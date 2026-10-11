const { randomUUID } = require("node:crypto");
const { google } = require("googleapis");
const chrono = require("chrono-node");
const { validateBookingPolicy } = require("./bookingPolicy.js");
const { detectMessageLanguage } = require("./language.js");
const { restrictedRefalcoReply } = require("./refalcoAnswer.js");
const { extractCustomerName, namePrompt, isPlausibleCustomerName } = require("./messageRouter.js");
const { normalizeAppointmentDetails } = require("./appointmentDetails.js");
const { detectBuyingSignals } = require("./buyingSignals.js");

const CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events.owned",
  "https://www.googleapis.com/auth/calendar.events.freebusy"
];
const CUSTOMER_BOOKING_URL = "https://calendar.app.google/Ny3HQG1iwmF3T5s58";
let calendarApprovalQueue = Promise.resolve();

function isBookingRequest(text) {
  const value = String(text || "").toLowerCase();
  if (detectBuyingSignals(text).some((signal) => signal.bookingRequested)) return true;
  // An explicit refusal or deferral cancels any booking implication in the same turn.
  if (/(?:\b(?:do not|don't|dont|not|no|without|rather not)\b.{0,45}\b(?:book|schedule|meeting|call|appointment)\b|\b(?:not|no)\b.{0,25}\b(?:meeting|call|appointment)\b|ما\s+بدي.{0,35}(?:احجز|حجز|موعد|اجتماع)|لا.{0,30}(?:موعد|اجتماع|احجز|حجز)|مو\s+حابة.{0,30}(?:موعد|اجتماع)|δεν\s+θέλω.{0,35}(?:ραντεβού|συνάντηση|κλήση|κλείσω))/iu.test(value)) return false;
  const english =
    /\b(book|schedule|arrange)\b.*\b(meeting|call|appointment)\b/.test(value) ||
    /\b(meeting|call|appointment)\b.*\b(book|schedule|arrange)\b/.test(value) ||
    /\b(set up|organize|organise|reserve)\b.{0,50}\b(meeting|call|appointment|visit)\b/.test(value) ||
    /\b(?:i(?:'d| would)? like|i want|i need|can i|could i)\b.{0,35}\b(meeting|call|appointment)\b/.test(value) ||
    /\b(?:can|could|would) we meet\b|\b(?:i(?:'d| would)? like to meet|i want to meet|let's meet)\b/.test(value) ||
    /\b(?:are you|would you be) available\b.{0,35}\b(meet|meeting|call|appointment)\b/.test(value);
  const arabic =
    /(احجز|حجز|حدد|رتب).*(موعد|اجتماع|مكالمة)|(موعد|اجتماع|مكالمة).*(احجز|حجز|حدد|رتب)/.test(value) ||
    /(اريد|أريد|ارغب|أرغب|ممكن|هل يمكن|هل نستطيع).{0,35}(موعد|اجتماع|مكالمة)/.test(value) ||
    /(موعد|اجتماع|مكالمة).{0,35}(اريد|أريد|ارغب|أرغب)/.test(value);
  // REFAL-AGENT-014: isBookingRequest previously had no Greek coverage at
  // all — the literal entry gate to the booking state machine, so a Greek
  // customer could never start a booking through this function (intent.js's
  // separate APPOINTMENT classification already had Greek, but that is used
  // for routing elsewhere, not for this gate). Mirrors the EN/AR shape above.
  const greek =
    /(κλείσω|κλείσουμε|κανονίσω|κανονίσουμε|οργανώσω).{0,50}(ραντεβού|συνάντηση|κλήση)|(ραντεβού|συνάντηση|κλήση).{0,50}(κλείσω|κλείσουμε|κανονίσω|κανονίσουμε)/.test(value) ||
    /(θέλω|θα ήθελα|μπορώ|μπορούμε).{0,35}(ραντεβού|συνάντηση|κλήση)/.test(value) ||
    /(ραντεβού|συνάντηση|κλήση).{0,35}(θέλω|θα ήθελα)/.test(value);

  const asksAboutRefalcoProcess = /\b(?:does|do|how does|how do)\s+(?:rafa|business|your team|the team)\b/.test(value);
  const asksHowToCall = /\bhow can i call (?:you|rafa|business|the team)\b/.test(value);

  return !asksAboutRefalcoProcess && !asksHowToCall && (english || arabic || greek);
}

function appointmentChangeIntent(text) {
  const value = String(text || "").toLowerCase();
  if (/\b(?:cancel|canceling|cancel my|call off)\b.{0,35}\b(?:meeting|appointment|booking)\b|\b(?:meeting|appointment|booking)\b.{0,35}\b(?:cancel|call off)\b/.test(value) || /(إلغاء|إلغي|ألغي|الغي|الغ|الغِ).{0,25}(موعد|اجتماع|حجز)|(موعد|اجتماع|حجز).{0,25}(إلغاء|إلغي|ألغي|الغي|الغ)/u.test(value)) return "cancelled";
  if (/\b(?:reschedule|change|move)\b.{0,35}\b(?:meeting|appointment|booking|time)\b|\b(?:meeting|appointment|booking)\b.{0,35}\b(?:reschedule|change|move)\b/.test(value) || /(تغيير|تعديل|تأجيل|اجل|أجل|أغير|اغير|أعدل|اعدل|أبدل|ابدل).{0,25}(موعد|اجتماع)|(موعد|اجتماع).{0,25}(تغيير|تعديل|تأجيل|أغير|اغير|أعدل|اعدل|أبدل|ابدل)/u.test(value)) return "rescheduled";
  return "";
}

function parseBookingDetails(text, policy, now = new Date()) {
  if (!policy) return null;
  const input = normalizeBookingText(text);
  const referenceOffset = timezoneOffsetMinutes(now, policy.timezone);
  const parsed = chrono.parse(input, { instant: now, timezone: referenceOffset }, { forwardDate: true })[0];
  if (!parsed || !parsed.start.isCertain("hour")) return null;
  const local = {
    year: parsed.start.get("year"),
    month: parsed.start.get("month"),
    day: parsed.start.get("day"),
    hour: parsed.start.get("hour"),
    minute: parsed.start.get("minute") || 0
  };
  const start = zonedLocalTimeToDate(local, policy.timezone);
  if (!start) return null;
  const matchedDate = String(parsed.text || "").trim();
  let purpose = input.replace(matchedDate, "").replace(/^[\s,.;:-]*(?:to discuss|about|for)?\s*/i, "").trim();
  if (/^(?:hi|hello|hey|مرحبا|أهلا|اهلا|السلام عليكم|صباح الخير|مساء الخير)[.!؟!\s]*$/i.test(purpose)) purpose = "";
  return {
    start,
    end: new Date(start.getTime() + (policy.durationMinutes || 0) * 60000),
    purpose
  };
}

function partsAt(date, timezone) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  }).formatToParts(date).map(({ type, value }) => [type, value]));
}

function timezoneOffsetMinutes(date, timezone) {
  const parts = partsAt(date, timezone);
  const representedAsUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second)
  );
  return (representedAsUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000;
}

function zonedLocalTimeToDate(local, timezone) {
  const wallTime = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  const offsets = new Set([-36, -12, 0, 12, 36].map((hours) =>
    timezoneOffsetMinutes(new Date(wallTime + hours * 3600000), timezone)
  ));
  const matches = [];
  for (const offset of offsets) {
    const candidate = new Date(wallTime - offset * 60000);
    const parts = partsAt(candidate, timezone);
    if (Number(parts.year) === local.year && Number(parts.month) === local.month &&
      Number(parts.day) === local.day && Number(parts.hour) === local.hour &&
      Number(parts.minute) === local.minute) matches.push(candidate);
  }
  return matches.length === 1 ? matches[0] : null;
}

function calendarId(policy) {
  return String(policy?.calendarId || "").trim();
}

function hasOAuthCalendarCredentials() {
  return Boolean(process.env.GOOGLE_CALENDAR_CLIENT_ID && process.env.GOOGLE_CALENDAR_CLIENT_SECRET && process.env.GOOGLE_CALENDAR_REFRESH_TOKEN);
}

function hasServiceAccountCalendarCredentials() {
  return Boolean(process.env.GOOGLE_CALENDAR_CLIENT_EMAIL && process.env.GOOGLE_CALENDAR_PRIVATE_KEY);
}

function googleAuth() {
  if (hasOAuthCalendarCredentials()) {
    const auth = new google.auth.OAuth2(
      process.env.GOOGLE_CALENDAR_CLIENT_ID,
      process.env.GOOGLE_CALENDAR_CLIENT_SECRET
    );
    auth.setCredentials({ refresh_token: process.env.GOOGLE_CALENDAR_REFRESH_TOKEN });
    return auth;
  }

  const clientEmail = process.env.GOOGLE_CALENDAR_CLIENT_EMAIL;
  const privateKey = process.env.GOOGLE_CALENDAR_PRIVATE_KEY?.replace(/\\n/g, "\n");

  if (!clientEmail || !privateKey) {
    throw new Error("Configure Google Calendar OAuth client credentials or a service account in the runtime secret store.");
  }

  return new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: CALENDAR_SCOPES
  });
}

