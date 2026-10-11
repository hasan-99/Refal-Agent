// Bounded Agent decision loop (Phases 3-5 of the refactor).
//
// Core rule: AGENT DECIDES, CODE AUTHORIZES. `decideNextStep` is model-driven
// and may be wrong, confused, or even adversarially manipulated by untrusted
// retrieved/customer content — this file never trusts its output directly.
// Every tool call is validated against the explicit registry before running,
// and every final response/clarification is validated with the same
// deterministic `responsePolicy.validateResponse` already used elsewhere in
// the codebase, before it is allowed to leave this function.

const { validateResponse, safeFallbackData, MODEL_DRAFT_THRESHOLDS, AGENT_CLARIFY_THRESHOLDS, AGENT_SUMMARY_THRESHOLDS } = require("./responsePolicy");
// REFAL-AGENT-028: deterministic factual-grounding gate, additive to the
// existing responsePolicy check below — never a replacement for it. Checked
// only once the ordinary policy check already passed, so every existing
// rejection reason/path is untouched; this can only add a NEW rejection
// reason, never remove one.
const { validateFactualGrounding, collectApprovedKnowledgeEvidence, collectDynamicDataEvidence } = require("./groundingPolicy");
const { resolveObservationConflicts, canonicalKnowledgeEvidence, buildDecisionMessages } = require("./agentDecision");
const { MAX_PROMPT_TOKEN_CEILING, promptTokenUpperBound } = require("./promptBudget");
// M1 close — the three output gates the Agent path was missing. Each had
// exactly one caller in the repo (src/ai.js), so flipping the Agent flag
// silently dropped every M1 guard while their unit tests stayed green.
const { resolveHumourLevel, assertHumourCompliance } = require("./humourEngine");
const { detectAntiPatterns } = require("./antiPatterns");
const { detectIntents } = require("./intent");
const { detectMessageLanguage } = require("./language");
// REFAL-AGENT-026: ports the legacy ai.js wrong-language check (`answer.length
// > 8 && detectMessageLanguage(answer) !== language`) into the Agent path.
// Reuses agentObservability.js's existing languageSignalsFrom — the SAME
// detector legacy already trusts (src/language.js) compared against
// `context.locale`, the Agent's own trusted per-turn expected-language field
// (set by the caller before the decision loop ever runs — never something
// the model itself reports). languageSignalsFrom is otherwise a read-only
// telemetry helper; reusing it here does not change its own behavior or
// make it a gate on its own — only this file's use of its return value gates.
const { languageSignalsFrom } = require("./agentObservability");
const { findRepeatedQuestion } = require("./neverReAsk");
const { evaluateAnswerClaims } = require("./claimPolicy");
const { containsUnconditionalProhibition } = require("./refalcoAnswer");

