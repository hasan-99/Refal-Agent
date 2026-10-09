const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  CLAIM_CLASSES,
  splitClaims,
  classifyClaim,
  evaluateAnswerClaims,
  approvedEvidenceText,
  isApprovedEvidence
} = require("./claimPolicy");
const { MB_CANDIDATES, LANGUAGES, LANGUAGE_NAMES } = require("./brainMbCandidates");

// G2 for P2.1. The gate is the MB corpus itself, driven as a table in all three
// languages, because the two failure modes are opposite and both are silent:
//
//   expect "pass" + BLOCK with evidence  -> the gate is deleting an approved fact
//   expect "pass" + ALLOW without evidence -> the gate is inventing a fact
//   expect "block" + ALLOW with evidence  -> evidence rescued a guarantee
//
// The last one is the dangerous one. A guarantee or a personalized conclusion is
// never made safe by a chunk that happens to contain the same words.

const approved = (content) => ({
  content,
  review_status: "approved",
  valid_until: null,
  source_name: "synthetic-approved",
  document_id: "doc-p21",
  chunk_id: "chunk-p21"
});

const expired = (content) => ({ content, review_status: "approved", valid_until: "2020-01-01T00:00:00Z" });
const pending = (content) => ({ content, review_status: "pending", valid_until: null });
const future = (content) => ({ content, review_status: "approved", valid_until: "2099-01-01T00:00:00Z" });

// ---------------------------------------------------------------- MB table (120)

for (const candidate of MB_CANDIDATES) {
  for (const code of LANGUAGES) {
    const sentence = candidate[code];
    const language = LANGUAGE_NAMES[code];

    if (candidate.expect === "pass") {
      test(`${candidate.id} ${code}: approved evidence carrying the fact allows it`, () => {
        const verdict = classifyClaim(sentence, { evidence: [approved(sentence)] });
        assert.equal(verdict.allowed, true, `${verdict.claimClass}: ${verdict.reasons.join(", ")}`);
        assert.equal(verdict.claimClass, CLAIM_CLASSES.PROGRAM_FACT);
        assert.deepEqual(verdict.unsupportedNumbers, []);
        assert.equal(verdict.language, language);
      });

      test(`${candidate.id} ${code}: the same fact with no evidence is blocked`, () => {
        const verdict = classifyClaim(sentence, { evidence: [] });
        assert.equal(verdict.allowed, false, `${verdict.claimClass}: ${verdict.reasons.join(", ")}`);
        assert.equal(verdict.claimClass, CLAIM_CLASSES.PROGRAM_FACT);
        assert.deepEqual(verdict.reasons, ["no_approved_evidence"]);
      });
    } else {
      test(`${candidate.id} ${code}: stays blocked even WITH matching evidence`, () => {
        const verdict = classifyClaim(sentence, { evidence: [approved(sentence)] });
        assert.equal(verdict.allowed, false, `${verdict.claimClass}: ${verdict.reasons.join(", ")}`);
        assert.ok(
          verdict.claimClass === CLAIM_CLASSES.GUARANTEE || verdict.claimClass === CLAIM_CLASSES.PERSONALIZED_CONCLUSION,
          `expected a guarantee or a personalized conclusion, got ${verdict.claimClass}`
        );
        assert.ok(verdict.reasons.length > 0);
      });
    }
  }
}

// ------------------------------------------------------------------ public API

test("CLAIM_CLASSES is frozen and carries exactly the four classes", () => {
  assert.equal(Object.isFrozen(CLAIM_CLASSES), true);
  assert.deepEqual(Object.keys(CLAIM_CLASSES).sort(), ["GUARANTEE", "NEUTRAL", "PERSONALIZED_CONCLUSION", "PROGRAM_FACT"]);
});

test("classifyClaim returns the full documented shape", () => {
  const verdict = classifyClaim("Corporate tax in Cyprus starts at 15%.", { evidence: [] });
  assert.deepEqual(Object.keys(verdict).sort(), ["allowed", "claimClass", "language", "reasons", "unsupportedNumbers"]);
  assert.equal(typeof verdict.allowed, "boolean");
  assert.ok(Array.isArray(verdict.reasons));
  assert.ok(Array.isArray(verdict.unsupportedNumbers));
});

test("evaluateAnswerClaims returns the full documented shape", () => {
  const result = evaluateAnswerClaims("We guarantee approval.", { evidence: [] });
  assert.deepEqual(Object.keys(result).sort(), ["allowed", "blocked", "claims"]);
  assert.deepEqual(Object.keys(result.blocked[0]).sort(), ["claimClass", "reasons", "sentence"]);
  assert.deepEqual(Object.keys(result.claims[0]).sort(), ["allowed", "claimClass", "reasons", "sentence"]);
});

// ------------------------------------------------------------------ splitClaims

