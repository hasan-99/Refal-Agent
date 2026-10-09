const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  LIVE_RESERVATION_SOURCE,
  RESERVATION_DEPOSIT_REPLY,
  violatesReservationDepositRule,
  reservationDepositGuard,
  containsRoiClaim,
  roiCanonicalReply,
  ROI_REPLY,
  classifyVatStatement
} = require("./reservationPolicy");
// Sibling module, so `./refalcoAnswer`. The brief wrote `../src/refalcoAnswer`,
// which does not resolve from inside src/.
const { containsProhibitedClaim } = require("./refalcoAnswer");
const { questionCount } = require("./responsePolicy");
const { violatesGoldenFormula } = require("./goldenFormula");

const DASH_CONNECTOR = /\s[-–—]\s|—/u;

// ---------------------------------------------------------------------------
// W2.4.1 — Reservation deposit (MB-F50, ABSOLUTE).
// The rule is: amount + deposit mention => only `refal_reservation_rules` may
// carry it. Every other provenance, including none at all, is a violation.
// ---------------------------------------------------------------------------

const DEPOSIT_SENTENCES = {
  english: (amount) => `The reservation deposit for this unit is ${amount}.`,
  arabic: (amount) => `عربون الحجز لهاد العقار ${amount}.`,
  greek: (amount) => `Η προκαταβολή κράτησης για αυτό το ακίνητο είναι ${amount}.`
};

const DEPOSIT_AMOUNTS = {
  english: ["€5,000", "€5.000", "EUR 5000", "5000 EUR", "5,000 euros", "$5,000", "£5,000", "€٥٬٠٠٠", "٥٠٠٠ EUR"],
  arabic: ["€5,000", "٥٠٠٠ يورو", "٥٬٠٠٠ يورو", "5.000 يورو", "EUR 5000", "$3,000", "£2,500", "€٥٠٠٠", "3000 دولار"],
  greek: ["€5.000", "5.000 ευρώ", "EUR 5000", "5000 EUR", "$5,000", "£2,500", "€٥٬٠٠٠", "5,000 ευρώ", "2.500 ευρώ"]
};

// Every provenance that is NOT the live table. `null` and an omitted option
// object are included because the guard must DEFAULT DENY: the table arrives in
// M4 (BLK-12), so until a caller can supply it, nothing may quote a figure.
const DENIED_SOURCES = ["chunk", "model", null, undefined, "", "knowledge_base", "refal_reservation_rules_draft"];

for (const language of Object.keys(DEPOSIT_AMOUNTS)) {
  for (const amount of DEPOSIT_AMOUNTS[language]) {
    const text = DEPOSIT_SENTENCES[language](amount);
    test(`deposit amount "${amount}" in ${language} is blocked for every source except the live table`, () => {
      for (const source of DENIED_SOURCES) {
        assert.equal(violatesReservationDepositRule(text, { source }), true, `source=${String(source)} must be denied: ${text}`);
      }
      assert.equal(violatesReservationDepositRule(text), true, `an omitted option object must default-deny: ${text}`);
      assert.equal(violatesReservationDepositRule(text, { source: LIVE_RESERVATION_SOURCE }), false, `the live table must be allowed: ${text}`);
    });
  }
}

test("the only allowed provenance string is the live table name", () => {
  assert.equal(LIVE_RESERVATION_SOURCE, "refal_reservation_rules");
});

const DEPOSIT_WITHOUT_AMOUNT = [
  "The reservation deposit is agreed per project and per property.",
  "A holding fee applies once you choose a unit.",
  "عربون الحجز بيختلف حسب المشروع والعقار.",
  "وديعة الحجز بتتحدد مع فريق المبيعات.",
  "Η προκαταβολή κράτησης καθορίζεται ανά έργο.",
  "Η κράτηση γίνεται αφού επιλέξετε ακίνητο."
];
for (const text of DEPOSIT_WITHOUT_AMOUNT) {
  test(`a deposit mention with no amount is not a violation: ${text}`, () => {
    for (const source of DENIED_SOURCES) assert.equal(violatesReservationDepositRule(text, { source }), false, `source=${String(source)}`);
    assert.equal(reservationDepositGuard(text, { source: "model" }), null);
  });
}

