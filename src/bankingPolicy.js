const { detectMessageLanguage, foldArabicLetters, foldRulePatterns } = require("./language");
const { normalizeSafetyText } = require("./safetyPolicy");

// P2.3 — Banking and payment gateway guard (MB 2.3, MB-F28 / MB-F29, MB-AP4).
//
// MB-F28 is absolute: REFAL may never give a definitive promise about opening a
// bank account or activating a payment gateway (Stripe, PayPal, Amazon,
// Shopify). MB-F29 names the reason: the decision is the financial
// institution's own risk assessment and KYC/AML compliance call, not ours.
//
// This module does three separate jobs and keeps them separate on purpose:
//
//   detectBankingIntent      — INPUT side. Is the customer asking about banking
//                              or a payment gateway, in any of the three
//                              languages plus Arabizi and Greeklish?
//   bankingGuardReply        — the mandated REPLY SHAPE: honest, then the real
//                              value, then exactly ONE discovery question.
//   violatesBankingHonesty   — OUTPUT gate. Does a candidate answer promise an
//                              institution's decision instead of being honest
//                              about who owns it?
//
// Two traps this file is written around, both already paid for in this repo:
//
//   * BLK-15 — an unanchored substring is a false-positive generator. `vat`
//     without a boundary turned `private`, `renovation` and `activate` into
//     restricted tax topics (see the comment at src/safetyPolicy.js:23-26).
//     Every short Latin token here (`iban`, `psp`, `emi`, `stripe`) carries an
//     explicit boundary.
//   * JavaScript `\b` is ASCII-only, so it is UNREACHABLE next to an Arabic or
//     Greek letter (src/refalcoAnswer.js:51-57). The boundary used here is a
//     Unicode property lookaround, and the Arabic alternatives are multi-word
//     phrases that need no boundary at all, because Arabic glues its prefixes
//     onto the stem (`أفتح حساب` must still match `فتح حساب`).
//
// BLK-16 — every Arabic pattern below is authored in readable pointed Arabic and
// folded once at module load by `foldRulePatterns`, and the incoming text is
// folded by `normalizeSafetyText`. Both sides folded is the only way the bare
// alef spelling reaches the same verdict as the hamza-carrying one.

const BANKING_TOPICS = Object.freeze({
  BANK_ACCOUNT: "bank_account",
  BANK_APPROVAL: "bank_approval",
  STRIPE: "stripe",
  PAYPAL: "paypal",
  AMAZON: "amazon",
  SHOPIFY: "shopify",
  PAYMENT_GATEWAY: "payment_gateway",
  MERCHANT_ACCOUNT: "merchant_account",
  PSP: "psp",
  ACQUIRING: "acquiring",
  IBAN: "iban",
  EMI: "emi"
});

// Unicode-safe word boundary. `\b` cannot be used for any of these because the
// same rule table carries Arabic and Greek alternatives.
const L = "(?<![\\p{L}\\p{N}_])";
const R = "(?![\\p{L}\\p{N}_])";
const bounded = (...alternatives) => `${L}(?:${alternatives.join("|")})${R}`;

