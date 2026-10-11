const nodemailer = require("nodemailer");

function safeText(value, limit = 500) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
}

function buildOwnerReviewEmail(job) {
  const payload = job?.payload || {};
  const timezone = safeText(payload.timezone, 80) || "Europe/Nicosia";
  let when = "Not provided";
  try { when = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, dateStyle: "full", timeStyle: "short" }).format(new Date(payload.startsAt)); }
  catch { /* Keep a non-sensitive fallback for malformed persisted payloads. */ }
  const dashboardUrl = safeText(payload.dashboardUrl, 500);
  const validDashboardUrl = (() => { try { const url = new URL(dashboardUrl); return ["https:", "http:"].includes(url.protocol) ? url.href : ""; } catch { return ""; } })();
  return [
    "A customer-approved Refalco Group appointment request is waiting for admin review. It is not confirmed.",
    "",
    `Time: ${when} (${timezone})`,
    `Customer: ${safeText(payload.name, 100) || "Not provided"}`,
    `WhatsApp: ${safeText(payload.phone, 40) || "Not provided"}`,
    `Purpose: ${safeText(payload.purpose, 500) || "Not provided"}`,
    "",
    validDashboardUrl ? `Review in dashboard: ${validDashboardUrl}` : "Open Refalco Group dashboard and choose Bookings."
  ].join("\n");
}

function buildHandoverReviewEmail(job) {
  const payload = job?.payload || {};
  const dashboardUrl = safeText(payload.dashboardUrl, 700);
  const validDashboardUrl = (() => { try { const url = new URL(dashboardUrl); return ["https:", "http:"].includes(url.protocol) ? url.href : ""; } catch { return ""; } })();
  return [
    "A customer interaction requires specialist review. Review it in the admin dashboard; this internal alert is not permission to contact the customer and is not an appointment.",
    "",
    `Department: ${safeText(payload.department, 100) || "General"}`,
    `Priority: ${safeText(payload.priority, 30) || "Normal"}`,
    `Intent: ${safeText(payload.intent, 100) || "Not classified"}`,
    `Customer: ${safeText(payload.name, 120) || "Name not provided yet"}`,
    `Request: ${safeText(payload.need, 700) || "See the conversation for context."}`,
    validDashboardUrl ? `Open handover: ${validDashboardUrl}` : "Open the dashboard and choose Follow-ups.",
    "",
    "Only prepare customer follow-up when the contact has granted current, purpose-specific consent. Drafts are not sent until an admin approves them."
  ].join("\n");
}

function buildAdminFollowUpEmail(job) {
  const payload = job?.payload || {};
  const subject = safeText(payload.subject, 180) || "A follow-up from Refalco Group";
  const text = safeText(payload.text, 4000);
  return { subject, text };
}

function createMailer(env = process.env) {
  if (!env.SMTP_USER || !env.SMTP_PASS) throw new Error("SMTP credentials are not configured.");
  return nodemailer.createTransport({
    host: env.SMTP_HOST || "smtp.gmail.com",
    port: Number(env.SMTP_PORT || 465),
    secure: String(env.SMTP_SECURE || "true").toLowerCase() !== "false",
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS }
  });
}

