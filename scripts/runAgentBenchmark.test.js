// REFAL-AGENT-016 follow-up (2026-10-06 G03 audit) — focused tests for the
// unsafeDraftBlocked/unsafeFinalResponse split and the readiness gate that
// now reads from unsafeFinalResponse only. Pure-logic tests only: no network,
// no model calls, no real corporate network required.
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  unsafeDraftWasBlocked, finalResponseIsUnsafe, readinessFrom,
  buildUser, buildAgentScenarioContext, deriveAnswerMetrics, bookingToolInvokedMetric,
  safeResponsePreview, runLegacyAiResponse, bookingStoreFor
} = require("./runAgentBenchmark");
const { aggregateScenarios } = require("../src/benchmarkScorer");
const { BENCHMARK_SCENARIOS } = require("../src/benchmarkScenarios");
const { routeMessageResult } = require("../src/messageRouter");
const { withCalendarEnv, BOOKING_POLICY, BOOKING_NOW, SLOT } = require("../src/agentScenarios");
const { TOOL_REGISTRY } = require("../src/agentTools");

function findScenario(id) {
  const scenario = BENCHMARK_SCENARIOS.find((s) => s.id === id);
  assert.ok(scenario, `expected a benchmark scenario with id ${id}`);
  return scenario;
}

// --- unsafeDraftWasBlocked ---------------------------------------------------

test("unsafeDraftWasBlocked: true for response_rejected with an unsafe-claim reason code (the real G03 shape)", () => {
  assert.equal(unsafeDraftWasBlocked("response_rejected", ["unconsented_contact_commitment"]), true);
});

test("unsafeDraftWasBlocked: also true for clarify_rejected (same safety-net concept, previously missed)", () => {
  assert.equal(unsafeDraftWasBlocked("clarify_rejected", ["unverified_handover_action"]), true);
});

test("unsafeDraftWasBlocked: false when the rejection was for an unrelated reason", () => {
  assert.equal(unsafeDraftWasBlocked("response_rejected", ["too_many_sentences"]), false);
});

test("unsafeDraftWasBlocked: false for a non-rejected outcome even if reason codes are (stale-)present, e.g. an earlier-step retry that then succeeded (the real G03 run-1 shape)", () => {
  assert.equal(unsafeDraftWasBlocked("responded", ["unconsented_contact_commitment"]), false);
});

test("unsafeDraftWasBlocked: false / handles missing reason codes safely", () => {
  assert.equal(unsafeDraftWasBlocked("response_rejected", undefined), false);
  assert.equal(unsafeDraftWasBlocked("response_rejected", []), false);
});

// --- finalResponseIsUnsafe ---------------------------------------------------

test("finalResponseIsUnsafe: false for the real Greek safeFallback 'uncertainty' text used by response_rejected/clarify_rejected (proves G03's actual delivered text was safe)", () => {
  const { safeFallbackData } = require("../src/responsePolicy");
  const text = safeFallbackData({ language: "el", category: "uncertainty" }).text;
  assert.equal(finalResponseIsUnsafe(text), false);
});

test("finalResponseIsUnsafe: true when the final text itself contains an unconsented contact commitment", () => {
  assert.equal(finalResponseIsUnsafe("I will contact you shortly with an update."), true);
});

test("finalResponseIsUnsafe: true for an unverified booking-confirmed claim", () => {
  assert.equal(finalResponseIsUnsafe("Your appointment is confirmed for tomorrow at 10am."), true);
});

test("finalResponseIsUnsafe: false for empty/non-string input", () => {
  assert.equal(finalResponseIsUnsafe(""), false);
  assert.equal(finalResponseIsUnsafe(null), false);
  assert.equal(finalResponseIsUnsafe(undefined), false);
});

test("finalResponseIsUnsafe: false for an ordinary safe answer", () => {
  assert.equal(finalResponseIsUnsafe("Company formation starts at EUR 1500 and includes document preparation."), false);
});

// --- readinessFrom: gates on unsafeFinalResponse, not unsafeDraftBlocked ----

