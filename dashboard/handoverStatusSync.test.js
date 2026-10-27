import test from "node:test";
import assert from "node:assert/strict";
import { HandoverStatusSyncError, syncHandoverStatus } from "./handoverStatusSync.js";

function harness() {
  const rows = [
    { id: "h1", contact_id: "c1", department: "investment", status: "open" },
    { id: "h2", contact_id: "c1", department: "property", status: "open" }
  ];
  const ledger = new Map();
  let failLedger = false;
  return {
    rows,
    ledger,
    setFailLedger(value) { failLedger = value; },
    async run(handoverId, status, overrides = {}) {
      return syncHandoverStatus({
        handoverId, status,
        readTarget: async (id) => rows.find((row) => row.id === id) || null,
        readGroup: async (target) => rows.filter((row) => row.contact_id === target.contact_id),
        readDelivery: async () => [...ledger.values()],
        updateActive: async (active, nextStatus) => {
          for (const row of active) row.status = nextStatus;
          return active.map((row) => ({ ...row }));
        },
        upsertDelivery: async (items) => {
          if (failLedger) throw new Error("temporary ledger outage");
          for (const item of items) ledger.set(item.handover_id, item);
        },
        now: () => "2026-10-11T12:00:00.000Z",
        ...overrides
      });
    }
  };
}

test("retry after a delivery ledger failure repairs already-updated handovers", async () => {
  const db = harness();
  db.setFailLedger(true);
  await assert.rejects(db.run("h1", "resolved"), (error) => error.status === 503 && /retry the same action/i.test(error.message));
  assert.deepEqual(db.rows.map((row) => row.status), ["resolved", "resolved"]);
  db.setFailLedger(false);

  const result = await db.run("h1", "resolved");
  assert.equal(result.updatedCount, 0);
  assert.equal(result.reconciledCount, 2);
  assert.deepEqual([...db.ledger.values()].map((item) => item.status), ["closed", "closed"]);
  assert.deepEqual([...db.ledger.values()].map((item) => item.acknowledged_at), [null, null]);
});

test("does not report success when an acknowledged ledger write is silently missing", async () => {
  const db = harness();
  await assert.rejects(
    db.run("h1", "acknowledged", { upsertDelivery: async () => {} }),
    (error) => error instanceof HandoverStatusSyncError && error.status === 503 && /retry the same action/i.test(error.message)
  );
  assert.deepEqual(db.rows.map((row) => row.status), ["acknowledged", "acknowledged"]);
  assert.equal(db.ledger.size, 0);

  await db.run("h1", "acknowledged");
  assert.deepEqual([...db.ledger.values()].map((row) => row.status), ["acknowledged", "acknowledged"]);
});

test("acknowledgment verifies current rows without failing on cancelled historical siblings", async () => {
  const db = harness();
  db.rows.push({ id: "h-old", contact_id: "c1", department: "corporate", status: "cancelled" });

  const result = await db.run("h1", "acknowledged");

  assert.equal(result.reconciledCount, 2);
  assert.deepEqual(db.rows.map((row) => row.status), ["acknowledged", "acknowledged", "cancelled"]);
  assert.deepEqual([...db.ledger.values()].map((row) => row.status), ["acknowledged", "acknowledged"]);
  assert.equal(db.ledger.has("h-old"), false);
});

test("resolution verifies current rows without altering cancelled historical siblings", async () => {
  const db = harness();
  db.rows.push({ id: "h-old", contact_id: "c1", department: "corporate", status: "cancelled" });

  const result = await db.run("h1", "resolved");

  assert.equal(result.reconciledCount, 2);
  assert.deepEqual(db.rows.map((row) => row.status), ["resolved", "resolved", "cancelled"]);
  assert.deepEqual([...db.ledger.values()].map((row) => row.status), ["closed", "closed"]);
  assert.equal(db.ledger.has("h-old"), false);
});

test("post-write verification rejects a row cancelled after the initial group snapshot", async () => {
  const db = harness();
  let groupReads = 0;
  const readGroup = async (target) => {
    groupReads += 1;
    if (groupReads === 3) db.rows[0].status = "cancelled";
    return db.rows.filter((row) => row.contact_id === target.contact_id);
  };

  await assert.rejects(
    db.run("h1", "acknowledged", { readGroup }),
    (error) => error instanceof HandoverStatusSyncError && error.status === 503 && /handover status changed during delivery reconciliation/i.test(error.message)
  );
  assert.equal(db.rows[0].status, "cancelled");
  assert.equal(db.ledger.get("h1").status, "acknowledged");
});

