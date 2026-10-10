const assert = require("node:assert/strict");
const { test } = require("node:test");
const { runP65LiveVerification } = require("./runP65LiveVerification");

const testRunId = "3a623eb1-0a75-4df7-9fb8-258a70cc2911";
const notificationId = "3a623eb1-0a75-4df7-9fb8-258a70cc2922";
const env = { RAFA_P65_TEST_RECIPIENT: "hasan.cy99@gmail.com", SMTP_USER: "sender@example.test", SMTP_PASS: "test-only" };

test("one-shot P6.5 runner creates then claims only its ID and never calls batch claiming", async () => {
  const calls = [];
  const store = {
    createP65TestHandoverNotification: async (id) => {
      calls.push(["create", id]);
      return { created: true, notification: { id: notificationId, kind: "handover_review", recipient: env.RAFA_P65_TEST_RECIPIENT, payload: { p65TestRunId: id } } };
    },
    claimDueNotifications: async () => { throw new Error("production batch must never run in the one-shot script"); },
    claimNotificationById: async (id, runId) => { calls.push(["claim", id, runId]); return [{ id, handover_id: "synthetic", kind: "handover_review", channel: "email", recipient: env.RAFA_P65_TEST_RECIPIENT, attempts: 1, payload: { p65TestRunId: runId } }]; },
    getHandoverStatus: async () => ({ status: "open" }),
    getAppointment: async () => null,
    updateNotification: async (id, patch) => calls.push(["update", id, patch.status])
  };
  let sent = 0;
  const result = await runP65LiveVerification({
    store, env, testRunId,
    mailerFactory: () => ({ sendMail: async (message) => { sent++; assert.equal(message.to, env.RAFA_P65_TEST_RECIPIENT); return { messageId: "synthetic-provider-id" }; } })
  });
  assert.deepEqual(result, { testRunId, notificationId, created: true, claimed: 1, sent: 1 });
  assert.deepEqual(calls, [["create", testRunId], ["claim", notificationId, testRunId], ["update", notificationId, "sent"]]);
  assert.equal(sent, 1);
});

test("one-shot P6.5 runner refuses mismatched recipients and missing SMTP config before claiming", async () => {
  let claims = 0;
  const store = {
    createP65TestHandoverNotification: async () => ({ notification: { id: notificationId, kind: "handover_review", recipient: "someone-else@example.test", payload: { p65TestRunId: testRunId } } }),
    claimNotificationById: async () => { claims++; return []; }
  };
  await assert.rejects(runP65LiveVerification({ store, env, testRunId }), /matching controlled P6\.5 notification/i);
  await assert.rejects(runP65LiveVerification({ store, env: { RAFA_P65_TEST_RECIPIENT: env.RAFA_P65_TEST_RECIPIENT }, testRunId }), /SMTP_USER and SMTP_PASS/i);
  assert.equal(claims, 0);
});
