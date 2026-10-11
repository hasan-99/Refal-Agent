import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchJsonWithTimeout, ProviderTimeoutError } from "./providerTransport.mjs";
import { normalizeOpenRouterUsage } from "./providerUsage.mjs";
import { redactAuditEventFields } from "./auditEventPrivacy.mjs";

test("provider transport returns parsed JSON and forwards an abort signal", async () => {
  let requestSignal;
  const result = await fetchJsonWithTimeout("https://provider.invalid", { method: "POST" }, {
    timeoutMs: 100,
    fetchImpl: async (_url, init) => {
      requestSignal = init.signal;
      return { json: async () => ({ choices: [{ message: { content: "ok" } }] }) };
    }
  });

  assert.equal(result.body.choices[0].message.content, "ok");
  assert.equal(requestSignal instanceof AbortSignal, true);
  assert.equal(requestSignal.aborted, false);
});

test("provider timeout aborts and rejects a fetch that never settles", async () => {
  let requestSignal;
  await assert.rejects(fetchJsonWithTimeout("https://provider.invalid", {}, {
    timeoutMs: 10,
    fetchImpl: (_url, init) => {
      requestSignal = init.signal;
      return new Promise(() => {});
    }
  }), ProviderTimeoutError);
  assert.equal(requestSignal.aborted, true);
});

test("provider timeout includes time spent reading a stalled response body", async () => {
  await assert.rejects(fetchJsonWithTimeout("https://provider.invalid", {}, {
    timeoutMs: 10,
    fetchImpl: async () => ({ json: () => new Promise(() => {}) })
  }), ProviderTimeoutError);
});

test("provider transport rejects invalid timeout configuration", async () => {
  await assert.rejects(fetchJsonWithTimeout("https://provider.invalid", {}, { timeoutMs: 0 }), RangeError);
});

test("Edge provider accounting includes response latency and preserves only safe scalars after redaction", () => {
  const usage = normalizeOpenRouterUsage({
    model: "provider/model-a",
    usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150, cost: 0.0025 }
  }, "configured/model", 842);
  assert.deepEqual(usage, {
    model: "provider/model-a", promptTokens: 120, completionTokens: 30,
    totalTokens: 150, costUsd: 0.0025, providerReported: true, providerLatencyMs: 842
  });
  assert.deepEqual(redactAuditEventFields({ source: "dashboard", userId: "operator@example.test", ...usage }), {
    source: "dashboard", userId: "[redacted]", model: "[redacted]",
    promptTokens: 120, completionTokens: 30, totalTokens: 150, costUsd: 0.0025,
    providerReported: true, providerLatencyMs: 842
  });
  assert.equal(normalizeOpenRouterUsage({}, "configured/model", Infinity).providerLatencyMs, null);
});
