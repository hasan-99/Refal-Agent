const test = require("node:test");
const assert = require("node:assert/strict");
const { buildRefalLeadSummary, createHandover, formatRefalLeadSummary, routeIntentToDepartment } = require("./handover");

test("validated intent routing selects the specialist department and fails closed for unknown intents", () => {
  assert.equal(routeIntentToDepartment({ intents: ["real_estate", "investment"] }).department, "investment");
  assert.equal(routeIntentToDepartment({ intent: "made_up_intent" }).department, "general");
  assert.equal(routeIntentToDepartment({ intent: "made_up_intent" }).validated, false);
});

test("REFAL LEAD SUMMARY is structured and internal-only content is separated", () => {
  const handover = createHandover({ intent: "construction", customer: { name: "Rami", phone: "+35712345678" }, need: "Tender discussion", timing: "This month" });
  assert.equal(handover.summary.format, "REFAL LEAD SUMMARY");
  assert.equal(handover.summary.department, "development_construction");
  assert.match(formatRefalLeadSummary(handover.summary), /Department: development_construction/);
  assert.equal(handover.messages.customerMayReceiveInternal, false);
  assert.doesNotMatch(handover.messages.customerMessage, /REFAL LEAD SUMMARY|Priority|development_construction/);
  assert.match(handover.messages.internalMessage, /REFAL LEAD SUMMARY/);
});