const AMOUNT_WITHOUT_DEPOSIT = [
  "The company formation package is €999 plus VAT.",
  "Annual accounting starts from EUR 1,200.",
  "باقة تأسيس الشركة ٩٩٩ يورو زائد الضريبة.",
  "رسوم المحاسبة السنوية 1,200 يورو.",
  "Το πακέτο ίδρυσης εταιρείας είναι €999 συν ΦΠΑ.",
  "Η ετήσια λογιστική υποστήριξη ξεκινά από 1.200 ευρώ."
];
for (const text of AMOUNT_WITHOUT_DEPOSIT) {
  test(`an amount with no deposit mention is another guard's job: ${text}`, () => {
    for (const source of DENIED_SOURCES) assert.equal(violatesReservationDepositRule(text, { source }), false, `source=${String(source)}`);
  });
}

// BLK-15 regression class: an unanchored substring made `vat` fire inside
// `private`, `renovation` and `activate`. The same mistake with `deposit` and
// `reservation` would refuse ordinary sentences, so it is pinned here.
const ORDINARY_WORDS = [
  "Is this a private company with €5,000 of share capital?",
  "We handle renovation work worth €5,000.",
  "How do I activate my account with a €5,000 balance?",
  "He deposited his documents at the office on 12 May.",
  "We are an innovative firm and the fee is €5,000.",
  "The preservation of the records costs €5,000."
];
for (const text of ORDINARY_WORDS) {
  test(`ordinary vocabulary does not become a deposit violation: ${text}`, () => {
    assert.equal(violatesReservationDepositRule(text, { source: "model" }), false, text);
  });
}

// BLK-16 regression class: the bare-alef and ta-marbuta spellings must reach
// the SAME verdict, or one spelling silently bypasses the guard.
const ARABIC_SPELLING_PAIRS = [
  ["وديعه الحجز 5000 يورو.", "وديعة الحجز 5000 يورو."],
  ["عربون الحجز للشقه الاولى ٥٠٠٠ يورو.", "عربون الحجز للشقة الأولى ٥٠٠٠ يورو."],
  ["دفعه الحجز ٣٠٠٠ دولار.", "دفعة الحجز ٣٠٠٠ دولار."]
];
for (const [bare, pointed] of ARABIC_SPELLING_PAIRS) {
  test(`BLK-16: bare and hamza/ta-marbuta spellings agree: ${bare}`, () => {
    assert.equal(violatesReservationDepositRule(bare, { source: "chunk" }), violatesReservationDepositRule(pointed, { source: "chunk" }), `variant mismatch: ${bare}`);
    assert.equal(violatesReservationDepositRule(bare, { source: "chunk" }), true, `bare spelling bypassed the gate: ${bare}`);
    assert.equal(violatesReservationDepositRule(bare, { source: LIVE_RESERVATION_SOURCE }), false, bare);
  });
}

test("the guard returns null when the figure comes from the live table", () => {
  assert.equal(reservationDepositGuard("The reservation deposit is €5,000.", { source: LIVE_RESERVATION_SOURCE }), null);
});

test("the guard reports a violation with a stable reason code", () => {
  const result = reservationDepositGuard("The reservation deposit is €5,000.", { source: "chunk" });
  assert.equal(result.violation, true);
  assert.equal(result.reason, "reservation_deposit_amount_not_from_refal_reservation_rules");
});

for (const [language, marker] of [["english", /reservation deposit terms/i], ["arabic", /عربون الحجز/], ["greek", /προκαταβολής κράτησης/]]) {
  test(`the ${language} safe reply refuses the figure and offers the live lookup`, () => {
    const result = reservationDepositGuard(DEPOSIT_SENTENCES[language]("€5,000"), { source: "model" });
    assert.equal(result.violation, true);
    assert.match(result.safeReply, marker);
    assert.equal(result.safeReply, RESERVATION_DEPOSIT_REPLY[language]);
  });
}

test("an explicit language option overrides detection", () => {
  const result = reservationDepositGuard("The reservation deposit is €5,000.", { source: "model", language: "greek" });
  assert.equal(result.safeReply, RESERVATION_DEPOSIT_REPLY.greek);
});

test("an unknown language option falls back to detection rather than throwing", () => {
  const result = reservationDepositGuard("عربون الحجز ٥٠٠٠ يورو.", { source: "model", language: "klingon" });
  assert.equal(result.safeReply, RESERVATION_DEPOSIT_REPLY.arabic);
});

