import test from "node:test";
import assert from "node:assert/strict";
import { listDynamicData, mutateDynamicData, performDynamicAction } from "./dynamicData.mjs";

function fakeClient(rows = []) {
  const state = { calls: [], rpc: null };
  const query = {
    select(value) { state.calls.push(["select", value]); return this; },
    order(...args) { state.calls.push(["order", ...args]); return this; },
    limit(...args) { state.calls.push(["limit", ...args]); return this; },
    eq(...args) { state.calls.push(["eq", ...args]); return this; },
    lte(...args) { state.calls.push(["lte", ...args]); return this; },
    gt(...args) { state.calls.push(["gt", ...args]); return this; },
    then(resolve, reject) { return Promise.resolve({ data: rows, error: null }).then(resolve, reject); }
  };
  return {
    state,
    from(table) { state.calls.push(["from", table]); return query; },
    async rpc(name, args) { state.rpc = { name, args }; return { data: { id: "row-1" }, error: null }; }
  };
}

test("customer reads filter approved, active, verified, current rows and unavailable is explicit", async () => {
  const client = fakeClient([]);
  const result = await listDynamicData(client, "offers", { code: "formation-package" }, new Date("2026-10-10T00:00:00Z"));
  assert.equal(result.status, "unavailable");
  assert.equal(result.reasonCode, "NO_CURRENT_DATA");
  assert.ok(client.state.calls.some((call) => call[0] === "eq" && call[1] === "review_status" && call[2] === "approved"));
  assert.ok(client.state.calls.some((call) => call[0] === "lte" && call[1] === "effective_from"));
  assert.ok(client.state.calls.some((call) => call[0] === "gt" && call[1] === "valid_until"));
  assert.ok(client.state.calls.some((call) => call[0] === "eq" && call[1] === "code" && call[2] === "formation-package"));
});

test("operator reads can list draft and expired rows for correction", async () => {
  const client = fakeClient([{ id: "draft-1" }]);
  const result = await listDynamicData(client, "properties", { view: "admin" });
  assert.equal(result.status, "available");
  assert.equal(client.state.calls.some((call) => call[1] === "review_status"), false);
  assert.equal(client.state.calls.some((call) => call[1] === "available"), false);
});

test("unsupported tables and invalid edits fail before touching the gateway", async () => {
  const client = fakeClient();
  await assert.rejects(listDynamicData(client, "rafa_contacts"), { statusCode: 400 });
  await assert.rejects(mutateDynamicData(client, "offers", { operation: "drop" }), { statusCode: 400 });
  assert.equal(client.state.calls.length, 0);
});

test("typed mutations delegate to the audited RPC and require a reason", async () => {
  const client = fakeClient();
  const row = await mutateDynamicData(client, "offers", {
    operation: "update", id: "8ed4acd5-d3cb-4c8e-aa2a-6651414a564a",
    data: { amount: 1200 }, actor: "operator@example.test", reason: "Owner approved update"
  });
  assert.equal(row.id, "row-1");
  assert.equal(client.state.rpc.name, "refal_mutate_dynamic_data");
  assert.equal(client.state.rpc.args.p_kind, "offers");
  assert.equal(client.state.rpc.args.p_actor, "operator@example.test");
  await assert.rejects(mutateDynamicData(client, "offers", {
    operation: "create", data: { amount: 1200 }, actor: "operator@example.test", reason: ""
  }), { statusCode: 400 });
});

test("durable action receipts return confirmed only after a persisted row and never retry pending duplicates", async () => {
  let claimCount = 0;
  let finishCount = 0;
  const client = {
    async rpc(name) {
      if (name === "refal_claim_dynamic_action") {
        claimCount += 1;
        return { data: { claimed: claimCount === 1, receipt_id: "receipt-1", state: claimCount === 1 ? "pending" : "pending", result: null }, error: null };
      }
      finishCount += 1;
      return { data: { state: "confirmed" }, error: null };
    }
  };
  const body = { userId: "123@s.whatsapp.net", contactId: "contact-1", sourceTurnId: "8ed4acd5-d3cb-4c8e-aa2a-6651414a564a", idempotencyKey: "turn-1:upsertLead", args: { profile: { name: "Test" } } };
  let effects = 0;
  const first = await performDynamicAction(client, "upsertLead", body, async () => { effects += 1; return { id: "contact-1", status: "confirmed" }; });
  const second = await performDynamicAction(client, "upsertLead", body, async () => { effects += 1; return { id: "contact-1" }; });
  assert.equal(first.status, "confirmed");
  assert.equal(second.status, "pending");
  assert.equal(effects, 1);
  assert.equal(finishCount, 1);
});

test("ambiguous action failures remain pending for reconciliation", async () => {
  const states = [];
  const client = { async rpc(name, args) {
    if (name === "refal_claim_dynamic_action") return { data: { claimed: true, receipt_id: "receipt-2", state: "pending" }, error: null };
    states.push(args.p_state);
    return { data: { state: args.p_state }, error: null };
  } };
  const result = await performDynamicAction(client, "createHandover", {
    userId: "123@s.whatsapp.net", contactId: "contact-1", sourceTurnId: "8ed4acd5-d3cb-4c8e-aa2a-6651414a564a", idempotencyKey: "turn-2:handover", args: { department: "general" }
  }, async () => { throw new Error("network timeout after write"); });
  assert.equal(result.status, "pending");
  assert.deepEqual(states, []);
});

test("definitive handler rejection is durably failed and stays failed on duplicate", async () => {
  const states = [];
  let claimed = false;
  const client = { async rpc(name, args) {
    if (name === "refal_claim_dynamic_action") {
      if (!claimed) { claimed = true; return { data: { claimed: true, receipt_id: "receipt-rejected", state: "pending" }, error: null }; }
      return { data: { claimed: false, receipt_id: "receipt-rejected", state: "failed", result: { reasonCode: "ACTION_REJECTED" } }, error: null };
    }
    states.push(args.p_state);
    return { data: { state: args.p_state, result: args.p_result }, error: null };
  } };
  const body = { userId: "123@s.whatsapp.net", contactId: "contact-1", sourceTurnId: "8ed4acd5-d3cb-4c8e-aa2a-6651414a564a", idempotencyKey: "turn-3:handover", args: { department: "general" } };
  const execute = async () => { const error = new Error("Sensitive internal validation detail"); error.name = "HttpError"; error.statusCode = 403; throw error; };
  const first = await performDynamicAction(client, "createHandover", body, execute);
  const duplicate = await performDynamicAction(client, "createHandover", body, execute);
  assert.equal(first.status, "failed");
  assert.equal(first.reasonCode, "ACTION_REJECTED");
  assert.doesNotMatch(JSON.stringify(first), /Sensitive internal/u);
  assert.equal(duplicate.status, "failed");
  assert.deepEqual(states, ["failed"]);
});
