"use strict";

// Knowledge Gaps: best-effort recording of an ungrounded agent turn.
//
// Called from src/agentLiveAnswerTurn.js AFTER the reply decision and
// delivery. scheduleKnowledgeGapRecording is synchronous, returns at once, and
// cannot throw: the work runs on a later tick with its own try/catch, is never
// awaited by the turn, and only ever logs its own failure. With
// RAFA_KNOWLEDGE_GAPS off (the default) it returns before doing anything.
//
// Nothing here changes what the customer is told, and nothing here writes
// knowledge. Gaps are review items for a human.

const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { redactPersonalData, DEFAULT_EMBEDDING_MODEL } = require("./ai");
const { PROMPT_VERSION } = require("./brainPrompt");
const { DEFAULT_OPENROUTER_MODEL, resolveOpenRouterModel } = require("./openrouterPrivacy");

const AGENT_VERSION = "agent-loop-1";
const RECORD_TIMEOUT_MS = 5000;
const EMBED_TIMEOUT_MS = 3000;
const LOCAL_RATE_LIMIT_MS = 10 * 60 * 1000;
const LOCAL_RATE_LIMIT_MAX_KEYS = 2000;

let policyPromise;
function loadGapPolicy() {
  if (!policyPromise) {
    policyPromise = import(pathToFileURL(path.join(__dirname, "../supabase/functions/rafa-agent-api/knowledgeGapPolicy.mjs")).href)
      .catch((error) => { policyPromise = undefined; throw error; });
  }
  return policyPromise;
}

const SETTINGS_TIMEOUT_MS = 5000; // off the reply path; covers an Edge cold start

function knowledgeGapsEnabled(env = process.env) {
  return /^(?:on|true|1|yes)$/iu.test(String(env?.RAFA_KNOWLEDGE_GAPS || "").trim());
}

function splitCodes(value) {
  return String(value || "").split(",").map((code) => code.trim()).filter((code) => /^[A-Za-z0-9_:.-]{1,80}$/u.test(code));
}

function expiredAt(value, now) {
  if (typeof value !== "string" || !value.trim()) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && time <= now;
}

// Reads only the deterministic trace the agent loop already produced.
function extractGapSignals(agentResult = {}, { now = Date.now() } = {}) {
  const steps = Array.isArray(agentResult?.steps) ? agentResult.steps : [];
  const searches = [];
  const rejectionCodes = [];
  const stepReasonCodes = [];
  let expiredMatches = 0;
  const evidenceKeys = new Map();
  for (const step of steps) {
    const result = step?.result || {};
    if (step?.tool === "responsePolicyCheck") { rejectionCodes.push(...splitCodes(result.reasonCode)); continue; }
    if (result.ok === false && result.reasonCode) stepReasonCodes.push(...splitCodes(result.reasonCode));
    if (step?.tool !== "searchApprovedKnowledge" || result.status === "skipped") continue;
    const observation = result.modelObservation || {};
    const evidence = Array.isArray(observation.evidence) ? observation.evidence : [];
    const policyEvidence = [...(Array.isArray(observation.policyEvidence) ? observation.policyEvidence : []),
      ...(Array.isArray(observation.candidatePolicyEvidence) ? observation.candidatePolicyEvidence : [])];
    const trace = result.trace || {};
    expiredMatches += policyEvidence.filter((item) => expiredAt(item?.valid_until, now)).length;
    for (const item of Array.isArray(observation.policyEvidence) ? observation.policyEvidence : []) {
      if (!item?.sourceRef) continue;
      const keys = [item.metadata?.topic, ...(Array.isArray(item.metadata?.facts) ? item.metadata.facts : [])].filter(Boolean);
      for (const key of keys) evidenceKeys.set(key, new Set([...(evidenceKeys.get(key) || []), item.sourceRef]));
    }
    const validUntilByRef = new Map(policyEvidence.filter((item) => item?.sourceRef).map((item) => [item.sourceRef, item.valid_until || null]));
    searches.push({
      status: String(result.status || observation.status || "unknown"),
      query: typeof step?.args?.query === "string" ? step.args.query : "",
      queries: Array.isArray(trace.searchQueries) ? trace.searchQueries.filter((item) => typeof item === "string") : [],
      evidenceCount: evidence.length,
      candidateCount: Number.isInteger(trace.candidateCount) ? trace.candidateCount : evidence.length,
      candidateIds: Array.isArray(trace.candidateIds) ? trace.candidateIds.filter((id) => typeof id === "string") : [],
      primaryMatchCount: Array.isArray(observation.primarySearchRefs) ? observation.primarySearchRefs.length : 0,
      rerank: trace.rerank && typeof trace.rerank === "object" ? { ran: true, status: String(trace.rerank.status || "unknown") } : null,
      evidence: evidence.map((item, index) => ({ id: item?.sourceRef || null, rank: index + 1, relevance: Number(item?.relevance) || null,
        retrievalRank: Number(item?.retrievalRank) || null, validUntil: validUntilByRef.get(item?.sourceRef) || null })).filter((item) => item.id)
    });
  }
  const evidenceOverlap = [...evidenceKeys.values()].some((refs) => refs.size >= 2);
  return {
    outcome: String(agentResult?.outcome || "unknown"),
    turnReason: typeof agentResult?.reason === "string" ? agentResult.reason : "",
    corrected: agentResult?.corrected === true,
    rejectionCodes: [...new Set(rejectionCodes)],
    stepReasonCodes: [...new Set(stepReasonCodes)],
    searches,
    expiredMatches,
    evidenceOverlap
  };
}

