const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { loadProjectEnv } = require("../src/env");
const { createStore } = require("../src/supabaseStore");
const { runNotificationCheck } = require("../src/notificationScheduler");

async function runP65LiveVerification({ store, mailerFactory, env = process.env, testRunId = randomUUID(), logEvent = () => {} }) {
  const controlledRecipient = String(env.RAFA_P65_TEST_RECIPIENT || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(controlledRecipient)) throw new Error("RAFA_P65_TEST_RECIPIENT must be configured to the controlled admin inbox.");
  if (!env.SMTP_USER || !env.SMTP_PASS) throw new Error("SMTP_USER and SMTP_PASS must be configured before a live P6.5 email can be sent.");
  if (!store?.createP65TestHandoverNotification || !store?.claimNotificationById) throw new Error("The isolated P6.5 Edge API routes are unavailable.");

  const created = await store.createP65TestHandoverNotification(testRunId);
  const notification = created?.notification;
  if (!notification?.id || notification.kind !== "handover_review" || notification.recipient?.toLowerCase() !== controlledRecipient || notification.payload?.p65TestRunId !== testRunId) {
    throw new Error("The Edge API did not return the matching controlled P6.5 notification; no delivery was attempted.");
  }
  const result = await runNotificationCheck({
    store,
    mailerFactory,
    env,
    notificationId: notification.id,
    testRunId,
    logEvent
  });
  return { testRunId, notificationId: notification.id, created: Boolean(created.created), ...result };
}

async function main() {
  const rootDir = path.join(__dirname, "..");
  loadProjectEnv(rootDir);
  const result = await runP65LiveVerification({ store: createStore() });
  // Deliberately omit recipient, message contents, and provider credentials.
  console.log(JSON.stringify(result));
  if (result.claimed !== 1 || result.sent !== 1) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`P6.5 live verification stopped safely: ${String(error?.message || error).slice(0, 300)}`);
    process.exitCode = 1;
  });
}

module.exports = { runP65LiveVerification };
