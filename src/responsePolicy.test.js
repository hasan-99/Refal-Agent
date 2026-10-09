const test = require("node:test");
const assert = require("node:assert/strict");
const {
  validateResponse,
  safeFallbackData,
  sentenceCount,
  questionCount,
  MODEL_DRAFT_THRESHOLDS,
  AGENT_CLARIFY_THRESHOLDS,
  LEGACY_RESPONSE_THRESHOLDS,
  hasVerifiedHandoverClaim,
  hasVerifiedBookingClaim
} = require("./responsePolicy");
const { containsProhibitedClaim } = require("./refalcoAnswer");

test("validates concise two-to-five sentence replies", () => {
  const text = "I understand your goal. We can clarify the available options. What matters most to you?";
  const result = validateResponse(text);
  assert.equal(result.valid, true);
  assert.equal(sentenceCount(text), 3);
  assert.equal(questionCount(text), 1);
});

test("rejects excessive questions, length, internal reasoning, and prohibited claims", () => {
  // REFAL-AGENT-011: DEFAULT_MIN_SENTENCES was lowered from 2 to 0 — no
  // production caller ever relied on the old default (every real caller
  // already passed an explicit minSentences of 1 or 0), so a concise,
  // correct one-sentence answer must be valid under the default too. The
  // minimum-sentence check itself still works when a caller genuinely wants
  // it (see the explicit-override assertion below).
  assert.equal(validateResponse("One sentence only.").reasons.includes("too_few_sentences"), false);
  assert.ok(validateResponse("One sentence only.", { minSentences: 2 }).reasons.includes("too_few_sentences"));
  assert.ok(validateResponse("First? Second? Third?").reasons.includes("too_many_questions"));
  assert.ok(validateResponse("I guarantee approval. We will obtain your permit.").reasons.includes("prohibited_claim"));
  assert.ok(validateResponse("My internal reasoning is that the customer is ready. We can help.").reasons.includes("internal_reasoning"));
  assert.ok(validateResponse("a".repeat(501)).reasons.includes("too_long"));
  assert.ok(validateResponse("The activity is suitable for the standard setup.").reasons.includes("prohibited_claim"));
});

test("a concise, correct one-sentence answer is allowed under every real caller's thresholds (test 1)", () => {
  const text = "No, we don't currently offer that.";
  assert.equal(sentenceCount(text), 1);
  for (const thresholds of [MODEL_DRAFT_THRESHOLDS, LEGACY_RESPONSE_THRESHOLDS, AGENT_CLARIFY_THRESHOLDS, {}]) {
    assert.equal(validateResponse(text, thresholds).valid, true, JSON.stringify(thresholds));
  }
});

test("question-count policy is AT MOST one, not EXACTLY one: zero, one, and two questions (tests 2-4)", () => {
  assert.equal(validateResponse("Understood, I can help with that.", { minSentences: 0 }).reasons.includes("too_many_questions"), false);
  assert.equal(questionCount("Understood, I can help with that."), 0);
  assert.equal(validateResponse("What budget range should we keep in mind?", { minSentences: 0 }).reasons.includes("too_many_questions"), false);
  assert.equal(questionCount("What budget range should we keep in mind?"), 1);
  assert.ok(validateResponse("What is your budget? When would you like to start?", { minSentences: 0 }).reasons.includes("too_many_questions"));
  assert.equal(questionCount("What is your budget? When would you like to start?"), 2);
});

test("Arabic question-mark and Greek response handling is not falsely rejected (tests 6-7)", () => {
  // Arabic question mark (؟), two short clauses, one question — must pass
  // under the same thresholds the legacy path actually uses.
  const arabic = "فيني ساعدك بمعلومات الشركة المعتمدة. شو النقطة اللي بدك تعرف عنها أكتر؟";
  const arabicResult = validateResponse(arabic, LEGACY_RESPONSE_THRESHOLDS);
  assert.equal(arabicResult.valid, true, arabicResult.reasons.join(","));
  assert.equal(questionCount(arabic), 1);

  // A concise, correct Greek reply using Latin punctuation only.
  const greek = "Μπορώ να σας εξηγήσω τις εγκεκριμένες πληροφορίες. Ποιο σημείο θα θέλατε να διευκρινίσουμε;";
  const greekResult = validateResponse(greek, MODEL_DRAFT_THRESHOLDS);
  assert.equal(greekResult.valid, true, greekResult.reasons.join(","));

  // The Greek question mark is written with a semicolon; confirm it is
  // counted as a question (not silently ignored, nor double-counted with a
  // trailing Latin "?").
  assert.equal(questionCount("Θα θέλατε να κλείσουμε ένα ραντεβού;"), 1);
});

