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
    whatsapp_jid: "35799111222@s.whatsapp.net",
    starts_at: "2026-10-01T08:00:00.000Z",
    timezone: "Europe/Nicosia",
    ...overrides
  };
}

function reminderConsentedUser() {
  return {
    id: "35799111222@s.whatsapp.net",
    consent: { automatedReminder: "granted" },
    history: [{ id: "consent-turn", at: "2026-09-28T08:00:00.000Z", source: "whatsapp", message: "Yes, send me automated reminders", metadata: { followUpConsent: { state: "granted", purpose: "automated_reminder", sourceTurnId: "consent-turn", channel: "whatsapp", language: "en" } } }]
  };
}

test("sends a reminder only for a confirmed appointment and records provider ID", async () => {
  const updates = [];
  const sent = [];
  const store = {
    claimDueReminders: async () => [reminderJob()],
    getAppointment: async () => appointment(),
    getUser: async () => reminderConsentedUser(),
    isContactBlocked: async () => false,
    updateReminder: async (id, patch) => updates.push({ id, patch })
  };
  const result = await runReminderCheck({
    store,
    socket: { sendMessage: async (to, message) => { sent.push({ to, message }); return { key: { id: "wamid-1" } }; } },
    now: new Date("2026-09-29T08:00:00.000Z")
  });

  assert.deepEqual(result, { claimed: 1, sent: 1 });
  assert.equal(sent[0].to, "35799111222@s.whatsapp.net");
  assert.match(sent[0].message.text, /your meeting is scheduled/);
  assert.deepEqual(updates.map(({ patch }) => patch.status), ["sending", "sent"]);
  assert.equal(updates[1].patch.providerMessageId, "wamid-1");
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
      isContactBlocked: async () => false,
      updateReminder: async (_id, patch) => updates.push(patch)
    },
    socket: { sendMessage: async () => { sends += 1; } }
  });

  assert.equal(result.sent, 0);
  assert.equal(sends, 0);
  assert.deepEqual(updates, [{ status: "cancelled" }]);
});

test("automated reminders use the language recorded on the customer's consent turn", async () => {
  for (const [language, marker] of [["ar", "تذكير"], ["el", "Υπενθύμιση"]]) {
    const sent = [];
    const user = reminderConsentedUser();
    user.history[0].metadata.followUpConsent.language = language;
    await runReminderCheck({
      store: {
        claimDueReminders: async () => [reminderJob()],
        getAppointment: async () => appointment(),
        getUser: async () => user,
        isContactBlocked: async () => false,
        updateReminder: async () => {}
      },
      socket: { sendMessage: async (_to, message) => { sent.push(message.text); return {}; } }
    });
    assert.match(sent[0], new RegExp(marker));
  }
});

test("cancels a reminder when its recipient does not match the appointment contact", async () => {
  const updates = [];
  let sends = 0;
  await runReminderCheck({
    store: {
      claimDueReminders: async () => [reminderJob({ recipient: "35799110000@s.whatsapp.net" })],
      getAppointment: async () => appointment(),
      isContactBlocked: async () => false,
      updateReminder: async (_id, patch) => updates.push(patch)
    },
    socket: { sendMessage: async () => { sends += 1; } }
  });
  assert.equal(sends, 0);
  assert.deepEqual(updates, [{ status: "cancelled" }]);
});

test("formats appointment reminders in the appointment timezone across the Cyprus DST change", () => {
  const text = reminderText(appointment({ starts_at: "2026-10-25T07:30:00.000Z", timezone: "Europe/Nicosia" }));
  assert.match(text, /25 Oct 2026, 09:30 \(Europe\/Nicosia\)/);
});

test("does not send a reminder when contact suppression is unavailable", async () => {
  const updates = [];
  let sends = 0;
  await runReminderCheck({
    store: {
      claimDueReminders: async () => [reminderJob()],
      getAppointment: async () => appointment(),
      updateReminder: async (_id, patch) => updates.push(patch)
    },
    socket: { sendMessage: async () => { sends += 1; } },
    now: new Date("2026-09-29T08:00:00.000Z")
  });

  assert.equal(sends, 0);
  assert.equal(updates[0].status, "failed");
  assert.match(updates[0].lastError, /suppression check is unavailable/i);
  assert.ok(updates[0].nextAttemptAt);
});

test("does not send a reminder when contact suppression lookup fails", async () => {
  const updates = [];
  let sends = 0;
  await runReminderCheck({
    store: {
      claimDueReminders: async () => [reminderJob()],
      getAppointment: async () => appointment(),
      isContactBlocked: async () => { throw new Error("suppression service unavailable"); },
      updateReminder: async (_id, patch) => updates.push(patch)
    },
    socket: { sendMessage: async () => { sends += 1; } },
    now: new Date("2026-09-29T08:00:00.000Z")
  });

  assert.equal(sends, 0);
  assert.equal(updates[0].status, "failed");
  assert.match(updates[0].lastError, /suppression service unavailable/i);
});

