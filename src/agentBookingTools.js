// REFAL-AGENT-009 — deterministic booking tools for the Agent loop.
//
// These WRAP the existing booking state machine in src/booking.js; they never
// reimplement it. Window/notice validity (`appointmentWindowIssue`), real-time
// availability (`isAvailable`), the idempotent calendar write
// (`createBookingEvent`) and the customer-facing confirmation wording
// (`bookingConfirmationMessage`) all stay exactly where they already are and
// are only called from here.
//
// What is genuinely NEW here, and why:
//
//   The legacy customer self-confirmation path (booking.js's
//   `awaiting_confirmation` branch) checks `isAvailable` and then — with no
//   serialization at all — writes the appointment and the calendar event. Two
//   near-simultaneous confirmations for the same slot can both pass the
//   availability check before either write lands. The admin approval path has
//   had a lock for this (`calendarApprovalQueue`) since it was written; the
//   customer path never did. This file adds a per-slot lock for the new path.
//
//   The lock here is deliberately SEPARATE from `calendarApprovalQueue`: that
//   one is a single global queue owned by `approvePendingAppointment`, and
//   sharing it would both serialize unrelated customer slots behind admin
//   approvals and change the behavior of a live, tested path. Nothing in this
//   file touches it.
//
// Nothing calls these tools from live traffic yet (Tickets 010/017). They are
// registered in agentTools.js's TOOL_REGISTRY so the chain can be exercised
// end to end first.

const { createHash } = require("node:crypto");
const {
  appointmentWindowIssue,
  bookingConfirmationMessage,
  calendarId,
  createBookingEvent,
  formatBookingTime,
  hasCalendarConfig,
  isAvailable,
  suggestAvailableTimes
} = require("./booking");
const { validateBookingPolicy } = require("./bookingPolicy");
const { normalizeAppointmentDetails } = require("./appointmentDetails");
const { ok, fail } = require("./agentToolResult");

const MAX_SUGGESTIONS = 3;
// The statuses the legacy customer path routes to administrator review.
const ADMIN_REVIEW_STATUSES = Object.freeze(["pending_calendar", "failed", "rejected", "rescheduled"]);
const IDEMPOTENCY_PREFIX = "agent-booking";
const IDEMPOTENCY_CACHE_TTL_MS = 10 * 60 * 1000;
const IDEMPOTENCY_CACHE_MAX_ENTRIES = 200;

// --- per-slot serialization ---------------------------------------------------
// Same promise-chaining pattern already proven by `approvePendingAppointment`,
// but keyed per calendar+slot so two DIFFERENT slots still run fully
// concurrently. The map entry is deleted as soon as its own chain settles and
// nothing newer has taken the tail, so this cannot grow without bound (the
// project's own bug audit already flagged an unbounded in-memory map in
// rateLimiter.js as a real memory-leak class of bug).
const slotLocks = new Map();

function slotKeyFor(policy, start, end) {
  return `${calendarId(policy)}|${start.toISOString()}|${end.toISOString()}`;
}

async function withSlotLock(slotKey, run) {
  const previous = slotLocks.get(slotKey) || Promise.resolve();
  let release;
  const turn = new Promise((resolve) => { release = resolve; });
  const tail = previous.then(() => turn, () => turn);
  slotLocks.set(slotKey, tail);
  await previous.catch(() => {});
  try {
    return await run();
  } finally {
    release();
    // Only the current tail owner may clear the entry; if a later caller has
    // already queued behind us it owns the key now and will clear it itself.
    if (slotLocks.get(slotKey) === tail) slotLocks.delete(slotKey);
  }
}

// --- idempotency ---------------------------------------------------------------
// The authoritative protection is the STABLE idempotency key that reaches
// `store.createAppointment` on every call for the same inbound WhatsApp
// message (the Edge Function enforces a unique constraint on it and returns
// the existing row instead of inserting a second one). The in-process map
// below is only a fast path that avoids the duplicate round trip; a second bot
// instance would not share it — exactly the same caveat the project already
// documents for the in-memory rate limiter.
const idempotentResults = new Map();

