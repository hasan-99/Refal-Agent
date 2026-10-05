// REFAL-AGENT-009 — tool-level tests for the Agent booking tools.
//
// Calendar stubbing follows src/booking.test.js's existing convention
// (replace `google.calendar`, restore it in `t.after`) rather than inventing a
// second mocking style.

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { google } = require("googleapis");
const { getBookingAvailability, requestBookingAction, deriveIdempotencyKey, __resetBookingToolState } = require("./agentBookingTools");

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

// Thursday 09:00 Cyprus; the slot below is the following Monday 10:00 Cyprus,
// comfortably inside the window and past the 24h notice.
const NOW = new Date("2026-10-01T06:00:00.000Z");
const SLOT = { start: "2026-10-05T07:00:00.000Z", end: "2026-10-05T07:30:00.000Z" };
const OTHER_SLOT = { start: "2026-10-05T07:30:00.000Z", end: "2026-10-05T08:00:00.000Z" };

function resetCalendarEnv(t, configured = true) {
  const keys = ["GOOGLE_CALENDAR_CLIENT_ID", "GOOGLE_CALENDAR_CLIENT_SECRET", "GOOGLE_CALENDAR_REFRESH_TOKEN", "GOOGLE_CALENDAR_CLIENT_EMAIL", "GOOGLE_CALENDAR_PRIVATE_KEY"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) process.env[key] = configured ? `test-${key.toLowerCase()}` : "";
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function freshToolState(t) {
  __resetBookingToolState();
  t.after(() => __resetBookingToolState());
}

function makeUser(id = "35799111222@c.us") {
  return { id, phone: id.replace(/@.+$/, ""), profile: { name: "Test" }, booking: null };
}

// A calendar double whose free/busy answers are derived from the events that
// have actually been inserted — the same approach the existing
// "concurrent admin approvals" test in booking.test.js uses — plus a real
// await between the read and the write so two unserialized callers WOULD
// interleave.
function installCalendarDouble(t, { insert, delayTicks = 1 } = {}) {
  const originalCalendar = google.calendar;
  const state = { events: [], freebusyCalls: 0, insertCalls: 0 };
  google.calendar = () => ({
    freebusy: {
      query: async ({ requestBody }) => {
        state.freebusyCalls += 1;
        // A remote free/busy query answers from the calendar's state at the
        // moment the request is RECEIVED, and the answer arrives later. The
        // snapshot is therefore taken before the delay, not after — otherwise
        // the double would silently hide exactly the race this is testing (a
        // caller that read "free" before a competing write landed).
        const windowStart = Date.parse(requestBody.timeMin);
        const windowEnd = Date.parse(requestBody.timeMax);
        const busy = state.events
          .filter((event) => Date.parse(event.start.dateTime) < windowEnd && Date.parse(event.end.dateTime) > windowStart)
          .map((event) => ({ start: event.start.dateTime, end: event.end.dateTime }));
        for (let tick = 0; tick < delayTicks; tick += 1) await new Promise((resolve) => setImmediate(resolve));
        return { data: { calendars: { primary: { busy } } } };
      }
    },
    events: {
      insert: async (params) => {
        state.insertCalls += 1;
        if (insert) return insert(params, state);
        state.events.push(params.requestBody);
        return { data: { ...params.requestBody, id: params.requestBody.id, htmlLink: "https://calendar.google.com/calendar/event?id=test", hangoutLink: "https://meet.google.com/abc-defg-hij" } };
      }
    }
  });
  t.after(() => { google.calendar = originalCalendar; });
  return state;
}

// A store double that confirms immediately (status "confirmed" with no event
// yet), which is the legacy branch that actually writes to the calendar.
function makeConfirmingStore() {
  const calls = { created: [], updated: [] };
  let sequence = 0;
  return {
    calls,
    getBookingPolicy: async () => completePolicy,
    createAppointment: async (value) => {
      calls.created.push(value);
      sequence += 1;
      return { appointment: { id: `1111111${sequence}-1111-4111-8111-11111111111${sequence}`, status: "confirmed" }, created: true };
    },
    updateAppointment: async (id, patch) => {
      calls.updated.push({ id, patch });
      return { id, ...patch };
    }
  };
}

test("getBookingAvailability reports an already-busy slot as unavailable, not as an error", async (t) => {
  resetCalendarEnv(t);
  freshToolState(t);
  const calendar = installCalendarDouble(t, { delayTicks: 0 });
  calendar.events.push({ start: { dateTime: SLOT.start }, end: { dateTime: SLOT.end } });

  const result = await getBookingAvailability(SLOT, { policy: completePolicy, now: NOW });

  assert.equal(result.ok, true);
  assert.equal(result.status, "unavailable");
  assert.equal(result.data.start, SLOT.start);
});

test("getBookingAvailability reports a free slot as available and never writes", async (t) => {
  resetCalendarEnv(t);
  freshToolState(t);
  const calendar = installCalendarDouble(t, { delayTicks: 0 });

  const result = await getBookingAvailability(SLOT, { policy: completePolicy, now: NOW });

  assert.equal(result.ok, true);
  assert.equal(result.status, "available");
  assert.equal(calendar.insertCalls, 0);
});

test("getBookingAvailability rejects an out-of-window slot deterministically, without asking the calendar", async (t) => {
  resetCalendarEnv(t);
  freshToolState(t);
  const calendar = installCalendarDouble(t, { delayTicks: 0 });

  // 06:00 Cyprus on the Monday: inside the notice period but before 08:30.
  const tooEarly = await getBookingAvailability({ start: "2026-10-05T03:00:00.000Z" }, { policy: completePolicy, now: NOW });
  assert.equal(tooEarly.ok, true);
  assert.equal(tooEarly.status, "invalid_window");
  assert.equal(tooEarly.data.reason, "hours");

  // Later today: inside business hours but inside the 24h notice period.
  const tooSoon = await getBookingAvailability({ start: "2026-10-01T07:00:00.000Z" }, { policy: completePolicy, now: NOW });
  assert.equal(tooSoon.status, "invalid_window");
  assert.equal(tooSoon.data.reason, "notice");
  assert.equal(calendar.freebusyCalls, 0, "an invalid window must be settled in code, not by a calendar round trip");
});

test("getBookingAvailability with no slot returns suggested times formatted by the existing deterministic formatter", async (t) => {
  resetCalendarEnv(t);
  freshToolState(t);
  installCalendarDouble(t, { delayTicks: 0 });

  const result = await getBookingAvailability({}, { policy: completePolicy, now: NOW, language: "english" });

  assert.equal(result.ok, true);
  assert.equal(result.status, "suggestions");
  assert.ok(result.data.length > 0 && result.data.length <= 3);
  assert.equal(result.userSafeSummary.length, result.data.length);
  assert.match(result.userSafeSummary[0], /\d{2}:\d{2}/);
});

test("a calendar-access failure is a system error, clearly distinct from an unavailable slot", async (t) => {
  resetCalendarEnv(t);
  freshToolState(t);
  const originalCalendar = google.calendar;
  google.calendar = () => ({ freebusy: { query: async () => { throw new Error("invalid_grant"); } } });
  t.after(() => { google.calendar = originalCalendar; });

  const result = await getBookingAvailability(SLOT, { policy: completePolicy, now: NOW });

  assert.equal(result.ok, false);
  assert.equal(result.status, "error");
  assert.equal(result.reasonCode, "CALENDAR_UNAVAILABLE");
});

test("two simultaneous requests for the IDENTICAL slot serialize: exactly one is confirmed, the other is told the slot is gone", async (t) => {
  resetCalendarEnv(t);
  freshToolState(t);
  const calendar = installCalendarDouble(t);
  const store = makeConfirmingStore();

  // Both callers read availability before either writes, unless the per-slot
  // lock really serializes them: the stubbed free/busy query awaits a macrotask
  // between being called and answering, so an unlocked implementation
  // interleaves and both see a free slot. (Verified by temporarily removing
  // the lock while developing this test: it then produced two confirmations
  // and two calendar events.)
  const [first, second] = await Promise.all([
    requestBookingAction({ ...SLOT, purpose: "Visa discussion" }, {
      store, user: makeUser("35799111222@c.us"), userId: "35799111222@c.us",
      inboundMessageId: "wa-msg-A", policy: completePolicy, now: NOW
    }),
    requestBookingAction({ ...SLOT, purpose: "Visa discussion" }, {
      store, user: makeUser("35799333444@c.us"), userId: "35799333444@c.us",
      inboundMessageId: "wa-msg-B", policy: completePolicy, now: NOW
    })
  ]);

  const outcomes = [first, second];
  const confirmed = outcomes.filter((result) => result.ok && result.status === "confirmed");
  const rejected = outcomes.filter((result) => !result.ok && result.reasonCode === "SLOT_NO_LONGER_AVAILABLE");

  assert.equal(confirmed.length, 1, JSON.stringify(outcomes));
  assert.equal(rejected.length, 1, JSON.stringify(outcomes));
  assert.equal(calendar.insertCalls, 1, "exactly one real calendar event may exist for one slot");
  assert.equal(store.calls.created.length, 1, "the losing request must not create an appointment row either");
  assert.equal(confirmed[0].status, "confirmed");
  assert.match(confirmed[0].userSafeSummary, /Confirmed\. Your meeting is booked for/);
});

test("two simultaneous requests for DIFFERENT slots are not serialized against each other and both succeed", async (t) => {
  resetCalendarEnv(t);
  freshToolState(t);
  const calendar = installCalendarDouble(t);
  const store = makeConfirmingStore();
  const user = makeUser();

  const [first, second] = await Promise.all([
    requestBookingAction({ ...SLOT, purpose: "Visa discussion" }, { store, user, userId: user.id, inboundMessageId: "wa-msg-C", policy: completePolicy, now: NOW }),
    requestBookingAction({ ...OTHER_SLOT, purpose: "Company formation" }, { store, user, userId: user.id, inboundMessageId: "wa-msg-D", policy: completePolicy, now: NOW })
  ]);

  assert.equal(first.status, "confirmed");
  assert.equal(second.status, "confirmed");
  assert.equal(calendar.insertCalls, 2);
});

test("a duplicate WhatsApp delivery of the same message never produces a second appointment", async (t) => {
  resetCalendarEnv(t);
  freshToolState(t);
  installCalendarDouble(t, { delayTicks: 0 });
  const store = makeConfirmingStore();
  const user = makeUser();
  const context = { store, user, userId: user.id, inboundMessageId: "wa-msg-DUPLICATE", policy: completePolicy, now: NOW };

  const first = await requestBookingAction({ ...SLOT, purpose: "Visa discussion" }, context);
  const second = await requestBookingAction({ ...SLOT, purpose: "Visa discussion" }, context);

  assert.equal(first.status, "confirmed");
  // The in-process fast path short-circuits the second call entirely.
  assert.deepEqual(second, first);
  assert.equal(store.calls.created.length, 1);
  assert.match(store.calls.created[0].idempotencyKey, /^agent-booking:[0-9a-f]{40}$/);
});

test("the authoritative duplicate protection is the stable key reaching the store, not this process's cache", async (t) => {
  resetCalendarEnv(t);
  freshToolState(t);
  installCalendarDouble(t, { delayTicks: 0 });
  // A review-gated store leaves the calendar untouched, so the retry below is
  // decided by the idempotency key alone rather than by its own event.
  const created = [];
  const store = {
    getBookingPolicy: async () => completePolicy,
    createAppointment: async (value) => { created.push(value); return { appointment: { id: "33333333-3333-4333-8333-333333333333", status: "pending_review" } }; },
    updateAppointment: async (id, patch) => ({ id, ...patch })
  };
  const user = makeUser();
  const context = { store, user, userId: user.id, inboundMessageId: "wa-msg-RETRY", policy: completePolicy, now: NOW };

  const first = await requestBookingAction({ ...SLOT, purpose: "Visa discussion" }, context);
  // Simulate a second bot instance / a restarted process: no shared cache.
  __resetBookingToolState();
  const second = await requestBookingAction({ ...SLOT, purpose: "Visa discussion" }, context);

  assert.equal(created.length, 2, "without the in-process cache the store is reached twice — by design");
  assert.equal(created[1].idempotencyKey, created[0].idempotencyKey, "the same WhatsApp message must derive the same key, so the store's unique constraint collapses the duplicate");
  assert.match(created[0].idempotencyKey, /^agent-booking:[0-9a-f]{40}$/);
  assert.deepEqual(second, first);
});

test("the derived idempotency key is stable per message+slot, differs per message, and cannot collide with a legacy random key", () => {
  const keyA = deriveIdempotencyKey("wa-msg-1", "primary|2026-10-05T07:00:00.000Z|2026-10-05T07:30:00.000Z");
  const keyAgain = deriveIdempotencyKey("wa-msg-1", "primary|2026-10-05T07:00:00.000Z|2026-10-05T07:30:00.000Z");
  const keyB = deriveIdempotencyKey("wa-msg-2", "primary|2026-10-05T07:00:00.000Z|2026-10-05T07:30:00.000Z");

  assert.equal(keyA, keyAgain);
  assert.notEqual(keyA, keyB);
  assert.match(keyA, /^agent-booking:/);
  assert.ok(keyA.length <= 200);
});

test("a calendar write failure after availability passed is never reported as a booking", async (t) => {
  resetCalendarEnv(t);
  freshToolState(t);
  const calendar = installCalendarDouble(t, {
    delayTicks: 0,
    insert: () => { throw new Error("Google Calendar is unavailable"); }
  });
  const store = makeConfirmingStore();
  const user = makeUser();

  const result = await requestBookingAction({ ...SLOT, purpose: "Visa discussion" }, {
    store, user, userId: user.id, inboundMessageId: "wa-msg-CALENDAR-DOWN", policy: completePolicy, now: NOW
  });

  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, "CALENDAR_UNAVAILABLE");
  assert.equal(result.requiresReconciliation, true);
  assert.equal(result.userSafeSummary, undefined, "a failed booking must never carry confirmation wording");
  assert.equal(calendar.insertCalls, 1);
  // The failure must not be cached as a success: a retry has to be able to run.
  assert.equal(store.calls.updated.length, 0);
});