function hasCalendarConfig(policy) {
  try { policy = validateBookingPolicy(policy); } catch { return false; }
  try {
    new Intl.DateTimeFormat("en", { timeZone: policy.timezone });
  } catch {
    return false;
  }
  return Boolean(
    calendarId(policy) &&
    (hasOAuthCalendarCredentials() || hasServiceAccountCalendarCredentials()) &&
    policy.durationOwnerConfirmed && policy.durationMinutes &&
    policy.minimumNoticeHours !== null && policy.reminderHours.length
  );
}

function hasBookingPolicy(policy) {
  try { policy = validateBookingPolicy(policy); } catch { return false; }
  try { new Intl.DateTimeFormat("en", { timeZone: policy.timezone }); }
  catch { return false; }
  return Boolean(calendarId(policy) && policy.durationOwnerConfirmed && policy.durationMinutes &&
    policy.minimumNoticeHours !== null && policy.reminderHours.length);
}

async function scheduleBookingReminders({ store, appointment, userId, now, policy }) {
  if (typeof store.createReminder !== "function") throw new Error("The durable Supabase reminder queue is unavailable.");
  const offsets = [...new Set([...(policy.reminderHours || []), 1])];
  for (const hoursBefore of offsets) {
    const dueAt = new Date(new Date(appointment.starts_at || appointment.startsAt).getTime() - hoursBefore * 3600000);
    if (dueAt <= now) continue;
    await store.createReminder(appointment.id, {
      kind: hoursBefore === 1 ? "meet_link_1h" : `${hoursBefore}h_before`,
      channel: "whatsapp",
      recipient: userId,
      dueAt: dueAt.toISOString(),
      idempotencyKey: `${appointment.id}:whatsapp:${hoursBefore}h`
    });
  }
}

async function approvePendingAppointment(options) {
  const previous = calendarApprovalQueue.catch(() => {});
  let release;
  const turn = new Promise((resolve) => { release = resolve; });
  calendarApprovalQueue = previous.then(() => turn);
  await previous;
  try { return await approvePendingAppointmentUnlocked(options); }
  finally { release(); }
}

async function approvePendingAppointmentUnlocked({ store, appointmentId, reviewer, now = new Date() }) {
  const appointment = await store.getAppointment(appointmentId);
  if (!appointment) throw new Error("Appointment was not found.");
  if (appointment.status !== "pending_review") throw new Error("Only a pending appointment can be approved.");
  const policy = validateBookingPolicy(await store.getBookingPolicy());
  const details = { start: new Date(appointment.starts_at), end: new Date(appointment.ends_at), purpose: appointment.purpose };
  const issue = appointmentWindowIssue(details.start, details.end, policy, now);
  if (issue) throw new Error("The requested time is no longer within the booking window. Reject it and ask the customer to choose another time.");
  if (!await isAvailable(details, policy)) throw new Error("The requested time is no longer available. Reject it and ask the customer to choose another time.");
  const user = await store.getUser(appointment.whatsapp_jid, { includeHistory: false });
  if (!user) throw new Error("The customer contact could not be loaded.");
  const eventId = `rafa${appointment.id.replace(/-/g, "")}`;
  const event = await createBookingEvent({ user, userId: appointment.whatsapp_jid, details, eventId, policy });
  if (policy.createMeetLink && !event.meetLink) throw new Error("Google Calendar did not return a Meet link. The appointment remains pending review; check Calendar conference settings and retry.");
  const saved = await store.updateAppointment(appointment.id, {
    status: "confirmed",
    googleEventId: event.id,
    googleEventUrl: event.htmlLink || "",
    googleMeetUrl: event.meetLink || "",
    confirmedAt: now.toISOString(),
    reviewedAt: now.toISOString(),
    reviewedBy: String(reviewer || "admin").slice(0, 200)
  });
  if (saved?.status !== "confirmed") throw new Error("Calendar event was created, but the appointment confirmation could not be saved.");
  let reminderError = "";
  try { await scheduleBookingReminders({ store, appointment: saved, userId: appointment.whatsapp_jid, now, policy }); }
  catch (error) {
    reminderError = String(error?.message || "Reminder scheduling failed.").slice(0, 240);
    try { await store.logEvent?.("appointment_reminder_schedule_error", { appointmentId: appointment.id, message: reminderError }); } catch { /* Confirmation delivery must not depend on event logging. */ }
  }
  try {
    await store.updateUser(appointment.whatsapp_jid, (draft) => {
      draft.booking = { ...(draft.booking || {}), status: "booked", appointmentId: appointment.id, bookedAt: now.toISOString(), eventId: event.id, meetLink: event.meetLink || "" };
    });
  } catch (error) {
    try { await store.logEvent?.("appointment_contact_sync_error", { appointmentId: appointment.id, message: String(error?.message || "Could not update contact booking state.").slice(0, 240) }); } catch { /* Do not suppress the customer confirmation. */ }
  }
  return { appointment: saved, user, event, policy, reminderError };
}

async function changeAppointmentStatus({ store, appointmentId, status, actor = "customer", reason = "", now = new Date() }) {
  if (!["cancelled", "rescheduled"].includes(status)) throw new Error("Unsupported appointment change.");
  const appointment = await store.getAppointment(appointmentId);
  if (!appointment) throw new Error("Appointment was not found.");
  if (appointment.status === status) return appointment;
  if (!["confirmed", "pending_review", "awaiting_customer_confirmation", "creating", "pending_calendar"].includes(appointment.status)) throw new Error("Only an active appointment can be changed.");
  let calendarChanged = false;
  if (appointment.status === "confirmed" && appointment.google_event_id) {
    try {
      await calendarClient().events.delete({ calendarId: appointment.calendar_id || calendarId(await store.getBookingPolicy()), eventId: appointment.google_event_id });
      calendarChanged = true;
    } catch (error) {
      if (error?.code !== 404 && error?.response?.status !== 404) throw new Error("Google Calendar could not update this appointment. It remains unchanged; please retry.");
      calendarChanged = true;
    }
  }
  let saved;
  try {
    saved = await store.updateAppointment(appointment.id, {
      status,
      cancelledAt: status === "cancelled" ? now.toISOString() : undefined,
      reviewedAt: now.toISOString(),
      reviewedBy: String(actor).slice(0, 200),
      reviewReason: String(reason).trim().slice(0, 500)
    });
  } catch (cause) {
    if (calendarChanged) {
      try { await store.logEvent?.("appointment_calendar_sync_reconciliation_required", { appointmentId, targetStatus: status, actor }); } catch { /* Preserve the primary reconciliation error. */ }
      const error = new Error("Google Calendar changed, but the Supabase appointment status did not save. Admin reconciliation is required.");
      error.calendarChanged = true;
      throw error;
    }
    throw cause;
  }
  if (saved?.status !== status) {
    try { await store.logEvent?.("appointment_calendar_sync_reconciliation_required", { appointmentId, targetStatus: status, actor }); } catch { /* Preserve the primary reconciliation error. */ }
    const error = new Error("Google Calendar changed, but the Supabase appointment status did not save. Admin reconciliation is required.");
    error.calendarChanged = true;
    throw error;
  }
  await store.updateUser(appointment.whatsapp_jid, (draft) => {
    draft.booking = status === "rescheduled"
      ? { status: "awaiting_details", startedAt: now.toISOString(), idempotencyKey: randomUUID(), purpose: appointment.purpose }
      : null;
  });
  await store.logEvent?.(`appointment_${status}`, { appointmentId: appointment.id, actor, reason: String(reason).slice(0, 500) });
  return saved;
}

function appointmentWindowIssue(start, end, policy, now = new Date()) {
  const parts = (date) => Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: policy.timezone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(date).map(({ type, value }) => [type, value]));
  const nowLocal = parts(now);
  const startLocal = parts(start);
  const endLocal = parts(end);
  const dayIndex = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5 };
  const startMinutes = Number(startLocal.hour) * 60 + Number(startLocal.minute);
  const endMinutes = Number(endLocal.hour) * 60 + Number(endLocal.minute);

  const localDay = (dateParts) => Date.UTC(Number(dateParts.year), Number(dateParts.month) - 1, Number(dateParts.day));
  const tomorrowLocal = localDay(nowLocal) + 86400000;
  if (localDay(startLocal) < tomorrowLocal || start <= now || start.getTime() - now.getTime() < policy.minimumNoticeHours * 3600000) return "notice";
  if (!dayIndex[startLocal.weekday] || !policy.weekdays.includes(dayIndex[startLocal.weekday]) || startLocal.weekday !== endLocal.weekday || endMinutes > Number(policy.endTime.slice(0, 2)) * 60 + Number(policy.endTime.slice(3)) || startMinutes < Number(policy.startTime.slice(0, 2)) * 60 + Number(policy.startTime.slice(3))) return "hours";
  return null;
}

function calendarClient() {
  return google.calendar({ version: "v3", auth: googleAuth() });
}