test("cancels reminders when current automated-reminder consent is absent or revoked", async () => {
  const consented = reminderConsentedUser();
  for (const currentUser of [null, { ...consented, history: [] }, {
    ...consented,
    history: [...consented.history, { at: "2026-09-30T08:00:00Z", message: "Stop messaging me" }]
  }, { ...consented, consent: { automatedReminder: "revoked" } }]) {
    const updates = [];
    let sends = 0;
    await runReminderCheck({
      store: {
        claimDueReminders: async () => [reminderJob()],
        getAppointment: async () => appointment(),
        getUser: async () => currentUser,
        isContactBlocked: async () => false,
        updateReminder: async (_id, patch) => updates.push(patch)
      },
      socket: { sendMessage: async () => { sends += 1; } }
    });
    assert.equal(sends, 0);
    assert.deepEqual(updates, [{ status: "cancelled" }]);
  }
});

test("cancels a WhatsApp reminder when the recorded reminder consent is for another channel", async () => {
  const updates = [];
  let sends = 0;
  const user = reminderConsentedUser();
  user.history[0].metadata.followUpConsent.channel = "email";
  await runReminderCheck({
    store: {
      claimDueReminders: async () => [reminderJob()],
      getAppointment: async () => appointment(),
      getUser: async () => user,
      isContactBlocked: async () => false,
      updateReminder: async (_id, patch) => updates.push(patch)
    },
    socket: { sendMessage: async () => { sends += 1; } }
  });
  assert.equal(sends, 0);
  assert.deepEqual(updates, [{ status: "cancelled" }]);
});

test("does not send when automated-reminder consent lookup is unavailable", async () => {
  const updates = [];
  let sends = 0;
  await runReminderCheck({
    store: {
      claimDueReminders: async () => [reminderJob()],
      getAppointment: async () => appointment(),
      isContactBlocked: async () => false,
      updateReminder: async (_id, patch) => updates.push(patch)
    },
    socket: { sendMessage: async () => { sends += 1; } },
    now: new Date("2026-09-29T08:00:00.000Z")
  });
  assert.equal(sends, 0);
  assert.equal(updates[0].status, "failed");
  assert.match(updates[0].lastError, /consent lookup is unavailable/i);
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
      getUser: async () => reminderConsentedUser(),
      isContactBlocked: async () => false,
      updateReminder: async (_id, patch) => updates.push(patch)
    },
    socket: { sendMessage: async () => { sends += 1; } }
  });
  assert.equal(sends, 0);
  assert.deepEqual(updates, [{ status: "cancelled" }]);
});

test("provider failures are quarantined as ambiguous and never auto-retried", async () => {
  for (const attempts of [2, 5]) {
    const updates = [];
    let sends = 0;
    await runReminderCheck({
      store: {
      claimDueReminders: async () => [reminderJob({ attempts })],
      getAppointment: async () => appointment(),
      getUser: async () => reminderConsentedUser(),
      isContactBlocked: async () => false,
      updateReminder: async (_id, patch) => updates.push(patch)
      },
      socket: { sendMessage: async () => { sends += 1; throw new Error("provider timed out after accepting request"); } },
      now: new Date("2026-09-29T08:00:00.000Z")
    });
    assert.deepEqual(updates.map((patch) => patch.status), ["sending", "uncertain"]);
    assert.match(updates[1].lastError, /provider timed out/);
    assert.equal(sends, 1);
  }
});

test("cancels a reminder if the appointment contact changes during preparation", async () => {
  const updates = [];
  let reads = 0;
  let sends = 0;
  await runReminderCheck({
    store: {
      claimDueReminders: async () => [reminderJob()],
      getAppointment: async () => ++reads === 1
        ? appointment()
        : appointment({ whatsapp_jid: "35799110000@s.whatsapp.net" }),
      getUser: async () => reminderConsentedUser(),
      isContactBlocked: async () => false,
      updateReminder: async (_id, patch) => updates.push(patch)
    },
    socket: { sendMessage: async () => { sends += 1; } }
  });
  assert.equal(sends, 0);
  assert.deepEqual(updates, [{ status: "cancelled" }]);
});

test("a sent-state persistence error after provider acceptance is marked uncertain, never retryable", async () => {
  const updates = [];
  let sends = 0;
  await runReminderCheck({
    store: {
      claimDueReminders: async () => [reminderJob()],
      getAppointment: async () => appointment(),
      getUser: async () => reminderConsentedUser(),
      isContactBlocked: async () => false,
      updateReminder: async (_id, patch) => {
        updates.push(patch);
        if (patch.status === "sent") throw new Error("response lost after database commit");
      }
    },
    socket: { sendMessage: async () => { sends += 1; return { key: { id: "wamid-accepted" } }; } }
  });
  assert.equal(sends, 1);
  assert.deepEqual(updates.map((patch) => patch.status), ["sending", "sent", "uncertain"]);
});
