// GENERATED FILE — do not edit by hand.
// Source: src/reservationPolicy.js
// Generator: scripts/generateEdgeMirrors.js  (npm run edge:mirrors)
//
// The edge function is Deno and cannot require() CommonJS, so it imports this
// verbatim ESM extract instead of keeping its own copy. Hand-maintained copies
// of these exact checks drifted into fail-opens; src/mirrorParity.test.js now
// runs both implementations over a shared corpus and fails on any divergence.

import { detectMessageLanguage, foldArabicLetters, foldRulePatterns } from "./language.mjs";

// P2.4 — Reservation deposit, ROI and property VAT guards.
//
// Three MB rules live in one module because they are one phase and they share
// the same trilingual matching machinery:
//
//   W2.4.1  MB-F50  Reservation deposit (ABSOLUTE). A currency amount in an
//                   answer that also mentions reservation/deposit must come
//                   from the live `refal_reservation_rules` table, never a
//                   knowledge chunk and never the model.
//   W2.4.2  MB-F55  No yield percentage, no future price prediction. MB's
//                   reply script is the canonical response, trilingual.
//   W2.4.3  MB-F45/MB-F48  19% and 5% are stateable programme facts. WHICH
//                   rate applies to this customer is not REFAL's to decide.
//
// ---------------------------------------------------------------------------
// Two matching traps this repo has already paid for. Do not reintroduce them.
//
// 1. BLK-16, fail-open by orthography. Arabic writes the same word several
//    interchangeable ways (`وديعة` / `وديعه`, bare vs hamza alef). Every rule
//    below is built through `foldRulePatterns`, and every incoming text through
//    `normalizeReservationText`, so BOTH sides of a match are folded. Folding
//    only one side is a fail-open, not a missed match.
//
// 2. `\b` is ASCII-only in JavaScript. It never fires next to an Arabic or
//    Greek letter, and it never fires after `%` or `٪` because those are not
//    word characters, so `/100\s*%\b/` can never match. See the comments at
//    src/refalcoAnswer.js:51-57 and :160-166. Latin terms here use the Unicode
//    lookaround pair `(?<![\p{L}\p{N}])` / `(?![\p{L}\p{N}])` instead, which is
//    also what keeps BLK-15 closed: an unanchored substring made `vat` match
//    inside `private`, `renovation` and `activate`.
// ---------------------------------------------------------------------------

// Any digit script a customer or a chunk may use. Arabic-Indic (U+0660..) and
// extended Arabic-Indic (U+06F0..) are NFKC-stable, so they survive
// normalization as themselves and must be listed explicitly.
const DIGIT = "[\\d\\u0660-\\u0669\\u06F0-\\u06F9]";
// Grouping and decimal marks, including the Arabic thousands (U+066C) and
// decimal (U+066B) separators, so `5,000`, `5.000` and `٥٬٠٠٠` all read as one
// number rather than as two.
const SEPARATOR = "[.,\\u066B\\u066C\\u00A0\\u202F\\u2009]";
const NUMBER = `${DIGIT}(?:${DIGIT}|${SEPARATOR})*`;
const NOT_WORD_BEFORE = "(?<![\\p{L}\\p{N}])";
const NOT_WORD_AFTER = "(?![\\p{L}\\p{N}])";

const CURRENCY_SYMBOL = "[€$£]";
const CURRENCY_CODE = "(?:EUR|USD|GBP)";
const CURRENCY_WORD = "(?:euros?|dollars?|pounds?|sterling)";
// No lookaround on the Arabic and Greek currency words: `\b` is unreachable
// beside them, and Arabic attaches its article and conjunctions directly.
const ARABIC_CURRENCY = "(?:يورو|اليورو|دولار|الدولار|جنيه|الجنيه)";
const GREEK_CURRENCY = "(?:ευρώ|ευρω|δολάρια|λίρες)";

