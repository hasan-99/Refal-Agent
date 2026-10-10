const { LEAD_TIERS } = require("./leadTemperature");
const { HOOKS } = require("./salesHooks");

// goldenFormula is intentionally NOT imported: its hasDirectAnswer means "did
// this reply deflect entirely", which is a different question from "is this
// reply nothing but questions". See isQuestionOnly below.

// P1.5 — Anti-pattern guards (MB-AP1..AP5, CX R-04).
//
// These are OUTPUT guards: they inspect a drafted reply in the context of the
// turn that produced it, and report which anti-patterns it commits. They do not
// rewrite the reply. Rewriting a reply to dodge a guard is how caveats get
// silently dropped, which is the failure mode CX 12B specifically warns about.
//
// Every pattern below splits Latin from non-Latin. \b is ASCII-only in
// JavaScript, so a \b-wrapped Arabic or Greek alternative is unreachable dead
// code — enforced repo-wide by src/regexBoundary.test.js.

const ANTI_PATTERNS = Object.freeze({
  PHONE_OBSESSION: "AP-1",
  DISCLAIMER_OVERLOAD: "AP-2",
  FEAR_SELLING: "AP-3",
  FAKE_PROMISE: "AP-4",
  INTERROGATION: "AP-5",
  UNREQUESTED_MEETING: "AP-6",
  HOT_TIER_HOOK: "AP-7"
});

