export function ledgerPatchForExistingNotification(status, now = new Date().toISOString()) {
  if (status === "sent") {
    return { status: "delivered", delivered_at: now, next_attempt_at: null, last_error_code: null, updated_at: now };
  }
  if (status === "dead" || status === "cancelled") {
    return { status: "failed", next_attempt_at: null, last_error_code: status === "dead" ? "notification_dead" : "notification_cancelled", updated_at: now };
  }
  return null;
}

export function ledgerPatchForRetryMismatch(notificationStatus, now = new Date().toISOString()) {
  if (notificationStatus !== "queued" && notificationStatus !== "processing") return null;
  return { status: "queued", next_attempt_at: now, last_error_code: null, updated_at: now };
}

export function isHandoverClosed(status) {
  return status === "resolved" || status === "cancelled";
}

export function canRetryHandoverReview(status) {
  return status === "open" || status === "acknowledged";
}

export function ledgerPatchForClosedHandover(status, now = new Date().toISOString()) {
  if (!isHandoverClosed(status)) return null;
  return {
    status: "closed",
    closed_at: now,
    closure_reason: status === "cancelled" ? "handover_cancelled" : "handover_resolved",
    next_attempt_at: null,
    updated_at: now
  };
}

export async function closeHandoverDeliverySafely({ cancelActiveNotifications, closeDelivery }) {
  await cancelActiveNotifications();
  await closeDelivery();
}

export function ledgerPatchForNotificationResult(status, attempts = 1, now = new Date().toISOString(), nextAttemptAt = now) {
  const patch = {
    status: status === "sent" ? "delivered" : status === "failed" ? "retry" : status === "cancelled" ? "closed" : "failed",
    attempt_count: Math.min(100, Math.max(0, Number(attempts) || 1)),
    last_attempt_at: now,
    next_attempt_at: status === "failed" ? nextAttemptAt : null,
    last_error_code: status === "sent" ? null : status === "cancelled" ? "handover_closed_before_delivery" : "delivery_failed",
    updated_at: now
  };
  if (status === "sent") patch.delivered_at = now;
  if (status === "cancelled") {
    patch.closed_at = now;
    patch.closure_reason = "handover_closed_before_delivery";
  }
  return patch;
}