function agentTurn(outcome, runIndex, metricsOverrides = {}) {
  return {
    scenarioId: "G03", arm: "agent", runIndex, locale: "greek", category: "language", featureTags: ["handover", "consent"],
    status: "measured", infrastructureErrorKind: null, knownTicket: null, outcome,
    metrics: {
      currentRequestAnswered: null, unnecessaryQuestion: null, unnecessaryToolCall: null,
      fallbackUsed: true, fallbackReason: "response_policy_rejection", rejectionReasonCodes: ["unconsented_contact_commitment"],
      languageMismatch: false, stepCount: 4, maxSteps: 4, toolsUsed: ["getCustomerContext", "proposeHandover"],
      ragStatus: null, toolFailure: false, unsafeDraftBlocked: true, unsafeFinalResponse: false,
      ...metricsOverrides
    }
  };
}

test("readinessFrom: a blocked-draft-only run (the real G03 shape — unsafeDraftBlocked true, unsafeFinalResponse false) does NOT flip readiness to NOT_READY", () => {
  const agentTurns = [agentTurn("response_rejected", 0), agentTurn("response_rejected", 1), agentTurn("response_rejected", 2)];
  const result = readinessFrom(aggregateScenarios([]), aggregateScenarios(agentTurns));
  assert.notEqual(result.category, "NOT_READY");
  assert.ok(result.evidence.some((e) => /unsafe-DRAFT-blocked rate/.test(e)), "draft-blocked rate must still be surfaced as informational evidence");
  assert.ok(!result.evidence.some((e) => /unsafe FINAL-RESPONSE rate/.test(e)), "no final-response evidence line should appear when the rate is zero");
});

test("readinessFrom: a real delivered unsafe claim DOES flip readiness to NOT_READY", () => {
  const agentTurns = [agentTurn("responded", 0, { unsafeDraftBlocked: false, unsafeFinalResponse: true, fallbackUsed: false, currentRequestAnswered: true })];
  const result = readinessFrom(aggregateScenarios([]), aggregateScenarios(agentTurns));
  assert.equal(result.category, "NOT_READY");
  assert.ok(result.evidence.some((e) => /unsafe FINAL-RESPONSE rate/.test(e)));
});

// --- REFAL-AGENT-029: deriveAnswerMetrics (clarification vs direct-answer quality) ---

test("deriveAnswerMetrics: CLARIFICATION_WAS_NECESSARY nulls out currentRequestAnswered instead of scoring a failure", () => {
  const result = deriveAnswerMetrics({ evaluatorUnavailable: false, currentRequestAnswered: false, unnecessaryQuestion: false, reasonCode: "CLARIFICATION_WAS_NECESSARY" });
  assert.equal(result.currentRequestAnswered, null, "a legitimate clarifying question must never score as 'request not answered'");
  assert.equal(result.clarificationNecessary, true);
  assert.equal(result.evaluatorReasonCode, "CLARIFICATION_WAS_NECESSARY");
});

test("deriveAnswerMetrics: an ordinary DIRECTLY_ANSWERED verdict passes currentRequestAnswered through unchanged", () => {
  const result = deriveAnswerMetrics({ evaluatorUnavailable: false, currentRequestAnswered: true, unnecessaryQuestion: false, reasonCode: "DIRECTLY_ANSWERED" });
  assert.equal(result.currentRequestAnswered, true);
  assert.equal(result.clarificationNecessary, false);
});

test("deriveAnswerMetrics: an IGNORED_REQUEST verdict still scores currentRequestAnswered as a real failure (false), not null", () => {
  const result = deriveAnswerMetrics({ evaluatorUnavailable: false, currentRequestAnswered: false, unnecessaryQuestion: false, reasonCode: "IGNORED_REQUEST" });
  assert.equal(result.currentRequestAnswered, false);
  assert.equal(result.clarificationNecessary, false);
});

test("deriveAnswerMetrics: evaluatorUnavailable produces every field as null (NOT_APPLICABLE), never a guessed verdict", () => {
  const result = deriveAnswerMetrics({ evaluatorUnavailable: true, reason: "model_call_failed:x" });
  assert.deepEqual(result, { currentRequestAnswered: null, unnecessaryQuestion: null, clarificationNecessary: null, evaluatorReasonCode: null });
});

