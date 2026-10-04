const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyLeadTemperature } = require("./leadTemperature");

test("confirmed appointment classifies a lead as hot", () => {
  assert.deepEqual(classifyLeadTemperature({ booking: { status: "confirmed" } }), {
    status: "hot",
    reason: "appointment_booked"
  });
});

test("recent appointment intent is hot and company interest is warm", () => {
  assert.equal(classifyLeadTemperature({ history: [{ message: "Can I book an appointment?" }] }).status, "hot");
  assert.equal(classifyLeadTemperature({ history: [{ message: "Please tell me more about your properties" }] }).status, "warm");
});

test("explicit decline is cold and ordinary greetings stay unclassified", () => {
  assert.equal(classifyLeadTemperature({ history: [{ message: "Please stop messaging me" }] }).status, "cold");
  assert.equal(classifyLeadTemperature({ history: [{ message: "Hi there" }] }).status, "unclassified");
});
