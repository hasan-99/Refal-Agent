// REFAL-AGENT-016 — pure scoring/aggregation logic for the legacy-vs-Agent
// benchmark. No network, no model calls, no side effects — takes already-
// executed turn results and produces metrics. This is the one file the
// framework's deterministic tests target directly.

const OPEN_TICKETS = Object.freeze({
  "REFAL-AGENT-022": "safetyPolicy bare-credential-keyword false positive",
  "REFAL-AGENT-023": "followUp Arabic/Greek goodbye + Arabic-only re-engagement",
  "REFAL-AGENT-024": "conversationRecap fixed-backstory bug",
  "REFAL-AGENT-025": "Greek booking date-word normalization",
  "REFAL-AGENT-026": "Agent response-language validation"
});

// Turn-score shape (one per scenario+arm+run):
// {
//   scenarioId, arm: "legacy"|"agent", runIndex, locale, category, featureTags,
//   status: "measured" | "not_measurable" | "infrastructure_error",
//   notMeasurableReason, infrastructureErrorKind,
//   knownTicket: null | "REFAL-AGENT-0NN",
//   outcome: string|null,
//   metrics: {
//     currentRequestAnswered, unnecessaryQuestion, unnecessaryToolCall,
//     fallbackUsed, fallbackReason, rejectionReasonCodes, languageMismatch,
//     stepCount, toolsUsed, ragStatus, toolFailure, unsafeDraftBlocked,
//     unsafeFinalResponse
//   }
// }
//
// unsafeDraftBlocked vs unsafeFinalResponse (2026-10-06 audit): these measure
// opposite things and must never be merged back into one field.
// unsafeDraftBlocked = a drafted claim was rejected by the deterministic
// response policy and never became the delivered response (the safety net
// working — informational, NOT a readiness failure on its own).
// unsafeFinalResponse = the actual text that would reach the customer
// contains an unverified claim (a real failure — this is what gates
// readiness).

function isBool(value) {
  return typeof value === "boolean";
}

// Rate over a metric key, excluding null/undefined (NOT_APPLICABLE) turns
// from BOTH numerator and denominator — the required behavior: a metric
// that was never evaluable must never silently count as a pass or a fail.
function rate(turns, metricKey) {
  const evaluable = turns.filter((t) => isBool(t.metrics?.[metricKey]));
  if (evaluable.length === 0) return { rate: null, numerator: 0, denominator: 0 };
  const numerator = evaluable.filter((t) => t.metrics[metricKey] === true).length;
  return { rate: numerator / evaluable.length, numerator, denominator: evaluable.length };
}

function countBy(turns, pickKey) {
  const counts = {};
  for (const turn of turns) {
    const value = pickKey(turn);
    const list = Array.isArray(value) ? value : value != null ? [value] : [];
    for (const item of list) counts[item] = (counts[item] || 0) + 1;
  }
  return counts;
}

function numericStats(values) {
  const nums = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (nums.length === 0) return { mean: null, median: null, max: null, count: 0 };
  const sorted = [...nums].sort((a, b) => a - b);
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { mean, median, max: sorted[sorted.length - 1], count: nums.length };
}