const CURRENCY_AMOUNT = [
  `${CURRENCY_SYMBOL}\\s*${DIGIT}`,
  `${NUMBER}\\s*${CURRENCY_SYMBOL}`,
  `${NOT_WORD_BEFORE}${CURRENCY_CODE}\\s*${DIGIT}`,
  `${NUMBER}\\s*${CURRENCY_CODE}${NOT_WORD_AFTER}`,
  `${NUMBER}\\s*${CURRENCY_WORD}${NOT_WORD_AFTER}`,
  `${NUMBER}\\s*${ARABIC_CURRENCY}`,
  `${ARABIC_CURRENCY}\\s*${NUMBER}`,
  `${NUMBER}\\s*${GREEK_CURRENCY}`,
  // `5,000`, `5.000`, `٥٬٠٠٠`: a grouped number is an amount even with the
  // currency left implicit.
  `${NOT_WORD_BEFORE}${DIGIT}{1,3}(?:[.,\\u066C]${DIGIT}{3})+${NOT_WORD_AFTER}`,
  // Default-deny. MB-F50 is absolute, so a bare standalone 3+ digit figure
  // inside a sentence that already talks about a reservation deposit counts as
  // an amount. Over-blocking a reference number is the cheap side of this rule.
  `${NOT_WORD_BEFORE}${DIGIT}{3,}${NOT_WORD_AFTER}`
].join("|");

// MB-F50 is about a PROPERTY reservation deposit. "Name reservation" is a
// company-formation step and carries no deposit at all, so excluding it is a
// correction, not a weakening.
//
// It cost two real test failures when `violatesReservationDepositRule` was wired
// into the live gate for P2.6: "The €999 package includes document preparation,
// name reservation, and application follow-up" tripped MB-F50 because a currency
// amount sat near the word "reservation". Same for the Arabic `حجز الاسم` and
// the Greek `κράτηση ονόματος`, which are the standard phrasings for exactly
// that formation step.
const NAME_RESERVATION = "(?:(?:company\\s+|business\\s+|trade\\s+)?name\\s+reservations?|reservations?\\s+of\\s+(?:the\\s+)?(?:company\\s+|business\\s+|trade\\s+)?name|حجز\\s*(?:ال)?اسم|κράτησ\\p{L}*\\s+(?:του\\s+)?ονόματ\\p{L}*)";
const DEPOSIT_MENTION = [
  // The "name reservation" exclusion needs a LOOKBEHIND, not a lookahead: the
  // qualifier sits before the noun. A lookahead at this position only sees
  // "reservation, and application follow-up" and happily matches.
  `${NOT_WORD_BEFORE}(?:(?<!\\bname\\s)(?<!\\bnames\\s)reservations?(?!\\s+of\\s+(?:the\\s+)?(?:company\\s+|business\\s+|trade\\s+)?names?\\b)|deposits?|holding fee|holding deposit|booking fee|reservation fee)${NOT_WORD_AFTER}`,
  "(?:عربون|العربون|وديعة|الوديعة|ودائع)",
  `(?:دفعة|مبلغ|رسوم|مقدم)\\s*(?:ال)?حجز(?!\\s*(?:ال)?اسم)`,
  `(?<![\\p{L}])(?:προκαταβολ|κράτησ(?!\\p{L}*\\s+(?:του\\s+)?ονόματ)|κρατησ)`
].join("|");

// --- W2.4.2 ROI vocabulary ------------------------------------------------
// A standalone return/yield term is an ROI claim on its own. `return` on its
// own is NOT, because "I will return your call" is ordinary service language;
// it only counts when it is qualified or attached to an investment.
const RETURN_TERM = [
  `${NOT_WORD_BEFORE}(?:roi|irr|yields?|cap rate|capital growth rate)${NOT_WORD_AFTER}`,
  `${NOT_WORD_BEFORE}returns? on investment${NOT_WORD_AFTER}`,
  `${NOT_WORD_BEFORE}(?:expected|annual|yearly|guaranteed|rental|net|gross|investment)\\s+returns?${NOT_WORD_AFTER}`,
  `${NOT_WORD_BEFORE}returns?\\s+(?:on|from)\\s+(?:an?\\s+|your\\s+|the\\s+)?(?:investment|property|rental|purchase)`,
  "(?:عائد|العائد|عوائد|العوائد|عائدات|مردود|المردود)",
  "(?<![\\p{L}])(?:απόδοσ|αποδόσ|αποδοσ)"
].join("|");

