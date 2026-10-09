const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  ORDINARY, EXPANDED, analyseAnswerShape, questionsAreCoupled, violatesGoldenFormula
} = require("./goldenFormula");

test("W1.4.3 length budgets replace the contradictory 3/500 preset", () => {
  // The old model-draft preset allowed 5 sentences but only 500 characters,
  // which a compliant 5-sentence Greek or Arabic reply cannot satisfy.
  assert.equal(ORDINARY.minSentences, 2);
  assert.equal(ORDINARY.maxSentences, 5);
  assert.equal(ORDINARY.maxChars, 700);
  assert.equal(EXPANDED.maxSentences, 20);
  assert.equal(EXPANDED.maxChars, 1800);
  assert.ok(EXPANDED.maxChars > ORDINARY.maxChars);
});

test("question counting handles all three scripts, including the Greek question mark", () => {
  // The Greek question mark is the SAME character as a Latin semicolon, so it
  // must only count when preceded by Greek script.
  assert.equal(analyseAnswerShape("Which city are you considering?").questionCount, 1);
  assert.equal(analyseAnswerShape("بأي مدينة بتفكر؟").questionCount, 1);
  assert.equal(analyseAnswerShape("Σε ποια πόλη σκέφτεστε;").questionCount, 1);
  // A Latin semicolon is NOT a question.
  assert.equal(analyseAnswerShape("We offer three services; all are approved.").questionCount, 0);
});

test("a reply with no question at all is compliant — a question is optional, not mandatory", () => {
  // CX 1B. BLK-4 was partly the belief that every reply must end in a question,
  // which manufactures the interrogation anti-pattern P1.5 then has to undo.
  const answer = "Company formation in Cyprus usually takes about two weeks once the documents are complete. The process covers the legal entity registration itself.";
  assert.deepEqual(violatesGoldenFormula(answer), []);
  assert.equal(analyseAnswerShape(answer).questionCount, 0);
});

test("a reply with no value hook is compliant — hooks are never forced", () => {
  // W1.4.4. A forced hook on a thin answer reads as a sales tic.
  const answer = "Yes, we handle that. The registration itself is filed with the Registrar of Companies.";
  assert.equal(analyseAnswerShape(answer).hasValueHook, false);
  assert.deepEqual(violatesGoldenFormula(answer), []);
});

test("the value hook is detected in all three languages when present", () => {
  assert.equal(analyseAnswerShape("It takes two weeks. This means you can plan the bank opening right after.").hasValueHook, true);
  assert.equal(analyseAnswerShape("بياخد أسبوعين. يعني إنه فيك تجهز البنك بعدها مباشرة.").hasValueHook, true);
  assert.equal(analyseAnswerShape("Χρειάζονται δύο εβδομάδες. Αυτό σημαίνει ότι μπορείτε να προγραμματίσετε την τράπεζα.").hasValueHook, true);
});

test("two questions are REJECTED unless tightly coupled", () => {
  // Two separate asks = interrogation.
  const separate = "Which city are you considering? What is your budget?";
  assert.ok(violatesGoldenFormula(separate).includes("too_many_questions"));
  assert.equal(questionsAreCoupled(separate), false);
});

test("a single question mark joining two interrogatives is already ONE question", () => {
  // This never needs the coupling exception: it carries one question mark.
  const oneMark = "Which city are you considering, and is it residential or commercial?";
  assert.equal(analyseAnswerShape(oneMark).questionCount, 1);
  assert.deepEqual(violatesGoldenFormula(oneMark), []);
});

test("two question marks are permitted when the second is a short conjunction-led follow-on", () => {
  const coupled = "Which city are you considering? And is it residential or commercial?";
  assert.equal(questionsAreCoupled(coupled), true);
  assert.ok(!violatesGoldenFormula(coupled).includes("too_many_questions"));
});

test("the coupling exception caps at two — three questions always fails", () => {
  const three = "Which city? And is it residential or commercial? And what is your timeline?";
  assert.ok(violatesGoldenFormula(three).includes("too_many_questions"));
});

test("a second question that is not conjunction-led is a separate ask", () => {
  const separate = "Which city are you considering? What is your budget?";
  assert.equal(questionsAreCoupled(separate), false);
});

test("a long second question is a second topic however it is introduced", () => {
  const longSecond = "Which city? And could you also tell me about your overall investment timeline, budget range and whether partners are involved?";
  assert.equal(questionsAreCoupled(longSecond), false);
  assert.ok(violatesGoldenFormula(longSecond).includes("too_many_questions"));
});

test("coupling is recognised in Arabic and Greek, not just English", () => {
  assert.equal(questionsAreCoupled("بأي مدينة بتفكر؟ وهل هي سكنية أو تجارية؟"), true);
  assert.equal(questionsAreCoupled("Σε ποια πόλη σκέφτεστε; Και είναι οικιστικό ή εμπορικό;"), true);
});

