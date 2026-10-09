const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  detectBankingIntent,
  bankingGuardReply,
  violatesBankingHonesty,
  BANKING_TOPICS,
  STRIPE_GOLDEN_DIALOGUE
} = require("./bankingPolicy");
const { foldArabicLetters } = require("./language");
const { containsProhibitedClaim } = require("./refalcoAnswer");
const { validateResponse, questionCount } = require("./responsePolicy");

// P2.3 G2 gate — MB 2.3, MB-F28 / MB-F29.
//
// Three properties are being defended here, and they fail in different
// directions, so they are tested separately:
//
//   1. DETECTION must fire on every banking / gateway topic in all three
//      languages plus Arabizi and Greeklish, and must NOT fire on ordinary
//      business English (BLK-15) or on a bare-alef Arabic spelling (BLK-16).
//   2. The REPLY must carry all three mandated parts and exactly one question,
//      and must survive the repo's own output gates untouched.
//   3. The HONESTY gate must block a promised institutional decision while
//      staying silent on the honest MB-F29 sentence, which names approval
//      precisely in order to refuse to promise it.

const T = BANKING_TOPICS;

function topicsOf(text) {
  return detectBankingIntent(text).topics;
}

// ---------------------------------------------------------------------------
// 1. Topic detection, English
// ---------------------------------------------------------------------------

test("EN: opening a bank account is detected", () => {
  const result = detectBankingIntent("I want to open a corporate bank account in Cyprus");
  assert.equal(result.matched, true);
  assert.equal(result.language, "english");
  assert.ok(result.topics.includes(T.BANK_ACCOUNT));
});

test("EN: a bank approval question is detected", () => {
  assert.ok(topicsOf("Will the bank approve my application?").includes(T.BANK_APPROVAL));
});

test("EN: Stripe is detected", () => {
  assert.ok(topicsOf("Can I use Stripe with a Cyprus company?").includes(T.STRIPE));
});

test("EN: PayPal is detected, spaced or joined", () => {
  assert.ok(topicsOf("Does PayPal work for this?").includes(T.PAYPAL));
  assert.ok(topicsOf("We also need pay pal").includes(T.PAYPAL));
});

test("EN: Amazon selling is detected", () => {
  assert.ok(topicsOf("I sell on Amazon and need payouts").includes(T.AMAZON));
});

test("EN: Shopify is detected", () => {
  assert.ok(topicsOf("My store is on Shopify").includes(T.SHOPIFY));
});

test("EN: payment gateway is detected", () => {
  assert.ok(topicsOf("I need a payment gateway for my store").includes(T.PAYMENT_GATEWAY));
});

test("EN: payment processor is detected as a gateway topic", () => {
  assert.ok(topicsOf("Which payment processor do you work with?").includes(T.PAYMENT_GATEWAY));
});

test("EN: merchant account is detected", () => {
  assert.ok(topicsOf("How do I get a merchant account?").includes(T.MERCHANT_ACCOUNT));
});

test("EN: payment service provider is detected", () => {
  assert.ok(topicsOf("Which payment service provider do you recommend?").includes(T.PSP));
});

test("EN: the PSP acronym is detected when written in capitals", () => {
  assert.ok(topicsOf("We already work with a PSP").includes(T.PSP));
});

test("EN: acquiring bank is detected", () => {
  assert.ok(topicsOf("Do you know an acquiring bank in Cyprus?").includes(T.ACQUIRING));
});

test("EN: card acquiring and acquirer are detected", () => {
  assert.ok(topicsOf("We need a card acquiring partner").includes(T.ACQUIRING));
  assert.ok(topicsOf("Who is the acquirer here?").includes(T.ACQUIRING));
});

test("EN: IBAN is detected", () => {
  assert.ok(topicsOf("How long does it take to get an IBAN?").includes(T.IBAN));
});

test("EN: the EMI acronym is detected when written in capitals", () => {
  assert.ok(topicsOf("Can you open an EMI account instead?").includes(T.EMI));
});

test("EN: electronic money institution is detected", () => {
  assert.ok(topicsOf("What about an electronic money institution?").includes(T.EMI));
});

