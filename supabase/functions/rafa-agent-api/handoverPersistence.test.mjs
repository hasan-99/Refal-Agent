import test from "node:test";
import assert from "node:assert/strict";
import { buildSafeHistoryInsert, hasPurposeBoundFollowUpConsent, sanitizeInboundHistoryText } from "./handoverPersistence.mjs";

test("Edge history persistence redacts privacy-risk messages before database insertion", () => {
  const payloadText = sanitizeInboundHistoryText("Password: SecretPhrase-81; help me set up a company");
  assert.equal(payloadText, "[message omitted: potentially sensitive credentials]");
  assert.doesNotMatch(payloadText, /SecretPhrase-81|company/);
  assert.equal(sanitizeInboundHistoryText("I want information about company formation"), "I want information about company formation");
  const requestPayload = buildSafeHistoryInsert({ contactId: "contact-1", id: "customer-1" }, { message: "Password: SecretPhrase-81", response: "Use a secure channel." });
  assert.equal(requestPayload.contact_id, "contact-1");
  assert.equal(requestPayload.message, "[message omitted: potentially sensitive credentials]");
  assert.doesNotMatch(JSON.stringify(requestPayload), /SecretPhrase-81/);
});

test("Edge defense in depth omits IBAN and identity secrets from message, response, metadata, and handover summary", () => {
  const payload = buildSafeHistoryInsert({ contactId: "contact-1", id: "customer-1" }, {
    message: "Company setup. IBAN: CY17 0020 0128 0000 0012 0052 7600",
    response: "OTP 839102 was received",
    metadata: { handover: { summary: { requirements: { passportNumber: "P1234567" }, lastMessage: "CVV: 123" } } }
  });
  assert.doesNotMatch(JSON.stringify(payload), /CY17|0020 0128|839102|P1234567|CVV: 123/);
  assert.equal(payload.message, "[message omitted: potentially sensitive credentials]");
  assert.match(JSON.stringify(payload), /\[redacted\]/);
});

test("outbound follow-up consent must link a granted purpose-specific source turn", () => {
  const consent = { state: "granted", source_turn_id: "turn-1" };
  const valid = { id: "turn-1", metadata: { specialistFollowUp: { consented: true, purpose: "specialist_follow_up" } } };
  assert.equal(hasPurposeBoundFollowUpConsent(consent, valid), true);
  assert.equal(hasPurposeBoundFollowUpConsent({ ...consent, state: "denied" }, valid), false);
  assert.equal(hasPurposeBoundFollowUpConsent({ ...consent, state: "revoked" }, valid), false);
  assert.equal(hasPurposeBoundFollowUpConsent(consent, { ...valid, id: "turn-2" }), false);
  assert.equal(hasPurposeBoundFollowUpConsent(consent, { id: "turn-1", metadata: {} }), false);
  assert.equal(hasPurposeBoundFollowUpConsent({ state: "granted" }, valid), false);
});