test("a pure deflection is not a direct answer", () => {
  assert.equal(analyseAnswerShape("Unfortunately I cannot help with that.").hasDirectAnswer, false);
  assert.equal(analyseAnswerShape("للأسف ما فيني ساعدك بهالموضوع.").hasDirectAnswer, false);
  assert.equal(analyseAnswerShape("Δυστυχώς δεν μπορώ να βοηθήσω.").hasDirectAnswer, false);
  assert.ok(violatesGoldenFormula("Unfortunately I cannot help with that.").includes("no_direct_answer"));
});

test("a deflection that still answers something IS a direct answer", () => {
  // Declining one part while answering another is the correct behaviour, not a
  // violation. Flagging this would push REFAL toward over-claiming.
  const answer = "I cannot confirm the tax outcome for your situation. What I can confirm is that the standard corporate rate applies to registered entities.";
  assert.equal(analyseAnswerShape(answer).hasDirectAnswer, true);
  assert.deepEqual(violatesGoldenFormula(answer), []);
});

// ---------------------------------------------------------------------------
// W1.4.5 — MB 1.3's four worked examples as regression fixtures: two that the
// master brain marks WRONG and two it marks RIGHT.
// ---------------------------------------------------------------------------

test("MB 1.3 fixture ❌ 1 — interrogation: a wall of questions is rejected", () => {
  const bad = "What is your budget? Which city interests you? What is your timeline? Do you have a company already?";
  const reasons = violatesGoldenFormula(bad);
  assert.ok(reasons.includes("too_many_questions"), "a question wall must be rejected");
});

test("MB 1.3 fixture ❌ 2 — deflection with no answer and no substance is rejected", () => {
  const bad = "Unfortunately I am not able to assist with that request.";
  const reasons = violatesGoldenFormula(bad);
  assert.ok(reasons.includes("no_direct_answer"));
});

test("MB 1.3 fixture ✅ 1 — answer first, one hook, one question", () => {
  const good = "Company formation in Cyprus takes about two weeks once your documents are complete. This means you can line up the bank account straight after. Which city are you considering?";
  assert.deepEqual(violatesGoldenFormula(good), []);
  const shape = analyseAnswerShape(good);
  assert.equal(shape.hasDirectAnswer, true);
  assert.equal(shape.hasValueHook, true);
  assert.equal(shape.questionCount, 1);
});

test("MB 1.3 fixture ✅ 2 — answer with no question and no hook is still correct", () => {
  const good = "Yes, a non-resident can own a Cyprus company outright. There is no local shareholding requirement for that structure.";
  assert.deepEqual(violatesGoldenFormula(good), []);
  const shape = analyseAnswerShape(good);
  assert.equal(shape.questionCount, 0);
  assert.equal(shape.hasValueHook, false);
});

test("the expanded budget admits a long detailed reply the ordinary budget rejects", () => {
  const detailed = `${"Cyprus company formation covers several distinct steps. "
    .repeat(8)}Each step has its own timeline.`;
  assert.ok(violatesGoldenFormula(detailed, ORDINARY).length > 0);
  assert.deepEqual(violatesGoldenFormula(detailed, EXPANDED).filter((r) => r !== "too_many_sentences"), []);
});

test("W1.4.3: the runtime validator budget cannot drift from ORDINARY", () => {
  // Duplicated-constant guard. The ceiling lives in TWO places and cannot be
  // shared by import: goldenFormula.js requires responsePolicy.js, so the
  // reverse import would be a cycle. The numbers were therefore retyped, which
  // is exactly how "5 sentences in the prompt, 500 characters in the
  // validator" produced the BLK-4 mismatch in the first place. Pin them.
  const { MODEL_DRAFT_THRESHOLDS } = require("./responsePolicy");
  assert.equal(MODEL_DRAFT_THRESHOLDS.maxSentences, ORDINARY.maxSentences,
    "the validator's sentence ceiling drifted from the budget the prompt quotes");
  assert.equal(MODEL_DRAFT_THRESHOLDS.maxChars, ORDINARY.maxChars,
    "the validator's character ceiling drifted from the budget the prompt quotes");
  assert.equal(MODEL_DRAFT_THRESHOLDS.maxQuestions, ORDINARY.maxQuestions);
  // The ONE deliberate divergence, pinned so it stays deliberate: the FLOOR is
  // 1, not ORDINARY's 2. A correct one-sentence answer ("No, we do not offer
  // that.") must not be rejected and padded, which would itself be an MB
  // anti-pattern. The 2-sentence guidance reaches the model via the prompt.
  assert.equal(MODEL_DRAFT_THRESHOLDS.minSentences, 1);
  assert.equal(ORDINARY.minSentences, 2);
});

test("an empty answer is not a direct answer and does not crash", () => {
  const shape = analyseAnswerShape("");
  assert.equal(shape.hasDirectAnswer, false);
  assert.equal(shape.questionCount, 0);
  assert.equal(shape.sentenceCount, 0);
  assert.equal(analyseAnswerShape(null).hasDirectAnswer, false);
});
