const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeOpenRouterUsage } = require("./ai.js");

test("OpenRouter usage keeps provider-reported values and actual response model", () => {
  assert.deepEqual(normalizeOpenRouterUsage({
    model: "provider/served-model",
    usage: { prompt_tokens: 31, completion_tokens: 12, total_tokens: 43, cost: 0.00021 }
  }, "configured/model"), {
    model: "provider/served-model",
    promptTokens: 31,
    completionTokens: 12,
    totalTokens: 43,
    costUsd: 0.00021,
    providerReported: true
  });
});

test("missing or malformed OpenRouter usage is not estimated", () => {
  assert.deepEqual(normalizeOpenRouterUsage({ usage: { prompt_tokens: "15", total_tokens: -1, cost: "0.01" } }, "model-x"), {
    model: "model-x",
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    costUsd: null,
    providerReported: false
  });
});