// ---------------------------------------------------------------------------
// 2. Topic detection, Arabic
// ---------------------------------------------------------------------------

test("AR: opening a bank account is detected", () => {
  const result = detectBankingIntent("بدي أفتح حساب بنكي للشركة");
  assert.equal(result.language, "arabic");
  assert.ok(result.topics.includes(T.BANK_ACCOUNT));
});

test("AR: bank approval is detected", () => {
  assert.ok(topicsOf("هل موافقة البنك أكيدة؟").includes(T.BANK_APPROVAL));
});

test("AR: the bank accepting or refusing is detected", () => {
  assert.ok(topicsOf("هل البنك رح يوافق على الطلب؟").includes(T.BANK_APPROVAL));
});

test("AR: Stripe transliterations are detected", () => {
  assert.ok(topicsOf("بدي أشغل سترايب").includes(T.STRIPE));
  assert.ok(topicsOf("بدي أشغل ستريب").includes(T.STRIPE));
});

test("AR: PayPal is detected", () => {
  assert.ok(topicsOf("بدي بايبال كمان").includes(T.PAYPAL));
});

test("AR: Amazon is detected", () => {
  assert.ok(topicsOf("عندي متجر أمازون").includes(T.AMAZON));
});

test("AR: Shopify is detected", () => {
  assert.ok(topicsOf("متجري على شوبيفاي").includes(T.SHOPIFY));
});

test("AR: payment gateway is detected", () => {
  assert.ok(topicsOf("بدي بوابة دفع للمتجر").includes(T.PAYMENT_GATEWAY));
});

test("AR: merchant account is detected", () => {
  assert.ok(topicsOf("كيف بفتح حساب تاجر؟").includes(T.MERCHANT_ACCOUNT));
});

test("AR: payment service provider is detected", () => {
  assert.ok(topicsOf("مين مزود خدمة الدفع المناسب؟").includes(T.PSP));
});

test("AR: acquiring bank is detected", () => {
  assert.ok(topicsOf("بدي أعرف البنك المستحوذ").includes(T.ACQUIRING));
});

test("AR: IBAN is detected", () => {
  assert.ok(topicsOf("كم بدها لفتح الآيبان؟").includes(T.IBAN));
});

test("AR: electronic money institution is detected", () => {
  assert.ok(topicsOf("شو رأيك بمؤسسة نقود إلكترونية؟").includes(T.EMI));
});

// ---------------------------------------------------------------------------
// 3. Topic detection, Greek
// ---------------------------------------------------------------------------

test("EL: opening a bank account is detected", () => {
  const result = detectBankingIntent("Θέλω να ανοίξω τραπεζικό λογαριασμό");
  assert.equal(result.language, "greek");
  assert.ok(result.topics.includes(T.BANK_ACCOUNT));
});

test("EL: account opening phrased with an article is detected", () => {
  assert.ok(topicsOf("Μπορείτε να μου κάνετε άνοιγμα του λογαριασμού;").includes(T.BANK_ACCOUNT));
});

test("EL: bank approval is detected", () => {
  assert.ok(topicsOf("Θα δώσει έγκριση η τράπεζα;").includes(T.BANK_APPROVAL));
});

test("EL: Stripe transliteration is detected", () => {
  assert.ok(topicsOf("Θέλω να χρησιμοποιώ στράιπ").includes(T.STRIPE));
});

test("EL: PayPal is detected", () => {
  assert.ok(topicsOf("Θέλω πέι παλ για την εταιρεία").includes(T.PAYPAL));
});

test("EL: Amazon is detected", () => {
  assert.ok(topicsOf("Πουλάω στο αμαζόν").includes(T.AMAZON));
});

test("EL: Shopify is detected", () => {
  assert.ok(topicsOf("Το κατάστημά μου είναι στο shopify").includes(T.SHOPIFY));
});

test("EL: payment gateway is detected", () => {
  assert.ok(topicsOf("Χρειάζομαι πύλη πληρωμών").includes(T.PAYMENT_GATEWAY));
});

