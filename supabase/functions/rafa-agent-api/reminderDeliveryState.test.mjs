import test from "node:test";
import assert from "node:assert/strict";
import { isAllowedReminderTransition, reminderPatchForState } from "./reminderDeliveryState.mjs";

test("reminder transitions require a durable sending marker before terminal provider outcomes", () => {
  assert.equal(isAllowedReminderTransition("processing", "sending"), true);
  assert.equal(isAllowedReminderTransition("sending", "sent"), true);
  assert.equal(isAllowedReminderTransition("sending", "uncertain"), true);
  assert.equal(isAllowedReminderTransition("processing", "sent"), false);
  assert.equal(isAllowedReminderTransition("sending", "failed"), false);
  assert.equal(isAllowedReminderTransition("uncertain", "processing"), false);
  assert.equal(isAllowedReminderTransition("failed", "processing"), false);
  assert.equal(isAllowedReminderTransition("sent", "failed"), false);
});

test("failed is the only provider state with an explicit retry timestamp", () => {
  const now = new Date("2026-10-11T12:00:00.000Z");
  assert.throws(() => reminderPatchForState("failed", { nextAttemptAt: "2026-10-11T11:00:00.000Z" }, now), /future retry time/);
  assert.deepEqual(reminderPatchForState("uncertain", { lastError: "provider timed out" }, now), {
    status: "uncertain", last_error: "provider timed out"
  });
  assert.deepEqual(reminderPatchForState("sending", {}, now), { status: "sending" });
});
