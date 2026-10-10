const test = require("node:test");
const assert = require("node:assert/strict");
const { EdgeApiStore } = require("./supabaseStore");

function store() {
  return new EdgeApiStore({ apiUrl: "https://example.test/rafa-agent-api", key: "public-key", apiSecret: "internal-secret" });
}

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
