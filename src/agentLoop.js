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
const { resolveObservationConflicts, canonicalKnowledgeEvidence, buildDecisionPrompt } = require("./agentDecision");
// M1 close — the three output gates the Agent path was missing. Each had
// exactly one caller in the repo (src/ai.js), so flipping the Agent flag
// silently dropped every M1 guard while their unit tests stayed green.
const { resolveHumourLevel, assertHumourCompliance } = require("./humourEngine");
const { detectAntiPatterns } = require("./antiPatterns");
const { detectIntents } = require("./intent");
const { detectMessageLanguage } = require("./language");
const MAX_KNOWLEDGE_SEARCH_CALLS = 2;
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
// Conversation-behaviour gates (src/conversationFlags.js). Active only when
// the live turn put context.conversationFeatures in the Agent context.
const { evaluateTruthfulActions, truthfulActionCorrection } = require("./truthfulActionGuard");
const { stripUnhelpfulFollowups, dedupeLeadingName } = require("./sessionMemory");
const { countFollowupRemovals } = require("./conversationQuality");

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

function hasCurrentApprovedEvidence(observations) {
  return observations.some((item) => item?.result?.modelObservation?.status === "found"
    && Array.isArray(item.result.modelObservation.evidence)
    && item.result.modelObservation.evidence.length > 0);
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

function removeRejectedEvidenceSpans(text, blockedClaims) {
  const claims = blockedClaims.filter((claim) => {
    const reasons = claim?.reasons || [];
    return reasons.length > 0 && reasons.every((reason) =>
      ["no_approved_evidence", "entities_not_in_evidence", "service_not_established", "unsupported_relation", "personalized_marker", "context_mismatch"].includes(reason));
  });
  if (!claims.length || claims.length !== blockedClaims.length) return null;
  let corrected = String(text || "");
  for (const claim of claims) {
    const span = String(claim.sentence || claim.claim || "").trim();
    const start = span ? corrected.indexOf(span) : -1;
    if (!span || start < 0) return null;
    let before = corrected.slice(0, start);
    let after = corrected.slice(start + span.length);
    // If the rejected span was the rest of a sentence after a connector,
    // the remaining clause is not a complete customer reply. Ask the model
    // to rewrite it instead of sending a repaired fragment.
    if (/[,:;،؛]\s*$/u.test(before) && !after.trim()) return null;
    // A rejected sentence can be attached to the grounded sentence with a
    // semicolon/comma. Remove only separators made orphaned by this deletion.
    before = before.replace(/[ \t]*[,;:،؛]\s*$/u, " ");
    after = after.replace(/^\s*[,;:،؛]\s*/u, " ");
    corrected = `${before}${after}`;
  }
  corrected = corrected.split(/\r?\n/u).map((line) => line.trim())
    .filter(Boolean).join("\n").replace(/(?:^|\n)[•*-]\s*(?=\n|$)/gu, "\n").trim();
  if (/[,;:،؛]$/u.test(corrected)) corrected = corrected.slice(0, -1).trimEnd();
  if (/[\p{L}\p{N}]$/u.test(corrected)) corrected += ".";
  return corrected && corrected !== String(text || "").trim() ? corrected : null;
}

async function attemptEvidenceBoundPartialCorrection(text, policy, thresholds, context, assessDraft, step) {
  if (!policy.reasons.every((reason) =>
    ["no_approved_evidence", "prohibited_claim", "service_not_established", "unconditional_prohibition", "unsupported_relation", "personalized_marker", "context_mismatch"].includes(reason))) return null;
  const evidenceItems = currentDraftEvidence(context.observations || [], context);
  const blockedClaims = Array.isArray(policy.blockedClaims) && policy.blockedClaims.length
    ? policy.blockedClaims
    : evaluateAnswerClaims(text, { evidence: evidenceItems, language: context.locale }).blocked;
  const corrected = removeRejectedEvidenceSpans(text, blockedClaims);
  if (!corrected) return null;
  const recheck = await checkDraftPolicy(corrected, thresholds, context.observations || [], context.locale, context, assessDraft, step);
  return recheck.valid ? recheck.text : null;
}

// Fed back to decideNextStep as an observation so a retried decision can see
// *why* its last draft was rejected, reusing agentDecision.js's existing
// observation formatting (it only expects {step, tool, args, result}).
function policyRejectionObservation(step, decisionType, policy, diagnosticCodes = policy.reasons, observations = []) {
  const hasUnsupportedRelation = policy.reasons?.includes("unsupported_relation");
  const hasContextMismatch = policy.reasons?.includes("context_mismatch");
  const hasUnansweredRequest = policy.reasons?.includes("question_not_answered");
  const hasUnestablishedService = (policy.reasons || []).includes("service_not_established")
    || (policy.blockedClaims || []).some((claim) => (claim.reasons || []).includes("service_not_established"));
  const hasMissingEvidence = (policy.blockedClaims || []).some((claim) => (claim.reasons || []).some((reason) =>
    ["no_approved_evidence", "entities_not_in_evidence"].includes(reason)));
  const correction = policy.reasons?.includes("no_approved_evidence")
    ? observations.some((item) => item?.tool === "searchApprovedKnowledge")
      ? "No approved knowledge supports the rejected claim. Preserve other supported facts, state only the unsupported detail as unconfirmed, and do not invent it. Do not repeat the same search unless a distinct missing fact can be retrieved."
      : "No approved-knowledge search has run this turn. Use searchApprovedKnowledge for the requested company or package facts before answering; a live-offer lookup does not establish general service scope. If approved search returns no relevant evidence, say the detail is unconfirmed and do not invent a price or condition."
      : hasMissingEvidence
        ? "This factual span lacks current approved evidence. If it is needed to answer the customer's current request, run one focused search for that missing fact using the resolved conversation context. If no distinct approved evidence supports it, remove that span and preserve the other supported answer. Do not rephrase or repeat the unsupported claim."
      : hasUnestablishedService
        ? "The approved content describes a process but does not establish that REFAL performs or offers that process as a service. Remove only the unsupported attribution to REFAL. Keep useful process facts that the current-turn evidence states, such as what the institution reviews and who decides; say naturally that REFAL's specific role is not described. Preserve any supported answer about outcomes or guarantees. Do not turn an unknown service role into a claim that REFAL does or does not offer it."
      : hasUnsupportedRelation && hasContextMismatch
      ? "The comparison is not supported as drafted, and the quoted context span repeats or misuses earlier conversation. Use the immediately preceding relevant answer as the comparison set, not a narrower category. Remove the unsupported comparison and remove the full rejected repeat; do not restate it in new words, bullets or translation. Keep only supported information that adds value now. If no additional named service is established, acknowledge the prior scope briefly and ask for a specific area only when useful. Do not replace the removed text with a generic evidence or confirmation disclaimer, and do not search again unless a distinct missing fact is answerable from another source."
    : hasUnsupportedRelation
      ? "The rejected comparison or relationship is not established. Remove only that claim; do not replace it with an unsupported yes/no answer or a generic disclaimer about what you can confirm. Preserve and state the relevant approved scope naturally. Use conversation history to avoid repeating details already given, and ask for a particular area only when that helps the customer. Keep other supported facts and material conditions. Do not repeat the search unless new evidence could resolve a distinct missing detail."
    : hasContextMismatch
      ? "Correct the exact quoted context span. If it repeats or misuses earlier conversation, remove the full span rather than restating it in different words. Preserve other supported details, answer the current request directly, and do not narrate evidence or confirmation state."
    : "Correct each rejected claim using its supporting current-turn evidence; remove unsupported claims or accurately state their limits. For a CONTEXT span, correct only the quoted passage to respect the customer's role, preference, or prior scope; preserve other supported facts. An UNMET_REQUEST span quotes an unanswered part of the current request, not an unsupported draft statement to delete: address it or accurately explain the evidence limit. Resolve the actual current request against the prior answer, including its comparisons and references, rather than answering an earlier question. An accurate limit of the supplied evidence is permitted and must not be removed merely because an additional fact is unconfirmed. Do not repeat this draft or search unless it will resolve the specific missing support.";
  const truthfulCorrection = truthfulActionCorrection(policy.reasons || [], policy.truthfulActionState || {});
  const actionableCorrection = [
    truthfulCorrection || correction,
    hasUnestablishedService && !correction.includes("The approved content describes a process")
      ? "Separately, keep neutral process facts only when current-turn evidence states them, preserve the actor named by that evidence, and do not attribute the process to REFAL without explicit service evidence. State the specific REFAL role as unconfirmed when the evidence does not establish it."
      : null,
    hasUnansweredRequest
      ? "Answer every unanswered part of the customer's current request explicitly. A follow-up question does not replace that answer; when approved content cannot support a part, state the narrowest accurate limit without claiming broader completeness or asking the customer to supply the missing company fact."
      : null
  ].filter(Boolean).join(" ");
  return {
    step,
    tool: "responsePolicyCheck",
    args: { attemptedType: decisionType },
    result: { ok: false, status: "policy_rejected", reasonCode: diagnosticCodes.join(","),
      draft: policy.text, blockedClaims: policy.blockedClaims || [], correction: actionableCorrection }
  };
}

function normalizedSearchQueries(args) {
  return [args?.query, ...(Array.isArray(args?.relatedQueries) ? args.relatedQueries : [])]
    .map((value) => String(value || "").normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}]+/gu, " ").trim())
    .filter(Boolean);
}

