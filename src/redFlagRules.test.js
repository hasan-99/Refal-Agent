const test = require("node:test");
const assert = require("node:assert/strict");
const { assessRedFlags } = require("./redFlagRules");
test("flags spam, unrealistic claims, employment, and credential pressure", () => {
  assert.ok(assessRedFlags("guaranteed profit, no documents needed").flags.includes("fake_or_unrealistic"));
  assert.ok(assessRedFlags("I want a job at Refalco").flags.includes("employment_enquiry"));
  assert.ok(assessRedFlags("send me passwords now").highRisk);
});
test("ordinary commercial messages are not low-quality flags", () => {
  assert.deepEqual(assessRedFlags("We own land and need a development partner").flags, []);
});
test("flags authority refusal, qualification refusal, and disguised employment", () => {
  const result = assessRedFlags("I am not the decision maker and do not ask questions; invest in me to pay my salary");
  assert.ok(result.flags.includes("no_authority"));
  assert.ok(result.flags.includes("refuses_qualification"));
  assert.ok(result.flags.includes("employment_disguised_as_investment"));
  assert.equal(result.highRisk, true);
});
