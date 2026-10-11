import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { registerContactCorrectionAdminRoutes } from "./contactCorrectionAdmin.js";

const CONTACT_ID = "35799123456@s.whatsapp.net";
const ADMIN = { email: "admin@refalco.com", role: "admin" };

async function withApp({ user, correctionError = null } = {}, run) {
  let current = structuredClone(user || { id: CONTACT_ID, profile: { nameOverride: "Mira", needOverride: "accounting", conversationSummary: "Owner of two companies" } });
  const events = [];
  const store = {
    async getUser() { return current ? structuredClone(current) : null; },
    async correctContactProfile(_id, changes, expected, actor) {
      if (correctionError) throw correctionError;
      const profile = current.profile || {};
      for (const field of Object.keys(expected)) {
        if (String(expected[field] ?? "") !== String(profile[field] || "")) {
          const error = new Error("stale"); error.status = 409; throw error;
        }
      }
      const next = { ...profile, ...changes };
      if (Object.hasOwn(changes, "conversationSummary")) next.conversationSummaryUpdatedAt = "2026-10-11T10:00:00.000Z";
      const fields = Object.keys(changes);
      events.push({ event: "contact_memory_admin_updated", payload: { contactId: _id, actor, action: "update_contact_memory", fields } });
      current = { ...current, profile: next };
      return { profile: structuredClone(next) };
    }
  };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.dashboardUser = req.get("x-role") === "staff" ? { role: "staff", email: "staff@refalco.com" } : ADMIN;
    next();
  });
  const requireAdmin = (req, res, next) => req.dashboardUser.role === "admin" ? next() : res.status(403).json({ error: "Administrator access is required." });
  registerContactCorrectionAdminRoutes(app, { store, requireAdmin, now: () => new Date("2026-10-11T10:00:00.000Z") });
  const server = await new Promise((resolve) => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run({ request: (body, headers = {}) => fetch(`${base}/api/leads/${encodeURIComponent(CONTACT_ID)}/contact`, { method: "PUT", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }), getCurrent: () => structuredClone(current), events }); }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

test("partial correction updates preserve omitted fields and atomically audit only changed field names", async () => {
  await withApp({}, async ({ request, getCurrent, events }) => {
    const response = await request({ contact: { needOverride: "tax" }, expected: { needOverride: "accounting" } });
    assert.equal(response.status, 200);
    assert.deepEqual(getCurrent().profile, {
      nameOverride: "Mira", needOverride: "tax", conversationSummary: "Owner of two companies"
    });
    assert.deepEqual(events, [{ event: "contact_memory_admin_updated", payload: {
      contactId: CONTACT_ID, actor: "admin@refalco.com", action: "update_contact_memory", fields: ["needOverride"]
    } }]);
    assert.doesNotMatch(JSON.stringify(events), /Mira|tax|accounting|Owner of two companies/);
  });
});

test("stale correction baselines return a conflict without saving or auditing", async () => {
  await withApp({}, async ({ request, getCurrent, events }) => {
    const response = await request({ contact: { nameOverride: "Mira Haddad" }, expected: { nameOverride: "Old name" } });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "contact_correction_stale");
    assert.equal(getCurrent().profile.nameOverride, "Mira");
    assert.equal(events.length, 0);
  });
});

test("parallel stale saves use the durable compare-and-save contract so the later editor cannot overwrite", async () => {
  await withApp({}, async ({ request, getCurrent, events }) => {
    const expected = { needOverride: "accounting" };
    const [first, second] = await Promise.all([
      request({ contact: { needOverride: "tax" }, expected }),
      request({ contact: { needOverride: "audit" }, expected })
    ]);
    assert.deepEqual([first.status, second.status].sort(), [200, 409]);
    assert.equal(getCurrent().profile.needOverride, "tax");
    assert.equal(events.length, 1);
  });
});

test("staff cannot correct contact memory, invalid fields are rejected, and unavailable atomic writes never report success", async () => {
  await withApp({}, async ({ request, events }) => {
    assert.equal((await request({ contact: { nameOverride: "X" } }, { "x-role": "staff" })).status, 403);
    assert.equal((await request({ contact: { privateNotes: "secret" } })).status, 400);
    assert.equal(events.length, 0);
  });
  await withApp({ correctionError: new Error("storage unavailable") }, async ({ request }) => {
    const response = await request({ contact: { nameOverride: "Mira H" }, expected: { nameOverride: "Mira" } });
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /No success was confirmed/);
  });
});
