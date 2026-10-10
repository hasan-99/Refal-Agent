"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { appendGroundedHook, guardJurisdictionAnswer, buildObjectionAnswer, isComparisonRequest, requestedJurisdiction, hasInformationalIntent } = require("./salesIntelligence");
const { INTENTS } = require("./intent");

const expiry = "2026-12-31T00:00:00Z";
const verified = "2026-10-01T00:00:00Z";
function policyRow(topic, facts, content, factRegisterRows = facts.map((id) => ({ id, status: "approved", reviewer: "BOSS", verifiedAt: verified, effectiveFrom: null, expiryOrReviewAt: "2026-12-30", approvedLanguages: ["en", "ar", "el"] }))) {
  return { chunk_id: `${topic}-chunk`, content, review_status: "approved", valid_until: expiry,
    policyMetadata: { topic, facts, reviewStatus: "approved", validUntil: expiry, factRegisterRows } };
}

test("runtime appends one localized approved hook after the answer and returns persistence metadata", () => {
  const result = appendGroundedHook({
    message: "Our SaaS app is growing", response: "The current guidance covers software activity.", language: "english",
    rows: [policyRow("ip-box", ["MB-F20"], "IP Box is a Cyprus regime and is not automatic for every company.")],
    history: [], user: { profile: {} }
  });
  assert.equal(result.salesOffer.id, "H1_IP_BOX");
  assert.match(result.response, /not automatic for every company/u);
  assert.equal((result.response.match(/\?/gu) || []).length, 1);
  assert.equal(appendGroundedHook({ message: "Our SaaS app is growing", response: "The current guidance covers software activity.", language: "english",
    rows: [policyRow("ip-box", ["MB-F20"], "IP Box is a Cyprus regime and is not automatic for every company.")],
    history: [{ metadata: { salesOffer: { id: "H1_IP_BOX" } } }], user: { profile: {} } }).salesOffer, null);
});

test("runtime suppresses hooks for no-contact preferences and declines", () => {
  const input = { message: "Our SaaS app is growing", response: "The current guidance covers software activity.", language: "english",
    rows: [policyRow("ip-box", ["MB-F20"], "IP Box is a Cyprus regime and is not automatic for every company.")], history: [] };
  assert.equal(appendGroundedHook({ ...input, user: { profile: { conversationPreferences: { noProactiveBookingOrContact: true } } } }).salesOffer, null);
  assert.equal(appendGroundedHook({ ...input, message: "No thanks, our SaaS app is growing", user: { profile: {} } }).salesOffer, null);
});

test("runtime callers classify ordinary company and service questions as informational", () => {
  for (const intent of [INTENTS.AGENT_IDENTITY, INTENTS.COMPANY_INFO, INTENTS.BUSINESS_AREAS, INTENTS.SERVICES, INTENTS.CONTACT, INTENTS.GENERAL_INFORMATION, INTENTS.PRICING]) {
    assert.equal(hasInformationalIntent([intent]), true, intent);
  }
  const input = { message: "What services do you offer for software companies?", response: "The approved information covers software activity.", language: "en",
    rows: [policyRow("ip-box", ["MB-F20"], "IP Box is a Cyprus regime and is not automatic for every company.")], history: [] };
  assert.equal(appendGroundedHook({ ...input, suppressed: { informational: hasInformationalIntent([INTENTS.SERVICES]) } }).salesOffer, null);
});

test("automatic Arabizi and Greeklish detection localizes the selected hook", () => {
  const evidence = [policyRow("ip-box", ["MB-F20"], "IP Box is a Cyprus regime and is not automatic for every company.")];
  const greek = appendGroundedHook({ message: "ftiaxno efarmogi kai logismiko", response: "Η εγκεκριμένη πληροφορία καλύπτει τη δραστηριότητα λογισμικού.", rows: evidence });
  const arabic = appendGroundedHook({ message: "barmeje SaaS", response: "المعلومات المعتمدة تغطي نشاط البرمجيات.", rows: evidence });
  assert.match(greek.response, /Δεν εφαρμόζεται αυτόματα σε κάθε εταιρεία/iu);
  assert.match(arabic.response, /مو تلقائي لكل شركة/iu);
});

