export const APPOINTMENT_TRANSITIONS = Object.freeze({
  draft: ["awaiting_customer_confirmation", "cancelled"],
  awaiting_customer_confirmation: ["creating", "failed", "cancelled"],
  creating: ["pending_calendar", "pending_review", "confirmed", "failed", "cancelled"],
  pending_review: ["creating", "confirmed", "rejected", "rescheduled", "cancelled"],
  pending_calendar: ["pending_review", "creating", "confirmed", "failed", "cancelled"],
  confirmed: ["rescheduled", "cancelled", "completed"],
  rescheduled: ["pending_review", "cancelled"],
  rejected: ["pending_review", "cancelled"],
  failed: ["pending_calendar", "pending_review", "cancelled"],
  cancelled: [],
  completed: []
});

export function isAllowedAppointmentTransition(currentStatus, nextStatus) {
  if (nextStatus === currentStatus) return nextStatus !== "creating";
  return APPOINTMENT_TRANSITIONS[currentStatus]?.includes(nextStatus) || false;
}

export function hasConfirmationEventId(status, googleEventId) {
  return status !== "confirmed" || Boolean(String(googleEventId || "").trim());
}

// Keep the expected status in the database UPDATE predicate: a concurrent
// transition must result in no row instead of overwriting the newer state.
export function updateAppointmentIfStatusMatches(supabase, appointmentId, expectedStatus, patch) {
  return supabase.from("rafa_appointments").update(patch)
    .eq("id", appointmentId).eq("status", expectedStatus).select("*").single();
}