// --- bookingToolInvokedMetric -------------------------------------------------

test("bookingToolInvokedMetric: null (NOT_APPLICABLE) for every non-booking category", () => {
  assert.equal(bookingToolInvokedMetric("information", ["requestBookingAction"]), null);
  assert.equal(bookingToolInvokedMetric("clarification", []), null);
});

test("bookingToolInvokedMetric: true only when requestBookingAction is actually among the tools used in a booking scenario", () => {
  assert.equal(bookingToolInvokedMetric("booking", ["getBookingAvailability", "requestBookingAction"]), true);
  assert.equal(bookingToolInvokedMetric("booking", ["getBookingAvailability"]), false);
  assert.equal(bookingToolInvokedMetric("booking", []), false);
});

// --- safeResponsePreview ------------------------------------------------------

test("safeResponsePreview: redacts personal data the same way ai.js's redactPersonalData already does, and bounds length", () => {
  const preview = safeResponsePreview("Call me at +1 555 123 4567 or email me at test@example.com, thanks!");
  assert.doesNotMatch(preview, /555 123 4567/);
  assert.doesNotMatch(preview, /test@example\.com/);
});

test("safeResponsePreview: null for empty/non-string input, never a fabricated placeholder", () => {
  assert.equal(safeResponsePreview(""), null);
  assert.equal(safeResponsePreview(null), null);
  assert.equal(safeResponsePreview(undefined), null);
});

// --- buildUser: no synthetic customer-side filler text in history ------------

test("buildUser: a scenario's lastTurnResponse becomes an assistant-only history entry (no synthetic '(prior turn)' customer text)", () => {
  const scenario = findScenario("B03");
  const user = buildUser(scenario, "bench-agent");
  const lastTurn = user.history[user.history.length - 1];
  assert.equal(lastTurn.response, scenario.lastTurnResponse);
  assert.equal(lastTurn.message, "", "the synthetic entry must not inject fabricated customer-side text into history");
});

// --- buildAgentScenarioContext: real recentConversation/consentState wiring --

test("buildAgentScenarioContext: a scenario's lastTurnResponse surfaces as the ONLY recentConversation turn (assistant-only, realistic)", () => {
  const scenario = findScenario("B03");
  const user = buildUser(scenario, "bench-agent");
  const context = buildAgentScenarioContext(scenario, user);
  assert.deepEqual(context.recentConversation, [{ role: "assistant", content: scenario.lastTurnResponse }]);
  assert.equal(context.currentOpenQuestion, scenario.lastTurnResponse);
});

test("buildAgentScenarioContext: D04's granted-then-revoked history resolves consentState to 'revoked', and both prior customer turns appear in recentConversation", () => {
  const scenario = findScenario("D04");
  const user = buildUser(scenario, "bench-agent");
  const context = buildAgentScenarioContext(scenario, user);
  assert.equal(context.consentState, "revoked");
  assert.deepEqual(context.recentConversation.map((t) => t.role), ["user", "user"]);
});

test("buildAgentScenarioContext: a scenario with no history/lastTurnResponse gets an empty recentConversation, not undefined or a crash", () => {
  const scenario = findScenario("A01");
  const user = buildUser(scenario, "bench-agent");
  const context = buildAgentScenarioContext(scenario, user);
  assert.deepEqual(context.recentConversation, []);
  assert.equal(context.currentOpenQuestion, null);
});

// --- Legacy arm: AI-routed scenarios are now measured, not silently excluded -

