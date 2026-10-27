"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { claimInboundReceipt } = require("./inboundMessageReceipt");

const token = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

test("provider-ID turns fail closed when durable receipt support is missing", async () => {
  await assert.rejects(claimInboundReceipt({}, "15551234567@s.whatsapp.net", "message-1"), { code: "INBOUND_RECEIPT_UNAVAILABLE" });
  await assert.rejects(claimInboundReceipt({ claimInboundMessage: async () => ({ claimed: true, leaseToken: token }) }, "15551234567@s.whatsapp.net", "message-1"), { code: "INBOUND_RECEIPT_UNAVAILABLE" });
});

test("messages without a provider ID fail closed", async () => {
  await assert.rejects(claimInboundReceipt({ claimInboundMessage() {}, completeInboundMessage() {} }, "15551234567@s.whatsapp.net", ""), { code: "INBOUND_RECEIPT_UNAVAILABLE" });
});

test("a duplicate is ignored, while a successful claim must carry a UUID fence", async () => {
  const store = { claimInboundMessage: async () => ({ claimed: false, duplicate: true }), completeInboundMessage() {} };
  assert.deepEqual(await claimInboundReceipt(store, "15551234567@s.whatsapp.net", "message-1"), { duplicate: true, leaseToken: null });
  store.claimInboundMessage = async () => ({ claimed: true, duplicate: false, leaseToken: token });
  assert.deepEqual(await claimInboundReceipt(store, "15551234567@s.whatsapp.net", "message-1"), { duplicate: false, leaseToken: token });
  store.claimInboundMessage = async () => ({ claimed: true, leaseToken: "not-a-uuid" });
  await assert.rejects(claimInboundReceipt(store, "15551234567@s.whatsapp.net", "message-1"), { code: "INBOUND_RECEIPT_UNAVAILABLE" });
});

test("receipt claims reject contradictory or incomplete duplicate states instead of silently dropping a message", async () => {
  const store = { claimInboundMessage: async () => ({ claimed: false, duplicate: false }), completeInboundMessage() {} };
  await assert.rejects(claimInboundReceipt(store, "15551234567@s.whatsapp.net", "message-1"), { code: "INBOUND_RECEIPT_UNAVAILABLE" });
  store.claimInboundMessage = async () => ({ claimed: true, duplicate: true, leaseToken: token });
  await assert.rejects(claimInboundReceipt(store, "15551234567@s.whatsapp.net", "message-1"), { code: "INBOUND_RECEIPT_UNAVAILABLE" });
});