test("EL: merchant account is detected", () => {
  assert.ok(topicsOf("Πώς παίρνω εμπορικό λογαριασμό;").includes(T.MERCHANT_ACCOUNT));
});

test("EL: payment service provider is detected", () => {
  assert.ok(topicsOf("Ποιος πάροχος υπηρεσιών πληρωμών;").includes(T.PSP));
});

test("EL: acquiring bank is detected", () => {
  assert.ok(topicsOf("Χρειάζομαι αποδέκτρια τράπεζα").includes(T.ACQUIRING));
});

test("EL: IBAN is detected", () => {
  assert.ok(topicsOf("Πόσο θέλει το ιβαν;").includes(T.IBAN));
});

test("EL: electronic money institution is detected", () => {
  assert.ok(topicsOf("Τι λέτε για ίδρυμα ηλεκτρονικού χρήματος;").includes(T.EMI));
});

// ---------------------------------------------------------------------------
// 4. Arabizi and Greeklish. The dialect anchors live in src/language.js; each
//    string below carries one so the language verdict is the dialect, not
//    English.
// ---------------------------------------------------------------------------

test("Arabizi: opening a bank account is detected and read as Arabic", () => {
  const result = detectBankingIntent("baddi fat7 el hesab banki");
  assert.equal(result.language, "arabic");
  assert.ok(result.topics.includes(T.BANK_ACCOUNT));
});

test("Arabizi: bank approval is detected", () => {
  const result = detectBankingIntent("shu ra2yak bi mwafa2et el bank");
  assert.equal(result.language, "arabic");
  assert.ok(result.topics.includes(T.BANK_APPROVAL));
});

test("Arabizi: payment gateway is detected", () => {
  const result = detectBankingIntent("baddi bawabet el daf3 la el matjar");
  assert.equal(result.language, "arabic");
  assert.ok(result.topics.includes(T.PAYMENT_GATEWAY));
});

test("Arabizi: a Latin-script gateway name still resolves to Arabic", () => {
  const result = detectBankingIntent("baddi shaghel Stripe");
  assert.equal(result.language, "arabic");
  assert.ok(result.topics.includes(T.STRIPE));
});

test("Greeklish: account opening is detected and read as Greek", () => {
  const result = detectBankingIntent("thelo anigma logariasmou");
  assert.equal(result.language, "greek");
  assert.ok(result.topics.includes(T.BANK_ACCOUNT));
});

test("Greeklish: bank approval is detected", () => {
  const result = detectBankingIntent("egkrisi tis trapezas poso argotera");
  assert.equal(result.language, "greek");
  assert.ok(result.topics.includes(T.BANK_APPROVAL));
});

test("Greeklish: payment gateway is detected", () => {
  const result = detectBankingIntent("thelo pyli pliromon gia to etaireia mou");
  assert.equal(result.language, "greek");
  assert.ok(result.topics.includes(T.PAYMENT_GATEWAY));
});

// ---------------------------------------------------------------------------
// 5. BLK-16 — bare alef vs hamza. The bare spelling used to bypass Arabic
//    matchers outright, which is a MISS, not a near miss. Both spellings must
//    reach the identical verdict.
// ---------------------------------------------------------------------------

const ARABIC_SPELLING_PAIRS = [
  ["بدي افتح حساب بنكي", "بدي أفتح حساب بنكي"],
  ["موافقه البنك اكيده", "موافقة البنك أكيدة"],
  ["بدي بوابه الدفع", "بدي بوابة الدفع"],
  ["مؤسسه نقود الكترونيه", "مؤسسة نقود إلكترونية"],
  ["كم بدها لفتح الايبان", "كم بدها لفتح الآيبان"]
];

test("BLK-16: bare-alef and hamza spellings produce identical topics", () => {
  for (const [bare, pointed] of ARABIC_SPELLING_PAIRS) {
    assert.deepEqual(detectBankingIntent(bare).topics, detectBankingIntent(pointed).topics, `variant mismatch: ${bare}`);
  }
});

