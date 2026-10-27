const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeOpenRouterUsage } = require("./ai.js");
const { askOpenRouter } = require("./ai.js");

test("provider usage latency includes slow response-body parsing", async (t) => {
  const originalFetch = global.fetch;
  const originalApiKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-key";
  global.fetch = async () => ({
    ok: true,
    json: async () => {
      await new Promise((resolve) => setTimeout(resolve, 160));
      return {
        model: "provider/served-model",
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.00001 },
        choices: [{ finish_reason: "stop", message: { content: "Our Limassol office can help with that." } }]
      };
    }
  });
  t.after(() => {
    global.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalApiKey;
  });

  let seen;
  await askOpenRouter({
    text: "Where are your offices?",
    evidence: [{ heading: "Office", content: "Our Limassol office can help with that." }],
    includeSources: false,
    onUsage: (usage) => { seen = usage; }
  });
  assert.ok(Number.isSafeInteger(seen.providerLatencyMs));
  assert.ok(seen.providerLatencyMs >= 120, `body delay was omitted: ${seen.providerLatencyMs}ms`);
  assert.equal(seen.model, "provider/served-model");
  assert.equal(seen.totalTokens, 15);
  assert.equal(seen.costUsd, 0.00001);
});

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

test("multilingual conversation history over the prompt ceiling skips provider calls", async (t) => {
  const originalFetch = global.fetch;
  const originalApiKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-key";
  let fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    throw new Error("provider should not be called for an oversized prompt");
  };
  t.after(() => {
    global.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalApiKey;
  });

  const answer = await askOpenRouter({
    text: "ما هي الخدمات؟",
    evidence: [{ heading: "الخدمات", content: "خدمات معتمدة" }],
    conversationTurns: Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user",
      content: "م".repeat(1200)
    }))
  });
  assert.equal(answer, null, "oversized prompt must use the deterministic fallback path");
  assert.equal(fetchCalls, 0);
});
