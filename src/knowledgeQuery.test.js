const assert = require("node:assert/strict");
const { test } = require("node:test");
const { turnNeedsKnowledge, SOCIAL_ONLY_INTENTS } = require("./knowledgeQuery");
const { INTENTS, detectIntents } = require("./intent");

// The smalltalk retrieval gate.
//
// A greeting has no knowledge need, and retrieving anyway is harmful rather
// than merely wasteful: the hybrid path has no "return nothing" behaviour
// (CF-09), so a contentless social message still drags back the N closest
// chunks and the model is handed them as though they answered the question.
// That is CF-04's failure mode arriving through a different door.
//
// Every case below drives the REAL classifier rather than a hand-written
// intent array. This repo has repeatedly been bitten by tests that pass on a
// state the live caller cannot produce (AP-1 was dead for exactly that reason,
// and so was the W1.7.7 booking assertion). If detectIntents stops labelling
// "كيفك" as small talk, these must fail.

const SOCIAL = [
  ["ar", "كيفك"],
  ["ar", "كيف حالك"],
  ["ar", "مرحبا"],
  ["ar", "اهلا"],
  ["ar", "شكرا"],
  ["en", "hi"],
  ["en", "hello"],
  ["en", "how are you"],
  ["en", "thanks"],
  ["el", "γεια σας"],
  ["el", "καλημέρα"],
  ["el", "τι κάνεις"],
  ["el", "ευχαριστώ"],
];

const SUBSTANTIVE = [
  ["ar", "شو بتقدمو خدمات"],
  ["ar", "كم تكلفة تأسيس شركة"],
  ["ar", "بدي اسجل شركة بقبرص"],
  ["en", "What services do you offer?"],
  ["en", "How much does company formation cost?"],
  ["en", "What is the corporate tax rate in Cyprus?"],
  ["el", "Τι υπηρεσίες προσφέρετε;"],
  ["el", "Πόσο κοστίζει η σύσταση εταιρείας;"],
];

test("a purely social turn needs no retrieval, in all three languages", () => {
  for (const [lang, message] of SOCIAL) {
    const intents = detectIntents(message);
    assert.ok(intents.length > 0, `${lang} "${message}" produced no intent at all`);
    assert.equal(
      turnNeedsKnowledge(intents),
      false,
      `${lang} "${message}" -> [${intents}] must NOT trigger retrieval`
    );
  }
});

test("a real question still retrieves, so the gate cannot become a knowledge blackout", () => {
  for (const [lang, message] of SUBSTANTIVE) {
    const intents = detectIntents(message);
    assert.equal(
      turnNeedsKnowledge(intents),
      true,
      `${lang} "${message}" -> [${intents}] MUST still retrieve`
    );
  }
});

test("a greeting carrying a real question retrieves: the question wins, not the hello", () => {
  // "مرحبا، شو خدماتكم" is a greeting AND a services request. Suppressing
  // retrieval here would answer the hello and silently drop the question.
  const mixed = [INTENTS.GREETING, INTENTS.SERVICES];
  assert.equal(turnNeedsKnowledge(mixed), true);
  assert.equal(turnNeedsKnowledge([INTENTS.SMALL_TALK, INTENTS.PRICING]), true);
});

test("UNKNOWN is deliberately NOT social, so a classifier miss never blacks out knowledge", () => {
  // An unclassified message is usually a real question we failed to label.
  // Treating it as social would convert a classifier miss into a retrieval
  // blackout, which is strictly worse than retrieving something unhelpful.
  assert.equal(turnNeedsKnowledge([INTENTS.UNKNOWN]), true);
  assert.equal(turnNeedsKnowledge([INTENTS.UNKNOWN, INTENTS.SMALL_TALK]), true);
  assert.ok(!SOCIAL_ONLY_INTENTS.has(INTENTS.UNKNOWN), "UNKNOWN must never be in the social set");
});

test("the gate fails SAFE: no intents, junk input, or a missing argument all still retrieve", () => {
  assert.equal(turnNeedsKnowledge([]), true);
  assert.equal(turnNeedsKnowledge(), true);
  assert.equal(turnNeedsKnowledge(null), true);
  assert.equal(turnNeedsKnowledge("not an array"), true);
  assert.equal(turnNeedsKnowledge([null, undefined]), true);
});

test("the social set is exactly greeting and small talk, and nothing creeps in", () => {
  // A widening of this set is a widening of when REFAL goes knowledge-blind.
  // It should be a deliberate edit that breaks this test, never a drive-by.
  assert.deepEqual(
    [...SOCIAL_ONLY_INTENTS].sort(),
    [INTENTS.GREETING, INTENTS.SMALL_TALK].sort()
  );
});
