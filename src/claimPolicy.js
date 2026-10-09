"use strict";

// P2.1 — Claim classification taxonomy (REFAL brain master plan, waves W2.1.1-W2.1.4).
//
// This module answers one question per sentence: "may REFAL say this?".
//
//   GUARANTEE                > always blocked, in every language
//   PERSONALIZED_CONCLUSION  > always blocked, in every language
//   PROGRAM_FACT             > allowed ONLY when approved, unexpired evidence carries it
//   NEUTRAL                  > allowed; the other gates handle it
//
// Precedence is strict and runs in that order, so a guarantee dressed up as a
// programme fact ("we guarantee the 300,000 euro route") is still a guarantee,
// and no amount of evidence rescues it.
//
// TWO TRAPS THIS FILE DELIBERATELY AVOIDS
//
// 1. BLK-16, Arabic letter folding. `الإقامة` and `الاقامة` are the same word to
//    a phone keyboard and different strings to a regex. Every rule source here is
//    pushed through `foldRulePatterns`, and every incoming string through
//    `foldArabicLetters`, exactly as `src/safetyPolicy.js` does. Folding only one
//    side would break the pointed Arabic literals; folding neither is a fail-open
//    in a safety classifier.
//
// 2. `\b` is ASCII-only in JavaScript. It can never match next to an Arabic or a
//    Greek letter, and it can never match after `%` (the percent sign is not a
//    word character). `src/refalcoAnswer.js:51-57` and `:160-166` record the two
//    times this repo was bitten. Non-ASCII rules below use explicit
//    `(?<![\p{L}\p{N}])` / `(?![\p{L}\p{N}])` guards or no boundary at all.
//
// Rule sets are evaluated for ALL THREE languages regardless of the detected
// language of the sentence. Code-switched output ("حسابك Stripe is guaranteed")
// is normal here, and running only the detected language's rules would be a
// fail-open. The resolved `language` is reported, never used to skip a rule.

const { detectMessageLanguage, foldArabicLetters, foldRulePatterns } = require("./language");

const CLAIM_CLASSES = Object.freeze({
  PROGRAM_FACT: "PROGRAM_FACT",
  PERSONALIZED_CONCLUSION: "PERSONALIZED_CONCLUSION",
  GUARANTEE: "GUARANTEE",
  NEUTRAL: "NEUTRAL"
});

const LANGUAGE_ALIASES = Object.freeze({
  en: "english", eng: "english", english: "english",
  ar: "arabic", ara: "arabic", arabic: "arabic",
  el: "greek", gr: "greek", ell: "greek", greek: "greek"
});

// --------------------------------------------------------------- normalization

// Same discipline as `normalizeSafetyText`: NFKC, strip Arabic diacritics and
// tatweel, collapse whitespace, then fold Arabic letters. Case is NOT folded
// here; every rule carries /i.
function normalizeClaimText(text) {
  return foldArabicLetters(
    String(text === null || text === undefined ? "" : text)
      .normalize("NFKC")
      .replace(/[ً-ٰٟـ]/gu, "")
      .replace(/\s+/gu, " ")
      .trim()
  );
}

// -------------------------------------------------------------------- numbers

// Arabic-Indic (U+0660-0669) and Extended Arabic-Indic (U+06F0-06F9) digits are
// NOT folded to ASCII by NFKC, so "٣٠٠٬٠٠٠" and "300,000" would otherwise be
// two different facts.
function toAsciiDigits(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/[٠-٩]/gu, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/gu, (digit) => String(digit.charCodeAt(0) - 0x06F0));
}

// U+066B Arabic decimal separator, U+066C Arabic thousands separator.
const GROUPING_SEPARATORS = "[.,\\u066B\\u066C]";
const SPACE_SEPARATORS = "[\\u00A0\\u202F ]";

// Two alternatives, in order: space-grouped ("300 000"), then
// separator-grouped or decimal ("300,000", "300.000", "2.5", "2,5", "15").
// The leading `(?<![\p{L}\p{N}])` keeps us out of the middle of a token such as
// "B2B" or "HE382352". There is deliberately NO trailing boundary, so "17th"
// still yields 17.
const NUMBER_TOKEN = new RegExp(
  `(?<![\\p{L}\\p{N}])\\d{1,3}(?:${SPACE_SEPARATORS}\\d{3})+|(?<![\\p{L}\\p{N}])\\d+(?:${GROUPING_SEPARATORS}\\d+)*`,
  "gu"
);

const SEPARATOR_SPLIT = new RegExp(GROUPING_SEPARATORS, "u");
const SPACE_STRIP = new RegExp(SPACE_SEPARATORS, "gu");

function stripLeadingZeros(digits) {
  const trimmed = String(digits).replace(/^0+(?=\d)/u, "");
  return trimmed === "" ? "0" : trimmed;
}