for (const language of Object.keys(RESERVATION_DEPOSIT_REPLY)) {
  test(`the ${language} deposit reply asks at most one question and uses no dash connector`, () => {
    const reply = RESERVATION_DEPOSIT_REPLY[language];
    assert.ok(reply.length > 0);
    assert.ok(questionCount(reply) <= 1, `one question rule broken: ${questionCount(reply)}`);
    assert.doesNotMatch(reply, DASH_CONNECTOR);
    assert.deepEqual(violatesGoldenFormula(reply), []);
    assert.equal(containsProhibitedClaim(reply), false);
  });
}

test("the deposit reply table is frozen", () => {
  assert.equal(Object.isFrozen(RESERVATION_DEPOSIT_REPLY), true);
});

// ---------------------------------------------------------------------------
// W2.4.2 — ROI (MB-F55).
// ---------------------------------------------------------------------------

const ROI_CLAIMS = [
  "What ROI can I expect on this apartment?",
  "The rental yield is 6% per year.",
  "Expected yields in Larnaca are strong.",
  "IRR of 12% annually on this project.",
  "The return on investment is roughly 7%.",
  "You can expect annual returns of 8%.",
  "Net returns from the rental are around 5%.",
  "Profit of 8% per year is realistic here.",
  "Prices will rise next year.",
  "Property values are expected to increase.",
  "The market will keep rising for the next five years.",
  "Prices are set to double by 2030.",
  "كم العائد المضبوط من هاد العقار؟",
  "العوائد الإيجارية بلارنكا ممتازة.",
  "المردود السنوي حوالي 7%.",
  "أرباح 10% سنوياً من الإيجار.",
  "الأسعار رح ترتفع السنة الجاية.",
  "هل السعر بيرتفع؟",
  "أسعار العقارات سوف تتضاعف.",
  "Ποια είναι η απόδοση αυτού του ακινήτου;",
  "Οι αποδόσεις στη Λάρνακα είναι υψηλές.",
  "Το κέρδος φτάνει το 8% τον χρόνο.",
  "Οι τιμές θα ανέβουν τον επόμενο χρόνο.",
  "Η αξία θα αυξηθεί σίγουρα."
];
for (const text of ROI_CLAIMS) {
  test(`MB-F55 blocks the ROI claim: ${text}`, () => {
    assert.equal(containsRoiClaim(text), true, text);
  });
}

test("a historical rise phrased as the future is still blocked", () => {
  // Evidence-backed history does not license a forward-looking statement.
  assert.equal(containsRoiClaim("Limassol prices rose 30% over five years, so they will keep rising."), true);
  assert.equal(containsRoiClaim("أسعار ليماسول ارتفعت كثير بالسنوات الماضية، ورح ترتفع كمان."), true);
});

const NOT_ROI_CLAIMS = [
  "Standard property VAT in Cyprus is 19%.",
  "Corporate tax in Cyprus starts from 15% from 2026.",
  "I will return your call tomorrow morning.",
  "The IP Box effective rate is roughly 2.5% to 3%.",
  "ضريبة القيمة المضافة الأساسية على العقارات الجديدة هي 19%.",
  "تبدأ ضريبة الشركات في قبرص من 15% اعتباراً من 2026.",
  "Ο βασικός ΦΠΑ ακινήτων είναι 19%.",
  "Το πακέτο ίδρυσης κοστίζει €999."
];
for (const text of NOT_ROI_CLAIMS) {
  test(`a stateable programme fact is not an ROI claim: ${text}`, () => {
    assert.equal(containsRoiClaim(text), false, text);
  });
}

for (const language of ["english", "arabic", "greek"]) {
  test(`roiCanonicalReply returns a non-empty ${language} script`, () => {
    const reply = roiCanonicalReply(language);
    assert.equal(typeof reply, "string");
    assert.ok(reply.length > 0);
    assert.equal(reply, ROI_REPLY[language]);
  });

  test(`the ${language} ROI script passes containsProhibitedClaim as false`, () => {
    assert.equal(containsProhibitedClaim(roiCanonicalReply(language)), false, language);
  });

  test(`the ${language} ROI script asks at most one question and uses no dash connector`, () => {
    const reply = roiCanonicalReply(language);
    assert.ok(questionCount(reply) <= 1, `one question rule broken: ${questionCount(reply)}`);
    assert.doesNotMatch(reply, DASH_CONNECTOR);
  });

  test(`the ${language} ROI script does not itself trip the ROI guard`, () => {
    assert.equal(containsRoiClaim(roiCanonicalReply(language)), false, language);
  });

  test(`the ${language} ROI script states that a future price cannot be guaranteed`, () => {
    const markers = {
      english: /nobody can guarantee a future property price/i,
      arabic: /ما حد بيقدر يضمن سعر العقار بالمستقبل/,
      greek: /κανείς δεν μπορεί να εγγυηθεί την τιμή/
    };
    assert.match(roiCanonicalReply(language), markers[language]);
  });
}