const PERCENTAGE = [
  `${NUMBER}\\s*(?:%|٪|percent|per cent)`,
  `(?:%|٪)\\s*${NUMBER}`,
  `${NUMBER}\\s*(?:بالمئة|بالمائة|بالميه|في المئة|في المائة)`,
  `${NUMBER}\\s*τοις εκατό`
].join("|");

// A percentage only becomes an ROI claim near a profit or growth word. Keeping
// this narrow is deliberate: 19% property VAT and 15% corporate tax are
// stateable programme facts (MB-F48, MB-F19) and must not be swept up here.
const PROFIT_OR_GROWTH = [
  // `returns?` added 2026-10-09: "you can expect 8% returns" carried a
  // percentage next to the plural noun but matched no `returnTerm` alternative,
  // because those all require an adjacent qualifier (expected/annual/rental/…).
  // Surfaced when the refusal carve-out in src/outputGuards.js stripped the
  // negated half of "I cannot promise a yield, but you can expect 8% returns"
  // and nothing caught what was left.
  `${NOT_WORD_BEFORE}(?:profits?|profitability|appreciation|appreciate|capital growth|rental income|cash flow|returns?)${NOT_WORD_AFTER}`,
  "(?:ربح|الربح|أرباح|الأرباح|ربحية|نمو رأسمالي|دخل إيجاري)",
  "(?<![\\p{L}])(?:κέρδ|ανατίμησ|υπεραξί)"
].join("|");

// A future price prediction is a price/value/market subject sitting next to an
// explicit future rise. Verb-anchored on purpose: "nobody can guarantee a
// future property price" is a refusal, not a prediction, and must survive.
const PRICE_SUBJECT = [
  `${NOT_WORD_BEFORE}(?:prices?|values?|property market|real estate market|the market|capital value)${NOT_WORD_AFTER}`,
  "(?:سعر|السعر|أسعار|الأسعار|قيمة العقار|السوق|سوق العقارات)",
  "(?<![\\p{L}])(?:τιμή|τιμές|τιμες|αξία|αγορά)"
].join("|");

const FUTURE_RISE = [
  `${NOT_WORD_BEFORE}(?:will|'ll|is going to|are going to|is set to|are set to|is expected to|are expected to|expected to|bound to|sure to)\\s+(?:keep\\s+|continue\\s+to\\s+|only\\s+)?(?:rise|rising|increase|increasing|go up|going up|climb|climbing|double|appreciate|appreciating|grow|growing|jump)${NOT_WORD_AFTER}`,
  `${NOT_WORD_BEFORE}(?:keep|continue)\\s+(?:to\\s+)?(?:rise|rising|increase|increasing|going up|climbing|appreciating)${NOT_WORD_AFTER}`,
  "(?:رح|راح|سوف|حـ)\\s*(?:ترتفع|يرتفع|تزيد|يزيد|تصعد|يصعد|تتضاعف|يتضاعف|تعلى|تطلع)",
  "(?:بترتفع|بيرتفع|سترتفع|سيرتفع|ستزيد|سيزيد|ستتضاعف|سيتضاعف|رح تعلى)",
  "(?<![\\p{L}])θα\\s+(?:ανέβ|ανεβ|αυξηθ|αυξάνο|αυξανο|διπλασιαστ|εκτοξευθ)",
  "(?<![\\p{L}])(?:αναμένεται|προβλέπεται)\\s+να\\s+(?:ανέβ|ανεβ|αυξηθ)"
].join("|");

const FUTURE_PRICE_PREDICTION = [
  `(?:${PRICE_SUBJECT})[^.!?؟]{0,60}?(?:${FUTURE_RISE})`,
  `(?:${FUTURE_RISE})[^.!?؟]{0,60}?(?:${PRICE_SUBJECT})`
].join("|");

// --- W2.4.3 VAT vocabulary ------------------------------------------------
// BLK-15 again: `vat` is lookaround-anchored so it cannot match inside
// `private`, `innovative`, `renovation` or `activate`.
const VAT_TERM = [
  `${NOT_WORD_BEFORE}vat${NOT_WORD_AFTER}`,
  `${NOT_WORD_BEFORE}value[- ]added tax${NOT_WORD_AFTER}`,
  "(?:ضريبة القيمة المضافة|القيمة المضافة|ضريبة القيمه المضافه)",
  "(?<![\\p{L}])(?:φπα|φ\\.π\\.α|φόρος προστιθέμενης αξίας|φόρου προστιθέμενης αξίας)"
].join("|");

