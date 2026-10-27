const { safeErrorDiagnostics } = require("./operationalTelemetry");
const { getAutomatedReminderConsent } = require("./leadQualification");

function reminderText(appointment, job = {}, language = "en") {
  const locale = language === "ar" || language === "arabic" ? "ar" : language === "el" || language === "greek" ? "el" : "en-GB";
  const start = new Intl.DateTimeFormat(locale, {
    timeZone: appointment.timezone || "Europe/Nicosia",
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(appointment.starts_at));
  const timezone = appointment.timezone || "Europe/Nicosia";
  const base = locale === "ar" ? `تذكير: موعدك في ${start} (${timezone}).`
    : locale === "el" ? `Υπενθύμιση: η συνάντησή σας είναι προγραμματισμένη για ${start} (${timezone}).`
      : `Reminder: your meeting is scheduled for ${start} (${timezone}).`;
  if (job.reminder_kind === "meet_link_1h") return appointment.google_meet_url
    ? `${base}\n${locale === "ar" ? "رابط Google Meet" : locale === "el" ? "Σύνδεσμος Google Meet" : "Google Meet"}: ${appointment.google_meet_url}`
    : `${base}\n${locale === "ar" ? "رابط الاجتماع غير متاح بعد. يُرجى التواصل مع Refalco Group إذا كنت بحاجة إلى مساعدة." : locale === "el" ? "Ο σύνδεσμος της συνάντησης δεν είναι ακόμη διαθέσιμος. Επικοινωνήστε με τη Refalco Group αν χρειάζεστε βοήθεια." : "The meeting link is not available yet. Please contact Refalco Group if you need help."}`;
  return base;
}

async function runReminderCheck({ store, socket, now = new Date(), logEvent = () => {} }) {
  if (!store.claimDueReminders || !store.getAppointment || !store.updateReminder) {
    throw new Error("Supabase reminder queue methods are unavailable.");
  }
  const jobs = await store.claimDueReminders(25);
  let sent = 0;
  for (const job of jobs) {
    let providerSendStarted = false;
    try {
      const appointment = await store.getAppointment(job.appointment_id);
      if (!appointment || appointment.status !== "confirmed"
        || !appointment.whatsapp_jid || appointment.whatsapp_jid !== job.recipient) {
        await store.updateReminder(job.id, { status: "cancelled" });
        continue;
      }
      // A reminder is outbound contact. If the durable suppression service is
      // unavailable, fail this job into the retry path instead of treating the
      // missing check as permission to send.
      if (typeof store.isContactBlocked !== "function") {
        throw new Error("Contact suppression check is unavailable.");
      }
      if (await store.isContactBlocked(job.recipient)) {
        await store.updateReminder(job.id, { status: "cancelled" });
        continue;
      }
      if (job.channel !== "whatsapp") throw new Error(`Unsupported reminder channel: ${job.channel}`);
      // Re-read immediately before the external send so a cancellation or
      // reschedule while this job was being prepared does not send stale data.
      const latestAppointment = await store.getAppointment(job.appointment_id);
      if (!latestAppointment || latestAppointment.status !== "confirmed"
        || latestAppointment.starts_at !== appointment.starts_at
        || latestAppointment.whatsapp_jid !== job.recipient) {
        await store.updateReminder(job.id, { status: "cancelled" });
        continue;
      }
      if (typeof store.getUser !== "function") {
        throw new Error("Automated reminder consent lookup is unavailable.");
      }
      const currentUser = await store.getUser(job.recipient);
      const reminderConsent = currentUser?.consent?.automatedReminder === "granted"
        ? getAutomatedReminderConsent(currentUser, now)
        : null;
      // Consent is scoped to the channel on which the customer agreed. A
      // durable grant for email or another channel cannot authorize WhatsApp.
      const consentChannel = String(reminderConsent?.channel || "").trim().toLowerCase();
      const deliveryChannel = String(job.channel || "").trim().toLowerCase();
      if (!reminderConsent || !deliveryChannel || consentChannel !== deliveryChannel) {
        await store.updateReminder(job.id, { status: "cancelled" });
        continue;
      }
      // Persist the no-reclaim marker before contacting WhatsApp. A worker
      // crash after this point is ambiguous, so the queue must not resend it.
      await store.updateReminder(job.id, { status: "sending" });
      providerSendStarted = true;
      const result = await socket.sendMessage(job.recipient, { text: reminderText(latestAppointment, job, reminderConsent.language) });
      await store.updateReminder(job.id, {
        status: "sent",
        sentAt: now.toISOString(),
        providerMessageId: result?.key?.id || ""
      });
      sent += 1;
      logEvent("appointment_reminder_sent", { appointmentId: latestAppointment.id, reminderId: job.id });
    } catch (error) {
      const lastError = String(error?.message || "Reminder delivery failed.").slice(0, 1000);
      if (providerSendStarted) {
        // Provider errors and post-send persistence errors do not prove that
        // the message was rejected. Mark uncertain and never retry it.
        try {
          await store.updateReminder(job.id, { status: "uncertain", lastError });
        } catch (stateError) {
          // The durable `sending` marker is excluded from due claims, so it is
          // still safe if recording the final ambiguous outcome also fails.
          logEvent("appointment_reminder_state_error", { reminderId: job.id, message: String(stateError?.message || "State update failed").slice(0, 300) });
        }
        logEvent("appointment_reminder_uncertain", { reminderId: job.id, message: lastError });
        continue;
      }
      const exhausted = Number(job.attempts || 0) >= 5;
      try {
        await store.updateReminder(job.id, exhausted ? {
          status: "dead",
          lastError
        } : {
          status: "failed",
          lastError,
          nextAttemptAt: new Date(now.getTime() + Math.min(60, 5 * (2 ** Math.max(0, Number(job.attempts || 1) - 1))) * 60000).toISOString()
        });
      } catch (stateError) {
        logEvent("appointment_reminder_state_error", { reminderId: job.id, message: String(stateError?.message || "State update failed").slice(0, 300) });
      }
      logEvent("appointment_reminder_error", { reminderId: job.id, exhausted, message: lastError });
    }
  }
  return { claimed: jobs.length, sent };
}

function startReminderSchedule({ store, socket, logEvent = () => {} }) {
  let running = false;
  let stopped = false;
  const interval = Math.max(15000, Number(process.env.BOOKING_REMINDER_POLL_MS) || 30000);
  const run = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const result = await runReminderCheck({ store, socket, logEvent });
      if (result.claimed) logEvent("appointment_reminder_check", result);
    } catch (error) {
      console.error("Appointment reminder check failed:", safeErrorDiagnostics(error));
      logEvent("appointment_reminder_check_error", safeErrorDiagnostics(error));
    } finally {
      running = false;
    }
  };
  const timer = setInterval(run, interval);
  timer.unref?.();
  run();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    }
  };
}

module.exports = { reminderText, runReminderCheck, startReminderSchedule };
