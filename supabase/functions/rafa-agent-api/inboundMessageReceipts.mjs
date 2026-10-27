/** Durable inbound receipt operations. The database functions provide the
 * atomic claim and token fence; this adapter never performs read-then-write. */
export async function claimInboundMessage(supabase, { userId, messageId, leaseToken }) {
  const { data, error } = await supabase.rpc("refal_claim_inbound_message", {
    p_whatsapp_jid: userId,
    p_message_id: messageId,
    p_lease_token: leaseToken
  });
  if (error) throw error;
  const claimed = data?.claimed === true;
  return {
    claimed,
    duplicate: !claimed,
    leaseToken: claimed && typeof data.lease_token === "string" ? data.lease_token : null
  };
}

export async function completeInboundMessage(supabase, { userId, messageId, leaseToken }) {
  const { data, error } = await supabase.rpc("refal_complete_inbound_message", {
    p_whatsapp_jid: userId,
    p_message_id: messageId,
    p_lease_token: leaseToken
  });
  if (error) throw error;
  return { processed: data?.processed === true };
}
