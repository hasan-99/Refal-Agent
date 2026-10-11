const test = require("node:test");
const assert = require("node:assert/strict");
const { findRepeatedQuestion, trustedKnownValue } = require("./neverReAsk");

test("known customer fields suppress repeated questions in English, Arabic and Greek", () => {
  const facts = { countryOfResidence: "Jordan", investmentBudget: "EUR 250,000", familyMembers: "4", businessActivity: "software", targetMarkets: "EU", timeline: "Q2" };
  assert.deepEqual(findRepeatedQuestion("Which country do you live in?", facts), ["countryOfResidence"]);
  assert.deepEqual(findRepeatedQuestion("ما ميزانيتك؟ وكم فرداً في عائلتك؟", facts), ["investmentBudget", "familyMembers"]);
  assert.deepEqual(findRepeatedQuestion("Σε ποιες αγορές στοχεύετε; Πότε θέλετε να ξεκινήσετε;", facts), ["targetMarkets", "timeline"]);
  assert.deepEqual(findRepeatedQuestion("What is your company's business activity?", facts), ["businessActivity"]);
});

test("inferred, low-confidence, conflicting, or non-customer provenance does not suppress a needed question", () => {
  assert.equal(trustedKnownValue({ value: "Jordan", provenance: "derived_from_customer_message", confidence: 0.99, inferred: true }), null);
  assert.equal(trustedKnownValue({ value: "Jordan", provenance: "customer_message", confidence: 0.79 }), null);
  assert.equal(trustedKnownValue({ value: "Jordan", provenance: "customer_message", confidence: 1, correctionNeeded: true }), null);
  assert.equal(trustedKnownValue({ value: "Jordan", provenance: "approved_knowledge", confidence: 1 }), null);
  assert.equal(trustedKnownValue({ value: "Jordan" }), null, "structured values without provenance are not trusted");
  assert.equal(trustedKnownValue({ value: "Jordan", provenance: "customer_message" }), null, "structured values without confidence are not trusted");
  assert.deepEqual(findRepeatedQuestion("Which country do you live in?", { countryOfResidence: null }), []);
  assert.deepEqual(findRepeatedQuestion("Which country do you live in?", { countryOfResidence: { value: "Jordan" } }), []);
});

test("legacy string memories remain usable because saveCustomerFact only persists customer_message provenance", () => {
  assert.deepEqual(findRepeatedQuestion("Which country do you live in?", { countryOfResidence: "Jordan" }), ["countryOfResidence"]);
});

test("common Arabic and Greek paraphrases are covered by the never-reask gate", () => {
  const facts = { countryOfResidence: "Jordan", investmentBudget: "EUR 250,000", familyMembers: "4", businessActivity: "software", targetMarkets: "EU", timeline: "Q2" };
  assert.deepEqual(findRepeatedQuestion("من أي بلد أنت؟ قديش ميزانيتك؟", facts), ["countryOfResidence", "investmentBudget"]);
  assert.deepEqual(findRepeatedQuestion("شو طبيعة نشاط الشركة؟ أي دول تستهدف؟", facts), ["businessActivity", "targetMarkets"]);
  assert.deepEqual(findRepeatedQuestion("Από ποια χώρα είστε; Τι προϋπολογισμό έχετε;", facts), ["countryOfResidence", "investmentBudget"]);
  assert.deepEqual(findRepeatedQuestion("Έχετε οικογένεια; Με τι ασχολείται η εταιρεία;", facts), ["familyMembers", "businessActivity"]);
  assert.deepEqual(findRepeatedQuestion("Ποιες χώρες στοχεύετε; Πότε σκοπεύετε να ξεκινήσετε;", facts), ["targetMarkets", "timeline"]);
});

test("natural business-activity paraphrases in English, Arabic, and Greek do not re-ask a saved answer", () => {
  const facts = { businessActivity: "software consultancy" };
  for (const question of [
    "What kind of work do you do?",
    "What does your business do?",
    "What industry are you in?",
    "شو بتعملوا؟",
    "ما طبيعة عملك؟",
    "Σε ποιον κλάδο δραστηριοποιείστε;",
    "Τι δουλειά κάνετε;",
    "Με τι ασχολείστε;"
  ]) {
    assert.deepEqual(findRepeatedQuestion(question, facts), ["businessActivity"], question);
  }
});
