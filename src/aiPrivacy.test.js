const test = require("node:test");
const assert = require("node:assert/strict");
const { redactPersonalData } = require("./ai");

test("model and RAG query sanitizer removes bank and identity secrets while preserving the business question", () => {
  const input = "Help me set up a company in Cyprus. IBAN: CY17 0020 0128 0000 0012 0052 7600; OTP: 839102; passport number: P1234567";
  const sanitized = redactPersonalData(input);
  assert.match(sanitized, /Help me set up a company in Cyprus/);
  assert.doesNotMatch(sanitized, /CY17|0020 0128|839102|P1234567/);
});
