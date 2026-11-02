const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MAX_PROMPT_TOKEN_CEILING,
  PROMPT_MESSAGE_FRAMING_TOKEN_RESERVE,
  PROMPT_GLOBAL_FRAMING_TOKEN_RESERVE,
  promptTokenUpperBound,
  boundRecentConversation,
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
  const extended = { ...base, response_format: { json_schema: { schema: { properties: { answer: { description: "x".repeat(MAX_PROMPT_TOKEN_CEILING + 1) } } } } } };
  assert.ok(promptTokenUpperBound(extended) > MAX_PROMPT_TOKEN_CEILING);
  assert.ok(promptTokenUpperBound(extended) > promptTokenUpperBound(base));
});

test("bounded conversation keeps a concise explicit customer exclusion when repeated older messages are trimmed", () => {
  const repeatedQuestion = "عندي سؤال عن تأسيس شركة في قبرص ".repeat(12);
  const turns = [
    ...Array.from({ length: 7 }, () => ({ role: "user", content: repeatedQuestion })),
    { role: "user", content: "I only want company formation; I am not interested in property." },
    ...Array.from({ length: 4 }, () => ({ role: "user", content: repeatedQuestion })),
    { role: "user", content: repeatedQuestion },
    { role: "assistant", content: "Our package covers registration and the registered office. ".repeat(30) }
  ];

  const bounded = boundRecentConversation(turns, 4000);
  const customerTurns = bounded.turns.filter((turn) => turn.role === "user");
  assert.ok(customerTurns.some((turn) => /not interested in property/u.test(turn.content)));
});
