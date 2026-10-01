const test = require("node:test");
const assert = require("node:assert/strict");
const { assessPriority } = require("./priorityRules");

test("priority rules flag high-value and existing-client work", () => {
  assert.equal(assessPriority({ intent: "investment" }).level, "high");
  assert.equal(assessPriority({ text: "I am an existing client and need help with my account" }).handoverRequired, true);
});

test("ordinary complaints are high priority but severe threats are urgent", () => {
  assert.equal(assessPriority({ text: "I am unhappy with the service" }).level, "high");
  assert.equal(assessPriority({ text: "This is a formal complaint and I will contact a lawyer" }).level, "urgent");
  assert.equal(assessPriority({ text: "Hello, I have a question" }).level, "normal");
});
