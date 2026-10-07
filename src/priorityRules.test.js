const test = require("node:test");
const assert = require("node:assert/strict");
const { assessPriority } = require("./priorityRules");

test("priority rules flag high-value and existing-client work", () => {
  const investment = assessPriority({ intent: "investment" });
  assert.equal(investment.level, "high");
  assert.equal(investment.handoverRequired, false);
  assert.equal(assessPriority({ text: "I am an existing client and need help with my account" }).handoverRequired, true);
  assert.equal(assessPriority({ text: "Are you describing an available service or promising a specific result for my case?", intents: ["services"] }).handoverRequired, false);
});

test("a basic investment-company enquiry does not force a customer-facing handover", () => {
  const priority = assessPriority({ text: "بدي اسجل شركة استثمار ب قبرص", intent: ["company_formation", "investment"] });
  assert.equal(priority.level, "high");
  assert.equal(priority.handoverRequired, false);
});

test("ordinary complaints are high priority but severe threats are urgent", () => {
  assert.equal(assessPriority({ text: "I am unhappy with the service" }).level, "high");
  assert.equal(assessPriority({ text: "This is a formal complaint and I will contact a lawyer" }).level, "urgent");
  assert.equal(assessPriority({ text: "Hello, I have a question" }).level, "normal");
});

test("bare mentions of media, press, land, or an account no longer force a false escalation", () => {
  assert.equal(assessPriority({ text: "What social media accounts does the business have?" }).level, "normal");
  assert.equal(assessPriority({ text: "Is the business on the press list for industry news?" }).level, "normal");
  assert.equal(assessPriority({ text: "What do I need to open my account for the new company with a local bank?" }).level, "normal");
  assert.equal(assessPriority({ text: "Is land available near Limassol for a small villa?" }).level, "normal");
});

test("a real press/media complaint, land development deal, or account problem still escalates", () => {
  const media = assessPriority({ text: "This is a media enquiry from a journalist about your company" });
  assert.equal(media.level, "urgent");
  assert.ok(media.triggers.includes("severe_complaint"));

  const land = assessPriority({ text: "We are looking at a land development deal near Limassol" });
  assert.equal(land.level, "high");
  assert.ok(land.triggers.includes("material_business_opportunity"));

  const account = assessPriority({ text: "My account status shows an unresolved issue" });
  assert.equal(account.level, "high");
  assert.ok(account.triggers.includes("existing_client"));
});