// [topic, pattern] pairs. Several topics appear more than once: an acronym that
// must stay case-sensitive (PSP, EMI, IBAN) cannot share a regex with the
// case-insensitive prose alternatives without making `Emi` or `psp`-in-a-word
// matchable, which is BLK-15 all over again.
const rawRules = [
  // --- bank account opening -------------------------------------------------
  [BANKING_TOPICS.BANK_ACCOUNT, new RegExp([
    bounded("bank(?:ing)?\\s+account", "corporate\\s+account", "business\\s+account", "company\\s+account"),
    bounded("open(?:ing)?\\s+(?:up\\s+)?(?:a|an|the|my|our)?\\s*(?:bank|banking|corporate|business|company)?\\s*account"),
    bounded("account\\s+opening", "accounts?\\s+(?:will\\s+be\\s+|to\\s+be\\s+|can\\s+be\\s+)?opened"),
    // Arabizi. No boundary games needed, these are multi-token phrases.
    "(?:fat7|fath|fateh|ifta7|efta7)\\s*(?:el\\s*|il\\s*)?(?:7esab|hesab|hisab|7isab|7sab)",
    "(?:7esab|hesab|hisab|7isab)\\s*(?:banki|bank|masrafi|maSrafi|shirka|sherke)",
    // Arabic.
    "(?:ال)?حساب\\s+(?:ال)?(?:بنكي|مصرفي)",
    "حساب\\s+(?:في\\s+)?(?:ال)?(?:بنك|مصرف)",
    "فتح\\s+(?:ال)?حساب",
    "فتح\\s+حساب",
    // Greek.
    "τραπεζικ\\S*\\s+λογαριασμ",
    "λογαριασμ\\S*\\s+(?:στην\\s+|σε\\s+)?τράπεζ",
    "άνοιγμα\\s+(?:\\S+\\s+){0,2}λογαριασμ",
    "ανοίξ\\S*\\s+(?:\\S+\\s+){0,2}λογαριασμ",
    // Greeklish.
    "(?:trapeziko|etairiko|etaireiko)\\s+logariasm",
    "(?:anigma|anoigma|anoixo|anikso|anoikso)\\s+(?:trapeziko\\s+|trapezikou\\s+)?logariasm"
  ].join("|"), "iu")],

  // --- bank approval --------------------------------------------------------
  [BANKING_TOPICS.BANK_APPROVAL, new RegExp([
    `${bounded("banks?")}[^.?!؟]{0,40}${bounded("approv\\w+", "accept\\w+", "declin\\w+", "reject\\w+", "decision")}`,
    `${bounded("approv\\w+", "accept\\w+", "decision")}[^.?!؟]{0,40}${bounded("banks?")}`,
    // Arabizi.
    "(?:mwafa2|muwafaqa|mwafaka|moufaka)\\S*\\s*(?:el\\s*|il\\s*)?(?:bank|banque|masraf)",
    "bank\\s+(?:rah\\s+|ra7\\s+)?(?:ywafe2|ywafek|ywafi2|yuwafiq)",
    // Arabic.
    "موافقة\\s+(?:ال)?(?:بنك|مصرف)",
    "قبول\\s+(?:ال)?(?:بنك|مصرف)",
    "(?:ال)?(?:بنك|مصرف)\\s+(?:رح\\s+|راح\\s+|سوف\\s+)?(?:يوافق|بيوافق|يقبل|بيقبل|يرفض|بيرفض)",
    // Greek.
    "έγκριση\\S*\\s+(?:\\S+\\s+){0,2}τράπεζ",
    "τράπεζ\\S*\\s+(?:\\S+\\s+){0,2}(?:εγκρίν|έγκριση|δεχτ|απορρίψ)",
    "εγκριθεί\\s+(?:\\S+\\s+){0,2}τράπεζ",
    // Greeklish.
    "egkrisi\\S*\\s+(?:tis\\s+|apo\\s+tin\\s+)?trapez",
    "trapeza\\s+(?:tha\\s+)?(?:egkrin|dext|decht)"
  ].join("|"), "iu")],

  // --- named gateways -------------------------------------------------------
  [BANKING_TOPICS.STRIPE, new RegExp([
    bounded("stripe"),
    "سترايب", "ستريب", "ستررايب",
    "στράιπ", "στραϊπ", "στραιπ"
  ].join("|"), "iu")],

  [BANKING_TOPICS.PAYPAL, new RegExp([
    bounded("pay\\s?pal"),
    "باي\\s?بال", "بايبال",
    "πέι\\s?παλ", "πειπαλ", "πέιπαλ"
  ].join("|"), "iu")],

  [BANKING_TOPICS.AMAZON, new RegExp([
    bounded("amazon"),
    "أمازون", "امازون",
    "αμαζόν", "αμαζον"
  ].join("|"), "iu")],

  [BANKING_TOPICS.SHOPIFY, new RegExp([
    bounded("shopify"),
    "شوبيفاي", "شوبفاي",
    "σοπιφάι", "σοπιφαι"
  ].join("|"), "iu")],

  // --- payment gateway as a concept ----------------------------------------
  [BANKING_TOPICS.PAYMENT_GATEWAY, new RegExp([
    bounded("payment\\s+gateways?", "payments?\\s+gateway", "card\\s+gateway", "checkout\\s+gateway"),
    bounded("payment\\s+processors?", "payment\\s+processing"),
    // Arabizi.
    "bawab\\S*\\s*(?:el\\s*|il\\s*)?(?:daf3|dafe3|dafaa|dfe3|daf'|dafa)",
    // Arabic.
    "بوابة\\s+(?:ال)?دفع",
    "بوابات\\s+(?:ال)?دفع",
    "تشغيل\\s+(?:ال)?دفع\\s+(?:ال)?إلكتروني",
    // Greek.
    "πύλ\\S*\\s+πληρωμ",
    "επεξεργασία\\s+πληρωμ",
    // Greeklish.
    "(?:pyli|pili|pyles|piles)\\s+pliromon",
    "gateway\\s+pliromon"
  ].join("|"), "iu")],

  // --- merchant account -----------------------------------------------------
  [BANKING_TOPICS.MERCHANT_ACCOUNT, new RegExp([
    bounded("merchant\\s+accounts?", "merchant\\s+id", "merchant\\s+services?", "merchant\\s+onboarding"),
    // Arabizi.
    "(?:7esab|hesab|hisab)\\s+(?:el\\s*)?(?:tajer|tejer|tajir)",
    // Arabic.
    "حساب\\s+(?:ال)?تاجر",
    "حساب\\s+تجاري\\s+للدفع",
    // Greek.
    "λογαριασμ\\S*\\s+εμπόρου",
    "εμπορικ\\S*\\s+λογαριασμ",
    // Greeklish.
    "logariasmo\\s+emporou",
    "emporiko\\s+logariasmo"
  ].join("|"), "iu")],

  // --- payment service provider --------------------------------------------
  [BANKING_TOPICS.PSP, new RegExp([
    bounded("payment\\s+service\\s+providers?", "payment\\s+services\\s+provider"),
    // Arabic.
    "مزود\\S*\\s+(?:خدمة\\s+|خدمات\\s+)?(?:ال)?دفع",
    "مزودي\\s+خدمات\\s+(?:ال)?دفع",
    // Greek.
    "πάροχ\\S*\\s+(?:υπηρεσιών\\s+)?πληρωμ",
    // Greeklish.
    "paroch\\S*\\s+(?:ypiresion\\s+)?pliromon"
  ].join("|"), "iu")],
  // Case-sensitive acronym. `psp` lower-cased inside a longer token is exactly
  // the BLK-15 shape, and an all-caps acronym is how customers actually write it.
  [BANKING_TOPICS.PSP, new RegExp(bounded("PSPs?"), "u")],

  // --- acquiring ------------------------------------------------------------
  // Deliberately NOT a bare `acquiring`: "acquiring a competitor" is ordinary
  // business English and has nothing to do with card acquiring.
  [BANKING_TOPICS.ACQUIRING, new RegExp([
    bounded("acquiring\\s+(?:bank|banks|account|accounts|services?|partner|side)"),
    bounded("(?:card|merchant|payment)\\s+acquiring"),
    bounded("acquirers?"),
    // Arabic.
    "(?:ال)?بنك\\s+(?:ال)?مستحوذ",
    "جهة\\s+(?:ال)?استحواذ",
    "استحواذ\\s+(?:ال)?مدفوعات",
    // Greek.
    "αποδέκτ\\S*\\s+τράπεζ",
    "αποδέκτης\\s+πληρωμ",
    "εκκαθάριση\\s+συναλλαγ",
    // Greeklish.
    "apodekt\\S*\\s+(?:trapez|pliromon)"
  ].join("|"), "iu")],

  // --- IBAN opening ---------------------------------------------------------
  [BANKING_TOPICS.IBAN, new RegExp([
    bounded("ibans?"),
    "(?:ال)?آيبان",
    "(?:ال)?ايبان",
    bounded("ιβαν")
  ].join("|"), "iu")],

  // --- electronic money institution ----------------------------------------
  [BANKING_TOPICS.EMI, new RegExp([
    bounded("electronic\\s+money\\s+institutions?"),
    bounded("e[-\\s]?money\\s+(?:institutions?|accounts?|licence|license)"),
    // Arabic.
    "مؤسسة\\s+(?:ال)?(?:نقود|أموال|نقد)\\s+(?:ال)?إلكتروني",
    "مؤسسات\\s+(?:ال)?(?:نقود|أموال)\\s+(?:ال)?إلكتروني",
    // Greek.
    "ίδρυμα\\s+ηλεκτρονικού\\s+χρήματος",
    "ιδρύματα\\s+ηλεκτρονικού\\s+χρήματος",
    // Greeklish.
    "idryma\\s+ilektronikou\\s+chrimatos"
  ].join("|"), "iu")],
  // Case-sensitive acronym, same reason as PSP. `emi` lower-cased would match
  // inside ordinary tokens the moment anyone relaxes the boundary.
  [BANKING_TOPICS.EMI, new RegExp(bounded("EMIs?"), "u")]
];