test("BLK-16: the bare-alef spelling never silently fails to match", () => {
  for (const [bare] of ARABIC_SPELLING_PAIRS) {
    assert.equal(detectBankingIntent(bare).matched, true, `bare spelling missed: ${bare}`);
  }
});

test("BLK-16: folding is what makes the two spellings equal, not luck", () => {
  for (const [bare, pointed] of ARABIC_SPELLING_PAIRS) {
    assert.equal(foldArabicLetters(bare), foldArabicLetters(pointed), `fold did not unify: ${bare}`);
  }
});

test("BLK-16: the ta-marbuta spelling of a merchant account is detected", () => {
  assert.ok(topicsOf("كيف بفتح حساب التاجر؟").includes(T.MERCHANT_ACCOUNT));
});

// ---------------------------------------------------------------------------
// 6. BLK-15 — unanchored substrings. `vat` with no boundary turned `private`,
//    `renovation` and `activate` into restricted tax topics
//    (src/safetyPolicy.js:23-26). The short tokens here (iban, psp, emi,
//    stripe) are the same shape of hazard.
// ---------------------------------------------------------------------------

const ORDINARY_BUSINESS_ENGLISH = [
  "private",
  "Is this a private company?",
  "We handle renovation work",
  "How do I activate my account settings?",
  "We are an innovative software firm",
  "The excavation starts on Monday",
  "We want to cultivate new markets",
  "Emily is our accountant",
  "Our semi-annual report is ready",
  "Please send me a reminder",
  "He is from the Emirates",
  "She wears a striped shirt",
  "We are acquiring a competitor this year",
  "What services do you offer?",
  "أريد تأسيس شركة في قبرص",
  "Πόσο κοστίζει μια εταιρεία;"
];

test("BLK-15: ordinary words never match a banking topic", () => {
  for (const text of ORDINARY_BUSINESS_ENGLISH) {
    assert.equal(detectBankingIntent(text).matched, false, `false positive on: ${text}`);
  }
});

test("BLK-15: `private`, `renovation` and `activate` specifically stay clean", () => {
  for (const text of ["private", "renovation", "activate"]) {
    assert.deepEqual(detectBankingIntent(text).topics, [], `false positive on: ${text}`);
  }
});

test("BLK-15: non-banking text yields no guard reply at all", () => {
  for (const text of ORDINARY_BUSINESS_ENGLISH) {
    assert.equal(bankingGuardReply(text), null, `unexpected guard reply for: ${text}`);
  }
});

test("BLK-15: `acquiring` on its own is not card acquiring", () => {
  assert.equal(detectBankingIntent("We are acquiring new customers every month").matched, false);
  assert.ok(topicsOf("We need an acquiring bank").includes(T.ACQUIRING));
});

test("BLK-15: a lower-case `emi` or `psp` inside a word is not an acronym", () => {
  assert.equal(detectBankingIntent("The chemistry department is semi independent").matched, false);
  assert.equal(detectBankingIntent("Please inspect the apse profile").matched, false);
});

// ---------------------------------------------------------------------------
// 7. The MB 2.3 golden dialogue
// ---------------------------------------------------------------------------

test("the golden fixture holds all three languages and is frozen", () => {
  assert.deepEqual(Object.keys(STRIPE_GOLDEN_DIALOGUE).sort(), ["arabic", "english", "greek"]);
  assert.equal(Object.isFrozen(STRIPE_GOLDEN_DIALOGUE), true);
  for (const key of ["arabic", "english", "greek"]) {
    assert.equal(Object.isFrozen(STRIPE_GOLDEN_DIALOGUE[key]), true, key);
    assert.equal(typeof STRIPE_GOLDEN_DIALOGUE[key].customer, "string", key);
    assert.equal(typeof STRIPE_GOLDEN_DIALOGUE[key].reply, "string", key);
  }
});

