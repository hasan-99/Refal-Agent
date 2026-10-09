const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ANTI_PATTERNS, detectAntiPatterns } = require("./antiPatterns");

const ids = (result) => result.map((violation) => violation.id);

// --- AP-1 -----------------------------------------------------------------

test("AP-1: asking for a phone number in a turn that delivered nothing is blocked", () => {
  const result = detectAntiPatterns({
    answer: "Happy to help with that. Can I have your phone number?",
    customerMessage: "How long does company formation take?",
    deliveredApprovedFact: false
  });
  assert.ok(ids(result).includes(ANTI_PATTERNS.PHONE_OBSESSION));
});

test("AP-1: the same request is fine once the turn delivered an approved fact", () => {
  const result = detectAntiPatterns({
    answer: "Formation takes about two weeks once documents are complete. Can I have your phone number so a specialist can follow up?",
    customerMessage: "How long does company formation take?",
    deliveredApprovedFact: true
  });
  assert.ok(!ids(result).includes(ANTI_PATTERNS.PHONE_OBSESSION));
});

test("AP-1: the customer raising contact themselves lifts the guard", () => {
  const result = detectAntiPatterns({
    answer: "Of course. What's your phone number?",
    customerMessage: "Please have someone call me.",
    deliveredApprovedFact: false
  });
  assert.ok(!ids(result).includes(ANTI_PATTERNS.PHONE_OBSESSION));
});

test("AP-1 fires in Arabic and Greek too", () => {
  for (const answer of ["تمام. ممكن رقمك؟", "Βεβαίως. Το τηλέφωνό σας;"]) {
    const result = detectAntiPatterns({ answer, customerMessage: "Tell me about services.", deliveredApprovedFact: false });
    assert.ok(ids(result).includes(ANTI_PATTERNS.PHONE_OBSESSION), answer);
  }
});

// --- AP-2 -----------------------------------------------------------------

test("AP-2: one caveat is fine, a stack of them is disclaimer overload", () => {
  const one = detectAntiPatterns({ answer: "The standard rate applies. Please note this depends on your structure." });
  assert.ok(!ids(one).includes(ANTI_PATTERNS.DISCLAIMER_OVERLOAD));

  const many = detectAntiPatterns({
    answer: "Please note this is not legal advice. That said, it may vary. However, I cannot guarantee the outcome. It needs qualified review."
  });
  assert.ok(ids(many).includes(ANTI_PATTERNS.DISCLAIMER_OVERLOAD));
});

test("AP-2 reports rather than strips — CX 12B", () => {
  // The guard must never rewrite. Removing a meaningful condition to sound
  // confident is a worse defect than a wordy reply, so detectAntiPatterns
  // returns violations and leaves the text alone.
  const answer = "Please note this is not tax advice. However, it may vary by case. Subject to review.";
  const result = detectAntiPatterns({ answer });
  const overload = result.find((violation) => violation.id === ANTI_PATTERNS.DISCLAIMER_OVERLOAD);
  assert.ok(overload);
  assert.ok(overload.count > 1);
  // No sanitized/rewritten field is offered at all.
  assert.equal(overload.sanitized, undefined);
});

// --- AP-3 -----------------------------------------------------------------

test("AP-3: urgency claims without evidence are fear-based selling", () => {
  for (const answer of [
    "Prices will rise tomorrow, so act now before it is too late.",
    "الأسعار رح ترتفع بكرا، بادر قبل ما تخسر الفرصة.",
    "Οι τιμές θα αυξηθούν αύριο. Τελευταία ευκαιρία."
  ]) {
    const result = detectAntiPatterns({ answer, evidenceText: "" });
    assert.ok(ids(result).includes(ANTI_PATTERNS.FEAR_SELLING), answer);
  }
});

test("AP-3: the same claim is permitted when approved evidence says it verbatim", () => {
  const result = detectAntiPatterns({
    answer: "Prices will rise tomorrow under the published schedule.",
    evidenceText: "Published notice: prices will rise tomorrow for all new applications."
  });
  assert.ok(!ids(result).includes(ANTI_PATTERNS.FEAR_SELLING));
});

// --- AP-4 -----------------------------------------------------------------

test("AP-4: promising a third party's behaviour is blocked", () => {
  const result = detectAntiPatterns({ answer: "Stripe will definitely approve your account." });
  assert.ok(ids(result).includes(ANTI_PATTERNS.FAKE_PROMISE));
});

test("AP-4: promising issuance of a permit or residency is blocked, in all languages", () => {
  for (const answer of [
    "You will receive residency within three months.",
    "رح تحصل على إقامة خلال ثلاثة أشهر.",
    "Θα λάβετε άδεια διαμονής σε τρεις μήνες."
  ]) {
    assert.ok(ids(detectAntiPatterns({ answer })).includes(ANTI_PATTERNS.FAKE_PROMISE), answer);
  }
});

