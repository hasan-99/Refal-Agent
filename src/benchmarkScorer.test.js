// REFAL-AGENT-016 — deterministic tests for the benchmark scorer/aggregator.
// No network, no model calls — pure function tests against hand-built turn
// fixtures.

const test = require("node:test");
const assert = require("node:assert/strict");
const { rate, aggregateRuns, aggregateScenarios, aggregateExcludingKnownTickets, OPEN_TICKETS } = require("./benchmarkScorer");

function turn(overrides = {}) {
  return {
    scenarioId: "X01", arm: "agent", runIndex: 0, locale: "english", category: "information", featureTags: ["rag"],
    status: "measured", notMeasurableReason: null, infrastructureErrorKind: null, knownTicket: null,
    outcome: "responded",
    metrics: { currentRequestAnswered: true, unnecessaryQuestion: false, unnecessaryToolCall: false, fallbackUsed: false, fallbackReason: null, rejectionReasonCodes: [], languageMismatch: false, stepCount: 2, maxSteps: 4, toolsUsed: ["searchApprovedKnowledge"], ragStatus: "found", toolFailure: false, unsafeDraftBlocked: false, unsafeFinalResponse: false },
    ...overrides
  };
}

// 1. scorer aggregates metrics correctly
test("aggregateScenarios computes correct rates from a known fixture set", () => {
  const turns = [
    turn({ metrics: { ...turn().metrics, currentRequestAnswered: true } }),
    turn({ metrics: { ...turn().metrics, currentRequestAnswered: true } }),
    turn({ metrics: { ...turn().metrics, currentRequestAnswered: false } })
  ];
  const result = aggregateScenarios(turns);
  assert.equal(result.metrics.currentRequestAnsweredRate.numerator, 2);
  assert.equal(result.metrics.currentRequestAnsweredRate.denominator, 3);
  assert.equal(result.metrics.currentRequestAnsweredRate.rate, 2 / 3);
});

// 2. NOT_APPLICABLE excluded from denominator
test("a null/undefined (not-applicable) metric is excluded from both numerator and denominator, never counted as pass or fail", () => {
  const turns = [
    turn({ metrics: { ...turn().metrics, currentRequestAnswered: true } }),
    turn({ metrics: { ...turn().metrics, currentRequestAnswered: null } }), // evaluator unavailable
    turn({ metrics: { ...turn().metrics, currentRequestAnswered: undefined } })
  ];
  const result = rate(turns, "currentRequestAnswered");
  assert.equal(result.denominator, 1, "only the one boolean-valued turn should count");
  assert.equal(result.numerator, 1);
  assert.equal(result.rate, 1);
});

test("an all-not-applicable metric reports rate: null rather than dividing by zero", () => {
  const turns = [turn({ metrics: { ...turn().metrics, currentRequestAnswered: null } })];
  const result = rate(turns, "currentRequestAnswered");
  assert.equal(result.rate, null);
  assert.equal(result.denominator, 0);
});

// 3. repeated runs aggregate correctly (pass rate / variance / majority)
test("aggregateRuns computes pass rate, variance, and majority outcome across repeated runs", () => {
  const runs = [
    turn({ runIndex: 0, outcome: "responded" }),
    turn({ runIndex: 1, outcome: "responded" }),
    turn({ runIndex: 2, outcome: "response_rejected", metrics: { ...turn().metrics, currentRequestAnswered: false } })
  ];
  const result = aggregateRuns(runs, (t) => t.metrics.currentRequestAnswered === true);
  assert.equal(result.runCount, 3);
  assert.equal(result.passRate, 2 / 3);
  assert.ok(result.variance > 0, "variance should be non-zero when runs disagree");
  assert.equal(result.majorityOutcome, "responded");
});

test("aggregateRuns never silently picks only the best run — passRate reflects ALL runs", () => {
  const runs = [turn({ metrics: { ...turn().metrics, currentRequestAnswered: false } }), turn({ metrics: { ...turn().metrics, currentRequestAnswered: false } }), turn()];
  const result = aggregateRuns(runs, (t) => t.metrics.currentRequestAnswered === true);
  assert.equal(result.passRate, 1 / 3, "2 failing runs must still count toward the rate, not be discarded");
});

// 4. known open-ticket failures tagged correctly
test("a turn tagged with a known open ticket is excluded from unexpectedFailures and listed under knownTicketAffected", () => {
  const turns = [
    turn({ knownTicket: "REFAL-AGENT-023", metrics: { ...turn().metrics, currentRequestAnswered: false } }),
    turn({ metrics: { ...turn().metrics, currentRequestAnswered: false } }) // same failure, no ticket
  ];
  const result = aggregateScenarios(turns);
  assert.equal(result.knownTicketAffected.length, 1);
  assert.equal(result.knownTicketAffected[0].ticket, "REFAL-AGENT-023");
  assert.equal(result.knownTicketAffected[0].reason, OPEN_TICKETS["REFAL-AGENT-023"]);
  assert.equal(result.unexpectedFailures.length, 1, "only the untagged failure should be unexpected");
});

