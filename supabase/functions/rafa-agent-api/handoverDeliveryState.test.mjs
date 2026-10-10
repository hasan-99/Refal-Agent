import assert from "node:assert/strict";
import { test } from "node:test";
import { canRetryHandoverReview, closeHandoverDeliverySafely, isHandoverClosed, ledgerPatchForClosedHandover, ledgerPatchForExistingNotification, ledgerPatchForNotificationResult, ledgerPatchForRetryMismatch } from "./handoverDeliveryState.mjs";

test("notification terminal states reconcile the delivery ledger after a partial write", () => {
  const now = "2026-10-10T12:00:00.000Z";
  assert.deepEqual(ledgerPatchForExistingNotification("sent", now), {
    status: "delivered", delivered_at: now, next_attempt_at: null, last_error_code: null, updated_at: now
  });
  assert.deepEqual(ledgerPatchForExistingNotification("dead", now), {
    status: "failed", next_attempt_at: null, last_error_code: "notification_dead", updated_at: now
  });
  assert.deepEqual(ledgerPatchForExistingNotification("cancelled", now), {
    status: "failed", next_attempt_at: null, last_error_code: "notification_cancelled", updated_at: now
  });
  assert.equal(ledgerPatchForExistingNotification("queued", now), null);
});

test("a retried active notification repairs a failed delivery ledger", () => {
  const now = "2026-10-10T12:00:00.000Z";
  assert.deepEqual(ledgerPatchForRetryMismatch("queued", now), {
    status: "queued", next_attempt_at: now, last_error_code: null, updated_at: now
  });
  assert.deepEqual(ledgerPatchForRetryMismatch("processing", now), {
    status: "queued", next_attempt_at: now, last_error_code: null, updated_at: now
  });
  assert.equal(ledgerPatchForRetryMismatch("dead", now), null);
  assert.equal(ledgerPatchForRetryMismatch("sent", now), null);
});

test("closed handovers cannot be retried and reconcile to a closed delivery ledger", () => {
  const now = "2026-10-10T12:00:00.000Z";
  assert.equal(canRetryHandoverReview("open"), true);
  assert.equal(canRetryHandoverReview("acknowledged"), true);
  assert.equal(canRetryHandoverReview(null), false);
  assert.equal(canRetryHandoverReview("unexpected"), false);
  for (const status of ["resolved", "cancelled"]) {
    assert.equal(isHandoverClosed(status), true);
    assert.equal(canRetryHandoverReview(status), false);
    assert.deepEqual(ledgerPatchForClosedHandover(status, now), {
      status: "closed", closed_at: now,
      closure_reason: status === "cancelled" ? "handover_cancelled" : "handover_resolved",
      next_attempt_at: null, updated_at: now
    });
  }
  assert.equal(ledgerPatchForClosedHandover("open", now), null);
});

test("closed-handover reconciliation cancels active notifications before closing the ledger", async () => {
  const order = [];
  await closeHandoverDeliverySafely({
    cancelActiveNotifications: async () => { order.push("cancel"); },
    closeDelivery: async () => { order.push("close"); }
  });
  assert.deepEqual(order, ["cancel", "close"]);
  await assert.rejects(closeHandoverDeliverySafely({
    cancelActiveNotifications: async () => { throw new Error("transient cancel failure"); },
    closeDelivery: async () => { order.push("must-not-close"); }
  }), /transient cancel failure/);
  assert.equal(order.includes("must-not-close"), false, "open/retry ledger remains discoverable after cancellation failure");
});

test("worker cancellation records a closed ledger rather than reopening it as a delivery failure", () => {
  const now = "2026-10-10T12:00:00.000Z";
  assert.deepEqual(ledgerPatchForNotificationResult("cancelled", 3, now), {
    status: "closed", attempt_count: 3, last_attempt_at: now, next_attempt_at: null,
    last_error_code: "handover_closed_before_delivery", updated_at: now,
    closed_at: now, closure_reason: "handover_closed_before_delivery"
  });
  assert.equal(ledgerPatchForNotificationResult("sent", 1, now).status, "delivered");
  assert.equal(ledgerPatchForNotificationResult("failed", 2, now, "2026-10-10T12:05:00.000Z").status, "retry");
});
