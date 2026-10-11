import test from "node:test";
import assert from "node:assert/strict";
import {
  hasConfirmationEventId,
  isAllowedAppointmentTransition,
  updateAppointmentIfStatusMatches
} from "./appointmentStateMachine.mjs";

test("appointment transition graph accepts workflow edges and rejects unsafe edges", () => {
  for (const [from, to] of [
    ["awaiting_customer_confirmation", "creating"],
    ["creating", "confirmed"],
    ["creating", "pending_calendar"],
    ["pending_calendar", "pending_review"],
    ["confirmed", "cancelled"]
  ]) assert.equal(isAllowedAppointmentTransition(from, to), true, `${from} -> ${to}`);

  for (const [from, to] of [
    ["awaiting_customer_confirmation", "confirmed"],
    ["cancelled", "creating"],
    ["completed", "pending_calendar"],
    ["creating", "creating"],
    ["unknown", "confirmed"]
  ]) assert.equal(isAllowedAppointmentTransition(from, to), false, `${from} -> ${to}`);
});

test("confirmation requires a non-empty Google event ID", () => {
  assert.equal(hasConfirmationEventId("confirmed", "event-123"), true);
  assert.equal(hasConfirmationEventId("confirmed", "  "), false);
  assert.equal(hasConfirmationEventId("confirmed", undefined), false);
  assert.equal(hasConfirmationEventId("creating", undefined), true);
});

test("status guarded update affects no row after a concurrent status change", async () => {
  let currentStatus = "creating";
  let persistedPatch = null;
  const predicates = [];
  const supabase = {
    from(table) {
      assert.equal(table, "rafa_appointments");
      return {
        update(patch) {
          return {
            eq(column, value) {
              predicates.push([column, value]);
              return this;
            },
            select(columns) {
              assert.equal(columns, "*");
              return this;
            },
            async single() {
              // Another request wins after the handler read currentStatus but
              // before its UPDATE is applied.
              currentStatus = "cancelled";
              const expected = predicates.find(([column]) => column === "status")?.[1];
              if (currentStatus !== expected) return { data: null, error: { code: "PGRST116" } };
              persistedPatch = patch;
              return { data: { status: patch.status }, error: null };
            }
          };
        }
      };
    }
  };

  const result = await updateAppointmentIfStatusMatches(
    supabase,
    "appointment-id",
    "creating",
    { status: "confirmed", google_event_id: "event-123" }
  );

  assert.deepEqual(predicates, [["id", "appointment-id"], ["status", "creating"]]);
  assert.equal(currentStatus, "cancelled");
  assert.equal(persistedPatch, null, "stale update must not overwrite the concurrent status");
  assert.equal(result.error.code, "PGRST116", "handler can translate the zero-row CAS into HTTP 409");
});
