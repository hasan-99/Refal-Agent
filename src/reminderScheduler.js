const { safeErrorDiagnostics } = require("./operationalTelemetry");

function reminderText(appointment, job = {}) {
  const start = new Intl.DateTimeFormat("en-GB", {
    timeZone: appointment.timezone || "Europe/Nicosia",
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(appointment.starts_at));
  const base = `Reminder: your meeting is scheduled for ${start} (${appointment.timezone || "Europe/Nicosia"}).`;
  if (job.reminder_kind === "meet_link_1h") return appointment.google_meet_url
    ? `${base}\nGoogle Meet: ${appointment.google_meet_url}`
    : `${base}\nThe meeting link is not available yet. Please contact Refalco Group if you need help.`;
  return base;
}

async function runReminderCheck({ store, socket, now = new Date(), logEvent = () => {} }) {
  if (!store.claimDueReminders || !store.getAppointment || !store.updateReminder) {
    throw new Error("Supabase reminder queue methods are unavailable.");
  }
  const jobs = await store.claimDueReminders(25);
  let sent = 0;
  for (const job of jobs) {
    try {
      const appointment = await store.getAppointment(job.appointment_id);
      if (!appointment || appointment.status !== "confirmed") {
        await store.updateReminder(job.id, { status: "cancelled" });
        continue;
      }
      if (typeof store.isContactBlocked === "function" && await store.isContactBlocked(job.recipient)) {
        await store.updateReminder(job.id, { status: "cancelled" });
        continue;
      }
      if (job.channel !== "whatsapp") throw new Error(`Unsupported reminder channel: ${job.channel}`);
      // Re-read immediately before the external send so a cancellation or
      // reschedule while this job was being prepared does not send stale data.
      const latestAppointment = await store.getAppointment(job.appointment_id);
      if (!latestAppointment || latestAppointment.status !== "confirmed"
        || latestAppointment.starts_at !== appointment.starts_at) {
        await store.updateReminder(job.id, { status: "cancelled" });
        continue;
      }
      const result = await socket.sendMessage(job.recipient, { text: reminderText(latestAppointment, job) });
      await store.updateReminder(job.id, {
        status: "sent",
        sentAt: now.toISOString(),
        providerMessageId: result?.key?.id || ""
      });
      sent += 1;
      logEvent("appointment_reminder_sent", { appointmentId: latestAppointment.id, reminderId: job.id });
    } catch (error) {
      const lastError = String(error?.message || "Reminder delivery failed.").slice(0, 1000);
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
