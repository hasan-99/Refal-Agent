import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { registerDynamicDataAdminRoutes } from "./dynamicDataAdmin.js";

const NOW = new Date("2026-10-10T12:00:00.000Z");
const ADMIN = { id: "11111111-1111-4111-8111-111111111111", email: "admin@refalco.com", role: "admin" };

async function withApp({ fetchImpl, env = { RAFA_API_URL: "https://example.supabase.co/functions/v1/rafa-agent-api", RAFA_API_SECRET: "server-secret" } } = {}, run) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (req.get("x-test-user") === "none") return res.status(401).json({ error: "Sign in to continue." });
    req.dashboardUser = req.get("x-test-user") === "staff"
      ? { id: "22222222-2222-4222-8222-222222222222", email: "staff@refalco.com", role: "staff" }
      : ADMIN;
    next();
  });
  const requireAdmin = (req, res, next) => req.dashboardUser.role === "admin" ? next() : res.status(403).json({ error: "Administrator access is required." });
  registerDynamicDataAdminRoutes(app, { requireAdmin, fetchImpl, env, now: () => new Date(NOW) });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run(async (path, options = {}) => fetch(`${base}${path}`, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } })); }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function offerData(overrides = {}) {
  return {
    code: "FORMATION-2026",
    title_en: "Formation package",
    amount: 999,
    valid_from: "2026-10-10T12:00:00.000Z",
    effective_from: "2026-10-10T12:00:00.000Z",
    valid_until: "2026-10-25T12:00:00.000Z",
    source_note: "Owner-approved current offer",
    ...overrides
  };
}

test("GET lists all gateway rows and uses the private Edge gateway contract", async () => {
  const calls = [];
  await withApp({ fetchImpl: async (...args) => { calls.push(args); return jsonResponse(200, { rows: [{ id: "draft-row", review_status: "draft" }], status: "ok" }); } }, async (request) => {
    const response = await request("/api/dynamic-data/offers");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { rows: [{ id: "draft-row", review_status: "draft" }], status: "ok" });
    assert.equal(calls[0][0], "https://example.supabase.co/functions/v1/rafa-agent-api/dynamic-data/offers?view=admin");
    assert.equal(calls[0][1].method, "GET");
    assert.equal(calls[0][1].headers["x-rafa-api-secret"], "server-secret");
  });
});

test("create validates typed data and derives audited actor from the dashboard session", async () => {
  const calls = [];
  await withApp({ fetchImpl: async (...args) => { calls.push(args); return jsonResponse(201, { row: { id: "created-row", ...JSON.parse(args[1].body).data } }); } }, async (request) => {
    const response = await request("/api/dynamic-data/offers", { method: "POST", body: JSON.stringify({ data: offerData({ review_status: "approved" }), actor: "attacker", role: "admin", reason: "Owner verified current terms" }) });
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
    const call = calls[0];
    const payload = JSON.parse(call[1].body);
    assert.deepEqual({ operation: payload.operation, actor: payload.actor, reason: payload.reason }, { operation: "create", actor: ADMIN.email, reason: "Owner verified current terms" });
    assert.equal(payload.data.reviewed_by, ADMIN.email);
    assert.equal(payload.data.verified_at, NOW.toISOString());
    assert.equal(call[1].method, "POST");
  });
});

test("mutations require admin while reads require a signed-in dashboard user", async () => {
  let calls = 0;
  await withApp({ fetchImpl: async () => { calls += 1; return jsonResponse(200, { rows: [] }); } }, async (request) => {
    const unauthenticated = await request("/api/dynamic-data/offers", { headers: { "x-test-user": "none" } });
    assert.equal(unauthenticated.status, 401);
    const staffRead = await request("/api/dynamic-data/offers", { headers: { "x-test-user": "staff" } });
    assert.equal(staffRead.status, 200);
    const staffWrite = await request("/api/dynamic-data/offers", { method: "POST", headers: { "x-test-user": "staff" }, body: JSON.stringify({ data: offerData(), reason: "Valid reason" }) });
    assert.equal(staffWrite.status, 403);
    assert.equal(calls, 1);
  });
});