test("roiCanonicalReply falls back to English for an unknown or missing language", () => {
  assert.equal(roiCanonicalReply("klingon"), ROI_REPLY.english);
  assert.equal(roiCanonicalReply(), ROI_REPLY.english);
  assert.equal(roiCanonicalReply(null), ROI_REPLY.english);
});

test("ROI_REPLY is frozen and trilingual", () => {
  assert.equal(Object.isFrozen(ROI_REPLY), true);
  assert.deepEqual(Object.keys(ROI_REPLY).sort(), ["arabic", "english", "greek"]);
});

test("the Arabic ROI script is verbatim from the Master Brain manual", () => {
  // Provenance regression. The Arabic entry is copied character for character
  // from the manual's ROI section; the English and Greek entries are native
  // renderings of the same invariants, since the manual is Arabic only.
  const manual = path.join(__dirname, "..", "newplan", "Master Brain & Operating Rules Manual - REFAL AI.txt");
  assert.ok(fs.existsSync(manual), `source manual missing: ${manual}`);
  const source = fs.readFileSync(manual, "utf8");
  assert.ok(source.includes(ROI_REPLY.arabic), "the Arabic ROI script drifted from the Master Brain manual");
});

// ---------------------------------------------------------------------------
// W2.4.3 — Property VAT (MB-F45, MB-F48, MB-F49).
// 19% and 5% are stateable. "Which rate applies to YOU" is not.
// ---------------------------------------------------------------------------

const VAT_STATEABLE = [
  "Standard property VAT in Cyprus is 19%.",
  "ضريبة القيمة المضافة الأساسية على العقارات الجديدة هي 19%.",
  "Ο βασικός ΦΠΑ ακινήτων στην Κύπρο είναι 19%."
];
for (const text of VAT_STATEABLE) {
  test(`the base 19% rate is a stateable programme fact: ${text}`, () => {
    const result = classifyVatStatement(text);
    assert.equal(result.mentionsVat, true);
    assert.equal(result.statesRate, true);
    assert.equal(result.personalizedRateConclusion, false);
    assert.equal(result.allowed, true);
    assert.ok(result.reasons.includes("vat_rate_is_a_stateable_programme_fact"), JSON.stringify(result.reasons));
  });
}

const VAT_PERSONALIZED = [
  "You will pay the reduced 5% rate.",
  "ستدفع نسبة 5% المخفضة.",
  "Θα πληρώσετε τον μειωμένο συντελεστή 5%."
];
for (const text of VAT_PERSONALIZED) {
  test(`deciding the customer's own rate is blocked: ${text}`, () => {
    const result = classifyVatStatement(text);
    assert.equal(result.statesRate, true);
    assert.equal(result.personalizedRateConclusion, true);
    assert.equal(result.allowed, false);
    assert.ok(result.reasons.includes("personalized_vat_rate_conclusion"), JSON.stringify(result.reasons));
  });
}

// MB-F45, candidate MBC-015. This MUST pass: the conditional 5% statement is
// the fact BLK-1's blanket prohibition used to kill.
const VAT_CONDITIONAL = [
  "Reduced VAT of 5% can apply to a first permanent residence, subject to the current conditions.",
  "النسبة المخفضة 5% يمكن أن تنطبق على أول سكن دائم، حسب الشروط الحالية.",
  "Ο μειωμένος ΦΠΑ 5% μπορεί να ισχύει για πρώτη μόνιμη κατοικία, υπό τις ισχύουσες προϋποθέσεις."
];
for (const text of VAT_CONDITIONAL) {
  test(`MBC-015: the conditional reduced 5% statement is allowed: ${text}`, () => {
    const result = classifyVatStatement(text);
    assert.equal(result.mentionsVat, true);
    assert.equal(result.statesRate, true);
    assert.equal(result.personalizedRateConclusion, false);
    assert.equal(result.allowed, true, JSON.stringify(result.reasons));
    assert.ok(result.reasons.includes("rate_stated_conditionally"), JSON.stringify(result.reasons));
  });
}

