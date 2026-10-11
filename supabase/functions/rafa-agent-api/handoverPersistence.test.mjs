import test from "node:test";
import assert from "node:assert/strict";
import { areAdjacentConsentTurns, buildSafeHistoryInsert, hasPurposeBoundAutomatedReminderConsent, hasPurposeBoundFollowUpConsent, sanitizeInboundHistoryText } from "./handoverPersistence.mjs";

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

test("automated reminder consent requires a separate scope and linked offer and confirmation turns", () => {
  const offer = { id: "offer-1", response: "Would you like automated reminders for this request?", metadata: { automatedReminderOffer: { consentRequired: true, purpose: "automated_reminder", language: "en", channel: "whatsapp" } } };
  const confirmation = { id: "confirm-1", metadata: {
    automatedReminderConsent: { state: "granted", purpose: "automated_reminder", scope: "automated_reminder", offerSourceTurnId: "offer-1", language: "en", channel: "whatsapp" },
    followUpConsent: { state: "granted", purpose: "automated_reminder", sourceTurnId: "confirm-1", offerSourceTurnId: "offer-1", language: "en", channel: "whatsapp" }
  } };
  const consent = { consent_type: "automated_reminder", state: "granted", source_turn_id: "confirm-1", offer_source_turn_id: "offer-1", language: "en", channel: "whatsapp" };
  assert.equal(hasPurposeBoundAutomatedReminderConsent(consent, confirmation, offer), true);
  assert.equal(hasPurposeBoundAutomatedReminderConsent({ ...consent, state: "revoked" }, confirmation, offer), false);
  assert.equal(hasPurposeBoundAutomatedReminderConsent({ ...consent, consent_type: "follow_up" }, confirmation, offer), false);
  assert.equal(hasPurposeBoundAutomatedReminderConsent(consent, { ...confirmation, id: "other" }, offer), false);
  assert.equal(hasPurposeBoundAutomatedReminderConsent(consent, confirmation, { ...offer, metadata: {} }), false);
  assert.equal(hasPurposeBoundAutomatedReminderConsent({ ...consent, language: "el" }, confirmation, offer), false);
  assert.equal(areAdjacentConsentTurns([offer, confirmation], "offer-1", "confirm-1"), true);
  assert.equal(areAdjacentConsentTurns([offer, { id: "intervening" }, confirmation], "offer-1", "confirm-1"), false);
  assert.equal(areAdjacentConsentTurns([confirmation, offer], "offer-1", "confirm-1"), true, "the timestamp check establishes chronology without relying on UUID ordering for equal timestamps");
});
