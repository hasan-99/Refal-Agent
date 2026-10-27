const test = require("node:test");
const assert = require("node:assert/strict");
const { CONSENT_STATES, getFollowUpDecision, isNaturalConversationEnd, runFollowUpCheck, shouldSendFollowUp } = require("./followUp");

function user(overrides = {}) { return { id: "contact-1", history: [{ id: "consent-turn", at: "2026-09-30T00:00:00.000Z", source: "whatsapp", automated: true, message: "I agree to automated reminders", response: "Understood.", metadata: { intent: { language: "english" }, followUpConsent: { state: "granted", purpose: "automated_reminder", sourceTurnId: "consent-turn", channel: "whatsapp", language: "en" } } }], ...overrides }; }

function withDeliveryClaims(store) {
  const states = new Map();
  store.claimFollowUpSend = async (userId, claim) => {
    const current = states.get(userId);
    const allowed = !current || ["retryable"].includes(current.outcome)
      || (current.outcome === "sent" && current.consentSourceTurnId !== claim.consentSourceTurnId);
    if (!allowed) return false;
    states.set(userId, { ...claim, outcome: "sending" });
    return true;
  };
  store.finishFollowUpSend = async (userId, result) => {
    const current = states.get(userId);
    if (!current || current.outcome !== "sending" || current.claimId !== result.claimId) return false;
    states.set(userId, { ...current, outcome: result.outcome });
    return true;
  };
  store.deliveryStates = states;
  return store;
}

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

test("bot-generated customer turns remain eligible; only scheduler follow-up turns are excluded", () => {
  const now = new Date("2026-10-01T01:00:00.000Z");
  const target = user();
  assert.equal(shouldSendFollowUp(target, now), true, "the stored automated flag describes REFAL's reply, not an outbound follow-up");
  const scheduledMessage = { ...target.history[0], source: "auto-follow-up", message: "[auto-follow-up]" };
  assert.equal(shouldSendFollowUp(user({ history: [scheduledMessage] }), now), false);
});

test("specialist-contact consent alone cannot authorize generic automated reminder outreach", () => {
  const now = new Date("2026-10-02T00:00:00Z");
  const specialistOnly = user({ history: [{ id: "specialist-turn", at: "2026-09-30T00:00:00Z", message: "Please follow up", response: "Understood.", metadata: { specialistFollowUp: { consented: true, purpose: "specialist_follow_up" } } }] });
  assert.equal(getFollowUpDecision(specialistOnly, now).reason, "consent_required");
  assert.equal(shouldSendFollowUp(specialistOnly, now), false);
});

test("WhatsApp follow-ups require WhatsApp-scoped consent and use its recorded language", async () => {
  const now = new Date("2026-10-01T01:00:00Z");
  const emailGrant = user();
  emailGrant.history[0].metadata.followUpConsent.channel = "email";
  assert.equal(getFollowUpDecision(emailGrant, now).reason, "consent_channel_mismatch");
  assert.equal(shouldSendFollowUp(emailGrant, now), false);

  for (const [language, expected] of [["en", "Would you like to know more?"], ["el", "Σας ενδιαφέρει"], ["ar", "لسا مهتم"]]) {
    const target = user();
    target.history[0].metadata.followUpConsent.language = language;
    const delivered = [];
    const store = withDeliveryClaims({
      async allUsers() { return [target]; },
      async getUser() { return target; },
      async isContactBlocked() { return false; },
      async updateUser(_id, update) { update(target); },
      async addHistory(_id, message, response, metadata) { target.history.push({ message, response, ...metadata }); }
    });
    assert.deepEqual(await runFollowUpCheck({ store, now, sendFollowUp: async (_id, text) => delivered.push(text) }), { sent: 1 });
    assert.match(delivered[0], new RegExp(expected));
    assert.equal(target.history.at(-1).response, delivered[0]);
  }
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
  const store = withDeliveryClaims({ async allUsers() { return Object.values(data); }, async getUser(id) { return data[id]; }, async isContactBlocked() { return false; }, async updateUser(id, update) { update(data[id]); }, async addHistory(id, message, response, metadata) { data[id].history.push({ at: metadata.at, message, response, ...metadata }); } });
  const now = new Date("2026-10-01T01:00:00Z");
  await runFollowUpCheck({ store, now, sendFollowUp: async (...args) => sent.push(args) }); await runFollowUpCheck({ store, now, sendFollowUp: async (...args) => sent.push(args) });
  assert.equal(sent.length, 1);
});