const rules = foldRulePatterns(rawRules);

// Preserves the declaration order of BANKING_TOPICS so `topics` is stable and
// comparable between calls, rather than depending on where a term appeared.
const TOPIC_ORDER = Object.values(BANKING_TOPICS);

function detectBankingIntent(text) {
  const language = detectMessageLanguage(text);
  const value = normalizeSafetyText(text);
  if (!value) return { matched: false, topics: [], language };
  const found = new Set();
  for (const [topic, pattern] of rules) if (pattern.test(value)) found.add(topic);
  const topics = TOPIC_ORDER.filter((topic) => found.has(topic));
  return { matched: topics.length > 0, topics, language };
}

// ---------------------------------------------------------------------------
// The mandated reply shape (MB 2.3): honest -> value -> ONE question.
//
// Every string below is written to survive the repo's own output gates
// unchanged: `refalcoAnswer.containsProhibitedClaim` and
// `responsePolicy.validateResponse` at its default budget (500 chars,
// 5 sentences, 1 question). That rules out some otherwise natural wording:
//
//   * English must not contain the literal "bank approval", "permit",
//     "licence" or "visa" — they are blanket-blocked terms there.
//   * Arabic must not contain "موافقة البنك"; "الموافقة النهائية" is the
//     equivalent that states the same fact without tripping the gate.
//   * Greek must not contain "έγκριση τράπεζας", "άδεια" or "διαμονή", which
//     are matched as bare substrings with no boundary at all.
//
// No dash is used as a connector anywhere (Anti Regression Checklist 0.2), and
// no guarantee wording appears in any language.
// ---------------------------------------------------------------------------
const GUARD_REPLIES = Object.freeze({
  english: Object.freeze({
    honest: "The final decision belongs to the financial institution's own risk assessment and KYC and AML compliance requirements, so nobody can promise it on their behalf.",
    value: "What we shape is the file itself, clean and correct from day one: a clear business activity, a documented source of funds, the right corporate structure and realistic volumes. That measurably improves your odds and shortens the process.",
    question: "What is the nature of your business, and where are your customers based today?"
  }),
  arabic: Object.freeze({
    honest: "الموافقة النهائية بترجع لتقييم المخاطر ومتطلبات الامتثال (KYC/AML) عند الجهة المالية نفسها، وما حدا فينا بيقدر يوعدك بقرار جهة تانية.",
    value: "اللي منعمله إننا نبني لك ملف نظيف وصحيح من أول يوم: نشاط تجاري موصوف بوضوح، مصدر أموال موثّق، هيكل شركة سليم، وأرقام واقعية. هيك بتزيد فرصك فعلياً وبيقصر الوقت.",
    question: "شو طبيعة شغلك ومن وين عملاؤك حالياً؟"
  }),
  greek: Object.freeze({
    honest: "Η τελική απόφαση ανήκει στην αξιολόγηση κινδύνου και στις απαιτήσεις συμμόρφωσης KYC και AML του ίδιου του χρηματοπιστωτικού οργανισμού, οπότε κανείς δεν την υπόσχεται.",
    value: "Εμείς διαμορφώνουμε τον φάκελο, καθαρό και σωστό από την πρώτη μέρα: σαφής δραστηριότητα, τεκμηριωμένη προέλευση κεφαλαίων, σωστή εταιρική δομή, ρεαλιστικοί όγκοι. Αυτό βελτιώνει μετρήσιμα τις πιθανότητες και συντομεύει τη διαδικασία.",
    question: "Ποια είναι η φύση της δουλειάς σας και πού βρίσκονται οι πελάτες σας;"
  })
});