test("splitClaims splits on an English full stop", () => {
  assert.deepEqual(splitClaims("One fact. Another fact."), ["One fact.", "Another fact."]);
});

test("splitClaims splits on an exclamation mark", () => {
  assert.deepEqual(splitClaims("Welcome! Here is the detail."), ["Welcome!", "Here is the detail."]);
});

test("splitClaims splits on a Latin question mark", () => {
  assert.deepEqual(splitClaims("What is the fee? It depends."), ["What is the fee?", "It depends."]);
});

test("splitClaims splits on the Arabic question mark", () => {
  assert.deepEqual(splitClaims("كم التكلفة؟ بدي معلومات."), ["كم التكلفة؟", "بدي معلومات."]);
});

test("splitClaims splits on the Greek question mark (semicolon)", () => {
  assert.deepEqual(splitClaims("Πόσο κοστίζει; Θέλω πληροφορίες."), ["Πόσο κοστίζει;", "Θέλω πληροφορίες."]);
});

test("splitClaims splits on the Arabic semicolon", () => {
  assert.deepEqual(splitClaims("الرسوم ثابتة؛ الضريبة منفصلة."), ["الرسوم ثابتة؛", "الضريبة منفصلة."]);
});

test("splitClaims does NOT split on a decimal point inside 2.5%", () => {
  assert.deepEqual(splitClaims("The effective rate can be 2.5% on qualifying profits."), ["The effective rate can be 2.5% on qualifying profits."]);
});

test("splitClaims does NOT split on a thousands separator inside 300.000", () => {
  assert.deepEqual(splitClaims("Η επένδυση είναι 300.000 ευρώ συν ΦΠΑ."), ["Η επένδυση είναι 300.000 ευρώ συν ΦΠΑ."]);
});

test("splitClaims keeps a decimal and a thousands separator in one sentence", () => {
  assert.deepEqual(
    splitClaims("The rate is 2.5% and the investment is 300.000 euro."),
    ["The rate is 2.5% and the investment is 300.000 euro."]
  );
});

test("splitClaims treats a run of terminators as one boundary", () => {
  assert.deepEqual(splitClaims("Really?! Yes."), ["Really?!", "Yes."]);
});

test("splitClaims keeps a sentence that ends on a decimal digit", () => {
  assert.deepEqual(splitClaims("The reduced rate is 2.5. The standard rate differs."), ["The reduced rate is 2.5.", "The standard rate differs."]);
});

test("splitClaims collapses whitespace and drops empty fragments", () => {
  assert.deepEqual(splitClaims("  One.   \n\n Two.  "), ["One.", "Two."]);
});

test("splitClaims returns an empty array for empty, null and undefined input", () => {
  assert.deepEqual(splitClaims(""), []);
  assert.deepEqual(splitClaims("   "), []);
  assert.deepEqual(splitClaims(null), []);
  assert.deepEqual(splitClaims(undefined), []);
});

test("splitClaims handles a trailing sentence with no terminator", () => {
  assert.deepEqual(splitClaims("First. Second without a stop"), ["First.", "Second without a stop"]);
});

test("splitClaims mixes all three scripts in one answer", () => {
  assert.deepEqual(
    splitClaims("The fee is fixed. كم التكلفة؟ Πόσο κοστίζει;"),
    ["The fee is fixed.", "كم التكلفة؟", "Πόσο κοστίζει;"]
  );
});

// ------------------------------------------------------------- isApprovedEvidence

test("isApprovedEvidence accepts an approved chunk with no valid_until", () => {
  assert.equal(isApprovedEvidence({ content: "x", review_status: "approved" }), true);
});

test("isApprovedEvidence accepts an approved chunk with a null valid_until", () => {
  assert.equal(isApprovedEvidence(approved("x")), true);
});

test("isApprovedEvidence accepts an approved chunk with an empty valid_until", () => {
  assert.equal(isApprovedEvidence({ content: "x", review_status: "approved", valid_until: "   " }), true);
});

test("isApprovedEvidence accepts an approved chunk whose valid_until is in the future", () => {
  assert.equal(isApprovedEvidence(future("x")), true);
});

test("isApprovedEvidence rejects an expired chunk", () => {
  assert.equal(isApprovedEvidence(expired("x")), false);
});

test("isApprovedEvidence rejects a pending chunk", () => {
  assert.equal(isApprovedEvidence(pending("x")), false);
});

test("isApprovedEvidence rejects a rejected chunk", () => {
  assert.equal(isApprovedEvidence({ content: "x", review_status: "rejected" }), false);
});

test("isApprovedEvidence rejects a chunk with no review_status at all", () => {
  assert.equal(isApprovedEvidence({ content: "x" }), false);
});