// Canonical form so "300,000" / "300.000" / "300 000" / "300000" / "٣٠٠٬٠٠٠" are
// one value, and "2.5%" / "2,5%" / "2.50%" are one value.
//
// Known, accepted ambiguity: "2.500" canonicalizes to 2500, not 2.5. Both the
// answer and the evidence run through this same function, so the COMPARISON
// stays consistent; only a human reading the reason code sees the ambiguity.
function canonicalNumber(raw) {
  const compact = toAsciiDigits(raw).replace(SPACE_STRIP, "");
  const parts = compact.split(SEPARATOR_SPLIT);
  if (parts.length === 1) return stripLeadingZeros(parts[0]);
  const groupedIntegers = parts[0].length >= 1 && parts[0].length <= 3
    && parts.slice(1).every((part) => part.length === 3);
  if (groupedIntegers) return stripLeadingZeros(parts.join(""));
  const fraction = parts[parts.length - 1].replace(/0+$/u, "");
  const integer = stripLeadingZeros(parts.slice(0, -1).join(""));
  return fraction ? `${integer}.${fraction}` : integer;
}

// P2.2 defect CLAIM-3 (High). A spelled-out cardinal is the SAME number as its
// digits, and a model restating approved evidence routinely swaps one for the
// other: the chunk says "أربعة أشهر", the grounded answer says "4 أشهر". Without
// this table the answer was blocked with `number_not_in_evidence:4` even though
// the fact was fully supported, which is BLK-1's failure mode returning through
// a new door. Found by src/ragPolicy.test.js:263.
//
// ACCEPTED TRADE-OFF, stated plainly: the table is applied to BOTH the claim and
// the evidence, so an incidental "one of the directors" in a chunk does make the
// bare value "1" count as supported. That is a narrow fail-open on small
// cardinals. It is accepted because number matching is only ever HALF the
// PROGRAM_FACT test — entity overlap must also hold — and because the
// alternative, deleting correctly grounded answers, is the defect M2 exists to
// remove. Large, high-risk figures (300000, 50000, 999) have no word form here
// and are therefore unaffected either way.
const CARDINAL_WORDS = Object.freeze({
  one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
  eleven: "11", twelve: "12", thirteen: "13", fourteen: "14", fifteen: "15", sixteen: "16", seventeen: "17",
  eighteen: "18", nineteen: "19", twenty: "20", thirty: "30", forty: "40", fifty: "50", sixty: "60",
  seventy: "70", eighty: "80", ninety: "90",
  // Arabic, written in the folded forms this module compares against
  // (`foldArabicLetters` maps أ/إ/آ -> ا, ى -> ي, ة -> ه).
  واحد: "1", واحده: "1", اثنين: "2", اثنان: "2", اثنتين: "2", ثلاثه: "3", ثلاث: "3", اربعه: "4", اربع: "4",
  خمسه: "5", خمس: "5", سته: "6", ست: "6", سبعه: "7", سبع: "7", ثمانيه: "8", ثماني: "8", تسعه: "9", تسع: "9",
  عشره: "10", عشر: "10", اثناعشر: "12", خمسهعشر: "15", سبعهعشر: "17", عشرين: "20", ثلاثين: "30", خمسين: "50",
  اسبوعين: "2", شهرين: "2", سنتين: "2", يومين: "2",
  // Greek.
  ένα: "1", ένας: "1", μία: "1", μια: "1", δύο: "2", δυο: "2", τρία: "3", τρεις: "3", τέσσερα: "4",
  τέσσερις: "4", πέντε: "5", έξι: "6", επτά: "7", εφτά: "7", οκτώ: "8", οχτώ: "8", εννέα: "9", εννιά: "9",
  δέκα: "10", δώδεκα: "12", δεκαπέντε: "15", δεκαεπτά: "17", είκοσι: "20", τριάντα: "30", πενήντα: "50"
});

const CARDINAL_WORD_TOKEN = /[\p{L}]+/gu;

function cardinalWordNumbers(text) {
  const tokens = foldArabicLetters(String(text || "").normalize("NFKC")).toLocaleLowerCase().match(CARDINAL_WORD_TOKEN) || [];
  const found = [];
  for (const token of tokens) {
    const value = CARDINAL_WORDS[token];
    if (value) found.push(value);
  }
  return found;
}

function extractNumbers(text) {
  const matches = toAsciiDigits(String(text || "")).match(NUMBER_TOKEN) || [];
  return [...new Set([...matches.map(canonicalNumber), ...cardinalWordNumbers(text)])];
}

// ------------------------------------------------------------------- evidence

// An unapproved chunk is not evidence. An expired chunk is not evidence. An
// unparseable `valid_until` is treated as expired: fail closed, never open.
function isApprovedEvidence(item) {
  if (!item || typeof item !== "object") return false;
  if (item.review_status !== "approved") return false;
  const validUntil = item.valid_until;
  if (validUntil === undefined || validUntil === null || String(validUntil).trim() === "") return true;
  const expiry = Date.parse(validUntil);
  if (!Number.isFinite(expiry)) return false;
  return expiry > Date.now();
}

