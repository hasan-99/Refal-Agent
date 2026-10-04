const assert = require("node:assert/strict");
const { test } = require("node:test");
const { reminderText, runReminderCheck } = require("./reminderScheduler");

function reminderJob(overrides = {}) {
  return {
    id: "reminder-1",
    appointment_id: "appointment-1",
    recipient: "35799111222@s.whatsapp.net",
    channel: "whatsapp",
    attempts: 1,
    ...overrides
  };
}

function appointment(overrides = {}) {
  return {
    id: "appointment-1",
    status: "confirmed",
    starts_at: "2026-10-01T08:00:00.000Z",
    timezone: "Europe/Nicosia",
    ...overrides
  };
}

test("sends a reminder only for a confirmed appointment and records provider ID", async () => {
  const updates = [];
  const sent = [];
  const store = {
    claimDueReminders: async () => [reminderJob()],
    getAppointment: async () => appointment(),
    updateReminder: async (id, patch) => updates.push({ id, patch })
  };
  const result = await runReminderCheck({
    store,
    socket: { sendMessage: async (to, message) => { sent.push({ to, message }); return { key: { id: "wamid-1" } }; } },
    now: new Date("2026-09-29T08:00:00.000Z")
  });

  assert.deepEqual(result, { claimed: 1, sent: 1 });
  assert.equal(sent[0].to, "35799111222@s.whatsapp.net");
  assert.match(sent[0].message.text, /Refalco meeting is scheduled/);
  assert.equal(updates[0].patch.status, "sent");
  assert.equal(updates[0].patch.providerMessageId, "wamid-1");
});

test("one-hour Meet reminder includes only the appointment's validated Calendar Meet link", () => {
  const message = reminderText(appointment({ google_meet_url: "https://meet.google.com/abc-defg-hij" }), { reminder_kind: "meet_link_1h" });
  assert.match(message, /Google Meet: https:\/\/meet\.google\.com\/abc-defg-hij/);
  assert.doesNotMatch(reminderText(appointment(), { reminder_kind: "meet_link_1h" }), /https?:\/\//);
});

test("cancels a claimed reminder when its appointment is no longer confirmed", async () => {
  const updates = [];
  let sends = 0;
  const result = await runReminderCheck({
    store: {
      claimDueReminders: async () => [reminderJob()],
      getAppointment: async () => appointment({ status: "cancelled" }),
      updateReminder: async (_id, patch) => updates.push(patch)
    },
    socket: { sendMessage: async () => { sends += 1; } }
  });

  assert.equal(result.sent, 0);
  assert.equal(sends, 0);
  assert.deepEqual(updates, [{ status: "cancelled" }]);
});

test("does not send stale reminder after appointment changes during preparation", async () => {
  const updates = [];
  let reads = 0;
  let sends = 0;
  await runReminderCheck({
    store: {
      claimDueReminders: async () => [reminderJob()],
      getAppointment: async () => ++reads === 1
        ? appointment()
        : appointment({ starts_at: "2026-10-02T08:00:00.000Z" }),
      updateReminder: async (_id, patch) => updates.push(patch)
    },
    socket: { sendMessage: async () => { sends += 1; } }
  });
  assert.equal(sends, 0);
  assert.deepEqual(updates, [{ status: "cancelled" }]);
});

test("retries transient delivery failures and dead-letters after five attempts", async () => {
  for (const [attempts, expectedStatus] of [[2, "failed"], [5, "dead"]]) {
    const updates = [];
    await runReminderCheck({
      store: {
        claimDueReminders: async () => [reminderJob({ attempts })],
        getAppointment: async () => appointment(),
        updateReminder: async (_id, patch) => updates.push(patch)
      },
      socket: { sendMessage: async () => { throw new Error("temporary provider outage"); } },
      now: new Date("2026-09-29T08:00:00.000Z")
    });
    assert.equal(updates[0].status, expectedStatus);
    if (expectedStatus === "failed") assert.ok(new Date(updates[0].nextAttemptAt) > new Date("2026-09-29T08:00:00.000Z"));
  }
});
