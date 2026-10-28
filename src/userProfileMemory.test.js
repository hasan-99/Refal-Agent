"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { readProfileMemory, deriveProfileUpdate, persistProfileMemory, FIELD_NAMES } = require("./userProfileMemory");
const { buildSessionMemory } = require("./sessionMemory");

const NOW = Date.parse("2026-10-28T12:00:00Z");
const iso = (daysAgo) => new Date(NOW - daysAgo * 86_400_000).toISOString();

function sessionFrom(messages, extra = {}) {
  const history = messages.slice(0, -1).map((message, index) => ({ id: `t${index}`, at: new Date(NOW - (messages.length - index) * 60_000).toISOString(), message,
    metadata: { intent: { intents: ["company_formation"] } } }));
  return buildSessionMemory({ history, currentMessage: messages.at(-1), currentTurn: { id: "cur", intents: ["company_formation"] }, now: NOW, ...extra });
}

test("L: only allowlisted, confirmed, customer-stated fields are promoted; tentative, country, budget and contact details never are", () => {
  const state = sessionFrom(["My name is Hassan. We are based in Cyprus", "Please reply in English. We may need Arabic. My budget is 50000 EUR, email hassan@example.com. I own a company"]);
  const update = deriveProfileUpdate(state, null, { now: NOW });
  assert.equal(update.action, "write");
  const fields = update.profile.fields;
  assert.deepEqual(Object.keys(fields).sort(), ["customerType", "name", "preferredLanguage", "serviceInterest"]);
  for (const key of Object.keys(fields)) assert.ok(FIELD_NAMES.includes(key));
  assert.equal(fields.name.value, "Hassan");
  assert.equal(fields.name.status, "confirmed");
  assert.equal(fields.name.source, "user");
  assert.equal(fields.preferredLanguage.value, "english");
  assert.equal(fields.customerType.value, "business");
  assert.equal(fields.serviceInterest[0].status, "inferred");
  assert.doesNotMatch(JSON.stringify(update.profile), /Cyprus|50000|example\.com|Arabic/u);
});

test("L: a hedged name or language is not promoted", () => {
  const update = deriveProfileUpdate(sessionFrom(["maybe call me Sam", "maybe reply in English"]), null, { now: NOW });
  assert.equal(update.profile?.fields?.name, undefined);
  assert.equal(update.profile?.fields?.preferredLanguage, undefined);
});

test("L: a corrected name replaces the stored one and the wrong value is dropped", () => {
  const existing = { version: 1, fields: { name: { value: "Sami", status: "confirmed", source: "user", firstSeenAt: iso(10), updatedAt: iso(10) } } };
  const update = deriveProfileUpdate(sessionFrom(["My name is not Sami, it is Hassan"]), existing, { now: NOW });
  assert.equal(update.action, "write");
  assert.equal(update.profile.fields.name.value, "Hassan");
  const rejectedOnly = deriveProfileUpdate(sessionFrom(["My name is not Sami"]), existing, { now: NOW });
  assert.equal(rejectedOnly.profile?.fields?.name, undefined);
});

test("26: 'forget my details' deletes the durable profile", () => {
  const existing = { version: 1, fields: { name: { value: "Hassan", status: "confirmed", source: "user", firstSeenAt: iso(1), updatedAt: iso(1) } } };
  assert.deepEqual(deriveProfileUpdate(sessionFrom(["Please forget my details"]), existing, { now: NOW }), { action: "delete" });
  assert.deepEqual(deriveProfileUpdate(sessionFrom(["امسح بياناتي"]), existing, { now: NOW }), { action: "delete" });
});

test("no write when nothing changed (no per-turn write amplification)", () => {
  const state = sessionFrom(["My name is Hassan"]);
  const first = deriveProfileUpdate(state, null, { now: NOW });
  const read = readProfileMemory({ profile: { memoryProfile: first.profile } }, { now: NOW });
  assert.deepEqual(deriveProfileUpdate(sessionFrom(["My name is Hassan"]), read, { now: NOW }), { action: "none" });
});

test("25: retention drops old entries on read; malformed or foreign data is ignored, never thrown", () => {
  const profile = { memoryProfile: { version: 1, fields: {
    name: { value: "Hassan", status: "confirmed", source: "user", updatedAt: iso(200) },
    preferredLanguage: { value: "english", status: "confirmed", source: "user", updatedAt: iso(5) },
    customerType: { value: "spy", status: "confirmed", source: "user", updatedAt: iso(1) },
    serviceInterest: [{ value: "tax", status: "confirmed", source: "agent_inference", updatedAt: iso(1) }],
    budget: { value: "50000", status: "confirmed", source: "user", updatedAt: iso(1) }
  } } };
  const read = readProfileMemory({ profile }, { now: NOW, retentionDays: 180 });
  assert.deepEqual(Object.keys(read.fields), ["preferredLanguage"]);
  assert.equal(readProfileMemory({ profile: { memoryProfile: "garbage" } }), null);
  assert.equal(readProfileMemory({ profile: { memoryProfile: { version: 2, fields: {} } } }), null);
  assert.equal(readProfileMemory(null), null);
});

test("persistence is fail-safe and touches only profile.memoryProfile", async () => {
  const user = { profile: { conversationPreferences: { noProactiveBookingOrContact: true }, memoryProfile: { version: 1, fields: {} } } };
  const store = { updateUser: async (_id, update) => update(user) };
  const written = await persistProfileMemory(store, "u", { action: "write", profile: { version: 1, updatedAt: iso(0), fields: { name: { value: "Hassan" } } } });
  assert.equal(written.status, "written");
  assert.equal(user.profile.conversationPreferences.noProactiveBookingOrContact, true);
  assert.equal(user.profile.memoryProfile.fields.name.value, "Hassan");
  assert.equal((await persistProfileMemory(store, "u", { action: "delete" })).status, "deleted");
  assert.equal(user.profile.memoryProfile, undefined);
  assert.equal((await persistProfileMemory({ updateUser: async () => { throw new Error("db down"); } }, "u", { action: "delete" })).status, "failed");
  assert.equal((await persistProfileMemory({}, "u", { action: "delete" })).status, "unsupported");
  assert.equal((await persistProfileMemory(store, "u", { action: "none" })).status, "unchanged");
});

test("the retention migration is reviewed-only, scoped to memoryProfile, and carries a rollback", () => {
  const sql = fs.readFileSync(path.join(__dirname, "..", "supabase", "migrations", "20261028150000_rafa_memory_profile_retention.sql"), "utf8");
  assert.match(sql, /-- Rollback:\r?\n--\s+drop function if exists public\.rafa_purge_expired_memory_profiles\(integer\);/u);
  assert.match(sql, /set profile = c\.profile - 'memoryProfile'/u);
  assert.match(sql, /revoke all on function public\.rafa_purge_expired_memory_profiles\(integer\) from public, anon, authenticated;/u);
  assert.doesNotMatch(sql, /\b(?:drop\s+table|truncate|delete\s+from|alter\s+table)\b/iu);
});