async function runNotificationCheck({ store, socket, mailerFactory = createMailer, env = process.env, now = new Date(), logEvent = () => {}, notificationId = "", testRunId = "" }) {
  if (!store.updateNotification || !store.getAppointment) throw new Error("Supabase notification outbox methods are unavailable.");
  let jobs;
  if (notificationId) {
    if (!store.claimNotificationById) throw new Error("Isolated notification claiming is unavailable.");
    if (!testRunId) throw new Error("A P6.5 test run ID is required for isolated notification claiming.");
    jobs = await store.claimNotificationById(notificationId, testRunId);
  } else {
    if (!store.claimDueNotifications) throw new Error("Supabase notification batch claiming is unavailable.");
    jobs = await store.claimDueNotifications(25);
  }
  if (notificationId && (jobs.length > 1 || jobs.some((job) => job.id !== notificationId || job.kind !== "handover_review" || job.payload?.p65TestRunId !== testRunId))) {
    throw new Error("Isolated notification claim returned a job outside the requested P6.5 test.");
  }
  let sent = 0;
  for (const job of jobs) {
    try {
      if (job.appointment_id) {
        const appointment = await store.getAppointment(job.appointment_id);
        if (!appointment || (job.expected_appointment_status && appointment.status !== job.expected_appointment_status)) {
          await store.updateNotification(job.id, { status: "cancelled", lastError: "Appointment changed before notification delivery." });
          continue;
        }
      }
      if (job.kind === "handover_review") {
        if (typeof store.getHandoverStatus !== "function") throw new Error("Handover status verification is unavailable.");
        const handover = await store.getHandoverStatus(job.handover_id);
        if (!handover || !["open", "acknowledged"].includes(handover.status)) {
          await store.updateNotification(job.id, { status: "cancelled", lastError: "Handover closed before notification delivery." });
          continue;
        }
      }
      if (["customer_message", "admin_followup"].includes(job.kind) && job.channel === "whatsapp") {
        if (typeof store.isContactBlocked === "function" && await store.isContactBlocked(job.recipient)) {
          await store.updateNotification(job.id, { status: "cancelled", lastError: "Recipient is blocked." });
          continue;
        }
        if (!socket?.sendMessage) throw new Error("WhatsApp is not connected.");
        const text = safeText(job.payload?.text, 1500);
        if (!text) throw new Error("Notification text is empty.");
        const result = await socket.sendMessage(job.recipient, { text });
        await store.updateNotification(job.id, { status: "sent", sentAt: now.toISOString(), providerMessageId: result?.key?.id || "" });
      } else if (job.kind === "owner_review" && job.channel === "email") {
        const mailer = mailerFactory(env);
        const result = await mailer.sendMail({
          from: env.REPORT_EMAIL_FROM || env.SMTP_USER,
          to: job.recipient,
          subject: "New WhatsApp appointment request — review required",
          text: buildOwnerReviewEmail(job)
        });
        await store.updateNotification(job.id, { status: "sent", sentAt: now.toISOString(), providerMessageId: result.messageId || "" });
      } else if (job.kind === "handover_review" && job.channel === "email") {
        const mailer = mailerFactory(env);
        const result = await mailer.sendMail({
          from: env.REPORT_EMAIL_FROM || env.SMTP_USER,
          to: job.recipient,
          subject: "New specialist follow-up request — review required",
          text: buildHandoverReviewEmail(job)
        });
        await store.updateNotification(job.id, { status: "sent", sentAt: now.toISOString(), providerMessageId: result.messageId || "" });
      } else if (job.kind === "admin_followup" && job.channel === "email") {
        const mailer = mailerFactory(env);
        const result = await mailer.sendMail({
          from: env.REPORT_EMAIL_FROM || env.SMTP_USER,
          to: job.recipient,
          subject: buildAdminFollowUpEmail(job).subject,
          text: buildAdminFollowUpEmail(job).text
        });
        await store.updateNotification(job.id, { status: "sent", sentAt: now.toISOString(), providerMessageId: result.messageId || "" });
      } else throw new Error("Unsupported notification channel or type.");
      sent++;
      logEvent("notification_sent", { notificationId: job.id, appointmentId: job.appointment_id || null, channel: job.channel, kind: job.kind });
    } catch (error) {
      const attempts = Number(job.attempts || 1);
      const dead = attempts >= 5;
      const retryMinutes = Math.min(60, 5 * (2 ** Math.max(0, attempts - 1)));
      const lastError = safeText(error?.message || "Notification delivery failed.", 500);
      try {
        // SMTP errors and database failures can be ambiguous: the provider may
        // have accepted a message even when this worker did not receive or
        // persist confirmation. P6.5 runs are one-shot and fail closed rather
        // than automatically risking a duplicate email.
        await store.updateNotification(job.id, notificationId ? { status: "dead", lastError } : dead ? { status: "dead", lastError } : {
          status: "failed", lastError,
          nextAttemptAt: new Date(now.getTime() + retryMinutes * 60000).toISOString()
        });
      } catch (stateError) {
        logEvent("notification_state_error", { notificationId: job.id, message: safeText(stateError?.message, 200) });
      }
      logEvent("notification_delivery_error", { notificationId: job.id, channel: job.channel, dead, message: lastError });
    }
  }
  return { claimed: jobs.length, sent };
}

function startNotificationSchedule({ store, socket, logEvent = () => {} }) {
  let running = false;
  let stopped = false;
  const intervalMs = Math.max(15000, Number(process.env.RAFA_NOTIFICATION_POLL_MS) || 30000);
  const run = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const result = await runNotificationCheck({ store, socket, logEvent });
      if (result.claimed) logEvent("notification_check", result);
    } catch (error) {
      logEvent("notification_check_error", { message: safeText(error?.message, 300) });
    } finally { running = false; }
  };
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  run();
  return { stop() { stopped = true; clearInterval(timer); } };
}

module.exports = { buildOwnerReviewEmail, buildHandoverReviewEmail, buildAdminFollowUpEmail, runNotificationCheck, startNotificationSchedule };
