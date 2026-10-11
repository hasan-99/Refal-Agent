const test = require("node:test");
const assert = require("node:assert/strict");
const { CONSENT_STATES, getFollowUpDecision, isNaturalConversationEnd, runFollowUpCheck, shouldSendFollowUp } = require("./followUp");

function user(overrides = {}) { return { id: "contact-1", history: [{ id: "consent-turn", at: "2026-09-30T00:00:00.000Z", source: "whatsapp", message: "I agree to automated reminders", response: "Understood.", metadata: { intent: { language: "english" }, followUpConsent: { state: "granted", purpose: "automated_reminder", sourceTurnId: "consent-turn", channel: "whatsapp", language: "en" } } }], ...overrides }; }

test("follow-up decision reports consent and timing reasons", () => {
  const now = new Date("2026-10-01T01:00:00.000Z"); const allowed = getFollowUpDecision(user(), now);
  assert.equal(allowed.consent, CONSENT_STATES.GRANTED); assert.equal(allowed.reason, "ready"); assert.equal(allowed.eligible, true);
  assert.equal(getFollowUpDecision({ id: "x", history: [] }, now).reason, "consent_required");
  assert.equal(getFollowUpDecision(user({ history: [{ at: "2026-10-01T00:30:00Z", message: "Yes", response: "Sure" }] }), now).reason, "consent_required");
});

test("opted-out and blocked contacts cannot be sent follow-ups", () => {
  const now = new Date("2026-10-02T00:00:00Z");
  assert.equal(getFollowUpDecision(user({ history: [{ at: "2026-09-30T00:00:00Z", message: "Please stop messaging me", response: "Understood" }] }), now).reason, "opted_out");
  for (const message of ["وقفوا التواصل معي", "ما بدي رسائل بعد اليوم", "Μη μου στέλνετε άλλα μηνύματα", "Do not send me any more messages"]) {
    const stopped = user({ history: [...user().history, { at: "2026-10-01T00:00:00Z", message, response: "Understood." }] });
    assert.equal(getFollowUpDecision(stopped, now).reason, "opted_out", message);
    assert.equal(shouldSendFollowUp(stopped, now), false, message);
  }
  assert.equal(shouldSendFollowUp(user({ blocked: true }), now), false);
});

test("specialist-contact consent alone cannot authorize generic automated reminder outreach", () => {
  const now = new Date("2026-10-02T00:00:00Z");
  const specialistOnly = user({ history: [{ id: "specialist-turn", at: "2026-09-30T00:00:00Z", message: "Please follow up", response: "Understood.", metadata: { specialistFollowUp: { consented: true, purpose: "specialist_follow_up" } } }] });
  assert.equal(getFollowUpDecision(specialistOnly, now).reason, "consent_required");
  assert.equal(shouldSendFollowUp(specialistOnly, now), false);
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

test("overlapping checks for one store do not send duplicate follow-ups", async () => {
  const target = user();
  const store = {
    async allUsers() { return [target]; },
    async isContactBlocked() { return false; },
    async updateUser(_id, update) { update(target); },
    async addHistory(_id, message, response, metadata) { target.history.push({ message, response, ...metadata }); }
  };
  let markSendStarted;
  const sendStarted = new Promise((resolve) => { markSendStarted = resolve; });
  let finishSend;
  const sendGate = new Promise((resolve) => { finishSend = resolve; });
  let sends = 0;
  const first = runFollowUpCheck({ store, now: new Date("2026-10-01T01:00:00Z"), sendFollowUp: async () => { sends += 1; markSendStarted(); await sendGate; } });
  await sendStarted;
  const overlapping = await runFollowUpCheck({ store, now: new Date("2026-10-01T01:00:00Z"), sendFollowUp: async () => { sends += 1; } });
  assert.deepEqual(overlapping, { sent: 0, skipped: true, reason: "check_in_progress" });
  finishSend();
  assert.deepEqual(await first, { sent: 1 });
  assert.equal(sends, 1);
});

test("saved schedules and low delay settings cannot bypass the 24-hour silence floor", () => {
  const previous = process.env.FOLLOW_UP_DELAY_HOURS;
  process.env.FOLLOW_UP_DELAY_HOURS = "1";
  try {
    const lastAt = "2026-10-01T00:00:00Z";
    const tooSoon = user({
      history: [{ ...user().history[0], at: lastAt, message: "I agree to automated reminders", response: "Understood." }],
      followUpState: { status: "scheduled", next_due_at: "2026-10-01T02:00:00Z" }
    });
    const timing = getFollowUpDecision(tooSoon, new Date("2026-10-01T23:59:59Z")).timing;
    assert.equal(timing.dueAt.toISOString(), "2026-10-02T00:00:00.000Z");
    assert.equal(timing.due, false);
    assert.equal(getFollowUpDecision(tooSoon, new Date("2026-10-02T00:00:00Z")).reason, "ready");
  } finally {
    if (previous === undefined) delete process.env.FOLLOW_UP_DELAY_HOURS;
    else process.env.FOLLOW_UP_DELAY_HOURS = previous;
  }
});

test("final thanks, goodbyes, and incomplete turns are excluded across supported languages", () => {
  for (const message of ["Thanks, goodbye", "شكراً، مع السلامة", "Ευχαριστώ, καλή συνέχεια"]) {
    assert.equal(isNaturalConversationEnd(message), true, message);
    assert.equal(shouldSendFollowUp(user({ history: [{ ...user().history[0], message }] }), new Date("2026-10-02T00:00:00Z")), false, message);
  }
  assert.equal(shouldSendFollowUp(user({ history: [{ ...user().history[0], response: "" }] }), new Date("2026-10-02T00:00:00Z")), false);
});

test("follow-up sends stay disabled when suppression checks are missing or fail", async () => {
  const now = new Date("2026-10-02T00:00:00Z");
  const target = user();
  const sent = [];
  const missing = await runFollowUpCheck({ store: { async allUsers() { return [target]; } }, now, sendFollowUp: async (...args) => sent.push(args) });
  assert.equal(missing.disabled, true);
  assert.equal(missing.reason, "suppression_check_unavailable");
  assert.equal(sent.length, 0);

  const failureStore = {
    async allUsers() { return [target, { ...target, id: "contact-2" }]; },
    async isContactBlocked(id) { if (id === "contact-2") throw new Error("lookup failed"); return false; }
  };
  await assert.rejects(runFollowUpCheck({ store: failureStore, now, sendFollowUp: async (...args) => sent.push(args) }), /lookup failed/);
  assert.equal(sent.length, 0, "all suppression lookups finish before the first send");
});