function bankingGuardReply(text, { language } = {}) {
  const detection = detectBankingIntent(text);
  if (!detection.matched) return null;
  const resolved = GUARD_REPLIES[language] ? language : (GUARD_REPLIES[detection.language] ? detection.language : "english");
  const parts = GUARD_REPLIES[resolved];
  return {
    reply: `${parts.honest} ${parts.value} ${parts.question}`,
    shape: { honest: parts.honest, value: parts.value, question: parts.question },
    language: resolved
  };
}

// ---------------------------------------------------------------------------
// MB's verbatim Stripe dialogue, the golden fixture for this phase.
//
// `arabic` is VERBATIM, copied character for character from
// `newplan/Master Brain & Operating Rules Manual - REFAL AI.txt` lines 78-79
// (reproduced in `docs/brain/SOURCE-ANALYSIS.md` lines 226-227).
//
// `english` and `greek` are NOT in any source document. They are faithful
// equivalents authored here, carrying the same four invariants the extraction
// names: warm acknowledgment of the real goal, honest refusal to promise,
// immediate pivot to the genuine value, one discovery question.
// ---------------------------------------------------------------------------
const STRIPE_GOLDEN_DIALOGUE = Object.freeze({
  arabic: Object.freeze({
    customer: "بدي أفتح شركة عشان أشغل Stripe، بتضمنوا لي فتح الحساب؟",
    reply: "آها 😄 هيك وصلنا للهدف الحقيقي بسرعة! بالنسبة لـ Stripe أو البنوك، الموافقة النهائية بتعتمد على تقييمهم لنشاطك وملفك وما حد بيقدر يوعدك بموافقة جهة ثانية. بس الفكرة إننا من البداية بنبني لك الشركة والملف بشكل واضح ومناسب لنشاطك، بدل ما تسجل وتكتشف مشاكل بالامتثال بعدين. شو طبيعة شغلك ومن وين عملاؤك حالياً؟"
  }),
  english: Object.freeze({
    customer: "I want to open a company so I can run Stripe. Can you guarantee the account will be opened for me?",
    // Equivalent, not a translation of record. See the note above.
    reply: "Ah, so we got to the real goal quickly. For Stripe or the banks, the final decision depends on how they assess your activity and your file, and nobody can promise you another institution's answer. What we do from day one is build your company and your file clearly and correctly for what you actually do, instead of registering first and finding compliance problems later. What is the nature of your business, and where are your customers based today?"
  }),
  greek: Object.freeze({
    customer: "Θέλω να ανοίξω εταιρεία για να χρησιμοποιώ το Stripe. Μπορείτε να μου εγγυηθείτε το άνοιγμα του λογαριασμού;",
    // Equivalent, not a translation of record. See the note above.
    reply: "Α, φτάσαμε γρήγορα στον πραγματικό στόχο. Για το Stripe ή τις τράπεζες, η τελική απόφαση εξαρτάται από τη δική τους αξιολόγηση του φακέλου σας, και κανείς δεν σας υπόσχεται την απόφαση άλλου οργανισμού. Εμείς από την πρώτη μέρα χτίζουμε την εταιρεία και τον φάκελό σας καθαρά και σωστά. Ποια είναι η φύση της δουλειάς σας και πού βρίσκονται οι πελάτες σας;"
  })
});