test("overlapping checks for one store do not send duplicate follow-ups", async () => {
  const target = user();
  const store = withDeliveryClaims({
    async allUsers() { return [target]; },
    async getUser() { return target; },
    async isContactBlocked() { return false; },
    async updateUser(_id, update) { update(target); },
    async addHistory(_id, message, response, metadata) { target.history.push({ message, response, ...metadata }); }
  });
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

test("fresh opt-out after candidate scan suppresses the follow-up send", async () => {
  const candidate = user();
  const optedOut = user({ history: [
    ...user().history,
    { id: "stop-turn", at: "2026-10-01T00:30:00Z", message: "Stop messaging me", response: "Understood." }
  ] });
  const delivered = [];
  const result = await runFollowUpCheck({
    store: withDeliveryClaims({
      async allUsers() { return [candidate]; },
      async isContactBlocked() { return false; },
      async getUser() { return optedOut; }
    }),
    now: new Date("2026-10-02T00:00:00Z"),
    sendFollowUp: async (...args) => delivered.push(args)
  });
  assert.deepEqual(result, { sent: 0 });
  assert.equal(delivered.length, 0);
});

test("fresh block after candidate scan suppresses the follow-up send", async () => {
  let checks = 0;
  const target = user();
  const delivered = [];
  const result = await runFollowUpCheck({
    store: withDeliveryClaims({
      async allUsers() { return [target]; },
      async getUser() { return target; },
      async isContactBlocked() { return ++checks > 1; }
    }),
    now: new Date("2026-10-02T00:00:00Z"),
    sendFollowUp: async (...args) => delivered.push(args)
  });
  assert.deepEqual(result, { sent: 0 });
  assert.equal(delivered.length, 0);
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
    async getUser(id) { return id === "contact-2" ? { ...target, id } : target; },
    async isContactBlocked(id) { if (id === "contact-2") throw new Error("lookup failed"); return false; },
    async claimFollowUpSend() { return true; },
    async finishFollowUpSend() { return true; }
  };
  await assert.rejects(runFollowUpCheck({ store: failureStore, now, sendFollowUp: async (...args) => sent.push(args) }), /lookup failed/);
  assert.equal(sent.length, 0, "all suppression lookups finish before the first send");
});

test("follow-up sends stay disabled when a fresh consent lookup is unavailable", async () => {
  const sent = [];
  const result = await runFollowUpCheck({
    store: { async allUsers() { return [user()]; }, async isContactBlocked() { return false; } },
    now: new Date("2026-10-02T00:00:00Z"),
    sendFollowUp: async (...args) => sent.push(args)
  });
  assert.deepEqual(result, { sent: 0, disabled: true, reason: "consent_check_unavailable" });
  assert.equal(sent.length, 0);
});

test("ambiguous provider failures are quarantined and never automatically retried", async () => {
  const target = user();
  const sent = [];
  const store = withDeliveryClaims({
    async allUsers() { return [target]; },
    async getUser() { return target; },
    async isContactBlocked() { return false; },
    async updateUser(_id, update) { update(target); },
    async addHistory(_id, message, response, metadata) { target.history.push({ id: "follow-up-result", message, response, ...metadata }); }
  });
  await runFollowUpCheck({
    store,
    now: new Date("2026-10-01T01:00:00Z"),
    sendFollowUp: async () => { sent.push("attempt"); throw new Error("provider timeout after acceptance"); }
  });
  const next = await runFollowUpCheck({ store, now: new Date("2026-10-01T02:00:00Z"), sendFollowUp: async () => sent.push("retry") });
  assert.deepEqual(next, { sent: 0 });
  assert.deepEqual(sent, ["attempt"]);
  assert.equal(store.deliveryStates.get("contact-1").outcome, "uncertain");
});

test("explicitly confirmed not-sent failures remain retryable", async () => {
  const target = user();
  const sent = [];
  const store = withDeliveryClaims({
    async allUsers() { return [target]; },
    async getUser() { return target; },
    async isContactBlocked() { return false; },
    async updateUser(_id, update) { update(target); },
    async addHistory(_id, message, response, metadata) { target.history.push({ id: "follow-up-result", message, response, ...metadata }); }
  });
  await runFollowUpCheck({
    store,
    now: new Date("2026-10-01T01:00:00Z"),
    sendFollowUp: async () => { const error = new Error("rejected before delivery"); error.definitelyNotSent = true; throw error; }
  });
  await runFollowUpCheck({ store, now: new Date("2026-10-01T02:00:00Z"), sendFollowUp: async () => { sent.push("delivered"); } });
  assert.deepEqual(sent, ["delivered"]);
  assert.equal(store.deliveryStates.get("contact-1").outcome, "sent");
});

test("provider acceptance with an unconfirmed durable finalization is reported for operator reconciliation", async () => {
  const target = user();
  const sent = [];
  const events = [];
  let finishCalls = 0;
  const store = {
    async allUsers() { return [target]; },
    async getUser() { return target; },
    async isContactBlocked() { return false; },
    async claimFollowUpSend() { return true; },
    async finishFollowUpSend() { finishCalls += 1; return false; },
    async updateUser(_id, update) { update(target); },
    async addHistory(_id, message, response, metadata) { target.history.push({ id: "follow-up-result", message, response, ...metadata }); }
  };

  const result = await runFollowUpCheck({
    store,
    now: new Date("2026-10-01T01:00:00Z"),
    sendFollowUp: async (...args) => { sent.push(args); return { key: { id: "provider-accepted-1" } }; },
    logEvent: (event, fields) => events.push({ event, fields })
  });

  assert.deepEqual(result, { sent: 1, deliveryStateUnconfirmed: 1 });
  assert.equal(sent.length, 1, "provider acceptance is counted once");
  assert.equal(finishCalls, 1);
  assert.equal(target.lastFollowUpSent, "2026-10-01T01:00:00.000Z");
  assert.equal(target.history.at(-1).source, "auto-follow-up");
  assert.deepEqual(events.map(({ event }) => event), ["follow_up_delivery_state_unconfirmed", "follow_up_sent"]);
  assert.deepEqual(events[0].fields, { outcome: "sent" });
});
