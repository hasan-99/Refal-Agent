// REFAL-AGENT-016 — deterministic tests for the benchmark markdown report
// builder: zero-denominator safety and no-raw-secrets output.

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildReportMarkdown, fmtRate } = require("./benchmarkReport");
const { aggregateScenarios } = require("./benchmarkScorer");

function emptyAgg() {
  return aggregateScenarios([]);
}

function baseInputs(overrides = {}) {
  return {
    environment: { date: "2026-10-05", branch: "feature/agentic-orchestration", commit: "abc1234", model: "test-model", evaluatorModel: "test-evaluator-model", provider: "openrouter", scenarioCount: 0, runsPerScenario: 1, maxSteps: 4, note: null },
    legacy: emptyAgg(), agent: emptyAgg(), legacyExcluding: emptyAgg(), agentExcluding: emptyAgg(),
    historical: null,
    cost: { totalCalls: 0, successfulCalls: 0, failedCalls: 0, avgCallsPerScenario: 0, totalSteps: 0, retries: 0, tokenUsageAvailable: false, promptTokens: 0, completionTokens: 0, costAvailable: false, costUsd: 0 },
    readiness: { category: "NOT_READY", evidence: ["no scenarios ran"] },
    ...overrides
  };
}

// 10. report generator handles zero denominators safely
test("fmtRate renders a null rate (zero evaluable turns) as n/a, never NaN or a crash", () => {
  assert.equal(fmtRate({ rate: null, numerator: 0, denominator: 0 }), "n/a (0 evaluable)");
  assert.equal(fmtRate(null), "n/a (0 evaluable)");
  assert.equal(fmtRate(undefined), "n/a (0 evaluable)");
});

test("buildReportMarkdown does not throw and produces a valid-looking document when every aggregate is empty (zero scenarios)", () => {
  const markdown = buildReportMarkdown(baseInputs());
  assert.equal(typeof markdown, "string");
  assert.doesNotMatch(markdown, /NaN|undefined|\[object Object\]/);
  assert.match(markdown, /# REFAL Agent Benchmark/);
  assert.match(markdown, /n\/a \(0 evaluable\)/);
});

test("buildReportMarkdown handles a populated aggregate without throwing and renders real numbers", () => {
  const turns = [
    { scenarioId: "A01", arm: "legacy", runIndex: 0, locale: "english", category: "information", featureTags: ["rag"], status: "measured", knownTicket: null, outcome: "responded", metrics: { currentRequestAnswered: true, unnecessaryQuestion: false, unnecessaryToolCall: false, fallbackUsed: false, fallbackReason: null, rejectionReasonCodes: [], languageMismatch: false, stepCount: null, maxSteps: null, toolsUsed: [], ragStatus: null, toolFailure: null, unsafeDraftBlocked: false, unsafeFinalResponse: false } },
    { scenarioId: "A01", arm: "agent", runIndex: 0, locale: "english", category: "information", featureTags: ["rag"], status: "infrastructure_error", infrastructureErrorKind: "model_decision_failure", knownTicket: null, outcome: "decision_failed", metrics: { currentRequestAnswered: null, unnecessaryQuestion: null, unnecessaryToolCall: null, fallbackUsed: null, fallbackReason: null, rejectionReasonCodes: [], languageMismatch: null, stepCount: 1, maxSteps: 4, toolsUsed: [], ragStatus: null, toolFailure: null, unsafeDraftBlocked: null, unsafeFinalResponse: null } }
  ];
  const legacy = aggregateScenarios(turns.filter((t) => t.arm === "legacy"));
  const agent = aggregateScenarios(turns.filter((t) => t.arm === "agent"));
  const markdown = buildReportMarkdown(baseInputs({ legacy, agent, legacyExcluding: legacy, agentExcluding: agent, environment: { ...baseInputs().environment, scenarioCount: 1 } }));
  assert.doesNotMatch(markdown, /NaN/);
  assert.match(markdown, /100\.0% \(1\/1\)/, "legacy's one measured, fully-answered turn should render as 100%");
});

// 11. benchmark output contains no raw secrets
test("buildReportMarkdown never includes an OPENROUTER_API_KEY-shaped token even if accidentally present in inputs", () => {
  const fakeKeyShape = "sk-or-v1-THIS-LOOKS-LIKE-A-REAL-KEY-1234567890abcdef";
  const markdown = buildReportMarkdown(baseInputs({ environment: { ...baseInputs().environment, note: "test note, no secret here" } }));
  assert.doesNotMatch(markdown, new RegExp(fakeKeyShape));
  assert.doesNotMatch(markdown, /sk-or-v1-[A-Za-z0-9]/, "report must never contain an OpenRouter-shaped secret");
  assert.doesNotMatch(markdown, /Bearer\s+\S+/i, "report must never contain a raw Authorization header value");
});