async function verifyCalendarAccess(policy, now = new Date()) {
  policy = validateBookingPolicy(policy);
  if (!hasOAuthCalendarCredentials() && !hasServiceAccountCalendarCredentials()) {
    throw new Error("Google Calendar credentials are not configured for the RAFA runtime.");
  }

  try {
    const timeMin = new Date(now.getTime() + 60000);
    const timeMax = new Date(timeMin.getTime() + 300000);
    const response = await calendarClient().freebusy.query({
      requestBody: {
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        timeZone: policy.timezone,
        items: [{ id: calendarId(policy) }]
      }
    });
    const calendar = response.data.calendars?.[calendarId(policy)];
    if (!calendar || calendar.errors?.length) {
      throw new Error("The configured calendar is missing or not accessible.");
    }
    return { calendarId: calendarId(policy), checkedAt: now.toISOString() };
  } catch (error) {
    if (error.message === "The configured calendar is missing or not accessible.") throw error;
    throw new Error("Google Calendar authorization failed or this calendar is not accessible to RAFA.");
  }
}

async function isAvailable({ start, end }, policy) {
  const calendar = calendarClient();
  const response = await calendar.freebusy.query({
    requestBody: {
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      timeZone: policy.timezone,
      items: [{ id: calendarId(policy) }]
    }
  });

  const busy = response.data.calendars?.[calendarId(policy)]?.busy || [];
  return busy.length === 0;
}

// Shared trusted slot-listing capability for both deterministic WhatsApp
// booking and the Agent tool registry. Callers may narrow the date horizon
// and count, but availability always comes from Google Calendar free/busy.
async function listCalendarSlots(policyValue, { now = new Date(), count = 3, horizonDays = 21, firstDayOffset = 1 } = {}) {
  const policy = validateBookingPolicy(policyValue);
  const today = partsAt(now, policy.timezone);
  const firstDay = Date.UTC(Number(today.year), Number(today.month) - 1, Number(today.day)) + firstDayOffset * 86400000;
  const startMinute = Number(policy.startTime.slice(0, 2)) * 60 + Number(policy.startTime.slice(3));
  const endMinute = Number(policy.endTime.slice(0, 2)) * 60 + Number(policy.endTime.slice(3));
  const candidates = [];
  for (let dayOffset = 0; dayOffset < horizonDays && candidates.length < 500; dayOffset++) {
    const day = new Date(firstDay + dayOffset * 86400000);
    const weekday = day.getUTCDay() === 0 ? 7 : day.getUTCDay();
    if (!policy.weekdays.includes(weekday)) continue;
    const year = day.getUTCFullYear();
    const month = day.getUTCMonth() + 1;
    const date = day.getUTCDate();
    for (let minute = startMinute; minute + policy.durationMinutes <= endMinute; minute += 30) {
      const start = zonedLocalTimeToDate({ year, month, day: date, hour: Math.floor(minute / 60), minute: minute % 60 }, policy.timezone);
      if (!start) continue;
      const end = new Date(start.getTime() + policy.durationMinutes * 60000);
      if (!appointmentWindowIssue(start, end, policy, now)) candidates.push({ start, end });
      if (candidates.length >= 500) break;
    }
  }
  if (!candidates.length) return [];
  const calendar = calendarClient();
  const response = await calendar.freebusy.query({
    requestBody: {
      timeMin: candidates[0].start.toISOString(),
      timeMax: candidates.at(-1).end.toISOString(),
      timeZone: policy.timezone,
      items: [{ id: calendarId(policy) }]
    }
  });
  const busy = response.data.calendars?.[calendarId(policy)]?.busy || [];
  return candidates.filter((slot) => !busy.some((block) => {
    const busyStart = Date.parse(block.start);
    const busyEnd = Date.parse(block.end);
    return Number.isFinite(busyStart) && Number.isFinite(busyEnd) && slot.start.getTime() < busyEnd && slot.end.getTime() > busyStart;
  })).slice(0, Math.max(1, Math.min(5, count)));
}

async function createBookingEvent({ user, userId, details, eventId, policy }) {
  const calendar = calendarClient();
  const phone = user.phone || String(userId || "").replace(/@.+$/, "");
  const name = isPlausibleCustomerName(user.profile?.name) ? user.profile.name : phone;
  const purpose = details.purpose || "WhatsApp booking";

  const requestBody = {
      id: eventId,
      summary: `WhatsApp booking - ${name}`,
      description: [
        `WhatsApp user: ${userId}`,
        `Phone: ${phone}`,
        `Name: ${isPlausibleCustomerName(user.profile?.name) ? user.profile.name : "not set"}`,
        `Company/project: ${user.profile?.company || "not set"}`,
        `Need: ${user.profile?.needOverride || user.profile?.need || "not set"}`,
        "",
        `Purpose: ${purpose}`
      ].join("\n"),
      start: {
        dateTime: details.start.toISOString(),
        timeZone: policy.timezone
      },
      end: {
        dateTime: details.end.toISOString(),
        timeZone: policy.timezone
      }
    };
  if (policy.createMeetLink) {
    requestBody.conferenceData = {
      createRequest: {
        requestId: `${eventId}-meet`,
        conferenceSolutionKey: { type: "hangoutsMeet" }
      }
    };
  }
  try {
    const response = await calendar.events.insert({
      calendarId: calendarId(policy),
      requestBody,
      ...(policy.createMeetLink ? { conferenceDataVersion: 1 } : {})
    });
    return withMeetLink(response.data, false, policy.createMeetLink);
  } catch (error) {
    if (error?.code !== 409 && error?.response?.status !== 409) throw error;
    const response = await calendar.events.get({ calendarId: calendarId(policy), eventId });
    const existing = response.data;
    const existingStart = Date.parse(existing.start?.dateTime || "");
    const existingEnd = Date.parse(existing.end?.dateTime || "");
    if (existingStart !== details.start.getTime() || existingEnd !== details.end.getTime()) {
      throw new Error("The idempotent calendar event ID already exists with different appointment times.");
    }
    if (policy.createMeetLink && !withMeetLink(existing, true).meetLink) {
      const updated = await calendar.events.patch({
        calendarId: calendarId(policy),
        eventId,
        conferenceDataVersion: 1,
        requestBody: { conferenceData: { createRequest: { requestId: `${eventId}-meet-retry`, conferenceSolutionKey: { type: "hangoutsMeet" } } } }
      });
      return withMeetLink(updated.data, true, policy.createMeetLink);
    }
    return withMeetLink(existing, true, policy.createMeetLink);
  }
}