test("a store that routes customer requests to administrator review is respected — pending_review is not a confirmation", async (t) => {
  resetCalendarEnv(t);
  freshToolState(t);
  const calendar = installCalendarDouble(t, { delayTicks: 0 });
  const updates = [];
  const store = {
    getBookingPolicy: async () => completePolicy,
    createAppointment: async () => ({ appointment: { id: "22222222-2222-4222-8222-222222222222", status: "pending_calendar" } }),
    updateAppointment: async (id, patch) => { updates.push(patch); return { id, ...patch }; }
  };
  const user = makeUser();

  const result = await requestBookingAction({ ...SLOT, purpose: "Visa discussion" }, {
    store, user, userId: user.id, inboundMessageId: "wa-msg-REVIEW", policy: completePolicy, now: NOW
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "pending_review");
  assert.equal(result.data.requiresAdminApproval, true);
  assert.equal(result.userSafeSummary, undefined, "an appointment awaiting admin review is not a booked meeting");
  assert.deepEqual(updates, [{ status: "pending_review" }]);
  assert.equal(calendar.insertCalls, 0, "the admin-review gate must not be bypassed by writing the event anyway");
});

test("a slot that became busy before the write is refused, and nothing is persisted", async (t) => {
  resetCalendarEnv(t);
  freshToolState(t);
  const calendar = installCalendarDouble(t, { delayTicks: 0 });
  calendar.events.push({ start: { dateTime: SLOT.start }, end: { dateTime: SLOT.end } });
  const store = makeConfirmingStore();
  const user = makeUser();

  const result = await requestBookingAction({ ...SLOT, purpose: "Visa discussion" }, {
    store, user, userId: user.id, inboundMessageId: "wa-msg-BUSY", policy: completePolicy, now: NOW
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "unavailable");
  assert.equal(result.reasonCode, "SLOT_NO_LONGER_AVAILABLE");
  assert.equal(store.calls.created.length, 0);
});

test("requestBookingAction never trusts the Agent's view of the window, the duration, or its own inputs", async (t) => {
  resetCalendarEnv(t);
  freshToolState(t);
  const calendar = installCalendarDouble(t, { delayTicks: 0 });
  const store = makeConfirmingStore();
  const user = makeUser();
  const base = { store, user, userId: user.id, inboundMessageId: "wa-msg-GUARDS", policy: completePolicy, now: NOW };

  const outOfHours = await requestBookingAction({ start: "2026-10-05T03:00:00.000Z", purpose: "Visa" }, base);
  assert.equal(outOfHours.status, "invalid_window");
  assert.equal(outOfHours.reasonCode, "OUTSIDE_BUSINESS_HOURS");

  const tooSoon = await requestBookingAction({ start: "2026-10-01T07:00:00.000Z", purpose: "Visa" }, base);
  assert.equal(tooSoon.reasonCode, "OUTSIDE_NOTICE_WINDOW");

  // The policy owns the meeting length; an Agent-chosen end is not accepted.
  const wrongDuration = await requestBookingAction({ start: SLOT.start, end: "2026-10-05T09:00:00.000Z", purpose: "Visa" }, base);
  assert.equal(wrongDuration.reasonCode, "INVALID_SLOT");

  assert.equal((await requestBookingAction({ start: "not a date", purpose: "Visa" }, base)).reasonCode, "INVALID_SLOT");
  assert.equal((await requestBookingAction({ ...SLOT }, base)).reasonCode, "PURPOSE_REQUIRED");
  assert.equal((await requestBookingAction({ ...SLOT, purpose: "Visa" }, { ...base, inboundMessageId: "" })).reasonCode, "INBOUND_MESSAGE_ID_REQUIRED");
  assert.equal((await requestBookingAction({ ...SLOT, purpose: "Visa" }, { ...base, user: null })).reasonCode, "CUSTOMER_NOT_LOADED");
  assert.equal((await requestBookingAction({ ...SLOT, purpose: "Visa" }, { ...base, store: {} })).reasonCode, "STORE_UNAVAILABLE");

  assert.equal(store.calls.created.length, 0);
  assert.equal(calendar.insertCalls, 0);
});

test("the Arabic confirmation uses the existing deterministic formatter, not model-invented wording", async (t) => {
  resetCalendarEnv(t);
  freshToolState(t);
  installCalendarDouble(t, { delayTicks: 0 });
  const store = makeConfirmingStore();
  const user = makeUser();

  const result = await requestBookingAction({ ...SLOT, purpose: "مناقشة الفيزا" }, {
    store, user, userId: user.id, inboundMessageId: "wa-msg-AR", policy: completePolicy, now: NOW, language: "arabic"
  });

  assert.equal(result.status, "confirmed");
  assert.match(result.userSafeSummary, /^تم تأكيد الموعد: /);
  assert.match(result.userSafeSummary, /https:\/\/meet\.google\.com\//);
});
