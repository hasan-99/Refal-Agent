const TERMINAL_STATES = new Set(["sent", "uncertain", "dead", "cancelled"]);

export function isAllowedReminderTransition(from, to) {
  if (from === to) return ["sending", ...TERMINAL_STATES].includes(from);
  if (from === "processing") return ["sending", "failed", "dead", "cancelled"].includes(to);
  if (from === "sending") return ["sent", "uncertain"].includes(to);
  return false;
}

export function reminderPatchForState(state, body, now = new Date()) {
  const patch = { status: state };
  if (state === "sent") {
    patch.sent_at = body.sentAt || now.toISOString();
    patch.provider_message_id = String(body.providerMessageId || "").slice(0, 500) || null;
    patch.last_error = null;
  } else if (state === "failed") {
    const retryAt = new Date(body.nextAttemptAt);
    if (!Number.isFinite(retryAt.getTime()) || retryAt <= now) throw new Error("A future retry time is required for failed reminders.");
    patch.next_attempt_at = retryAt.toISOString();
    patch.last_error = String(body.lastError || "Delivery failed.").slice(0, 1000);
  } else if (["dead", "uncertain"].includes(state)) {
    patch.last_error = String(body.lastError || (state === "uncertain" ? "Delivery outcome is ambiguous." : "Retry limit reached.")).slice(0, 1000);
  }
  return patch;
}
