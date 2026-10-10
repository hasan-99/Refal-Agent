const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export function controlledP65Recipient(value) {
  const recipient = String(value || "").trim();
  return EMAIL.test(recipient) ? recipient : "";
}

export function isSyntheticP65Handover(handover, contact, testRunId) {
  const id = String(testRunId || "");
  if (!UUID.test(id) || !handover || !contact) return false;
  return handover.status === "open"
    && handover.summary?.p65TestRunId === id
    && contact.whatsapp_jid === `p65test-${id}@lid`;
}

export function canCreateP65TestNotification({ kind, testRunId, idempotencyKey, handover, contact, recipient }) {
  return kind === "handover_review"
    && UUID.test(String(testRunId || ""))
    && idempotencyKey === `p65-handover:${testRunId}`
    && Boolean(controlledP65Recipient(recipient))
    && isSyntheticP65Handover(handover, contact, testRunId);
}

export function canClaimP65TestNotification({ id, requestedId, kind, testRunId, recipient, configuredRecipient, status, payload }) {
  return UUID.test(String(requestedId || ""))
    && id === requestedId
    && kind === "handover_review"
    && UUID.test(String(testRunId || ""))
    && payload?.p65TestRunId === testRunId
    && status === "queued"
    && Boolean(controlledP65Recipient(configuredRecipient))
    && recipient === controlledP65Recipient(configuredRecipient);
}