test("isApprovedEvidence fails closed on an unparseable valid_until", () => {
  assert.equal(isApprovedEvidence({ content: "x", review_status: "approved", valid_until: "not-a-date" }), false);
});

test("isApprovedEvidence rejects null, undefined and non-objects", () => {
  assert.equal(isApprovedEvidence(null), false);
  assert.equal(isApprovedEvidence(undefined), false);
  assert.equal(isApprovedEvidence("approved"), false);
  assert.equal(isApprovedEvidence(42), false);
});

// ---------------------------------------------------------- approvedEvidenceText

test("approvedEvidenceText concatenates only approved, unexpired chunks", () => {
  const text = approvedEvidenceText([
    approved("Corporate tax starts at 15%."),
    pending("Secret pending number 99%."),
    expired("Expired number 77%."),
    future("Reduced VAT of 5% can apply.")
  ]);
  assert.match(text, /15%/);
  assert.match(text, /5% can apply/);
  assert.doesNotMatch(text, /99%/);
  assert.doesNotMatch(text, /77%/);
});

test("approvedEvidenceText returns an empty string when nothing is approved", () => {
  assert.equal(approvedEvidenceText([pending("a"), expired("b")]), "");
});

test("approvedEvidenceText is safe for empty, null and non-array input", () => {
  assert.equal(approvedEvidenceText([]), "");
  assert.equal(approvedEvidenceText(null), "");
  assert.equal(approvedEvidenceText(undefined), "");
  assert.equal(approvedEvidenceText("approved text"), "");
});

test("approvedEvidenceText folds Arabic letters so both spellings normalize alike", () => {
  const pointed = approvedEvidenceText([approved("الإقامة الدائمة")]);
  const bare = approvedEvidenceText([approved("الاقامة الدائمة")]);
  assert.equal(pointed, bare);
});

// --------------------------------------------- expired / pending behave as none

test("expired evidence behaves exactly like no evidence", () => {
  const sentence = "The minimum qualifying investment for permanent residency is 300,000 euro.";
  const withExpired = classifyClaim(sentence, { evidence: [expired(sentence)] });
  const withNone = classifyClaim(sentence, { evidence: [] });
  assert.deepEqual(withExpired, withNone);
  assert.equal(withExpired.allowed, false);
  assert.deepEqual(withExpired.reasons, ["no_approved_evidence"]);
});

test("pending evidence behaves exactly like no evidence", () => {
  const sentence = "The minimum qualifying investment for permanent residency is 300,000 euro.";
  const withPending = classifyClaim(sentence, { evidence: [pending(sentence)] });
  const withNone = classifyClaim(sentence, { evidence: [] });
  assert.deepEqual(withPending, withNone);
  assert.equal(withPending.allowed, false);
});

test("an unexpired approved chunk alongside an expired one still grounds the fact", () => {
  const sentence = "The minimum qualifying investment for permanent residency is 300,000 euro.";
  const verdict = classifyClaim(sentence, { evidence: [expired("unrelated 999 euro"), future(sentence)] });
  assert.equal(verdict.allowed, true, verdict.reasons.join(", "));
});

// -------------------------------------------------------- numbers must be grounded

test("a number present in the sentence but absent from evidence blocks and is named", () => {
  const verdict = classifyClaim("The minimum qualifying investment for permanent residency is 300,000 euro.", {
    evidence: [approved("The minimum qualifying investment for permanent residency is 250,000 euro.")]
  });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.claimClass, CLAIM_CLASSES.PROGRAM_FACT);
  assert.ok(verdict.reasons.includes("number_not_in_evidence:300000"), verdict.reasons.join(", "));
  assert.deepEqual(verdict.unsupportedNumbers, ["300000"]);
});

test("every unsupported number is reported, not just the first", () => {
  const verdict = classifyClaim("Corporate tax is 15% and the investment is 300,000 euro.", {
    evidence: [approved("Corporate tax is 12% and the investment is 250,000 euro.")]
  });
  assert.equal(verdict.allowed, false);
  assert.deepEqual(verdict.unsupportedNumbers, ["15", "300000"]);
  assert.ok(verdict.reasons.includes("number_not_in_evidence:15"));
  assert.ok(verdict.reasons.includes("number_not_in_evidence:300000"));
});

test("300,000 and 300.000 are the same number", () => {
  const verdict = classifyClaim("The qualifying investment for residency is 300,000 euro.", {
    evidence: [approved("The qualifying investment for residency is 300.000 euro plus VAT.")]
  });
  assert.equal(verdict.allowed, true, verdict.reasons.join(", "));
});

test("300 000 with a space separator is the same number as 300000", () => {
  const verdict = classifyClaim("The qualifying investment for residency is 300 000 euro.", {
    evidence: [approved("The qualifying investment for residency is 300000 euro plus VAT.")]
  });
  assert.equal(verdict.allowed, true, verdict.reasons.join(", "));
});

