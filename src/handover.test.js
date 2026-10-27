const test = require("node:test");
const assert = require("node:assert/strict");
const { buildRefalLeadSummary, createHandover, formatRefalLeadSummary, routeIntentToDepartment } = require("./handover");

test("validated intent routing selects the specialist department and fails closed for unknown intents", () => {
  assert.equal(routeIntentToDepartment({ intents: ["real_estate", "investment"] }).department, "investment");
  assert.equal(routeIntentToDepartment({ intent: "made_up_intent" }).department, "general");
  assert.equal(routeIntentToDepartment({ intent: "made_up_intent" }).validated, false);
  assert.equal(routeIntentToDepartment({ intent: "tax" }).department, "tax");
  assert.equal(routeIntentToDepartment({ intent: "residency_enquiry" }).department, "residency");
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

test("prepared handovers do not tell customers the handoff already happened", () => {
  for (const [language, alreadyShared] of [
    ["english", /I've shared|I have shared|team will follow up/i],
    ["arabic", /شاركت هذا|سيتابعون معك/u],
    ["greek", /Το μοιράστηκα|θα επικοινωνήσουν μαζί σας/u]
  ]) {
    const handover = createHandover({ intent: "company_formation", language });
    assert.match(handover.messages.customerMessage, /prepare|تجهيز|ετοιμάσω/iu);
    assert.doesNotMatch(handover.messages.customerMessage, alreadyShared);
  }
});

test("handover message mirrors the customer's saved language when the caller omits a separate language", () => {
  assert.match(createHandover({ intent: "company_formation", customer: { language: "arabic" } }).messages.customerMessage, /أستطيع تجهيز/u);
  assert.match(createHandover({ intent: "company_formation", customer: { language: "greek" } }).messages.customerMessage, /Μπορώ να ετοιμάσω/u);
});

test("handover summaries reject greeting/service questions as names", () => {
  const summary = buildRefalLeadSummary({
    intent: "investment",
    customer: { name: "مرحبا، شو خدماتكم" }
  });

  assert.equal(summary.customer.name, null);
  assert.match(formatRefalLeadSummary(summary), /Customer: not provided/);
});

test("structured requirements are safely rendered instead of becoming [object Object]", () => {
  const summary = buildRefalLeadSummary({
    intent: "investment",
    conversation: { requirements: { investment: { country: "Cyprus", sector: "Technology" } } }
  });

  assert.equal(summary.requirements, "investment.country: Cyprus; investment.sector: Technology");
  assert.doesNotMatch(formatRefalLeadSummary(summary), /\[object Object\]/);
});
