const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeCrmCandidate, mergeCrmCandidate, extractLiteralEvidence, extractLiteralSpan, normalizeCrmValue, isNegatedLiteralMention, isSelfIdentifiedName } = require("./crmProfile");

const candidate = (overrides = {}) => ({
  field: "businessActivity", value: "Online retail", rawValue: "online retail",
  provenance: "customer_message", confidence: 0.98, sourceTurnId: "turn-1",
  evidence: "My company will operate an online retail shop.", ...overrides
});

test("CRM candidate stores raw and normalized customer values with provenance and confidence", () => {
  const result = normalizeCrmCandidate(candidate());
  assert.equal(result.ok, true);
  assert.equal(result.record.rawValue, "online retail");
  assert.equal(result.record.normalizedValue, "online retail");
  assert.equal(result.record.provenance, "customer_message");
  assert.equal(result.record.confidence, 0.98);
  assert.equal(result.record.sourceTurnId, "turn-1");
  assert.equal(result.record.inferred, false);
});

test("inferred facts are marked inferred and cannot be treated as customer-stated", () => {
  const result = normalizeCrmCandidate(candidate({ provenance: "derived_from_customer_message" }));
  assert.equal(result.ok, true);
  assert.equal(result.record.inferred, true);
});

test("CRM extraction rejects unknown fields and incomplete evidence or confidence", () => {
  assert.equal(normalizeCrmCandidate(candidate({ field: "secret" })).reason, "unknown_field");
  assert.equal(normalizeCrmCandidate(candidate({ confidence: 1.2 })).reason, "invalid_confidence");
  assert.equal(normalizeCrmCandidate(candidate({ evidence: "" })).reason, "missing_provenance");
  assert.equal(normalizeCrmCandidate(candidate({ sourceTurnId: "" })).reason, "missing_provenance");
});

test("a CRM name is accepted only after clear self-identification", () => {
  const nameCandidate = candidate({ field: "name", value: "Maya", rawValue: "Maya" });
  assert.equal(normalizeCrmCandidate(nameCandidate).reason, "name_not_self_identified");
  assert.equal(normalizeCrmCandidate({ ...nameCandidate, selfIdentified: true }).ok, true);
});

test("conflicts create a correction need and never silently overwrite prior customer data", () => {
  const existing = { businessActivity: { normalizedValue: "consultancy", provenance: "customer_message" } };
  const result = mergeCrmCandidate(existing, candidate());
  assert.equal(result.ok, true);
  assert.equal(result.correctionNeeded, true);
  assert.equal(result.record.normalizedValue, "consultancy");
  assert.equal(result.correction.proposedValue, "online retail");
});

test("equivalent CRM values do not create a false correction across Unicode, case, or spacing variants", () => {
  const existing = { businessActivity: { normalizedValue: "ＯＮＬＩＮＥ   RETAIL", provenance: "customer_message" } };
  const result = mergeCrmCandidate(existing, candidate());
  assert.equal(result.ok, true);
  assert.equal(result.unchanged, true);
  assert.equal(result.correctionNeeded, false);
  assert.equal(result.record, existing.businessActivity);
});

test("sensitive details are redacted from raw value and evidence", () => {
  const result = normalizeCrmCandidate(candidate({ value: "Email hasan@example.com", rawValue: "Email hasan@example.com", evidence: "Call me at +357 99123456" }));
  assert.equal(result.ok, true);
  assert.doesNotMatch(JSON.stringify(result.record), /hasan@example\.com|99123456/);
});

test("CRM evidence must match a whole literal value in the trusted turn", () => {
  assert.equal(extractLiteralEvidence("I live in Jordan.", "Jordan"), "I live in Jordan.");
  assert.equal(extractLiteralEvidence("I live in Jordan.", "Jor"), "");
  assert.equal(extractLiteralEvidence("ميزانيتي ٢٥٠ ألف يورو", "٢٥٠ ألف يورو"), "ميزانيتي ٢٥٠ ألف يورو");
  assert.equal(extractLiteralEvidence("أقيم في الأُرْدُنّ", "الأردن"), "أقيم في الأُرْدُنّ");
});