test("AP-4: a specific ROI figure is blocked", () => {
  assert.ok(ids(detectAntiPatterns({ answer: "You can expect a 12% annual return." })).includes(ANTI_PATTERNS.FAKE_PROMISE));
  assert.ok(ids(detectAntiPatterns({ answer: "The yield is around 8%." })).includes(ANTI_PATTERNS.FAKE_PROMISE));
});

test("AP-4: an ordinary mention of a payment provider is not a promise", () => {
  const result = detectAntiPatterns({ answer: "Many clients use Stripe or PayPal for online payments." });
  assert.ok(!ids(result).includes(ANTI_PATTERNS.FAKE_PROMISE));
});

// --- AP-5 -----------------------------------------------------------------

test("AP-5: three consecutive question-only turns is interrogation", () => {
  const result = detectAntiPatterns({
    answer: "And what is your timeline?",
    history: [
      { role: "assistant", content: "What is your budget?" },
      { role: "assistant", content: "Which city are you considering?" }
    ]
  });
  assert.ok(ids(result).includes(ANTI_PATTERNS.INTERROGATION));
});

test("AP-5: a question that follows a real answer is not interrogation", () => {
  const result = detectAntiPatterns({
    answer: "Formation takes about two weeks. Which city are you considering?",
    history: [
      { role: "assistant", content: "What is your budget?" },
      { role: "assistant", content: "Which city are you considering?" }
    ]
  });
  assert.ok(!ids(result).includes(ANTI_PATTERNS.INTERROGATION));
});

test("AP-5: two question-only turns is not yet interrogation", () => {
  const result = detectAntiPatterns({
    answer: "And what is your timeline?",
    history: [{ role: "assistant", content: "What is your budget?" }]
  });
  assert.ok(!ids(result).includes(ANTI_PATTERNS.INTERROGATION));
});

// --- AP-6 -----------------------------------------------------------------

test("AP-6: an informational request stays informational", () => {
  const result = detectAntiPatterns({
    answer: "Formation takes about two weeks. Shall I book a meeting for you?",
    customerMessage: "How long does company formation take?",
    leadTier: "informational"
  });
  assert.ok(ids(result).includes(ANTI_PATTERNS.UNREQUESTED_MEETING));
});

test("AP-6: a lead tier ALONE never licenses a meeting offer — CX R-04", () => {
  // The whole point of R-04: being scored "cold" or "informational" must not
  // flip to a booking push just because an internal tier changed.
  const cold = detectAntiPatterns({
    answer: "Would you like a call?",
    customerMessage: "What services do you offer?",
    leadTier: "cold"
  });
  assert.ok(ids(cold).includes(ANTI_PATTERNS.UNREQUESTED_MEETING));
});

test("AP-6: the offer is correct once the customer asks for it", () => {
  const result = detectAntiPatterns({
    answer: "Of course, shall I arrange a meeting?",
    customerMessage: "I would like a meeting with a specialist.",
    leadTier: "informational"
  });
  assert.ok(!ids(result).includes(ANTI_PATTERNS.UNREQUESTED_MEETING));
});

test("AP-6: a hot lead may be offered a booking", () => {
  const result = detectAntiPatterns({
    answer: "Shall I book a call with a specialist?",
    customerMessage: "We are ready to proceed this month.",
    leadTier: "hot"
  });
  assert.ok(!ids(result).includes(ANTI_PATTERNS.UNREQUESTED_MEETING));
});

test("AP-6 fires in Arabic and Greek", () => {
  for (const answer of ["تحب نرتب لك موعد؟", "Θα θέλατε ένα ραντεβού;"]) {
    const result = detectAntiPatterns({ answer, customerMessage: "What do you do?", leadTier: "cold" });
    assert.ok(ids(result).includes(ANTI_PATTERNS.UNREQUESTED_MEETING), answer);
  }
});

// --- general --------------------------------------------------------------

test("a clean, well-formed reply commits no anti-pattern", () => {
  const result = detectAntiPatterns({
    answer: "Company formation in Cyprus takes about two weeks once your documents are complete. Which city are you considering?",
    customerMessage: "How long does company formation take?",
    deliveredApprovedFact: true,
    leadTier: "informational"
  });
  assert.deepEqual(result, []);
});

test("all six anti-patterns are defined and can fire", () => {
  assert.deepEqual(Object.values(ANTI_PATTERNS).sort(), ["AP-1", "AP-2", "AP-3", "AP-4", "AP-5", "AP-6"]);
});

test("empty input never crashes", () => {
  assert.deepEqual(detectAntiPatterns(), []);
  assert.deepEqual(detectAntiPatterns({}), []);
});