test("the Arabic fixture is the verbatim MB text, not a paraphrase", () => {
  // newplan/Master Brain & Operating Rules Manual - REFAL AI.txt lines 78-79.
  assert.equal(
    STRIPE_GOLDEN_DIALOGUE.arabic.customer,
    "بدي أفتح شركة عشان أشغل Stripe، بتضمنوا لي فتح الحساب؟"
  );
  assert.equal(
    STRIPE_GOLDEN_DIALOGUE.arabic.reply,
    "آها 😄 هيك وصلنا للهدف الحقيقي بسرعة! بالنسبة لـ Stripe أو البنوك، الموافقة النهائية بتعتمد على تقييمهم لنشاطك وملفك وما حد بيقدر يوعدك بموافقة جهة ثانية. بس الفكرة إننا من البداية بنبني لك الشركة والملف بشكل واضح ومناسب لنشاطك، بدل ما تسجل وتكتشف مشاكل بالامتثال بعدين. شو طبيعة شغلك ومن وين عملاؤك حالياً؟"
  );
});

test("every golden customer message is recognised as a banking question", () => {
  for (const key of ["arabic", "english", "greek"]) {
    const result = detectBankingIntent(STRIPE_GOLDEN_DIALOGUE[key].customer);
    assert.equal(result.matched, true, key);
    assert.ok(result.topics.includes(T.STRIPE), `Stripe not detected in ${key}`);
  }
});

test("each golden customer message is read in its own language", () => {
  assert.equal(detectBankingIntent(STRIPE_GOLDEN_DIALOGUE.arabic.customer).language, "arabic");
  assert.equal(detectBankingIntent(STRIPE_GOLDEN_DIALOGUE.english.customer).language, "english");
  assert.equal(detectBankingIntent(STRIPE_GOLDEN_DIALOGUE.greek.customer).language, "greek");
});

test("each golden dialogue produces a guard reply with all three mandated parts", () => {
  for (const key of ["arabic", "english", "greek"]) {
    const guard = bankingGuardReply(STRIPE_GOLDEN_DIALOGUE[key].customer);
    assert.ok(guard, `no guard reply for ${key}`);
    assert.equal(guard.language, key);
    for (const part of ["honest", "value", "question"]) {
      assert.equal(typeof guard.shape[part], "string", `${key}.${part}`);
      assert.ok(guard.shape[part].trim().length > 0, `${key}.${part} is empty`);
      assert.ok(guard.reply.includes(guard.shape[part]), `${key}.${part} missing from reply`);
    }
  }
});

test("each golden dialogue produces exactly one question mark (One Question Rule)", () => {
  for (const key of ["arabic", "english", "greek"]) {
    const guard = bankingGuardReply(STRIPE_GOLDEN_DIALOGUE[key].customer);
    assert.equal(questionCount(guard.reply), 1, `${key} asked ${questionCount(guard.reply)} questions`);
  }
});

test("the three mandated parts appear in order: honest, then value, then question", () => {
  for (const key of ["arabic", "english", "greek"]) {
    const { reply, shape } = bankingGuardReply(STRIPE_GOLDEN_DIALOGUE[key].customer);
    assert.ok(reply.indexOf(shape.honest) < reply.indexOf(shape.value), `${key}: value precedes honest`);
    assert.ok(reply.indexOf(shape.value) < reply.indexOf(shape.question), `${key}: question precedes value`);
  }
});

test("the question is the last part of the reply", () => {
  for (const key of ["arabic", "english", "greek"]) {
    const { reply, shape } = bankingGuardReply(STRIPE_GOLDEN_DIALOGUE[key].customer);
    assert.ok(reply.trim().endsWith(shape.question), `${key} does not end on the discovery question`);
  }
});

test("only the question part carries a question mark", () => {
  for (const key of ["arabic", "english", "greek"]) {
    const { shape } = bankingGuardReply(STRIPE_GOLDEN_DIALOGUE[key].customer);
    assert.equal(questionCount(shape.honest), 0, `${key}: honest part asks a question`);
    assert.equal(questionCount(shape.value), 0, `${key}: value part asks a question`);
    assert.equal(questionCount(shape.question), 1, `${key}: question part is not one question`);
  }
});

test("the golden fixture replies themselves ask exactly one question", () => {
  for (const key of ["arabic", "english", "greek"]) {
    assert.equal(questionCount(STRIPE_GOLDEN_DIALOGUE[key].reply), 1, key);
  }
});

