"use strict";

const LEASE_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function receiptError(message) {
  const error = new Error(message);
  error.code = "INBOUND_RECEIPT_UNAVAILABLE";
  return error;
}

async function claimInboundReceipt(store, userId, messageId) {
  if (!String(messageId || "").trim()) throw receiptError("Inbound message identity is unavailable.");
  if (!store || typeof store.claimInboundMessage !== "function" || typeof store.completeInboundMessage !== "function") {
    throw receiptError("Durable inbound receipt support is unavailable.");
  }

  const receipt = await store.claimInboundMessage(userId, messageId);
  if (receipt?.claimed === false && receipt?.duplicate === true) return { duplicate: true, leaseToken: null };
  if (receipt?.claimed !== true || receipt?.duplicate !== false || !LEASE_TOKEN_PATTERN.test(String(receipt.leaseToken || ""))) {
    throw receiptError("Durable inbound receipt claim could not be verified.");
  }
  return { duplicate: false, leaseToken: receipt.leaseToken };
}

module.exports = { claimInboundReceipt, LEASE_TOKEN_PATTERN };
