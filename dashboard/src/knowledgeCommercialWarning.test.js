import test from "node:test";
import assert from "node:assert/strict";
import { detectCommercialKnowledgeWarning } from "./knowledgeCommercialWarning.js";

test("currency amounts suggest an appropriate commercial table without blocking identity or other facts", () => {
  assert.equal(detectCommercialKnowledgeWarning("Refalco Group was founded in 2000 and operates from Cyprus."), null);
  assert.deepEqual(detectCommercialKnowledgeWarning("The current formation package is €999 plus VAT.").target, { id: "offers", label: "Offers" });
  assert.deepEqual(detectCommercialKnowledgeWarning("The annual secretary renewal fee is EUR 450.").target, { id: "renewals", label: "Renewal fees" });
  assert.deepEqual(detectCommercialKnowledgeWarning("The government registration fee is 120 EUR.").target, { id: "governmentFees", label: "Government fees" });
});

test("deposit and property references route to their typed tables", () => {
  assert.deepEqual(detectCommercialKnowledgeWarning("Reservation deposit: $5000, refundable.").target, { id: "reservations", label: "Reservation rules" });
  assert.deepEqual(detectCommercialKnowledgeWarning("Property reference: CY-APT-101, price €200,000.").target, { id: "properties", label: "Property inventory" });
  assert.equal(detectCommercialKnowledgeWarning("A 2 bedroom apartment has sea views."), null);
});

test("detects localized currency amounts and property references", () => {
  assert.equal(detectCommercialKnowledgeWarning("السعر ٩٩٩ يورو").currencyAmount, true);
  assert.equal(detectCommercialKnowledgeWarning("Τέλος εγγραφής 250 ευρώ").currencyAmount, true);
  assert.equal(detectCommercialKnowledgeWarning("مرجع العقار: CY-APT-101").propertyReference, true);
});
