import assert from "node:assert/strict";
import test from "node:test";
import { persistDynamicActionAlert } from "./dynamicActionAlert.mjs";

test("persists a bounded, typed internal alert tied to the verified source turn", async () => {
  let call;
  const result = await persistDynamicActionAlert({
    rpc: async (name, args) => {
      call = { name, args };
      return { data: { id: "alert-1", trigger: "action_reconciliation", status: "open" }, error: null };
    }
  }, {
    contactId: "contact-1", sourceTurnId: "8ed4acd5-d3cb-4c8e-aa2a-6651414a564a",
    tool: "createHandover", receiptId: "r".repeat(120), reasonCode: "outcome_uncertain"
  });
  assert.equal(result.id, "alert-1");
  assert.equal(call.name, "refal_upsert_dynamic_action_alert");
  assert.equal(call.args.p_contact_id, "contact-1");
  assert.equal(call.args.p_source_turn_id, "8ed4acd5-d3cb-4c8e-aa2a-6651414a564a");
  assert.equal(call.args.p_details.receipt_id.length, 80);
  assert.equal(call.args.p_details.reason, "outcome_uncertain");
});

test("rejects unknown tools and does not hide alert persistence failure", async () => {
  const input = { contactId: "contact-1", sourceTurnId: "8ed4acd5-d3cb-4c8e-aa2a-6651414a564a", tool: "sendMessage" };
  await assert.rejects(persistDynamicActionAlert({ rpc: async () => ({}) }, input), /verified action reference/);
  await assert.rejects(persistDynamicActionAlert({ rpc: async () => ({ data: null, error: new Error("db unavailable") }) }, { ...input, tool: "createHandover" }), /db unavailable/);
  await assert.rejects(persistDynamicActionAlert({ rpc: async () => ({ data: null, error: null }) }, { ...input, tool: "createHandover" }), /not persisted/);
});
