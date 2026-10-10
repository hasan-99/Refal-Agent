const assert = require("node:assert/strict");
const { test } = require("node:test");
const { EdgeApiStore } = require("./supabaseStore");

const id = "3a623eb1-0a75-4df7-9fb8-258a70cc2911";

test("claimNotificationById uses the isolated authenticated Edge route and exact run ID", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => ({ notification: { id, kind: "handover_review" } }) };
  };
  const store = new EdgeApiStore({ apiUrl: "https://edge.example.test/rafa-agent-api", key: "public-key", apiSecret: "internal-secret" });
  assert.deepEqual(await store.claimNotificationById(id, id), [{ id, kind: "handover_review" }]);
  assert.equal(request.url, `https://edge.example.test/rafa-agent-api/notifications/${id}/claim`);
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers["x-rafa-api-secret"], "internal-secret");
  assert.deepEqual(JSON.parse(request.options.body), { testRunId: id });
});

test("claimNotificationById validates IDs before making any API request", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let requests = 0;
  global.fetch = async () => { requests++; throw new Error("must not request"); };
  const store = new EdgeApiStore({ apiUrl: "https://edge.example.test/rafa-agent-api", key: "public-key", apiSecret: "internal-secret" });
  await assert.rejects(store.claimNotificationById("not-a-uuid", id), /notification ID/i);
  await assert.rejects(store.claimNotificationById(id, "not-a-uuid"), /test run ID/i);
  assert.equal(requests, 0);
});

test("a rejected internal API secret is not retried or bypassed", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let requests = 0;
  global.fetch = async () => { requests++; return { ok: false, status: 401, json: async () => ({ error: "Unauthorized" }) }; };
  const store = new EdgeApiStore({ apiUrl: "https://edge.example.test/rafa-agent-api", key: "public-key", apiSecret: "invalid" });
  await assert.rejects(store.claimNotificationById(id, id), /Unauthorized/);
  assert.equal(requests, 1);
});