function withMeetLink(event, alreadyExisted, includeMeetLink = true) {
  const meetLink = includeMeetLink ? (event?.hangoutLink ||
    (event?.conferenceData?.entryPoints || []).find((entry) => entry.entryPointType === "video" && /^https:\/\/meet\.google\.com\//.test(entry.uri || ""))?.uri ||
    "") : "";
  return { ...event, meetLink, _rafaAlreadyExisted: alreadyExisted };
}

function formatBookingTime(date, policy, language = "english") {
  return new Intl.DateTimeFormat(language === "arabic" ? "ar" : language === "greek" ? "el" : "en-GB", {
    timeZone: policy.timezone,
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function bookingPrompt(policy, language = "english") {
  if (language === "arabic") return `هل يناسبك غدًا أو يوم عمل لاحق؟ أجب «غدًا» أو أرسل تاريخًا لاحقًا لأعرض لك حتى موعدين متاحين بين ${policy.startTime} و${policy.endTime} (${policy.timezone})، أو اختر موعدك مباشرة من هنا: ${CUSTOMER_BOOKING_URL}`;
  if (language === "greek") return `Σας εξυπηρετεί αύριο ή κάποια επόμενη εργάσιμη ημέρα; Απαντήστε «αύριο» ή στείλτε μια μεταγενέστερη ημερομηνία για να σας δείξω έως δύο διαθέσιμες ώρες μεταξύ ${policy.startTime} και ${policy.endTime} (${policy.timezone}), ή επιλέξτε ώρα εδώ: ${CUSTOMER_BOOKING_URL}`;
  return `Would tomorrow or a later working day suit you better? Reply “tomorrow” or send a later date and I’ll show up to two currently available times between ${policy.startTime} and ${policy.endTime} (${policy.timezone}), or choose a time directly here: ${CUSTOMER_BOOKING_URL}`;
}

function normalizeBookingText(text) {
  const weekdays = [
    [/الاثنين|الإثنين/g, "Monday"],
    [/الثلاثاء/g, "Tuesday"],
    [/الأربعاء|الاربعاء/g, "Wednesday"],
    [/الخميس/g, "Thursday"],
    [/الجمعة/g, "Friday"],
    [/السبت/g, "Saturday"],
    [/الأحد|الاحد/g, "Sunday"]
  ];
  const months = [
    [/يناير/g, "January"], [/فبراير/g, "February"], [/مارس/g, "March"], [/أبريل|ابريل/g, "April"],
    [/مايو/g, "May"], [/يونيو/g, "June"], [/يوليو/g, "July"], [/أغسطس|اغسطس/g, "August"],
    [/سبتمبر/g, "September"], [/أكتوبر|اكتوبر/g, "October"], [/نوفمبر/g, "November"], [/ديسمبر/g, "December"]
  ];
  let value = String(text || "")
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/الساعة/g, "at")
    .replace(/غدًا|غداً|غدا|بكرة|بكرا/g, "tomorrow")
    .replace(/اليوم/g, "today")
    .replace(/صباحًا|صباحاً|صباحا|الصبح/g, "AM")
    .replace(/مساءً|مساءاً|مساءا|مساء|المساء/g, "PM");
  for (const [pattern, replacement] of [...weekdays, ...months]) value = value.replace(pattern, replacement);
  const greekWords = [
    [/στις|στο/giu, "at"],
    [/δευτέρα/giu, "Monday"], [/τρίτη/giu, "Tuesday"], [/τετάρτη/giu, "Wednesday"],
    [/πέμπτη/giu, "Thursday"], [/παρασκευή/giu, "Friday"], [/σάββατο/giu, "Saturday"],
    [/κυριακή/giu, "Sunday"], [/αύριο/giu, "tomorrow"], [/σήμερα/giu, "today"],
    [/ιανουαρίου|ιανουάριος/giu, "January"], [/φεβρουαρίου|φεβρουάριος/giu, "February"],
    [/μαρτίου|μάρτιος/giu, "March"], [/απριλίου|απρίλιος/giu, "April"],
    [/μαΐου|μαΐος/giu, "May"], [/ιουνίου|ιούνιος/giu, "June"],
    [/ιουλίου|ιούλιος/giu, "July"], [/αυγούστου|αύγουστος/giu, "August"],
    [/σεπτεμβρίου|σεπτέμβριος/giu, "September"], [/οκτωβρίου|οκτώβριος/giu, "October"],
    [/νοεμβρίου|νοέμβριος/giu, "November"], [/δεκεμβρίου|δεκέμβριος/giu, "December"]
  ];
  for (const [pattern, replacement] of greekWords) value = value.replace(pattern, replacement);
  return value;
}

function isResumeYes(text) { return /^(?:yes|yeah|yep|ναι|نαι|نαι|نعم|أجل)[.!،\s]*$/iu.test(String(text || "").trim()); }
function isResumeNo(text) { return /^(?:no|nope|όχι|οχι|لا)[.!،\s]*$/iu.test(String(text || "").trim()); }

function bookingDayOffset(text, policy, now) {
  const input = normalizeBookingText(text).trim();
  if (/^tomorrow[.!،\s]*$/iu.test(input)) return 1;
  if (/^today[.!،\s]*$/iu.test(input)) return 0;
  if (!/\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december)\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[/. -]\d{1,2}(?:[/. -]\d{2,4})?\b/iu.test(input)) return null;
  const parsed = chrono.parse(input, { instant: now, timezone: timezoneOffsetMinutes(now, policy.timezone) }, { forwardDate: true })[0];
  if (!parsed || parsed.start.isCertain("hour")) return null;
  const requested = partsAt(parsed.start.date(), policy.timezone);
  const current = partsAt(now, policy.timezone);
  const requestedDay = Date.UTC(Number(requested.year), Number(requested.month) - 1, Number(requested.day));
  const currentDay = Date.UTC(Number(current.year), Number(current.month) - 1, Number(current.day));
  const offset = Math.round((requestedDay - currentDay) / 86400000);
  return offset >= 0 && offset <= 366 ? offset : null;
}

async function handleBookingMessage({ userId, text, store, user: existingUser = null, now = new Date() }) {
  const user = existingUser || await store.ensureUser(userId);
  let bookingState = user.booking?.status;
  const language = detectMessageLanguage(text);
  const changeIntent = appointmentChangeIntent(text);
  const restrictedReply = restrictedRefalcoReply(text);
  if (restrictedReply && (isBookingRequest(text) || changeIntent)) return { response: restrictedReply, event: null };

  if (!bookingState && !isBookingRequest(text) && !changeIntent) return null;

  // A visitor may decline an old, unfinished booking at any point. Clear only
  // the draft; this must not create/cancel an appointment or keep prompting.
  if (bookingState === "awaiting_details" && isBookingDecline(text)) {
    await store.updateUser(userId, (draft) => { draft.booking = null; });
    return {
      response: language === "arabic"
        ? "مفهوم، لن أتابع طلب حجز موعد. يمكننا متابعة استفسارك هنا."
        : language === "greek"
          ? "Κατανοητό — δεν θα συνεχίσω με αίτημα ραντεβού. Μπορούμε να συνεχίσουμε εδώ την ερώτησή σας."
          : "Understood — I won’t continue with an appointment request. We can keep discussing your question here.",
      event: null
    };
  }

  if (["awaiting_details", "awaiting_confirmation", "awaiting_slot_choice"].includes(bookingState)) {
    const startedAt = Date.parse(user.booking?.startedAt || "");
    // Unfinished conversational drafts should not hijack future messages. A
    // confirmed/pending appointment is unaffected; only temporary draft states
    // expire, after one hour of inactivity.
    if (Number.isFinite(startedAt) && now.getTime() - startedAt > 60 * 60 * 1000) {
      await store.updateUser(userId, (draft) => { draft.booking = null; });
      bookingState = null;
    }
  }

  if (!bookingState && !isBookingRequest(text) && !changeIntent) return null;

  // An informational turn can be answered without discarding the draft. If a
  // later date-like message arrives, ask once whether it resumes that draft;
  // date-shaped content alone must not silently switch the conversation back.
  if (bookingState === "awaiting_details" && user.booking?.interrupted) {
    if (user.booking?.resumePrompted) {
      if (isResumeYes(text)) {
        text = user.booking.pendingDetailsReply || "";
        await store.updateUser(userId, (draft) => {
          draft.booking = { ...draft.booking, interrupted: false, resumePrompted: false, pendingDetailsReply: null };
        });
        user.booking = { ...user.booking, interrupted: false, resumePrompted: false, pendingDetailsReply: null };
      } else {
        await store.updateUser(userId, (draft) => { draft.booking = null; });
        return null;
      }
    } else if (isBookingDetailsReply(text, false)) {
      await store.updateUser(userId, (draft) => {
        draft.booking = { ...draft.booking, resumePrompted: true, pendingDetailsReply: String(text).slice(0, 1000) };
      });
      return {
        response: language === "arabic" ? "هل تريد متابعة طلب الموعد السابق بهذا الوقت؟ أجب بنعم أو لا." :
          language === "greek" ? "Θέλετε να συνεχίσουμε το προηγούμενο αίτημα ραντεβού με αυτή την ώρα; Απαντήστε ναι ή όχι." :
            "Would you like to resume the earlier appointment request with this time? Please reply yes or no.",
        event: null
      };
    }
  }

  if (bookingState === "awaiting_slot_choice" && user.booking?.interrupted) {
    if (user.booking?.resumePrompted) {
      if (isResumeYes(text)) {
        text = user.booking.pendingSlotChoice || "";
        await store.updateUser(userId, (draft) => {
          draft.booking = { ...draft.booking, interrupted: false, resumePrompted: false, pendingSlotChoice: null };
        });
        user.booking = { ...user.booking, interrupted: false, resumePrompted: false, pendingSlotChoice: null };
      } else if (isResumeNo(text)) {
        await store.updateUser(userId, (draft) => { draft.booking = null; });
        return null;
      } else {
        // A question during the disambiguation turn is still an informational
        // turn. Keep both the original draft and the pending choice intact.
        return null;
      }
    } else if (slotChoiceIndex(text, user.booking?.slotOptions) >= 0) {
      await store.updateUser(userId, (draft) => {
        draft.booking = { ...draft.booking, resumePrompted: true, pendingSlotChoice: String(text).trim() };
      });
      return {
        response: language === "arabic" ? "هل تريد متابعة طلب الموعد السابق؟ أجب بنعم أو لا." :
          language === "greek" ? "Θέλετε να συνεχίσετε το προηγούμενο αίτημα ραντεβού; Απαντήστε ναι ή όχι." :
            "Would you like to resume the earlier appointment request? Please reply yes or no.",
        event: null
      };
    }
  }

  if (bookingState === "awaiting_details" && !isBookingDetailsReply(text, !isPlausibleCustomerName(user.profile?.name) && !user.profile?.nameOverride) && !changeIntent && !isBookingRequest(text)) {
    await store.updateUser(userId, (draft) => { draft.booking = { ...draft.booking, interrupted: true }; });
    user.booking = { ...user.booking, interrupted: true };
    return null;
  }
  if (bookingState === "awaiting_confirmation" && !isBookingConfirmationReply(text) && !changeIntent && !isBookingRequest(text)) return null;
  if (bookingState && !["awaiting_details", "awaiting_confirmation", "awaiting_slot_choice"].includes(bookingState) && !changeIntent && !isBookingRequest(text)) return null;

  if (changeIntent) {
    if (!user.booking?.appointmentId) {
      if (bookingState && typeof store.updateUser === "function") await store.updateUser(userId, (draft) => { draft.booking = null; });
      const response = changeIntent === "rescheduled"
        ? (language === "arabic" ? `حسنًا، أرسل اليوم والوقت الجديدين. ${isPlausibleCustomerName(user.profile?.name) ? "" : namePrompt(language)}` : language === "greek" ? `Βεβαίως — στείλτε τη νέα ημέρα και ώρα. ${isPlausibleCustomerName(user.profile?.name) ? "" : namePrompt(language)}` : `Sure—send the new day and time. ${isPlausibleCustomerName(user.profile?.name) ? "" : namePrompt(language)}`)
        : (language === "arabic" ? "لا يوجد موعد مؤكد لإلغائه." : language === "greek" ? "Δεν βρέθηκε ενεργό ραντεβού για ακύρωση." : "I couldn’t find an active appointment to cancel.");
      return { response, event: null };
    }
    try {
      const changed = await changeAppointmentStatus({ store, appointmentId: user.booking.appointmentId, status: changeIntent, actor: "customer", now });
      const response = changeIntent === "cancelled"
        ? (language === "arabic" ? "تم إلغاء موعدك مع الشركة." : language === "greek" ? "Το ραντεβού σας με τη Refalco Group ακυρώθηκε." : "Your Refalco Group appointment has been cancelled.")
        : (language === "arabic" ? `تم تحديث الطلب. أرسل اليوم والوقت الجديدين مع سبب مختصر، وسأطلب من الفريق مراجعتهما.` : language === "greek" ? "Το αίτημα ενημερώθηκε. Στείλτε νέα ημέρα, ώρα και σύντομο σκοπό, και θα ζητήσω από την ομάδα να το εξετάσει." : "I’ve updated your request. Send a new day, time, and brief purpose, and I’ll ask the team to review it.");
      return { response, event: null, appointment: changed };
    } catch (error) {
      const response = error.calendarChanged
        ? (language === "arabic" ? "تم تحديث التقويم، لكن تعذر حفظ حالة الموعد في النظام. أبلغت فريق الشركة لمراجعة السجل." : language === "greek" ? "Το ημερολόγιο ενημερώθηκε, αλλά δεν ήταν δυνατή η αποθήκευση της κατάστασης του ραντεβού. Ενημέρωσα την ομάδα της Refalco Group να το ελέγξει." : "The calendar was updated, but I couldn’t save the appointment status. I’ve flagged it for Refalco Group team to reconcile.")
        : (language === "arabic" ? "تعذر تحديث الموعد في التقويم الآن، لذلك لم أغيّره. حاول مرة أخرى أو تواصل مع فريق الشركة." : language === "greek" ? "Δεν ήταν δυνατή η ενημέρωση του ραντεβού στο ημερολόγιο αυτή τη στιγμή, οπότε δεν άλλαξε. Δοκιμάστε ξανά ή επικοινωνήστε με τη Refalco Group." : "I couldn’t update the appointment in Google Calendar, so it has not been changed. Please try again or contact Refalco Group.");
      return { response, event: null, error };
    }
  }

  const policy = await store.getBookingPolicy();

  if (restrictedReply) return { response: restrictedReply, event: null };

  if (!hasBookingPolicy(policy)) {
    return {
      response: language === "arabic"
        ? `الحجز المباشر غير متاح حاليًا. يمكنك اختيار موعدك من هنا: ${CUSTOMER_BOOKING_URL}`
        : language === "greek"
          ? `Η απευθείας κράτηση δεν είναι διαθέσιμη αυτή τη στιγμή. Μπορείτε να επιλέξετε ώρα εδώ: ${CUSTOMER_BOOKING_URL}`
          : `Direct booking is unavailable right now. You can choose a time here: ${CUSTOMER_BOOKING_URL}`,
      event: null
    };
  }

  let calendarUnavailable = Boolean(user.booking?.calendarUnavailable);
  if (!bookingState && hasCalendarConfig(policy)) {
    try {
      await verifyCalendarAccess(policy, now);
    } catch {
      calendarUnavailable = true;
    }
  }
  if (!hasCalendarConfig(policy)) calendarUnavailable = true;

  if (bookingState === "awaiting_slot_choice") {
    const options = Array.isArray(user.booking?.slotOptions) ? user.booking.slotOptions : [];
    const index = slotChoiceIndex(text, options);
    if (index < 0 || !options[index]) {
      await store.updateUser(userId, (draft) => { draft.booking = { ...draft.booking, interrupted: true }; });
      user.booking = { ...user.booking, interrupted: true };
      return null;
    }
    await store.updateUser(userId, (draft) => { draft.booking = { ...draft.booking, status: "awaiting_details", selectedSlot: options[index], slotOptions: undefined }; });
    user.booking = { ...user.booking, status: "awaiting_details", selectedSlot: options[index] };
    return { response: language === "arabic" ? "ما الغرض المختصر من الاجتماع؟" : language === "greek" ? "Ποιος είναι ο σύντομος σκοπός της συνάντησης;" : "What is the brief purpose of the meeting?", event: null };
  }

  if (!bookingState) {
    await store.updateUser(userId, (draft) => {
      draft.booking = { status: "awaiting_details", startedAt: now.toISOString(), idempotencyKey: randomUUID(), calendarUnavailable };
    });
    const reply = calendarUnavailable
      ? (language === "arabic" ? `لا أستطيع التحقق من توفر التقويم الآن. أرسل التاريخ والوقت اللذين تفضلهما بين ${policy.startTime} و${policy.endTime} (${policy.timezone}) مع سبب مختصر، وسأطلب من الفريق مراجعتهما دون تأكيد الموعد.` : language === "greek" ? `Δεν μπορώ να επαληθεύσω τη διαθεσιμότητα του ημερολογίου τώρα. Στείλτε την ημερομηνία και ώρα που προτιμάτε μεταξύ ${policy.startTime} και ${policy.endTime} (${policy.timezone}) μαζί με σύντομο σκοπό, και θα ζητήσω από την ομάδα να τα ελέγξει χωρίς να επιβεβαιώσω το ραντεβού.` : `I can’t verify calendar availability right now. Send your preferred date and time between ${policy.startTime} and ${policy.endTime} (${policy.timezone}), plus a brief purpose, and I’ll ask the team to review it without confirming the appointment.`)
      : bookingPrompt(policy, language);
    return { response: isPlausibleCustomerName(user.profile?.name) ? reply : `${reply}\n\n${namePrompt(language)}`, event: null };
  }

  if (bookingState === "awaiting_details") {
    const dayPreference = bookingDayOffset(text, policy, now);
    if (dayPreference !== null) {
      if (calendarUnavailable) return { response: language === "arabic" ? "لا أستطيع عرض مواعيد مؤكدة الآن. أرسل وقتك المفضل وسأطلب من الفريق مراجعته دون ادعاء توفره." : language === "greek" ? "Δεν μπορώ να εμφανίσω επιβεβαιωμένες ώρες τώρα. Στείλτε την προτιμώμενη ώρα και θα ζητήσω από την ομάδα να την ελέγξει χωρίς να ισχυριστώ ότι είναι διαθέσιμη." : "I can’t show verified times right now. Send your preferred time and I’ll ask the team to review it without claiming it is available.", event: null };
      let slots = [];
      try { slots = await listCalendarSlots(policy, { now, count: 2, firstDayOffset: dayPreference, horizonDays: 1 }); }
      catch { calendarUnavailable = true; }
      if (calendarUnavailable) return { response: language === "arabic" ? "تعذر التحقق من التقويم الآن. أرسل وقتك المفضل لطلب مراجعته من الفريق." : language === "greek" ? "Δεν ήταν δυνατή η επαλήθευση του ημερολογίου. Στείλτε την ώρα που προτιμάτε για έλεγχο από την ομάδα." : "I couldn’t verify the calendar just now. Send your preferred time for the team to review.", event: null };
      if (!slots.length) return { response: language === "arabic" ? "لا توجد مواعيد متاحة مؤكدة في ذلك اليوم. اختر اليوم الآخر أو أرسل تاريخًا ووقتًا آخر." : language === "greek" ? "Δεν βρέθηκαν διαθέσιμες επιβεβαιωμένες ώρες εκείνη την ημέρα. Επιλέξτε την άλλη ημέρα ή στείλτε άλλη ημερομηνία και ώρα." : "I couldn’t find a verified available time that day. Choose the other day or send another date and time.", event: null };
      const slotOptions = slots.map(({ start, end }) => ({ start: start.toISOString(), end: end.toISOString() }));
      await store.updateUser(userId, (draft) => { draft.booking = { ...draft.booking, status: "awaiting_slot_choice", slotOptions }; });
      const listed = slotOptions.map((slot, i) => `${i + 1}. ${formatBookingTime(new Date(slot.start), policy, language)}`).join(language === "arabic" ? "، " : "; ");
      return { response: language === "arabic" ? `هذه مواعيد متاحة حاليًا: ${listed}. اختر 1 أو 2.` : language === "greek" ? `Αυτές οι ώρες είναι διαθέσιμες τώρα: ${listed}. Επιλέξτε 1 ή 2.` : `These times are currently available: ${listed}. Choose 1 or 2.`, event: null, slots: slotOptions };
    }
    const name = !isPlausibleCustomerName(user.profile?.name) ? (extractCustomerName(text) || extractBookingNameReply(text)) : null;
    if (name && typeof store.updateUser === "function") {
      await store.updateUser(userId, (draft) => { draft.profile = { ...(draft.profile || {}), name }; });
      const acknowledgment = language === "arabic" ? `تشرفت بك يا ${name}.` : language === "greek" ? `Χάρηκα για τη γνωριμία, ${name}.` : `Nice to meet you, ${name}.`;
      return { response: `${acknowledgment} ${bookingPrompt(policy, language)}`, event: null };
    }
    const details = user.booking?.selectedSlot
      ? { start: new Date(user.booking.selectedSlot.start), end: new Date(user.booking.selectedSlot.end), purpose: String(text || "").trim() }
      : parseBookingDetails(text, policy, now);
    if (!details) {
      return {
        response: language === "arabic"
          ? "أرسل تاريخًا ووقتًا واضحين، مثل الثلاثاء الساعة 10:30، مع سبب مختصر لاجتماع متعلق بالشركة."
          : language === "greek"
            ? "Στείλτε μια σαφή ημερομηνία/ώρα και τον σκοπό, για παράδειγμα: Τρίτη 10:30 για να συζητήσουμε έργα της Refalco Group."
            : "Please send a clear date/time and purpose, for example: Tuesday 10:30 to discuss Refalco Group projects.",
        event: null
      };
    }
    if (!details.purpose && user.booking?.purpose) details.purpose = user.booking.purpose;
    if (!details.purpose) {
      return {
        response: language === "arabic"
          ? "وصلني اليوم والوقت، لكن أحتاج معرفة موضوع الاجتماع. أرسل اليوم والوقت مع سبب مختصر، مثل: الثلاثاء الساعة 10:30 لمناقشة طلب الفيزا."
          : language === "greek"
            ? "Έχω την ημερομηνία και την ώρα, αλλά χρειάζομαι ακόμα τον σκοπό της συνάντησης. Στείλτε και τα δύο μαζί, για παράδειγμα: Τρίτη 10:30 για να συζητήσουμε την αίτηση βίζας μου."
            : "I have the date and time, but still need the meeting purpose. Please send both together, for example: Tuesday 10:30 to discuss my visa application.",
        event: null
      };
    }
    const normalizedAppointmentDetails = normalizeAppointmentDetails({ user, purpose: details.purpose, timezone: policy.timezone, language, format: user.profile?.meetingFormat });
    if (!normalizedAppointmentDetails.ready) {
      const labels = { name: "name", phone: "phone or WhatsApp number", email: "email", company: "company", topic: "meeting topic", language: "preferred language", timezone: "timezone", format: "meeting format" };
      const missing = normalizedAppointmentDetails.missingRequired.map((field) => labels[field] || field);
      return {
        response: language === "arabic"
          ? `لترتيب الموعد بشكل صحيح، أحتاج أيضًا إلى: ${missing.join("، ")}. أرسل هذه التفاصيل من فضلك.`
          : language === "greek"
            ? `Πριν ζητήσω αυτό το ραντεβού, χρειάζομαι ακόμα: ${missing.join(", ")}. Στείλτε αυτές τις πληροφορίες.`
            : `Before I request this appointment, I still need: ${missing.join(", ")}. Please send those details.`,
        event: null
      };
    }
    const issue = appointmentWindowIssue(details.start, details.end, policy, now);
    if (issue === "notice") return {
      response: language === "arabic"
        ? `اختر موعدًا يبعد ${policy.minimumNoticeHours} ساعة على الأقل من الآن.`
        : language === "greek"
          ? `Επιλέξτε ώρα τουλάχιστον ${policy.minimumNoticeHours} ώρες από τώρα.`
          : `Please choose a time at least ${policy.minimumNoticeHours} hours from now.`,
      event: null
    };
    if (issue === "hours") return {
      response: language === "arabic"
        ? `المواعيد متاحة بين ${policy.startTime} و${policy.endTime} (${policy.timezone}) في أيام العمل المحددة. اختر وقتًا آخر.`
        : language === "greek"
          ? `Τα ραντεβού είναι διαθέσιμα ${policy.startTime}-${policy.endTime} (${policy.timezone}) τις καθορισμένες εργάσιμες ημέρες. Επιλέξτε άλλη ώρα.`
          : `Meetings are available ${policy.startTime}-${policy.endTime} (${policy.timezone}) on the configured weekdays. Please choose another time.`,
      event: null
    };

    let available = false;
    if (!calendarUnavailable) {
      try { available = await isAvailable(details, policy); }
      catch { calendarUnavailable = true; }
    }
    if (!available && !calendarUnavailable) {
      return {
        response: language === "arabic"
          ? `هذا الموعد غير متاح. ${bookingPrompt(policy, language)}`
          : language === "greek"
            ? `Αυτή η ώρα δεν είναι διαθέσιμη. ${bookingPrompt(policy, language)}`
            : `That time is not available. ${bookingPrompt(policy, language)}`,
        event: null
      };
    }

    if (typeof store.createAppointment !== "function") {
      await store.updateUser(userId, (draft) => { draft.booking = { ...draft.booking, status: "failed" }; });
      return { response: language === "arabic" ? "تعذر حفظ طلب الموعد بأمان. لم يتم تأكيد أي موعد." : language === "greek" ? "Δεν ήταν δυνατή η ασφαλής αποθήκευση του αιτήματος. Δεν επιβεβαιώθηκε ραντεβού." : "I couldn’t safely save the appointment request. No appointment was confirmed.", event: null };
    }
    const appointmentDetails = normalizeAppointmentDetails({ user, purpose: details.purpose, timezone: policy.timezone, language, format: user.profile?.meetingFormat });
    let created;
    try {
      created = await store.createAppointment({
        userId,
        startsAt: details.start.toISOString(),
        endsAt: details.end.toISOString(),
        timezone: policy.timezone,
        durationMinutes: policy.durationMinutes,
        purpose: details.purpose,
        idempotencyKey: user.booking.idempotencyKey || randomUUID(),
        calendarId: calendarId(policy),
        status: "awaiting_customer_confirmation",
        metadata: { appointmentDetails, availabilityVerified: !calendarUnavailable }
      });
    } catch (error) {
      await store.updateUser(userId, (draft) => { draft.booking = { ...draft.booking, status: "failed" }; });
      return { response: language === "arabic" ? "تعذر حفظ طلب الموعد. لم يتم تأكيد أي موعد؛ حاول مرة أخرى لاحقًا." : language === "greek" ? "Δεν ήταν δυνατή η αποθήκευση του αιτήματος. Δεν έχει επιβεβαιωθεί ραντεβού· δοκιμάστε ξανά αργότερα." : "I couldn’t save the appointment request. No appointment is confirmed; please try again later.", event: null, error };
    }
    const appointment = created?.appointment || created;
    if (!appointment?.id || appointment.conflict || appointment.status !== "awaiting_customer_confirmation") {
      await store.updateUser(userId, (draft) => { draft.booking = { ...draft.booking, status: "failed" }; });
      return { response: language === "arabic" ? "لم أتمكن من حفظ طلب الموعد في الحالة الصحيحة. لم يتم تأكيد موعد." : language === "greek" ? "Δεν αποθηκεύτηκε το αίτημα στη σωστή κατάσταση. Δεν επιβεβαιώθηκε ραντεβού." : "I couldn’t save the appointment request in the correct state. No appointment was confirmed.", event: null };
    }

    await store.updateUser(userId, (draft) => {
      draft.booking = {
        status: "awaiting_confirmation",
        startedAt: user.booking.startedAt,
        idempotencyKey: user.booking.idempotencyKey || randomUUID(),
        appointmentId: appointment.id,
        start: details.start.toISOString(),
        end: details.end.toISOString(),
        purpose: details.purpose,
        calendarUnavailable
      };
    });

    if (calendarUnavailable) {
      const time = formatBookingTime(details.start, policy, language);
      return {
        response: language === "arabic"
          ? `لا أستطيع تأكيد توفر ${time}. هل تريد مني إرسال طلب لهذا الوقت إلى الفريق لمراجعته؟ أجب بنعم أو لا.`
          : language === "greek"
            ? `Δεν μπορώ να επιβεβαιώσω ότι η ώρα ${time} είναι διαθέσιμη. Θέλετε να στείλω αίτημα για αυτή την ώρα στην ομάδα για έλεγχο; Απαντήστε ναι ή όχι.`
            : `I can’t verify that ${time} is available. Would you like me to send a request for this exact time to the team for review? Please reply yes or no.`,
        event: null
      };
    }

    return {
      response: language === "arabic"
        ? `الموعد متاح: ${formatBookingTime(details.start, policy, language)} لمدة ${policy.durationMinutes} دقيقة. الغرض: ${details.purpose}. للتأكيد على هذا الوقت المحدد، أجب بنعم، ${exactBookingTime(details.start, policy)}، أو أجب لا لاختيار وقت آخر.`
        : language === "greek"
          ? `Βρήκα διαθέσιμη ώρα: ${formatBookingTime(details.start, policy, language)} για ${policy.durationMinutes} λεπτά. Σκοπός: ${details.purpose}. Για επιβεβαίωση αυτής της ώρας, απαντήστε «ναι, ${exactBookingTime(details.start, policy)}», ή όχι για άλλη ώρα.`
        : `I found that time available: ${formatBookingTime(details.start, policy, language)} for ${policy.durationMinutes} minutes. Purpose: ${details.purpose}. To confirm this exact time, reply yes with the time (for example, “yes, 11:00”); reply no to choose another time.`,
      event: null
    };
  }

  if (bookingState === "awaiting_confirmation") {
    const answer = String(text || "").trim().toLowerCase();
    if (/^(no|nope|cancel|لا|مش|όχι|άκυρο|ακύρωση)$/.test(answer)) {
      if (user.booking.appointmentId) {
        try { await store.updateAppointment(user.booking.appointmentId, { status: "cancelled", cancelledAt: now.toISOString() }); }
        catch (error) {
          return { response: language === "arabic" ? "تعذر إلغاء طلب الموعد في النظام الآن. لم يتم إنشاء حدث تقويم." : language === "greek" ? "Δεν ήταν δυνατή η ακύρωση του αιτήματος τώρα. Δεν δημιουργήθηκε συμβάν ημερολογίου." : "I couldn’t cancel the appointment request in the system just now. No calendar event was created.", event: null, error };
        }
      }
      await store.updateUser(userId, (draft) => { draft.booking = null; });
      return { response: language === "arabic" ? `لا مشكلة. ${bookingPrompt(policy, language)}` : language === "greek" ? `Κανένα πρόβλημα. ${bookingPrompt(policy, language)}` : `No problem. ${bookingPrompt(policy, language)}`, event: null };
    }
    if (!isExactBookingConfirmation(text, new Date(user.booking.start), policy)) {
      const time = formatBookingTime(new Date(user.booking.start), policy, language);
      const exactTime = exactBookingTime(new Date(user.booking.start), policy);
      return { response: language === "arabic" ? `للتأكيد، أعد إرسال «نعم، ${exactTime}» مع وقت الموعد المحدد (${time})، أو أجب لا لاختيار وقت آخر.` : language === "greek" ? `Για επιβεβαίωση, απαντήστε «ναι, ${exactTime}» με την ακριβή ώρα (${time}), ή όχι για άλλη ώρα.` : `To confirm, reply yes with the exact appointment time (${exactTime}), or no to choose another time.`, event: null };
    }

    const details = {
      start: new Date(user.booking.start),
      end: new Date(user.booking.end),
      purpose: user.booking.purpose
    };
    const issue = appointmentWindowIssue(details.start, details.end, policy, now);
    if (issue) {
      if (user.booking.appointmentId) await store.updateAppointment(user.booking.appointmentId, { status: "failed" });
      await store.updateUser(userId, (draft) => { draft.booking = { status: "awaiting_details", startedAt: now.toISOString(), idempotencyKey: randomUUID() }; });
      return { response: language === "arabic" ? `لم يعد الوقت المقترح ضمن مواعيد الحجز. ${bookingPrompt(policy, language)}` : language === "greek" ? `Αυτή η προτεινόμενη ώρα δεν είναι πλέον εντός του παραθύρου κράτησης. ${bookingPrompt(policy, language)}` : `That proposed time is no longer within the booking window. ${bookingPrompt(policy, language)}`, event: null };
    }
    let available = false;
    let calendarUnavailable = Boolean(user.booking.calendarUnavailable);
    if (!calendarUnavailable) {
      try { available = await isAvailable(details, policy); }
      catch { calendarUnavailable = true; }
    }
    if (!available && !calendarUnavailable) {
      if (user.booking.appointmentId) await store.updateAppointment(user.booking.appointmentId, { status: "failed" });
      await store.updateUser(userId, (draft) => { draft.booking = { status: "awaiting_details", startedAt: now.toISOString(), idempotencyKey: randomUUID() }; });
      return { response: language === "arabic" ? `لم يعد هذا الموعد متاحًا. ${bookingPrompt(policy, language)}` : language === "greek" ? `Αυτή η ώρα δεν είναι πλέον διαθέσιμη. ${bookingPrompt(policy, language)}` : `That time is no longer available. ${bookingPrompt(policy, language)}`, event: null };
    }

    if (typeof store.updateAppointment !== "function" || !user.booking.appointmentId) {
      throw new Error("The durable Supabase appointment store is unavailable.");
    }
    let appointment;
    try { appointment = await store.updateAppointment(user.booking.appointmentId, { status: "creating" }); }
    catch (error) {
      let current = null;
      if (typeof store.getAppointment === "function") {
        try { current = await store.getAppointment(user.booking.appointmentId); } catch { /* Preserve the guarded conflict response. */ }
      }
      if (current?.status === "confirmed" && current.google_event_id) {
        await store.updateUser(userId, (draft) => { draft.booking = { ...draft.booking, status: "booked", appointmentId: current.id, eventId: current.google_event_id, bookedAt: current.confirmed_at }; });
        return { response: bookingConfirmationMessage(details.start, policy, language, current.google_meet_url || ""), event: null, appointment: current };
      }
      if (current?.status === "pending_calendar") {
        await store.updateUser(userId, (draft) => { draft.booking = { ...draft.booking, status: "pending_calendar", appointmentId: current.id }; });
        return { response: language === "arabic" ? "طلب هذا الموعد قيد مراجعة الفريق. لم يتم تأكيد الموعد." : language === "greek" ? "Το αίτημα ραντεβού βρίσκεται υπό έλεγχο από την ομάδα. Δεν έχει επιβεβαιωθεί." : "The appointment request is under team review. It is not confirmed.", event: null, appointment: current, details, user, policy };
      }
      if (current?.status === "creating") {
        await store.updateUser(userId, (draft) => { draft.booking = { ...draft.booking, status: "creating", appointmentId: current.id }; });
        return { response: language === "arabic" ? "طلبك قيد المعالجة الآن. لم أؤكد الموعد بعد." : language === "greek" ? "Το αίτημά σας βρίσκεται σε επεξεργασία. Δεν έχει επιβεβαιωθεί ακόμη." : "Your request is being processed. The appointment is not confirmed yet.", event: null };
      }
      throw error;
    }
    await store.updateUser(userId, (draft) => { draft.booking = { ...draft.booking, status: "creating" }; });
    if (!appointment?.id || appointment.status !== "creating") {
      return { response: language === "arabic" ? "تعذر بدء حفظ الموعد بأمان. لم يتم تأكيد أي موعد." : language === "greek" ? "Δεν ήταν δυνατή η ασφαλής έναρξη αποθήκευσης του ραντεβού. Δεν επιβεβαιώθηκε ραντεβού." : "I couldn’t safely start saving the appointment. No appointment was confirmed.", event: null };
    }
    if (calendarUnavailable) {
      appointment = await store.updateAppointment(appointment.id, { status: "pending_calendar", metadata: { ...(appointment.metadata || {}), availabilityVerified: false } });
      await store.updateUser(userId, (draft) => { draft.booking = { ...draft.booking, status: "pending_calendar", appointmentId: appointment.id }; });
      if (appointment?.status !== "pending_calendar") throw new Error("Could not save the appointment for calendar review.");
      return {
        response: language === "arabic"
          ? `أُرسل طلبك للموعد المفضل ${formatBookingTime(details.start, policy, language)} إلى الفريق للمراجعة. لم يتم التحقق من توفر الوقت أو تأكيد الموعد.`
          : language === "greek"
            ? `Το αίτημά σας για την προτιμώμενη ώρα ${formatBookingTime(details.start, policy, language)} στάλθηκε στην ομάδα για έλεγχο. Η διαθεσιμότητα δεν επαληθεύτηκε και το ραντεβού δεν έχει επιβεβαιωθεί.`
            : `Your request for ${formatBookingTime(details.start, policy, language)} has been sent to the team for review. Availability was not verified and the appointment is not confirmed.`,
        event: null, appointment, details, user, policy
      };
    }

    const eventId = `rafa${appointment.id.replace(/-/g, "")}`;
    let event;
    try {
      event = await createBookingEvent({ user, userId, details, eventId, policy });
    } catch (error) {
      appointment = await store.updateAppointment(appointment.id, { status: "pending_calendar", metadata: { ...(appointment.metadata || {}), availabilityVerified: true, calendarError: String(error?.message || error).slice(0, 200) } });
      await store.updateUser(userId, (draft) => { draft.booking = { ...draft.booking, status: "pending_calendar", appointmentId: appointment.id }; });
      return { response: language === "arabic" ? "تعذر إنشاء حدث التقويم. أرسلت طلبك للفريق للمراجعة؛ لم يتم تأكيد الموعد." : language === "greek" ? "Δεν ήταν δυνατή η δημιουργία συμβάντος ημερολογίου. Έστειλα το αίτημα στην ομάδα για έλεγχο· το ραντεβού δεν έχει επιβεβαιωθεί." : "I couldn’t create the calendar event. I’ve sent your request to the team for review; the appointment is not confirmed.", event: null, appointment, details, user, policy, error };
    }
    let savedAppointment;
    try {
      savedAppointment = await store.updateAppointment(appointment.id, {
        status: "confirmed",
        googleEventId: event.id,
        googleEventUrl: event.htmlLink || "",
        googleMeetUrl: event.meetLink || "",
        confirmedAt: now.toISOString()
      });
    } catch (error) {
      try {
        savedAppointment = await store.updateAppointment(appointment.id, {
          status: "pending_calendar",
          googleEventId: event.id,
          googleEventUrl: event.htmlLink || "",
          googleMeetUrl: event.meetLink || "",
          metadata: { ...(appointment.metadata || {}), availabilityVerified: true, reconciliationRequired: true }
        });
      } catch { savedAppointment = null; }
      await store.updateUser(userId, (draft) => { draft.booking = { ...draft.booking, status: "pending_calendar", appointmentId: appointment.id }; });
      return { response: language === "arabic" ? "تم إنشاء حدث التقويم لكن تعذر حفظ التأكيد. أبلغت الفريق للمراجعة؛ لم أتمكن من تأكيد الموعد." : language === "greek" ? "Δημιουργήθηκε συμβάν ημερολογίου, αλλά δεν αποθηκεύτηκε η επιβεβαίωση. Ενημέρωσα την ομάδα για έλεγχο· δεν μπορώ να επιβεβαιώσω το ραντεβού." : "The calendar event was created, but I couldn’t save the confirmation. I’ve flagged it for review; I can’t confirm the appointment.", event: null, appointment: savedAppointment || { ...appointment, status: "creating", google_event_id: event.id, metadata: { ...(appointment.metadata || {}), reconciliationRequired: true } }, details, user, policy, error };
    }
    if (savedAppointment?.status !== "confirmed") {
      try { await store.updateAppointment(appointment.id, { status: "pending_calendar", googleEventId: event.id, googleEventUrl: event.htmlLink || "", googleMeetUrl: event.meetLink || "", metadata: { ...(appointment.metadata || {}), availabilityVerified: true, reconciliationRequired: true } }); } catch { /* Durable creating state remains visible for reconciliation. */ }
      return { response: language === "arabic" ? "تم إنشاء حدث التقويم لكن تعذر حفظ التأكيد. أبلغت الفريق للمراجعة؛ لم أتمكن من تأكيد الموعد." : language === "greek" ? "Δημιουργήθηκε συμβάν ημερολογίου, αλλά δεν αποθηκεύτηκε η επιβεβαίωση. Ενημέρωσα την ομάδα για έλεγχο· δεν μπορώ να επιβεβαιώσω το ραντεβού." : "The calendar event was created, but I couldn’t save the confirmation. I’ve flagged it for review; I can’t confirm the appointment.", event: null, appointment: { ...appointment, google_event_id: event.id, status: "pending_calendar" }, details, user, policy };
    }
    await scheduleBookingReminders({ store, appointment: savedAppointment, userId, now, policy });
    await store.updateUser(userId, (draft) => {
        draft.booking = { ...draft.booking, status: "booked", bookedAt: now.toISOString(), eventId: event.id, meetLink: event.meetLink || "", appointmentId: appointment.id };
    });

    return {
      response: bookingConfirmationMessage(details.start, policy, language, event.meetLink),
      event: event._rafaAlreadyExisted ? null : event,
      details,
      user,
      policy
    };
  }

  return null;
}

function extractBookingNameReply(text) {
  const raw = String(text || "").normalize("NFKC").trim();
  if (/[؟?]/u.test(raw)) return null;
  const value = raw.replace(/[.!،]+$/u, "").trim();
  const words = value.split(/\s+/u);
  if (!value || value.length > 60 || words.length > 2 || !/^[\p{L}][\p{L}'’-]*(?:\s+[\p{L}][\p{L}'’-]*)?$/u.test(value)) return null;
  if (/^(?:i|im|i'm|dont|don't|no|not|need|want|what|how|why|where|when|who|business|company|business|service|services|price|cost|formation|meeting|appointment|hi|hello|hey|مرحبا|مرحبًا|أهلا|اهلا|سلام|شو|ماذا|ما|كيف|ليش|وين|متى|نعم|لا|مش|مو|بدي|اريد|أريد|شركة|خدمات|الخدمات|موعد|اجتماع|اليوم|غدا|بكرة|ευχαριστώ|όχι|δεν|θέλω|εταιρεία|υπηρεσίες)$/iu.test(value)) return null;
  return value;
}

function isBookingDecline(text) {
  const value = String(text || "").normalize("NFKC").toLocaleLowerCase().trim().replace(/[.!،؟?]+$/u, "");
  return /^(?:no\s*(?:need(?:\s+to)?|thanks?)|not\s+now|i\s*(?:do\s+not|don't|dont)\s+want(?:\s+to)?(?:\s+.*)?|i\s*(?:do\s+not|don't|dont)\s+need(?:\s+.*)?|لا\s*داعي(?:\s+.*)?|ما\s*بدي(?:\s+.*)?|مش\s*(?:حابب|حابة|محتاج)(?:\s+.*)?|لا\s*أريد(?:\s+.*)?|δεν\s+θέλω(?:\s+.*)?|όχι\s+τώρα)$/iu.test(value);
}

function isBookingDetailsReply(text, allowContextualName = false) {
  if (extractCustomerName(text)) return true;
  if (allowContextualName && extractBookingNameReply(text)) return true;
  // REFAL-AGENT-014: this gate had no Greek lexical markers at all, so a
  // Greek customer's date/time reply during booking was silently dropped
  // (handleBookingMessage returned null — no response sent). Added Greek
  // weekday/time words mirroring the EN/AR lists above, plus a
  // language-neutral numeric date/time pattern (digits alone, e.g. a
  // customer writing "2026-01-05 10:00", carry no language and should be
  // recognized regardless of which language words surround them).
  return /\b(?:date|time|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|am|pm|at\s+\d{1,2})\b|تاريخ|وقت|الساعة|بكرة|غدا|غدًا|الاثنين|الثلاثاء|الأربعاء|الخميس|الجمعة|السبت|الأحد|ώρα|ημερομηνία|σήμερα|αύριο|δευτέρα|τρίτη|τετάρτη|τέταρτη|πέμπτη|παρασκευή|σάββατο|κυριακή|\d{1,2}:\d{2}|\d{4}-\d{2}-\d{2}/iu.test(String(text || ""));
}

function isBookingConfirmationReply(text) {
  const value = String(text || "").trim();
  const affirmative = "(?:yes|yeah|yep|confirm|confirmed|نعم|اي|أيوه|ναι|επιβεβαίωση|επιβεβαιώνω)";
  return new RegExp(`^(?:${affirmative}|${affirmative}[,.،\\s]*(?:at\\s*)?[0-9٠-٩]{1,2}[:٫][0-9٠-٩]{2}|no|nope|cancel|that works|sounds good|لا|مش|الغاء|إلغاء|όχι|άκυρο|ακύρωση)[.!،\\s]*$`, "iu").test(value);
}

function slotChoiceIndex(text, options) {
  const choice = String(text || "").trim();
  const index = /^(?:1|one|١|ένα)$/iu.test(choice) ? 0 : /^(?:2|two|٢|δύο)$/iu.test(choice) ? 1 : -1;
  return Array.isArray(options) && options[index] ? index : -1;
}

function exactBookingTime(start, policy) {
  const local = partsAt(start, policy.timezone);
  return `${local.hour}:${local.minute}`;
}

function isExactBookingConfirmation(text, start, policy) {
  const raw = normalizeBookingText(String(text || "")).toLocaleLowerCase();
  const local = partsAt(start, policy.timezone);
  const match = raw.match(/^(?:yes|yeah|yep|confirm|confirmed|نعم|اي|أيوه|ναι|επιβεβαιώνω|επιβεβαίωση)[,،\s]+(?:at\s*)?(\d{1,2})[:٫](\d{2})$/iu);
  return Boolean(match && String(Number(match[1])).padStart(2, "0") === local.hour && match[2] === local.minute);
}

function bookingConfirmationMessage(start, policy, language = "english", meetLink = "") {
  const time = formatBookingTime(start, policy, language);
  if (language === "arabic") {
    return meetLink ? `تم تأكيد الموعد: ${time}. رابط Google Meet: ${meetLink}` : `تم تأكيد الموعد: ${time}.`;
  }
  if (language === "greek") {
    return meetLink ? `Επιβεβαιώθηκε. Το ραντεβού σας έχει κλειστεί για ${time}. Google Meet: ${meetLink}` : `Επιβεβαιώθηκε. Το ραντεβού σας έχει κλειστεί για ${time}.`;
  }
  return meetLink ? `Confirmed. Your meeting is booked for ${time}. Google Meet: ${meetLink}` : `Confirmed. Your meeting is booked for ${time}.`;
}

function calendarAccessFailure(language) {
  if (language === "arabic") return "تعذر الوصول إلى تقويم الشركة حاليًا، لذلك لا يمكنني تأكيد المواعيد الآن. يُرجى التواصل مع فريق الشركة مباشرة.";
  if (language === "greek") return "Δεν είναι δυνατή αυτή τη στιγμή η πρόσβαση στο ημερολόγιο της Refalco Group, οπότε δεν μπορώ να επιβεβαιώσω ραντεβού τώρα. Επικοινωνήστε απευθείας με την ομάδα της Refalco Group.";
  return "REFAL cannot currently access Refalco Group's calendar, so I can't book an appointment right now. Please contact Refalco Group team directly.";
}

module.exports = {
  bookingPrompt,
  bookingConfirmationMessage,
  createBookingEvent,
  isAvailable,
  formatBookingTime,
  handleBookingMessage,
  hasCalendarConfig,
  hasOAuthCalendarCredentials,
  googleAuth,
  verifyCalendarAccess,
  calendarId,
  isBookingRequest,
  extractBookingNameReply,
  listCalendarSlots,
  // Backwards-compatible alias for older internal callers.
  suggestAvailableTimes: listCalendarSlots,
  appointmentWindowIssue,
  appointmentChangeIntent,
  approvePendingAppointment,
  changeAppointmentStatus,
  parseBookingDetails,
  CUSTOMER_BOOKING_URL
};
