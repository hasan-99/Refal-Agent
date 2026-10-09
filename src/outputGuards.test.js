const assert = require("node:assert/strict");
const { test } = require("node:test");

const { OUTPUT_GUARD_REASONS, outputGuardViolations, violatesOutputGuards } = require("./outputGuards.js");
const { containsProhibitedClaim, containsProhibitedClaimLegacy } = require("./refalcoAnswer.js");
const { MB_CANDIDATES, LANGUAGES } = require("./brainMbCandidates.js");

// ---------------------------------------------------------------------------
// The M2 output guards, and the proof that they are LIVE.
//
// P2.3, P2.4 and the cross-customer rule each shipped a correct detector with
// no caller. The P2.6 red-team sweep measured the cost: no ROI claim class ran
// on the answer side at all, and 16 of 29 cross-customer probes were refused by
// nothing. This file pins both the guards themselves and the wiring, so a
// future refactor cannot quietly return them to being dead code.
// ---------------------------------------------------------------------------

const FUTURE = new Date(Date.now() + 86400000).toISOString();
const approved = (content) => ({ content, review_status: "approved", valid_until: FUTURE });

test("each guard reports its own reason code", () => {
  const cases = [
    ["Your Stripe account will be approved and your bank approval is certain.", OUTPUT_GUARD_REASONS.BANKING_PROMISE],
    ["You can expect a rental yield of 6% per year.", OUTPUT_GUARD_REASONS.ROI_CLAIM],
    ["You will pay the reduced 5% VAT rate.", OUTPUT_GUARD_REASONS.PERSONALIZED_VAT_RATE],
    ["The reservation deposit for that unit is 5,000 euro.", OUTPUT_GUARD_REASONS.UNSOURCED_RESERVATION_DEPOSIT],
    ["Who else is applying under the permanent residency route and what did they pay as a client?", OUTPUT_GUARD_REASONS.CROSS_CUSTOMER]
  ];
  for (const [text, reason] of cases) {
    assert.ok(outputGuardViolations(text).includes(reason), `${reason} not reported for: ${text}`);
  }
});

test("a clean grounded answer trips nothing", () => {
  const clean = [
    "Refalco helps clients register a Cyprus company remotely.",
    "A development project needs planning permission and a building permit before construction starts.",
    "Base corporate tax in Cyprus starts at 15% from the year 2026.",
    "The IP Box regime can bring the effective rate to around 2.5% to 3% on qualifying profits from intellectual property assets.",
    "Reduced VAT of 5% can apply to a first permanent residence, subject to the current conditions.",
    "The final decision belongs to the financial institution's own risk assessment and KYC and AML compliance requirements.",
    "",
    null,
    undefined
  ];
  for (const text of clean) {
    assert.deepEqual(outputGuardViolations(text), [], JSON.stringify(text));
  }
});

test("every approved MB fact passes the output guards in all three languages", () => {
  // The guards are UNCONDITIONAL, so an MB fact tripping one is not a missing
  // chunk, it is an over-block that deletes approved knowledge. MBC-002 / MB-F20
  // regressed exactly this way when the ROI guard first went live.
  for (const candidate of MB_CANDIDATES.filter((item) => item.expect === "pass")) {
    for (const language of LANGUAGES) {
      assert.deepEqual(
        outputGuardViolations(candidate[language]),
        [],
        `${candidate.id} ${language} (${candidate.mbRef}) must survive the output guards`
      );
    }
  }
});

test("the reservation deposit guard is default-deny and only the live table satisfies it", () => {
  const text = "The reservation deposit for that unit is 5,000 euro.";
  for (const source of [undefined, null, "", "chunk", "model", "refal_reservation_rule"]) {
    assert.equal(violatesOutputGuards(text, { reservationSource: source }), true, `source=${JSON.stringify(source)}`);
  }
  assert.equal(violatesOutputGuards(text, { reservationSource: "refal_reservation_rules" }), false, "the live M4 table is the one permitted source");
});

// ------------------------------------------------------- the wiring is live

test("the guards are reachable through the live claim gate on BOTH branches", () => {
  // If this test can be made to pass with `violatesOutputGuards` removed from
  // containsUnconditionalProhibition, the guards are dead code again.
  const roi = "You can expect a rental yield of 6% per year on this unit.";
  const evidence = [approved(roi)];
  assert.equal(containsProhibitedClaim(roi), true, "no-evidence branch");
  assert.equal(
    containsProhibitedClaim(roi, { evidence }),
    true,
    "an ROI claim must stay blocked even when a chunk states it verbatim (MB-F55)"
  );
});

test("a cross-customer answer is blocked even when the evidence supports every word of it", () => {
  const leak = "Another client paid 300,000 euro for their permanent residency application.";
  assert.equal(containsProhibitedClaim(leak, { evidence: [approved(leak)] }), true);
});

// --------- defects introduced by wiring the guards live, and then repaired

