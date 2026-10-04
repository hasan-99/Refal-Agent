const test = require("node:test");
const assert = require("node:assert/strict");
const { CATEGORIES, detectObjection, objectionResponse } = require("./objectionWorkflow");

test("covers every owner objection category", () => {
  const examples = {
    price: "The price is too expensive for my budget.", trust: "How do I know you are reliable?", timing: "I want to wait until next month.",
    competitor: "I prefer the other provider.", tax: "I won't proceed because of the tax burden.", bureaucracy: "I don't want to deal with the paperwork.",
    risk: "It is too risky for me to proceed.", uncertainty: "I am not sure whether to proceed.",
    partner_consultation: "I need to discuss this with my partner.", not_ready: "I am not ready to decide yet."
  };
  assert.deepEqual(Object.keys(examples).sort(), [...CATEGORIES].sort());
  for (const [category, message] of Object.entries(examples)) assert.ok(detectObjection(message).categories.includes(category));
  assert.equal(detectObjection("Den exo apofasisei akoma, sigkrinw epiloges").category, "not_ready");
});

test("returns one safe, localized next question for an objection", () => {
  const result = objectionResponse({ text: "The price is too expensive.", language: "en" });
  assert.equal(result.category, "price");
  assert.equal(result.fallback, true);
  assert.equal(result.safe, true);
  assert.equal(result.nextQuestion.match(/[?]/g).length, 1);
});

test("unknown messages remain non-objections", () => {
  assert.deepEqual(detectObjection("Hello, I would like information."), { isObjection: false, category: null, categories: [] });
});

test("a neutral price question is an information request, not a price objection", () => {
  for (const text of ["كم تكلفة تأسيس شركة بقبرص؟", "What does company formation cost?", "Πόσο κοστίζει η ίδρυση εταιρείας;"]) {
    assert.equal(detectObjection(text).isObjection, false, text);
  }
});

test("neutral tax, permit, document, and competitor questions are not objections", () => {
  for (const text of [
    "What general tax questions should I ask?",
    "Which permits might apply to this project?",
    "What documents are needed for the process?",
    "Another Cyprus firm says 48 hours. Are they better?",
    "ما الأسئلة الضريبية العامة اللي لازم اسألها؟",
    "شو الأوراق المطلوبة؟ وهل ممكن تحتاج الأرض تصريح؟",
    "Ποιες γενικές φορολογικές ερωτήσεις να κάνω;",
    "Ποια έγγραφα χρειάζονται και ποιες άδειες μπορεί να ισχύουν;",
    "Μια άλλη εταιρεία λέει 48 ώρες. Τι μπορώ να συγκρίνω;"
  ]) assert.equal(detectObjection(text).isObjection, false, text);
});