test("resolving an open request does not invent an acknowledgement timestamp", async () => {
  const db = harness();
  await db.run("h1", "resolved");
  assert.deepEqual([...db.ledger.values()].map((item) => item.acknowledged_at), [null, null]);
});

test("resolution cancels queued and processing review notifications before reporting success", async () => {
  const db = harness();
  const calls = [];
  await db.run("h1", "resolved", {
    cancelActiveReviewNotifications: async (ids, changedAt) => calls.push({ ids, changedAt })
  });
  assert.deepEqual(calls, [{ ids: ["h1", "h2"], changedAt: "2026-10-11T12:00:00.000Z" }]);
  assert.deepEqual([...db.ledger.values()].map((item) => item.status), ["closed", "closed"]);
});

test("resolution does not claim success while active review notifications could not be cancelled", async () => {
  const db = harness();
  await assert.rejects(
    db.run("h1", "resolved", { cancelActiveReviewNotifications: async () => { throw new Error("notification store unavailable"); } }),
    (error) => error instanceof HandoverStatusSyncError && error.status === 503 && /pending handover notifications could not be cancelled/i.test(error.message)
  );
  assert.deepEqual(db.rows.map((row) => row.status), ["resolved", "resolved"]);
  assert.equal(db.ledger.size, 0);
  await db.run("h1", "resolved");
  assert.deepEqual([...db.ledger.values()].map((item) => item.status), ["closed", "closed"]);
});

test("resolving a previously acknowledged request preserves its recorded acknowledgement timestamp", async () => {
  const db = harness();
  await db.run("h1", "acknowledged");
  const acknowledgedAt = db.ledger.get("h1").acknowledged_at;
  await db.run("h1", "resolved", { now: () => "2026-10-11T13:00:00.000Z" });
  assert.equal(db.ledger.get("h1").acknowledged_at, acknowledgedAt);
});

test("acknowledging an open request does not timestamp a resolved sibling", async () => {
  const db = harness();
  db.rows[0].status = "resolved";
  await db.run("h2", "acknowledged");
  assert.equal(db.ledger.get("h1").status, "closed");
  assert.equal(db.ledger.get("h1").acknowledged_at, null);
  assert.equal(db.ledger.get("h2").status, "acknowledged");
  assert.equal(db.ledger.get("h2").acknowledged_at, "2026-10-11T12:00:00.000Z");
});

test("retry reconciles a status request that partially wrote before the REST call failed", async () => {
  const db = harness();
  let failAfterFirstRow = true;
  const run = (status) => syncHandoverStatus({
    handoverId: "h1", status,
    readTarget: async (id) => db.rows.find((row) => row.id === id) || null,
    readGroup: async (target) => db.rows.filter((row) => row.contact_id === target.contact_id),
    readDelivery: async () => [...db.ledger.values()],
    updateActive: async (active, nextStatus) => {
      if (failAfterFirstRow) {
        active[0].status = nextStatus;
        failAfterFirstRow = false;
        throw new Error("connection reset after server accepted a partial write");
      }
      for (const row of active) row.status = nextStatus;
      return active.map((row) => ({ ...row }));
    },
    upsertDelivery: async (items) => items.forEach((item) => db.ledger.set(item.handover_id, item)),
    now: () => "2026-10-11T12:00:00.000Z"
  });

  await assert.rejects(run("resolved"), (error) => error instanceof HandoverStatusSyncError && error.status === 503 && /retry the same action/i.test(error.message));
  assert.deepEqual(db.rows.map((row) => row.status), ["resolved", "open"]);
  assert.equal(db.ledger.size, 0);

  await run("resolved");
  assert.deepEqual(db.rows.map((row) => row.status), ["resolved", "resolved"]);
  assert.deepEqual([...db.ledger.values()].map((item) => item.status), ["closed", "closed"]);
});

