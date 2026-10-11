const test = require("node:test");
const assert = require("node:assert/strict");
const { EdgeApiStore } = require("./supabaseStore");

function store() {
  return new EdgeApiStore({ apiUrl: "https://example.test/rafa-agent-api", key: "public-key", apiSecret: "internal-secret" });
}

test("shared rate-limit requests are one bounded authenticated Edge call", async () => {
  const instance = store();
  let request;
  instance.request = async (...args) => { request = args; return { allowed: true, remaining: 9, retryAfterSeconds: 30 }; };
  const result = await instance.consumeRateLimit({ scope: "incoming_minute", subjectHash: "f".repeat(64), limit: 10 });
  assert.deepEqual(request, ["/rate-limits/consume", {
    method: "POST", timeoutMs: 5000,
    body: JSON.stringify({ scope: "incoming_minute", subjectHash: "f".repeat(64), limit: 10 })
  }]);
  assert.equal(result.allowed, true);
});

test("CRM writes use the dedicated durable profile route with linked source turn", async () => {
  const instance = store();
  let request;
  instance.request = async (...args) => { request = args; return { status: "saved", field: "businessactivity" }; };
  const result = await instance.saveCrmProfile({ userId: "123@s.whatsapp.net", field: "businessActivity", value: "accounting", sourceTurnId: "turn-1" });
  assert.deepEqual(request, ["/crm/profile", {
    method: "POST", timeoutMs: 8000,
    body: JSON.stringify({ userId: "123@s.whatsapp.net", field: "businessActivity", value: "accounting", sourceTurnId: "turn-1" })
  }]);
  assert.equal(result.status, "saved");
});

test("durable CRM result updates the active contact projection for the current agent turn", async () => {
  const instance = store();
  const user = { id: "123@s.whatsapp.net", profile: { agentFacts: { businessactivity: { value: "accounting" } } } };
  instance.data.users[user.id] = user;
  instance.request = async () => ({ status: "correction_needed", field: "businessactivity", correctionField: "businessactivity" });
  const result = await instance.saveCrmProfile({ userId: user.id, field: "businessActivity", value: "construction", sourceTurnId: "turn-2" });
  assert.equal(result.status, "correction_needed");
  assert.deepEqual(user.profile.crmCorrectionNeeded, { field: "businessactivity" });
  assert.equal(user.profile.agentFacts.businessactivity.value, "accounting", "the old value is retained until clarification");
  assert.equal(user.profile.agentFacts.businessactivity.correctionNeeded, true);
});

test("dynamic reads send only typed filters and normalize explicit empty state", async () => {
  const instance = store();
  let request;
  instance.request = async (path) => { request = path; return { rows: [], status: "unavailable", reasonCode: "NO_CURRENT_DATA" }; };
  const result = await instance.lookupDynamicData("properties", { city: "Limassol", view: "admin", active: false, randomField: "draft" });
  assert.equal(request, "/dynamic-data/properties?city=Limassol");
  assert.deepEqual(result, { ok: false, status: "unavailable", reasonCode: "NO_CURRENT_DATA", data: [] });
});

test("dynamic action writes use the idempotent route and never retry after an ambiguous error", async () => {
  const instance = store();
  let calls = 0;
  const originalFetch = global.fetch;
  global.fetch = async (_url, options) => {
    calls += 1;
    assert.equal(options.method, "POST");
    return new Response("{}", { status: 503, headers: { "content-type": "application/json" } });
  };
  try {
    await assert.rejects(instance.performDynamicAction("upsertLead", { userId: "contact" }));
    assert.equal(calls, 1);
  } finally { global.fetch = originalFetch; }
});

test("dynamic action rate-limit rejection is definitive, safe, and not returned as pending", async () => {
  const instance = store();
  let calls = 0;
  const originalFetch = global.fetch;
  global.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: "Please wait before repeating this request." }), {
      status: 429,
      headers: { "content-type": "application/json" }
    });
  };
  try {
    const result = await instance.performDynamicAction("upsertLead", { userId: "contact" });
    assert.deepEqual(result, {
      ok: false,
      status: "error",
      reasonCode: "ACTION_RATE_LIMITED",
      userSafeSummary: "Please wait before trying that again."
    });
    assert.equal(calls, 1);
  } finally { global.fetch = originalFetch; }
});

test("safe GET requests retry transient failures within a fixed bound", async () => {
  const instance = store();
  let calls = 0;
  const originalFetch = global.fetch;
  global.fetch = async () => {
    calls += 1;
    return calls < 3
      ? new Response("{}", { status: 503, headers: { "content-type": "application/json" } })
      : new Response(JSON.stringify({ rows: [{ id: "offer-1" }], status: "available" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await instance.lookupDynamicData("offers", { code: "formation-package" });
    assert.equal(result.ok, true);
    assert.equal(calls, 3);
  } finally { global.fetch = originalFetch; }
});
