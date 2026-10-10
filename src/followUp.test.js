const test = require("node:test");
const assert = require("node:assert/strict");
const { CONSENT_STATES, getFollowUpDecision, runFollowUpCheck, shouldSendFollowUp } = require("./followUp");

function user(overrides = {}) { return { id: "contact-1", history: [{ at: "2026-09-30T00:00:00.000Z", message: "Yes, please follow up", response: "Of course.", metadata: { specialistFollowUp: { consented: true, purpose: "specialist_follow_up" } } }], ...overrides }; }

test("follow-up decision reports consent and timing reasons", () => {
  const now = new Date("2026-10-01T01:00:00.000Z"); const allowed = getFollowUpDecision(user(), now);
  assert.equal(allowed.consent, CONSENT_STATES.GRANTED); assert.equal(allowed.reason, "ready"); assert.equal(allowed.eligible, true);
  assert.equal(getFollowUpDecision({ id: "x", history: [] }, now).reason, "consent_required");
  assert.equal(getFollowUpDecision(user({ history: [{ at: "2026-10-01T00:30:00Z", message: "Yes", response: "Sure" }] }), now).reason, "consent_required");
});

test("opted-out and blocked contacts cannot be sent follow-ups", () => {
  const now = new Date("2026-10-02T00:00:00Z");
  assert.equal(getFollowUpDecision(user({ history: [{ at: "2026-09-30T00:00:00Z", message: "Please stop messaging me", response: "Understood" }] }), now).reason, "opted_out");
  assert.equal(shouldSendFollowUp(user({ blocked: true }), now), false);
});

test("an explicit saved schedule controls due time and still requires purpose-bound consent", () => {
  const now = new Date("2026-10-01T12:00:00Z");
  const scheduled = user({ followUpState: { status: "scheduled", next_due_at: "2026-10-01T13:00:00Z" } });
  assert.equal(getFollowUpDecision(scheduled, now).reason, "not_due");
  assert.equal(getFollowUpDecision(scheduled, new Date("2026-10-01T13:00:00Z")).reason, "ready");
  assert.equal(getFollowUpDecision({ ...scheduled, history: [{ at: "2026-09-30T00:00:00Z", message: "Hello", response: "Hi" }] }, new Date("2026-10-01T13:00:00Z")).reason, "consent_required");
});

test("runFollowUpCheck remains idempotent for one conversation cycle", async () => {
  const sent = []; const data = { "contact-1": user() };
  const store = { async allUsers() { return Object.values(data); }, async isContactBlocked() { return false; }, async updateUser(id, update) { update(data[id]); }, async addHistory(id, message, response, metadata) { data[id].history.push({ at: metadata.at, message, response, ...metadata }); } };
  const now = new Date("2026-10-01T01:00:00Z");
  await runFollowUpCheck({ store, now, sendFollowUp: async (...args) => sent.push(args) }); await runFollowUpCheck({ store, now, sendFollowUp: async (...args) => sent.push(args) });
  assert.equal(sent.length, 1);
});