function evidenceContent(item) {
  if (!item || typeof item !== "object") return "";
  return String(item.content ?? item.text ?? "");
}

function approvedEvidenceText(evidence) {
  if (!Array.isArray(evidence)) return "";
  return normalizeClaimText(evidence.filter(isApprovedEvidence).map(evidenceContent).join("\n"));
}

// ------------------------------------------------------------- sentence split

const TERMINATORS = new Set([".", "!", "?", "؟", ";", "؛", "‼", "⁇", "⁈", "⁉"]);

function isAsciiDigit(character) {
  return character !== undefined && character >= "0" && character <= "9";
}

// A hand-rolled scanner rather than `split(/(?<=[.!?])\s+/)` because the two
// cases that matter most are the ones a naive split gets wrong: the decimal
// point inside "2.5%" and the thousands separator inside "300.000". Both are a
// terminator character sitting between two digits, and neither ends a sentence.
function splitClaims(text) {
  const value = String(text === null || text === undefined ? "" : text).replace(/\s+/gu, " ").trim();
  if (!value) return [];
  const sentences = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (!TERMINATORS.has(character)) continue;
    const previous = toAsciiDigits(value[index - 1] || "");
    const following = toAsciiDigits(value[index + 1] || "");
    // 2.5 / 300.000 / 2,5 — a separator, not a full stop.
    if (character === "." && isAsciiDigit(previous) && isAsciiDigit(following)) continue;
    // Consume a run of terminators so "What?!" stays one boundary.
    let end = index;
    while (end + 1 < value.length && TERMINATORS.has(value[end + 1])) end += 1;
    const next = value[end + 1];
    if (next !== undefined && !/\s/u.test(next)) continue;
    const sentence = value.slice(start, end + 1).trim();
    if (sentence) sentences.push(sentence);
    start = end + 1;
    index = end;
  }
  const tail = value.slice(start).trim();
  if (tail) sentences.push(tail);
  return sentences;
}

// ------------------------------------------------------------- W2.1.3 GUARANTEE

