const ACTION_NAMES = new Set([
  "upsertLead", "createHandover", "holdOrBookAppointment",
  "scheduleFollowUp", "recordComplianceEvent"
]);

/** Persist one operator-visible reconciliation item for an uncertain write. */
/** @param {any} client @param {{contactId:string,sourceTurnId:string|null,tool:string,receiptId?:string|null,reasonCode?:string}} input */
export async function persistDynamicActionAlert(client, {
  contactId, sourceTurnId, tool, receiptId = null, reasonCode = "outcome_uncertain"
} = {}) {
  if (!contactId || !/^[0-9a-f-]{36}$/i.test(String(sourceTurnId || "")) || !ACTION_NAMES.has(tool)) {
    throw new Error("A verified action reference is required for reconciliation alerting.");
  }
  const { data, error } = await client.rpc("refal_upsert_dynamic_action_alert", {
    p_contact_id: contactId,
    p_source_turn_id: sourceTurnId,
    p_details: {
      tool,
      receipt_id: typeof receiptId === "string" ? receiptId.slice(0, 80) : null,
      reason: /^[a-z][a-z0-9_]{0,79}$/.test(String(reasonCode)) ? reasonCode : "outcome_uncertain"
    }
  });
  if (error || !data?.id) throw error || new Error("Reconciliation alert was not persisted.");
  return data;
}
