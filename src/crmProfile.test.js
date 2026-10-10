const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeCrmCandidate, mergeCrmCandidate } = require("./crmProfile");

const candidate = (overrides = {}) => ({
  field: "businessActivity", value: "Online retail", rawValue: "online retail",
  provenance: "customer_message", confidence: 0.98, sourceTurnId: "turn-1",
  evidence: "My company will operate an online retail shop.", ...overrides
});

test("CRM candidate stores raw and normalized customer values with provenance and confidence", () => {
  const result = normalizeCrmCandidate(candidate());
  assert.equal(result.ok, true);
  assert.equal(result.record.rawValue, "online retail");
  assert.equal(result.record.normalizedValue, "Online retail");
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
  assert.equal(result.correction.proposedValue, "Online retail");
});

test("sensitive details are redacted from raw value and evidence", () => {
  const result = normalizeCrmCandidate(candidate({ value: "Email hasan@example.com", rawValue: "Email hasan@example.com", evidence: "Call me at +357 99123456" }));
  assert.equal(result.ok, true);
  assert.doesNotMatch(JSON.stringify(result.record), /hasan@example\.com|99123456/);
});
