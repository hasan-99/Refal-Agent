const { randomUUID } = require("node:crypto");
const { google } = require("googleapis");
const chrono = require("chrono-node");
const { validateBookingPolicy } = require("./bookingPolicy.js");
const { detectMessageLanguage } = require("./language.js");
const { restrictedRefalcoReply } = require("./refalcoAnswer.js");
const { extractCustomerName, namePrompt, isPlausibleCustomerName } = require("./messageRouter.js");
const { normalizeAppointmentDetails } = require("./appointmentDetails.js");

const CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events.owned",
  "https://www.googleapis.com/auth/calendar.events.freebusy"
];
const CUSTOMER_BOOKING_URL = "https://calendar.app.google/Ny3HQG1iwmF3T5s58";
let calendarApprovalQueue = Promise.resolve();

function isBookingRequest(text) {
  const value = String(text || "").toLowerCase();
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
  const input = normalizeArabicBookingText(text);
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
    policy.createMeetLink &&
    policy.durationOwnerConfirmed && policy.durationMinutes &&
    policy.minimumNoticeHours !== null && policy.reminderHours.length
  );
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
  if (!event.meetLink) throw new Error("Google Calendar did not return a Meet link. The appointment remains pending review; check Calendar conference settings and retry.");
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
  if (!["confirmed", "pending_review"].includes(appointment.status)) throw new Error("Only a confirmed or pending appointment can be changed.");
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

async function suggestAvailableTimes(policyValue, { now = new Date(), count = 3, horizonDays = 21 } = {}) {
  const policy = validateBookingPolicy(policyValue);
  const today = partsAt(now, policy.timezone);
  const firstDay = Date.UTC(Number(today.year), Number(today.month) - 1, Number(today.day)) + 86400000;
  const startMinute = Number(policy.startTime.slice(0, 2)) * 60 + Number(policy.startTime.slice(3));
  const endMinute = Number(policy.endTime.slice(0, 2)) * 60 + Number(policy.endTime.slice(3));
  const candidates = [];
  for (let dayOffset = 1; dayOffset <= horizonDays && candidates.length < 500; dayOffset++) {
    const day = new Date(firstDay + (dayOffset - 1) * 86400000);
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
    return withMeetLink(response.data, false);
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
      return withMeetLink(updated.data, true);
    }
    return withMeetLink(existing, true);
  }
}

