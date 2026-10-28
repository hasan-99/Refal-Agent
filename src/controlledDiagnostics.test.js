const test = require("node:test");
const assert = require("node:assert/strict");
const { sanitizeControlledInspection, canRunControlledAppointmentWorkflow } = require("./controlledDiagnostics");

test("controlled QA permits only explicit appointment requests that stay in pending team review", () => {
  const controlled = { profile: { qaControlledDiagnostics: true } };
  assert.equal(canRunControlledAppointmentWorkflow(controlled, { operation: "booking_request" }), true);
  assert.equal(canRunControlledAppointmentWorkflow({ ...controlled, booking: { status: "awaiting_details", teamReviewRequired: true } }, {}), true);
  assert.equal(canRunControlledAppointmentWorkflow({ ...controlled, booking: { status: "awaiting_details" } }, {}), false);
  assert.equal(canRunControlledAppointmentWorkflow({ ...controlled, booking: { status: "awaiting_confirmation" } }, {}), false);
  assert.equal(canRunControlledAppointmentWorkflow(controlled, { operation: "none" }), false);
  assert.equal(canRunControlledAppointmentWorkflow({ profile: {} }, { operation: "none" }), true);
});

test("controlled inspection contains only rejected draft, evidence and bounded verdicts, with Node/Edge parity", async () => {
  const { sanitizeControlledInspection: edge } = await import("../supabase/functions/rafa-agent-api/controlledDiagnostics.mjs");
  const input = { traceId: "inspection-1", step: 2, type: "respond", draft: "Private Person: mail user@example.test token=sk-secret123456789000",
    evidence: [{ sourceRef: "abcd123456789000abcd123456789000", title: "Approved source", section: "Conditions", content: "Formation does not guarantee bank approval." }],
    reasonCodes: ["unsupported_claim", "private prose"], claims: [{ sentence: "Approval is guaranteed", claimClass: "GUARANTEE", reasons: ["guarantee_marker"] }],
    reasoning: "hidden", prompt: "hidden", apiKey: "hidden", customerMessage: "private" };
  const result = sanitizeControlledInspection(input, ["Private Person"]);
  assert.deepEqual(edge(input, ["Private Person"]), result);
  assert.equal(result.evidence[0].content, input.evidence[0].content);
  assert.deepEqual(result.reasonCodes, ["unsupported_claim"]);
  assert.doesNotMatch(JSON.stringify(result), /Private Person|user@example|sk-secret|hidden|customerMessage/u);
  assert.equal(sanitizeControlledInspection({ ...input, step: 0 }), null);
});