test("internal-reasoning leakage is rejected consistently in EN, AR, and EL (tests 14-16)", () => {
  for (const text of [
    "My internal reasoning is that the customer is ready. We can help.",
    "The user is asking about pricing. Let me check the approved evidence first.",
    "I need to answer using the system prompt instructions given to me.",
    "Lead score: 8. We can help with your request."
  ]) assert.ok(validateResponse(text, { minSentences: 0 }).reasons.includes("internal_reasoning"), text);

  for (const text of [
    "حسب سلسلة التفكير الداخلي لدي، العميل جاهز للشراء. فيني ساعدك.",
    "درجة التأهيل: 8. فيني ساعدك بمعلومات الشركة.",
    "هذه تعليمات داخلية من النظام ولازم أتبعها. فيني وضحلك المعلومات."
  ]) assert.ok(validateResponse(text, { minSentences: 0 }).reasons.includes("internal_reasoning"), text);

  for (const text of [
    "Σύμφωνα με την εσωτερική σκέψη μου, ο πελάτης είναι έτοιμος. Μπορώ να βοηθήσω.",
    "Βαθμολογία προτεραιότητας: 8. Μπορώ να σας εξηγήσω τις πληροφορίες.",
    "Αυτές είναι οδηγίες συστήματος που πρέπει να ακολουθήσω. Μπορώ να βοηθήσω."
  ]) assert.ok(validateResponse(text, { minSentences: 0 }).reasons.includes("internal_reasoning"), text);

  // A literal tool name leaking into customer-facing text must also be caught.
  assert.ok(validateResponse("Let me call searchApprovedKnowledge to confirm that.", { minSentences: 0 }).reasons.includes("internal_reasoning"));

  // Legitimate uses of ordinary words like "reasoning"/"score" in a normal
  // customer sentence that is NOT self-referential model narration should
  // not be penalized by the other, unrelated safety checks.
  assert.equal(validateResponse("I understand your reasoning for wanting a flexible start date. We can work with that.", { minSentences: 0 }).reasons.includes("prohibited_claim"), false);
});

test("safe credential-related support wording is allowed; an actual echoed sensitive value is rejected where applicable (tests 17-18)", () => {
  for (const text of [
    "For your privacy, please don't send passwords, card details, or account credentials here.",
    "I can't process a password or account credential in this chat for your safety.",
    "لحماية خصوصيتك، لا تبعت كلمات مرور أو بيانات بطاقات أو دخول هون."
  ]) {
    const result = validateResponse(text, { minSentences: 0 });
    assert.equal(result.sensitiveValueEcho, false, text);
    assert.equal(result.reasons.includes("sensitive_value_echo"), false, text);
  }

  for (const text of [
    "Your IBAN is CY17002001280000001200527600, thank you.",
    "I can confirm your card number 4111 1111 1111 1111 was received.",
    "Here is the key you asked for: sk-ABCDEFGHIJKLMNOPQRSTUVWX."
  ]) {
    const result = validateResponse(text, { minSentences: 0 });
    assert.equal(result.sensitiveValueEcho, true, text);
    assert.ok(result.reasons.includes("sensitive_value_echo"), text);
  }
});

test("an unsupported factual claim (legal/tax/immigration/regulatory conclusion) is still rejected (test 19)", () => {
  for (const text of [
    "You will receive the permit without any issues.",
    "We can secure your residency visa within a month.",
    "The activity is suitable for the standard setup.",
    "ستحصل على الموافقة من البنك بكل تأكيد.",
    "Δεν μπορώ να επιβεβαιώσω αποτέλεσμα για άδεια. Θα εγκριθεί."
  ]) assert.ok(validateResponse(text, { minSentences: 0 }).reasons.includes("prohibited_claim"), text);
});