const VAT_RATE = [
  `${NOT_WORD_BEFORE}(?:19|5|١٩|٥|۱۹|۵)\\s*(?:%|٪|percent|per cent|بالمئة|بالمائة|τοις εκατό)`
].join("|");

// "the reduced 5% rate" names the property VAT rate without saying "VAT". MB
// treats that idiom as a VAT statement, so the guard must too.
const VAT_RATE_IDIOM = [
  `${NOT_WORD_BEFORE}(?:reduced|standard|base|basic|full)\\s+(?:vat\\s+)?(?:rate\\s+of\\s+)?(?:19|5)\\s*(?:%|percent)`,
  `${NOT_WORD_BEFORE}(?:19|5)\\s*(?:%|percent)\\s*(?:vat\\s+)?rate${NOT_WORD_AFTER}`,
  "(?:النسبة|نسبة)\\s*(?:المخفضة|الأساسية|الاساسية)",
  `(?:النسبة|نسبة)\\s*(?:${DIGIT}{1,2})\\s*(?:%|٪)`,
  // `\\w` is ASCII-only, so a Greek inflection suffix needs \\p{L}, not \\w.
  "(?<![\\p{L}])(?:μειωμέν|βασικ)\\p{L}*\\s+συντελεστ"
].join("|");

// Personalized conclusions. "Which rate applies to YOU" is a decision for the
// team that calculates it (MB-F49), never for REFAL.
const PERSONALIZED_RATE = [
  `${NOT_WORD_BEFORE}you(?:'ll)?\\s+(?:will\\s+|would\\s+|can\\s+|could\\s+|do\\s+|are\\s+|only\\s+)*(?:pay|get|be charged|qualify|be eligible|be entitled|be exempt)`,
  `${NOT_WORD_BEFORE}you\\s+(?:qualify|are eligible|are entitled|are exempt)${NOT_WORD_AFTER}`,
  `${NOT_WORD_BEFORE}your\\s+(?:vat\\s+)?(?:rate|case|purchase qualifies)`,
  `${NOT_WORD_BEFORE}in your case${NOT_WORD_AFTER}`,
  `${NOT_WORD_BEFORE}(?:the\\s+)?rate\\s+(?:that\\s+)?applies\\s+to\\s+you${NOT_WORD_AFTER}`,
  `${NOT_WORD_BEFORE}applies\\s+to\\s+(?:you|your)${NOT_WORD_AFTER}`,
  "(?:ستدفع|سوف تدفع|رح تدفع|راح تدفع|بتدفع|بتدفعي)",
  "(?:حالتك|بحالتك|في حالتك|نسبتك|عليك ينطبق|ينطبق عليك|بتنطبق عليك|تنطبق عليك|أنت مؤهل|انت مؤهل|بتستحق)",
  "(?<![\\p{L}])(?:θα πληρώσετε|θα πληρώσεις|στην περίπτωσή σας|στην περιπτωσή σας|ισχύει για εσάς|ισχύει για σας|δικαιούστε|είστε επιλέξιμ|ο συντελεστής σας)"
].join("|");

// Conditional phrasing is what keeps a 5% statement a programme fact instead of
// a personal conclusion (MB-F45, candidate MBC-015).
const CONDITIONAL_RATE = [
  `${NOT_WORD_BEFORE}(?:can apply|may apply|applies only|is available|subject to|under (?:certain|specific|the current) conditions|where the conditions|if the conditions)`,
  "(?:يمكن أن (?:تنطبق|ينطبق)|قد (?:تنطبق|ينطبق)|بشروط|حسب الشروط|وفق الشروط|ضمن شروط|تحت شروط)",
  "(?<![\\p{L}])(?:μπορεί να ισχύει|υπό (?:προϋποθέσεις|τις ισχύουσες προϋποθέσεις|όρους)|με προϋποθέσεις|εφόσον πληρούνται)"
].join("|");

