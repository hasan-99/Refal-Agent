const { sentenceCount, questionCount, questionsAreCoupled } = require("./responsePolicy");

// P1.4 — Golden Answer Formula and the One Question Rule (removes BLK-4).
//
// MB-G3 shape: answer first, optionally add one value hook, then ask AT MOST one
// question. Two rules here are easy to get backwards, so they are stated plainly:
//
//   * A question is OPTIONAL, never mandatory (CX 1B). BLK-4 was partly the
//     belief that every reply must end in a question, which produces the
//     interrogation anti-pattern P1.5 then has to clean up.
//   * A value hook is EVIDENCE-OPTIONAL and must never be forced (W1.4.4). A
//     forced hook on a thin answer reads as a sales tic.
//
// Sentence and question counting is delegated to responsePolicy, which already
// handles the trilingual cases correctly: `?`, Arabic `؟`, and the Greek
// question mark `;` — which is the SAME CHARACTER as a Latin semicolon and so
// must only count when preceded by Greek script.

// W1.4.3 — length budgets. The previous model-draft preset allowed 5 sentences
// but only 500 characters, which is self-contradictory for Greek and Arabic,
// where the same content runs longer than English. ORDINARY raises the ceiling
// to 700 so a compliant 5-sentence reply is actually expressible.
const ORDINARY = Object.freeze({ minSentences: 2, maxSentences: 5, maxChars: 700, maxQuestions: 1 });
const EXPANDED = Object.freeze({ minSentences: 2, maxSentences: 20, maxChars: 1800, maxQuestions: 1 });

// A direct answer is the absence of pure deflection, not the presence of a
// keyword. Detecting "directness" positively would reward confident phrasing
// over correct phrasing, so this looks for replies that answer NOTHING.
const PURE_DEFLECTION_LATIN = /^(?:\s*(?:i(?:'m| am)? (?:sorry|afraid)|unfortunately|regrettably)[^.!?]*[.!?]\s*)+$/iu;
const PURE_DEFLECTION_OTHER = /^(?:\s*(?:للأسف|عذرا|عذراً|آسف|ما فيني|لا أستطيع)[^.؟!]*[.؟!]\s*)+$|^(?:\s*(?:δυστυχώς|λυπάμαι|δεν μπορώ)[^.;!]*[.;!]\s*)+$/iu;

// A value hook is a forward-looking benefit or relevance statement. Trilingual,
// and deliberately NOT \b-wrapped on the non-Latin side: \b is ASCII-only in
// JavaScript, so a \b-guarded Arabic or Greek alternative is unreachable.
const VALUE_HOOK_LATIN = /\b(?:this (?:means|lets|allows|gives)|which (?:means|lets|allows|gives)|that (?:means|lets|allows)|so you (?:can|could|get|avoid)|useful (?:if|when|for)|helpful (?:if|when|for)|worth knowing|the advantage|the benefit|in practice)\b/iu;
const VALUE_HOOK_OTHER = /(?:يعني إنه|معناها|هيك بتقدر|هيك فيك|بتستفيد|الميزة|الفايدة|عملياً|بالممارسة)|(?:αυτό σημαίνει|που σημαίνει|έτσι μπορείτε|το πλεονέκτημα|το όφελος|στην πράξη)/iu;

/**
 * Two questions are permitted ONLY when tightly coupled: the second must be a
 * narrow disambiguation of the first, not a second topic. "Which city, and is it
 * residential or commercial?" is one decision. "Which city, and what is your
 * budget?" is an interrogation.
 *
 * Coupling is approximated structurally rather than semantically: the questions
 * must sit in the SAME sentence, and the second must be short. A second question
 * in its own sentence is a separate ask.
 */
// questionsAreCoupled moved to responsePolicy.js (W1.4.2) so the One Question
// Rule enforced there and the shape analysis here cannot drift apart. It is
// re-exported below for existing callers.

/**
 * W1.4.1 — describe the shape of an answer. Pure analysis, no verdict; callers
 * decide what to do with it.
 */
function analyseAnswerShape(answer) {
  const text = String(answer || "").trim();
  const questions = questionCount(text);
  const sentences = sentenceCount(text);
  const deflectionOnly = Boolean(text) && (PURE_DEFLECTION_LATIN.test(text) || PURE_DEFLECTION_OTHER.test(text));

  return {
    hasDirectAnswer: Boolean(text) && !deflectionOnly,
    hasValueHook: VALUE_HOOK_LATIN.test(text) || VALUE_HOOK_OTHER.test(text),
    questionCount: questions,
    sentenceCount: sentences,
    charCount: text.length,
    questionsCoupled: questions === 2 ? questionsAreCoupled(text) : false
  };
}

/**
 * W1.4.2 — the One Question Rule, as a REJECTION not a warning.
 *
 * Returns the reasons an answer violates the golden formula. An empty array
 * means compliant. Note what is deliberately NOT a violation: having no question
 * at all, and having no value hook.
 */
function violatesGoldenFormula(answer, budget = ORDINARY) {
  const shape = analyseAnswerShape(answer);
  const reasons = [];

  if (!shape.hasDirectAnswer) reasons.push("no_direct_answer");

  if (shape.questionCount > 1) {
    // The coupling exception is the ONLY way past one question, and it caps at
    // two. Three questions is an interrogation in any phrasing.
    if (!(shape.questionCount === 2 && shape.questionsCoupled)) reasons.push("too_many_questions");
  }

  if (shape.sentenceCount > budget.maxSentences) reasons.push("too_many_sentences");
  if (shape.charCount > budget.maxChars) reasons.push("too_long");

  return reasons;
}

module.exports = {
  ORDINARY,
  EXPANDED,
  analyseAnswerShape,
  questionsAreCoupled,
  violatesGoldenFormula
};