test("the golden fixture replies never promise an institution's decision", () => {
  for (const key of ["arabic", "english", "greek"]) {
    assert.equal(violatesBankingHonesty(STRIPE_GOLDEN_DIALOGUE[key].reply), false, key);
  }
});

test("the golden fixture replies survive the prohibited-claim gate", () => {
  for (const key of ["arabic", "english", "greek"]) {
    assert.equal(containsProhibitedClaim(STRIPE_GOLDEN_DIALOGUE[key].reply), false, key);
  }
});

test("the golden fixture replies survive validateResponse", () => {
  for (const key of ["arabic", "english", "greek"]) {
    const result = validateResponse(STRIPE_GOLDEN_DIALOGUE[key].reply);
    assert.equal(result.valid, true, `${key}: ${result.reasons.join(", ")}`);
  }
});

// ---------------------------------------------------------------------------
// 8. The reply shape
// ---------------------------------------------------------------------------

test("a guard reply is produced for a banking question in each language", () => {
  assert.ok(bankingGuardReply("Can you open a bank account for me?"));
  assert.ok(bankingGuardReply("بدي أفتح حساب بنكي"));
  assert.ok(bankingGuardReply("Θέλω να ανοίξω τραπεζικό λογαριασμό"));
});

test("the reply language follows the customer's language by default", () => {
  assert.equal(bankingGuardReply("Can you open a bank account?").language, "english");
  assert.equal(bankingGuardReply("بدي أفتح حساب بنكي").language, "arabic");
  assert.equal(bankingGuardReply("Θέλω να ανοίξω τραπεζικό λογαριασμό").language, "greek");
});

test("an explicit language option overrides the detected language", () => {
  const guard = bankingGuardReply("Can you open a bank account?", { language: "greek" });
  assert.equal(guard.language, "greek");
  assert.ok(guard.reply.includes("χρηματοπιστωτικού"));
});

test("an unknown language option falls back to the detected language", () => {
  const guard = bankingGuardReply("بدي أفتح حساب بنكي", { language: "klingon" });
  assert.equal(guard.language, "arabic");
});

test("the honest part names the institution's own risk and KYC/AML assessment", () => {
  assert.match(bankingGuardReply("Stripe?", { language: "english" }).shape.honest, /risk assessment/i);
  assert.match(bankingGuardReply("Stripe?", { language: "english" }).shape.honest, /KYC and AML/);
  assert.match(bankingGuardReply("Stripe?", { language: "arabic" }).shape.honest, /KYC\/AML/);
  assert.match(bankingGuardReply("Stripe?", { language: "greek" }).shape.honest, /KYC και AML/);
});

test("the value part names a clean file from day one and what makes it clean", () => {
  assert.match(bankingGuardReply("Stripe?", { language: "english" }).shape.value, /business activity/i);
  assert.match(bankingGuardReply("Stripe?", { language: "english" }).shape.value, /source of funds/i);
  assert.match(bankingGuardReply("Stripe?", { language: "arabic" }).shape.value, /مصدر أموال/);
  assert.match(bankingGuardReply("Stripe?", { language: "greek" }).shape.value, /προέλευση κεφαλαίων/);
});

test("no generated reply uses a dash as a connector", () => {
  for (const language of ["english", "arabic", "greek"]) {
    const { reply } = bankingGuardReply("Stripe?", { language });
    assert.doesNotMatch(reply, / [-–—] |—|–/u, `dash connector in ${language}`);
  }
});

test("no generated reply contains guarantee wording in any language", () => {
  for (const language of ["english", "arabic", "greek"]) {
    const { reply } = bankingGuardReply("Stripe?", { language });
    assert.doesNotMatch(reply, /guarantee|guaranteed|مضمون|نضمن|εγγύηση|εγγυημέν|σίγουρη έγκριση/iu, language);
  }
});

test("no generated reply trips its own honesty gate", () => {
  for (const language of ["english", "arabic", "greek"]) {
    assert.equal(violatesBankingHonesty(bankingGuardReply("Stripe?", { language }).reply), false, language);
  }
});