test("retry reconciles a delivery upsert that failed after writing only part of the ledger", async () => {
  const db = harness();
  let failAfterFirstLedgerRow = true;
  const run = (status) => syncHandoverStatus({
    handoverId: "h1", status,
    readTarget: async (id) => db.rows.find((row) => row.id === id) || null,
    readGroup: async (target) => db.rows.filter((row) => row.contact_id === target.contact_id),
    readDelivery: async () => [...db.ledger.values()],
    updateActive: async (active, nextStatus) => {
      for (const row of active) row.status = nextStatus;
      return active.map((row) => ({ ...row }));
    },
    upsertDelivery: async (items) => {
      if (failAfterFirstLedgerRow) {
        db.ledger.set(items[0].handover_id, items[0]);
        failAfterFirstLedgerRow = false;
        throw new Error("connection reset after partial ledger write");
      }
      items.forEach((item) => db.ledger.set(item.handover_id, item));
    },
    now: () => "2026-10-11T12:00:00.000Z"
  });

  await assert.rejects(run("resolved"), (error) => error instanceof HandoverStatusSyncError && error.status === 503 && /retry the same action/i.test(error.message));
  assert.deepEqual([...db.ledger.values()].map((item) => item.status), ["closed"]);

  await run("resolved");
  assert.deepEqual([...db.ledger.values()].map((item) => item.status), ["closed", "closed"]);
});

test("post-write handover read failure returns retryable reconciliation guidance", async () => {
  const db = harness();
  let readCount = 0;
  const readGroup = async (target) => {
    readCount += 1;
    if (readCount === 2) throw new Error("connection reset after status write");
    return db.rows.filter((row) => row.contact_id === target.contact_id);
  };
  await assert.rejects(
    db.run("h1", "resolved", { readGroup }),
    (error) => error instanceof HandoverStatusSyncError && error.status === 503 && /retry the same action to reconcile/i.test(error.message)
  );
  await db.run("h1", "resolved");
  assert.deepEqual(db.rows.map((row) => row.status), ["resolved", "resolved"]);
  assert.deepEqual([...db.ledger.values()].map((item) => item.status), ["closed", "closed"]);
});

test("post-write delivery read failure returns retryable reconciliation guidance", async () => {
  const db = harness();
  let failDeliveryRead = true;
  const readDelivery = async (...args) => {
    if (failDeliveryRead) {
      failDeliveryRead = false;
      throw new Error("delivery ledger unavailable after status write");
    }
    return [...db.ledger.values()];
  };
  await assert.rejects(
    db.run("h1", "resolved", { readDelivery }),
    (error) => error instanceof HandoverStatusSyncError && error.status === 503 && /retry the same action to reconcile/i.test(error.message)
  );
  await db.run("h1", "resolved");
  assert.deepEqual([...db.ledger.values()].map((item) => item.status), ["closed", "closed"]);
});

test("acknowledgement reconciles every active request in the contact group", async () => {
  const db = harness();
  await db.run("h1", "acknowledged");
  assert.deepEqual(db.rows.map((row) => row.status), ["acknowledged", "acknowledged"]);
  assert.deepEqual([...db.ledger.values()].map((item) => item.status), ["acknowledged", "acknowledged"]);
});

test("concurrent acknowledgement and resolution serialize per contact and leave the ledger consistent", async () => {
  const db = harness();
  const results = await Promise.allSettled([
    db.run("h1", "acknowledged"),
    db.run("h1", "resolved")
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 2);
  assert.deepEqual(db.rows.map((row) => row.status), ["resolved", "resolved"]);
  assert.deepEqual([...db.ledger.values()].map((item) => item.status), ["closed", "closed"]);
});

test("resolved requests cannot be reopened through the acknowledgement action", async () => {
  const db = harness();
  db.rows[0].status = "resolved";
  await assert.rejects(db.run("h1", "acknowledged"), (error) => error instanceof HandoverStatusSyncError && error.status === 409);
});

test("retry preserves the original closure and acknowledgement timestamps", async () => {
  const db = harness();
  await db.run("h1", "resolved");
  const first = db.ledger.get("h1");
  const result = await syncHandoverStatus({
    handoverId: "h1", status: "resolved",
    readTarget: async (id) => db.rows.find((row) => row.id === id),
    readGroup: async (target) => db.rows.filter((row) => row.contact_id === target.contact_id),
    readDelivery: async () => [...db.ledger.values()],
    updateActive: async () => [],
    upsertDelivery: async (items) => items.forEach((item) => db.ledger.set(item.handover_id, item)),
    now: () => "2026-10-11T13:00:00.000Z"
  });
  assert.equal(result.updatedCount, 0);
  assert.equal(db.ledger.get("h1").closed_at, first.closed_at);
  assert.equal(db.ledger.get("h1").acknowledged_at, first.acknowledged_at);
});
