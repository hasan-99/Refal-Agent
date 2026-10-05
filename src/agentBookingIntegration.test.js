// REFAL-AGENT-009 — booking tool integration.
//
// Same shape as agentHandoverIntegration.test.js (Ticket 008): the REAL
// TOOL_REGISTRY and the REAL runAgentTurn wired together, proving that what
// the booking tool actually reported — not what the model asserts — decides
// what a customer can be told.
//
// Nothing here is wired to live traffic (Tickets 010/017). Until a caller
// explicitly passes `allowVerifiedBookingClaim: true` after a real persisted
// success, EVERY claim that a meeting is booked is blocked by the
// deterministic output gate, including the ones built on top of a genuinely
// confirmed tool result.

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { google } = require("googleapis");
const { runAgentTurn } = require("./agentLoop");
const { TOOL_REGISTRY } = require("./agentTools");
const { __resetBookingToolState } = require("./agentBookingTools");
const { validateResponse } = require("./responsePolicy");

const completePolicy = {
  timezone: "Europe/Nicosia",
  calendarId: "primary",
  weekdays: [1, 2, 3, 4, 5],
  startTime: "08:30",
  endTime: "11:00",
  durationMinutes: 30,
  durationOwnerConfirmed: true,
  minimumNoticeHours: 24,
  reminderHours: [12],
  createMeetLink: true
};

const NOW = new Date("2026-10-01T06:00:00.000Z");
const SLOT = { start: "2026-10-05T07:00:00.000Z", end: "2026-10-05T07:30:00.000Z" };
const CONTEXT = { currentMessage: "Can we meet on Monday at 10:00?", locale: "english" };

function scriptedDecider(decisions) {
  let index = 0;
  return async () => decisions[Math.min(index++, decisions.length - 1)];
}