test("300000 plain is the same number as 300,000 grouped", () => {
  const verdict = classifyClaim("The qualifying investment for residency is 300000 euro.", {
    evidence: [approved("The qualifying investment for residency is 300,000 euro plus VAT.")]
  });
  assert.equal(verdict.allowed, true, verdict.reasons.join(", "));
});

test("2.5% and 2,5% are the same percentage", () => {
  const verdict = classifyClaim("The IP Box effective tax rate can be 2.5% on qualifying profits.", {
    evidence: [approved("The IP Box effective tax rate can be 2,5% on qualifying profits.")]
  });
  assert.equal(verdict.allowed, true, verdict.reasons.join(", "));
});

test("2,5% in the answer against 2.5% in the evidence is also the same percentage", () => {
  const verdict = classifyClaim("The IP Box effective tax rate can be 2,5% on qualifying profits.", {
    evidence: [approved("The IP Box effective tax rate can be 2.5% on qualifying profits.")]
  });
  assert.equal(verdict.allowed, true, verdict.reasons.join(", "));
});

test("2.50% and 2.5% are the same percentage", () => {
  const verdict = classifyClaim("The IP Box effective tax rate can be 2.50% on qualifying profits.", {
    evidence: [approved("The IP Box effective tax rate can be 2.5% on qualifying profits.")]
  });
  assert.equal(verdict.allowed, true, verdict.reasons.join(", "));
});

test("Arabic-Indic digits normalize to ASCII before the comparison", () => {
  const verdict = classifyClaim("رسوم الإقامة ٣٠٠٬٠٠٠ يورو حسب الشروط.", {
    evidence: [approved("رسوم الإقامة 300,000 يورو حسب الشروط.")]
  });
  assert.equal(verdict.allowed, true, verdict.reasons.join(", "));
});

test("an Arabic-Indic number absent from evidence still blocks", () => {
  const verdict = classifyClaim("رسوم الإقامة ٤٠٠٬٠٠٠ يورو حسب الشروط.", {
    evidence: [approved("رسوم الإقامة 300,000 يورو حسب الشروط.")]
  });
  assert.equal(verdict.allowed, false);
  assert.ok(verdict.reasons.includes("number_not_in_evidence:400000"), verdict.reasons.join(", "));
});

test("a year is not special-cased away: it must appear in the evidence too", () => {
  const grounded = classifyClaim("Base corporate tax in Cyprus starts at 15% from the year 2026.", {
    evidence: [approved("Base corporate tax in Cyprus starts at 15% from the year 2026.")]
  });
  assert.equal(grounded.allowed, true, grounded.reasons.join(", "));

  const ungrounded = classifyClaim("Base corporate tax in Cyprus starts at 15% from the year 2026.", {
    evidence: [approved("Base corporate tax in Cyprus starts at 15% from the year 2024.")]
  });
  assert.equal(ungrounded.allowed, false);
  assert.ok(ungrounded.reasons.includes("number_not_in_evidence:2026"), ungrounded.reasons.join(", "));
});

test("a percentage is compared, not merely detected", () => {
  const verdict = classifyClaim("Reduced VAT of 5% can apply to a first permanent residence.", {
    evidence: [approved("Reduced VAT of 19% applies to property in Cyprus.")]
  });
  assert.equal(verdict.allowed, false);
  assert.ok(verdict.reasons.includes("number_not_in_evidence:5"), verdict.reasons.join(", "));
});

test("a grounded programme fact carries the program_fact_grounded reason", () => {
  const sentence = "Non Dom status gives 0% on dividends and interest for 17 years.";
  const verdict = classifyClaim(sentence, { evidence: [approved(sentence)] });
  assert.deepEqual(verdict.reasons, ["program_fact_grounded"]);
  assert.deepEqual(verdict.unsupportedNumbers, []);
});

test("with no approved evidence, every number is listed as unsupported", () => {
  const verdict = classifyClaim("Corporate tax is 15% and the investment is 300,000 euro.", { evidence: [] });
  assert.deepEqual(verdict.reasons, ["no_approved_evidence"]);
  assert.deepEqual(verdict.unsupportedNumbers, ["15", "300000"]);
});

test("a programme fact whose entities do not overlap the evidence is blocked", () => {
  const verdict = classifyClaim("A trading company needs a VAT number and EORI registration for customs.", {
    evidence: [approved("GESY is the national health system and private insurance can be added on top.")]
  });
  assert.equal(verdict.allowed, false);
  assert.ok(verdict.reasons.includes("entities_not_in_evidence"), verdict.reasons.join(", "));
});

// -------------------------------------------------------- GUARANTEE, trilingual