// Authored in pointed Arabic for readability, folded once at module load so the
// patterns match the folded text (BLK-16).
const PATTERNS = Object.fromEntries(foldRulePatterns([
  ["currencyAmount", new RegExp(CURRENCY_AMOUNT, "iu")],
  ["depositMention", new RegExp(DEPOSIT_MENTION, "iu")],
  ["returnTerm", new RegExp(RETURN_TERM, "iu")],
  ["percentage", new RegExp(PERCENTAGE, "iu")],
  ["profitPercentage", new RegExp(`(?:${PERCENTAGE})[^.!?؟]{0,60}?(?:${PROFIT_OR_GROWTH})|(?:${PROFIT_OR_GROWTH})[^.!?؟]{0,60}?(?:${PERCENTAGE})`, "iu")],
  ["futurePricePrediction", new RegExp(FUTURE_PRICE_PREDICTION, "iu")],
  ["vatTerm", new RegExp(VAT_TERM, "iu")],
  ["vatRate", new RegExp(VAT_RATE, "iu")],
  ["vatRateIdiom", new RegExp(VAT_RATE_IDIOM, "iu")],
  ["personalizedRate", new RegExp(PERSONALIZED_RATE, "iu")],
  ["conditionalRate", new RegExp(CONDITIONAL_RATE, "iu")],
  // An explicit "this still has to be checked" hedge, trilingual. Only ever
  // widens what is allowed, and only for the personalized-rate verdict: a
  // guarantee or an ROI claim is not rescued by appending "needs confirmation".
  ["needsConfirmation", new RegExp("(?:needs?|requires?|subject)\\s+(?:to\\s+)?(?:be\\s+)?(?:confirm\\w*|verif\\w*|check\\w*|review\\w*)|to\\s+be\\s+(?:confirmed|verified|checked)|(?:cannot|can't|do(?:es)? not|don't)\\s+confirm|بحاجة\\s+(?:إلى|الى)\\s+(?:تأكيد|التأكيد|تحقق|التحقق|مراجعة)|يحتاج\\s+(?:إلى\\s+)?(?:تأكيد|تحقق|مراجعة)|بدها\\s+(?:تأكيد|تحقق)|بدّها\\s+(?:تأكيد|تحقق)|لازم\\s+(?:يتأكد|نتأكد|تتأكد)|χρειάζ\\p{L}*\\s+(?:επιβεβαίωσ\\p{L}*|έλεγχο|επαλήθευσ\\p{L}*)|πρέπει\\s+να\\s+(?:επιβεβαιωθ\\p{L}*|ελεγχθ\\p{L}*)", "iu")],
  // P2.6 regression fix. A TAX rate expressed on profits is a programme fact,
  // not a yield claim. MBC-002 / MB-F20 is the exact case: "The IP Box regime
  // can bring the effective rate to around 2.5% to 3% on qualifying profits
  // from intellectual property assets." `profitPercentage` sees a percentage
  // within 60 characters of "profits" and fires, so wiring `containsRoiClaim`
  // into the live output gate deleted an approved MB fact in all three
  // languages. Measured by scripts/auditClaimGates.js, which flipped MBC-002
  // from PASS to BLOCK the moment the gate went live.
  ["taxRateContext", new RegExp("(?:ip\\s*box|effective\\s+(?:tax\\s+)?rate|corporate\\s+tax|income\\s+tax|tax\\s+rate|withholding\\s+tax|(?<![\\p{L}\\p{N}])vat(?![\\p{L}\\p{N}])|ضريب|معدل\\s+فعلي|المعدل\\s+الفعلي|φορολογ|φόρο|ΦΠΑ|πραγματικ\\p{L}*\\s+συντελεστ\\p{L}*)", "iu")]
]));

function normalizeReservationText(text) {
  return foldArabicLetters(
    String(text || "").normalize("NFKC").replace(/[ً-ٰٟـ]/gu, "").replace(/\s+/gu, " ").trim()
  );
}

// ---------------------------------------------------------------------------
// W2.4.1 — Reservation deposit (MB-F50, ABSOLUTE)
// ---------------------------------------------------------------------------

