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