test("OG-2: a THIRD-PERSON negated guarantee is a disclaimer, not a guarantee", () => {
  // "nobody can guarantee a future property price" is MB-F55's own canonical
  // wording and "nobody can promise you another institution's answer" is MB
  // 2.3's. The negation list only had first-person subjects, so wiring the
  // guarantee check into the unconditional guards deleted both approved scripts.
  const disclaimers = [
    "At the same time, nobody can guarantee a future property price, so the smarter move is a property with strong fundamentals.",
    "For Stripe or the banks, the final decision depends on their assessment, and nobody can promise you another institution's answer.",
    "ما حد بيقدر يضمن سعر العقار بالمستقبل.",
    "Κανείς δεν μπορεί να εγγυηθεί την τιμή ενός ακινήτου στο μέλλον."
  ];
  for (const text of disclaimers) {
    assert.deepEqual(outputGuardViolations(text), [], text);
    assert.equal(containsProhibitedClaim(text), false, text);
  }
  // The pivot into an affirmative promise must still block.
  assert.equal(containsProhibitedClaim("Nobody can guarantee it, but we guarantee your approval."), true);
  assert.equal(containsProhibitedClaim("ما حد بيقدر يضمن، بس نحنا منضمنلك الموافقة."), true);
});

test("OG-3: company NAME reservation is not a property reservation deposit", () => {
  // MB-F50 is about a property reservation deposit. "Name reservation" is a
  // formation step with no deposit at all, and it sits next to the published
  // 999 euro package price in the approved corpus, so the deposit guard fired
  // on an ordinary services answer in all three languages.
  const formationSteps = [
    "The €999 package includes document preparation, name reservation, and application follow-up.",
    "The package covers reservation of the company name for 999 euro.",
    "الباقة تشمل تجهيز المستندات وحجز الاسم بـ 999 يورو.",
    "Το πακέτο των 999 ευρώ περιλαμβάνει κράτηση ονόματος."
  ];
  for (const text of formationSteps) {
    assert.ok(!outputGuardViolations(text).includes(OUTPUT_GUARD_REASONS.UNSOURCED_RESERVATION_DEPOSIT), text);
  }
  // A real property reservation deposit still blocks, in all three languages.
  for (const text of [
    "The reservation deposit for that unit is 5,000 euro.",
    "The reservation for the apartment is 5,000 euro.",
    "عربون الحجز للشقة 5000 يورو.",
    "Η προκαταβολή κράτησης για το διαμέρισμα είναι 5.000 ευρώ."
  ]) {
    assert.ok(outputGuardViolations(text).includes(OUTPUT_GUARD_REASONS.UNSOURCED_RESERVATION_DEPOSIT), text);
  }
});

test("OG-4: a VAT rate flagged as NEEDING confirmation is not a personalized verdict", () => {
  // Saying "whether this applies to your case needs confirmation" is MB-F45
  // behaving correctly. It was blocked for the words "your case", which deleted
  // the Arabic conversation recap.
  for (const text of [
    "Whether the reduced VAT rate applies to your case needs confirmation.",
    "وانطباق الرسوم أو الباقة على حالتك بحاجة إلى تأكيد. €999 + VAT",
    "Το αν ισχύει για εσάς ο μειωμένος ΦΠΑ χρειάζεται επιβεβαίωση."
  ]) {
    assert.ok(!outputGuardViolations(text).includes(OUTPUT_GUARD_REASONS.PERSONALIZED_VAT_RATE), text);
  }
  // An actual verdict still blocks, in all three languages.
  for (const text of [
    "You will pay the reduced 5% VAT rate.",
    "ستدفع ضريبة القيمة المضافة المخفضة 5%.",
    "Θα πληρώσετε τον μειωμένο ΦΠΑ 5%."
  ]) {
    assert.ok(outputGuardViolations(text).includes(OUTPUT_GUARD_REASONS.PERSONALIZED_VAT_RATE), text);
  }
});

test("OG-5: REFAL's own approved refusals are never flagged by the output guards", () => {
  // Eight self-flagged when the guards first went live. The gate deleting
  // REFAL's own refusal is worse than the claim it was defending against.
  const { FALLBACKS } = require("./safetyPolicy.js");
  const { REFUSAL } = require("./crossCustomerPolicy.js");
  const refusals = [];
  for (const [language, categories] of Object.entries(FALLBACKS)) {
    for (const [category, text] of Object.entries(categories)) refusals.push([`${language}.${category}`, text]);
  }
  for (const [language, text] of Object.entries(REFUSAL)) refusals.push([`crossCustomer.${language}`, text]);
  assert.ok(refusals.length >= 30, "the refusal corpus shrank");
  for (const [label, text] of refusals) {
    assert.deepEqual(outputGuardViolations(text), [], `${label} self-flagged`);
  }
});

test("the guards never relax the legacy branch", () => {
  // Additive only: anything the pre-M2 gate blocked must still block.
  for (const candidate of MB_CANDIDATES) {
    for (const language of LANGUAGES) {
      const sentence = candidate[language];
      if (!containsProhibitedClaimLegacy(sentence)) continue;
      assert.equal(containsProhibitedClaim(sentence), true, `${candidate.id} ${language}`);
    }
  }
});