test("a specialist follow-up is added only after an answer, with consent and no repeat", () => {
  const input = { message: "We need a large land development and a strategic partnership", response: "The approved overview explains the initial planning steps.", language: "en", answerComplete: true, specialistEligible: true, history: [] };
  const offered = appendGroundedHook(input);
  assert.equal(offered.specialistOffer?.consentRequired, true);
  assert.match(offered.response, /With your permission/u);
  assert.equal((offered.response.match(/\?/gu) || []).length, 1);
  assert.equal(appendGroundedHook({ ...input, answerComplete: false }).specialistOffer, undefined);
  assert.equal(appendGroundedHook({ ...input, suppressed: { optOut: true } }).specialistOffer, undefined);
  assert.equal(appendGroundedHook({ ...input, history: [{ metadata: { specialistOffer: { consentRequired: true, offeredAt: new Date().toISOString() } } }] }).specialistOffer, undefined);
});

test("jurisdiction runtime fails closed without server-enriched current register rows", () => {
  const result = guardJurisdictionAnswer({ message: "Compare Cyprus and Dubai", response: "Dubai has a coastline. Where are your clients, your bank, and your family?", rows: [] });
  assert.equal(result.valid, false);
  assert.match(result.response, /Where are your clients, your bank, and your family\?/u);
});

test("jurisdiction runtime accepts a validated corpus-backed answer and runs the M5 selector", () => {
  const content = "Dubai and the UAE are an excellent environment, and the clearest reason is that there is no personal income tax.";
  const rows = [policyRow("jurisdiction-dubai", ["MB-J0", "MB-J1"], content)];
  const result = guardJurisdictionAnswer({
    message: "Compare Cyprus and Dubai", response: `${content} Where are your clients, your bank, and your family?`, rows, language: "en"
  });
  assert.equal(result.valid, true);
  assert.equal(result.topicSlug, "jurisdiction-dubai");
});

test("jurisdiction runtime recognizes country names and comparison phrasing in Arabic, English and Greek", () => {
  for (const [message, topic] of [
    ["Compare Cyprus and Dubai", "jurisdiction-dubai"],
    ["Σύγκριση Κύπρου με την Εσθονία", "jurisdiction-estonia"],
    ["مقارنة قبرص مع مالطا وبلغاريا", "jurisdiction-malta-bulgaria"],
    ["Σύγκριση Κύπρου με τις ΗΠΑ", "jurisdiction-usa"]
  ]) {
    assert.equal(isComparisonRequest(message), true, message);
    assert.equal(requestedJurisdiction(message, []), topic, message);
  }
});

test("objection runtime uses the M5 matrix and leaves a missing live inclusion unclaimed", async () => {
  const result = await buildObjectionAnswer({ text: "The €999 price feels expensive.", language: "en", store: {} });
  assert.equal(result.objection, "O1");
  assert.match(result.response, /check the current package inclusions/u);
  assert.equal((result.response.match(/\?/gu) || []).length, 1);
});

test("O1/O2 runtime requests the current formation package by its exact code", async () => {
  const now = Date.now();
  let query;
  const store = { lookupDynamicData: async (...args) => {
    query = args;
    return { ok: true, status: "found", data: [{
      code: "formation-package", amount: 999, currency: "EUR", inclusions: ["Incorporation", "Company Secretary"],
      valid_from: new Date(now - 1000).toISOString(), effective_from: new Date(now - 1000).toISOString(),
      valid_until: new Date(now + 86400000).toISOString(), verified_at: new Date(now - 2000).toISOString(),
      updated_at: new Date(now - 500).toISOString(), review_status: "approved", active: true,
      location: "CY", eligibility: null, vat_note: "plus VAT"
    }] };
  } };
  const result = await buildObjectionAnswer({ text: "The price feels expensive", language: "en", store, now: new Date(now) });
  assert.deepEqual(query, ["offers", { code: "formation-package" }]);
  assert.match(result.response, /Company Secretary/u);
});