// A knowledge search adds nothing when every query it carries was already
// searched this turn: the same text, the same words in another order, or a
// subset of an earlier query's words (broader, not more specific). A call
// with any materially more specific or different query still runs.
function isRepeatedKnowledgeSearch(args, observations) {
  const requested = normalizedSearchQueries(args);
  if (!requested.length) return false;
  const previous = observations.filter((item) => item?.tool === "searchApprovedKnowledge" && item.result?.status !== "error"
    && item.result?.status !== "skipped").flatMap((item) => normalizedSearchQueries(item.args));
  if (!previous.length) return false;
  const previousTokens = previous.map((query) => new Set(query.split(" ")));
  return requested.every((query) => {
    if (previous.includes(query)) return true;
    const tokens = query.split(" ");
    return previousTokens.some((known) => tokens.every((token) => known.has(token)));
  });
}

function normalizeBlockedClaimKey(claim) {
  const sentence = String(claim?.sentence || claim?.claim || "").normalize("NFKC").toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (!sentence) return null;
  return sentence;
}

function currentSearchEvidenceIds(observations) {
  const ids = observations.filter((item) => item?.tool === "searchApprovedKnowledge")
    .flatMap((item) => item?.result?.modelObservation?.evidence || [])
    .map((item) => item?.sourceRef).filter((id) => typeof id === "string");
  return new Set(ids);
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
    const primarySearchRefs = new Set(Array.isArray(model.primarySearchRefs) ? model.primarySearchRefs : []);
    for (const item of model.candidateEvidence) {
      const key = item.sourceRef || JSON.stringify([item.title, item.section, item.content]);
      const candidate = { item, round, roundIndex, primarySearchMatch: primarySearchRefs.has(key) };
      const existing = pool.get(key);
      if (!existing || Number(item.relevance || 1) >= Number(existing.item.relevance || 1)) pool.set(key, candidate);
    }
  }
  const latestRoundIndex = Math.max(0, rounds.length - 1);
  const isLatestPrimaryMatch = (candidate) => candidate.roundIndex === latestRoundIndex && candidate.primarySearchMatch;
  const selectionScore = (candidate) => Number(candidate.item.relevance || 1)
    // Same-turn searches answer different parts of one request. Keep a strong
    // earlier primary match when a later contextual query drifts, while a
    // genuinely higher-ranked new result can still replace it.
    + (candidate.primarySearchMatch ? (isLatestPrimaryMatch(candidate) ? 0.5 : 1.5) : 0);
  const ranked = [...pool.values()].sort((a, b) => selectionScore(b) - selectionScore(a)
    // A focused current search gets a modest, bounded preference over stale
    // non-history context. Explicitly relevant history retains its existing
    // relevance boost, and generic equal-ranked results stay stable.
    // Equal-ranked later search results have not shown that they are better.
    // Keep earlier usable evidence ahead of them so unrelated query drift or
    // a long new section cannot evict the answer's existing support.
    || a.roundIndex - b.roundIndex || Number(a.item.selectionOrder || 0) - Number(b.item.selectionOrder || 0));
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