const GUARANTEE_SENTENCES = [
  ["english", "We guarantee your Stripe account will be approved."],
  ["english", "Bank approval is guaranteed for this file."],
  ["english", "Approval is certain once we file the application."],
  ["english", "Success is assured with our package."],
  ["english", "I promise you the permit will be issued."],
  ["english", "We offer 100% approval on every application."],
  ["arabic", "نحن نضمن موافقة البنك على الملف."],
  ["arabic", "أنا بضمنلك إنه الحساب رح ينوافق عليه."],
  ["arabic", "العائد مضمون على هذا الاستثمار."],
  ["arabic", "الموافقة على الطلب مؤكدة تماماً."],
  ["greek", "Εγγυόμαστε την έγκριση του λογαριασμού σας."],
  ["greek", "Εγγυώμαι ότι θα εγκριθεί ο φάκελος."],
  ["greek", "Η απόδοση είναι εγγυημένη κάθε χρόνο."],
  ["greek", "Η έγκριση τράπεζας είναι βέβαιη."],
  ["greek", "Υπάρχει σίγουρη έγκριση για αυτή την περίπτωση."]
];

for (const [language, sentence] of GUARANTEE_SENTENCES) {
  test(`guarantee (${language}) is blocked with evidence: ${sentence.slice(0, 40)}`, () => {
    const verdict = classifyClaim(sentence, { evidence: [approved(sentence)] });
    assert.equal(verdict.claimClass, CLAIM_CLASSES.GUARANTEE, verdict.reasons.join(", "));
    assert.equal(verdict.allowed, false);
    assert.deepEqual(verdict.reasons, ["guarantee_marker"]);
  });
}

test("a guarantee is blocked without evidence too", () => {
  const verdict = classifyClaim("We guarantee bank approval.", { evidence: [] });
  assert.equal(verdict.claimClass, CLAIM_CLASSES.GUARANTEE);
  assert.equal(verdict.allowed, false);
});

test("100% approval is caught even though \\b can never match after a percent sign", () => {
  const verdict = classifyClaim("This route has 100% approval for every applicant.", { evidence: [] });
  assert.equal(verdict.claimClass, CLAIM_CLASSES.GUARANTEE, verdict.reasons.join(", "));
});

test("a bare refusal to guarantee is not itself a guarantee", () => {
  for (const sentence of [
    "I can't guarantee bank approval.",
    "ما فيني أضمن موافقة البنك.",
    "Δεν μπορώ να εγγυηθώ τραπεζική έγκριση."
  ]) {
    const verdict = classifyClaim(sentence, { evidence: [] });
    assert.notEqual(verdict.claimClass, CLAIM_CLASSES.GUARANTEE, sentence);
    assert.equal(verdict.allowed, true, sentence);
  }
});

test("a refusal to guarantee does NOT rescue a guarantee in the same clause", () => {
  const verdict = classifyClaim("I cannot guarantee approval, but we guarantee the price will not change.", { evidence: [] });
  assert.equal(verdict.claimClass, CLAIM_CLASSES.GUARANTEE, verdict.reasons.join(", "));
  assert.equal(verdict.allowed, false);
});

// --------------------------------------- PERSONALIZED_CONCLUSION, trilingual

const PERSONALIZED_SENTENCES = [
  ["english", "Your company qualifies for the IP Box regime."],
  ["english", "You will get the residency under Category A."],
  ["english", "Your activity is eligible for the programme."],
  ["english", "Your business activity is suitable and will proceed."],
  ["english", "You qualify for IP Box based on what you described."],
  ["english", "You are eligible for permanent residency."],
  ["english", "Here is my personal tax advice for your situation."],
  ["arabic", "شركتك مؤهلة لنظام IP Box."],
  ["arabic", "نشاطك التجاري مناسب للتسجيل."],
  ["arabic", "رح تحصل على الإقامة الدائمة بدون مشاكل."],
  ["arabic", "ستحصل على الموافقة خلال شهر."],
  ["arabic", "هاي استشارة ضريبية شخصية لحالتك."],
  ["greek", "Η εταιρεία σας δικαιούται το καθεστώς IP Box."],
  ["greek", "Θα πάρετε την άδεια διαμονής."],
  ["greek", "Η δραστηριότητά σας είναι επιλέξιμη για το πρόγραμμα."],
  ["greek", "Ορίστε η προσωπική μου φορολογική συμβουλή."]
];

for (const [language, sentence] of PERSONALIZED_SENTENCES) {
  test(`personalized conclusion (${language}) is blocked with evidence: ${sentence.slice(0, 40)}`, () => {
    const verdict = classifyClaim(sentence, { evidence: [approved(sentence)] });
    assert.equal(verdict.claimClass, CLAIM_CLASSES.PERSONALIZED_CONCLUSION, verdict.reasons.join(", "));
    assert.equal(verdict.allowed, false);
    assert.deepEqual(verdict.reasons, ["personalized_marker"]);
  });
}

