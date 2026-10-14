const assert = require("node:assert/strict");
const { test } = require("node:test");
const { google } = require("googleapis");
const { appointmentChangeIntent, approvePendingAppointment, appointmentWindowIssue, changeAppointmentStatus, extractBookingNameReply, formatBookingTime, handleBookingMessage, hasCalendarConfig, isBookingRequest, parseBookingDetails, verifyCalendarAccess } = require("./booking.js");

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

function resetCalendarEnv(t, configured) {
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

function makeStore(policy, initialUser = { profile: {}, booking: null }) {
  const calls = { updates: 0, appointments: 0 };
  const user = structuredClone(initialUser);
  let appointment = null;
  return {
    calls,
    ensureUser: async () => user,
    getBookingPolicy: async () => policy,
    updateUser: async (_id, update) => { calls.updates += 1; update(user); return user; },
    createAppointment: async (value) => { calls.appointments += 1; appointment = { id: "11111111-1111-4111-8111-111111111111", status: value.status, ...value }; return { appointment }; },
    updateAppointment: async (_id, patch) => { appointment = { ...appointment, ...patch, status: patch.status || appointment.status }; return appointment; },
    getAppointment: async () => appointment
  };
}

test("booking intent recognizes natural English and Arabic requests without treating process questions as bookings", () => {
  for (const message of [
    "Could we meet next Thursday?",
    "Please set up a call next week",
    "I'd like an appointment on Tuesday",
    "Are you available for a meeting tomorrow?",
    "Is tomorrow at 10 available?",
    "ممكن ترتيب موعد الخميس",
    "أريد اجتماع يوم الخميس",
    "بكرا الساعة ١٠ الصبح في موعد متاح؟"
  ]) assert.equal(isBookingRequest(message), true, message);

  for (const message of [
    "How does Refalco Group schedule meetings?",
    "Does RAFA book appointments?",
    "Can you tell me about Refalco Group's meetings?",
    "بدي أعرف بشكل عام شو خدماتكم، وما بدي احجز موعد حالياً.",
    "I want to know your services, but I don't want to book a meeting yet."
  ]) assert.equal(isBookingRequest(message), false, message);
});

test("specific Arabic time inquiry retains the slot, collects only missing details, then queues team review", async (t) => {
  resetCalendarEnv(t, false);
  const userId = "35799111222@s.whatsapp.net";
  const user = { id: userId, phone: "35799111222", profile: {}, booking: null };
  const store = makeStore(completePolicy, user);
  const now = new Date("2026-10-13T12:00:00.000Z");

  const availability = await handleBookingMessage({ userId, text: "الخميس الساعة ١٠ الصبح في موعد متاح؟", store, now });
  assert.match(availability.response, /السبب المختصر للاجتماع/u);
  assert.equal((await store.ensureUser()).booking.status, "awaiting_details");
  assert.equal((await store.ensureUser()).booking.selectedSlot.start, "2026-10-15T07:00:00.000Z");
  assert.equal(store.calls.appointments, 0);

  const purpose = await handleBookingMessage({ userId, text: "مناقشة تأسيس شركتي", store, now });
  assert.match(purpose.response, /الاسم/u);
  assert.equal((await store.ensureUser()).booking.purpose, "مناقشة تأسيس شركتي");
  assert.equal(store.calls.appointments, 0);

  const submitted = await handleBookingMessage({ userId, text: "حسن", store, now });
  assert.equal(submitted.appointment.status, "pending_review");
  assert.match(submitted.response, /للفريق/u);
  assert.doesNotMatch(submitted.response, /الموعد متاح/u);
  assert.equal((await store.ensureUser()).booking.status, "pending_review");
  assert.equal(submitted.appointment.metadata.appointmentDetails.name, "حسن");
  assert.equal(submitted.appointment.metadata.appointmentDetails.phone, "35799111222");
  assert.equal(submitted.appointment.metadata.appointmentDetails.topic, "مناقشة تأسيس شركتي");
  assert.equal(store.calls.appointments, 1);
});

test("specific next-morning requests inside the minimum-notice window do not create a dashboard request", async (t) => {
  resetCalendarEnv(t, false);
  const store = makeStore(completePolicy);
  const now = new Date("2026-10-13T14:49:00.000Z");
  const result = await handleBookingMessage({ userId: "35799111222@s.whatsapp.net", text: "بكرا الساعة ١٠ الصبح في موعد متاح؟", store, now });
  assert.match(result.response, /24 ساعة/u);
  assert.equal(store.calls.appointments, 0);
  assert.equal((await store.ensureUser()).booking, null);
});

test("Rafa acknowledges a booking customer's name naturally without saying it was saved", async (t) => {
  resetCalendarEnv(t, true);
  const user = { profile: {}, booking: { status: "awaiting_details", startedAt: new Date().toISOString() } };
  const store = makeStore(completePolicy, user);
  const result = await handleBookingMessage({ userId: "test-user", text: "Rami", store });
  assert.match(result.response, /Nice to meet you, Rami/i);
  assert.match(result.response, /tomorrow or a later working day/i);
  assert.doesNotMatch(result.response, /saved|stored|recorded/i);
  assert.equal(store.calls.updates, 1);
});

test("calendar access check requires runtime credentials and only performs a read-only free/busy query", async (t) => {
  resetCalendarEnv(t, false);
  await assert.rejects(verifyCalendarAccess(completePolicy), /credentials are not configured/);

  resetCalendarEnv(t, true);
  const originalCalendar = google.calendar;
  const checks = [];
  google.calendar = () => ({ freebusy: { query: async ({ requestBody }) => {
    checks.push(requestBody);
    return { data: { calendars: { primary: { busy: [] } } } };
  } } });
  t.after(() => { google.calendar = originalCalendar; });
  const now = new Date("2026-09-30T12:00:00.000Z");
  const result = await verifyCalendarAccess(completePolicy, now);

  assert.deepEqual(result, { calendarId: "primary", checkedAt: now.toISOString() });
  assert.deepEqual(checks[0].items, [{ id: "primary" }]);
  assert.equal(Date.parse(checks[0].timeMax) - Date.parse(checks[0].timeMin), 5 * 60 * 1000);
  assert.equal(checks[0].timeMin, "2026-09-30T12:01:00.000Z");
});

test("calendar access check reports missing or inaccessible calendar IDs", async (t) => {
  resetCalendarEnv(t, true);
  const originalCalendar = google.calendar;
  google.calendar = () => ({ freebusy: { query: async () => ({
    data: { calendars: { primary: { errors: [{ reason: "notFound" }] } } }
  }) } });
  t.after(() => { google.calendar = originalCalendar; });

  await assert.rejects(verifyCalendarAccess(completePolicy), /missing or not accessible/);
});

test("a booking request does not prefetch calendar availability before collecting details", async (t) => {
  resetCalendarEnv(t, true);
  const originalCalendar = google.calendar;
  const calendarCalls = [];
  google.calendar = () => ({ freebusy: { query: async () => { calendarCalls.push(true); throw new Error("invalid_grant"); } } });
  t.after(() => { google.calendar = originalCalendar; });
  const store = makeStore(completePolicy);

  const result = await handleBookingMessage({ userId: "test-user", text: "Could we book a meeting next Thursday?", store });

  assert.match(result.response, /tomorrow or a later working day/i);
  assert.doesNotMatch(result.response, /that time (?:is )?available/i);
  assert.equal((await store.ensureUser()).booking.calendarUnavailable, false);
  assert.equal(calendarCalls.length, 0);
  assert.equal(store.calls.updates, 1);
  assert.equal(store.calls.appointments, 0);
});

test("calendar configuration remains ready when optional Meet-link creation is disabled", (t) => {
  resetCalendarEnv(t, true);
  assert.equal(hasCalendarConfig({ ...completePolicy, createMeetLink: false }), true);
});

test("Greek customer can submit a preferred time for admin review without calendar prefetch", async (t) => {
  resetCalendarEnv(t, true);
  const originalCalendar = google.calendar;
  const calendarCalls = [];
  google.calendar = () => ({ freebusy: { query: async ({ requestBody }) => {
    calendarCalls.push(requestBody);
    throw new Error("calendar authorization unavailable");
  } } });
  t.after(() => { google.calendar = originalCalendar; });
  const policy = { ...completePolicy, startTime: "10:00", endTime: "15:00", createMeetLink: true };
  const user = { id: "35799111222@c.us", phone: "35799111222", profile: { name: "Test" }, booking: null };
  let persistedInput;
  const appointment = { id: "11111111-1111-4111-8111-111111111111", status: "pending_review", created_at: "2026-01-02T08:00:00.000Z", metadata: {} };
  const store = {
    ensureUser: async () => user,
    getBookingPolicy: async () => policy,
    updateUser: async (_id, update) => { update(user); return user; },
    createAppointment: async (value) => { persistedInput = value; Object.assign(appointment, { status: value.status, starts_at: value.startsAt, ends_at: value.endsAt, metadata: value.metadata }); return { appointment, created: true }; },
    updateAppointment: async (_id, patch) => { Object.assign(appointment, patch, { status: patch.status || appointment.status }); return appointment; }
  };
  const now = new Date("2026-01-02T08:00:00.000Z");

  const started = await handleBookingMessage({ userId: user.id, text: "Θέλω να κλείσω ένα ραντεβού", store, now });
  assert.match(started.response, /αύριο ή κάποια επόμενη εργάσιμη ημέρα/);
  const proposed = await handleBookingMessage({ userId: user.id, text: "Δευτέρα 5 Ιανουαρίου 2026 στις 11:00 για συζήτηση έργου", store, now });
  assert.match(proposed.response, /ομάδα/);
  assert.match(proposed.response, /δεν έχει επιβεβαιωθεί/);
  assert.doesNotMatch(proposed.response, /Βρήκα διαθέσιμη ώρα/);
  assert.equal(calendarCalls.length, 0, "the request path does not prefetch calendar availability");
  assert.equal(persistedInput.status, "pending_review", "the requested time is queued for admin review");
  assert.equal(appointment.status, "pending_review");
  assert.equal(persistedInput.metadata.availabilityVerified, false);
  assert.equal(persistedInput.startsAt, "2026-01-05T09:00:00.000Z");
  assert.equal(appointment.status, "pending_review");
});

test("booking stays unavailable and makes no state changes until required policy is complete", async (t) => {
  resetCalendarEnv(t, false);
  const store = makeStore({ ...completePolicy, durationMinutes: null, durationOwnerConfirmed: false, minimumNoticeHours: null, reminderHours: [] });

  const result = await handleBookingMessage({ userId: "test-user", text: "أريد حجز اجتماع", store });

  assert.match(result.response, /الحجز المباشر غير متاح/);
  assert.match(result.response, /https:\/\/calendar\.app\.google\//);
  assert.equal(result.event, null);
  assert.equal(store.calls.updates, 0);
  assert.equal(store.calls.appointments, 0);
});

test("ordinary chat does not make a booking-policy network request", async () => {
  let policyReads = 0;
  const store = makeStore(null);
  store.getBookingPolicy = async () => { policyReads += 1; throw new Error("Booking settings API unavailable"); };

  const result = await handleBookingMessage({ userId: "test-user", text: "What does Refalco Group do?", store });

  assert.equal(result, null);
  assert.equal(policyReads, 0);
});

test("Arabic service enquiries that explicitly defer a meeting never enter booking", async () => {
  const texts = [
    "بدي أعرف بشكل عام شو خدماتكم، وما بدي احجز موعد حالياً.",
    "مرحبا، شو خدماتكم؟",
    "أريد معرفة خدماتكم فقط ولا أرغب بحجز اجتماع الآن"
  ];
  for (const text of texts) {
    const store = makeStore(completePolicy);
    const result = await handleBookingMessage({ userId: "service-question", text, store });
    assert.equal(result, null, text);
    assert.equal(store.calls.updates, 0, text);
    assert.equal(store.calls.appointments, 0, text);
  }
});

test("a new company question is handled as normal chat during an unfinished booking flow", async () => {
  const store = makeStore(completePolicy, {
    profile: { name: "Sam" },
    booking: { status: "awaiting_confirmation", startedAt: new Date().toISOString(), start: "2026-10-06T08:00:00.000Z", end: "2026-10-06T08:30:00.000Z" }
  });
  const result = await handleBookingMessage({ userId: "test-user", text: "What services does Refalco Group offer?", store });
  assert.equal(result, null);
  assert.equal(store.calls.updates, 0);
  assert.equal(store.calls.appointments, 0);
});

test("a service question declining a meeting stays in chat during an unfinished booking flow", async () => {
  const store = makeStore(completePolicy, {
    profile: {},
    booking: { status: "awaiting_details", startedAt: new Date().toISOString() }
  });
  const text = "بدي أعرف بشكل عام شو خدماتكم، وما بدي احجز موعد حالياً.";
  assert.equal(await handleBookingMessage({ userId: "service-question", text, store }), null);
  assert.equal(store.calls.updates, 1);
  assert.equal((await store.ensureUser()).booking.interrupted, true);
  assert.equal(store.calls.appointments, 0);
});

test("an unfinished booking never captures a greeting or question as a name", async () => {
  for (const text of ["مرحبا، شو خدماتكم؟", "مرحبا، مين أنت وشو بتعمل؟", "What services do you offer?", "No need to", "I dont want"]) {
    assert.equal(extractBookingNameReply(text), null, text);
  }
  assert.equal(extractBookingNameReply("Mary Ann"), "Mary Ann");
  assert.equal(extractBookingNameReply("Rami"), "Rami");

  const store = makeStore(completePolicy, {
    profile: { name: "Saved Customer" },
    booking: { status: "awaiting_details", startedAt: new Date().toISOString() }
  });
  assert.equal(await handleBookingMessage({ userId: "existing-customer", text: "What is Refalco Group company?", store }), null);
  assert.equal(store.calls.updates, 1);
  assert.equal((await store.ensureUser()).booking.interrupted, true);
  assert.equal(store.calls.appointments, 0);
});

test("natural booking refusals clear only the stale draft in the visitor's language", async () => {
  for (const [text, pattern] of [
    ["No need to", /won’t continue with an appointment/i],
    ["I dont want", /won’t continue with an appointment/i],
    ["مش حابب احجز موعد", /لن أتابع طلب حجز موعد/],
    ["δεν θέλω ραντεβού", /δεν θα συνεχίσω.*ραντεβού/i]
  ]) {
    const store = makeStore(completePolicy, {
      profile: { name: "Saved Customer" },
      booking: { status: "awaiting_details", startedAt: new Date().toISOString() }
    });
    const result = await handleBookingMessage({ userId: "declining-customer", text, store });
    assert.match(result.response, pattern, text);
    assert.equal(store.ensureUser && (await store.ensureUser()).booking, null, text);
    assert.equal(store.calls.appointments, 0, text);
  }
});

test("stale unfinished booking state expires instead of confirming days later", async () => {
  const now = new Date("2026-10-10T10:00:00.000Z");
  const store = makeStore(completePolicy, {
    profile: { name: "Sam" },
    booking: { status: "awaiting_confirmation", startedAt: "2026-10-07T10:00:00.000Z", start: "2026-10-08T08:00:00.000Z", end: "2026-10-08T08:30:00.000Z" }
  });
  const result = await handleBookingMessage({ userId: "test-user", text: "yes", store, now });
  assert.equal(result, null);
  assert.equal(store.calls.updates, 1);
  assert.equal(store.calls.appointments, 0);
});

test("an hour-old unfinished details draft is cleared before unrelated conversation", async () => {
  const now = new Date("2026-10-10T10:00:00.000Z");
  const store = makeStore(completePolicy, {
    profile: { name: "Sam" },
    booking: { status: "awaiting_details", startedAt: "2026-10-10T06:30:00.000Z" }
  });
  const result = await handleBookingMessage({ userId: "test-user", text: "What services does Refalco Group offer?", store, now });
  assert.equal(result, null);
  assert.equal((await store.ensureUser()).booking, null);
  assert.equal(store.calls.appointments, 0);
});

test("Arabic booking dates honor weekday, relative-day, and Arabic-Indic time digits", () => {
  const now = new Date("2026-09-29T12:00:00.000Z");
  const policy = { ...completePolicy, durationMinutes: 30 };
  const weekday = parseBookingDetails("الثلاثاء الساعة 10:30 لمناقشة مشاريع الشركة", policy, now);
  const relative = parseBookingDetails("غداً الساعة 10:30 لمناقشة مشاريع الشركة", policy, now);
  const arabicDigits = parseBookingDetails("الأربعاء الساعة ١١:٠٠ لمناقشة مشاريع الشركة", policy, now);

  assert.equal(weekday.start.toISOString(), "2026-10-06T07:30:00.000Z");
  assert.equal(relative.start.toISOString(), "2026-09-30T07:30:00.000Z");
  assert.equal(arabicDigits.start.toISOString(), "2026-09-30T08:00:00.000Z");
  assert.equal(weekday.purpose, "لمناقشة مشاريع الشركة");
  assert.match(formatBookingTime(weekday.start, policy, "arabic"), /10:30 ص/);
});

test("an informational question during slot choice returns to chat and a later choice requires one resume confirmation", async () => {
  const now = new Date("2026-10-11T05:00:00.000Z");
  const store = makeStore(completePolicy, {
    profile: { name: "Sam" },
    booking: {
      status: "awaiting_slot_choice",
      startedAt: now.toISOString(),
      slotOptions: [
        { start: "2026-10-12T07:00:00.000Z", end: "2026-10-12T07:30:00.000Z" },
        { start: "2026-10-12T07:30:00.000Z", end: "2026-10-12T08:00:00.000Z" }
      ]
    }
  });

  const question = await handleBookingMessage({ userId: "slot-topic-switch", text: "What services do you offer?", store, now });
  assert.equal(question, null);
  assert.equal((await store.ensureUser()).booking.status, "awaiting_slot_choice");
  assert.equal((await store.ensureUser()).booking.interrupted, true);

  const laterChoice = await handleBookingMessage({ userId: "slot-topic-switch", text: "2", store, now });
  assert.match(laterChoice.response, /resume the earlier appointment request/i);
  assert.equal((await store.ensureUser()).booking.pendingSlotChoice, "2");

  const followupQuestion = await handleBookingMessage({ userId: "slot-topic-switch", text: "What documents do I need?", store, now });
  assert.equal(followupQuestion, null);
  assert.equal((await store.ensureUser()).booking.status, "awaiting_slot_choice");
  assert.equal((await store.ensureUser()).booking.pendingSlotChoice, "2");

  const resumed = await handleBookingMessage({ userId: "slot-topic-switch", text: "yes", store, now });
  assert.match(resumed.response, /brief purpose/i);
  assert.equal((await store.ensureUser()).booking.status, "awaiting_details");
  assert.equal((await store.ensureUser()).booking.selectedSlot.start, "2026-10-12T07:30:00.000Z");
});

test("Greek weekdays, relative dates, and month names parse in Cyprus local time", () => {
  const now = new Date("2026-01-02T08:00:00.000Z");
  const policy = { ...completePolicy, durationMinutes: 30 };
  const weekday = parseBookingDetails("Δευτέρα 5 Ιανουαρίου 2026 στις 10:00 για συζήτηση", policy, now);
  const relative = parseBookingDetails("αύριο στις 10:00 για συνάντηση", policy, now);
  assert.equal(weekday.start.toISOString(), "2026-01-05T08:00:00.000Z");
  assert.equal(relative.start.toISOString(), "2026-01-03T08:00:00.000Z");
});

test("Cyprus DST gaps and repeated local times fail closed while valid boundary times parse", () => {
  const policy = { ...completePolicy, durationMinutes: 30 };
  const springGap = parseBookingDetails("Sunday March 29, 2026 at 03:30", policy, new Date("2026-03-01T10:00:00.000Z"));
  const fallRepeated = parseBookingDetails("Sunday October 25, 2026 at 03:30", policy, new Date("2026-09-01T10:00:00.000Z"));
  const validAfterGap = parseBookingDetails("Sunday March 29, 2026 at 04:00", policy, new Date("2026-03-01T10:00:00.000Z"));
  assert.equal(springGap, null);
  assert.equal(fallRepeated, null);
  assert.equal(validAfterGap.start.toISOString(), "2026-03-29T01:00:00.000Z");
});

test("configured opening and closing boundaries are inclusive and outside times are rejected", () => {
  const now = new Date("2026-01-02T08:00:00.000Z");
  const opening = new Date("2026-01-05T06:30:00.000Z"); // 08:30 Nicosia
  const openingEnd = new Date("2026-01-05T07:00:00.000Z");
  const closingStart = new Date("2026-01-05T08:30:00.000Z"); // 10:30 Nicosia
  const closing = new Date("2026-01-05T09:00:00.000Z"); // 11:00 Nicosia
  const afterClose = new Date("2026-01-05T09:01:00.000Z");
  assert.equal(appointmentWindowIssue(opening, openingEnd, completePolicy, now), null);
  assert.equal(appointmentWindowIssue(closingStart, closing, completePolicy, now), null);
  assert.equal(appointmentWindowIssue(closingStart, afterClose, completePolicy, now), "hours");
});

test("a date-like reply after an informational topic switch asks once before resuming a booking draft", async (t) => {
  resetCalendarEnv(t, true);
  const originalCalendar = google.calendar;
  google.calendar = () => ({ freebusy: { query: async () => ({ data: { calendars: { primary: { busy: [] } } } }) } });
  t.after(() => { google.calendar = originalCalendar; });
  const now = new Date("2026-10-10T10:00:00.000Z");
  const store = makeStore(completePolicy, {
    id: "test-user", phone: "35799000000", profile: { name: "Sam" }, booking: { status: "awaiting_details", startedAt: now.toISOString() }
  });
  const question = await handleBookingMessage({ userId: "test-user", text: "What services does Refalco Group offer?", store, now });
  assert.equal(question, null);
  assert.equal((await store.ensureUser()).booking.interrupted, true);
  const dateReply = await handleBookingMessage({ userId: "test-user", text: "Monday at 10:00 for a project discussion", store, now });
  assert.match(dateReply.response, /resume the earlier appointment request/i);
  assert.equal((await store.ensureUser()).booking.resumePrompted, true);
  const resumed = await handleBookingMessage({ userId: "test-user", text: "yes", store, now });
  assert.match(resumed.response, /team to review/);
  assert.doesNotMatch(resumed.response, /time available/u);
  assert.equal((await store.ensureUser()).booking.status, "pending_review");
  assert.equal(store.calls.appointments, 1);
});

test("Arabic and Greek appointment requests enter team review without claiming availability", async (t) => {
  resetCalendarEnv(t, true);
  const originalCalendar = google.calendar;
  google.calendar = () => ({ freebusy: { query: async () => ({ data: { calendars: { primary: { busy: [] } } } }) } });
  t.after(() => { google.calendar = originalCalendar; });
  for (const [language, start, expected] of [
    ["arabic", "2026-10-12T07:30:00.000Z", /أرسلت طلب الموعد/],
    ["greek", "2026-10-12T07:30:00.000Z", /ομάδα/]
  ]) {
    const now = new Date("2026-10-11T05:00:00.000Z");
    const userId = `3579900000${language === "arabic" ? "1" : "2"}@c.us`;
    const store = makeStore(completePolicy, {
      id: userId,
      phone: userId.replace(/@.+$/, ""),
      profile: { name: "Sam" },
      booking: {
        status: "awaiting_details",
        startedAt: now.toISOString(),
        selectedSlot: { start, end: "2026-10-12T08:00:00.000Z" }
      }
    });
    const proposed = await handleBookingMessage({ userId, text: language === "arabic" ? "مشروع جديد 10:30" : "Νέο έργο 10:30", store, now });
    assert.match(proposed.response, expected, `${language} initial prompt`);
    assert.match(proposed.response, /not confirmed|لم يتم تأكيد|δεν έχει επιβεβαιωθεί/iu);
    assert.equal((await store.ensureUser()).booking.status, "pending_review");
    assert.equal(store.calls.appointments, 1);
  }
});

test("a date and greeting are not accepted as a meeting purpose", () => {
  const now = new Date("2026-09-29T12:00:00.000Z");
  const policy = { ...completePolicy, durationMinutes: 30 };
  assert.equal(parseBookingDetails("Tuesday October 6 at 10:30", policy, now).purpose, "");
  assert.equal(parseBookingDetails("Tuesday October 6 at 10:30 مرحبا", policy, now).purpose, "");
});

test("booking asks for a real purpose instead of saving a generic Refalco Group meeting", async (t) => {
  resetCalendarEnv(t, true);
  const now = new Date("2026-09-29T12:00:00.000Z");
  const user = { id: "test-user", profile: {}, booking: { status: "awaiting_details", startedAt: now.toISOString() } };
  let appointmentWrites = 0;
  const store = {
    ensureUser: async () => user,
    getBookingPolicy: async () => ({ ...completePolicy, durationMinutes: 30 }),
    updateUser: async (_id, update) => update(user),
    createAppointment: async () => { appointmentWrites += 1; }
  };
  const result = await handleBookingMessage({ userId: user.id, text: "Tuesday October 6 at 10:30", store, now });
  assert.match(result.response, /still need the meeting purpose/i);
  assert.equal(appointmentWrites, 0);
});

test("appointments must be on the following Cyprus-local day or later", () => {
  const now = new Date("2026-10-01T06:30:00.000Z"); // 09:30 in Cyprus
  const today = new Date("2026-10-01T07:00:00.000Z");
  const tomorrow = new Date("2026-10-02T07:00:00.000Z");
  const endToday = new Date(today.getTime() + 30 * 60000);
  const endTomorrow = new Date(tomorrow.getTime() + 30 * 60000);

  assert.equal(appointmentWindowIssue(today, endToday, completePolicy, now), "notice");
  assert.equal(appointmentWindowIssue(tomorrow, endTomorrow, completePolicy, now), null);
});

test("admin approval rechecks availability before creating the calendar event and schedules the Meet link reminder", async (t) => {
  resetCalendarEnv(t, true);
  const originalCalendar = google.calendar;
  const calls = { freebusy: 0, events: 0, reminders: [], patch: null };
  google.calendar = () => ({
    freebusy: { query: async () => { calls.freebusy++; return { data: { calendars: { primary: { busy: [] } } } }; } },
    events: { insert: async ({ requestBody }) => { calls.events++; return { data: { ...requestBody, id: requestBody.id, htmlLink: "https://calendar.google.com/calendar/event?id=test", hangoutLink: "https://meet.google.com/abc-defg-hij" } }; } }
  });
  t.after(() => { google.calendar = originalCalendar; });
  const appointment = {
    id: "11111111-1111-4111-8111-111111111111", status: "pending_review",
    starts_at: "2026-10-05T07:00:00.000Z", ends_at: "2026-10-05T07:30:00.000Z",
    timezone: "Europe/Nicosia", purpose: "Consultation", whatsapp_jid: "35799111222@s.whatsapp.net"
  };
  const store = {
    getAppointment: async () => appointment,
    getBookingPolicy: async () => ({ ...completePolicy, createMeetLink: true }),
    getUser: async () => ({ phone: "35799111222", profile: { name: "Test" } }),
    updateAppointment: async (_id, patch) => { calls.patch = patch; return { ...appointment, ...patch, starts_at: appointment.starts_at, id: appointment.id }; },
    createReminder: async (_id, reminder) => { calls.reminders.push(reminder); },
    updateUser: async (_id, update) => { const draft = { booking: {} }; update(draft); }
  };
  const result = await approvePendingAppointment({ store, appointmentId: appointment.id, reviewer: "admin@example.com", now: new Date("2026-10-01T06:00:00.000Z") });
  assert.equal(calls.freebusy, 1);
  assert.equal(calls.events, 1);
  assert.equal(calls.patch.status, "confirmed");
  assert.equal(calls.patch.reviewedBy, "admin@example.com");
  assert.equal(result.event.meetLink, "https://meet.google.com/abc-defg-hij");
  assert.ok(calls.reminders.some((reminder) => reminder.kind === "meet_link_1h"));
});

test("appointment approval is not reported as failed when reminder queue setup fails", async (t) => {
  resetCalendarEnv(t, true);
  const originalCalendar = google.calendar;
  google.calendar = () => ({
    freebusy: { query: async () => ({ data: { calendars: { primary: { busy: [] } } } }) },
    events: { insert: async ({ requestBody }) => ({ data: { ...requestBody, id: requestBody.id, htmlLink: "https://calendar.google.com/calendar/event?id=test", hangoutLink: "https://meet.google.com/abc-defg-hij" } }) }
  });
  t.after(() => { google.calendar = originalCalendar; });
  const appointment = {
    id: "22222222-2222-4222-8222-222222222222", status: "pending_review",
    starts_at: "2026-10-05T07:00:00.000Z", ends_at: "2026-10-05T07:30:00.000Z",
    timezone: "Europe/Nicosia", purpose: "Consultation", whatsapp_jid: "35799111222@s.whatsapp.net"
  };
  const events = [];
  const store = {
    getAppointment: async () => appointment,
    getBookingPolicy: async () => ({ ...completePolicy, createMeetLink: true }),
    getUser: async () => ({ phone: "35799111222", profile: { name: "Test" } }),
    updateAppointment: async (_id, patch) => { Object.assign(appointment, patch); events.push(patch.status); return appointment; },
    createReminder: async () => { throw new Error("reminder storage unavailable"); },
    updateUser: async () => {}
  };
  const result = await approvePendingAppointment({ store, appointmentId: appointment.id, reviewer: "admin", now: new Date("2026-10-01T06:00:00.000Z") });
  assert.equal(result.appointment.status, "confirmed");
  assert.match(result.reminderError, /reminder storage unavailable/);
  assert.deepEqual(events, ["confirmed"]);
});

test("concurrent admin approvals serialize and do not double-book one calendar slot", async (t) => {
  resetCalendarEnv(t, true);
  const originalCalendar = google.calendar;
  const calendarEvents = [];
  google.calendar = () => ({
    freebusy: { query: async ({ requestBody }) => {
      const start = Date.parse(requestBody.timeMin);
      const end = Date.parse(requestBody.timeMax);
      const busy = calendarEvents.filter((event) => Date.parse(event.start.dateTime) < end && Date.parse(event.end.dateTime) > start).map((event) => ({ start: event.start.dateTime, end: event.end.dateTime }));
      return { data: { calendars: { primary: { busy } } } };
    } },
    events: { insert: async ({ requestBody }) => { calendarEvents.push(requestBody); return { data: { ...requestBody, id: requestBody.id, htmlLink: "https://calendar.google.com/calendar/event?id=test", hangoutLink: "https://meet.google.com/abc-defg-hij" } }; } }
  });
  t.after(() => { google.calendar = originalCalendar; });
  const appointments = ["33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"].map((id) => ({
    id, status: "pending_review", starts_at: "2026-10-05T07:00:00.000Z", ends_at: "2026-10-05T07:30:00.000Z",
    timezone: "Europe/Nicosia", purpose: "Consultation", whatsapp_jid: "35799111222@s.whatsapp.net"
  }));
  const store = {
    getAppointment: async (id) => appointments.find((item) => item.id === id),
    getBookingPolicy: async () => ({ ...completePolicy, createMeetLink: true }),
    getUser: async () => ({ phone: "35799111222", profile: { name: "Test" } }),
    updateAppointment: async (id, patch) => { const item = appointments.find((appointment) => appointment.id === id); Object.assign(item, patch); return item; },
    createReminder: async () => {}, updateUser: async () => {}
  };
  const now = new Date("2026-10-01T06:00:00.000Z");
  const outcomes = await Promise.allSettled(appointments.map((appointment) => approvePendingAppointment({ store, appointmentId: appointment.id, reviewer: "admin", now })));
  assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(calendarEvents.length, 1);
  assert.equal(appointments.filter((appointment) => appointment.status === "confirmed").length, 1);
});

test("customer cancel and reschedule intents update the calendar and move the contact into the correct next state", async (t) => {
  resetCalendarEnv(t, true);
  assert.equal(appointmentChangeIntent("Please cancel my appointment"), "cancelled");
  assert.equal(appointmentChangeIntent("Can we reschedule our meeting?"), "rescheduled");
  assert.equal(appointmentChangeIntent("بدي ألغي الموعد"), "cancelled");
  assert.equal(appointmentChangeIntent("بدي أغير الموعد"), "rescheduled");
  const originalCalendar = google.calendar;
  const deletes = [];
  google.calendar = () => ({ events: { delete: async (args) => deletes.push(args) } });
  t.after(() => { google.calendar = originalCalendar; });
  const row = { id: "11111111-1111-4111-8111-111111111111", status: "confirmed", whatsapp_jid: "35799111222@s.whatsapp.net", calendar_id: "primary", google_event_id: "rafa-event" };
  const userUpdates = [];
  const store = {
    getAppointment: async () => row,
    getBookingPolicy: async () => completePolicy,
    updateAppointment: async (_id, patch) => Object.assign(row, patch),
    updateUser: async (_id, fn) => { const draft = {}; fn(draft); userUpdates.push(draft.booking); }
  };
  await changeAppointmentStatus({ store, appointmentId: row.id, status: "rescheduled", actor: "customer", now: new Date("2026-10-01T06:00:00.000Z") });
  assert.equal(deletes.length, 1);
  assert.equal(row.status, "rescheduled");
  assert.equal(userUpdates[0].status, "awaiting_details");
  assert.ok(userUpdates[0].idempotencyKey);
});

test("Arabic booking prompts are localized and restricted financial topics are refused", async (t) => {
  resetCalendarEnv(t, true);
  const originalCalendar = google.calendar;
  google.calendar = () => ({ freebusy: { query: async () => ({ data: { calendars: { primary: { busy: [] } } } }) } });
  t.after(() => { google.calendar = originalCalendar; });
  const store = makeStore(completePolicy);
  const prompt = await handleBookingMessage({ userId: "test-user", text: "أريد حجز اجتماع", store });
  assert.match(prompt.response, /غدًا أو يوم عمل لاحق/);

  const restrictedStore = makeStore(completePolicy);
  const refusal = await handleBookingMessage({ userId: "test-user", text: "أريد حجز اجتماع لمناقشة العوائد الاستثمارية", store: restrictedStore });
  assert.match(refusal.response, /لا أستطيع تقديم معلومات عن الاستثمارات أو العوائد المالية/);
  assert.equal(restrictedStore.calls.updates, 0);
});

test("booking cancellation uses the current Supabase hours", async (t) => {
  resetCalendarEnv(t, true);
  const originalCalendar = google.calendar;
  google.calendar = () => ({ freebusy: { query: async () => ({ data: { calendars: { primary: { busy: [] } } } }) } });
  t.after(() => { google.calendar = originalCalendar; });
  const store = makeStore(completePolicy, { profile: {}, booking: { status: "awaiting_confirmation" } });

  const result = await handleBookingMessage({ userId: "test-user", text: "no", store });

  assert.match(result.response, /08:30 and 11:00 \(Europe\/Nicosia\)/);
  assert.equal(store.calls.updates, 1);
  assert.equal(store.calls.appointments, 0);
});

test("Arabic WhatsApp booking persists a pending team-review request without creating a calendar event", async (t) => {
  resetCalendarEnv(t, true);
  const originalCalendar = google.calendar;
  const busyChecks = [];
  const events = [];
  google.calendar = () => ({
    freebusy: { query: async ({ requestBody }) => {
      busyChecks.push(requestBody);
      return { data: { calendars: { primary: { busy: [] } } } };
    } },
    events: { insert: async ({ calendarId, requestBody, conferenceDataVersion }) => {
      events.push({ calendarId, requestBody, conferenceDataVersion });
      return { data: { ...requestBody, htmlLink: "https://calendar.google.com/calendar/event?eid=synthetic", hangoutLink: "https://meet.google.com/abc-defg-hij" } };
    } }
  });
  t.after(() => { google.calendar = originalCalendar; });

  const policy = { ...completePolicy, startTime: "10:00", endTime: "15:00", reminderHours: [24, 1], createMeetLink: true };
  const user = { id: "35799111222@c.us", phone: "35799111222", profile: { name: "Test" }, booking: null };
  const appointmentId = "11111111-1111-4111-8111-111111111111";
  const persisted = { id: appointmentId, status: "awaiting_customer_confirmation", created_at: "2026-01-02T08:00:00.000Z", metadata: {} };
  const writes = [];
  const reminders = [];
  const store = {
    ensureUser: async () => user,
    getBookingPolicy: async () => policy,
    updateUser: async (_id, update) => { update(user); return user; },
    createAppointment: async (value) => {
      Object.assign(persisted, { status: value.status, starts_at: value.startsAt, ends_at: value.endsAt, timezone: value.timezone, metadata: value.metadata });
      return { appointment: persisted, created: true };
    },
    updateAppointment: async (_id, value) => {
      writes.push(value.status);
      Object.assign(persisted, { status: value.status, google_event_id: value.googleEventId, google_meet_url: value.googleMeetUrl, confirmed_at: value.confirmedAt });
      return persisted;
    },
    createReminder: async (_id, reminder) => { reminders.push(reminder); }
  };
  const now = new Date("2026-01-02T08:00:00.000Z");

  const started = await handleBookingMessage({ userId: user.id, text: "أريد حجز اجتماع", store, now });
  assert.match(started.response, /غدًا أو يوم عمل لاحق/);
  const proposed = await handleBookingMessage({ userId: user.id, text: "الاثنين الساعة 11:00 لمناقشة مشروع الشركة", store, now });
  assert.match(proposed.response, /أرسلت طلب الموعد/);
  assert.match(proposed.response, /لم يتم تأكيد الموعد/);
  assert.equal(busyChecks.length, 0, "the request enters team review without checking or claiming calendar availability");
  assert.equal(events.length, 0);
  assert.equal(persisted.status, "pending_review");
  assert.deepEqual(writes, []);
  assert.equal(user.booking.status, "pending_review");
  assert.equal(user.booking.appointmentId, appointmentId);
  assert.equal(reminders.length, 0);
});

test("admin approval succeeds without a Meet link when its creation is disabled", async (t) => {
  resetCalendarEnv(t, true);
  const originalCalendar = google.calendar;
  let insertedBody;
  google.calendar = () => ({
    freebusy: { query: async () => ({ data: { calendars: { primary: { busy: [] } } } }) },
    events: { insert: async ({ requestBody }) => { insertedBody = requestBody; return { data: { ...requestBody, id: requestBody.id, htmlLink: "https://calendar.google.com/calendar/event?id=no-meet" } }; } }
  });
  t.after(() => { google.calendar = originalCalendar; });
  const appointment = {
    id: "55555555-5555-4555-8555-555555555555", status: "pending_review",
    starts_at: "2026-10-05T07:00:00.000Z", ends_at: "2026-10-05T07:30:00.000Z",
    timezone: "Europe/Nicosia", purpose: "Consultation", whatsapp_jid: "35799111222@s.whatsapp.net"
  };
  const store = {
    getAppointment: async () => appointment,
    getBookingPolicy: async () => ({ ...completePolicy, createMeetLink: false }),
    getUser: async () => ({ phone: "35799111222", profile: { name: "Test" } }),
    updateAppointment: async (_id, patch) => ({ ...appointment, ...patch }),
    createReminder: async () => {},
    updateUser: async () => {}
  };
  const result = await approvePendingAppointment({ store, appointmentId: appointment.id, reviewer: "admin", now: new Date("2026-10-01T06:00:00.000Z") });
  assert.equal(result.appointment.status, "confirmed");
  assert.equal(result.event.meetLink, "");
  assert.equal(result.appointment.googleMeetUrl, "");
  assert.equal("conferenceData" in insertedBody, false);
});

test("admin approval still requires a Meet link when its creation is enabled", async (t) => {
  resetCalendarEnv(t, true);
  const originalCalendar = google.calendar;
  let appointmentWrites = 0;
  google.calendar = () => ({
    freebusy: { query: async () => ({ data: { calendars: { primary: { busy: [] } } } }) },
    events: { insert: async ({ requestBody }) => ({ data: { ...requestBody, id: requestBody.id, htmlLink: "https://calendar.google.com/calendar/event?id=missing-meet" } }) }
  });
  t.after(() => { google.calendar = originalCalendar; });
  const appointment = {
    id: "66666666-6666-4666-8666-666666666666", status: "pending_review",
    starts_at: "2026-10-05T07:00:00.000Z", ends_at: "2026-10-05T07:30:00.000Z",
    timezone: "Europe/Nicosia", purpose: "Consultation", whatsapp_jid: "35799111222@s.whatsapp.net"
  };
  const store = {
    getAppointment: async () => appointment,
    getBookingPolicy: async () => ({ ...completePolicy, createMeetLink: true }),
    getUser: async () => ({ phone: "35799111222", profile: { name: "Test" } }),
    updateAppointment: async () => { appointmentWrites += 1; return appointment; }
  };
  await assert.rejects(approvePendingAppointment({ store, appointmentId: appointment.id, reviewer: "admin", now: new Date("2026-10-01T06:00:00.000Z") }), /did not return a Meet link/u);
  assert.equal(appointmentWrites, 0);
});

test("the main WhatsApp flow offers at most two live slots for tomorrow and asks for a numbered choice", async (t) => {
  resetCalendarEnv(t, true);
  const originalCalendar = google.calendar;
  const queries = [];
  google.calendar = () => ({ freebusy: { query: async ({ requestBody }) => {
    queries.push(requestBody);
    return { data: { calendars: { primary: { busy: [] } } } };
  } } });
  t.after(() => { google.calendar = originalCalendar; });
  const now = new Date("2026-10-11T05:00:00.000Z");
  const user = { id: "slot-choice-user", profile: { name: "Test" }, booking: null };
  const store = {
    ensureUser: async () => user,
    getBookingPolicy: async () => completePolicy,
    updateUser: async (_id, update) => { update(user); return user; }
  };
  await handleBookingMessage({ userId: user.id, text: "I'd like to book a meeting", store, now });
  const options = await handleBookingMessage({ userId: user.id, text: "tomorrow", store, now });
  assert.match(options.response, /currently available/);
  assert.equal(options.slots.length, 2);
  assert.match(options.response, /1\./);
  assert.match(options.response, /2\./);
  assert.equal(user.booking.status, "awaiting_slot_choice");
  const selected = await handleBookingMessage({ userId: user.id, text: "2", store, now });
  assert.match(selected.response, /brief purpose/);
  assert.equal(user.booking.status, "awaiting_details");
  assert.equal(queries.length, 1, "only the date-specific live slot listing queries the calendar");
});

test("booking offers tomorrow or a later workday, and localized date choices return compliant live slots", async (t) => {
  resetCalendarEnv(t, true);
  const originalCalendar = google.calendar;
  const queries = [];
  google.calendar = () => ({ freebusy: { query: async ({ requestBody }) => {
    queries.push(requestBody);
    return { data: { calendars: { primary: { busy: [] } } } };
  } } });
  t.after(() => { google.calendar = originalCalendar; });
  const now = new Date("2026-10-11T05:00:00.000Z"); // Sunday, 08:00 in Nicosia
  const cases = [
    { id: "workday-en", request: "I'd like to book a meeting", date: "Monday", prompt: /tomorrow or a later working day/i },
    { id: "workday-ar", request: "أريد حجز اجتماع", date: "الاثنين", prompt: /غدًا أو يوم عمل لاحق/ },
    { id: "workday-el", request: "Θέλω να κλείσω ένα ραντεβού", date: "Δευτέρα", prompt: /αύριο ή κάποια επόμενη εργάσιμη ημέρα/ }
  ];
  for (const scenario of cases) {
    const user = { id: scenario.id, phone: scenario.id, profile: { name: "Sam" }, booking: null };
    const store = {
      ensureUser: async () => user,
      getBookingPolicy: async () => completePolicy,
      updateUser: async (_id, update) => { update(user); return user; }
    };
    const started = await handleBookingMessage({ userId: user.id, text: scenario.request, store, now });
    assert.match(started.response, scenario.prompt, `${scenario.id} prompt`);
    assert.doesNotMatch(started.response, /today|σήμερα|اليوم/iu, `${scenario.id} must not offer same-day slots`);
    const selectedDate = await handleBookingMessage({ userId: user.id, text: scenario.date, store, now });
    assert.equal(selectedDate.slots.length, 2, `${scenario.id} should get two live options`);
    for (const slot of selectedDate.slots) {
      const localDate = Object.fromEntries(new Intl.DateTimeFormat("en", {
        timeZone: completePolicy.timezone, year: "numeric", month: "2-digit", day: "2-digit"
      }).formatToParts(new Date(slot.start)).map(({ type, value }) => [type, value]));
      assert.deepEqual([localDate.year, localDate.month, localDate.day], ["2026", "10", "12"], `${scenario.id} should return Monday slots`);
      assert.equal(appointmentWindowIssue(new Date(slot.start), new Date(slot.end), completePolicy, now), null, `${scenario.id} slot complies with policy`);
    }
    assert.equal(user.booking.status, "awaiting_slot_choice");
  }
  assert.equal(queries.length, 3, "each locale performs only one date-specific availability query");
});
