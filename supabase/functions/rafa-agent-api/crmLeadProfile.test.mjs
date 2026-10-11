import test from "node:test";
import assert from "node:assert/strict";
import {
  crmRowToAgentFacts, isExplicitCrmCorrection, isSelfIdentifiedCrmName,
  mergeCrmProfileRow, validateCrmValueAgainstMessage
} from "./crmLeadProfile.mjs";

test("CRM acceptance requires a supported value stated affirmatively in this turn", () => {
  assert.equal(validateCrmValueAgainstMessage("businessActivity", "accounting", "My business activity is accounting."), true);
  assert.equal(validateCrmValueAgainstMessage("businessActivity", "counting", "My business activity is accounting."), false);
  assert.equal(validateCrmValueAgainstMessage("businessActivity", "accounting", "I do not want accounting."), false);
  assert.equal(validateCrmValueAgainstMessage("businessActivity", "accounting", "لا أريد accounting"), false);
  assert.equal(validateCrmValueAgainstMessage("targetService", "construction", "Actually, construction is not what I want."), false);
  assert.equal(validateCrmValueAgainstMessage("targetService", "construction", "I said construction, but I do not want construction."), false);
  assert.equal(validateCrmValueAgainstMessage("targetService", "construction", "Θέλω construction, δεν το θέλω τελικά."), false);
  assert.equal(validateCrmValueAgainstMessage("unknown", "accounting", "accounting"), false);
});

test("name persistence also requires explicit self identification in Arabic, English, or Greek", () => {
  assert.equal(isSelfIdentifiedCrmName("My name is Maya Haddad", "Maya Haddad"), true);
  assert.equal(isSelfIdentifiedCrmName("اسمي مايا حداد", "مايا حداد"), true);
  assert.equal(isSelfIdentifiedCrmName("Με λένε Μαρία", "Μαρία"), true);
  assert.equal(isSelfIdentifiedCrmName("Please contact Maya Haddad", "Maya Haddad"), false);
});

test("durable CRM merge preserves conflicts until explicit correction and rehydrates safe facts", () => {
  const first = mergeCrmProfileRow(null, {
    field: "businessActivity", value: "accounting", sourceTurnId: "turn-a", capturedAt: "2026-10-11T10:00:00Z"
  });
  assert.equal(first.opportunity_fields.businessActivity, "accounting");
  const conflict = mergeCrmProfileRow(first, {
    field: "businessActivity", value: "construction", sourceTurnId: "turn-b", capturedAt: "2026-10-11T10:01:00Z"
  });
  assert.equal(conflict.opportunity_fields.businessActivity, "accounting");
  assert.equal(conflict.crm_correction_needed.field, "businessActivity");
  const correction = mergeCrmProfileRow(conflict, {
    field: "businessActivity", value: "construction", sourceTurnId: "turn-c", capturedAt: "2026-10-11T10:02:00Z", correction: true
  });
  assert.equal(correction.opportunity_fields.businessActivity, "construction");
  assert.deepEqual(correction.crm_correction_needed, {});
  const projection = crmRowToAgentFacts(correction);
  assert.equal(projection.agentFacts.businessactivity.value, "construction");
  assert.equal(projection.agentFacts.businessactivity.sourceTurnId, "turn-c");
  assert.equal(projection.crmCorrectionNeeded, null);
  assert.equal(isExplicitCrmCorrection("Actually, I meant construction."), true);
});
