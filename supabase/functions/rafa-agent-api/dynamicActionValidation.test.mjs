import test from "node:test";
import assert from "node:assert/strict";
import { validateCustomerLeadFields } from "./dynamicActionValidation.mjs";

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