test("every generated reply survives containsProhibitedClaim", () => {
  for (const language of ["english", "arabic", "greek"]) {
    assert.equal(containsProhibitedClaim(bankingGuardReply("Stripe?", { language }).reply), false, language);
  }
});

test("every generated reply survives validateResponse at its default budget", () => {
  for (const language of ["english", "arabic", "greek"]) {
    const result = validateResponse(bankingGuardReply("Stripe?", { language }).reply);
    assert.equal(result.valid, true, `${language}: ${result.reasons.join(", ")}`);
  }
});

test("every generated reply asks exactly one question", () => {
  for (const language of ["english", "arabic", "greek"]) {
    assert.equal(questionCount(bankingGuardReply("Stripe?", { language }).reply), 1, language);
  }
});

test("the guard reply is driven by detection, so a non-banking question returns null", () => {
  assert.equal(bankingGuardReply("How much does a company cost?"), null);
  assert.equal(bankingGuardReply("شو خدمات الشركة؟"), null);
  assert.equal(bankingGuardReply("Τι υπηρεσίες έχετε;"), null);
});

test("the guard reply is produced for every detected topic, not just Stripe", () => {
  for (const text of [
    "I need a merchant account",
    "Which payment service provider?",
    "We need an acquiring bank",
    "How long for an IBAN?",
    "Can you open an EMI account?",
    "I sell on Amazon",
    "My store is on Shopify",
    "Does PayPal work?"
  ]) {
    assert.ok(bankingGuardReply(text), `no guard reply for: ${text}`);
  }
});

// ---------------------------------------------------------------------------
// 9. The honesty output gate
// ---------------------------------------------------------------------------

test("MB-F28: an English promise of approval is blocked", () => {
  assert.equal(violatesBankingHonesty("your Stripe account will be approved"), true);
});

test("MB-F28: an Arabic promise of approval is blocked", () => {
  assert.equal(violatesBankingHonesty("موافقة البنك مؤكدة"), true);
});

test("MB-F28: a Greek promise of approval is blocked", () => {
  assert.equal(violatesBankingHonesty("η έγκριση τράπεζας είναι βέβαιη"), true);
});

test("MB-F29: the honest sentence is NOT blocked", () => {
  assert.equal(
    violatesBankingHonesty("The final decision belongs to the financial institution's own risk assessment and KYC and AML compliance requirements."),
    false
  );
});

test("an explicit guarantee by us is blocked in all three languages", () => {
  assert.equal(violatesBankingHonesty("We guarantee the bank account opening."), true);
  assert.equal(violatesBankingHonesty("منضمنلك فتح الحساب"), true);
  assert.equal(violatesBankingHonesty("Σας εγγυόμαστε το άνοιγμα του λογαριασμού."), true);
});

test("'no problem' about the institution's side is blocked", () => {
  assert.equal(violatesBankingHonesty("Opening the account is no problem at all."), true);
  assert.equal(violatesBankingHonesty("ما في مشكلة بفتح الحساب أبداً"), true);
  assert.equal(violatesBankingHonesty("Δεν υπάρχει κανένα πρόβλημα με τον λογαριασμό."), true);
});

test("a promised future acceptance is blocked", () => {
  assert.equal(violatesBankingHonesty("Your merchant account will be accepted next week."), true);
  assert.equal(violatesBankingHonesty("Stripe will approve you."), true);
  assert.equal(violatesBankingHonesty("You will get the approval."), true);
});

test("'approval is guaranteed' is blocked in both word orders", () => {
  assert.equal(violatesBankingHonesty("Approval is guaranteed for Cyprus companies."), true);
  assert.equal(violatesBankingHonesty("This is guaranteed approval."), true);
});

test("a NEGATED guarantee is the compliant phrasing and must pass", () => {
  for (const text of [
    "I cannot guarantee the outcome.",
    "Nobody can promise you another institution's answer.",
    "No one can guarantee what the institution will decide.",
    "ما فيني أضمن النتيجة",
    "ما منضمن الموافقة",
    "Δεν μπορώ να εγγυηθώ το αποτέλεσμα."
  ]) {
    assert.equal(violatesBankingHonesty(text), false, `compliant phrasing blocked: ${text}`);
  }
});

