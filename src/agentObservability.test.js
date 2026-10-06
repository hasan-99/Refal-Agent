const test = require("node:test");
const assert = require("node:assert/strict");
const {
  FALLBACK_OUTCOMES,
  summarizeAgentTurn,
  buildAgentTurnEventFields,
  buildShadowComparisonFields
} = require("./agentObservability");

function respondedResult(overrides = {}) {
  return {
    finished: true,
    outcome: "responded",
    response: "The published price is EUR 1500.",
    steps: [
      { step: 1, tool: "searchApprovedKnowledge", args: { query: "the customer's actual question text" }, result: { ok: true, status: "found", data: [{ content: "raw RAG chunk text" }], userSafeSummary: ["Company formation price"] } }
    ],
    toolsUsed: ["searchApprovedKnowledge"],
    stepCount: 2,
    ...overrides
  };
}

test("successful Agent turn: summarizeAgentTurn derives the expected safe structured metadata (test 1)", () => {
  const summary = summarizeAgentTurn(respondedResult());
  assert.equal(summary.finalOutcome, "responded");
  assert.equal(summary.stepCount, 2);
  assert.deepEqual(summary.toolsUsed, ["searchApprovedKnowledge"]);
  assert.equal(summary.toolCallCount, 1);
  assert.equal(summary.ragUsed, true);
  assert.equal(summary.ragResultStatus, "found");
  assert.equal(summary.draftRejected, false);
  assert.deepEqual(summary.rejectionReasonCodes, []);
  assert.equal(summary.deterministicCorrectionUsed, false);
  assert.equal(summary.fallbackUsed, false);
  assert.equal(summary.responseLength, "The published price is EUR 1500.".length);
  assert.ok(summary.decisionTypesUsed.includes("tool"));
  assert.ok(summary.decisionTypesUsed.includes("respond"));
});

