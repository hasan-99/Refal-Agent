import assert from "node:assert/strict";
import test from "node:test";
import { canClaimP65TestNotification, canCreateP65TestNotification, controlledP65Recipient, isSyntheticP65Handover } from "./p65TestRouting.mjs";

const runId = "3a623eb1-0a75-4df7-9fb8-258a70cc2911";
const recipient = "hasan.cy99@gmail.com";
const handover = { id: "h1", status: "open", summary: { p65TestRunId: runId } };
const contact = { whatsapp_jid: `p65test-${runId}@lid` };

test("controlled recipient is accepted only as an email configuration value", () => {
  assert.equal(controlledP65Recipient(recipient), recipient);
  assert.equal(controlledP65Recipient("sandbox@refalco.test"), "sandbox@refalco.test");
  assert.equal(controlledP65Recipient("not-an-email"), "");
  assert.equal(controlledP65Recipient(""), "");
});

test("only a tagged synthetic open handover can create a controlled test notification", () => {
  const params = { kind: "handover_review", testRunId: runId, idempotencyKey: `p65-handover:${runId}`, handover, contact, recipient };
  assert.equal(isSyntheticP65Handover(handover, contact, runId), true);
  assert.equal(canCreateP65TestNotification(params), true);
  assert.equal(canCreateP65TestNotification({ ...params, kind: "customer_message" }), false);
  assert.equal(canCreateP65TestNotification({ ...params, idempotencyKey: "customer-follow-up" }), false);
  assert.equal(canCreateP65TestNotification({ ...params, handover: { ...handover, summary: {} } }), false);
  assert.equal(canCreateP65TestNotification({ ...params, contact: { whatsapp_jid: "35799123456@s.whatsapp.net" } }), false);
  assert.equal(canCreateP65TestNotification({ ...params, handover: { ...handover, summary: { p65TestRunId: "a8d4f7e2-8f20-4e42-bd03-c9b86083a719" } } }), false, "a different run marker cannot redirect a normal handover");
});

test("claim-by-ID policy requires the exact tagged admin handover job and rejects customer jobs", () => {
  const job = { id: "3a623eb1-0a75-4df7-9fb8-258a70cc2922", kind: "handover_review", testRunId: runId, recipient, status: "queued", payload: { p65TestRunId: runId } };
  const base = { ...job, requestedId: job.id, configuredRecipient: recipient };
  assert.equal(canClaimP65TestNotification(base), true);
  assert.equal(canClaimP65TestNotification({ ...base, requestedId: "3a623eb1-0a75-4df7-9fb8-258a70cc2923" }), false);
  assert.equal(canClaimP65TestNotification({ ...base, kind: "customer_message" }), false);
  assert.equal(canClaimP65TestNotification({ ...base, recipient: "customer@example.com" }), false);
  assert.equal(canClaimP65TestNotification({ ...base, payload: {} }), false);
  assert.equal(canClaimP65TestNotification({ ...base, status: "sent" }), false);
  assert.equal(canClaimP65TestNotification({ ...base, status: "processing" }), false, "an ambiguous or expired claim cannot be reclaimed and resend mail");
  assert.equal(canClaimP65TestNotification({ ...base, status: "failed" }), false, "a test failure requires a new audited run rather than a potentially duplicate retry");
  assert.equal(canClaimP65TestNotification({ ...base, configuredRecipient: "" }), false);
});