function withMeetLink(event, alreadyExisted) {
  const meetLink = event?.hangoutLink ||
    (event?.conferenceData?.entryPoints || []).find((entry) => entry.entryPointType === "video" && /^https:\/\/meet\.google\.com\//.test(entry.uri || ""))?.uri ||
    "";
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
  if (language === "arabic") return `أرسل اليوم والوقت المفضلين بين ${policy.startTime} و${policy.endTime} (${policy.timezone}) مع سبب مختصر، أو اختر موعدك مباشرة من هنا: ${CUSTOMER_BOOKING_URL}`;
  if (language === "greek") return `Στείλτε την προτιμώμενη ημέρα και ώρα μεταξύ ${policy.startTime} και ${policy.endTime} (${policy.timezone}), μαζί με σύντομο σκοπό συνάντησης, ή επιλέξτε ώρα απευθείας εδώ: ${CUSTOMER_BOOKING_URL}`;
  return `Send your preferred weekday and time between ${policy.startTime} and ${policy.endTime} (${policy.timezone}), plus a brief meeting purpose, or choose a time directly here: ${CUSTOMER_BOOKING_URL}`;
}

function normalizeArabicBookingText(text) {
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
  return value;
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

  if (["awaiting_details", "awaiting_confirmation"].includes(bookingState)) {
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

  if (bookingState === "awaiting_details" && !isBookingDetailsReply(text, !isPlausibleCustomerName(user.profile?.name) && !user.profile?.nameOverride) && !changeIntent && !isBookingRequest(text)) return null;
  if (bookingState === "awaiting_confirmation" && !isBookingConfirmationReply(text) && !changeIntent && !isBookingRequest(text)) return null;
  if (bookingState && !["awaiting_details", "awaiting_confirmation"].includes(bookingState) && !changeIntent && !isBookingRequest(text)) return null;

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
        ? (language === "arabic" ? "تم إلغاء موعدك مع الشركة." : language === "greek" ? "Το ραντεβού σας με τη the business ακυρώθηκε." : "Your the business appointment has been cancelled.")
        : (language === "arabic" ? `تم تحديث الطلب. أرسل اليوم والوقت الجديدين مع سبب مختصر، وسأطلب من الفريق مراجعتهما.` : language === "greek" ? "Το αίτημα ενημερώθηκε. Στείλτε νέα ημέρα, ώρα και σύντομο σκοπό, και θα ζητήσω από την ομάδα να το εξετάσει." : "I’ve updated your request. Send a new day, time, and brief purpose, and I’ll ask the team to review it.");
      return { response, event: null, appointment: changed };
    } catch (error) {
      const response = error.calendarChanged
        ? (language === "arabic" ? "تم تحديث التقويم، لكن تعذر حفظ حالة الموعد في النظام. أبلغت فريق الشركة لمراجعة السجل." : language === "greek" ? "Το ημερολόγιο ενημερώθηκε, αλλά δεν ήταν δυνατή η αποθήκευση της κατάστασης του ραντεβού. Ενημέρωσα την ομάδα της the business να το ελέγξει." : "The calendar was updated, but I couldn’t save the appointment status. I’ve flagged it for the business team to reconcile.")
        : (language === "arabic" ? "تعذر تحديث الموعد في التقويم الآن، لذلك لم أغيّره. حاول مرة أخرى أو تواصل مع فريق الشركة." : language === "greek" ? "Δεν ήταν δυνατή η ενημέρωση του ραντεβού στο ημερολόγιο αυτή τη στιγμή, οπότε δεν άλλαξε. Δοκιμάστε ξανά ή επικοινωνήστε με τη the business." : "I couldn’t update the appointment in Google Calendar, so it has not been changed. Please try again or contact the business.");
      return { response, event: null, error };
    }
  }

  const policy = await store.getBookingPolicy();

  if (restrictedReply) return { response: restrictedReply, event: null };

  if (!hasCalendarConfig(policy)) {
    return {
      response: language === "arabic"
        ? `الحجز المباشر غير متاح حاليًا. يمكنك اختيار موعدك من هنا: ${CUSTOMER_BOOKING_URL}`
        : language === "greek"
          ? `Η απευθείας κράτηση δεν είναι διαθέσιμη αυτή τη στιγμή. Μπορείτε να επιλέξετε ώρα εδώ: ${CUSTOMER_BOOKING_URL}`
          : `Direct booking is unavailable right now. You can choose a time here: ${CUSTOMER_BOOKING_URL}`,
      event: null
    };
  }

  if (!bookingState) {
    try {
      await verifyCalendarAccess(policy, now);
    } catch {
      return { response: calendarAccessFailure(language), event: null };
    }
  }

  if (!bookingState) {
    await store.updateUser(userId, (draft) => {
      draft.booking = { status: "awaiting_details", startedAt: now.toISOString(), idempotencyKey: randomUUID() };
    });
    const prompt = bookingPrompt(policy, language);
    return { response: isPlausibleCustomerName(user.profile?.name) ? prompt : `${prompt}\n\n${namePrompt(language)}`, event: null };
  }

  if (bookingState === "awaiting_details") {
    const name = !isPlausibleCustomerName(user.profile?.name) ? (extractCustomerName(text) || extractBookingNameReply(text)) : null;
    if (name && typeof store.updateUser === "function") {
      await store.updateUser(userId, (draft) => { draft.profile = { ...(draft.profile || {}), name }; });
      const acknowledgment = language === "arabic" ? `تشرفت بك يا ${name}.` : language === "greek" ? `Χάρηκα για τη γνωριμία, ${name}.` : `Nice to meet you, ${name}.`;
      return { response: `${acknowledgment} ${bookingPrompt(policy, language)}`, event: null };
    }
    const details = parseBookingDetails(text, policy, now);
    if (!details) {
      return {
        response: language === "arabic"
          ? "أرسل تاريخًا ووقتًا واضحين، مثل الثلاثاء الساعة 10:30، مع سبب مختصر لاجتماع متعلق بالشركة."
          : language === "greek"
            ? "Στείλτε μια σαφή ημερομηνία/ώρα και τον σκοπό, για παράδειγμα: Τρίτη 10:30 για να συζητήσουμε έργα της the business."
            : "Please send a clear date/time and purpose, for example: Tuesday 10:30 to discuss the business projects.",
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

    let available;
    try { available = await isAvailable(details, policy); }
    catch { return { response: calendarAccessFailure(language), event: null }; }
    if (!available) {
      return {
        response: language === "arabic"
          ? `هذا الموعد غير متاح. ${bookingPrompt(policy, language)}`
          : language === "greek"
            ? `Αυτή η ώρα δεν είναι διαθέσιμη. ${bookingPrompt(policy, language)}`
            : `That time is not available. ${bookingPrompt(policy, language)}`,
        event: null
      };
    }

    await store.updateUser(userId, (draft) => {
      draft.booking = {
        status: "awaiting_confirmation",
        startedAt: user.booking.startedAt,
        idempotencyKey: user.booking.idempotencyKey || randomUUID(),
        start: details.start.toISOString(),
        end: details.end.toISOString(),
        purpose: details.purpose
      };
    });

    return {
      response: language === "arabic"
        ? `الموعد متاح: ${formatBookingTime(details.start, policy, language)} لمدة ${policy.durationMinutes} دقيقة. الغرض: ${details.purpose}. أجب بنعم للتأكيد أو لا لاختيار وقت آخر.`
        : language === "greek"
          ? `Βρήκα διαθέσιμη ώρα: ${formatBookingTime(details.start, policy, language)} για ${policy.durationMinutes} λεπτά. Σκοπός: ${details.purpose}. Απαντήστε ναι για επιβεβαίωση ή όχι για άλλη ώρα.`
          : `I found that time available: ${formatBookingTime(details.start, policy, language)} for ${policy.durationMinutes} minutes. Purpose: ${details.purpose}. Reply yes to confirm or no to choose another time.`,
      event: null
    };
  }

  if (bookingState === "awaiting_confirmation") {
    const answer = String(text || "").trim().toLowerCase();
    if (/^(no|nope|cancel|لا|مش|όχι|άκυρο|ακύρωση)$/.test(answer)) {
      await store.updateUser(userId, (draft) => { draft.booking = null; });
      return { response: language === "arabic" ? `لا مشكلة. ${bookingPrompt(policy, language)}` : language === "greek" ? `Κανένα πρόβλημα. ${bookingPrompt(policy, language)}` : `No problem. ${bookingPrompt(policy, language)}`, event: null };
    }
    if (!/^(yes|yeah|yep|confirm|confirmed|نعم|اي|أيوه|ναι|επιβεβαίωση|επιβεβαιώνω)$/.test(answer)) {
      return { response: language === "arabic" ? "أجب بنعم لتأكيد الموعد أو لا لاختيار وقت آخر." : language === "greek" ? "Απαντήστε ναι για να επιβεβαιώσετε αυτή την ώρα, ή όχι για να επιλέξετε άλλη." : "Please reply yes to confirm this time, or no to choose another.", event: null };
    }

    const details = {
      start: new Date(user.booking.start),
      end: new Date(user.booking.end),
      purpose: user.booking.purpose
    };
    const issue = appointmentWindowIssue(details.start, details.end, policy, now);
    if (issue) {
      await store.updateUser(userId, (draft) => { draft.booking = { status: "awaiting_details", startedAt: now.toISOString(), idempotencyKey: randomUUID() }; });
      return { response: language === "arabic" ? `لم يعد الوقت المقترح ضمن مواعيد الحجز. ${bookingPrompt(policy, language)}` : language === "greek" ? `Αυτή η προτεινόμενη ώρα δεν είναι πλέον εντός του παραθύρου κράτησης. ${bookingPrompt(policy, language)}` : `That proposed time is no longer within the booking window. ${bookingPrompt(policy, language)}`, event: null };
    }
    let available;
    try { available = await isAvailable(details, policy); }
    catch { return { response: calendarAccessFailure(language), event: null }; }
    if (!available) {
      await store.updateUser(userId, (draft) => { draft.booking = { status: "awaiting_details", startedAt: now.toISOString(), idempotencyKey: randomUUID() }; });
      return { response: language === "arabic" ? `لم يعد هذا الموعد متاحًا. ${bookingPrompt(policy, language)}` : language === "greek" ? `Αυτή η ώρα δεν είναι πλέον διαθέσιμη. ${bookingPrompt(policy, language)}` : `That time is no longer available. ${bookingPrompt(policy, language)}`, event: null };
    }

    if (typeof store.createAppointment !== "function" || typeof store.updateAppointment !== "function") {
      throw new Error("The durable Supabase appointment store is unavailable.");
    }
    const appointmentDetails = normalizeAppointmentDetails({ user, purpose: details.purpose, timezone: policy.timezone, language, format: user.profile?.meetingFormat });
    if (!appointmentDetails.ready) throw new Error("Required appointment details are missing.");
    let { appointment } = await store.createAppointment({
      userId,
      startsAt: details.start.toISOString(),
      endsAt: details.end.toISOString(),
      timezone: policy.timezone,
      durationMinutes: policy.durationMinutes,
      purpose: details.purpose,
      idempotencyKey: user.booking.idempotencyKey || randomUUID(),
      calendarId: calendarId(policy),
      metadata: { appointmentDetails }
    });
    if (!appointment?.id) throw new Error("Could not create a durable appointment record.");

    if (["pending_calendar", "failed", "rejected", "rescheduled"].includes(appointment.status)) {
      appointment = await store.updateAppointment(appointment.id, { status: "pending_review" });
    }
    if (!appointment?.id) throw new Error("Could not save the appointment for administrator review.");

    if (appointment.status === "pending_review") {
      await store.updateUser(userId, (draft) => {
        draft.booking = {
          ...draft.booking,
          status: "pending_review",
          appointmentId: appointment.id,
          requestedAt: appointment.created_at || now.toISOString()
        };
      });
      return {
        response: language === "arabic"
          ? `تم إرسال طلب الموعد للمراجعة. سأرسل لك التفاصيل بعد تأكيده من فريق الشركة.`
          : language === "greek"
            ? `Το αίτημα ραντεβού σας στάλθηκε για έλεγχο. Θα σας στείλω τις λεπτομέρειες μόλις το επιβεβαιώσει η ομάδα της the business.`
            : `Your appointment request has been sent for review. I’ll send the details once the business team confirms it.`,
        event: null,
        appointment,
        details,
        user,
        policy
      };
    }

    if (appointment.status === "confirmed" && appointment.google_event_id) {
      await scheduleBookingReminders({ store, appointment, userId, now, policy });
      await store.updateUser(userId, (draft) => {
        draft.booking = { ...draft.booking, status: "booked", bookedAt: appointment.confirmed_at, eventId: appointment.google_event_id, appointmentId: appointment.id };
      });
      return { response: bookingConfirmationMessage(details.start, policy, language, appointment.google_meet_url), event: null };
    }

    const eventId = `rafa${appointment.id.replace(/-/g, "")}`;
    const event = await createBookingEvent({ user, userId, details, eventId, policy });
    const savedAppointment = await store.updateAppointment(appointment.id, {
      status: "confirmed",
      googleEventId: event.id,
      googleEventUrl: event.htmlLink || "",
      googleMeetUrl: event.meetLink || "",
      confirmedAt: now.toISOString()
    });
    if (savedAppointment?.status !== "confirmed") throw new Error("The calendar event exists but its appointment record could not be confirmed.");
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
  return /^(?:yes|yeah|yep|no|nope|cancel|confirm|confirmed|that works|sounds good|نعم|اي|أيوه|لا|مش|الغاء|إلغاء|ναι|όχι|άκυρο|ακύρωση|επιβεβαίωση|επιβεβαιώνω)[.!،\s]*$/iu.test(String(text || "").trim());
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
  if (language === "greek") return "Δεν είναι δυνατή αυτή τη στιγμή η πρόσβαση στο ημερολόγιο της the business, οπότε δεν μπορώ να επιβεβαιώσω ραντεβού τώρα. Επικοινωνήστε απευθείας με την ομάδα της the business.";
  return "REFAL cannot currently access the business's calendar, so I can't book an appointment right now. Please contact the business team directly.";
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
  suggestAvailableTimes,
  appointmentWindowIssue,
  appointmentChangeIntent,
  approvePendingAppointment,
  changeAppointmentStatus,
  parseBookingDetails,
  CUSTOMER_BOOKING_URL
};