test("update and delete use explicit row ids, reason, and missing-row responses", async () => {
  const calls = [];
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  await withApp({ fetchImpl: async (...args) => { calls.push(JSON.parse(args[1].body)); return calls.length === 1 ? jsonResponse(404, { error: "Dynamic data row was not found." }) : jsonResponse(200, {}); } }, async (request) => {
    const update = await request("/api/dynamic-data/offers", { method: "PATCH", body: JSON.stringify({ id, data: { amount: 1200 }, reason: "Corrected after owner review" }) });
    assert.equal(update.status, 404);
    assert.match((await update.json()).error, /row not found/i);
    assert.deepEqual(calls[0], { operation: "update", id, data: { amount: 1200 }, actor: ADMIN.email, reason: "Corrected after owner review" });
    const deletion = await request("/api/dynamic-data/offers", { method: "DELETE", body: JSON.stringify({ id, reason: "Offer withdrawn" }) });
    assert.equal(deletion.status, 404);
    assert.deepEqual(calls[1], { operation: "delete", id, data: {}, actor: ADMIN.email, reason: "Offer withdrawn" });
  });
});

test("rejects unsupported kinds, fields, invalid effective dates, and incomplete deposit updates", async () => {
  let calls = 0;
  await withApp({ fetchImpl: async () => { calls += 1; return jsonResponse(200, { row: {} }); } }, async (request) => {
    const unsupported = await request("/api/dynamic-data/leads");
    assert.equal(unsupported.status, 400);
    const field = await request("/api/dynamic-data/offers", { method: "POST", body: JSON.stringify({ data: offerData({ arbitrary_sql: "bad" }), reason: "test" }) });
    assert.equal(field.status, 400);
    const date = await request("/api/dynamic-data/offers", { method: "POST", body: JSON.stringify({ data: offerData({ valid_until: "2026-10-10T11:00:00.000Z" }), reason: "test" }) });
    assert.equal(date.status, 400);
    const deposit = await request("/api/dynamic-data/reservations", { method: "PATCH", body: JSON.stringify({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", data: { deposit_percent: 10 }, reason: "test" }) });
    assert.equal(deposit.status, 400);
    assert.equal(calls, 0);
  });
});

test("accepts typed create contracts for all five commercial kinds", async () => {
  const payloads = [];
  await withApp({ fetchImpl: async (_url, options) => {
    const payload = JSON.parse(options.body);
    payloads.push(payload);
    return jsonResponse(201, { row: { id: "created-row", ...payload.data } });
  } }, async (request) => {
    const effective_from = "2026-10-10T12:00:00.000Z";
    const valid_until = "2026-11-09T12:00:00.000Z";
    const cases = [
      ["offers", offerData()],
      ["renewals", { item: "secretary", amount: 500, period: "annual", effective_from, valid_until, source_note: "Current source" }],
      ["properties", { reference: "CY-1", city: "Nicosia", type: "Apartment", status: "completed", price: 150000, effective_from, valid_until, source_note: "Current source" }],
      ["reservations", { project_or_property_id: "CY-1", deposit_amount: 5000, effective_from, valid_until, source_note: "Current source" }],
      ["governmentFees", { fee_type: "registry", amount: 100, authority: "Registry", effective_from, valid_until, source_note: "Current source" }]
    ];
    for (const [kind, data] of cases) {
      const response = await request(`/api/dynamic-data/${kind}`, { method: "POST", body: JSON.stringify({ data, reason: "Verified against source" }) });
      assert.equal(response.status, 201, `${kind}: ${JSON.stringify(await response.clone().json())}`);
    }
    assert.deepEqual(payloads.map((item) => item.operation), Array(5).fill("create"));
    assert.deepEqual(payloads.map((item) => item.actor), Array(5).fill(ADMIN.email));
  });
});

test("maps missing migration and gateway outages to explicit 503", async () => {
  await withApp({ fetchImpl: async () => jsonResponse(404, { code: "PGRST205", error: "Could not find table in the schema cache" }) }, async (request) => {
    const response = await request("/api/dynamic-data/governmentFees");
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.code, "dynamic_data_migration_missing");
    assert.match(body.error, /migration is not applied/i);
  });
  await withApp({ fetchImpl: async () => { throw new Error("network error"); } }, async (request) => {
    const response = await request("/api/dynamic-data/governmentFees");
    assert.equal(response.status, 503);
  });
  await withApp({ fetchImpl: async () => jsonResponse(404, { error: "Function route not found" }) }, async (request) => {
    const response = await request("/api/dynamic-data/governmentFees");
    assert.equal(response.status, 503, "an absent Edge route is not an empty list or missing data row");
  });
});