function responseTypeFor(agentResult, delivered) {
  const outcome = String(agentResult?.outcome || "");
  if (outcome === "responded") return agentResult?.corrected === true ? "corrected_answer" : "agent_answer";
  if (outcome === "clarified") return "clarification";
  return delivered ? "safe_fallback" : "not_delivered";
}

// In-process noise guard: the same question from the same conversation is
// recorded once per window. The Edge function enforces the same rule durably.
function createLocalRateLimiter({ windowMs = LOCAL_RATE_LIMIT_MS, maxKeys = LOCAL_RATE_LIMIT_MAX_KEYS, clock = Date.now } = {}) {
  const seen = new Map();
  return (key) => {
    const now = clock();
    for (const [entry, at] of seen) { if (now - at > windowMs || seen.size > maxKeys) seen.delete(entry); else break; }
    const last = seen.get(key);
    if (last !== undefined && now - last <= windowMs) return false;
    seen.delete(key);
    seen.set(key, now);
    return true;
  };
}
const defaultRateLimiter = createLocalRateLimiter();

function withTimeout(promise, ms, code) {
  let timer;
  return Promise.race([promise, new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(code), { code })), ms);
    timer.unref?.();
  })]).finally(() => clearTimeout(timer));
}

function safeFailure(error) {
  const code = /^[A-Z][A-Z0-9_.-]{0,59}$/u.test(String(error?.code || "")) ? error.code : null;
  return { errorCode: code, errorName: /^[A-Za-z]{1,40}$/u.test(String(error?.name || "")) ? error.name : "Error",
    status: Number.isInteger(error?.status) ? error.status : null };
}

// Builds the event and sends it. Returns a small result for tests and
// observability; never includes question text in what it logs.
// Admin recording switch (dashboard toggle, rafa_settings.knowledge_gaps).
// A store without the setting keeps the master-flag-only behaviour; a store
// that has it but cannot answer means "do not record" (fail closed).
async function recordingSwitch(store) {
  if (typeof store?.getKnowledgeGapSettings !== "function") return { allowed: true, source: "master_flag_only" };
  try {
    const value = await withTimeout(Promise.resolve(store.getKnowledgeGapSettings()), SETTINGS_TIMEOUT_MS, "GAP_SETTINGS_TIMEOUT");
    return value?.settings?.recording === true ? { allowed: true, source: "admin_switch" } : { allowed: false, skip: "recording_paused" };
  } catch {
    return { allowed: false, skip: "settings_unavailable" };
  }
}