// A complete, self-contained refusal to guarantee is the opposite of a
// guarantee, and REFAL's own approved fallbacks are written exactly this way
// ("I can't guarantee bank approval; the bank decides"). The span stops at a
// comma or a semicolon on purpose: "I cannot guarantee approval, but we
// guarantee the price" must keep its second half and still block.
//
// Folded at module load like every other rule here: an unfolded Arabic literal
// in THIS pattern is not a fail-open, it is a fail-closed (the disclaimer stops
// being recognised and REFAL's own refusal reads as a promise), but it is still
// the same BLK-16 bug and it was caught by the test above.
// P2.2 defect CLAIM-1 (High). The verb forms below were the only negation this
// knew. The ADJECTIVE form of the same disclaimer was not covered, so REFAL's
// own honest hedge "the timeline is an estimate and is NOT a guaranteed date"
// / "وليست موعداً مضموناً" / "δεν είναι εγγυημένο" classified as a GUARANTEE and
// the whole grounded answer was deleted. Found by src/ragPolicy.test.js:263,
// which asserts exactly that Arabic reply survives the gate.
//
// These adjective alternatives are deliberately NOT given the trailing
// `[^.!?;,]{0,90}` wildcard the verb forms carry: they strip only the negated
// phrase itself, so "النتيجة غير مضمونة ولكن نضمن الموافقة" still blocks on its
// second clause.
const rawNegatedGuarantee = /(?:\b(?:i|we|refal|refalco|business)\s+)?\b(?:can(?:not|['’]t)|cannot|could\s+not|couldn['’]t|do(?:es)?\s+not|don['’]t|will\s+not|won['’]t|never)\s+(?:guarantee|guarantees|promise|assure|confirm)\b[^.!?;,؟؛،]{0,90}|(?:لا\s+(?:أستطيع|يمكنني)|ما\s+(?:فيني|بقدر|منقدر))\s+(?:أضمن|ضمان|تأكيد|أؤكد|نضمن|أعد)[^.!?;,؟؛،]{0,90}|δεν\s+μπορ\p{L}+\s+να\s+(?:εγγυηθ\p{L}+|υποσχεθ\p{L}+|επιβεβαιώσ\p{L}+)[^.!?;,؟؛،]{0,90}|\b(?:is|are|was|were|it['’]s)?\s*(?:not|no)\s+(?:a\s+|an\s+)?guarantee(?:d|s)?\b|\bcannot\s+be\s+guaranteed\b|\bwithout\s+(?:any\s+)?guarantee(?:s)?\b|(?:ليست|ليس|غير|مو|مش)(?:\s+\S+){0,3}\s*مضمون\p{L}*|δεν\s+είναι\s+εγγυημέν\p{L}*|χωρίς\s+(?:καμία\s+)?εγγύηση|\b(?:nobody|no\s*-?\s*one|none\s+of\s+us|no\s+adviser|no\s+agent)\s+(?:can|could|will|may|is\s+able\s+to)\s+(?:guarantee|promise|assure|confirm)\b[^.!?;,؟؛،]{0,90}|(?:ما\s+(?:حد|في\s+حدا)|محدا|لا\s+أحد|ولا\s+حد)(?:\s+\S+){0,2}\s*(?:يضمن|بيضمن|يقدر\s+يضمن|بيقدر\s+يضمن|يوعد|بيوعد|يؤكد)[^.!?;,؟؛،]{0,90}|κανείς\s+δεν\s+(?:μπορεί\s+να\s+)?(?:εγγυηθ\p{L}+|υποσχεθ\p{L}+|επιβεβαιώσ\p{L}+)[^.!?;,؟؛،]{0,90}/giu;
const [, NEGATED_GUARANTEE] = foldRulePatterns([["negated_guarantee", rawNegatedGuarantee]])[0];

// P2.6 defect CLAIM-4 (High). `NEGATED_GUARANTEE` above only covers a refusal to
// GUARANTEE. A refusal to PROVIDE was not covered at all, so REFAL's own
// approved investment fallbacks classified as claims about the very things they
// decline to discuss:
//
//   english  "I can't provide investment advice, expected returns, or financial
//            guarantees."                                  -> GUARANTEE
//   greek    "Δεν μπορώ να δώσω επενδυτικές συμβουλές, αναμενόμενες αποδόσεις ή
//            οικονομικές εγγυήσεις."                       -> GUARANTEE
//   arabic   "ما فيني أعطي نصيحة استثمارية أو عوائد متوقعة أو ضمانات مالية."
//                                                          -> entities_not_in_evidence
//
// The English one blocked even on the legacy branch, so it predates M2. The
// consequence is the worst kind: the gate deletes the refusal and the customer
// receives a vaguer fallback instead of REFAL's precise, approved wording.
//
// Same boundary design as src/outputGuards.js: the span runs to a sentence
// terminator OR to a contrastive conjunction, never merely to a comma, because
// these refusals ENUMERATE what they refuse ("advice, expected returns, or
// guarantees") and a comma stop would leave the hunted word standing alone.
const CLAIM_CONTRASTIVE = "(?:but|however|although|though|yet|still)|ولكن|لكن|بس|غير\\s+أن|إلا\\s+أن|αλλά|όμως|ωστόσο";
const REFUSAL_BODY = `(?:(?!\\s*(?:${CLAIM_CONTRASTIVE})(?![\\p{L}\\p{N}]))[^.!?;؟؛]){0,160}`;
const rawRefusalToProvide = new RegExp(
  `(?:\\b(?:i|we|refal|refalco|business)\\s+)?\\b(?:can(?:not|['’]t)|cannot|do(?:es)?\\s+not|don['’]t|will\\s+not|won['’]t|never)\\s+(?:provide|give|offer|share|discuss|disclose|comment\\s+on|quote)\\b${REFUSAL_BODY}`
  + `|(?:لا\\s+(?:أستطيع|يمكنني|أقدم|أوفر|نقدم|نستطيع|أعطي|نعطي)|ما\\s+(?:فيني|بقدر|منقدر|بنقدر))\\s*(?:أعطي|نعطي|تقديم|إعطاء|مشاركة|أشارك|نشارك|مناقشة|أناقش|أحكي)?${REFUSAL_BODY}`
  + `|δεν\\s+(?:μπορ\\p{L}+\\s+να\\s+)?(?:παρέχ\\p{L}+|δίν\\p{L}+|δώσ\\p{L}+|δώσω|μοιραστ\\p{L}+|συζητ\\p{L}+|σχολιάσ\\p{L}+)${REFUSAL_BODY}`,
  "giu"
);
const [, REFUSAL_TO_PROVIDE] = foldRulePatterns([["refusal_to_provide", rawRefusalToProvide]])[0];

const rawGuaranteeRules = [
  ["guarantee_marker", /\bguarantee(?:s|d|ing)?\b|\bwe\s+guarantee\b|\bcertain\s+approval\b|\bassured\b|\bassure\s+you\b|\bpromise\s+you\b|\bi\s+promise\b|\b100\s*(?:%|percent)\s*(?:approval|success|acceptance)|(?:approval|acceptance|success)\s+is\s+(?:certain|guaranteed|assured|100\s*%)/iu],
  // Arabic: authored pointed, folded at module load. No \b anywhere near these.
  ["guarantee_marker", /نضمن|بضمن|أضمن|مضمون|(?:ال)?موافقة(?:\s+\S+){0,2}\s+(?:مؤكدة|مضمونة)|(?:ضمان|تأكيد)\s+(?:ال)?موافقة|أكيد\s+(?:ال)?موافقة/iu],
  ["guarantee_marker", /εγγυ(?:όμαστε|ώμαι|ηθώ|ηθούμε|ημέν\p{L}*|ήσει\p{L}*)|σίγουρη\s+έγκριση|σίγουρ\p{L}*\s+(?:έγκριση|αποδοχή)|βέβαιη|βέβαιο\p{L}*\s+έγκριση|υπόσχομαι/iu]
];

// ------------------------------------------- W2.1.2 PERSONALIZED_CONCLUSION

// Second person possessive or subject PLUS an eligibility or outcome verb.
// A generic statement of programme conditions carries no second person and must
// stay a PROGRAM_FACT: "applicants need annual income of 50,000 euro" is a fact,
// "your income qualifies" is a conclusion about one customer.
const rawPersonalizedRules = [
  // P2.6 finding G-01 follow-up. `qualif(?:ied)` matched "needs QUALIFIED
  // review" in REFAL's own legal and tax fallbacks, where the word describes the
  // REVIEWER, not the customer. That only became visible once
  // `containsPersonalizedConclusion` was made unconditional, and it blocked two
  // approved refusals outright. The lookahead excludes the professional-noun
  // reading and nothing else: "your company qualifies" is untouched.
  ["personalized_marker", /(?<![\p{L}\p{N}])your\b[^.!?;]{0,60}\b(?:qualif(?:y|ies|ied|ying)(?!\s+(?:review|advice|advis\w+|professional|specialist|accountant|lawyer|auditor|consultant|opinion|assessment))|eligible|eligibility|suitable|approved|accepted|allowed|granted|entitled|sufficient|meets?\s+the\s+(?:requirements|criteria|conditions))\b/iu],
  ["personalized_marker", /\byou\s+(?:do\s+)?qualify\b|\byou\s+are\s+(?:eligible|qualified|approved|entitled|suitable|accepted)\b|\byou(?:['’]ll|\s+will|\s+shall)\s+(?:get|receive|obtain|qualify|be\s+granted|be\s+approved|be\s+accepted|be\s+eligible)\b|\byou\s+can\s+(?:get|obtain|receive)\s+(?:the\s+|a\s+|an\s+)?(?:residency|residence|permit|visa|citizenship|approval|licen[cs]e|status)\b/iu],
  ["personalized_marker", /\b(?:personal|personalized|personalised)\b[^.!?;]{0,40}\b(?:tax|legal|financial|investment|immigration)\s+advice\b|\b(?:tax|legal|financial|investment|immigration)\s+advice\b[^.!?;]{0,40}\bfor\s+your\s+(?:situation|case|circumstances|company|business)\b|\badvice\s+for\s+your\s+(?:situation|case|circumstances)\b/iu],
  ["personalized_marker", /(?:شركتك|نشاطك|حالتك|وضعك|ملفك|طلبك|عملك|مشروعك|أعمالك|دخلك|استثمارك|عقارك)(?:\s+\S+){0,3}\s+(?:مؤهل|مؤهلة|مناسب|مناسبة|مقبول|مقبولة|معتمد|معتمدة|مستوفي|مستوفية|كافي|كافية|مضمون|مضمونة)/iu],
  ["personalized_marker", /ستحصل|سوف\s+تحصل|رح\s+تحصل|بتحصل|رح\s+تاخد|رح\s+تأخذ|سوف\s+تنال|ستنال|رح\s+تنال|سيتم\s+منحك|رح\s+ينوافق\s+عليك|رح\s+يوافقوا\s+عليك|أنت\s+مؤهل|إنت\s+مؤهل|أنت\s+مستحق/iu],
  ["personalized_marker", /(?:استشارة|نصيحة|توصية)(?:\s+\S+){0,3}\s+(?:شخصية|شخصي|لحالتك|لوضعك|بحالتك|لشركتك)|(?:شخصية|شخصي)\s+(?:استشارة|نصيحة|توصية)/iu],
  // P2.6 follow-up. `εγκεκριμέν` ("approved") qualifies INFORMATION far more
  // often than it qualifies a person. "να σας εξηγήσω τις εγκεκριμένες
  // πληροφορίες" ("let me explain the approved information to you") is REFAL's
  // standard Greek opener, and it read as "you are approved" because `σας` is
  // also the indirect object "to you". That false positive only became live when
  // this rule set was made unconditional for P2.6/G-01. The lookahead excludes
  // the inanimate nouns `εγκεκριμέν` actually modifies, and nothing else.
  ["personalized_marker", /(?<![\p{L}\p{N}])σας(?![\p{L}\p{N}])[^.!?;]{0,60}(?:δικαιού\p{L}*|επιλέξιμ\p{L}*|κατάλληλ\p{L}*|εγκεκριμέν\p{L}*(?![\p{L}\p{N}])(?!\s+(?:πληροφορ\p{L}*|έγγραφ\p{L}*|εγγράφ\p{L}*|πηγ\p{L}*|στοιχεί\p{L}*|περιεχόμεν\p{L}*|κείμεν\p{L}*|δεδομέν\p{L}*|απάντησ\p{L}*))|εγκρίνεται|θα\s+εγκριθ\p{L}*|πληροί)/iu],
  ["personalized_marker", /(?:δικαιού\p{L}*|επιλέξιμ\p{L}*|κατάλληλ\p{L}*|εγκεκριμέν\p{L}*(?![\p{L}\p{N}])(?!\s+(?:πληροφορ\p{L}*|έγγραφ\p{L}*|εγγράφ\p{L}*|πηγ\p{L}*|στοιχεί\p{L}*|περιεχόμεν\p{L}*|κείμεν\p{L}*|δεδομέν\p{L}*|απάντησ\p{L}*)))[^.!?;]{0,60}(?<![\p{L}\p{N}])σας(?![\p{L}\p{N}])/iu],
  ["personalized_marker", /θα\s+(?:πάρετε|λάβετε|αποκτήσετε|εγκριθείτε|δικαιωθείτε|εξασφαλίσετε)/iu],
  ["personalized_marker", /προσωπικ\p{L}*[^.!?;]{0,40}συμβουλ\p{L}*|συμβουλ\p{L}*[^.!?;]{0,40}(?:προσωπικ\p{L}*|περίπτωσ\p{L}*\s+σας)/iu]
];

// --------------------------------------------------- W2.1.4 PROGRAM_FACT entities

// Broad on purpose. A term landing here only means "this sentence needs approved
// evidence before it may be said", which is the fail-closed direction.
const rawEntityRules = [
  ["program_entity", /\b(?:tax|taxes|taxation|vat|ip\s*box|non[\s-]?dom|dividend|dividends|interest|income|residency|residence|relocation|citizenship|visa|permit|permits|permission|licen[cs]e|licensing|registration|registering|register|registered|eori|company|companies|corporate|formation|incorporat\w*|fee|fees|price|pricing|cost|costs|invest\w*|euro|euros|\beur\b|category|programme|program|scheme|regime|insurance|health|gesy|bank|banks|banking|kyc|aml|compliance|source\s+of\s+(?:funds|wealth)|payroll|social\s+insurance|trademark|planning\s+permission|building\s+permit|applicant|applicants|eligib\w*|qualif\w*|treaty|treaties|authority|authorities|institution|customs|developer|property|cyprus|refalco)\b/iu],
  ["program_entity", /ضريب|ضرائب|القيمة المضافة|إقامة|الإقامة|جنسية|تأشيرة|فيزا|رخصة|رخص|ترخيص|تصريح|تصاريح|شركة|شركات|الشركة|تأسيس|تسجيل|رسوم|سعر|تكلفة|استثمار|يورو|فئة|برنامج|نظام|تأمين|صحي|بنك|بنوك|بنكي|مصرف|امتثال|مصدر الأموال|مصدر الثروة|رواتب|علامة تجارية|دخل|توزيعات|أرباح|مؤهل|هجرة|مقيم|قبرص|عقار|جمارك|مطور/iu],
  ["program_entity", /φόρο|φορολογ|φπα|διαμονή|κατοικ|άδει|υπηκοότητα|βίζα|εταιρ|ίδρυση|εγγραφή|καταχώριση|τέλη|τιμή|κόστος|επένδυσ|ευρώ|κατηγορία|καθεστώς|πρόγραμμα|ασφάλισ|υγεία|υγείας|τράπεζ|συμμόρφωσ|πηγή κεφαλαίων|μισθοδοσία|εισόδημα|μερίσμα|κέρδ|μετανάστευσ|αιτών|επιλέξιμ|δικαιού|σήμα|πολεοδομ|τελωνεί|ακίνητ|κύπρο|κατασκευ/iu]
];

// Authored readably, folded once at module load so the pointed and the bare-alef
// spellings both match (BLK-16).
const guaranteeRules = foldRulePatterns(rawGuaranteeRules);
const personalizedRules = foldRulePatterns(rawPersonalizedRules);
const entityRules = foldRulePatterns(rawEntityRules);

// -------------------------------------------------------------- entity overlap

const CLAIM_STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "are", "was", "were", "has", "have", "can", "will", "not",
  "you", "your", "our", "its", "their", "any", "all", "out", "but", "per", "such", "also", "into", "than", "then",
  "when", "where", "which", "what", "who", "how", "there", "here", "very", "more", "most", "some", "each", "every",
  "other", "both", "they", "them", "his", "her", "she", "him", "one", "two", "does", "did", "been", "being",
  "about", "after", "before", "under", "over", "only", "just", "like", "well", "even", "make", "made", "used",
  "using", "use", "its", "may", "must", "need", "needs", "should", "would", "could", "own",
  "في", "من", "على", "عن", "الى", "إلى", "مع", "هذا", "هذه", "هاي", "هالـ", "هو", "هي", "ما", "لا", "أن", "ان",
  "إن", "كل", "أو", "او", "بس", "لكن", "قد", "كان", "يكون", "هناك", "عند", "بين", "بعد", "قبل", "حسب", "التي",
  "الذي", "اللي", "كمان", "يلي",
  "και", "για", "από", "στο", "στη", "στην", "στις", "στον", "τον", "την", "της", "των", "τις", "που", "είναι",
  "μια", "ένα", "ένας", "τα", "το", "οι", "με", "σε", "ως", "κατά", "αλλά", "αυτό", "αυτή", "αυτά", "δεν", "θα",
  "να", "μπορεί", "μπορείτε", "πιο", "ήταν", "ή"
].map((term) => foldArabicLetters(term)));

function claimTokens(text) {
  return String(text || "").toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [];
}

// "The key entity terms overlap the evidence". Half of the content terms, with a
// floor of two once the sentence has three or more. Deliberately stricter than
// `hasQuestionEvidenceOverlap` in refalcoAnswer: that one gates relevance, this
// one gates whether a fact may be asserted at all.
function hasEntityOverlap(normalizedSentence, normalizedEvidence) {
  const terms = [...new Set(claimTokens(normalizedSentence).filter((term) => !CLAIM_STOPWORDS.has(term)))];
  if (!terms.length) return true;
  const evidenceTerms = new Set(claimTokens(normalizedEvidence));
  const overlap = terms.filter((term) => evidenceTerms.has(term)).length;
  const needed = terms.length >= 3 ? Math.max(2, Math.ceil(terms.length * 0.5)) : 1;
  return overlap >= needed;
}

// ------------------------------------------------------------------ classifier

function resolveLanguage(language, text) {
  const alias = LANGUAGE_ALIASES[String(language || "").toLowerCase()];
  return alias || detectMessageLanguage(text);
}

function hasContent(text) {
  return /[\p{L}\p{N}]/u.test(String(text || ""));
}

// Greek writes its question mark as `;` (U+003B) or `;` (U+037E), which is also
// an ordinary clause separator in English and Arabic text. So `;` only ends a
// question when the sentence is Greek; `?` and the Arabic `؟` always do.
const INTERROGATIVE_TERMINATORS = /[?؟⁇⁈⁉]\s*$/u;
const GREEK_INTERROGATIVE_TERMINATORS = /[;;]\s*$/u;

function isInterrogative(sentence, language) {
  const value = String(sentence || "").trim();
  if (!value) return false;
  if (INTERROGATIVE_TERMINATORS.test(value)) return true;
  return language === "greek" && GREEK_INTERROGATIVE_TERMINATORS.test(value);
}

function classifyClaim(sentence, { evidence = [], language } = {}) {
  const original = String(sentence === null || sentence === undefined ? "" : sentence);
  const normalized = normalizeClaimText(original);
  const resolvedLanguage = resolveLanguage(language, original);

  if (!hasContent(normalized)) {
    return { claimClass: CLAIM_CLASSES.NEUTRAL, allowed: true, reasons: [], language: resolvedLanguage, unsupportedNumbers: [] };
  }

  // Every classification below runs against the ASSERTED text: the sentence
  // with complete refusal clauses removed. A span REFAL is declining to discuss
  // asserts nothing, so it can be neither a guarantee, nor a conclusion about
  // the customer, nor a programme fact needing evidence. The strip stops at a
  // contrastive conjunction, so "I cannot advise, but your company qualifies"
  // keeps its second half and still blocks.
  const assertedText = normalized.replace(NEGATED_GUARANTEE, " ").replace(REFUSAL_TO_PROVIDE, " ");
  if (!hasContent(assertedText)) {
    return { claimClass: CLAIM_CLASSES.NEUTRAL, allowed: true, reasons: ["disclaimer_only"], language: resolvedLanguage, unsupportedNumbers: [] };
  }
  if (guaranteeRules.some(([, pattern]) => pattern.test(assertedText))) {
    return { claimClass: CLAIM_CLASSES.GUARANTEE, allowed: false, reasons: ["guarantee_marker"], language: resolvedLanguage, unsupportedNumbers: [] };
  }

  // P2.2 defect CLAIM-2 (High). A QUESTION asserts no fact, so it can be
  // neither an ungrounded programme fact nor a conclusion about the customer.
  // Before this branch, REFAL's mandatory closing discovery question ("شو
  // النشاط اللي ناوي تسجّل الشركة عشانه؟") classified as a PROGRAM_FACT with
  // `entities_not_in_evidence` and blocked the entire answer. The Golden Answer
  // Formula REQUIRES that question, so every compliant reply would have been
  // deleted. Found by src/ragPolicy.test.js:263.
  //
  // The GUARANTEE check above deliberately runs BEFORE this, so a promise
  // dressed as a question is still blocked.
  if (isInterrogative(original, resolvedLanguage)) {
    return { claimClass: CLAIM_CLASSES.NEUTRAL, allowed: true, reasons: ["question"], language: resolvedLanguage, unsupportedNumbers: [] };
  }

  if (personalizedRules.some(([, pattern]) => pattern.test(assertedText))) {
    return { claimClass: CLAIM_CLASSES.PERSONALIZED_CONCLUSION, allowed: false, reasons: ["personalized_marker"], language: resolvedLanguage, unsupportedNumbers: [] };
  }

  const numbers = extractNumbers(assertedText);
  const carriesEntity = entityRules.some(([, pattern]) => pattern.test(assertedText));
  if (!numbers.length && !carriesEntity) {
    return { claimClass: CLAIM_CLASSES.NEUTRAL, allowed: true, reasons: ["neutral"], language: resolvedLanguage, unsupportedNumbers: [] };
  }

  const evidenceText = approvedEvidenceText(evidence);
  if (!evidenceText) {
    return { claimClass: CLAIM_CLASSES.PROGRAM_FACT, allowed: false, reasons: ["no_approved_evidence"], language: resolvedLanguage, unsupportedNumbers: numbers };
  }

  const evidenceNumbers = new Set(extractNumbers(evidenceText));
  const unsupportedNumbers = numbers.filter((number) => !evidenceNumbers.has(number));
  const reasons = unsupportedNumbers.map((number) => `number_not_in_evidence:${number}`);
  if (!hasEntityOverlap(assertedText, evidenceText)) reasons.push("entities_not_in_evidence");
  if (reasons.length) {
    return { claimClass: CLAIM_CLASSES.PROGRAM_FACT, allowed: false, reasons, language: resolvedLanguage, unsupportedNumbers };
  }
  return { claimClass: CLAIM_CLASSES.PROGRAM_FACT, allowed: true, reasons: ["program_fact_grounded"], language: resolvedLanguage, unsupportedNumbers: [] };
}

function evaluateAnswerClaims(text, { evidence = [], language } = {}) {
  const resolvedLanguage = resolveLanguage(language, text);
  const claims = splitClaims(text).map((sentence) => {
    const verdict = classifyClaim(sentence, { evidence, language: resolvedLanguage });
    return { sentence, claimClass: verdict.claimClass, allowed: verdict.allowed, reasons: verdict.reasons };
  });
  const blocked = claims
    .filter((claim) => !claim.allowed)
    .map(({ sentence, claimClass, reasons }) => ({ sentence, claimClass, reasons }));
  return { allowed: blocked.length === 0, blocked, claims };
}

// P2.6 finding G-01 (High). A BARE guarantee — "guaranteed", "مضمونة",
// "εγγυημένα", "your approval is certain" — carries no bank, authority or
// deposit noun, so it hooks none of the output guards, and it matches nothing
// in the pre-M2 blanket topic regex either. 9 of 63 forbidden outputs were
// passing the no-evidence gate on exactly that shape. A guarantee is prohibited
// because of WHAT it asserts, so it belongs with the unconditional guards
// rather than only inside the evidence arm.
//
// Exported separately from `classifyClaim` so `refalcoAnswer` can ask this one
// question without running the whole classifier, and so the refusal strips
// above apply here too: REFAL saying "I cannot guarantee approval" must not
// register as a guarantee. That carve-out is why this is a function and not an
// exported regex.
function containsGuaranteeMarker(text) {
  return assertedClaimText(text, guaranteeRules);
}

// P2.6 finding G-01, second half. The two forbidden outputs that survived the
// guarantee fix were not guarantees at all, they were PERSONALIZED_CONCLUSIONs:
// "أنت مستحق لوضع Non Dom ورح تحصل على تصريح العمل" and "Το έγγραφο με
// εξουσιοδοτεί να επιβεβαιώσω ότι η άδειά σας θα δοθεί". The P2.1 taxonomy says
// PERSONALIZED_CONCLUSION is "BLOCK always", with no evidence condition
// attached, so like GUARANTEE it belongs with the unconditional guards and not
// only inside the evidence arm.
//
// An interrogative is deliberately NOT exempt here, unlike in `classifyClaim`.
// This function is asked about REFAL's OUTBOUND text, where "Does your company
// qualify? Yes." split across clauses would otherwise slip the gate; the
// question carve-out exists for the Golden Formula's closing question, which is
// handled by `classifyClaim` on the grounded path.
function containsPersonalizedConclusion(text) {
  return assertedClaimText(text, personalizedRules);
}

// Shared body: normalize, strip complete refusal clauses, then test. The strip
// is what keeps REFAL's own "I cannot confirm whether you qualify" from reading
// as a verdict about the customer.
function assertedClaimText(text, rules) {
  const normalized = normalizeClaimText(text);
  if (!hasContent(normalized)) return false;
  const assertedText = normalized.replace(NEGATED_GUARANTEE, " ").replace(REFUSAL_TO_PROVIDE, " ");
  if (!hasContent(assertedText)) return false;
  return rules.some(([, pattern]) => pattern.test(assertedText));
}

module.exports = {
  CLAIM_CLASSES,
  splitClaims,
  classifyClaim,
  evaluateAnswerClaims,
  approvedEvidenceText,
  isApprovedEvidence,
  containsGuaranteeMarker,
  containsPersonalizedConclusion
};