// A turn may need two retrieval passes and two rejected drafts. Keep one final
// tool-free decision slot so the agent can apply the exact latest validation
// feedback instead of falling straight to the generic fallback.
const DEFAULT_MAX_STEPS = 5;
const DECISION_TYPES = new Set(["tool", "respond", "clarify"]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// The Agent may only ever name a tool that is actually registered — it can
// never invent one. A plain object for `args`; anything else is rejected
// before a tool ever sees it.
function validateDecision(decision, tools) {
  if (!isPlainObject(decision) || !DECISION_TYPES.has(decision.type)) {
    return { ok: false, reason: "decision_not_understood" };
  }
  if (decision.type === "tool") {
    if (typeof decision.tool !== "string" || !Object.hasOwn(tools, decision.tool)) {
      return { ok: false, reason: "unknown_tool_requested" };
    }
    if (decision.args !== undefined && !isPlainObject(decision.args)) {
      return { ok: false, reason: "invalid_tool_args" };
    }
    return { ok: true, type: "tool", tool: decision.tool, args: decision.args || {} };
  }
  // respond / clarify
  if (typeof decision.text !== "string" || !decision.text.trim()) {
    return { ok: false, reason: "missing_response_text" };
  }
  return { ok: true, type: decision.type, text: decision.text.trim() };
}

function languageKeyFromLocale(locale) {
  const value = String(locale || "").toLowerCase();
  if (value.startsWith("ar")) return "ar";
  if (value.startsWith("el") || value.startsWith("greek")) return "el";
  return "en";
}

function safeFallback(context, category = "uncertainty") {
  return safeFallbackData({ language: languageKeyFromLocale(context?.locale), category }).text;
}

// A mechanical, safe correction for exactly one rejection reason: too many
// questions. Truncating to the first question mark is safe precisely
// because it only ever removes text, never invents or alters a claim — for
// every other reason (prohibited claim, unconsented contact commitment,
// internal reasoning, wrong length) a truncation could leave a misleading
// fragment, so those are never "corrected," only retried or given up on.
function correctTooManyQuestions(text) {
  const match = /^[\s\S]*?[?؟]/u.exec(String(text || ""));
  return match ? match[0].trim() : null;
}

function attemptDeterministicCorrection(text, policy, thresholds, context = {}) {
  if (policy.reasons.length !== 1 || policy.reasons[0] !== "too_many_questions") return null;
  const corrected = correctTooManyQuestions(text);
  if (!corrected) return null;
  const evidenceItems = collectApprovedKnowledgeEvidence(context.observations || []);
  const recheck = validateResponse(corrected, { ...thresholds, customerMessage: context.currentMessage, evidence: evidenceItems, language: context.locale });
  return recheck.valid ? recheck.text : null;
}

// Fed back to decideNextStep as an observation so a retried decision can see
// *why* its last draft was rejected, reusing agentDecision.js's existing
// observation formatting (it only expects {step, tool, args, result}).
function policyRejectionObservation(step, decisionType, policy, diagnosticCodes = policy.reasons) {
  return {
    step,
    tool: "responsePolicyCheck",
    args: { attemptedType: decisionType },
    result: { ok: false, status: "policy_rejected", reasonCode: diagnosticCodes.join(","),
      draft: policy.text, blockedClaims: policy.blockedClaims || [],
      correction: "Correct each rejected claim using its supporting current-turn evidence; remove unsupported claims or accurately state their limits. For a CONTEXT span, correct only the quoted passage to respect the customer's role, preference, or prior scope; preserve other supported facts. An UNMET_REQUEST span quotes an unanswered part of the current request, not an unsupported draft statement to delete: address it or accurately explain the evidence limit. Resolve the actual current request against the prior answer, including its comparisons and references, rather than answering an earlier question. An accurate limit of the supplied evidence is permitted and must not be removed merely because an additional fact is unconfirmed. Do not repeat this draft or search unless it will resolve the specific missing support." }
  };
}

function diagnosticPolicyCodes(text, policy, evidenceItems, locale) {
  const codes = new Set(policy.reasons || []);
  if ((policy.reasons || []).includes("prohibited_claim")) {
    if (containsUnconditionalProhibition(text, { evidence: evidenceItems, language: locale })) codes.add("unconditional_prohibition");
    const verdict = evaluateAnswerClaims(text, { evidence: evidenceItems, language: locale });
    for (const claim of verdict.blocked || []) for (const reason of claim.reasons || []) {
      if (/^[a-z][a-z0-9_:.-]{0,80}$/iu.test(reason)) codes.add(reason);
    }
  }
  return [...codes].slice(0, 12);
}

// All search rounds share one decision prompt budget. Keep complete section
// evidence when possible, deduplicate chunks returned by subsequent searches,
// and expose only this same bounded evidence to both the model and validators.
function boundAccumulatedKnowledgeEvidence(observations, maxChars = 10000, maxBytes = Infinity) {
  const rounds = observations.filter((item) => item?.result?.modelObservation?.type === "approved_knowledge");
  const latest = rounds.at(-1);
  const previousIds = new Set(rounds.slice(0, -1).flatMap((round) => round.result.modelObservation.evidence || []).map((item) => item.sourceRef));
  const priorCandidateIds = new Set(rounds.slice(0, -1).flatMap((round) => round.result.modelObservation.candidateEvidence || round.result.modelObservation.evidence || []).map((item) => item.sourceRef));
  const pool = new Map();
  for (const [roundIndex, round] of rounds.entries()) {
    const model = round.result.modelObservation;
    model.candidateEvidence ||= (model.evidence || []).map((item) => ({ ...item }));
    model.candidatePolicyEvidence ||= (model.policyEvidence || []).map((item) => ({ ...item }));
    for (const item of model.candidateEvidence) {
      const key = item.sourceRef || JSON.stringify([item.title, item.section, item.content]);
      const candidate = { item, round, roundIndex };
      const existing = pool.get(key);
      if (!existing || Number(item.relevance || 1) >= Number(existing.item.relevance || 1)) pool.set(key, candidate);
    }
  }
  const ranked = [...pool.values()].sort((a, b) => Number(b.item.relevance || 1) - Number(a.item.relevance || 1)
    || b.roundIndex - a.roundIndex || Number(a.item.selectionOrder || 0) - Number(b.item.selectionOrder || 0));
  let used = 0;
  let usedBytes = 0;
  const retained = [];
  const excluded = [];
  for (const candidate of ranked) {
    const item = candidate.item;
    const chars = String(item.content || "").length + String(item.title || "").length + String(item.section || "").length + String(item.sourceRef || "").length + 48;
    const bytes = Buffer.byteLength(JSON.stringify({ content: item.content, title: item.title, section: item.section, ref: item.sourceRef }), "utf8") + 240;
    if (item.contentTruncated || used + chars > maxChars || usedBytes + bytes > maxBytes) { excluded.push(item.sourceRef); continue; }
    usedBytes += bytes;
    used += chars; retained.push(candidate);
  }
  for (const round of rounds) {
    const model = round.result.modelObservation;
    model.evidence = retained.filter((candidate) => candidate.round === round).map((candidate) => candidate.item);
    model.policyEvidence = model.candidatePolicyEvidence.filter((policy) => model.evidence.some((item) => item.sourceRef === policy.sourceRef));
    model.truncated = excluded.length > 0;
  }
  const newCandidateCount = (latest?.result.modelObservation.candidateEvidence || []).filter((item) => !priorCandidateIds.has(item.sourceRef)).length;
  return { evidenceCount: retained.length, newEvidenceCount: retained.filter((candidate) => candidate.round === latest && !previousIds.has(candidate.item.sourceRef)).length,
    newCandidateCount, candidateCount: pool.size, evidenceChars: used, truncated: excluded.length > 0,
    retainedIds: retained.map((candidate) => candidate.item.sourceRef), excludedIds: excluded,
    replacedIds: [...previousIds].filter((id) => !retained.some((candidate) => candidate.item.sourceRef === id)) };
}

function budgetCurrentEvidence(context, observations, tools) {
  const emptyEvidence = observations.map((round) => round?.result?.modelObservation?.type === "approved_knowledge"
    ? { ...round, result: { ...round.result, modelObservation: { ...round.result.modelObservation, evidence: [] } } } : round);
  // Reserve the structured response schema, request framing and formatting.
  // Complete sections are retained or omitted, and both reviewers share them.
  const availableBytes = Math.max(0, MAX_PROMPT_TOKEN_CEILING - 3000
    - promptTokenUpperBound(buildDecisionMessages(context, emptyEvidence, tools)));
  return boundAccumulatedKnowledgeEvidence(observations, 10000, availableBytes);
}

// REFAL-AGENT-026 — mirrors legacy ai.js's own short-text exemption
// (`answer.length > 8`): a very short draft (e.g. a one-word acknowledgement)
// is too little text for script-based language detection to be reliable, so
// it is never rejected on language grounds alone, matching legacy exactly.
// `locale` is always `context.locale` — trusted, caller-supplied, never
// something the model's own decision JSON can set.
function checkLanguageEquivalence(text, locale) {
  const trimmed = String(text || "").trim();
  if (trimmed.length <= 8) return { valid: true, reasons: [] };
  const signal = languageSignalsFrom(locale, trimmed);
  // languageMismatch is null (not computed) when locale is "unknown" or the
  // text is empty — nothing meaningful to compare, never treated as a
  // rejection. Only an explicit `true` gates.
  if (signal.languageMismatch !== true) return { valid: true, reasons: [] };
  return { valid: false, reasons: ["language_mismatch"] };
}

// REFAL-AGENT-028/026 — runs the existing responsePolicy check first,
// unchanged; only if that already passes does it additionally run the
// deterministic factual-grounding check against the evidence this turn's
// tool calls actually surfaced (Ticket 027's modelObservation channel, never
// a tool's raw `data`), then the language-equivalence check (Ticket 026).
// Each failure is folded into the same `{valid, text, reasons}` shape
// validateResponse already returns, so every downstream consumer
// (attemptDeterministicCorrection, policyRejectionObservation, the
// retry/fallback branching below) needs no special-casing: neither a
// grounding nor a language-mismatch reason ever equals "too_many_questions",
// so neither is ever mistaken for one the mechanical correction knows how to
// fix — both only ever go through retry-then-fallback, never a silent text edit.
function currentDraftEvidence(observations, context = {}) {
  const conflicts = resolveObservationConflicts(context, observations);
  return canonicalKnowledgeEvidence(collectApprovedKnowledgeEvidence(observations)
    .filter((item) => !item.sourceRef || !conflicts.staleRefs.has(item.sourceRef)));
}

function draftProgressKey(text, observations, context) {
  return JSON.stringify([String(text).normalize("NFKC").replace(/\s+/gu, " ").trim(), currentDraftEvidence(observations, context).map((item) => [item.sourceRef, item.content])]);
}

async function checkDraftPolicy(text, thresholds, observations, locale, context = {}, assessDraft = null, step = 0) {
  const evidenceItems = currentDraftEvidence(observations, context);
  const semanticGrounding = typeof assessDraft === "function";
  const policy = validateResponse(text, { ...thresholds, customerMessage: context.currentMessage, evidence: evidenceItems, language: locale, semanticGrounding });
  if (!policy.valid) return policy;
  const repeatedFields = findRepeatedQuestion(text, context.knownCustomerFacts);
  if (repeatedFields.length) return { ...policy, valid: false, reasons: repeatedFields.map((field) => `never_reask:${field}`) };
  const dynamicEvidenceItems = collectDynamicDataEvidence(observations);
  const grounding = validateFactualGrounding(text, { evidenceItems, dynamicEvidenceItems, semanticGrounding });
  if (!grounding.valid) return { ...policy, valid: false, reasons: grounding.reasons };
  if (semanticGrounding) {
    const review = await assessDraft({ text, evidenceItems, dynamicEvidenceItems, context, step });
    if (!review?.valid) return { ...policy, valid: false, reasons: review?.reasons || ["grounding_verdict_invalid"],
      blockedClaims: review?.blockedClaims || [], technicalFailure: review?.technicalFailure === true, errorCode: review?.errorCode };
  } else {
    const language = checkLanguageEquivalence(text, locale);
    if (!language.valid) return { ...policy, valid: false, reasons: language.reasons };
  }

  // M1 close — the Agent path was running THREE fewer output gates than the
  // legacy path. detectAntiPatterns, assertHumourCompliance and
  // assertModelKnowledgeIsGeneral each had exactly one caller in the repo,
  // src/ai.js, which this path does not traverse. So every M1 guard silently
  // disappeared the moment REFAL_AGENT_LIVE_ENABLED was flipped, while
  // antiPatterns.test.js and humourEngine.test.js stayed green. Two of the
  // three are wired here, at the single composition point, so they fold into
  // the same {valid, reasons} shape the retry/fallback branching already
  // handles and need no special-casing.
  //
  // assertModelKnowledgeIsGeneral is deliberately NOT wired: it keys off a
  // MODEL_KNOWLEDGE source level that cannot arise here any more than it can
  // in ai.js, so adding it would create a second dead gate rather than a
  // second real one. Recorded as W1.6.3 PARTIAL in the plan instead.
  const message = String(context.currentMessage || "");
  const history = Array.isArray(context.recentConversation) ? context.recentConversation : [];

  const humourLevel = resolveHumourLevel({
    message,
    history,
    intents: Array.isArray(context.intents) ? context.intents : [],
    language: detectMessageLanguage(message)
  }).level;
  const humour = assertHumourCompliance(text, humourLevel);
  // A joke next to a bereavement is regenerated, never silently edited; a
  // disallowed emoji is stripped in place. Same split as src/ai.js.
  if (humour.rejected) {
    return { ...policy, valid: false, reasons: ["humour_above_level"] };
  }
  const cleaned = humour.ok ? policy.text : humour.sanitized;

  const antiPatterns = detectAntiPatterns({
    answer: cleaned,
    customerMessage: message,
    history,
    leadTier: context.leadTier || "",
    deliveredApprovedFact: evidenceItems.length > 0,
    evidenceText: evidenceItems.map((item) => String(item?.content || "")).join("\n")
  });
  if (antiPatterns.length) {
    return { ...policy, valid: false, reasons: antiPatterns.map((violation) => `anti_pattern:${violation.id}`) };
  }

  return { ...policy, text: cleaned };
}

// deps:
//   decideNextStep({ context, observations, step }) -> a raw, untrusted decision object (model-driven)
//   tools: { [name]: { run(args, toolContext) } }       -- the deterministic tool registry
//   toolContext: extra data (store, user, etc.) passed through to every tool.run call
//   maxSteps: bounded step budget, default 5 (never unlimited)
async function runAgentTurn(context, { decideNextStep, assessDraft = null, tools = {}, toolContext = {}, maxSteps = DEFAULT_MAX_STEPS, initialObservations = [], onToolCall = async () => {}, onPolicyRejection = async () => {} } = {}) {
  if (typeof decideNextStep !== "function") throw new Error("runAgentTurn requires a decideNextStep function.");
  const observations = Array.isArray(initialObservations) ? [...initialObservations] : [];
  const toolsUsed = [...new Set(observations.map((item) => item?.tool).filter((name) => typeof name === "string"))];
  let knowledgeSearchExhausted = false;
  const rejectedDrafts = new Map();

  for (let step = 1; step <= maxSteps; step += 1) {
    let rawDecision;
    try {
      // Reserve the final model call for composing an answer. It receives no
      // tools, so retrieval cannot consume the entire bounded turn.
      const availableTools = step === maxSteps && maxSteps > 1 ? {}
        : knowledgeSearchExhausted ? Object.fromEntries(Object.entries(tools).filter(([name]) => name !== "searchApprovedKnowledge"))
          : tools;
      budgetCurrentEvidence(context, observations, availableTools);
      rawDecision = await decideNextStep({ context, observations, step, tools: availableTools });
    } catch (error) {
      return {
        finished: true,
        outcome: "decision_failed",
        response: safeFallback(context),
        steps: observations,
        toolsUsed,
        stepCount: step,
        reason: /^[A-Z][A-Z0-9_.-]{0,49}$/u.test(String(error?.code || "")) ? error.code : "MODEL_CALL_FAILED"
      };
    }

    if (rawDecision?.technicalFailure === true) {
      return { finished: true, outcome: "decision_failed", response: safeFallback(context), steps: observations,
        toolsUsed, stepCount: step, reason: rawDecision.errorCode || "MODEL_CALL_FAILED" };
    }

    if (step === maxSteps && maxSteps > 1 && rawDecision?.type === "tool") {
      return {
        finished: true, outcome: "max_steps_reached", response: safeFallback(context),
        steps: observations, toolsUsed, stepCount: step, reason: "step_limit_reached"
      };
    }

    const availableTools = step === maxSteps && maxSteps > 1 ? {}
      : knowledgeSearchExhausted ? Object.fromEntries(Object.entries(tools).filter(([name]) => name !== "searchApprovedKnowledge"))
        : tools;
    const validated = validateDecision(rawDecision, availableTools);
    if (!validated.ok) {
      if (step < maxSteps && knowledgeSearchExhausted && validated.reason === "unknown_tool_requested"
        && rawDecision?.tool === "searchApprovedKnowledge") {
        observations.push({ step, tool: "searchApprovedKnowledge", args: {},
          result: { ok: false, status: "search_exhausted", reasonCode: "NO_NEW_RELEVANT_SECTIONS" } });
        continue;
      }
      if (step < maxSteps && validated.reason !== "unknown_tool_requested") {
        observations.push({ step, tool: "decisionValidation", args: {},
          result: { ok: false, status: "invalid_decision", reasonCode: validated.reason } });
        continue;
      }
      return {
        finished: true,
        outcome: "invalid_decision",
        response: safeFallback(context),
        steps: observations,
        toolsUsed,
        stepCount: step,
        reason: validated.reason
      };
    }

    if (validated.type === "tool") {
      const normalizedQuery = validated.tool === "searchApprovedKnowledge"
        ? String(validated.args?.query || "").normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}]+/gu, " ").trim()
        : null;
      const repeated = normalizedQuery && observations.some((item) => item.tool === validated.tool
        && String(item.args?.query || "").normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}]+/gu, " ").trim() === normalizedQuery
        && item.result?.status !== "error");
      if (repeated) {
        knowledgeSearchExhausted = true;
        const observation = { step, tool: validated.tool, args: validated.args,
          result: { ok: false, status: "skipped", reasonCode: "REPEATED_SEARCH_NO_ADDITIONAL_VALUE" } };
        observations.push(observation);
        try { await onToolCall({ step, tool: validated.tool, args: validated.args, result: observation.result, durationMs: 0, skipped: true }); } catch {}
        if (!toolsUsed.includes(validated.tool)) toolsUsed.push(validated.tool);
        continue;
      }
      const tool = tools[validated.tool];
      let result;
      const toolStartedAt = performance.now();
      try {
        result = await tool.run(validated.args, toolContext);
      } catch (error) {
        result = { ok: false, status: "error", reasonCode: /^[A-Z][A-Z0-9_.-]{0,39}$/u.test(String(error?.code || "")) ? error.code : "TOOL_THREW" };
      }
      const observation = { step, tool: validated.tool, args: validated.args, result };
      observations.push(observation);
      const evidenceBudget = validated.tool === "searchApprovedKnowledge" ? budgetCurrentEvidence(context, observations, tools) : null;
      if (validated.tool === "searchApprovedKnowledge" && result?.ok === true
        && result.status === "found" && evidenceBudget?.newCandidateCount === 0 && evidenceBudget?.newEvidenceCount === 0 && !evidenceBudget?.replacedIds?.length) {
        knowledgeSearchExhausted = true;
        if (result.status === "found") {
          observation.result.status = "no_new_evidence";
          observation.result.reasonCode = "NO_NEW_RELEVANT_SECTIONS";
          if (observation.result.modelObservation) observation.result.modelObservation.status = "no_new_evidence";
        }
      }
      const evidence = result?.modelObservation?.evidence || [];
      try { await onToolCall({ step, tool: validated.tool, args: validated.args, result, durationMs: Math.max(0, Math.round(performance.now() - toolStartedAt)),
        evidenceCount: evidenceBudget?.evidenceCount ?? evidence.length, evidenceChars: evidenceBudget?.evidenceChars,
        candidateCount: result.trace?.candidateCount ?? evidenceBudget?.candidateCount, newCandidateCount: evidenceBudget?.newCandidateCount,
        retainedIds: evidenceBudget?.retainedIds, excludedIds: [...(result.trace?.excludedIds || []), ...(evidenceBudget?.excludedIds || [])], contextOmittedIds: evidenceBudget?.excludedIds, replacedIds: evidenceBudget?.replacedIds,
        candidateIds: result.trace?.candidateIds, selectionDurationMs: result.trace?.selectionDurationMs, selectionStatus: result.trace?.selectionStatus,
        evidenceIds: observations.flatMap((item) => item?.result?.modelObservation?.evidence || []).map((item) => item.sourceRef).filter(Boolean) }); } catch {}
      if (!toolsUsed.includes(validated.tool)) toolsUsed.push(validated.tool);
      continue;
    }

    if (validated.type === "respond") {
      const thresholds = assessDraft ? AGENT_SUMMARY_THRESHOLDS : MODEL_DRAFT_THRESHOLDS;
      const progressKey = draftProgressKey(validated.text, observations, context);
      const policy = rejectedDrafts.has(progressKey)
        ? { ...rejectedDrafts.get(progressKey), valid: false, text: validated.text, reasons: [...rejectedDrafts.get(progressKey).reasons, "repeated_rejected_draft"] }
        : await checkDraftPolicy(validated.text, thresholds, observations, context?.locale, context, assessDraft, step);
      if (!policy.valid) {
        rejectedDrafts.set(progressKey, policy);
        const evidenceItems = currentDraftEvidence(observations, context);
        try { await onPolicyRejection({ step, type: "respond", reasonCodes: diagnosticPolicyCodes(validated.text, policy, evidenceItems, context?.locale), draft: validated.text, evidence: evidenceItems, claims: policy.blockedClaims || evaluateAnswerClaims(validated.text, { evidence: evidenceItems, language: context?.locale }).blocked }); } catch {}
        if (policy.technicalFailure || policy.reasons.includes("repeated_rejected_draft")) return {
          finished: true, outcome: policy.technicalFailure ? "validation_failed" : "response_rejected", response: safeFallback(context),
          steps: observations, toolsUsed, stepCount: step, reason: policy.errorCode || policy.reasons.join(",")
        };
        const corrected = assessDraft ? null : attemptDeterministicCorrection(validated.text, policy, thresholds, { ...context, observations });
        if (corrected) {
          return { finished: true, outcome: "responded", response: corrected, steps: observations, toolsUsed, stepCount: step, corrected: true };
        }
        if (step < maxSteps) {
          observations.push(policyRejectionObservation(step, "respond", policy, diagnosticPolicyCodes(validated.text, policy, evidenceItems, context?.locale)));
          continue;
        }
        return {
          finished: true,
          outcome: "response_rejected",
          response: safeFallback(context),
          steps: observations,
          toolsUsed,
          stepCount: step,
          reason: policy.reasons.join(",")
        };
      }
      return { finished: true, outcome: "responded", response: policy.text, steps: observations, toolsUsed, stepCount: step };
    }

    // clarify: at most one question, no minimum length requirement — a short
    // single clarifying question is exactly what this path is for.
    const clarifyThresholds = AGENT_CLARIFY_THRESHOLDS;
    const progressKey = draftProgressKey(validated.text, observations, context);
    const policy = rejectedDrafts.has(progressKey)
      ? { ...rejectedDrafts.get(progressKey), valid: false, text: validated.text, reasons: [...rejectedDrafts.get(progressKey).reasons, "repeated_rejected_draft"] }
      : await checkDraftPolicy(validated.text, clarifyThresholds, observations, context?.locale, context, assessDraft, step);
    if (!policy.valid) {
      rejectedDrafts.set(progressKey, policy);
      const evidenceItems = currentDraftEvidence(observations, context);
      try { await onPolicyRejection({ step, type: "clarify", reasonCodes: diagnosticPolicyCodes(validated.text, policy, evidenceItems, context?.locale), draft: validated.text, evidence: evidenceItems, claims: policy.blockedClaims || evaluateAnswerClaims(validated.text, { evidence: evidenceItems, language: context?.locale }).blocked }); } catch {}
      if (policy.technicalFailure || policy.reasons.includes("repeated_rejected_draft")) return {
        finished: true, outcome: policy.technicalFailure ? "validation_failed" : "clarify_rejected", response: safeFallback(context),
        steps: observations, toolsUsed, stepCount: step, reason: policy.errorCode || policy.reasons.join(",")
      };
      const corrected = assessDraft ? null : attemptDeterministicCorrection(validated.text, policy, clarifyThresholds, { ...context, observations });
      if (corrected) {
        return { finished: true, outcome: "clarified", response: corrected, steps: observations, toolsUsed, stepCount: step, corrected: true };
      }
      if (step < maxSteps) {
        observations.push(policyRejectionObservation(step, "clarify", policy, diagnosticPolicyCodes(validated.text, policy, evidenceItems, context?.locale)));
        continue;
      }
      return {
        finished: true,
        outcome: "clarify_rejected",
        response: safeFallback(context),
        steps: observations,
        toolsUsed,
        stepCount: step,
        reason: policy.reasons.join(",")
      };
    }
    return { finished: true, outcome: "clarified", response: policy.text, steps: observations, toolsUsed, stepCount: step };
  }

  return {
    finished: true,
    outcome: "max_steps_reached",
    response: safeFallback(context),
    steps: observations,
    toolsUsed,
    stepCount: maxSteps
  };
}

module.exports = { runAgentTurn, validateDecision, DEFAULT_MAX_STEPS, boundAccumulatedKnowledgeEvidence };
