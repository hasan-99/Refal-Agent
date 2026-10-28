"use strict";

// Per-conversation reuse of approved evidence (RAFA_SESSION_EVIDENCE_CACHE).
//
// What is kept: the approved chunks that the immediately previous turn's
// searches put in front of the model (structured evidence with chunk refs,
// approval and valid_until metadata), never an assistant reply. What it is
// for: a follow-up such as "and what does it include?" can be answered from
// that same approved evidence instead of repeating the search.
//
// Safety rules, all enforced on lookup:
//   - keyed by the WhatsApp contact; a set is only offered to the turn that
//     directly follows the turn that retrieved it (turn id match)
//   - the knowledge version stamp must be unchanged since retrieval, so a
//     re-approval, supersede, disable or edit discards the whole entry
//   - every item must still carry review_status "approved" and an unexpired
//     valid_until; anything else is dropped
//   - entries expire 10 minutes after the ORIGINAL retrieval, even when a
//     follow-up re-offers them, and are bounded in sets, items and characters
// The model still decides: reused evidence is one current-turn observation,
// the search tool stays available, and the grounding reviewer checks the
// draft against exactly this evidence.

const { redactPersonalData } = require("./ai");

const REUSED_EVIDENCE_TOOL = "previousTurnApprovedKnowledge";
const REUSABLE_TOOLS = new Set(["searchApprovedKnowledge", REUSED_EVIDENCE_TOOL]);

function itemChars(item) {
  return String(item?.content || "").length + String(item?.title || "").length + String(item?.section || "").length;
}

function isReusablePolicy(policy, now) {
  if (policy?.review_status !== "approved") return false;
  if (policy.valid_until == null || !String(policy.valid_until).trim()) return true;
  const expiry = Date.parse(policy.valid_until);
  return Number.isFinite(expiry) && expiry > now;
}

function createSessionEvidenceCache({ ttlMs = 600_000, maxSets = 3, maxItems = 12, maxChars = 12_000, maxSessions = 500, now = Date.now } = {}) {
  const sessions = new Map();

  function record({ sessionKey, sourceTurnId, knowledgeVersion, language = null, observations = [] } = {}) {
    if (!sessionKey || !sourceTurnId) return { recorded: false, reason: "missing_key" };
    if (!knowledgeVersion) { sessions.delete(sessionKey); return { recorded: false, reason: "no_version" }; }
    const at = now();
    const sets = [];
    for (const observation of [...(Array.isArray(observations) ? observations : [])].reverse()) {
      const model = observation?.result?.modelObservation;
      if (!REUSABLE_TOOLS.has(observation?.tool) || model?.type !== "approved_knowledge") continue;
      if (!["found", "no_new_evidence"].includes(model.status) || !Array.isArray(model.evidence) || !model.evidence.length) continue;
      const retrievedAt = Number.isFinite(observation.result?.retrievedAt) ? observation.result.retrievedAt : at;
      if (retrievedAt + ttlMs <= at) continue;
      const policyByRef = new Map((model.policyEvidence || []).filter((p) => p?.sourceRef).map((p) => [p.sourceRef, p]));
      sets.push({
        query: redactPersonalData(String(observation.args?.query || "")).slice(0, 300),
        retrievedAt,
        language,
        supportIntent: typeof observation.result?.trace?.supportIntent === "string" ? observation.result.trace.supportIntent : null,
        items: model.evidence.filter((item) => item?.sourceRef && policyByRef.has(item.sourceRef))
          .map((item) => ({ evidence: { ...item }, policy: { ...policyByRef.get(item.sourceRef) } })),
        factRegisterRows: Array.isArray(model.factRegisterRows) ? model.factRegisterRows.slice(0, 24).map((row) => ({ ...row })) : []
      });
      if (sets.length >= maxSets) break;
    }
    // Newest retrieval first; one copy of each chunk; bounded size.
    const seen = new Set();
    let items = 0;
    let chars = 0;
    const bounded = [];
    for (const set of sets) {
      const kept = [];
      for (const entry of set.items) {
        if (seen.has(entry.evidence.sourceRef)) continue;
        const size = itemChars(entry.evidence);
        if (items + 1 > maxItems || chars + size > maxChars) continue;
        seen.add(entry.evidence.sourceRef);
        items += 1; chars += size;
        kept.push(entry);
      }
      if (kept.length) bounded.push({ ...set, items: kept });
    }
    if (!bounded.length) { sessions.delete(sessionKey); return { recorded: false, reason: "no_evidence" }; }
    sessions.delete(sessionKey);
    sessions.set(sessionKey, { sourceTurnId, knowledgeVersion, sets: bounded });
    while (sessions.size > maxSessions) sessions.delete(sessions.keys().next().value);
    return { recorded: true, sets: bounded.length, items, chars };
  }

  function lookup({ sessionKey, previousTurnId, knowledgeVersion } = {}) {
    const entry = sessionKey ? sessions.get(sessionKey) : null;
    if (!entry) return { status: "none" };
    if (!previousTurnId || entry.sourceTurnId !== previousTurnId) { sessions.delete(sessionKey); return { status: "not_previous_turn" }; }
    if (!knowledgeVersion || entry.knowledgeVersion !== knowledgeVersion) { sessions.delete(sessionKey); return { status: knowledgeVersion ? "stale_version" : "version_unavailable" }; }
    const at = now();
    const sets = entry.sets.filter((set) => set.retrievedAt + ttlMs > at)
      .map((set) => ({ ...set, items: set.items.filter((item) => isReusablePolicy(item.policy, at)) }))
      .filter((set) => set.items.length);
    if (!sets.length) { sessions.delete(sessionKey); return { status: "expired" }; }
    const evidence = sets.flatMap((set) => set.items.map((item) => ({ ...item.evidence })));
    const policyEvidence = sets.flatMap((set) => set.items.map((item) => ({ ...item.policy })));
    const factRegisterRows = [...new Map(sets.flatMap((set) => set.factRegisterRows).filter((row) => row?.id).map((row) => [row.id, row])).values()];
    const observation = {
      step: 0,
      tool: REUSED_EVIDENCE_TOOL,
      args: { query: sets.map((set) => set.query).filter(Boolean).join(" | ").slice(0, 600) },
      result: {
        ok: true, status: "found",
        retrievedAt: Math.min(...sets.map((set) => set.retrievedAt)),
        userSafeSummary: evidence.map((item) => String(item.section || item.title || "Approved information").slice(0, 120)),
        modelObservation: {
          type: "approved_knowledge", status: "found", evidence,
          candidateEvidence: evidence.map((item) => ({ ...item })), policyEvidence,
          candidatePolicyEvidence: policyEvidence.map((item) => ({ ...item })),
          // Never a primary match: a fresh search result for the current
          // question outranks carried-over evidence in the shared budget.
          primarySearchRefs: [], truncated: false, factRegisterRows
        },
        trace: { reused: true, sets: sets.length, ageMs: at - Math.min(...sets.map((set) => set.retrievedAt)),
          supportIntents: [...new Set(sets.map((set) => set.supportIntent).filter(Boolean))] }
      }
    };
    return { status: "hit", observation, chunkIds: evidence.map((item) => item.sourceRef) };
  }

  return { record, lookup, clear: () => sessions.clear(), get size() { return sessions.size; } };
}

let processCache;
function getSessionEvidenceCache({ ttlMs } = {}) {
  if (!processCache) processCache = createSessionEvidenceCache(ttlMs ? { ttlMs } : {});
  return processCache;
}

module.exports = { createSessionEvidenceCache, getSessionEvidenceCache, REUSED_EVIDENCE_TOOL };