// ---------------------------------------------------------------------------
// Output gate: does this candidate answer promise an institution's decision?
//
// The hard requirement is that it must stay silent on the honest MB-F29
// sentence, which NAMES approval while refusing to promise it. So nothing here
// keys on a noun alone. Every rule needs an affirmative promise construction,
// and the Latin rules are written with explicit affirmative subjects ("we
// guarantee") rather than bare verbs, because "nobody can promise" and "I
// cannot guarantee" are the correct, compliant phrasings and must pass.
// ---------------------------------------------------------------------------
const rawHonestyViolations = [
  // Affirmative guarantee by us.
  new RegExp(`${bounded("we|i")}\\s+(?:can\\s+|will\\s+|do\\s+)?(?:guarantee|assure|promise)${R}`, "iu"),
  new RegExp(bounded("guaranteed\\s+(?:bank\\s+|stripe\\s+|merchant\\s+)?(?:approval|acceptance|account|opening|onboarding)"), "iu"),
  new RegExp(`${bounded("approval|acceptance|onboarding|the\\s+account")}\\s+is\\s+(?:guaranteed|certain|assured|sure|a\\s+formality)${R}`, "iu"),
  // Promised future decision.
  new RegExp(`${bounded("will|shall")}\\s+(?:definitely\\s+|certainly\\s+|surely\\s+|absolutely\\s+)?be\\s+(?:approved|accepted|opened|activated|onboarded)${R}`, "iu"),
  new RegExp(`${bounded("you")}\\s+will\\s+(?:definitely\\s+|certainly\\s+)?(?:get|receive|have)\\s+(?:the\\s+|your\\s+|an?\\s+)?(?:approval|acceptance|account)${R}`, "iu"),
  new RegExp(`${bounded("they|the\\s+bank|the\\s+banks|stripe|paypal|shopify|amazon")}\\s+will\\s+(?:definitely\\s+|certainly\\s+)?(?:approve|accept|onboard)${R}`, "iu"),
  // "No problem" as a promise about the institution's side.
  new RegExp(`${bounded("no\\s+problem|not\\s+a\\s+problem|no\\s+issue|no\\s+trouble")}[^.?!]{0,60}${bounded("account|accounts|stripe|paypal|shopify|amazon|gateway|approval|approving|opening|onboarding")}`, "iu"),
  new RegExp(`${bounded("account|accounts|stripe|paypal|shopify|amazon|gateway|approval|opening")}[^.?!]{0,60}${bounded("no\\s+problem|not\\s+a\\s+problem|no\\s+issue")}`, "iu"),

  // --- Arabic. Authored pointed, folded at load (BLK-16). ------------------
  // Affirmative guarantee verbs only. `ما منضمن` / `لا أضمن` are the compliant
  // negated forms and must NOT match, hence the negation lookbehind.
  /(?<!(?:ما|لا|مش|مو|ولا)\s{1,3})(?:بنضمن|منضمن|نضمنلك|نضمن لك|أضمنلك|بضمنلك|بوعدك|منوعدك|نوعدك)/u,
  // approval/acceptance + a certainty qualifier, up to three words apart.
  /(?:ال)?(?:موافقة|موافقه|قبول|القبول)(?:\s+\S+){0,3}\s*(?:ال)?(?:مؤكدة|مؤكد|مضمونة|مضمون|أكيدة|أكيد|محسومة|محسوم)/u,
  /(?:مؤكدة|مضمونة|أكيدة)\s+(?:ال)?(?:موافقة|القبول)/u,
  // "the account will definitely open" / "they will definitely approve".
  /(?:رح|راح|سوف|سي|ح)\s*(?:ينفتح|يفتحوا|يوافقوا|يقبلوا|تنفتح)[^.؟!]{0,30}(?:أكيد|مئة بالمئة|بالتأكيد)/u,
  /(?:أكيد|بالتأكيد|مئة بالمئة)[^.؟!]{0,30}(?:رح|راح|سوف)\s*(?:ينفتح|يفتحوا|يوافقوا|يقبلوا|تنفتح)/u,
  // "no problem" about the account or the gateway.
  /ما\s+في\s+(?:أي\s+)?مشكلة[^.؟!]{0,60}(?:الحساب|حساب|بوابة|البوابة|الموافقة|سترايب|Stripe)/iu,

  // --- Greek ---------------------------------------------------------------
  /(?:εγγυόμαστε|εγγυώμαι|σας\s+εγγυόμαστε|υποσχόμαστε|σας\s+υποσχόμαστε)/iu,
  /(?:έγκριση|αποδοχή|άνοιγμα)[^.;!]{0,45}(?:είναι\s+)?(?:βέβαιη|βέβαιο|σίγουρη|σίγουρο|εγγυημένη|εγγυημένο|δεδομένη|δεδομένο)/iu,
  /(?:βέβαιη|σίγουρη|εγγυημένη)\s+(?:η\s+)?(?:έγκριση|αποδοχή)/iu,
  /θα\s+(?:σίγουρα\s+)?(?:εγκριθεί|γίνει\s+δεκτ|ανοίξει)[^.;!]{0,30}(?:σίγουρα|εγγυημένα|οπωσδήποτε)/iu,
  /δεν\s+υπάρχει\s+(?:κανένα\s+)?πρόβλημα[^.;!]{0,60}(?:λογαριασμ|πύλη|έγκριση|Stripe)/iu
];

const honestyViolations = foldRulePatterns(rawHonestyViolations.map((pattern, index) => [index, pattern]))
  .map(([, pattern]) => pattern);

function violatesBankingHonesty(text) {
  const raw = String(text || "");
  if (!raw.trim()) return false;
  // Folded for the Arabic rules, raw-normalised for the rest. Testing both is
  // cheap and means a pointed/bare spelling can never change the verdict.
  const folded = foldArabicLetters(raw.normalize("NFKC").replace(/[ً-ٰٟـ]/gu, "").replace(/\s+/gu, " ").trim());
  return honestyViolations.some((pattern) => pattern.test(folded));
}

module.exports = { detectBankingIntent, bankingGuardReply, violatesBankingHonesty, BANKING_TOPICS, STRIPE_GOLDEN_DIALOGUE };