test("CRM keeps the exact customer spelling separately from normalized display value", () => {
  const message = "My name is MAYA   HADDAD.";
  const rawValue = extractLiteralSpan(message, "Maya Haddad");
  assert.equal(rawValue, "MAYA   HADDAD");
  assert.equal(normalizeCrmValue(rawValue), "MAYA HADDAD");
  const result = normalizeCrmCandidate(candidate({ field: "name", value: "Maya Haddad", rawValue, selfIdentified: true }));
  assert.equal(result.ok, true);
  assert.equal(result.record.rawValue, rawValue);
  assert.equal(result.record.normalizedValue, "MAYA HADDAD");
});

test("literal span extraction follows evidence normalization for Arabic marks and compatibility forms", () => {
  assert.equal(extractLiteralSpan("أقيم في الأُرْدُنّ", "الأردن"), "الأُرْدُنّ");
  assert.equal(extractLiteralSpan("I live in Ｊｏｒｄａｎ", "Jordan"), "Ｊｏｒｄａｎ");
});

test("negated CRM mentions are not affirmative profile facts", () => {
  assert.equal(isNegatedLiteralMention("I don't live in Jordan", "Jordan"), true);
  assert.equal(isNegatedLiteralMention("لا أعيش في الأردن", "الأردن"), true);
  assert.equal(isNegatedLiteralMention("Δεν κατοικώ στην Κύπρο", "Κύπρο"), true);
  assert.equal(isNegatedLiteralMention("I live in Jordan", "Jordan"), false);
});

test("postposed negation is rejected without treating a contrastive correction as negation", () => {
  assert.equal(isNegatedLiteralMention("Jordan is not where I live", "Jordan"), true);
  assert.equal(isNegatedLiteralMention("The country is Jordan, not Cyprus", "Jordan"), false);
  assert.equal(isNegatedLiteralMention("الأردن ليس بلد إقامتي", "الأردن"), true);
  assert.equal(isNegatedLiteralMention("الأردن مش بلد إقامتي", "الأردن"), true);
  assert.equal(isNegatedLiteralMention("Η Ιορδανία δεν είναι η χώρα διαμονής μου", "Ιορδανία"), true);
  assert.equal(isNegatedLiteralMention("Not only Jordan, but Cyprus too", "Jordan"), false);
  assert.equal(isNegatedLiteralMention("ليس فقط الأردن، بل قبرص أيضًا", "الأردن"), false);
  assert.equal(isNegatedLiteralMention("Jordan is not only where I live", "Jordan"), false);
  assert.equal(isNegatedLiteralMention("Jordan isn't only where I live", "Jordan"), false);
  assert.equal(isNegatedLiteralMention("Jordan is no longer where I live", "Jordan"), true);
  assert.equal(isNegatedLiteralMention("Jordan, no longer my residence", "Jordan"), true);
  assert.equal(isNegatedLiteralMention("Jordan, never my residence", "Jordan"), true);
  assert.equal(isNegatedLiteralMention("الأردن مو إقامة بلدي", "الأردن"), true);
  assert.equal(isNegatedLiteralMention("الأردن مش دولة إقامتي", "الأردن"), true);
  assert.equal(isNegatedLiteralMention("الأردن ليس فقط بلد إقامتي", "الأردن"), false);
});

test("name identification is explicit and trilingual", () => {
  assert.equal(isSelfIdentifiedName("My name is Maya", "Maya"), true);
  assert.equal(isSelfIdentifiedName("My friend Maya owns a company", "Maya"), false);
  assert.equal(isSelfIdentifiedName("اسمي مايا", "مايا"), true);
  assert.equal(isSelfIdentifiedName("Με λένε Μαρία", "Μαρία"), true);
});