test("naming the decision without promising it passes", () => {
  for (const text of [
    "The approval depends on their own assessment of your file.",
    "الموافقة النهائية بترجع للجهة المالية نفسها",
    "Η τελική απόφαση ανήκει στον χρηματοπιστωτικό οργανισμό."
  ]) {
    assert.equal(violatesBankingHonesty(text), false, `honest phrasing blocked: ${text}`);
  }
});

test("BLK-16: a bare-alef Arabic promise is blocked exactly like the pointed one", () => {
  assert.equal(violatesBankingHonesty("موافقه البنك مؤكده"), true);
  assert.equal(violatesBankingHonesty("موافقة البنك مؤكدة"), true);
});

test("ordinary business prose never trips the honesty gate", () => {
  for (const text of [
    "We handle renovation work for private clients.",
    "Our innovative platform can activate new markets.",
    "شو خدمات الشركة؟",
    "Πόσο κοστίζει μια εταιρεία;"
  ]) {
    assert.equal(violatesBankingHonesty(text), false, text);
  }
});

// ---------------------------------------------------------------------------
// 10. Null, empty and non-string input
// ---------------------------------------------------------------------------

test("detectBankingIntent is safe on null, undefined and empty input", () => {
  for (const value of [null, undefined, "", "   ", "\n\t"]) {
    const result = detectBankingIntent(value);
    assert.equal(result.matched, false, String(value));
    assert.deepEqual(result.topics, []);
    assert.equal(typeof result.language, "string");
  }
});

test("bankingGuardReply returns null on null, undefined and empty input", () => {
  for (const value of [null, undefined, "", "   "]) {
    assert.equal(bankingGuardReply(value), null, String(value));
  }
});

test("violatesBankingHonesty is false on null, undefined and empty input", () => {
  for (const value of [null, undefined, "", "   "]) {
    assert.equal(violatesBankingHonesty(value), false, String(value));
  }
});

test("non-string input is coerced safely and never throws", () => {
  for (const value of [0, 1, {}, [], true, Symbol.iterator ? 42 : 42]) {
    assert.doesNotThrow(() => detectBankingIntent(value));
    assert.doesNotThrow(() => bankingGuardReply(value));
    assert.doesNotThrow(() => violatesBankingHonesty(value));
  }
});

// ---------------------------------------------------------------------------
// 11. Shape of the exported surface
// ---------------------------------------------------------------------------

test("BANKING_TOPICS is frozen and covers every MB 2.3 topic", () => {
  assert.equal(Object.isFrozen(BANKING_TOPICS), true);
  assert.deepEqual(Object.values(BANKING_TOPICS).sort(), [
    "acquiring", "amazon", "bank_account", "bank_approval", "emi", "iban",
    "merchant_account", "payment_gateway", "paypal", "psp", "shopify", "stripe"
  ]);
});

test("detectBankingIntent returns a stable topic order across calls", () => {
  const text = "Can Stripe and PayPal work with a corporate bank account and an IBAN?";
  assert.deepEqual(detectBankingIntent(text).topics, detectBankingIntent(text).topics);
  assert.deepEqual(detectBankingIntent(text).topics, [T.BANK_ACCOUNT, T.STRIPE, T.PAYPAL, T.IBAN]);
});

test("a multi-topic message reports every topic, not just the first", () => {
  const result = detectBankingIntent("I need Stripe, Shopify and a merchant account");
  assert.ok(result.topics.includes(T.STRIPE));
  assert.ok(result.topics.includes(T.SHOPIFY));
  assert.ok(result.topics.includes(T.MERCHANT_ACCOUNT));
});

test("topics are deduplicated when a term repeats", () => {
  const result = detectBankingIntent("Stripe, Stripe and more Stripe");
  assert.deepEqual(result.topics, [T.STRIPE]);
});
