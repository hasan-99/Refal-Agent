const assert = require("node:assert/strict");
const { test } = require("node:test");
const { buildOwnerReviewEmail, buildHandoverReviewEmail, runNotificationCheck } = require("./notificationScheduler.js");

function fakeStore(job, appointment = { id: job.appointment_id, status: job.expected_appointment_status }) {
  const updates = [];
  return {
    updates,
    claimDueNotifications: async () => [job],
    getAppointment: async () => appointment,
    updateNotification: async (id, patch) => updates.push({ id, patch })
  };
}

test("owner review email is an admin-facing dashboard notice and never claims the booking is confirmed", () => {
  const body = buildOwnerReviewEmail({ payload: {
    name: "Rana", phone: "+35799123456", startsAt: "2026-10-02T07:00:00.000Z",
    timezone: "Europe/Nicosia", purpose: "Consultation", dashboardUrl: "https://dashboard.example.test"
  } });
  assert.match(body, /waiting for admin review/);
  assert.match(body, /not confirmed/);
  assert.match(body, /dashboard\.example\.test/);
  assert.doesNotMatch(body, /Sources:|Refalco Group\.com/);
});

test("durable outbox sends owner email and records its message ID", async () => {
  const job = { id: "job-1", appointment_id: "appointment-1", channel: "email", kind: "owner_review", recipient: "hasan.cy99@gmail.com", expected_appointment_status: "pending_review", attempts: 1, payload: { startsAt: "2026-10-02T07:00:00.000Z", timezone: "Europe/Nicosia" } };
  const store = fakeStore(job);
  let mail;
  const result = await runNotificationCheck({
    store,
    mailerFactory: () => ({ sendMail: async (value) => { mail = value; return { messageId: "smtp-1" }; } }),
    env: { SMTP_USER: "sender@example.test", SMTP_PASS: "configured", SMTP_HOST: "smtp.example.test" },
    now: new Date("2026-10-01T10:00:00.000Z")
  });
  assert.deepEqual(result, { claimed: 1, sent: 1 });
  assert.equal(mail.to, "hasan.cy99@gmail.com");
  assert.equal(store.updates[0].patch.status, "sent");
  assert.equal(store.updates[0].patch.providerMessageId, "smtp-1");
});

test("handover alert tells admins to review a specialist request and links to the dashboard", () => {
  const email = buildHandoverReviewEmail({ payload: { department: "corporate_services", priority: "normal", intent: "company_formation", name: "Hasan", need: "Company setup", dashboardUrl: "https://dashboard.example.test/?section=follow-ups" } });
  assert.match(email, /internal alert is not permission to contact the customer/);
  assert.match(email, /purpose-specific consent/);
  assert.match(email, /not an appointment/);
  assert.match(email, /Hasan/);
  assert.match(email, /dashboard\.example\.test/);
});

test("handover-review outbox emails admin and records delivery without requiring an appointment", async () => {
  const job = { id: "handover-alert", handover_id: "handover-1", appointment_id: null, kind: "handover_review", channel: "email", recipient: "admin@example.test", attempts: 1, payload: { department: "corporate_services", need: "Company setup" } };
  const store = fakeStore(job);
  let sent;
  const result = await runNotificationCheck({ store, mailerFactory: () => ({ sendMail: async (mail) => { sent = mail; return { messageId: "alert-1" }; } }), env: { SMTP_USER: "agent@example.test", SMTP_PASS: "configured" } });
  assert.deepEqual(result, { claimed: 1, sent: 1 });
  assert.equal(sent.to, "admin@example.test");
  assert.match(sent.subject, /specialist follow-up request/);
  assert.match(sent.text, /Company setup/);
  assert.equal(store.updates[0].patch.status, "sent");
});

test("approved admin follow-up drafts use the selected WhatsApp or email channel", async () => {
  const whatsappJob = { id: "whatsapp-followup", appointment_id: null, kind: "admin_followup", channel: "whatsapp", recipient: "35799123456@s.whatsapp.net", attempts: 1, payload: { text: "Thanks for asking about company setup." } };
  const whatsappStore = fakeStore(whatsappJob);
  let delivered;
  await runNotificationCheck({ store: whatsappStore, socket: { sendMessage: async (jid, message) => { delivered = { jid, message }; return { key: { id: "wa-1" } }; } } });
  assert.deepEqual(delivered, { jid: whatsappJob.recipient, message: { text: whatsappJob.payload.text } });
  assert.equal(whatsappStore.updates[0].patch.status, "sent");

  const emailJob = { id: "email-followup", appointment_id: null, kind: "admin_followup", channel: "email", recipient: "client@example.test", attempts: 1, payload: { subject: "Company setup follow-up", text: "Here are the next steps." } };
  const emailStore = fakeStore(emailJob);
  let sent;
  await runNotificationCheck({ store: emailStore, mailerFactory: () => ({ sendMail: async (mail) => { sent = mail; return { messageId: "email-1" }; } }), env: { SMTP_USER: "agent@example.test", SMTP_PASS: "configured" } });
  assert.equal(sent.to, emailJob.recipient);
  assert.equal(sent.subject, emailJob.payload.subject);
  assert.equal(sent.text, emailJob.payload.text);
});

test("stale appointment notifications are cancelled without delivery", async () => {
  const job = { id: "job-2", appointment_id: "appointment-1", channel: "whatsapp", kind: "customer_message", recipient: "35799123456@s.whatsapp.net", expected_appointment_status: "confirmed", attempts: 1, payload: { text: "Confirmed" } };
  const store = fakeStore(job, { id: "appointment-1", status: "cancelled" });
  let sends = 0;
  const result = await runNotificationCheck({ store, socket: { sendMessage: async () => { sends++; } } });
  assert.equal(result.sent, 0);
  assert.equal(sends, 0);
  assert.equal(store.updates[0].patch.status, "cancelled");
});

test("transient delivery failures retry with bounded backoff and eventually dead-letter", async () => {
  const job = { id: "job-3", appointment_id: "appointment-1", channel: "whatsapp", kind: "customer_message", recipient: "35799123456@s.whatsapp.net", expected_appointment_status: "confirmed", attempts: 2, payload: { text: "Confirmed" } };
  const store = fakeStore(job);
  await runNotificationCheck({ store, socket: { sendMessage: async () => { throw new Error("WhatsApp offline"); } }, now: new Date("2026-10-01T10:00:00.000Z") });
  assert.equal(store.updates[0].patch.status, "failed");
  assert.equal(Date.parse(store.updates[0].patch.nextAttemptAt), Date.parse("2026-10-01T10:10:00.000Z"));
  job.attempts = 5;
  await runNotificationCheck({ store, socket: { sendMessage: async () => { throw new Error("still offline"); } } });
  assert.equal(store.updates[1].patch.status, "dead");
});