// --------------------------------- a generic programme condition is NOT personalized

const GENERIC_CONDITIONS = [
  "Applicants need proven annual income from outside Cyprus of 50,000 euro per year.",
  "The main applicant must show an annual income of 50,000 euro.",
  "A trading company needs a VAT number and EORI registration for customs.",
  "مقدم الطلب الرئيسي بيحتاج دخل سنوي مثبت من خارج قبرص قيمته 50,000 يورو.",
  "الشركة التجارية بتحتاج رقم ضريبة القيمة المضافة وتسجيل EORI.",
  "Ο κύριος αιτών χρειάζεται ετήσιο εισόδημα εκτός Κύπρου 50.000 ευρώ.",
  "Μια εμπορική εταιρεία χρειάζεται αριθμό ΦΠΑ και εγγραφή EORI."
];

for (const sentence of GENERIC_CONDITIONS) {
  test(`a generic programme condition stays PROGRAM_FACT: ${sentence.slice(0, 40)}`, () => {
    const verdict = classifyClaim(sentence, { evidence: [approved(sentence)] });
    assert.equal(verdict.claimClass, CLAIM_CLASSES.PROGRAM_FACT, verdict.reasons.join(", "));
    assert.equal(verdict.allowed, true, verdict.reasons.join(", "));
  });
}

test("a generic condition with no evidence is blocked, not reclassified", () => {
  const verdict = classifyClaim("Applicants need proven annual income of 50,000 euro per year.", { evidence: [] });
  assert.equal(verdict.claimClass, CLAIM_CLASSES.PROGRAM_FACT);
  assert.equal(verdict.allowed, false);
});

// ---------------------------------------------------------------- precedence

test("a guarantee outranks a personalized conclusion in the same sentence", () => {
  const verdict = classifyClaim("Your company qualifies and we guarantee the approval.", { evidence: [] });
  assert.equal(verdict.claimClass, CLAIM_CLASSES.GUARANTEE);
});

test("a personalized conclusion outranks a programme fact in the same sentence", () => {
  const sentence = "Your company qualifies for the 300,000 euro residency route.";
  const verdict = classifyClaim(sentence, { evidence: [approved(sentence)] });
  assert.equal(verdict.claimClass, CLAIM_CLASSES.PERSONALIZED_CONCLUSION);
  assert.equal(verdict.allowed, false);
});

test("a programme fact outranks NEUTRAL whenever a number is present", () => {
  const verdict = classifyClaim("We have 3 offices.", { evidence: [] });
  assert.equal(verdict.claimClass, CLAIM_CLASSES.PROGRAM_FACT);
  assert.equal(verdict.allowed, false);
});

// ------------------------------------------------------------------- NEUTRAL

test("small talk with no entity and no number is NEUTRAL and allowed", () => {
  for (const sentence of ["Thanks for your message.", "شكراً كتير إلك.", "Ευχαριστώ πολύ."]) {
    const verdict = classifyClaim(sentence, { evidence: [] });
    assert.equal(verdict.claimClass, CLAIM_CLASSES.NEUTRAL, `${sentence} -> ${verdict.reasons.join(", ")}`);
    assert.equal(verdict.allowed, true);
  }
});

test("a NEUTRAL clause does not need evidence", () => {
  const verdict = classifyClaim("Happy to help with that.", { evidence: [] });
  assert.equal(verdict.allowed, true);
  assert.deepEqual(verdict.reasons, ["neutral"]);
});

// ------------------------------------------------------- Arabic folding, BLK-16

test("bare-alef الاقامة and pointed الإقامة classify identically", () => {
  const evidence = [approved("الحد الأدنى للاستثمار المؤهل للإقامة الدائمة هو 300,000 يورو.")];
  const pointed = classifyClaim("الحد الأدنى للاستثمار المؤهل للإقامة الدائمة هو 300,000 يورو.", { evidence });
  const bare = classifyClaim("الحد الادنى للاستثمار المؤهل للاقامة الدائمة هو 300,000 يورو.", { evidence });
  assert.equal(pointed.claimClass, bare.claimClass);
  assert.equal(pointed.allowed, bare.allowed);
  assert.equal(bare.allowed, true, bare.reasons.join(", "));
});

test("bare-alef evidence grounds a pointed-alef answer", () => {
  const verdict = classifyClaim("الحد الأدنى للاستثمار المؤهل للإقامة الدائمة هو 300,000 يورو.", {
    evidence: [approved("الحد الادنى للاستثمار المؤهل للاقامة الدائمة هو 300,000 يورو.")]
  });
  assert.equal(verdict.allowed, true, verdict.reasons.join(", "));
});

