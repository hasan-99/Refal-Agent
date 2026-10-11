import test from "node:test";
import assert from "node:assert/strict";
import { consumeSharedRateLimit } from "./rateLimit.mjs";

test("shared rate limit calls only the allowlisted atomic RPC contract", async () => {
  let call;
  const result = await consumeSharedRateLimit({
    rpc: async (...args) => {
      call = args;
      return { data: [{ allowed: false, remaining: 0, retry_after_seconds: 24 }], error: null };
    }
  }, { scope: "incoming_minute", subjectHash: "a".repeat(64), limit: 10 });
  assert.deepEqual(call, ["rafa_consume_rate_limit", {
    p_scope: "incoming_minute", p_subject_hash: "a".repeat(64), p_limit: 10
  }]);
  assert.deepEqual(result, { allowed: false, remaining: 0, retryAfterSeconds: 24 });
});

test("shared limiter rejects arbitrary scopes, PII subjects, and invalid limits before database access", async () => {
  let calls = 0;
  const client = { rpc: async () => { calls += 1; return { data: [], error: null }; } };
  for (const input of [
    { scope: "arbitrary", subjectHash: "a".repeat(64), limit: 1 },
    { scope: "ai_daily", subjectHash: "+35799111222", limit: 1 },
    { scope: "ai_daily", subjectHash: "a".repeat(64), limit: 0 },
    { scope: "ai_daily", subjectHash: "a".repeat(64), limit: 1001 }
  ]) await assert.rejects(consumeSharedRateLimit(client, input), /Invalid shared rate limit/u);
  assert.equal(calls, 0);
});

test("shared limiter fails on database errors and malformed RPC responses", async () => {
  await assert.rejects(consumeSharedRateLimit({ rpc: async () => ({ data: null, error: new Error("db down") }) },
    { scope: "ai_daily", subjectHash: "b".repeat(64), limit: 2 }), /db down/u);
  await assert.rejects(consumeSharedRateLimit({ rpc: async () => ({ data: [], error: null }) },
    { scope: "ai_daily", subjectHash: "b".repeat(64), limit: 2 }), /response is invalid/u);
});
