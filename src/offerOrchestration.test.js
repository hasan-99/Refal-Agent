"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { selectOfferForTurn } = require("./offerOrchestration");
const { SOURCE_LEVELS } = require("./policyPrecedence");

const ready = { answerComplete: true, humourLevel: 1 };
const hook = (id = "H1_IP_BOX") => ({ type: "hook", id, validated: true });

test("selects at most one candidate using explicit-request priority", () => {
  const result = selectOfferForTurn({
    context: { ...ready, explicitBookingRequest: true, explicitBookingConsent: true },
    candidates: [hook(), { type: "booking", id: "B1", validated: true }],
  });
  assert.equal(result.type, "booking");
  assert.equal(result.candidate.id, "B1");
});

test("booking is only selected after validated explicit request and consent", () => {
  const booking = { type: "booking", id: "B1", validated: true };
  assert.equal(selectOfferForTurn({ context: ready, candidates: [booking] }).type, "nothing");
  assert.equal(selectOfferForTurn({ context: { ...ready, explicitBookingRequest: true }, candidates: [booking] }).type, "nothing");
  assert.equal(selectOfferForTurn({ context: { ...ready, explicitBookingRequest: true, explicitBookingConsent: true }, candidates: [booking] }).type, "booking");
});

test("specialist action paths require consent; a validated offer may ask for consent without executing it", () => {
  const specialist = { type: "specialist", id: "S1", validated: true };
  assert.equal(selectOfferForTurn({ context: ready, candidates: [specialist] }).type, "nothing");
  assert.equal(selectOfferForTurn({ context: { ...ready, explicitSpecialistRequest: true }, candidates: [specialist] }).type, "nothing");
  assert.equal(selectOfferForTurn({ context: { ...ready, explicitSpecialistRequest: true, handoverConsent: true }, candidates: [specialist] }).type, "specialist");
  assert.equal(selectOfferForTurn({ context: ready, candidates: [{ ...specialist, mode: "offer", consentRequired: true, response: "Would you like a specialist to follow up?" }] }).type, "specialist");
  assert.equal(selectOfferForTurn({ context: ready, candidates: [{ ...specialist, mode: "offer", response: "Would you like a specialist to follow up?" }] }).type, "nothing");
});

test("hard suppression rules beat every offer candidate", () => {
  for (const state of [
    { optOut: true }, { declined: true }, { informational: true }, { complaint: true },
    { sensitive: true }, { noProactiveContact: true }, { pendingBooking: true },
    { handoverActive: true }, { complianceLock: true }, { humourLevel: 0 }, { answerComplete: false },
  ]) {
    assert.equal(selectOfferForTurn({ context: { ...ready, ...state }, candidates: [hook()] }).type, "nothing", JSON.stringify(state));
  }
});

test("hooks require a completed answer, positive humour, validation, and no prior offer", () => {
  assert.equal(selectOfferForTurn({ context: { answerComplete: false, humourLevel: 2 }, candidates: [hook()] }).type, "nothing");
  assert.equal(selectOfferForTurn({ context: { ...ready, humourLevel: 0 }, candidates: [hook()] }).type, "nothing");
  assert.equal(selectOfferForTurn({ context: { ...ready, answerComplete: false }, candidates: [{ type: "objection", id: "O1", validated: true }] }).type, "nothing");
  assert.equal(selectOfferForTurn({ context: ready, candidates: [{ ...hook(), validated: false }] }).type, "nothing");
  assert.equal(selectOfferForTurn({ context: ready, candidates: [hook()], previouslyOffered: ["H1_IP_BOX"] }).type, "nothing");
  assert.equal(selectOfferForTurn({ context: ready, candidates: [hook()] }).type, "hook");
});

test("objection and jurisdiction response paths require independent validation", () => {
  assert.equal(selectOfferForTurn({ context: ready, candidates: [{ type: "objection", id: "O1" }] }).type, "nothing");
  assert.equal(selectOfferForTurn({ context: ready, candidates: [{ type: "jurisdiction", id: "J1", validated: true }] }).type, "jurisdiction");
});

test("one winner only; objections precede guarded jurisdiction and proactive hooks", () => {
  const result = selectOfferForTurn({ context: ready, candidates: [
    hook(), { type: "jurisdiction", id: "J1", validated: true },
    { type: "objection", id: "O2", validated: true },
  ] });
  assert.equal(result.type, "objection");
  assert.equal(result.candidate.id, "O2");
});

test("policyPrecedence rejects a candidate when higher authority or privacy conflicts win", () => {
  const candidate = {
    type: "hook", id: "H1_IP_BOX", validated: true,
    source: { level: SOURCE_LEVELS.APPROVED_KNOWLEDGE, id: "evidence" },
    conflicts: [{ level: SOURCE_LEVELS.OWNER_POLICY, id: "no_proactive_offer" }],
  };
  assert.equal(selectOfferForTurn({ context: ready, candidates: [candidate] }).type, "nothing");

  const privateCandidate = {
    type: "objection", id: "O5", validated: true,
    conflicts: [{ level: SOURCE_LEVELS.PRIVACY_RULE, id: "privacy_lock" }],
  };
  assert.equal(selectOfferForTurn({ context: ready, candidates: [privateCandidate] }).type, "nothing");
});

test("current live evidence beats a stale approved-knowledge conflict", () => {
  const candidate = {
    type: "objection", id: "O1", validated: true,
    source: { level: SOURCE_LEVELS.LIVE_DATA, id: "current_offer" },
    conflicts: [{ level: SOURCE_LEVELS.APPROVED_KNOWLEDGE, id: "stale_chunk" }],
  };
  const result = selectOfferForTurn({ context: ready, candidates: [candidate] });
  assert.equal(result.type, "objection");
  assert.equal(result.candidate.id, "O1");
});

test("model knowledge cannot introduce a Refalco-specific offer", () => {
  const candidate = {
    type: "specialist", id: "S1", validated: true,
    source: { level: SOURCE_LEVELS.MODEL_KNOWLEDGE, id: "model" },
    text: "Refalco offers a guaranteed package.",
  };
  assert.equal(selectOfferForTurn({ context: { ...ready, explicitSpecialistRequest: true }, candidates: [candidate] }).type, "nothing");
});

test("empty, malformed, and unrecognized candidates fail closed", () => {
  assert.equal(selectOfferForTurn({ context: ready }).type, "nothing");
  assert.equal(selectOfferForTurn({ context: ready, candidates: [{ type: "booking" }] }).type, "nothing");
  assert.equal(selectOfferForTurn({ context: ready, candidates: [{ type: "execute_booking", validated: true }] }).type, "nothing");
});

test("a composed response with multiple questions is rejected", () => {
  assert.equal(selectOfferForTurn({ context: ready, candidates: [
    { type: "objection", id: "O1", validated: true, response: "Which offer? What does it include?" },
  ] }).type, "nothing");
  assert.equal(selectOfferForTurn({ context: ready, candidates: [
    { type: "objection", id: "O1", validated: true, language: "en", response: "Ποια προσφορά; Τι περιλαμβάνει;" },
  ] }).type, "nothing");
});