// The ONLY provenance that may carry a reservation deposit figure.
//
// `refal_reservation_rules` does not exist yet. M4 builds it (blocker BLK-12),
// and BOSS runs the migration; this repo has no Supabase access and writes no
// DDL here. The guard and the `source` contract ship now and DEFAULT DENY, so
// the day the table lands the only change is a caller passing this string.
const LIVE_RESERVATION_SOURCE = "refal_reservation_rules";

function violatesReservationDepositRule(text, { source = null } = {}) {
  const value = normalizeReservationText(text);
  if (!value) return false;
  // Both halves are required. A deposit mentioned with no figure is a correct
  // answer, and a figure with no deposit mention belongs to the pricing and
  // grounding guards, not to this one.
  if (!PATTERNS.depositMention.test(value)) return false;
  if (!PATTERNS.currencyAmount.test(value)) return false;
  return source !== LIVE_RESERVATION_SOURCE;
}

const RESERVATION_DEPOSIT_REPLY = Object.freeze({
  english: "Reservation deposit terms and the amount are set per project and per property, so I will not quote a figure from memory. I can pull the exact terms for the property you have in mind, which property is it?",
  arabic: "شروط عربون الحجز وقيمته بتختلف من مشروع لمشروع ومن عقار لعقار، وما رح أعطيك رقم من عندي. فيني جيبلك الشروط المضبوطة للعقار اللي ببالك، أي عقار بالضبط؟",
  greek: "Οι όροι και το ποσό της προκαταβολής κράτησης καθορίζονται ανά έργο και ανά ακίνητο, οπότε δεν θα πω νούμερο από μνήμης. Μπορώ να βρω τους ακριβείς όρους για το ακίνητο που σας ενδιαφέρει, ποιο ακίνητο είναι;"
});

function reservationDepositGuard(text, { source = null, language } = {}) {
  if (!violatesReservationDepositRule(text, { source })) return null;
  const lang = RESERVATION_DEPOSIT_REPLY[language] ? language : detectMessageLanguage(text);
  return {
    violation: true,
    reason: "reservation_deposit_amount_not_from_refal_reservation_rules",
    safeReply: RESERVATION_DEPOSIT_REPLY[lang] || RESERVATION_DEPOSIT_REPLY.english
  };
}

// ---------------------------------------------------------------------------
// W2.4.2 — ROI (MB-F55)
// ---------------------------------------------------------------------------

function containsRoiClaim(text) {
  const value = normalizeReservationText(text);
  if (!value) return false;
  // An explicit return term (roi, irr, yield, عائد, απόδοση) is an ROI claim
  // whatever the surrounding topic, so it is tested before the tax carve-out.
  if (PATTERNS.returnTerm.test(value)) return true;
  // In a TAX-rate context a percentage sitting near "profits" is a rate, not a
  // yield. Without this, MB-F20's IP Box fact was deleted as an ROI claim once
  // this function was wired into the live gate. The carve-out narrows only the
  // inferred `profitPercentage` signal; an explicit return term above and a
  // future price prediction below both still fire inside a tax sentence.
  if (!PATTERNS.taxRateContext.test(value) && PATTERNS.profitPercentage.test(value)) return true;
  // A historical, evidence-backed rise phrased as the future is still a
  // prediction. Blocking is the safe side of MB-F55.
  return PATTERNS.futurePricePrediction.test(value);
}

