const test = require("node:test");
const assert = require("node:assert/strict");
const { CONSENT_STATES, getFollowUpDecision, runFollowUpCheck, shouldSendFollowUp } = require("./followUp");

function user(overrides = {}) { return { id: "contact-1", history: [{ at: "2026-09-30T00:00:00.000Z", message: "Yes, please follow up", response: "Of course." }], ...overrides }; }

test("follow-up decision reports consent and timing reasons", () => {
  const now = new Date("2026-10-01T01:00:00.000Z"); const allowed = getFollowUpDecision(user(), now);
  assert.equal(allowed.consent, CONSENT_STATES.GRANTED); assert.equal(allowed.reason, "ready"); assert.equal(allowed.eligible, true);
  assert.equal(getFollowUpDecision({ id: "x", history: [] }, now).reason, "consent_required");
  assert.equal(getFollowUpDecision(user({ history: [{ at: "2026-10-01T00:30:00Z", message: "Yes", response: "Sure" }] }), now).reason, "not_due");
});

test("opted-out and blocked contacts cannot be sent follow-ups", () => {
  const now = new Date("2026-10-02T00:00:00Z");
  assert.equal(getFollowUpDecision(user({ history: [{ at: "2026-09-30T00:00:00Z", message: "Please stop messaging me", response: "Understood" }] }), now).reason, "opted_out");
  assert.equal(shouldSendFollowUp(user({ blocked: true }), now), false);
});

test("runFollowUpCheck remains idempotent for one conversation cycle", async () => {
  const sent = []; const data = { "contact-1": user() };
  const store = { async allUsers() { return Object.values(data); }, async isContactBlocked() { return false; }, async updateUser(id, update) { update(data[id]); }, async addHistory(id, message, response, metadata) { data[id].history.push({ at: metadata.at, message, response, ...metadata }); } };
  const now = new Date("2026-10-01T01:00:00Z");
  await runFollowUpCheck({ store, now, sendFollowUp: async (...args) => sent.push(args) }); await runFollowUpCheck({ store, now, sendFollowUp: async (...args) => sent.push(args) });
  assert.equal(sent.length, 1);
});
