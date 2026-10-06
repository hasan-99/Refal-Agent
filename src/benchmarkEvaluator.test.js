// REFAL-AGENT-016 — deterministic tests for the benchmark evaluator's
// structured-output validation. No real network calls: `callModel` is
// injected.

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseEvaluatorJson, judgeResponse, REASON_CODES, buildEvaluatorMessages } = require("./benchmarkEvaluator");

test("parseEvaluatorJson accepts a well-formed structured response", () => {
  const parsed = parseEvaluatorJson('{"currentRequestAnswered": true, "unnecessaryQuestion": false, "reasonCode": "DIRECTLY_ANSWERED"}');
  assert.deepEqual(parsed, { currentRequestAnswered: true, unnecessaryQuestion: false, reasonCode: "DIRECTLY_ANSWERED" });
});

test("parseEvaluatorJson strips a markdown fence the model added anyway", () => {
  const parsed = parseEvaluatorJson('```json\n{"currentRequestAnswered": false, "unnecessaryQuestion": true, "reasonCode": "ASKED_UNNECESSARY_QUESTION_INSTEAD"}\n```');
  assert.equal(parsed.currentRequestAnswered, false);
  assert.equal(parsed.unnecessaryQuestion, true);
});

test("parseEvaluatorJson rejects missing fields, wrong types, unknown reasonCode, or chain-of-thought prose", () => {
  assert.equal(parseEvaluatorJson("not json at all"), null);
  assert.equal(parseEvaluatorJson('{"currentRequestAnswered": "yes", "unnecessaryQuestion": false, "reasonCode": "DIRECTLY_ANSWERED"}'), null, "non-boolean currentRequestAnswered must be rejected");
  assert.equal(parseEvaluatorJson('{"currentRequestAnswered": true, "reasonCode": "DIRECTLY_ANSWERED"}'), null, "missing unnecessaryQuestion must be rejected");
  assert.equal(parseEvaluatorJson('{"currentRequestAnswered": true, "unnecessaryQuestion": false, "reasonCode": "MADE_UP_CODE"}'), null, "an unrecognized reasonCode must be rejected");
  assert.equal(parseEvaluatorJson('I think the reply answers the question because... {"currentRequestAnswered": true, "unnecessaryQuestion": false, "reasonCode": "DIRECTLY_ANSWERED"}'), null, "leading chain-of-thought prose before the JSON must be rejected, not leniently parsed");
});

test("every REASON_CODE is a plain uppercase identifier, never free text", () => {
  for (const code of REASON_CODES) assert.match(code, /^[A-Z_]+$/);
});

test("buildEvaluatorMessages never asks for chain-of-thought and pins the schema in the system prompt", () => {
  const messages = buildEvaluatorMessages({ customerMessage: "price?", locale: "english", response: "EUR 1500" });
  assert.equal(messages.length, 2);
  assert.doesNotMatch(messages[0].content, /chain.of.thought|step.by.step|explain your reasoning/i);
  assert.match(messages[0].content, /reasonCode/);
});

test("judgeResponse returns evaluatorUnavailable (not a fabricated verdict) when there is nothing to judge", async () => {
  const result = await judgeResponse({ customerMessage: "hi", locale: "english", response: "" });
  assert.equal(result.evaluatorUnavailable, true);
  assert.equal(result.reason, "no_response_to_judge");
});

test("judgeResponse returns evaluatorUnavailable, not a guessed verdict, when the injected model call throws", async () => {
  const result = await judgeResponse(
    { customerMessage: "price?", locale: "english", response: "EUR 1500" },
    { callModel: async () => { throw new Error("fetch failed"); } }
  );
  assert.equal(result.evaluatorUnavailable, true);
  assert.match(result.reason, /model_call_failed/);
});

test("judgeResponse returns evaluatorUnavailable when the model returns unparseable content, never a default true/false", async () => {
  const result = await judgeResponse(
    { customerMessage: "price?", locale: "english", response: "EUR 1500" },
    { callModel: async () => "I believe this answers the question well." }
  );
  assert.equal(result.evaluatorUnavailable, true);
  assert.equal(result.reason, "unparseable_or_invalid_schema");
});

test("judgeResponse returns a validated structured verdict with a promptVersion when the injected model call succeeds", async () => {
  const result = await judgeResponse(
    { customerMessage: "price?", locale: "english", response: "EUR 1500" },
    { callModel: async () => '{"currentRequestAnswered": true, "unnecessaryQuestion": false, "reasonCode": "DIRECTLY_ANSWERED"}' }
  );
  assert.equal(result.evaluatorUnavailable, false);
  assert.equal(result.currentRequestAnswered, true);
  assert.equal(typeof result.promptVersion, "string");
});