// --- AP-1: contact capture ------------------------------------------------
const CONTACT_REQUEST_LATIN = /\b(?:your|a)\s+(?:phone|mobile|telephone|whatsapp|contact)\s+(?:number|details?)\b|\bcan\s+(?:i|we)\s+(?:have|get|take)\s+your\s+(?:number|phone|email|contact)\b|\bshare\s+your\s+(?:number|phone|email|contact details?)\b|\bwhat(?:'s| is)\s+your\s+(?:number|phone|email)\b/iu;
const CONTACT_REQUEST_OTHER = /(?:رقم(?:ك|\s+هاتفك|\s+جوالك|\s+الواتساب)|ممكن\s+رقمك|شو\s+رقمك|بريدك\s+الإلكتروني|إيميلك)|(?:το\s+)?(?:τηλέφωνό|κινητό|email)\s+σας|μπορώ\s+να\s+έχω\s+το\s+τηλέφωνό/iu;

const CUSTOMER_OFFERED_CONTACT_LATIN = /\b(?:my\s+(?:number|phone|email)\s+is|call\s+me|contact\s+me|reach\s+me|here(?:'s| is)\s+my\s+(?:number|phone|email))\b/iu;
const CUSTOMER_OFFERED_CONTACT_OTHER = /(?:رقمي\s+هو|اتصلوا\s+في|تواصلوا\s+معي|هذا\s+رقمي|ايميلي)|(?:το\s+τηλέφωνό\s+μου\s+είναι|καλέστε\s+με|επικοινωνήστε\s+μαζί\s+μου)/iu;

// --- AP-2: caveat counting ------------------------------------------------
// A caveat is a hedging clause. One is responsible; a stack of them is the
// "legal disclaimer overload" MB-AP2 names, and it reads as evasion.
const CAVEAT_LATIN = /\b(?:please note|bear in mind|keep in mind|however,|that said,|subject to|depending on|cannot guarantee|can(?:'t|not)\s+confirm|needs?\s+(?:qualified|specialist|individual)\s+review|is not (?:legal|tax|investment) advice|may vary|not a substitute for)\b/giu;
const CAVEAT_OTHER = /(?:يرجى الانتباه|خذ بعين الاعتبار|مع ذلك،|لكن يجب|يعتمد على|ما فيني أضمن|ما فيني أكد|بحاجة لمراجعة مختص|ليست استشارة|قد تختلف)|(?:σημειώστε ότι|λάβετε υπόψη|ωστόσο,|εξαρτάται από|δεν μπορώ να εγγυηθώ|δεν μπορώ να επιβεβαιώσω|χρειάζεται αξιολόγηση ειδικού|δεν αποτελεί συμβουλή|ενδέχεται να διαφέρει)/giu;

const MAX_CAVEATS = 1;

// --- AP-3: fear-based selling --------------------------------------------
const FEAR_LATIN = /\b(?:prices?\s+(?:will\s+)?(?:rise|increase|go up)\s+(?:tomorrow|soon|next\s+week|shortly)|act\s+now\s+before|before\s+it(?:'s| is)\s+too\s+late|last\s+chance|limited\s+time\s+only|the\s+law\s+(?:is\s+)?chang(?:es|ing)\s+(?:tomorrow|soon|immediately)|rules?\s+(?:are\s+)?chang(?:es|ing)\s+(?:tomorrow|soon|immediately)|you\s+(?:will\s+)?(?:miss|lose)\s+(?:out|the\s+opportunity)|won(?:'t| not)\s+last)\b/iu;
const FEAR_OTHER = /(?:الأسعار\s+(?:رح\s+)?(?:ترتفع|تزيد)\s+(?:بكرا|قريبا|قريباً)|بادر\s+قبل|آخر\s+فرصة|فرصة\s+محدودة|القانون\s+(?:رح\s+)?يتغير\s+(?:بكرا|قريبا)|رح\s+تخسر\s+الفرصة)|(?:οι\s+τιμές\s+θα\s+(?:αυξηθούν|ανέβουν)\s+(?:αύριο|σύντομα)|τελευταία\s+ευκαιρία|περιορισμένος\s+χρόνος|ο\s+νόμος\s+αλλάζει\s+(?:αύριο|σύντομα)|θα\s+χάσετε\s+την\s+ευκαιρία)/iu;

// --- AP-4: fake promises --------------------------------------------------
// Extends the GUARANTEE class with the specific third parties MB-AP4 names.
const THIRD_PARTY_PROMISE = /\b(?:stripe|paypal|amazon|shopify|revolut|wise)\b[^.!?]{0,60}\b(?:will|guarantee\w*|approve\w*|accept\w*|no\s+problem|definitely)\b|\b(?:will|guarantee\w*|definitely)\b[^.!?]{0,60}\b(?:stripe|paypal|amazon|shopify|revolut|wise)\b/iu;
const ISSUANCE_PROMISE_LATIN = /\b(?:you\s+will\s+(?:get|receive|be\s+granted)|we\s+(?:will|can)\s+(?:get|secure|obtain))\b[^.!?]{0,60}\b(?:residency|permit|visa|licence|license|approval|citizenship)\b/iu;
const ISSUANCE_PROMISE_OTHER = /(?:رح\s+تحصل|ستحصل|بنجيبلك|منأمنلك)[^.؟!]{0,60}(?:إقامة|اقامة|تصريح|تأشيرة|رخصة|موافقة|جنسية)|(?:θα\s+(?:λάβετε|πάρετε|σας\s+χορηγηθεί))[^.;!]{0,60}(?:άδεια|διαμονή|βίζα|έγκριση|υπηκοότητα)/iu;
const SPECIFIC_ROI = /\b\d{1,3}(?:[.,]\d+)?\s*%\s*(?:annual|yearly|per\s+year|return|roi|yield)\b|\b(?:return|roi|yield)\b[^.!?]{0,30}\b\d{1,3}(?:[.,]\d+)?\s*%/iu;

// --- AP-6: unrequested meeting push --------------------------------------
const MEETING_OFFER_LATIN = /\b(?:book|schedule|arrange|set\s+up)\s+(?:a\s+)?(?:meeting|call|appointment|consultation)\b|\bwould\s+you\s+like\s+(?:a\s+)?(?:call|meeting|appointment)\b|\bshall\s+(?:i|we)\s+(?:book|arrange|schedule)\b/iu;
const MEETING_OFFER_OTHER = /(?:نرتب|نحجز|بدك)\s*(?:لك\s*)?(?:موعد|اجتماع|مكالمة)|تحب\s+(?:نرتب|نحجز)|(?:να\s+)?(?:κλείσουμε|κανονίσουμε)\s+(?:ένα\s+)?(?:ραντεβού|συνάντηση|κλήση)|θα\s+θέλατε\s+(?:ένα\s+)?ραντεβού/iu;

const CUSTOMER_ASKED_FOR_MEETING_LATIN = /\b(?:book|schedule|arrange)\b[^.!?]{0,40}\b(?:meeting|call|appointment)\b|\b(?:i|we)\s+(?:want|would like|need)\s+(?:a\s+)?(?:meeting|call|appointment|consultation)\b|\bcan\s+(?:i|we)\s+(?:speak|talk)\s+to\s+(?:someone|a\s+specialist)\b/iu;
const CUSTOMER_ASKED_FOR_MEETING_OTHER = /(?:بدي|أريد|حابب|ممكن)\s*(?:احجز|موعد|اجتماع|مكالمة|أحكي مع)|(?:θέλω|μπορώ να κλείσω)\s*(?:ραντεβού|συνάντηση)/iu;

// Tiers at which an unsolicited meeting offer is permitted (CX R-04: a score
// tier alone never triggers it, but at a buying signal it is correct).
// Only HOT and WARM license an unsolicited booking offer. COLD is an EXPLICIT
// DECLINE in this system, so it must never receive one, and UNCLASSIFIED has
// shown no signal yet. CX R-04: a tier alone never triggers the offer; it only
// ever permits one that the conversation already justifies.
const BOOKING_READY_TIERS = Object.freeze([LEAD_TIERS.HOT, LEAD_TIERS.WARM]);

/**
 * True when a reply contains questions and nothing else — no declarative
 * sentence carrying information. Three of these in a row is interrogation.
 *
 * The Greek question mark is the same character as a Latin semicolon, so a
 * sentence is only treated as a question when the mark is `?`, `؟`, or a `;`
 * preceded by Greek script.
 */
function isQuestionOnly(text) {
  const value = String(text || "").trim();
  if (!value) return false;

  const sentences = value
    .split(/(?<=[.!?؟])\s+|(?<=\p{Script=Greek};)\s+/u)
    .map((part) => part.trim())
    .filter(Boolean);
  if (!sentences.length) return false;

  const isQuestion = (sentence) => /[?؟]\s*$/u.test(sentence) || /\p{Script=Greek};\s*$/u.test(sentence);
  return sentences.every(isQuestion);
}

function matches(text, latin, other) {
  const value = String(text || "");
  return latin.test(value) || other.test(value);
}

function countMatches(text, ...patterns) {
  const value = String(text || "");
  let total = 0;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    total += (value.match(pattern) || []).length;
  }
  return total;
}

/**
 * Inspect a drafted reply against all six anti-patterns.
 *
 * `deliveredApprovedFact` must be supplied by the caller: only the caller knows
 * whether approved evidence actually made it into this reply. It is NOT
 * inferred from the text, because inferring it would reward a reply that merely
 * sounds factual.
 */
function detectAntiPatterns({
  answer = "",
  customerMessage = "",
  history = [],
  deliveredApprovedFact = false,
  leadTier = "",
  evidenceText = ""
} = {}) {
  const reply = String(answer || "");
  const violations = [];

  // AP-1. Asking for contact details in a turn that gave nothing back is the
  // "phone number obsession" MB-AP1 names. Permitted when the customer raised
  // contact themselves, or when the turn actually delivered an approved fact.
  const asksForContact = matches(reply, CONTACT_REQUEST_LATIN, CONTACT_REQUEST_OTHER);
  const customerRaisedContact = matches(customerMessage, CUSTOMER_OFFERED_CONTACT_LATIN, CUSTOMER_OFFERED_CONTACT_OTHER)
    || matches(customerMessage, CONTACT_REQUEST_LATIN, CONTACT_REQUEST_OTHER);
  if (asksForContact && !deliveredApprovedFact && !customerRaisedContact) {
    violations.push({ id: ANTI_PATTERNS.PHONE_OBSESSION, reason: "contact_request_without_value" });
  }

  // AP-2. More than one caveat clause is disclaimer overload. CX 12B: the fix
  // is to report it, never to strip caveats automatically — a meaningful
  // condition removed to sound confident is a worse defect than a wordy reply.
  const caveats = countMatches(reply, CAVEAT_LATIN, CAVEAT_OTHER);
  if (caveats > MAX_CAVEATS) {
    violations.push({ id: ANTI_PATTERNS.DISCLAIMER_OVERLOAD, reason: "too_many_caveats", count: caveats });
  }

  // AP-3. Urgency claims are permitted ONLY when the approved, unexpired
  // evidence says so verbatim. Absent that, they are fear-based selling.
  if (matches(reply, FEAR_LATIN, FEAR_OTHER) && !matches(evidenceText, FEAR_LATIN, FEAR_OTHER)) {
    violations.push({ id: ANTI_PATTERNS.FEAR_SELLING, reason: "urgency_not_in_evidence" });
  }

  // AP-4. Promises about third parties, issuance outcomes, or a specific return.
  if (THIRD_PARTY_PROMISE.test(reply)
      || matches(reply, ISSUANCE_PROMISE_LATIN, ISSUANCE_PROMISE_OTHER)
      || SPECIFIC_ROI.test(reply)) {
    violations.push({ id: ANTI_PATTERNS.FAKE_PROMISE, reason: "absolute_or_third_party_promise" });
  }

  // AP-5. P1.4 catches a single interrogating turn. This adds the history
  // check MB-AP5 asks for: three consecutive turns that only asked questions.
  //
  // Note this uses isQuestionOnly, NOT goldenFormula's hasDirectAnswer. Those
  // mean different things: hasDirectAnswer asks "did this reply deflect
  // entirely", and a bare question is not a deflection. Interrogation is about
  // a reply that contains nothing BUT questions, which is a separate shape.
  const priorAgentTurns = (Array.isArray(history) ? history : [])
    .filter((turn) => turn && (turn.role === "assistant" || turn.role === "agent"))
    .slice(-2)
    .map((turn) => String(turn.content || turn.message || ""));
  const priorQuestionOnly = priorAgentTurns.length === 2 && priorAgentTurns.every(isQuestionOnly);
  if (isQuestionOnly(reply) && priorQuestionOnly) {
    violations.push({ id: ANTI_PATTERNS.INTERROGATION, reason: "three_consecutive_question_only_turns" });
  }

  // AP-6. An informational request stays informational. A lead tier on its own
  // is never a reason to offer a meeting (CX R-04).
  const offersMeeting = matches(reply, MEETING_OFFER_LATIN, MEETING_OFFER_OTHER);
  const customerAskedForMeeting = matches(customerMessage, CUSTOMER_ASKED_FOR_MEETING_LATIN, CUSTOMER_ASKED_FOR_MEETING_OTHER);
  if (offersMeeting && !customerAskedForMeeting && !BOOKING_READY_TIERS.includes(String(leadTier).toLowerCase())) {
    violations.push({ id: ANTI_PATTERNS.UNREQUESTED_MEETING, reason: "meeting_offer_without_signal" });
  }
  if (["hot", "strategic"].includes(String(leadTier).toLowerCase())) {
    const normalizedReply = reply.toLocaleLowerCase();
    const leakedHook = Object.values(HOOKS).some((hook) => Object.values(hook.hints || {}).some((hint) => hint && normalizedReply.includes(String(hint).toLocaleLowerCase())))
      || (/(?:ip\s*(?:box|holding)|tax|taxation|corporate\s+rate|non[- ]?dom|gesy|residenc\w*|relocat\w*|mov(?:e|ing)|international\s+schools?|healthcare|property\s+(?:route|option|investment)|علامة|إقامة|اقامة|ضريب|الإقامة|الاقامة|انتقال|صحة|مدارس|μετακόμ|διαμον|φορολογ|γεσυ|σχολεί|υγεία)/iu.test(normalizedReply)
        && /(?:could|may|might|worth|relevant|explore|discuss|consider|review|help(?:ful)?|option|eligible|can also|would you|benefit|advantage|favorable|favourable|reduce|lower|save|offers?|provides?|may apply|может|ممكن|قد يكون|مناسب|نستكشف|ينفع|ميزة|فوائد|يخفض|يقلل|μπορεί|ίσως|αξίζει|εξετάσουμε|να δούμε|όφελος|πλεονεκτήμ|μειώ|ευνοϊκ)/iu.test(normalizedReply));
    if (leakedHook) violations.push({ id: ANTI_PATTERNS.HOT_TIER_HOOK, reason: "sales_hook_suppressed_at_hot_tier" });
  }

  return violations;
}

module.exports = {
  ANTI_PATTERNS,
  MAX_CAVEATS,
  BOOKING_READY_TIERS,
  detectAntiPatterns
};
