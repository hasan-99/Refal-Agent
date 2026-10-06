// REFAL-AGENT-013 — Agent observability and shadow-comparison telemetry.
//
// Pure derivation only: every function here takes an already-finished
// runAgentTurn() result (or two of them, for comparison) and returns a safe,
// bounded-shape metadata object. Nothing in this file calls a tool, calls the
// model, awaits anything, or mutates its input — so it cannot change Agent
// decision behavior, RAG behavior, booking/handover behavior, or timing no
// matter how it is wired in. Emitting the result (via store.logEvent) is the
// caller's job (src/agentShadow.js), not this file's.
//
// Privacy contract: every field below is one of an id/enum/boolean/count/
// length/duration/reason-code — never free text. Specifically never
// included: the customer's message, the Agent's drafted or final response
// text, raw tool arguments, RAG chunk/evidence content, embeddings, or a
// full tool result's `data`/`userSafeSummary` payload. Tool `status` and
// `reasonCode` values are safe to log as-is because every tool in
// agentTools.js/agentBookingTools.js only ever returns one of a small,
// hardcoded set of literal strings for these two fields (see agentToolResult
// .js's ok()/fail() contract) — never anything derived from customer text.

// Outcomes where runAgentTurn() itself substituted a deterministic safe
// fallback response instead of delivering the Agent's own drafted text (see
// agentLoop.js). Centralized here so the per-turn summary and the shadow
// comparison agree on exactly the same definition of "fallback used".
const FALLBACK_OUTCOMES = new Set([
  "decision_failed",
  "invalid_decision",
  "response_rejected",
  "clarify_rejected",
  "max_steps_reached"
]);

// responsePolicy.js's agentLoop.js integration records a rejected
// respond/clarify attempt as a synthetic observation shaped like a tool call
// (`{ tool: "responsePolicyCheck", args: { attemptedType }, result }`) so the
// Agent's next decision can see why its last draft failed. That is the right
// shape for agentDecision.js's observation feed, but it must never be
// mistaken for a real tool call in telemetry.
const POLICY_CHECK_PSEUDO_TOOL = "responsePolicyCheck";

// REFAL-AGENT-014: ticket 013 flagged UNNECESSARY_QUESTION_RATE and
// LANGUAGE_MISMATCH_RATE as benchmark metrics (015/016) with no raw signal
// yet. Both additions below are pure derivation only (no new behavior, no
// gating) — they emit the raw ingredients a later benchmark can score, they
// do not themselves decide "unnecessary" or invent a mismatch verdict.
const { questionCount } = require("./responsePolicy");
const { detectMessageLanguage } = require("./language");

// Deliberately NOT an authoritative "was this question unnecessary" verdict
// — that requires conversation/benchmark context this file does not have.
// `clarificationRequested` is a reliable deterministic signal (the Agent's
// own decision type), `hasQuestion`/`questionCount` are reliable text counts;
// 015/016 combine these with their own benchmark context to score
// "unnecessary", not this module.
function questionSignalsFrom(response, finalOutcome) {
  const count = questionCount(response);
  return {
    questionCount: count,
    hasQuestion: count > 0,
    clarificationRequested: finalOutcome === "clarified"
  };
}

// `expectedLocale` is the turn's own context.locale (already the Agent's
// source of truth for which language to reply in — see agentContext.js).
// `detectedResponseLocale` re-runs the same script/keyword detector the
// legacy path already trusts (src/language.js, also used by ai.js's
// language-match check) against the drafted response text. Only the
// detected LANGUAGE NAME is ever logged, never the response text itself.
// A locale of "unknown" (no real expected language) or an empty response
// yields languageMismatch: null rather than a fabricated true/false, since
// there is nothing meaningful to compare — avoiding exactly the kind of
// fragile false-positive flagged in the 014 trace (a short reply dominated
// by an unavoidable English brand/URL can otherwise look mismatched).
function languageSignalsFrom(locale, response) {
  const expectedLocale = typeof locale === "string" && locale ? locale : "unknown";
  const text = typeof response === "string" ? response.trim() : "";
  if (expectedLocale === "unknown" || !text) {
    return { expectedLocale, detectedResponseLocale: null, languageMismatch: null };
  }
  const detectedResponseLocale = detectMessageLanguage(text);
  return {
    expectedLocale,
    detectedResponseLocale,
    languageMismatch: detectedResponseLocale !== expectedLocale
  };
}

function isPolicyRejectionStep(step) {
  return step?.tool === POLICY_CHECK_PSEUDO_TOOL;
}

// {tool, status, ok, reasonCode} only — never `args` (may echo customer
// text, e.g. saveCustomerFact's value or searchApprovedKnowledge's query)
// and never `result.data`/`result.userSafeSummary` (may contain RAG chunk
// content, customer facts, or appointment/handover detail).
function summarizeToolCalls(steps) {
  return steps.filter((step) => !isPolicyRejectionStep(step)).map((step) => ({
    tool: step.tool,
    status: step.result?.status ?? null,
    ok: Boolean(step.result?.ok),
    reasonCode: step.result?.reasonCode ?? null
  }));
}

function ragStatusFrom(toolCalls) {
  const ragCalls = toolCalls.filter((call) => call.tool === "searchApprovedKnowledge");
  if (!ragCalls.length) return null;
  return ragCalls[ragCalls.length - 1].status;
}

