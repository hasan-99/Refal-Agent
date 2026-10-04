const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyComplaint, handleComplaint } = require("./complaintWorkflow");

test("complaint workflow is neutral, asks for useful details, and keeps internal notes separate", () => {
  const result = handleComplaint({ text: "I am unhappy with the service", language: "english", customer: { name: "Mina" } });
  assert.equal(result.handoverRequired, true);
  assert.match(result.messages.customerMessage, /understand|frustrating/i);
  assert.match(result.messages.customerMessage, /detail/i);
  assert.doesNotMatch(result.messages.customerMessage, /severity|internal|priority/i);
  assert.match(result.messages.internalMessage, /Severity: high/);
});

test("non-complaints do not start the complaint workflow", () => {
  assert.deepEqual(classifyComplaint("Tell me about your services"), { isComplaint: false, severity: "none", triggers: [] });
});

test("a customer who says they are still upset remains in the complaint path", () => {
  for (const text of ["I am still upset", "أنا لسا متضايق", "Είμαι ακόμα αναστατωμένος"]) {
    assert.equal(classifyComplaint(text).isComplaint, true, text);
  }
});