test("مؤهله and مؤهلة are the same personalized marker", () => {
  const pointed = classifyClaim("شركتك مؤهلة للإقامة الدائمة.", { evidence: [] });
  const bare = classifyClaim("شركتك مؤهله للاقامة الدائمة.", { evidence: [] });
  assert.equal(pointed.claimClass, CLAIM_CLASSES.PERSONALIZED_CONCLUSION);
  assert.equal(bare.claimClass, CLAIM_CLASSES.PERSONALIZED_CONCLUSION);
  assert.deepEqual(pointed.reasons, bare.reasons);
});

test("bare-alef اضمن is caught exactly like أضمن", () => {
  const pointed = classifyClaim("أنا أضمن لك الموافقة.", { evidence: [] });
  const bare = classifyClaim("انا اضمن لك الموافقة.", { evidence: [] });
  assert.equal(pointed.claimClass, CLAIM_CLASSES.GUARANTEE);
  assert.equal(bare.claimClass, CLAIM_CLASSES.GUARANTEE);
});

test("Arabic diacritics and tatweel do not hide a guarantee", () => {
  const verdict = classifyClaim("العائد مَضْمُون على هذا الاستثمار.", { evidence: [] });
  assert.equal(verdict.claimClass, CLAIM_CLASSES.GUARANTEE, verdict.reasons.join(", "));
});

test("an Arabic marker adjacent to other letters still matches without \\b", () => {
  const verdict = classifyClaim("بضمنلك الموافقة بسرعة.", { evidence: [] });
  assert.equal(verdict.claimClass, CLAIM_CLASSES.GUARANTEE, verdict.reasons.join(", "));
});

test("a Greek marker adjacent to other letters still matches without \\b", () => {
  const verdict = classifyClaim("Η απόδοση είναι εγγυημένη.", { evidence: [] });
  assert.equal(verdict.claimClass, CLAIM_CLASSES.GUARANTEE, verdict.reasons.join(", "));
});

// --------------------------------------------------------- language resolution

test("language is detected when not supplied", () => {
  assert.equal(classifyClaim("Corporate tax starts at 15%.", { evidence: [] }).language, "english");
  assert.equal(classifyClaim("ضريبة الشركات تبدأ من 15%.", { evidence: [] }).language, "arabic");
  assert.equal(classifyClaim("Ο εταιρικός φόρος ξεκινά από 15%.", { evidence: [] }).language, "greek");
});

test("an explicitly supplied language is echoed back", () => {
  assert.equal(classifyClaim("Corporate tax starts at 15%.", { evidence: [], language: "greek" }).language, "greek");
  assert.equal(classifyClaim("Corporate tax starts at 15%.", { evidence: [], language: "arabic" }).language, "arabic");
});

test("short language codes are resolved to full names", () => {
  assert.equal(classifyClaim("Corporate tax starts at 15%.", { evidence: [], language: "el" }).language, "greek");
  assert.equal(classifyClaim("Corporate tax starts at 15%.", { evidence: [], language: "ar" }).language, "arabic");
  assert.equal(classifyClaim("ضريبة الشركات تبدأ من 15%.", { evidence: [], language: "en" }).language, "english");
});

test("an unknown language value falls back to detection, never to undefined", () => {
  assert.equal(classifyClaim("ضريبة الشركات تبدأ من 15%.", { evidence: [], language: "klingon" }).language, "arabic");
});

// --------------------------------------------------------- evaluateAnswerClaims

test("evaluateAnswerClaims blocks the whole answer when any clause is blocked", () => {
  const sentence = "Reduced VAT of 5% can apply to a first permanent residence.";
  const result = evaluateAnswerClaims(`${sentence} We guarantee your approval.`, { evidence: [approved(sentence)] });
  assert.equal(result.allowed, false);
  assert.equal(result.claims.length, 2);
  assert.equal(result.blocked.length, 1);
  assert.equal(result.blocked[0].claimClass, CLAIM_CLASSES.GUARANTEE);
  assert.equal(result.claims[0].allowed, true);
});

test("evaluateAnswerClaims allows an answer where every clause is grounded or neutral", () => {
  const fact = "Reduced VAT of 5% can apply to a first permanent residence.";
  const result = evaluateAnswerClaims(`${fact} Happy to help further.`, { evidence: [approved(fact)] });
  assert.equal(result.allowed, true, JSON.stringify(result.blocked));
  assert.deepEqual(result.blocked, []);
  assert.equal(result.claims.length, 2);
});

test("evaluateAnswerClaims reports every blocked clause, not only the first", () => {
  const result = evaluateAnswerClaims("We guarantee approval. Your company qualifies. The fee is 999 euro.", { evidence: [] });
  assert.equal(result.allowed, false);
  assert.equal(result.blocked.length, 3);
  assert.deepEqual(result.blocked.map((claim) => claim.claimClass), [
    CLAIM_CLASSES.GUARANTEE,
    CLAIM_CLASSES.PERSONALIZED_CONCLUSION,
    CLAIM_CLASSES.PROGRAM_FACT
  ]);
});