test("aggregateExcludingKnownTickets removes known-ticket turns entirely from the recomputed metrics", () => {
  const turns = [
    turn({ knownTicket: "REFAL-AGENT-022", metrics: { ...turn().metrics, currentRequestAnswered: false } }),
    turn({ metrics: { ...turn().metrics, currentRequestAnswered: true } })
  ];
  const raw = aggregateScenarios(turns);
  const excluding = aggregateExcludingKnownTickets(turns);
  assert.equal(raw.metrics.currentRequestAnsweredRate.rate, 0.5);
  assert.equal(excluding.metrics.currentRequestAnsweredRate.rate, 1, "with the known-ticket turn excluded, the remaining turn is a clean pass");
});

// 5. infrastructure errors separated from behavioral failures
test("infrastructure_error turns are counted separately and never pollute behavioral metrics", () => {
  const turns = [
    turn({ status: "infrastructure_error", infrastructureErrorKind: "network", outcome: "decision_failed", metrics: { currentRequestAnswered: null, unnecessaryQuestion: null, unnecessaryToolCall: null, fallbackUsed: null, fallbackReason: null, rejectionReasonCodes: [], languageMismatch: null, stepCount: 1, maxSteps: 4, toolsUsed: [], ragStatus: null, toolFailure: null, unsafeDraftBlocked: null, unsafeFinalResponse: null } }),
    turn({ metrics: { ...turn().metrics, currentRequestAnswered: true } })
  ];
  const result = aggregateScenarios(turns);
  assert.equal(result.totals.infrastructureErrors, 1);
  assert.equal(result.totals.measured, 1);
  assert.equal(result.metrics.currentRequestAnsweredRate.denominator, 1, "the infrastructure_error turn must not be measured as a behavioral pass or fail");
});

// 6. language metrics aggregate correctly
test("localeBreakdown computes per-locale rates independently", () => {
  const turns = [
    turn({ locale: "english", metrics: { ...turn().metrics, languageMismatch: false } }),
    turn({ locale: "arabic", metrics: { ...turn().metrics, languageMismatch: true } }),
    turn({ locale: "arabic", metrics: { ...turn().metrics, languageMismatch: false } })
  ];
  const result = aggregateScenarios(turns);
  assert.equal(result.localeBreakdown.english.languageMismatchRate.rate, 0);
  assert.equal(result.localeBreakdown.arabic.languageMismatchRate.rate, 0.5);
});

// 7. fallback reason distribution correct
test("fallbackReasonDistribution counts each reason, only across turns where fallback actually occurred", () => {
  const turns = [
    turn({ metrics: { ...turn().metrics, fallbackUsed: true, fallbackReason: "model_decision_failure" } }),
    turn({ metrics: { ...turn().metrics, fallbackUsed: true, fallbackReason: "model_decision_failure" } }),
    turn({ metrics: { ...turn().metrics, fallbackUsed: true, fallbackReason: "response_policy_rejection" } }),
    turn({ metrics: { ...turn().metrics, fallbackUsed: false, fallbackReason: null } })
  ];
  const result = aggregateScenarios(turns);
  assert.deepEqual(result.fallbackReasonDistribution, { model_decision_failure: 2, response_policy_rejection: 1 });
});

// 8. tool usage aggregation correct
test("toolUsageDistribution counts each tool across all measured turns' toolsUsed arrays", () => {
  const turns = [
    turn({ metrics: { ...turn().metrics, toolsUsed: ["searchApprovedKnowledge"] } }),
    turn({ metrics: { ...turn().metrics, toolsUsed: ["searchApprovedKnowledge", "proposeHandover"] } }),
    turn({ metrics: { ...turn().metrics, toolsUsed: [] } })
  ];
  const result = aggregateScenarios(turns);
  assert.deepEqual(result.toolUsageDistribution, { searchApprovedKnowledge: 2, proposeHandover: 1 });
});

test("numericStats (step count mean/median/max) ignores non-numeric and tracks MAX_AGENT_STEPS scenarios", () => {
  const turns = [
    turn({ metrics: { ...turn().metrics, stepCount: 1, maxSteps: 4 } }),
    turn({ metrics: { ...turn().metrics, stepCount: 4, maxSteps: 4 } }),
    turn({ scenarioId: "X02", metrics: { ...turn().metrics, stepCount: null, maxSteps: 4 } })
  ];
  const result = aggregateScenarios(turns);
  assert.equal(result.stepStats.count, 2);
  assert.equal(result.stepStats.max, 4);
  assert.deepEqual(result.scenariosAtMaxSteps, ["X01"]); // only the stepCount===maxSteps turn
});