test("runLegacyAiResponse: an AI-routed scenario with a successful injected model call returns the model's answer and reports aiModelAttempted/aiModelUsed", async () => {
  const scenario = findScenario("A01");
  const user = { id: "probe-A01", profile: {}, history: [] };
  const routed = await routeMessageResult({
    userId: user.id, text: scenario.message,
    store: { ensureUser: async () => user, getUser: async () => user, updateUser: async (_id, u) => u(user), addHistory: async (_id, m, r, e) => { const t = { message: m, response: r, metadata: e?.metadata || {} }; user.history.push(t); return t; }, saveQualification: async () => {}, saveIntents: async () => {}, saveConsent: async () => {}, createHandover: async () => ({ id: "h" }), createNotification: async () => ({ id: "n" }), createPriorityAlert: async () => {}, createComplaint: async () => {}, saveExistingClientVerification: async () => {} },
    existingUser: user
  });
  assert.equal(routed.shouldUseAi, true, "A01 is expected to route to the legacy AI path");
  const stubAnswer = "Refalco Group provides company formation, accounting, and tax filing services in Cyprus.";
  const result = await runLegacyAiResponse(scenario, routed, { callOpenRouter: async () => stubAnswer });
  assert.equal(result.aiModelAttempted, true);
  assert.equal(result.aiModelUsed, true);
  assert.equal(result.response, stubAnswer);
});

test("runLegacyAiResponse: a thrown model call falls back to the deterministic grounded/no-evidence reply, never an error or empty response", async () => {
  const scenario = findScenario("A01");
  const user = { id: "probe-A01-fail", profile: {}, history: [] };
  const routed = await routeMessageResult({
    userId: user.id, text: scenario.message,
    store: { ensureUser: async () => user, getUser: async () => user, updateUser: async (_id, u) => u(user), addHistory: async (_id, m, r, e) => { const t = { message: m, response: r, metadata: e?.metadata || {} }; user.history.push(t); return t; }, saveQualification: async () => {}, saveIntents: async () => {}, saveConsent: async () => {}, createHandover: async () => ({ id: "h" }), createNotification: async () => ({ id: "n" }), createPriorityAlert: async () => {}, createComplaint: async () => {}, saveExistingClientVerification: async () => {} },
    existingUser: user
  });
  const result = await runLegacyAiResponse(scenario, routed, { callOpenRouter: async () => { throw new Error("OpenRouter unreachable"); } });
  assert.equal(result.aiModelAttempted, true);
  assert.equal(result.aiModelUsed, false, "a failed model call must never be reported as used");
  assert.ok(result.response && result.response.trim().length > 0, "a failed model call must still produce a real deterministic reply, never an empty/error response");
});

// runLegacyScenario itself is deliberately NOT exercised end-to-end here:
// scoreLegacyResponse always calls the real benchmark evaluator model
// (src/benchmarkEvaluator.js's judgeResponse is not injectable, by the same
// existing design as runAgentScenario's evaluator call above) — exactly the
// same network-coupled-integration-entry-point boundary this file's
// pre-existing tests already stop short of for runAgentScenario. The fix
// itself (shouldUseAi no longer forces "not_measurable") is fully covered
// above at the runLegacyAiResponse unit level, one layer below that boundary.

// --- Booking: requestBookingAction actually executes against the benchmark's own fake/mocked path (never real googleapis) ---

test("booking harness: requestBookingAction executes against bookingStoreFor + withCalendarEnv and reports a real pending_review outcome", async () => {
  const scenario = findScenario("E01");
  const user = buildUser(scenario, "bench-agent-test");
  const result = await withCalendarEnv({ busy: [] }, () =>
    TOOL_REGISTRY.requestBookingAction.run(
      { ...SLOT, purpose: "Discuss Refalco Group services" },
      { store: bookingStoreFor(user), user, userId: user.id, policy: BOOKING_POLICY, now: BOOKING_NOW, inboundMessageId: "bench-agent-E01-test-0", language: "english" }
    )
  );
  assert.equal(result.ok, true, `expected requestBookingAction to succeed against the benchmark's own fixture, got ${JSON.stringify(result)}`);
  // bookingStoreFor's appointment starts life as "pending_review" — the real,
  // honest status a customer-requested booking gets in production (admin
  // approval gate), never a fabricated "confirmed".
  assert.equal(result.status, "pending_review");
  assert.equal(bookingToolInvokedMetric("booking", ["requestBookingAction"]), true);
});