function resetCalendarEnv(t) {
  const keys = ["GOOGLE_CALENDAR_CLIENT_ID", "GOOGLE_CALENDAR_CLIENT_SECRET", "GOOGLE_CALENDAR_REFRESH_TOKEN", "GOOGLE_CALENDAR_CLIENT_EMAIL", "GOOGLE_CALENDAR_PRIVATE_KEY"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) process.env[key] = `test-${key.toLowerCase()}`;
  __resetBookingToolState();
  t.after(() => {
    __resetBookingToolState();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function installCalendar(t, { busy = [], insert } = {}) {
  const originalCalendar = google.calendar;
  const state = { insertCalls: 0 };
  google.calendar = () => ({
    freebusy: { query: async () => ({ data: { calendars: { primary: { busy } } } }) },
    events: {
      insert: async (params) => {
        state.insertCalls += 1;
        if (insert) return insert(params);
        return { data: { ...params.requestBody, id: params.requestBody.id, htmlLink: "https://calendar.google.com/calendar/event?id=test", hangoutLink: "https://meet.google.com/abc-defg-hij" } };
      }
    }
  });
  t.after(() => { google.calendar = originalCalendar; });
  return state;
}

function makeUser() {
  return { id: "35799111222@c.us", phone: "35799111222", profile: { name: "Test" }, booking: null };
}

function bookingToolContext(store, extra = {}) {
  const user = makeUser();
  return { store, user, userId: user.id, policy: completePolicy, now: NOW, inboundMessageId: "wa-msg-integration", language: "english", ...extra };
}

const confirmingStore = () => ({
  getBookingPolicy: async () => completePolicy,
  createAppointment: async () => ({ appointment: { id: "11111111-1111-4111-8111-111111111111", status: "confirmed" } }),
  updateAppointment: async (id, patch) => ({ id, ...patch })
});

test("a completed-booking claim with no booking tool call at all is rejected, never delivered", async (t) => {
  resetCalendarEnv(t);
  const decide = scriptedDecider([
    { type: "respond", text: "Your appointment is booked for Monday at 10:00. See you then." }
  ]);

  const result = await runAgentTurn(CONTEXT, { decideNextStep: decide, tools: TOOL_REGISTRY, toolContext: bookingToolContext(confirmingStore()), maxSteps: 1 });

  assert.deepEqual(result.toolsUsed, []);
  assert.notEqual(result.outcome, "responded");
  assert.notEqual(result.response, "Your appointment is booked for Monday at 10:00. See you then.");
  assert.equal(result.reason, "unverified_booking_action");
});

test("when the calendar write fails after availability passed, a 'your appointment is confirmed' draft in the same turn is rejected", async (t) => {
  resetCalendarEnv(t);
  installCalendar(t, { insert: () => { throw new Error("Google Calendar is unavailable"); } });
  const decide = scriptedDecider([
    { type: "tool", tool: "requestBookingAction", args: { ...SLOT, purpose: "Visa discussion" } },
    { type: "respond", text: "Your appointment is confirmed for Monday at 10:00. I look forward to it." }
  ]);

  const result = await runAgentTurn(CONTEXT, { decideNextStep: decide, tools: TOOL_REGISTRY, toolContext: bookingToolContext(confirmingStore()), maxSteps: 2 });

  assert.equal(result.steps[0].tool, "requestBookingAction");
  assert.equal(result.steps[0].result.ok, false);
  assert.equal(result.steps[0].result.reasonCode, "CALENDAR_UNAVAILABLE");
  assert.notEqual(result.outcome, "responded");
  assert.notEqual(result.response, "Your appointment is confirmed for Monday at 10:00. I look forward to it.");
});

test("even a genuinely confirmed booking cannot be claimed by the Agent yet — only a caller that passes allowVerifiedBookingClaim may deliver that wording", async (t) => {
  resetCalendarEnv(t);
  installCalendar(t);
  const decide = scriptedDecider([
    { type: "tool", tool: "requestBookingAction", args: { ...SLOT, purpose: "Visa discussion" } },
    { type: "respond", text: "Great news, your meeting is booked for Monday at 10:00." }
  ]);

  const result = await runAgentTurn(CONTEXT, { decideNextStep: decide, tools: TOOL_REGISTRY, toolContext: bookingToolContext(confirmingStore()), maxSteps: 2 });

  assert.equal(result.steps[0].result.ok, true);
  assert.equal(result.steps[0].result.status, "confirmed");
  assert.notEqual(result.response, "Great news, your meeting is booked for Monday at 10:00.");

  // The deterministic confirmation text the tool itself produced is the only
  // wording that should ever be sent, and only by the (future) caller that
  // proves the booking — which is exactly what the gate's option models.
  const deterministic = result.steps[0].result.userSafeSummary;
  assert.match(deterministic, /^Confirmed\. Your meeting is booked for /);
  assert.ok(validateResponse(deterministic, { minSentences: 0 }).reasons.includes("unverified_booking_action"));
  assert.equal(validateResponse(deterministic, { minSentences: 0, allowVerifiedBookingClaim: true }).valid, true);
});

test("an appointment that only reached administrator review cannot be described as booked, but the honest wording is allowed through", async (t) => {
  resetCalendarEnv(t);
  const calendar = installCalendar(t);
  const reviewStore = {
    getBookingPolicy: async () => completePolicy,
    createAppointment: async () => ({ appointment: { id: "22222222-2222-4222-8222-222222222222", status: "pending_review" } }),
    updateAppointment: async (id, patch) => ({ id, ...patch })
  };
  const decide = scriptedDecider([
    { type: "tool", tool: "requestBookingAction", args: { ...SLOT, purpose: "Visa discussion" } },
    { type: "respond", text: "You're confirmed for Monday at 10:00." },
    { type: "respond", text: "Your appointment request has been sent to the team for review. The details follow once it is approved." }
  ]);

  const result = await runAgentTurn(CONTEXT, { decideNextStep: decide, tools: TOOL_REGISTRY, toolContext: bookingToolContext(reviewStore), maxSteps: 4 });

  assert.equal(result.steps[0].result.status, "pending_review");
  assert.equal(result.steps[0].result.userSafeSummary, undefined);
  assert.equal(calendar.insertCalls, 0);
  // The rejected claim is fed back as an observation and the honest second
  // draft is delivered (Ticket 005's correct-and-retry behavior).
  assert.equal(result.outcome, "responded");
  assert.equal(result.response, "Your appointment request has been sent to the team for review. The details follow once it is approved.");
});

test("getBookingAvailability is reachable from the real loop and an unavailable slot is reported as a normal answer, not an error", async (t) => {
  resetCalendarEnv(t);
  installCalendar(t, { busy: [{ start: SLOT.start, end: SLOT.end }] });
  const decide = scriptedDecider([
    { type: "tool", tool: "getBookingAvailability", args: { start: SLOT.start } },
    { type: "respond", text: "That time is already taken. Would another morning this week suit you?" }
  ]);

  const result = await runAgentTurn(CONTEXT, { decideNextStep: decide, tools: TOOL_REGISTRY, toolContext: bookingToolContext(confirmingStore()), maxSteps: 2 });

  assert.equal(result.steps[0].result.ok, true);
  assert.equal(result.steps[0].result.status, "unavailable");
  assert.equal(result.outcome, "responded");
  assert.equal(result.response, "That time is already taken. Would another morning this week suit you?");
});

test("requestBookingAction writes nothing when the Agent calls it without the inbound message id the dedup layer provides", async (t) => {
  resetCalendarEnv(t);
  const calendar = installCalendar(t);
  let created = 0;
  const store = {
    getBookingPolicy: async () => completePolicy,
    createAppointment: async () => { created += 1; return { appointment: { id: "x", status: "confirmed" } }; },
    updateAppointment: async (id, patch) => ({ id, ...patch })
  };
  const decide = scriptedDecider([{ type: "tool", tool: "requestBookingAction", args: { ...SLOT, purpose: "Visa discussion" } }]);

  const result = await runAgentTurn(CONTEXT, { decideNextStep: decide, tools: TOOL_REGISTRY, toolContext: bookingToolContext(store, { inboundMessageId: null }), maxSteps: 1 });

  assert.equal(result.steps[0].result.reasonCode, "INBOUND_MESSAGE_ID_REQUIRED");
  assert.equal(created, 0);
  assert.equal(calendar.insertCalls, 0);
});