async function recordKnowledgeGap(input = {}, deps = {}) {
  const { store, embedText, logEvent = async () => {}, rateLimiter = defaultRateLimiter, now = Date.now() } = deps;
  const recording = await recordingSwitch(store);
  if (!recording.allowed) return { recorded: false, skip: recording.skip };
  const policy = await loadGapPolicy();
  const { agentResult, message, classification = {}, socialOnlyTurn = false, userId, sourceTurnId, traceId, delivered } = input;
  const intents = Array.isArray(classification?.intents) ? classification.intents.filter((item) => typeof item === "string") : [];
  const signals = extractGapSignals(agentResult, { now });
  const verdict = policy.classifyKnowledgeGap({ ...signals, intents, socialOnlyTurn });
  if (!verdict.record) return { recorded: false, skip: verdict.skip };

  const question = policy.redactGapText(redactPersonalData(String(message || "")), 500);
  if (!question) return { recorded: false, skip: "empty_question" };
  const fingerprint = policy.gapFingerprint(question);
  if (!rateLimiter(`${String(userId || "")}:${fingerprint}`)) return { recorded: false, skip: "rate_limited" };

  const { category, intent } = policy.gapCategoryForIntents(intents);
  const firstSearch = signals.searches.find((item) => item.query);
  const evidence = signals.searches.flatMap((item) => item.evidence);
  const rerank = signals.searches.map((item) => item.rerank).find(Boolean) || { ran: false, status: null };
  let embedding = null;
  if (typeof embedText === "function") {
    try {
      const vector = await withTimeout(Promise.resolve(embedText(question)), EMBED_TIMEOUT_MS, "GAP_EMBED_TIMEOUT");
      embedding = policy.toUnitVector(vector, policy.GAP_GROUPING.dimensions);
    } catch { embedding = null; /* Groups by text only when the local model is unavailable. */ }
  }
  const payload = {
    userId: String(userId || "").slice(0, 200),
    sourceTurnId: sourceTurnId || null,
    traceId: traceId || null,
    question,
    searchQuery: firstSearch ? policy.redactGapText(redactPersonalData(firstSearch.query), 500) : "",
    language: policy.languageCode(classification?.language),
    intent, intents: intents.slice(0, 8), category,
    outcome: signals.outcome,
    reasonCode: splitCodes(signals.turnReason).join(",").slice(0, 120),
    reason: verdict.reason,
    suspectedReason: verdict.suspectedReason,
    confidence: verdict.confidence,
    searchRan: signals.searches.length > 0,
    searchQueries: [...new Set(signals.searches.flatMap((item) => item.queries.length ? item.queries : [item.query]))]
      .filter(Boolean).slice(0, 6).map((value) => policy.redactGapText(redactPersonalData(value), 300)),
    topChunks: evidence.slice(0, 10).map(({ id, rank, relevance, retrievalRank, validUntil }) => ({ id, rank, relevance, retrievalRank, validUntil })),
    candidateIds: [...new Set(signals.searches.flatMap((item) => item.candidateIds))].slice(0, 20),
    candidateCount: signals.searches.reduce((sum, item) => sum + (item.candidateCount || 0), 0),
    rerank,
    groundingRejected: signals.rejectionCodes.length > 0,
    rejectionReasons: signals.rejectionCodes.slice(0, 12),
    responseType: responseTypeFor(agentResult, delivered === true),
    noSafeAnswer: !["responded", "clarified"].includes(signals.outcome),
    model: resolveOpenRouterModel(process.env.OPENROUTER_MODEL, DEFAULT_OPENROUTER_MODEL),
    promptVersion: PROMPT_VERSION,
    agentVersion: AGENT_VERSION,
    embeddingModel: embedding ? DEFAULT_EMBEDDING_MODEL : "",
    analyticsOnly: verdict.analyticsOnly === true,
    signals: { rule: verdict.rule, corrected: signals.corrected, searchCount: signals.searches.length,
      expiredEvidence: signals.expiredMatches, evidenceOverlap: signals.evidenceOverlap,
      stepCount: Number.isInteger(agentResult?.stepCount) ? agentResult.stepCount : 0 },
    embedding
  };
  const result = await withTimeout(Promise.resolve(store.recordKnowledgeGapEvent(payload)), RECORD_TIMEOUT_MS, "GAP_RECORD_TIMEOUT");
  await logEvent("knowledge_gap_recorded", { traceId: traceId || null, reason: verdict.reason, confidence: verdict.confidence,
    suppressed: result?.suppressed === true, created: result?.created === true, grouping: result?.grouping || null });
  return { recorded: result?.recorded !== false, reason: verdict.reason, payload, result };
}

// The only function the live turn calls. Synchronous, never throws, never
// awaited. Returns true when work was scheduled (for tests).
function scheduleKnowledgeGapRecording(input = {}, deps = {}) {
  try {
    if (!knowledgeGapsEnabled(deps.env || process.env)) return false;
    if (!deps.store || typeof deps.store.recordKnowledgeGapEvent !== "function") return false;
    if (!input.agentResult) return false;
    const logEvent = typeof deps.logEvent === "function" ? deps.logEvent : async () => {};
    const timer = setTimeout(() => {
      recordKnowledgeGap(input, { ...deps, logEvent })
        .then((result) => deps.onSettled?.(result))
        .catch(async (error) => {
          try { await logEvent("knowledge_gap_record_failed", { traceId: input.traceId || null, ...safeFailure(error) }); } catch { /* best effort */ }
          try { deps.onSettled?.({ recorded: false, error }); } catch { /* best effort */ }
        });
    }, 0);
    void timer;
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  scheduleKnowledgeGapRecording,
  recordKnowledgeGap,
  extractGapSignals,
  knowledgeGapsEnabled,
  recordingSwitch,
  createLocalRateLimiter,
  loadGapPolicy,
  AGENT_VERSION
};