// MB's reply script. The Arabic is VERBATIM from
// `newplan/Master Brain & Operating Rules Manual - REFAL AI.txt:114`
// (section "التعامل مع أسئلة العائد (ROI) وارتفاع الأسعار"), reproduced
// character for character including the emoji. The source manual is Arabic
// only, so the English and Greek entries are native renderings of the SAME five
// invariants, not translations of a published English script (MB-F55): refuse
// the number honestly and charmingly, explain what it actually depends on, ask
// for budget and area so the figure comes from real numbers, state plainly that
// nobody can guarantee a future property price, and redirect to the intelligent
// criterion of strong fundamentals in an in-demand location.
//
// Each entry holds at most one question (the One Question Rule, src/goldenFormula.js)
// and uses commas and periods only, never a dash as a connector.
const ROI_REPLY = Object.freeze({
  english: "It depends on the project, the price, the expected rent and the running costs. I would rather not throw a flattering percentage at you just to sound good. Give me your budget and the area, and we will shortlist options and work it out on real numbers. At the same time, nobody can guarantee a future property price, so the smarter move is a property with strong fundamentals in a location people actually want.",
  arabic: "بيعتمد على المشروع والسعر والإيجار المتوقع والتكاليف. ما بحب أرمي عليك نسبة حلوة بس عشان تعجبك 😄 أعطيني ميزانيتك والمنطقة وبنطلع خيارات ونحسبها على أرقام فعلية. وبنفس الوقت ما حد بيقدر يضمن سعر العقار بالمستقبل، الأذكى نختار عقار أساسه قوي وموقعه مطلوب.",
  greek: "Εξαρτάται από το έργο, την τιμή, το αναμενόμενο ενοίκιο και τα έξοδα. Δεν θέλω να σας πετάξω ένα ωραίο ποσοστό απλώς για να ακουστεί καλό. Δώστε μου τον προϋπολογισμό σας και την περιοχή, και θα βρούμε επιλογές και θα τα υπολογίσουμε σε πραγματικά νούμερα. Παράλληλα, κανείς δεν μπορεί να εγγυηθεί την τιμή ενός ακινήτου στο μέλλον, οπότε το πιο έξυπνο είναι ένα ακίνητο με γερά θεμέλια σε περιοχή με πραγματική ζήτηση."
});

function roiCanonicalReply(language) {
  return ROI_REPLY[language] || ROI_REPLY.english;
}

// ---------------------------------------------------------------------------
// W2.4.3 — Property VAT (MB-F45, MB-F48, MB-F49)
// ---------------------------------------------------------------------------

/**
 * 19% and 5% are stateable programme facts. Deciding which one applies to this
 * customer is not REFAL's call, so a personalized rate conclusion blocks even
 * though the underlying numbers are perfectly quotable.
 *
 * `language` is accepted for call-site symmetry with the other two guards. It
 * is not needed for the classification itself: every pattern above carries its
 * English, Arabic and Greek alternatives, so the verdict is language agnostic.
 */
function classifyVatStatement(text, { language } = {}) {
  const value = normalizeReservationText(text);
  const reasons = [];
  if (!value) return { mentionsVat: false, statesRate: false, personalizedRateConclusion: false, allowed: true, reasons: ["no_vat_statement"] };

  const rateIdiom = PATTERNS.vatRateIdiom.test(value);
  const mentionsVat = PATTERNS.vatTerm.test(value) || rateIdiom;
  const statesRate = PATTERNS.vatRate.test(value) || rateIdiom;
  // A sentence that says the rate still NEEDS CHECKING is the opposite of a
  // personalized conclusion. "وانطباق الرسوم أو الباقة على حالتك بحاجة إلى تأكيد"
  // ("whether the fee or package applies to your case needs confirmation") is
  // REFAL doing exactly what MB-F45 asks, and it was being blocked for the word
  // "حالتك". Surfaced when this guard went live for P2.6: it deleted the Arabic
  // conversation recap, which is a customer-facing summary, not a verdict.
  const hedged = PATTERNS.needsConfirmation.test(value);
  const personalizedRateConclusion = (mentionsVat || statesRate) && !hedged && PATTERNS.personalizedRate.test(value);

  if (personalizedRateConclusion) reasons.push("personalized_vat_rate_conclusion");
  else if (statesRate) reasons.push("vat_rate_is_a_stateable_programme_fact");
  if (!mentionsVat && !statesRate) reasons.push("no_vat_statement");
  if (!personalizedRateConclusion && statesRate && PATTERNS.conditionalRate.test(value)) reasons.push("rate_stated_conditionally");

  return {
    mentionsVat,
    statesRate,
    personalizedRateConclusion,
    allowed: !personalizedRateConclusion,
    reasons
  };
}

export { LIVE_RESERVATION_SOURCE, RESERVATION_DEPOSIT_REPLY, violatesReservationDepositRule, reservationDepositGuard, containsRoiClaim, roiCanonicalReply, ROI_REPLY, classifyVatStatement };
