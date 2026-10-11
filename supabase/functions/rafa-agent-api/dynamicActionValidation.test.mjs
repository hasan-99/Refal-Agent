import test from "node:test";
import assert from "node:assert/strict";
import { validateCustomerLeadFields } from "./dynamicActionValidation.mjs";
import { crmRowToAgentFacts, isExplicitCrmCorrection, isSelfIdentifiedCrmName, mergeCrmProfileRow, validateCrmValueAgainstMessage } from "./crmLeadProfile.mjs";

test("lead values must be stated in this source turn", () => {
  assert.equal(validateCustomerLeadFields({ name: "Rami", budgetAmount: 50000, budgetCurrency: "EUR" }, "My name is Rami and my budget is EUR 50,000."), true);
  assert.equal(validateCustomerLeadFields({ name: "Hasan" }, "My name is Rami."), false);
  assert.equal(validateCustomerLeadFields({ budgetAmount: 90000, budgetCurrency: "EUR" }, "My budget is EUR 50,000."), false);
});

test("lead source validation normalizes Arabic digits and rejects unsupported or inferred fields", () => {
  assert.equal(validateCustomerLeadFields({ budgetAmount: 50000, budgetCurrency: "EUR" }, "ميزانيتي ٥٠٬٠٠٠ يورو"), true);
  assert.equal(validateCustomerLeadFields({ budgetAmount: 50000, budgetCurrency: "EUR" }, "My budget is 50,000."), false);
  assert.equal(validateCustomerLeadFields({ budgetAmount: 50000, budgetCurrency: "USD" }, "I use USD for work, my budget is EUR 50,000."), false);
  assert.equal(validateCustomerLeadFields({ budgetAmount: 50000 }, "My budget is EUR 50,000."), false);
  assert.equal(validateCustomerLeadFields({ residencyInterest: true }, "I might ask about residency later."), false);
  assert.equal(validateCustomerLeadFields({ finalRating: 8 }, "I am ready."), false);
  assert.equal(validateCustomerLeadFields({ whatsapp: "+35712345678" }, "My number is +35712345678."), false);
});

test("durable CRM contract verifies source turns, self-identifies names, and preserves conflicts", () => {
  assert.equal(validateCrmValueAgainstMessage("businessActivity", "accounting", "My business activity is accounting."), true);
  assert.equal(validateCrmValueAgainstMessage("businessActivity", "accounting", "I do not want accounting."), false);
  assert.equal(validateCrmValueAgainstMessage("businessActivity", "accounting", "لا أريد accounting"), false);
  assert.equal(validateCrmValueAgainstMessage("unknown", "accounting", "accounting"), false);
  assert.equal(validateCrmValueAgainstMessage("email", "[email]", "My email is maya@example.com"), true);
  assert.equal(validateCrmValueAgainstMessage("phone", "[phone]", "My phone is +35799123456"), true);
  assert.equal(isSelfIdentifiedCrmName("My name is Maya Haddad", "Maya Haddad"), true);
  assert.equal(isSelfIdentifiedCrmName("Please contact Maya Haddad", "Maya Haddad"), false);

  const first = mergeCrmProfileRow(null, { field: "businessActivity", value: "accounting", sourceTurnId: "turn-a", capturedAt: "2026-10-11T10:00:00Z" });
  const conflict = mergeCrmProfileRow(first, { field: "businessActivity", value: "construction", sourceTurnId: "turn-b", capturedAt: "2026-10-11T10:01:00Z" });
  assert.equal(conflict.opportunity_fields.businessActivity, "accounting");
  assert.equal(conflict.crm_correction_needed.field, "businessActivity");
  const corrected = mergeCrmProfileRow(conflict, { field: "businessActivity", value: "construction", sourceTurnId: "turn-c", capturedAt: "2026-10-11T10:02:00Z", correction: isExplicitCrmCorrection("Actually, I meant construction.") });
  const facts = crmRowToAgentFacts(corrected);
  assert.equal(facts.agentFacts.businessactivity.value, "construction");
  assert.equal(facts.agentFacts.businessactivity.sourceTurnId, "turn-c");
  assert.equal(facts.crmCorrectionNeeded, null);
});
