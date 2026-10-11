const test = require("node:test");
const assert = require("node:assert/strict");
const { checkAiMessage, checkIncomingMessage, resetRateLimiters } = require("./rateLimiter");

test("shared per-contact checks send only a stable HMAC and enforce the remote verdict", async (t) => {
  const previousSecret = process.env.RAFA_API_SECRET;
  process.env.RAFA_API_SECRET = "stable-test-secret";
  resetRateLimiters();
  t.after(() => {
    resetRateLimiters();
    if (previousSecret === undefined) delete process.env.RAFA_API_SECRET;
    else process.env.RAFA_API_SECRET = previousSecret;
  });
  const calls = [];
  const store = { consumeRateLimit: async (request) => { calls.push(request); return { allowed: false }; } };
  const first = await checkIncomingMessage("contact+private@c.us", { store });
  const second = await checkIncomingMessage("contact+private@c.us", { store });
  assert.deepEqual(first, { allowed: false, source: "shared" });
  assert.deepEqual(second, first);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(({ scope, limit }) => ({ scope, limit })), [
    { scope: "incoming_minute", limit: 10 }, { scope: "incoming_minute", limit: 10 }
  ]);
  assert.match(calls[0].subjectHash, /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(calls), /contact\+private/u);
});

test("AI quota uses the shared daily scope and a database outage uses the bounded local backstop", async (t) => {
  const previousSecret = process.env.RAFA_API_SECRET;
  process.env.RAFA_API_SECRET = "stable-test-secret";
  resetRateLimiters();
  t.after(() => {
    resetRateLimiters();
    if (previousSecret === undefined) delete process.env.RAFA_API_SECRET;
    else process.env.RAFA_API_SECRET = previousSecret;
  });
  let request;
  const remote = await checkAiMessage("client-1", { store: { consumeRateLimit: async (value) => { request = value; return { allowed: true }; } } });
  assert.deepEqual(remote, { allowed: true, source: "shared" });
  assert.deepEqual({ scope: request.scope, limit: request.limit }, { scope: "ai_daily", limit: 100 });

  const fallback = await checkAiMessage("client-2", { store: { consumeRateLimit: async () => { throw new Error("unavailable"); } }, now: new Date("2026-10-11T10:00:00Z") });
  assert.deepEqual(fallback, { allowed: true, source: "local_fallback" });
});
