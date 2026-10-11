const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MAX_PROMPT_TOKEN_CEILING,
  PROMPT_MESSAGE_FRAMING_TOKEN_RESERVE,
  PROMPT_GLOBAL_FRAMING_TOKEN_RESERVE,
  promptTokenUpperBound,
  assertPromptWithinTokenCeiling
} = require("./promptBudget");

test("prompt upper bound counts serialized UTF-8 message bytes, including multilingual and emoji text", () => {
  const messages = [{ role: "user", content: "مرحبا 😀" }];
  assert.equal(promptTokenUpperBound(messages), Buffer.byteLength(JSON.stringify(messages), "utf8")
    + PROMPT_MESSAGE_FRAMING_TOKEN_RESERVE + PROMPT_GLOBAL_FRAMING_TOKEN_RESERVE);
});

test("prompt token ceiling rejects oversized prompts before model dispatch", () => {
  const messages = [{ role: "system", content: "x".repeat(MAX_PROMPT_TOKEN_CEILING) }];
  assert.throws(() => assertPromptWithinTokenCeiling(messages), { code: "PROMPT_TOKEN_CEILING_EXCEEDED" });
  assert.doesNotThrow(() => assertPromptWithinTokenCeiling([{ role: "user", content: "short" }]));
});

test("prompt budget includes per-message framing and structured non-string fields", () => {
  const manyMessages = Array.from({ length: 3000 }, () => ({ role: "user", content: "" }));
  assert.ok(promptTokenUpperBound(manyMessages) > MAX_PROMPT_TOKEN_CEILING);

  const toolPayload = [{ role: "assistant", tool_calls: [{ id: "call", function: { arguments: "x".repeat(40000) } }] }];
  assert.ok(promptTokenUpperBound(toolPayload) > MAX_PROMPT_TOKEN_CEILING);
  assert.equal(promptTokenUpperBound([{ role: "user", content: "ok", opaque: 7 }]),
    Buffer.byteLength(JSON.stringify([{ role: "user", content: "ok", opaque: 7 }]), "utf8")
      + PROMPT_MESSAGE_FRAMING_TOKEN_RESERVE + PROMPT_GLOBAL_FRAMING_TOKEN_RESERVE);
});

test("prompt budget includes request-level response schema and generation options", () => {
  const base = { model: "model", messages: [{ role: "user", content: "short" }] };
  const extended = { ...base, response_format: { json_schema: { schema: { properties: { answer: { description: "x".repeat(32000) } } } } } };
  assert.ok(promptTokenUpperBound(extended) > MAX_PROMPT_TOKEN_CEILING);
  assert.ok(promptTokenUpperBound(extended) > promptTokenUpperBound(base));
});
