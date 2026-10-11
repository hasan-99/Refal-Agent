const ACTIVE_STATUSES = new Set(["open", "acknowledged"]);
const contactSyncLocks = new Map();

async function withContactSyncLock(contactId, operation) {
  const key = String(contactId || "");
  const previous = contactSyncLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  contactSyncLocks.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (contactSyncLocks.get(key) === current) contactSyncLocks.delete(key);
  }
}

export class HandoverStatusSyncError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = "HandoverStatusSyncError";
    this.status = status;
  }
}

/**
 * Reconcile a contact's handover rows and delivery ledger. The REST writes are
 * not one database transaction, so the operation is deliberately idempotent:
 * if ledger upsert fails after the handovers change, retrying the same request
 * reads the already-updated rows and repairs the ledger.
 */
export async function syncHandoverStatus({
  handoverId,
  status,
  readTarget,
  readGroup,
  readDelivery = async () => [],
  cancelActiveReviewNotifications = async () => {},
  updateActive,
  upsertDelivery,
  now = () => new Date().toISOString()
}) {
  if (!new Set(["acknowledged", "resolved"]).has(status)) {
    throw new HandoverStatusSyncError("Choose a valid handover status.", 400);
  }
  const target = await readTarget(handoverId);
  if (!target) throw new HandoverStatusSyncError("Specialist request not found.", 404);
  return withContactSyncLock(target.contact_id || target.id, async () => {
    // The target may have changed while this request waited behind another
    // dashboard action for the same contact. Re-read it under the lock so a
    // stale acknowledgement cannot reopen a request resolved by that action.
    const currentTarget = await readTarget(handoverId);
    if (!currentTarget) throw new HandoverStatusSyncError("Specialist request not found.", 404);
    if (currentTarget.status === "resolved" && status !== "resolved") {
      throw new HandoverStatusSyncError("A resolved specialist request cannot be reopened here.", 409);
    }

    const allRows = await readGroup(currentTarget);
    const activeRows = allRows.filter((row) => ACTIVE_STATUSES.has(row.status));
    const initiallyCancelledIds = new Set(allRows.filter((row) => row.status === "cancelled").map((row) => row.id));
    const changedAt = now();
    let updatedRows = [];
    if (activeRows.length) {
      try {
        updatedRows = await updateActive(activeRows, status, changedAt);
      } catch {
        // A REST request can fail after the database accepted some or all of
        // its writes. Tell the operator to retry the same action so the
        // read-back and delivery reconciliation below can converge.
        throw new HandoverStatusSyncError(
          "Status may have been saved, but the grouped requests could not be confirmed. Retry the same action to reconcile them.",
          503
        );
      }
    }
    // Read back the durable state before repairing the ledger. This also makes
    // a retry of a partially completed request converge on the actual DB state.
    let finalRows;
    try {
      finalRows = await readGroup(currentTarget);
    } catch {
      throw new HandoverStatusSyncError(
        "Status may have been saved, but the grouped requests could not be verified. Retry the same action to reconcile them.",
        503
      );
    }
    const stillActive = finalRows.some((row) => ACTIVE_STATUSES.has(row.status));
    if (stillActive && (status === "resolved" || finalRows.some((row) => row.status === "open"))) {
      throw new HandoverStatusSyncError(
        "Some grouped requests did not reach the requested status. Retry the same action to reconcile them.",
        503
      );
    }
    let previousDelivery;
    try {
      previousDelivery = await readDelivery(finalRows.map((row) => row.id));
    } catch {
      throw new HandoverStatusSyncError(
        "Status was saved, but delivery status could not be checked. Retry the same action to reconcile it.",
        503
      );
    }
    const previousByHandover = new Map(previousDelivery.map((row) => [row.handover_id, row]));
    if (status === "resolved") {
      const resolvedIds = finalRows.filter((row) => row.status === "resolved").map((row) => row.id);
      if (resolvedIds.length) {
        try {
          await cancelActiveReviewNotifications(resolvedIds, changedAt);
        } catch {
          throw new HandoverStatusSyncError(
            "Status was saved, but pending handover notifications could not be cancelled. Retry the same action to reconcile them.",
            503
          );
        }
      }
    }
    const delivery = finalRows
      .filter((row) => row.status === "acknowledged" || row.status === "resolved")
      .map((row) => {
        const previous = previousByHandover.get(row.id);
        const closed = row.status === "resolved";
        return {
          handover_id: row.id,
          department: row.department,
          recipient_lane: "sandbox",
          status: closed ? "closed" : "acknowledged",
          acknowledged_at: previous?.acknowledged_at || (row.status === "acknowledged" && status === "acknowledged" ? changedAt : null),
          ...(closed ? {
            closed_at: previous?.closed_at || changedAt,
            closure_reason: previous?.closure_reason || "operator_resolved"
          } : {}),
          updated_at: changedAt
        };
      });

    if (delivery.length) {
      try {
        await upsertDelivery(delivery);
      } catch (error) {
        throw new HandoverStatusSyncError(
          "Status was saved, but delivery status could not be synchronized. Retry the same action to reconcile it.",
          503
        );
      }

      // A concurrent dashboard instance can update the same contact after our
      // initial read. Confirm the durable handover and ledger still agree
      // before reporting success; process-local locking cannot serialize other
      // instances.
      let verifiedRows;
      let verifiedDelivery;
      try {
        [verifiedRows, verifiedDelivery] = await Promise.all([
          readGroup(currentTarget),
          readDelivery(delivery.map((row) => row.handover_id))
        ]);
      } catch {
        throw new HandoverStatusSyncError(
          "Status was saved, but the final delivery state could not be verified. Retry the same action to reconcile it.",
          503
        );
      }
      const deliveryByHandover = new Map(verifiedDelivery.map((row) => [row.handover_id, row]));
      const stateMatches = verifiedRows.every((row) => (row.status === "cancelled" && initiallyCancelledIds.has(row.id)) || (
        (row.status === "acknowledged" || row.status === "resolved")
        && deliveryByHandover.get(row.id)?.status === (row.status === "resolved" ? "closed" : "acknowledged")
      ));
      if (!stateMatches) {
        throw new HandoverStatusSyncError(
          "Handover status changed during delivery reconciliation. Retry the same action to synchronize the latest state.",
          503
        );
      }
    }
    return { handover: finalRows.find((row) => row.id === handoverId) || finalRows[0], updatedCount: updatedRows.length, reconciledCount: delivery.length };
  });
}