// The reasonCode on a policy-rejection observation is responsePolicy.js's
// own `reasons.join(",")` (e.g. "too_many_questions" or
// "unverified_booking_action,sensitive_value_echo") — a small, fixed set of
// policy reason codes, never the rejected draft text itself.
function rejectionReasonCodesFrom(steps) {
  const codes = steps
    .filter(isPolicyRejectionStep)
    .flatMap((step) => String(step.result?.reasonCode || "").split(","))
    .filter(Boolean);
  return [...new Set(codes)];
}

function decisionTypesUsedFrom(steps, outcome) {
  const types = new Set();
  for (const step of steps) {
    if (isPolicyRejectionStep(step)) types.add(step.args?.attemptedType === "clarify" ? "clarify" : "respond");
    else types.add("tool");
  }
  if (outcome === "responded") types.add("respond");
  if (outcome === "clarified") types.add("clarify");
  return [...types].sort();
}

// Pure: derives every safe per-turn signal from a finished runAgentTurn()
// result object. Never throws on a malformed/partial result — a missing
// field just yields a safe default, since this runs inside telemetry code
// that must never become a new way for a turn to fail.
function summarizeAgentTurn(result = {}) {
  const steps = Array.isArray(result.steps) ? result.steps : [];
  const toolCalls = summarizeToolCalls(steps);
  const toolsUsed = Array.isArray(result.toolsUsed) ? result.toolsUsed : toolCalls.map((call) => call.tool);
  const finalOutcome = result.outcome ?? null;

  return {
    stepCount: Number.isFinite(result.stepCount) ? result.stepCount : steps.length,
    toolsUsed,
    toolCallCount: toolsUsed.length,
    toolCalls,
    ragUsed: toolsUsed.includes("searchApprovedKnowledge"),
    ragResultStatus: ragStatusFrom(toolCalls),
    decisionTypesUsed: decisionTypesUsedFrom(steps, finalOutcome),
    draftRejected: steps.some(isPolicyRejectionStep),
    rejectionReasonCodes: rejectionReasonCodesFrom(steps),
    deterministicCorrectionUsed: Boolean(result.corrected),
    fallbackUsed: FALLBACK_OUTCOMES.has(finalOutcome),
    finalOutcome,
    responseLength: typeof result.response === "string" ? result.response.length : 0,
    ...questionSignalsFrom(result.response, finalOutcome)
  };
}

// Merges the pure per-turn summary with the turn-level context a caller
// (agentShadow.js today; a future live-routing caller later) already has in
// hand. `primaryIntentCategory` and `secondaryGoalCount` are read from the
// SAME deterministic intent.js classification every other path already
// computes — the Agent's own decision step does not yet produce an
// independent bounded goal category (see the shadow-comparison note below),
// so this is the clearest honest label available today, not a model output.
function buildAgentTurnEventFields({
  result,
  traceId,
  locale,
  primaryIntentCategory = null,
  secondaryGoalCount = 0,
  maxSteps = null,
  shadowMode = false,
  durationMs = null
} = {}) {
  return {
    traceId,
    locale: locale || "unknown",
    primaryIntentCategory,
    secondaryGoalCount,
    maxSteps,
    shadowMode,
    durationMs,
    ...summarizeAgentTurn(result),
    ...languageSignalsFrom(locale, result?.response)
  };
}

// Pure comparison derivation. `legacySummary` is whatever safe, already-
// computed shape the caller has for the deterministic path this turn
// (see src/bot.js); `agentResult` is the resolved return value of
// runShadowAgentTurn (already safe — never the drafted text itself beyond
// its length). Returns null if either side is missing, so the caller can
// skip logging entirely rather than emit a half-populated comparison.
//
// Known limitation (documented, not hidden): `agentPrimaryIntentCategory`
// reads the same shared classification as `legacyPrimaryIntentCategory`
// today, because the Agent path does not yet produce its own intent
// classification — `sameIntentCategory` is therefore always true by
// construction until a later ticket gives the Agent an independent goal
// label. The fields are still emitted now so the event shape is already
// correct for that future change and for Tickets 015/016's benchmarking.
function buildShadowComparisonFields({ agentResult, legacySummary } = {}) {
  if (!agentResult || !legacySummary) return null;
  const summary = summarizeAgentTurn(agentResult);
  const primaryIntentCategory = legacySummary.primaryIntentCategory ?? null;
  return {
    legacyPrimaryIntentCategory: primaryIntentCategory,
    agentPrimaryIntentCategory: primaryIntentCategory,
    sameIntentCategory: true,
    legacyUsedBookingPath: Boolean(legacySummary.usedBookingPath),
    agentProposedBookingTool: summary.toolsUsed.includes("requestBookingAction"),
    legacyUsedHandoverPath: Boolean(legacySummary.usedHandoverPath),
    agentProposedHandover: summary.toolsUsed.includes("proposeHandover"),
    legacyResponseLength: Number.isFinite(legacySummary.responseLength) ? legacySummary.responseLength : 0,
    agentResponseLength: summary.responseLength,
    agentOutcome: summary.finalOutcome,
    agentFallbackUsed: summary.fallbackUsed,
    agentStepCount: summary.stepCount,
    shadowDurationMs: Number.isFinite(agentResult.durationMs) ? agentResult.durationMs : null
  };
}

module.exports = {
  FALLBACK_OUTCOMES,
  summarizeAgentTurn,
  buildAgentTurnEventFields,
  buildShadowComparisonFields,
  questionSignalsFrom,
  languageSignalsFrom
};
