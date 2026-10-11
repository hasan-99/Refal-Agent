import test from "node:test";
import assert from "node:assert/strict";
import { claimInboundMessage, completeInboundMessage } from "./inboundMessageReceipts.mjs";

test("claim uses one atomic RPC and returns the lease fence only to the owner", async () => {
  let call;
  const supabase = { async rpc(name, args) { call = { name, args }; return { data: { claimed: true, lease_token: args.p_lease_token }, error: null }; } };
  const input = { userId: "15551234567@s.whatsapp.net", messageId: "wamid-1", leaseToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
  assert.deepEqual(await claimInboundMessage(supabase, input), { claimed: true, duplicate: false, leaseToken: input.leaseToken });
  assert.deepEqual(call, { name: "refal_claim_inbound_message", args: { p_whatsapp_jid: input.userId, p_message_id: input.messageId, p_lease_token: input.leaseToken } });
});

test("claim contention returns a duplicate without exposing a lease", async () => {
  const supabase = { async rpc() { return { data: { claimed: false, duplicate: true }, error: null }; } };
  assert.deepEqual(await claimInboundMessage(supabase, { userId: "15551234567@s.whatsapp.net", messageId: "wamid-1", leaseToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }), { claimed: false, duplicate: true, leaseToken: null });
});

test("completion is fenced by the exact lease token and reports a lost lease", async () => {
  let args;
  const supabase = { async rpc(name, value) { assert.equal(name, "refal_complete_inbound_message"); args = value; return { data: { processed: false }, error: null }; } };
  const input = { userId: "15551234567@s.whatsapp.net", messageId: "wamid-1", leaseToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
  assert.deepEqual(await completeInboundMessage(supabase, input), { processed: false });
  assert.deepEqual(args, { p_whatsapp_jid: input.userId, p_message_id: input.messageId, p_lease_token: input.leaseToken });
});

test("RPC failures remain errors so the bot can fail closed", async () => {
  const supabase = { async rpc() { return { data: null, error: new Error("database unavailable") }; } };
  await assert.rejects(claimInboundMessage(supabase, { userId: "15551234567@s.whatsapp.net", messageId: "wamid-1", leaseToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }), /database unavailable/);
  await assert.rejects(completeInboundMessage(supabase, { userId: "15551234567@s.whatsapp.net", messageId: "wamid-1", leaseToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }), /database unavailable/);
});
