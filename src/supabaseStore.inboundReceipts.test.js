"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EdgeApiStore } = require("./supabaseStore");

test("inbound receipt methods preserve the database fence token", async () => {
  const store = new EdgeApiStore({ apiUrl: "https://edge.test", key: "anon", apiSecret: "secret" });
  const calls = [];
  store.request = async (...args) => { calls.push(args); return { claimed: true, leaseToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }; };
  await store.claimInboundMessage("15551234567@s.whatsapp.net", "wamid-1");
  await store.completeInboundMessage("15551234567@s.whatsapp.net", "wamid-1", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.deepEqual(calls, [
    ["/messages/claim", { method: "POST", body: JSON.stringify({ userId: "15551234567@s.whatsapp.net", messageId: "wamid-1" }) }],
    ["/messages/complete", { method: "POST", body: JSON.stringify({ userId: "15551234567@s.whatsapp.net", messageId: "wamid-1", leaseToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }) }]
  ]);
});