test("the Agent path and legacy path enforce identical safety behavior for equivalent text, differing only in length/question knobs (test 20)", () => {
  const unverifiedBooking = "Your appointment is confirmed for Tuesday at 10:30.";
  const unverifiedHandover = "I've logged your request for specialist review.";
  const leaked = "The user is asking about pricing. Let me check the approved evidence first.";
  const secret = "Your IBAN is CY17002001280000001200527600, thank you.";

  for (const thresholds of [MODEL_DRAFT_THRESHOLDS, LEGACY_RESPONSE_THRESHOLDS, AGENT_CLARIFY_THRESHOLDS]) {
    assert.ok(validateResponse(unverifiedBooking, thresholds).reasons.includes("unverified_booking_action"), JSON.stringify(thresholds));
    assert.ok(validateResponse(unverifiedHandover, thresholds).reasons.includes("unverified_handover_action"), JSON.stringify(thresholds));
    assert.ok(validateResponse(leaked, thresholds).reasons.includes("internal_reasoning"), JSON.stringify(thresholds));
    assert.ok(validateResponse(secret, thresholds).reasons.includes("sensitive_value_echo"), JSON.stringify(thresholds));
  }

  // The verified-claim override is the same explicit, caller-supplied flag
  // regardless of which path sets it — never inferred from the text itself.
  assert.equal(validateResponse(unverifiedBooking, { ...MODEL_DRAFT_THRESHOLDS, allowVerifiedBookingClaim: true }).unverifiedBookingAction, false);
  assert.equal(validateResponse(unverifiedBooking, { ...LEGACY_RESPONSE_THRESHOLDS, allowVerifiedBookingClaim: true }).unverifiedBookingAction, false);
});

test("hasVerifiedHandoverClaim and hasVerifiedBookingClaim only read deterministic, already-persisted metadata flags", () => {
  assert.equal(hasVerifiedHandoverClaim({}), false);
  assert.equal(hasVerifiedHandoverClaim({ specialistFollowUp: { consented: true, purpose: "specialist_follow_up" }, handover: { routing: {}, summary: {} } }), true);
  assert.equal(hasVerifiedHandoverClaim({ specialistFollowUp: { consented: true, purpose: "specialist_follow_up" } }), false, "consent alone without a persisted handover is not enough");

  assert.equal(hasVerifiedBookingClaim({}), false);
  assert.equal(hasVerifiedBookingClaim({ verifiedBookingConfirmed: false }), false);
  assert.equal(hasVerifiedBookingClaim({ verifiedBookingConfirmed: true }), true);
});

test("allows narrowly worded EN/AR/EL safety disclaimers", () => {
  const allowed = [
    "I can’t provide personalized tax advice or confirm a tax result.",
    "I can’t confirm a permit or licence outcome.",
    "I can't confirm whether the activity needs a licence or permit.",
    "We cannot guarantee bank approval; the bank decides.",
    "Refalco Group does not provide company registration or legal-status information.",
    "لا أستطيع تأكيد نتيجة الرخصة أو التصريح أو التخطيط.",
    "لا أستطيع تقديم نصيحة ضريبية شخصية.",
    "ما فيني أكد إذا النشاط بده ترخيص.",
    "لا أقدم معلومات عن تسجيل الشركات أو الوضع القانوني لها.",
    "Δεν μπορώ να επιβεβαιώσω αποτέλεσμα για άδεια ή πολεοδομική έγκριση.",
    "Δεν μπορώ να παρέχω εξατομικευμένη φορολογική συμβουλή.",
    "Δεν μπορώ να επιβεβαιώσω αν η δραστηριότητα χρειάζεται άδεια.",
    "Δεν μπορώ να εγγυηθώ τραπεζική έγκριση, χρηματοδότηση ή δάνειο."
  ];
  for (const text of allowed) assert.equal(containsProhibitedClaim(text), false, text);
  assert.equal(containsProhibitedClaim("I can’t provide personalized tax advice or confirm a tax result; that depends on your circumstances and needs qualified review."), false);
  assert.equal(containsProhibitedClaim("I can’t provide personalized tax advice. You will receive bank approval."), true);
  assert.equal(containsProhibitedClaim("لا أستطيع تأكيد نتيجة الرخصة. ستحصل على الموافقة."), true);
  assert.equal(containsProhibitedClaim("Δεν μπορώ να επιβεβαιώσω αποτέλεσμα για άδεια. Θα εγκριθεί."), true);
  assert.equal(containsProhibitedClaim("ما فيني أكد إذا النشاط بده ترخيص. النشاط مؤهل."), true);
});