const VAT_MORE_PERSONALIZED = [
  "In your case the 5% VAT rate applies.",
  "You qualify for the reduced 5% VAT.",
  "The VAT rate that applies to you is 19%.",
  "بحالتك نسبة 5% المخفضة بتنطبق عليك.",
  "أنت مؤهل للنسبة المخفضة 5% من ضريبة القيمة المضافة.",
  "Στην περίπτωσή σας ισχύει ο ΦΠΑ 5%.",
  "Δικαιούστε τον μειωμένο ΦΠΑ 5%."
];
for (const text of VAT_MORE_PERSONALIZED) {
  test(`a personalized VAT conclusion blocks: ${text}`, () => {
    const result = classifyVatStatement(text);
    assert.equal(result.personalizedRateConclusion, true, JSON.stringify(result));
    assert.equal(result.allowed, false);
  });
}

const VAT_NOT_MENTIONED = [
  "Is this a private company?",
  "We handle renovation work in Limassol.",
  "How do I activate my account?",
  "We are an innovative firm.",
  "هل هذه شركة خاصة؟",
  "Η εταιρεία ασχολείται με ανακαινίσεις."
];
for (const text of VAT_NOT_MENTIONED) {
  test(`BLK-15: 'vat' does not match inside ordinary words: ${text}`, () => {
    const result = classifyVatStatement(text);
    assert.equal(result.mentionsVat, false, text);
    assert.equal(result.statesRate, false, text);
    assert.equal(result.allowed, true);
    assert.deepEqual(result.reasons, ["no_vat_statement"]);
  });
}

test("the standalone VAT term is still recognised", () => {
  assert.equal(classifyVatStatement("Do I pay VAT on a new build?").mentionsVat, true);
  assert.equal(classifyVatStatement("Value added tax applies to new property.").mentionsVat, true);
});

test("a VAT mention with no rate is allowed and reports no stated rate", () => {
  const result = classifyVatStatement("VAT on new property is calculated precisely by the team.");
  assert.equal(result.mentionsVat, true);
  assert.equal(result.statesRate, false);
  assert.equal(result.allowed, true);
});

test("second-person language without a VAT rate is not a VAT conclusion", () => {
  const result = classifyVatStatement("You will pay the invoice by bank transfer.");
  assert.equal(result.personalizedRateConclusion, false);
  assert.equal(result.allowed, true);
});

test("BLK-16: Arabic VAT spelling variants reach the same verdict", () => {
  const bare = classifyVatStatement("ضريبة القيمه المضافه الاساسية على العقارات هي 19%.");
  const pointed = classifyVatStatement("ضريبة القيمة المضافة الأساسية على العقارات هي 19%.");
  assert.deepEqual(bare, pointed);
  assert.equal(bare.mentionsVat, true);
});

test("the accepted language option does not change the verdict", () => {
  const text = "Standard property VAT in Cyprus is 19%.";
  assert.deepEqual(classifyVatStatement(text, { language: "greek" }), classifyVatStatement(text));
});

// ---------------------------------------------------------------------------
// Null, empty and undefined input must never throw and never fail open.
// ---------------------------------------------------------------------------

test("violatesReservationDepositRule is safe on null, empty and undefined input", () => {
  for (const text of [null, undefined, "", "   ", 0, false]) {
    assert.equal(violatesReservationDepositRule(text, { source: "model" }), false, String(text));
    assert.equal(violatesReservationDepositRule(text), false, String(text));
  }
});

test("reservationDepositGuard is safe on null, empty and undefined input", () => {
  for (const text of [null, undefined, "", "   "]) {
    assert.equal(reservationDepositGuard(text, { source: "model" }), null, String(text));
    assert.equal(reservationDepositGuard(text), null, String(text));
  }
});

test("containsRoiClaim is safe on null, empty and undefined input", () => {
  for (const text of [null, undefined, "", "   ", 0, false]) assert.equal(containsRoiClaim(text), false, String(text));
});

test("classifyVatStatement is safe on null, empty and undefined input", () => {
  for (const text of [null, undefined, "", "   "]) {
    const result = classifyVatStatement(text);
    assert.deepEqual(result, { mentionsVat: false, statesRate: false, personalizedRateConclusion: false, allowed: true, reasons: ["no_vat_statement"] });
  }
  assert.deepEqual(classifyVatStatement(null, {}), classifyVatStatement(undefined));
});