function deriveIdempotencyKey(inboundMessageId, slotKey) {
  // Derived from the real provider message id (never randomUUID), so a
  // duplicate-delivered WhatsApp message naturally produces the same key.
  // Prefixed so it can never collide with the legacy flow's random keys.
  const digest = createHash("sha256").update(`${inboundMessageId}|${slotKey}`).digest("hex").slice(0, 40);
  return `${IDEMPOTENCY_PREFIX}:${digest}`;
}

function readIdempotentResult(key) {
  const entry = idempotentResults.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > IDEMPOTENCY_CACHE_TTL_MS) {
    idempotentResults.delete(key);
    return null;
  }
  return entry.result;
}

function rememberIdempotentResult(key, result) {
  const now = Date.now();
  for (const [existingKey, entry] of idempotentResults) {
    if (now - entry.at > IDEMPOTENCY_CACHE_TTL_MS) idempotentResults.delete(existingKey);
  }
  idempotentResults.set(key, { at: now, result });
  while (idempotentResults.size > IDEMPOTENCY_CACHE_MAX_ENTRIES) {
    idempotentResults.delete(idempotentResults.keys().next().value);
  }
  return result;
}

// --- shared input handling ------------------------------------------------------

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function parseInstant(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (!isNonEmptyString(value)) return null;
  const parsed = new Date(String(value).trim());
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

// The Agent proposes a slot; the POLICY owns how long a meeting is. An
// explicitly-sent end that disagrees with the configured duration is rejected
// on the write path rather than silently honored.
function parseSlot(args, policy, { enforceDuration }) {
  const start = parseInstant(args?.start);
  if (!start) return null;
  const durationMs = (policy.durationMinutes || 0) * 60000;
  const end = parseInstant(args?.end) || (durationMs > 0 ? new Date(start.getTime() + durationMs) : null);
  if (!end || end.getTime() <= start.getTime()) return null;
  if (enforceDuration && (!durationMs || end.getTime() - start.getTime() !== durationMs)) return null;
  return { start, end };
}

async function resolvePolicy({ policy, store }) {
  const source = policy || (typeof store?.getBookingPolicy === "function" ? await store.getBookingPolicy() : null);
  if (!source) return { error: fail("error", "POLICY_UNAVAILABLE") };
  return { policy: validateBookingPolicy(source) };
}

async function resolvePolicySafely(toolContext) {
  try {
    return await resolvePolicy(toolContext);
  } catch (error) {
    return { error: fail("error", "POLICY_UNAVAILABLE", { message: String(error?.message || error).slice(0, 200) }) };
  }
}

function nowFrom(toolContext) {
  return toolContext?.now instanceof Date ? toolContext.now : new Date();
}

function slotPayload(start, end) {
  return { start: start.toISOString(), end: end.toISOString() };
}

// --- getBookingAvailability --------------------------------------------------
// Read-only, so no lock is needed. Distinguishes "this slot is not bookable"
// (a normal, expected answer) from "the calendar system is unreachable" (a
// system error) — the same discipline every Ticket 001 tool already follows.

async function getBookingAvailability(args, toolContext = {}) {
  const resolved = await resolvePolicySafely(toolContext);
  if (resolved.error) return resolved.error;
  const policy = resolved.policy;
  if (!hasCalendarConfig(policy)) return fail("error", "CALENDAR_NOT_CONFIGURED");
  const now = nowFrom(toolContext);
  const language = toolContext.language || "english";

  // No proposed slot means "what is open?".
  if (args?.start === undefined || args?.start === null || String(args.start).trim() === "") {
    let slots;
    try {
      slots = await suggestAvailableTimes(policy, { now, count: MAX_SUGGESTIONS });
    } catch (error) {
      return fail("error", "CALENDAR_UNAVAILABLE", { message: String(error?.message || error).slice(0, 200) });
    }
    return ok(
      "suggestions",
      slots.map(({ start, end }) => slotPayload(start, end)),
      { userSafeSummary: slots.map(({ start }) => formatBookingTime(start, policy, language)) }
    );
  }

  const slot = parseSlot(args, policy, { enforceDuration: false });
  if (!slot) return fail("invalid_input", "INVALID_SLOT");

  // Never trust the Agent's claim that a time is fine: re-derive it.
  const issue = appointmentWindowIssue(slot.start, slot.end, policy, now);
  if (issue) return ok("invalid_window", { ...slotPayload(slot.start, slot.end), reason: issue });

  let available;
  try {
    available = await isAvailable(slot, policy);
  } catch (error) {
    return fail("error", "CALENDAR_UNAVAILABLE", { message: String(error?.message || error).slice(0, 200) });
  }
  return ok(available ? "available" : "unavailable", slotPayload(slot.start, slot.end));
}

// --- requestBookingAction ------------------------------------------------------
// The write path. Everything that decides whether a booking may happen is
// re-derived here, inside the lock, from the real policy and the real
// calendar — never from the Agent's assertion.

async function requestBookingAction(args, toolContext = {}) {
  const { store, user, userId, inboundMessageId } = toolContext;
  if (!user || typeof user !== "object") return fail("not_found", "CUSTOMER_NOT_LOADED");
  if (!isNonEmptyString(userId)) return fail("invalid_input", "USER_ID_REQUIRED");
  if (typeof store?.createAppointment !== "function" || typeof store?.updateAppointment !== "function") {
    return fail("error", "STORE_UNAVAILABLE");
  }
  // Without the real inbound message id there is no stable idempotency key, so
  // a duplicate delivery could become a second appointment. Fail closed.
  if (!isNonEmptyString(inboundMessageId)) return fail("invalid_input", "INBOUND_MESSAGE_ID_REQUIRED");

  const purpose = String(args?.purpose || "").trim().slice(0, 1000);
  if (!purpose) return fail("invalid_input", "PURPOSE_REQUIRED");

  const resolved = await resolvePolicySafely(toolContext);
  if (resolved.error) return resolved.error;
  const policy = resolved.policy;
  if (!hasCalendarConfig(policy)) return fail("error", "CALENDAR_NOT_CONFIGURED");

  const slot = parseSlot(args, policy, { enforceDuration: true });
  if (!slot) return fail("invalid_input", "INVALID_SLOT");

  const slotKey = slotKeyFor(policy, slot.start, slot.end);
  const idempotencyKey = deriveIdempotencyKey(inboundMessageId, slotKey);
  const alreadyDone = readIdempotentResult(idempotencyKey);
  if (alreadyDone) return alreadyDone;

  return withSlotLock(slotKey, async () => {
    // Re-read after acquiring the lock: the call we just queued behind may have
    // been the duplicate delivery of this very message.
    const doneWhileWaiting = readIdempotentResult(idempotencyKey);
    if (doneWhileWaiting) return doneWhileWaiting;

    const now = nowFrom(toolContext);
    const language = toolContext.language || "english";

    const issue = appointmentWindowIssue(slot.start, slot.end, policy, now);
    if (issue) {
      return fail("invalid_window", issue === "notice" ? "OUTSIDE_NOTICE_WINDOW" : "OUTSIDE_BUSINESS_HOURS", slotPayload(slot.start, slot.end));
    }

    let available;
    try {
      available = await isAvailable(slot, policy);
    } catch (error) {
      return fail("error", "CALENDAR_UNAVAILABLE", { message: String(error?.message || error).slice(0, 200) });
    }
    if (!available) return fail("unavailable", "SLOT_NO_LONGER_AVAILABLE", slotPayload(slot.start, slot.end));

    const appointmentDetails = normalizeAppointmentDetails({ user, purpose, timezone: policy.timezone, language, format: user.profile?.meetingFormat });
    if (!appointmentDetails.ready) {
      return fail("invalid_input", "MISSING_APPOINTMENT_DETAILS", { missingRequired: appointmentDetails.missingRequired });
    }

    let created;
    try {
      created = await store.createAppointment({
        userId,
        startsAt: slot.start.toISOString(),
        endsAt: slot.end.toISOString(),
        timezone: policy.timezone,
        durationMinutes: policy.durationMinutes,
        purpose,
        idempotencyKey,
        calendarId: calendarId(policy),
        metadata: { appointmentDetails, source: "agent_booking_tool" }
      });
    } catch (error) {
      return fail("error", "APPOINTMENT_WRITE_FAILED", { message: String(error?.message || error).slice(0, 200) });
    }
    let appointment = created?.appointment || null;
    // The Edge Function answers a reused key whose details disagree with the
    // stored row with {conflict:true} rather than a row: that is a real error,
    // never a success.
    if (appointment?.conflict === true) return fail("error", "APPOINTMENT_KEY_CONFLICT");
    if (!appointment?.id) return fail("error", "APPOINTMENT_WRITE_FAILED");

    // Exactly the legacy customer path's coercion (booking.js's
    // awaiting_confirmation branch): a customer-requested appointment that is
    // not already live goes to administrator review. This tool must not become
    // a way around that gate.
    if (ADMIN_REVIEW_STATUSES.includes(appointment.status)) {
      try {
        appointment = await store.updateAppointment(appointment.id, { status: "pending_review" });
      } catch (error) {
        return fail("error", "APPOINTMENT_WRITE_FAILED", { message: String(error?.message || error).slice(0, 200) });
      }
      if (!appointment?.id) return fail("error", "APPOINTMENT_WRITE_FAILED");
    }

    // The live store files every customer-requested appointment as
    // pending_review (admin approval is a deliberate boundary). That is a
    // successful request, NOT a booking — no confirmation wording is returned.
    if (appointment.status === "pending_review") {
      return rememberIdempotentResult(idempotencyKey, ok("pending_review", {
        appointmentId: appointment.id,
        ...slotPayload(slot.start, slot.end),
        requiresAdminApproval: true
      }));
    }

    if (appointment.status === "confirmed" && appointment.google_event_id) {
      return rememberIdempotentResult(idempotencyKey, ok("confirmed", {
        appointmentId: appointment.id,
        ...slotPayload(slot.start, slot.end),
        eventId: appointment.google_event_id,
        meetLink: appointment.google_meet_url || ""
      }, { userSafeSummary: bookingConfirmationMessage(slot.start, policy, language, appointment.google_meet_url || "") }));
    }

    const eventId = `rafa${String(appointment.id).replace(/-/g, "")}`;
    let event;
    try {
      event = await createBookingEvent({ user, userId, details: { ...slot, purpose }, eventId, policy });
    } catch (error) {
      // The durable appointment row exists but the calendar does not. Never
      // report this as a booking; surface it so it can be reconciled.
      return fail("error", "CALENDAR_UNAVAILABLE", {
        appointmentId: appointment.id,
        requiresReconciliation: true,
        message: String(error?.message || error).slice(0, 200)
      });
    }

    let saved;
    try {
      saved = await store.updateAppointment(appointment.id, {
        status: "confirmed",
        googleEventId: event.id,
        googleEventUrl: event.htmlLink || "",
        googleMeetUrl: event.meetLink || "",
        confirmedAt: now.toISOString()
      });
    } catch (error) {
      return fail("error", "CONFIRMATION_NOT_SAVED", {
        appointmentId: appointment.id,
        requiresReconciliation: true,
        message: String(error?.message || error).slice(0, 200)
      });
    }
    if (saved?.status !== "confirmed") {
      return fail("error", "CONFIRMATION_NOT_SAVED", { appointmentId: appointment.id, requiresReconciliation: true });
    }

    // Only here — a real, persisted, confirmed appointment — is confirmation
    // wording produced, and it comes from the existing deterministic
    // formatter, never from the model.
    return rememberIdempotentResult(idempotencyKey, ok("confirmed", {
      appointmentId: appointment.id,
      ...slotPayload(slot.start, slot.end),
      eventId: event.id,
      meetLink: event.meetLink || ""
    }, { userSafeSummary: bookingConfirmationMessage(slot.start, policy, language, event.meetLink || "") }));
  });
}

// Test-only reset: the lock map and the idempotency fast path are module-level
// process state, so a test that asserts on them must be able to start clean.
function __resetBookingToolState() {
  slotLocks.clear();
  idempotentResults.clear();
}

module.exports = {
  getBookingAvailability,
  requestBookingAction,
  deriveIdempotencyKey,
  __resetBookingToolState
};