test("response policy preserves affirmative outcome and mixed-clause blocking", () => {
  const disclaimer = validateResponse("We cannot guarantee bank approval; the bank decides. I can explain the service process.");
  assert.equal(disclaimer.valid, true);
  for (const claim of [
    "We guarantee bank approval. I can explain the service process.",
    "You will receive the permit. I can explain the service process.",
    "The activity is suitable for the standard setup. I can explain the service process.",
    "We cannot guarantee bank approval. We will obtain your permit."
  ]) assert.ok(validateResponse(claim).reasons.includes("prohibited_claim"), claim);
});

test("safe fallback data is deterministic and multilingual", () => {
  for (const language of ["en", "ar", "el"]) {
    const result = safeFallbackData({ language, category: "uncertainty" });
    assert.equal(result.safe, true);
    assert.equal(result.deterministic, true);
    assert.ok(result.text.length > 0);
  }
  // REFAL-AGENT-014: ar/el previously had no "uncertainty"/"price"/"trust"
  // keys and silently degraded to the generic "default" text for those
  // categories. Each language now has its own category-specific wording,
  // mirroring the English set, instead of a generic fallback.
  assert.match(safeFallbackData({ language: "ar" }).text, /من المنطقي إنك تدرس التفاصيل/);
  assert.match(safeFallbackData({ language: "el" }).text, /Είναι λογικό να αξιολογήσετε/);
  assert.match(safeFallbackData({ language: "ar", category: "default" }).text, /فيني وضّحلك/);
  assert.match(safeFallbackData({ language: "el", category: "default" }).text, /Μπορώ να σας εξηγήσω/);
  assert.match(safeFallbackData({ language: "ar", category: "price" }).text, /الميزانية/u);
  assert.match(safeFallbackData({ language: "el", category: "price" }).text, /προϋπολογισμού/u);
  assert.match(safeFallbackData({ language: "ar", category: "trust" }).text, /توضح المعلومات/u);
  assert.match(safeFallbackData({ language: "el", category: "trust" }).text, /σαφείς πληροφορίες/u);
  assert.match(safeFallbackData({ language: "en", category: "timing" }).text, /Take the time you need/u);
  assert.doesNotMatch(safeFallbackData({ language: "en", category: "timing" }).text, /when would you ideally|move forward/iu);
  assert.match(safeFallbackData({ language: "ar", category: "timing" }).text, /خذ وقتك/u);
  assert.match(safeFallbackData({ language: "el", category: "not_ready" }).text, /δικό σας ρυθμό/u);
});

test("response policy rejects unconsented promises of later human contact but allows a consent question", () => {
  for (const response of [
    "I can pass this to a specialist and they will follow up with you directly.",
    "We will contact you tomorrow with an update.",
    "Once there is an answer from the specialist, you will be notified.",
    "I have requested a specialist to confirm this for you.",
    "رح يتواصل معك المختص قريباً.",
    "Η ομάδα θα επικοινωνήσει μαζί σας σύντομα.",
    "Μόλις υπάρξει απάντηση από τον ειδικό, θα ενημερωθείτε.",
    "Εντάξει, ζητώ να σας επιβεβαιώσει ειδικός το τελικό ποσό."
  ]) assert.ok(validateResponse(response, { minSentences: 0 }).reasons.includes("unconsented_contact_commitment"), response);

  const offer = validateResponse("Would you like me to ask a specialist to contact you?", { minSentences: 0 });
  assert.equal(offer.unconsentedContactCommitment, false);
  assert.equal(validateResponse("I can arrange for a specialist to follow up with you; would you like that?", { minSentences: 0 }).unconsentedContactCommitment, false);
  assert.equal(validateResponse("I can arrange for a specialist to follow up with you.", { minSentences: 0 }).unconsentedContactCommitment, true);
});