test("tool call logs tool name/status but never raw args or result data (test 2)", () => {
  const summary = summarizeAgentTurn(respondedResult());
  assert.deepEqual(summary.toolCalls, [{ tool: "searchApprovedKnowledge", status: "found", ok: true, reasonCode: null }]);
  const serialized = JSON.stringify(summary);
  assert.doesNotMatch(serialized, /the customer's actual question text/);
  assert.doesNotMatch(serialized, /raw RAG chunk text/);
  assert.doesNotMatch(serialized, /Company formation price/);
});

test("RAG use logs status/count but not chunk contents; a failed search is also categorized safely (test 3)", () => {
  const found = summarizeAgentTurn(respondedResult());
  assert.equal(found.ragUsed, true);
  assert.equal(found.ragResultStatus, "found");
  assert.equal(JSON.stringify(found).includes("raw RAG chunk text"), false);

  const failedSearch = summarizeAgentTurn(respondedResult({
    steps: [{ step: 1, tool: "searchApprovedKnowledge", args: { query: "x" }, result: { ok: false, status: "error", reasonCode: "RETRIEVAL_FAILED" } }],
    toolsUsed: ["searchApprovedKnowledge"]
  }));
  assert.equal(failedSearch.ragUsed, true);
  assert.equal(failedSearch.ragResultStatus, "error");
  assert.deepEqual(failedSearch.toolCalls, [{ tool: "searchApprovedKnowledge", status: "error", ok: false, reasonCode: "RETRIEVAL_FAILED" }]);

  const noRag = summarizeAgentTurn(respondedResult({ steps: [], toolsUsed: [] }));
  assert.equal(noRag.ragUsed, false);
  assert.equal(noRag.ragResultStatus, null);
});

test("saveCustomerFact observation logs status only, never the raw field/value (test 4)", () => {
  const result = respondedResult({
    steps: [{ step: 1, tool: "saveCustomerFact", args: { field: "companyActivity", value: "import/export of luxury watches", provenance: "customer_message" }, result: { ok: true, status: "saved", data: { field: "companyactivity", value: "import/export of luxury watches" } } }],
    toolsUsed: ["saveCustomerFact"]
  });
  const summary = summarizeAgentTurn(result);
  assert.deepEqual(summary.toolCalls, [{ tool: "saveCustomerFact", status: "saved", ok: true, reasonCode: null }]);
  assert.doesNotMatch(JSON.stringify(summary), /luxury watches/);
});

test("booking tool observation logs status only, never slot/customer details (test 5)", () => {
  const result = respondedResult({
    steps: [{ step: 1, tool: "requestBookingAction", args: { start: "2026-01-05T10:00:00.000Z", purpose: "discuss a confidential acquisition" }, result: { ok: true, status: "confirmed", data: { appointmentId: "appt-1", eventId: "evt-1", meetLink: "https://meet.google.com/abc" }, userSafeSummary: "Confirmed. Your meeting is booked for 5 Jan 2026, 10:00." } }],
    toolsUsed: ["requestBookingAction"]
  });
  const summary = summarizeAgentTurn(result);
  assert.deepEqual(summary.toolCalls, [{ tool: "requestBookingAction", status: "confirmed", ok: true, reasonCode: null }]);
  const serialized = JSON.stringify(summary);
  assert.doesNotMatch(serialized, /confidential acquisition/);
  assert.doesNotMatch(serialized, /meet\.google\.com/);
  assert.doesNotMatch(serialized, /2026-01-05/);
});

test("handover observation logs authorization status only, never the full handover payload (test 6)", () => {
  const result = respondedResult({
    steps: [{ step: 1, tool: "proposeHandover", args: { reason: "needs a specialist for a large land deal" }, result: { ok: true, status: "authorized", data: { summary: { need: "a large land deal", customer: { name: "Hasan" } }, routing: { department: "development" } } } }],
    toolsUsed: ["proposeHandover"]
  });
  const summary = summarizeAgentTurn(result);
  assert.deepEqual(summary.toolCalls, [{ tool: "proposeHandover", status: "authorized", ok: true, reasonCode: null }]);
  const serialized = JSON.stringify(summary);
  assert.doesNotMatch(serialized, /large land deal/);
  assert.doesNotMatch(serialized, /Hasan/);
});

test("a rejected draft logs reason code(s) and which step, never the draft text (test 7)", () => {
  const result = respondedResult({
    outcome: "responded",
    response: "A corrected short reply.",
    steps: [
      { step: 1, tool: "responsePolicyCheck", args: { attemptedType: "respond" }, result: { ok: false, status: "policy_rejected", reasonCode: "too_many_questions,unverified_booking_action" } }
    ],
    toolsUsed: [],
    corrected: true
  });
  const summary = summarizeAgentTurn(result);
  assert.equal(summary.draftRejected, true);
  assert.deepEqual(summary.rejectionReasonCodes.sort(), ["too_many_questions", "unverified_booking_action"]);
  assert.equal(JSON.stringify(summary).includes("A corrected short reply"), false);
});

test("deterministic correction is observable (test 8)", () => {
  assert.equal(summarizeAgentTurn(respondedResult({ corrected: true })).deterministicCorrectionUsed, true);
  assert.equal(summarizeAgentTurn(respondedResult({ corrected: undefined })).deterministicCorrectionUsed, false);
});

test("fallback usage is observable for every fallback outcome, and false for a real success (test 9)", () => {
  for (const outcome of FALLBACK_OUTCOMES) {
    assert.equal(summarizeAgentTurn(respondedResult({ outcome, response: "A safe deterministic fallback reply." })).fallbackUsed, true, outcome);
  }
  assert.equal(summarizeAgentTurn(respondedResult({ outcome: "responded" })).fallbackUsed, false);
  assert.equal(summarizeAgentTurn(respondedResult({ outcome: "clarified" })).fallbackUsed, false);
});

test("buildAgentTurnEventFields merges turn-level context with the pure summary and never includes response/message text", () => {
  const fields = buildAgentTurnEventFields({
    result: respondedResult(),
    traceId: "trace-1",
    locale: "english",
    primaryIntentCategory: "pricing",
    secondaryGoalCount: 1,
    maxSteps: 4,
    shadowMode: true,
    durationMs: 120
  });
  assert.equal(fields.traceId, "trace-1");
  assert.equal(fields.locale, "english");
  assert.equal(fields.primaryIntentCategory, "pricing");
  assert.equal(fields.secondaryGoalCount, 1);
  assert.equal(fields.maxSteps, 4);
  assert.equal(fields.shadowMode, true);
  assert.equal(fields.durationMs, 120);
  assert.equal(fields.finalOutcome, "responded");
  assert.equal(fields.response, undefined);
  assert.equal(fields.currentMessage, undefined);
});

test("EN/AR/EL turns produce the same event-field structure (test 15)", () => {
  const base = respondedResult();
  const en = buildAgentTurnEventFields({ result: base, traceId: "t1", locale: "english", primaryIntentCategory: "pricing" });
  const ar = buildAgentTurnEventFields({ result: { ...base, response: "السعر المعتمد هو 1500 يورو." }, traceId: "t2", locale: "arabic", primaryIntentCategory: "pricing" });
  const el = buildAgentTurnEventFields({ result: { ...base, response: "Η εγκεκριμένη τιμή είναι 1500 ευρώ." }, traceId: "t3", locale: "greek", primaryIntentCategory: "pricing" });
  assert.deepEqual(Object.keys(en).sort(), Object.keys(ar).sort());
  assert.deepEqual(Object.keys(en).sort(), Object.keys(el).sort());
});

test("buildShadowComparisonFields never includes either path's full response text and computes safe categorical differences (tests 11-13)", () => {
  const agentResult = { ...respondedResult(), durationMs: 95, toolsUsed: ["requestBookingAction"] };
  const legacySummary = {
    primaryIntentCategory: "appointment",
    usedBookingPath: true,
    usedHandoverPath: false,
    responseLength: 64
  };
  const fields = buildShadowComparisonFields({ agentResult, legacySummary });
  assert.equal(fields.legacyPrimaryIntentCategory, "appointment");
  assert.equal(fields.agentPrimaryIntentCategory, "appointment");
  assert.equal(fields.sameIntentCategory, true);
  assert.equal(fields.legacyUsedBookingPath, true);
  assert.equal(fields.agentProposedBookingTool, true);
  assert.equal(fields.legacyUsedHandoverPath, false);
  assert.equal(fields.agentProposedHandover, false);
  assert.equal(fields.legacyResponseLength, 64);
  assert.equal(fields.agentResponseLength, agentResult.response.length);
  assert.equal(fields.agentOutcome, "responded");
  assert.equal(fields.agentFallbackUsed, false);
  assert.equal(fields.shadowDurationMs, 95);

  const serialized = JSON.stringify(fields);
  assert.doesNotMatch(serialized, new RegExp(agentResult.response));
  assert.equal(fields.legacyResponseText, undefined);
  assert.equal(fields.agentResponseText, undefined);
});

test("buildShadowComparisonFields returns null when either side is missing, rather than emitting a half-populated comparison", () => {
  assert.equal(buildShadowComparisonFields({ agentResult: null, legacySummary: { responseLength: 1 } }), null);
  assert.equal(buildShadowComparisonFields({ agentResult: respondedResult(), legacySummary: null }), null);
});