// --- repeated-run aggregation (per scenario+arm) -----------------------------
// `isPass(turn)` decides what counts as "passed" for this scenario — caller-
// supplied so the same aggregator works for any pass definition (e.g.
// "status === measured && currentRequestAnswered !== false && !unsafeFinalResponse").
function aggregateRuns(turns, isPass) {
  if (turns.length === 0) return { runCount: 0, passRate: null, variance: null, majorityOutcome: null, outcomes: {} };
  const passFlags = turns.map((t) => (isPass(t) ? 1 : 0));
  const passRate = passFlags.reduce((a, b) => a + b, 0) / passFlags.length;
  const mean = passRate;
  const variance = passFlags.length > 1
    ? passFlags.reduce((sum, v) => sum + (v - mean) ** 2, 0) / passFlags.length
    : 0;
  const outcomeCounts = countBy(turns, (t) => t.outcome || "unknown");
  const majorityOutcome = Object.entries(outcomeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  return { runCount: turns.length, passRate, variance, majorityOutcome, outcomes: outcomeCounts };
}

// --- overall aggregation ------------------------------------------------------
function aggregateScenarios(allTurns) {
  const measured = allTurns.filter((t) => t.status === "measured");
  const notMeasurable = allTurns.filter((t) => t.status === "not_measurable");
  const infrastructureErrors = allTurns.filter((t) => t.status === "infrastructure_error");
  const knownTicketAffected = allTurns.filter((t) => t.knownTicket && OPEN_TICKETS[t.knownTicket]);
  // "Unexpected" behavioral failures: measured, scored as a failure on at
  // least one safety/core dimension, and NOT explained by an open ticket.
  const unexpectedFailures = measured.filter((t) =>
    !t.knownTicket &&
    (t.metrics.currentRequestAnswered === false || t.metrics.unsafeFinalResponse === true || t.metrics.unnecessaryToolCall === true)
  );

  const metrics = {
    currentRequestAnsweredRate: rate(measured, "currentRequestAnswered"),
    unnecessaryQuestionRate: rate(measured, "unnecessaryQuestion"),
    unnecessaryToolCallRate: rate(measured, "unnecessaryToolCall"),
    genericFallbackRate: rate(measured, "fallbackUsed"),
    languageMismatchRate: rate(measured, "languageMismatch"),
    toolFailureRate: rate(measured, "toolFailure"),
    unsafeDraftBlockedRate: rate(measured, "unsafeDraftBlocked"),
    unsafeFinalResponseRate: rate(measured, "unsafeFinalResponse")
  };

  const fallbackReasonDistribution = countBy(measured.filter((t) => t.metrics.fallbackUsed === true), (t) => t.metrics.fallbackReason || "unspecified");
  const rejectionReasonDistribution = countBy(measured, (t) => t.metrics.rejectionReasonCodes || []);
  const toolUsageDistribution = countBy(measured, (t) => t.metrics.toolsUsed || []);
  const ragStatusDistribution = countBy(measured, (t) => t.metrics.ragStatus || null);
  const stepStats = numericStats(measured.map((t) => t.metrics.stepCount));
  const scenariosAtMaxSteps = measured.filter((t) => typeof t.metrics.stepCount === "number" && typeof t.metrics.maxSteps === "number" && t.metrics.stepCount >= t.metrics.maxSteps).map((t) => t.scenarioId);

  const byLocale = {};
  for (const turn of allTurns) {
    const key = turn.locale || "unknown";
    (byLocale[key] = byLocale[key] || []).push(turn);
  }
  const localeBreakdown = Object.fromEntries(Object.entries(byLocale).map(([locale, turns]) => [locale, summarizeGroup(turns)]));

  const byFeature = {};
  for (const turn of allTurns) {
    for (const tag of turn.featureTags || ["uncategorized"]) (byFeature[tag] = byFeature[tag] || []).push(turn);
  }
  const featureBreakdown = Object.fromEntries(Object.entries(byFeature).map(([tag, turns]) => [tag, summarizeGroup(turns)]));

  return {
    totals: { total: allTurns.length, measured: measured.length, notMeasurable: notMeasurable.length, infrastructureErrors: infrastructureErrors.length },
    metrics,
    fallbackReasonDistribution,
    rejectionReasonDistribution,
    toolUsageDistribution,
    ragStatusDistribution,
    stepStats,
    scenariosAtMaxSteps,
    knownTicketAffected: knownTicketAffected.map((t) => ({ scenarioId: t.scenarioId, arm: t.arm, runIndex: t.runIndex, ticket: t.knownTicket, reason: OPEN_TICKETS[t.knownTicket] })),
    unexpectedFailures: unexpectedFailures.map((t) => ({ scenarioId: t.scenarioId, arm: t.arm, runIndex: t.runIndex, outcome: t.outcome, metrics: t.metrics })),
    localeBreakdown,
    featureBreakdown
  };
}

function summarizeGroup(turns) {
  const measured = turns.filter((t) => t.status === "measured");
  return {
    total: turns.length,
    measured: measured.length,
    currentRequestAnsweredRate: rate(measured, "currentRequestAnswered"),
    unnecessaryQuestionRate: rate(measured, "unnecessaryQuestion"),
    languageMismatchRate: rate(measured, "languageMismatch"),
    fallbackRate: rate(measured, "fallbackUsed")
  };
}

// Excluding known-open-ticket-affected failures from the "raw" picture, per
// the ticket's "report both raw and excluding known-ticket failures" rule.
function aggregateExcludingKnownTickets(allTurns) {
  return aggregateScenarios(allTurns.filter((t) => !t.knownTicket));
}

module.exports = {
  OPEN_TICKETS,
  rate,
  countBy,
  numericStats,
  aggregateRuns,
  aggregateScenarios,
  aggregateExcludingKnownTickets
};