test("a third-person contact promise and an 'I've asked' contraction are caught, not just first-person 'I/we will' claims", () => {
  // REFAL-AGENT-008: found via an agent-loop integration test where the
  // Agent (incorrectly) asserted a handover had already happened after only
  // an authorization check — this phrasing previously slipped past the
  // first-person-only pattern.
  assert.equal(validateResponse("I've asked a specialist to review your case and they will contact you shortly.", { minSentences: 0 }).unconsentedContactCommitment, true);
  assert.equal(validateResponse("A specialist will contact you shortly.", { minSentences: 0 }).unconsentedContactCommitment, true);
  assert.equal(validateResponse("The team will contact you about this.", { minSentences: 0 }).unconsentedContactCommitment, true);
  // A conditional offer phrased in the third person must still be allowed through.
  assert.equal(validateResponse("Would you like a specialist to contact you about this?", { minSentences: 0 }).unconsentedContactCommitment, false);
});

test("completed-booking claims require a verified booking, in all three languages and in third-person/contracted forms", () => {
  // REFAL-AGENT-009: the booking equivalent of the handover gate. Until a
  // booking tool reports a real persisted success (Tickets 010/017 pass
  // allowVerifiedBookingClaim), no phrasing of "it is booked" may reach a
  // customer — including the forms the Ticket 008 fix showed a
  // first-person-only pattern misses.
  for (const response of [
    "I've booked your appointment for Tuesday at 10:30.",
    "I have scheduled your meeting for Tuesday.",
    "I'll book the meeting for Tuesday at 10:30.",
    "Your appointment is booked.",
    "Your appointment has been confirmed for Tuesday.",
    "The meeting is now scheduled.",
    "You're confirmed for Tuesday at 10:30.",
    "You are booked for Tuesday at 10:30.",
    "It's confirmed.",
    "Your slot is reserved for Tuesday.",
    // The deterministic confirmation formatter's own output: it may only be
    // delivered by a caller that proved the booking, never by a model draft.
    "Confirmed. Your meeting is booked for 6 Oct 2026, 10:30. Google Meet: https://meet.google.com/abc-defg-hij",
    "تم تأكيد الموعد: 6 أكتوبر 2026، 10:30 ص.",
    "موعدك مؤكد يوم الثلاثاء.",
    "رح احجزلك الموعد يوم الثلاثاء.",
    "Το ραντεβού σας επιβεβαιώθηκε για την Τρίτη.",
    "Έκλεισα το ραντεβού σας για την Τρίτη."
  ]) {
    assert.ok(validateResponse(response, { minSentences: 0 }).reasons.includes("unverified_booking_action"), response);
    assert.equal(validateResponse(response, { minSentences: 0, allowVerifiedBookingClaim: true }).unverifiedBookingAction, false, response);
  }

  // Offers, questions and the existing deterministic booking copy must still pass.
  for (const response of [
    "Would you like me to book an appointment for you?",
    "I can check whether that time is free for a meeting.",
    "I found that time available: 6 Oct 2026, 10:30 for 30 minutes. Reply yes to confirm or no to choose another time.",
    "Your appointment request has been sent for review.",
    "That time is no longer available. Please choose another time.",
    "Your Refalco Group appointment has been cancelled.",
    "الموعد متاح: 6 أكتوبر 2026 لمدة 30 دقيقة. أجب بنعم للتأكيد أو لا لاختيار وقت آخر.",
    "تم إرسال طلب الموعد للمراجعة.",
    "تم إلغاء موعدك مع الشركة.",
    "Θα θέλατε να κλείσουμε ένα ραντεβού;",
    "Το ραντεβού σας ακυρώθηκε."
  ]) assert.equal(validateResponse(response, { minSentences: 0 }).unverifiedBookingAction, false, response);
});

test("request-recording claims require verified handover state", () => {
  for (const response of [
    "I’ll note your interest for a specialist follow-up.",
    "Thanks — I’ll pass this along for a Refalco Group specialist to follow up with you.",
    "I’ve logged your request for specialist review.",
    "Your specialist-review request is already recorded."
  ]) {
    assert.ok(validateResponse(response, { minSentences: 0 }).reasons.includes("unverified_handover_action"), response);
    assert.equal(validateResponse(response, { minSentences: 0, allowVerifiedHandoverClaim: true }).unverifiedHandoverAction, false, response);
  }
});