test("evaluateAnswerClaims keeps the original sentence text in each claim", () => {
  const result = evaluateAnswerClaims("We guarantee approval.", { evidence: [] });
  assert.equal(result.claims[0].sentence, "We guarantee approval.");
  assert.equal(result.blocked[0].sentence, "We guarantee approval.");
});

test("evaluateAnswerClaims propagates the resolved language to every clause", () => {
  const result = evaluateAnswerClaims("Corporate tax is 15%. Happy to help.", { evidence: [], language: "greek" });
  assert.equal(result.claims.length, 2);
  for (const claim of result.claims) assert.ok(claim.claimClass);
});

test("evaluateAnswerClaims does not split a thousands separator into a second clause", () => {
  const fact = "The qualifying investment is 300.000 euro.";
  const result = evaluateAnswerClaims(fact, { evidence: [approved(fact)] });
  assert.equal(result.claims.length, 1);
  assert.equal(result.allowed, true, JSON.stringify(result.blocked));
});

test("evaluateAnswerClaims handles a trilingual answer in one pass", () => {
  const result = evaluateAnswerClaims("We guarantee approval. نضمن الموافقة. Εγγυόμαστε την έγκριση.", { evidence: [] });
  assert.equal(result.allowed, false);
  assert.equal(result.blocked.length, 3);
  for (const claim of result.blocked) assert.equal(claim.claimClass, CLAIM_CLASSES.GUARANTEE);
});

// --------------------------------------------------------------- safe defaults

test("classifyClaim is safe for an empty string", () => {
  const verdict = classifyClaim("", { evidence: [] });
  assert.equal(verdict.claimClass, CLAIM_CLASSES.NEUTRAL);
  assert.equal(verdict.allowed, true);
  assert.deepEqual(verdict.reasons, []);
  assert.deepEqual(verdict.unsupportedNumbers, []);
});

test("classifyClaim is safe for null and undefined", () => {
  for (const value of [null, undefined]) {
    const verdict = classifyClaim(value, { evidence: [] });
    assert.equal(verdict.claimClass, CLAIM_CLASSES.NEUTRAL, String(value));
    assert.equal(verdict.allowed, true, String(value));
  }
});

test("classifyClaim is safe for whitespace and punctuation only", () => {
  for (const value of ["   ", "...", "؟؟", "---"]) {
    const verdict = classifyClaim(value, { evidence: [] });
    assert.equal(verdict.claimClass, CLAIM_CLASSES.NEUTRAL, value);
    assert.equal(verdict.allowed, true, value);
  }
});

test("classifyClaim is safe when the options object is omitted entirely", () => {
  assert.doesNotThrow(() => classifyClaim("Hello there"));
  assert.equal(classifyClaim("Hello there").allowed, true);
  assert.equal(classifyClaim("The fee is 999 euro.").allowed, false);
});

test("classifyClaim is safe when evidence is null or not an array", () => {
  for (const evidence of [null, undefined, "approved", 7, {}]) {
    const verdict = classifyClaim("The fee is 999 euro.", { evidence });
    assert.equal(verdict.allowed, false, String(evidence));
    assert.deepEqual(verdict.reasons, ["no_approved_evidence"], String(evidence));
  }
});

test("classifyClaim ignores malformed evidence entries without throwing", () => {
  const sentence = "Reduced VAT of 5% can apply to a first permanent residence.";
  assert.doesNotThrow(() => classifyClaim(sentence, { evidence: [null, undefined, 3, "x", approved(sentence)] }));
  assert.equal(classifyClaim(sentence, { evidence: [null, undefined, 3, "x", approved(sentence)] }).allowed, true);
});

test("evaluateAnswerClaims is safe for empty, null and undefined input", () => {
  for (const value of ["", null, undefined, "   "]) {
    const result = evaluateAnswerClaims(value, { evidence: [] });
    assert.equal(result.allowed, true, String(value));
    assert.deepEqual(result.blocked, [], String(value));
    assert.deepEqual(result.claims, [], String(value));
  }
});

test("evaluateAnswerClaims is safe when the options object is omitted entirely", () => {
  assert.doesNotThrow(() => evaluateAnswerClaims("Hello there"));
  assert.equal(evaluateAnswerClaims("Hello there").allowed, true);
  assert.equal(evaluateAnswerClaims("We guarantee approval.").allowed, false);
});

test("a non-string sentence does not throw", () => {
  assert.doesNotThrow(() => classifyClaim(12345, { evidence: [] }));
  assert.doesNotThrow(() => classifyClaim({ toString: () => "We guarantee approval." }, { evidence: [] }));
});