// The decision prompt planner (agentDecision.buildDecisionPrompt) chooses a
// layout that leaves at least the reserved evidence space, trimming secondary
// guidance, older history and tool detail first, and reports how many bytes
// evidence may use. Complete sections are retained in rank order or omitted,
// and the model and both reviewers see exactly the retained set.
function budgetCurrentEvidence(context, observations, tools) {
  const plan = buildDecisionPrompt(context, observations, tools);
  const availableBytes = plan.evidenceBudgetBytes;
  return { ...boundAccumulatedKnowledgeEvidence(observations, 10000, availableBytes), availableBytes, layout: plan.layout };
}

// Content-free size report of the exact prompt the next decision receives.
function promptBudgetReport(context, observations, tools) {
  return buildDecisionPrompt(context, observations, tools).report;
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

// RAFA_SMART_FOLLOWUPS / RAFA_ANSWER_FIRST_STYLE: deterministic text edits
// applied before every other gate, so the edited draft is what the gates and
// the reviewer judge. They only remove a generic or repeated question or a
// repeated name opener; they never add text and never call a model.
function applyConversationStyleEdits(text, context = {}) {
  const features = context.conversationFeatures;
  if (!features) return text;
  let draft = text;
  if (features.smartFollowups === true && context.sessionState) {
    const stripped = stripUnhelpfulFollowups(draft, context.sessionState, { knownFacts: context.knownCustomerFacts });
    if (stripped.removed.length) { draft = stripped.text; countFollowupRemovals(context.conversationQuality, stripped.removed); }
  }
  if (features.answerFirstStyle === true && context.sessionState?.user?.name?.status === "confirmed") {
    const previousResponse = [...(Array.isArray(context.recentConversation) ? context.recentConversation : [])].reverse().find((turn) => turn?.role === "assistant")?.content || "";
    const conv = context.sessionState.conversation || {};
    const allowName = conv.recapRequested === true || (Array.isArray(context.intents) && context.intents.includes("greeting"))
      || (conv.corrections || []).some((entry) => entry.key === "name" && entry.turnId === "current");
    const deduped = dedupeLeadingName(draft, { name: context.sessionState.user.name.value, previousResponse, allowName });
    if (deduped.changed) { draft = deduped.text; if (context.conversationQuality) context.conversationQuality.nameOpenersDeduped += 1; }
  }
  return draft;
}

async function checkDraftPolicy(text, thresholds, observations, locale, context = {}, assessDraft = null, step = 0) {
  // A clarify decision is itself the question, so it is never stripped.
  if (context.conversationFeatures && thresholds !== AGENT_CLARIFY_THRESHOLDS) text = applyConversationStyleEdits(text, context);
  if (context.conversationFeatures?.smartFollowups === true && thresholds === AGENT_CLARIFY_THRESHOLDS
    && (context.sessionState?.conversation?.clarificationStreak || 0) >= 1) {
    if (context.conversationQuality) context.conversationQuality.clarificationLimitHits += 1;
    return { valid: false, text, reasons: ["smart_followup:clarification_limit"] };
  }
  const evidenceItems = currentDraftEvidence(observations, context);
  const semanticGrounding = typeof assessDraft === "function";
  const policy = validateResponse(text, { ...thresholds, customerMessage: context.currentMessage, evidence: evidenceItems, language: locale, semanticGrounding });
  if (!policy.valid) return policy;
  const repeatedFields = findRepeatedQuestion(text, context.knownCustomerFacts);
  if (repeatedFields.length) return { ...policy, valid: false, reasons: repeatedFields.map((field) => `never_reask:${field}`) };
  if (context.conversationFeatures?.truthfulActionStates === true) {
    // RAFA_TRUTHFUL_ACTION_STATES: no handoff/record/booking/response-time/
    // security/liability/guarantee/memory claim beyond the real state.
    const truthful = evaluateTruthfulActions(policy.text, { actionState: context.sessionState?.actions || {}, evidenceItems, observations });
    if (!truthful.valid) {
      if (context.conversationQuality) context.conversationQuality.unsupportedClaimsBlocked += truthful.reasons.length;
      return { ...policy, valid: false, reasons: truthful.reasons, blockedClaims: truthful.blockedClaims, truthfulActionState: truthful.state };
    }
    if (truthful.removed.length) {
      if (context.conversationQuality) context.conversationQuality.unsupportedClaimsRemoved += truthful.removed.length;
      text = truthful.text;
      policy.text = truthful.text;
    }
  }
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
async function runAgentTurn(context, { decideNextStep, assessDraft = null, tools = {}, toolContext = {}, maxSteps = DEFAULT_MAX_STEPS, initialObservations = [], onToolCall = async () => {}, onPolicyRejection = async () => {}, onPromptBudget = async () => {} } = {}) {
  if (typeof decideNextStep !== "function") throw new Error("runAgentTurn requires a decideNextStep function.");
  const observations = Array.isArray(initialObservations) ? [...initialObservations] : [];
  const toolsUsed = [...new Set(observations.map((item) => item?.tool).filter((name) => typeof name === "string"))];
  // A search that ran before the first decision (RAFA_FACTUAL_SEARCH_FIRST)
  // spends the same per-turn search budget and failure state as one the
  // model requested.
  const initialSearches = observations.filter((item) => item?.tool === "searchApprovedKnowledge");
  let knowledgeSearchCalls = initialSearches.length;
  const initialFailure = initialSearches.find((item) => item?.result?.status === "error");
  let knowledgeSearchFailed = Boolean(initialFailure);
  let knowledgeSearchFailureReason = initialFailure
    ? (/^[A-Z][A-Z0-9_.-]{0,39}$/u.test(String(initialFailure.result.reasonCode || "")) ? initialFailure.result.reasonCode : "KNOWLEDGE_SEARCH_FAILED") : null;
  let knowledgeSearchExhausted = knowledgeSearchFailed || knowledgeSearchCalls >= MAX_KNOWLEDGE_SEARCH_CALLS;
  const rejectedDrafts = new Map();
  const rejectedClaims = new Map();

  for (let step = 1; step <= maxSteps; step += 1) {
    let rawDecision;
    try {
      // Reserve the final model call for composing an answer. It receives no
      // tools, so retrieval cannot consume the entire bounded turn.
      const availableTools = step === maxSteps && maxSteps > 1 ? {}
        : knowledgeSearchExhausted ? Object.fromEntries(Object.entries(tools).filter(([name]) => name !== "searchApprovedKnowledge"))
          : tools;
      const evidenceBudget = budgetCurrentEvidence(context, observations, availableTools);
      try { await onPromptBudget({ step, ...promptBudgetReport(context, observations, availableTools) }); } catch { /* Telemetry must not change the turn. */ }
      // Hard invariant: a search that returned usable approved evidence must
      // never be followed by a decision that sees none of it. If not even the
      // highest-ranked section fits, stop with the safe fallback instead of
      // letting the model answer company facts from zero evidence.
      if (evidenceBudget.candidateCount > 0 && evidenceBudget.evidenceCount === 0) {
        return { finished: true, outcome: "prompt_budget_exhausted", response: safeFallback(context), steps: observations,
          toolsUsed, stepCount: step, reason: "PROMPT_BUDGET_EXHAUSTED" };
      }
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
          result: { ok: false, status: knowledgeSearchFailed ? "search_unavailable" : "search_exhausted",
            reasonCode: knowledgeSearchFailed ? knowledgeSearchFailureReason || "KNOWLEDGE_SEARCH_FAILED" : "NO_NEW_RELEVANT_SECTIONS" } });
        const hasApprovedEvidence = hasCurrentApprovedEvidence(observations);
        if (knowledgeSearchFailed && !hasApprovedEvidence) {
          return { finished: true, outcome: "knowledge_unavailable", response: safeFallback(context), steps: observations,
            toolsUsed, stepCount: step, reason: knowledgeSearchFailureReason || "KNOWLEDGE_SEARCH_FAILED" };
        }
        // If retrieval failed after returning evidence, or was exhausted with
        // no new sections, let the model compose from what is already in the
        // current turn. Never repeat a failed search or discard usable evidence.
        // Do not let repeated search requests consume the reserved recovery step.
        // Search is already unavailable and the evidence set has not changed.
        // Skip repeated model decisions and move to the reserved composition
        // step, preserving the final validation-correction step.
        step = Math.max(step, maxSteps - 2);
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
      const repeated = validated.tool === "searchApprovedKnowledge" && isRepeatedKnowledgeSearch(validated.args, observations);
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
      if (validated.tool === "searchApprovedKnowledge") knowledgeSearchCalls += 1;
      const toolStartedAt = performance.now();
      try {
        result = await tool.run(validated.args, toolContext);
      } catch (error) {
        result = { ok: false, status: "error", reasonCode: /^[A-Z][A-Z0-9_.-]{0,39}$/u.test(String(error?.code || "")) ? error.code : "TOOL_THREW" };
      }
      const observation = { step, tool: validated.tool, args: validated.args, result };
      observations.push(observation);
      if (validated.tool === "searchApprovedKnowledge" && result?.status === "error") {
        // A transport/provider failure is distinct from an empty knowledge
        // result. Preserve any earlier approved evidence and allow other
        // authorized tools, but never spend another step repeating retrieval
        // that just failed technically.
        knowledgeSearchFailed = true;
        knowledgeSearchFailureReason = /^[A-Z][A-Z0-9_.-]{0,39}$/u.test(String(result.reasonCode || ""))
          ? result.reasonCode : "KNOWLEDGE_SEARCH_FAILED";
        knowledgeSearchExhausted = true;
      }
      const evidenceBudget = validated.tool === "searchApprovedKnowledge" ? budgetCurrentEvidence(context, observations, tools) : null;
      if (validated.tool === "searchApprovedKnowledge" && result?.ok === true
        && result.status === "found" && evidenceBudget?.newEvidenceCount === 0) {
        knowledgeSearchExhausted = true;
        if (result.status === "found") {
          observation.result.status = "no_new_evidence";
          observation.result.reasonCode = "NO_NEW_RELEVANT_SECTIONS";
          if (observation.result.modelObservation) observation.result.modelObservation.status = "no_new_evidence";
        }
      }
      // Broad searches already run the approved profile, generated facets,
      // and exact customer wording in parallel. The next search-selection
      // model call tends to paraphrase that same bundle and often returns no
      // additional section. Drop the large retrieval tool description from
      // the answer prompt, keep the remaining review/correction steps, and go
      // directly to composition with the complete bounded evidence bundle.
      if (validated.tool === "searchApprovedKnowledge" && result?.ok === true
        && result.status === "found" && result.trace?.comprehensiveSearch === true
        && evidenceBudget?.newEvidenceCount > 0) {
        knowledgeSearchExhausted = true;
        if (!toolsUsed.includes(validated.tool)) toolsUsed.push(validated.tool);
        step = Math.max(step, maxSteps - 3);
        continue;
      }
      // A search call can already combine the current message, two
      // complementary model queries, and the customer's prior-language
      // wording. One focused recovery call is enough when the first search
      // leaves a distinct gap. Requiring a response after that bounded pair
      // prevents query drift from consuming every model step without adding
      // useful answer evidence.
      if (validated.tool === "searchApprovedKnowledge" && knowledgeSearchCalls >= MAX_KNOWLEDGE_SEARCH_CALLS) {
        knowledgeSearchExhausted = true;
      }
      const evidence = result?.modelObservation?.evidence || [];
      try { await onToolCall({ step, tool: validated.tool, args: validated.args, result, durationMs: Math.max(0, Math.round(performance.now() - toolStartedAt)),
        evidenceCount: evidenceBudget?.evidenceCount ?? evidence.length, evidenceChars: evidenceBudget?.evidenceChars,
        candidateCount: result.trace?.candidateCount ?? evidenceBudget?.candidateCount, newCandidateCount: evidenceBudget?.newCandidateCount,
        newEvidenceCount: evidenceBudget?.newEvidenceCount,
        retainedIds: evidenceBudget?.retainedIds, evidenceBudgetAvailableBytes: evidenceBudget?.availableBytes,
        excludedIds: [...(result.trace?.excludedIds || []), ...(evidenceBudget?.excludedIds || [])], contextOmittedIds: evidenceBudget?.excludedIds, replacedIds: evidenceBudget?.replacedIds,
        candidateIds: result.trace?.candidateIds, evidenceAssemblyDurationMs: result.trace?.evidenceAssemblyDurationMs, selectionStatus: result.trace?.selectionStatus,
        providerErrorCode: result.trace?.providerErrorCode, providerStatus: result.trace?.providerStatus, errorName: result.trace?.errorName,
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
        if (knowledgeSearchFailed && !hasCurrentApprovedEvidence(observations)) return {
          finished: true, outcome: "knowledge_unavailable", response: safeFallback(context),
          steps: observations, toolsUsed, stepCount: step,
          reason: knowledgeSearchFailureReason || "KNOWLEDGE_SEARCH_FAILED"
        };
        const evidenceIds = currentSearchEvidenceIds(observations);
        const blockedClaims = policy.blockedClaims || evaluateAnswerClaims(validated.text, { evidence: evidenceItems, language: context?.locale }).blocked;
        const repeatedBlockedClaimWithoutEvidenceProgress = policy.reasons.some((reason) => ["prohibited_claim", "no_approved_evidence"].includes(reason)) && blockedClaims.some((claim) => {
          if (!(claim.reasons || []).some((reason) => ["no_approved_evidence", "entities_not_in_evidence"].includes(reason))) return false;
          const key = normalizeBlockedClaimKey(claim);
          if (!key) return false;
          const previousEvidence = rejectedClaims.get(key);
          const evidenceProgress = previousEvidence instanceof Set && [...evidenceIds].some((id) => !previousEvidence.has(id));
          rejectedClaims.set(key, new Set([...(previousEvidence || []), ...evidenceIds]));
          return previousEvidence !== undefined && !evidenceProgress;
        });
        if (policy.technicalFailure || policy.reasons.includes("repeated_rejected_draft") || repeatedBlockedClaimWithoutEvidenceProgress) return {
          finished: true, outcome: policy.technicalFailure ? "validation_failed" : "response_rejected", response: safeFallback(context),
          steps: observations, toolsUsed, stepCount: step, reason: policy.errorCode || (repeatedBlockedClaimWithoutEvidenceProgress ? "repeated_blocked_claim_without_evidence_progress" : policy.reasons.join(","))
        };
        const corrected = assessDraft ? null : attemptDeterministicCorrection(validated.text, policy, thresholds, { ...context, observations });
        if (corrected) {
          return { finished: true, outcome: "responded", response: corrected, steps: observations, toolsUsed, stepCount: step, corrected: true };
        }
        const evidenceBoundPartial = await attemptEvidenceBoundPartialCorrection(validated.text, policy, thresholds,
          { ...context, observations }, assessDraft, step);
        if (evidenceBoundPartial) {
          return { finished: true, outcome: "responded", response: evidenceBoundPartial, steps: observations, toolsUsed, stepCount: step, corrected: true };
        }
        if (step < maxSteps) {
        observations.push(policyRejectionObservation(step, "respond", policy, diagnosticPolicyCodes(validated.text, policy, evidenceItems, context?.locale), observations));
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
    if (!policy.valid && policy.reasons?.includes("smart_followup:clarification_limit")) {
      // RAFA_SMART_FOLLOWUPS: one clarification per topic. A second one goes to
      // the existing safe fallback instead of questioning the customer again.
      return { finished: true, outcome: "clarify_rejected", response: safeFallback(context), steps: observations, toolsUsed, stepCount: step, reason: "clarification_limit" };
    }
    if (!policy.valid) {
      rejectedDrafts.set(progressKey, policy);
      const evidenceItems = currentDraftEvidence(observations, context);
      try { await onPolicyRejection({ step, type: "clarify", reasonCodes: diagnosticPolicyCodes(validated.text, policy, evidenceItems, context?.locale), draft: validated.text, evidence: evidenceItems, claims: policy.blockedClaims || evaluateAnswerClaims(validated.text, { evidence: evidenceItems, language: context?.locale }).blocked }); } catch {}
      if (knowledgeSearchFailed && !hasCurrentApprovedEvidence(observations)) return {
        finished: true, outcome: "knowledge_unavailable", response: safeFallback(context),
        steps: observations, toolsUsed, stepCount: step,
        reason: knowledgeSearchFailureReason || "KNOWLEDGE_SEARCH_FAILED"
      };
      if (policy.technicalFailure || policy.reasons.includes("repeated_rejected_draft")) return {
        finished: true, outcome: policy.technicalFailure ? "validation_failed" : "clarify_rejected", response: safeFallback(context),
        steps: observations, toolsUsed, stepCount: step, reason: policy.errorCode || policy.reasons.join(",")
      };
      const corrected = assessDraft ? null : attemptDeterministicCorrection(validated.text, policy, clarifyThresholds, { ...context, observations });
      if (corrected) {
        return { finished: true, outcome: "clarified", response: corrected, steps: observations, toolsUsed, stepCount: step, corrected: true };
      }
      if (step < maxSteps) {
        observations.push(policyRejectionObservation(step, "clarify", policy, diagnosticPolicyCodes(validated.text, policy, evidenceItems, context?.locale), observations));
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

module.exports = { runAgentTurn, validateDecision, DEFAULT_MAX_STEPS, MAX_KNOWLEDGE_SEARCH_CALLS, boundAccumulatedKnowledgeEvidence, policyRejectionObservation, isRepeatedKnowledgeSearch };
