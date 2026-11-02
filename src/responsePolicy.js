const DEFAULT_MAX_CHARS = 500;
// REFAL-AGENT-011: lowered from 2. No production caller ever relied on this
// default — ai.js, messageRouter.js, and agentLoop.js have always passed an
// explicit minSentences (1 or 0), so a "require 2 sentences" default was
// unreachable, misleading dead weight rather than an actual product
// requirement. A concise, correct one-sentence answer (e.g. "No, we don't
// currently offer that.") must remain valid for any future caller that omits
// the option too.
const DEFAULT_MIN_SENTENCES = 0;
const DEFAULT_MAX_SENTENCES = 5;
const DEFAULT_MAX_QUESTIONS = 1;
const { containsProhibitedClaim } = require("./refalcoAnswer");
const { containsRawSecretValue } = require("./sensitiveData");
const { containsLabeledSensitiveValue } = require("./sensitiveOutputPolicy");
const { requestsForbiddenCredential } = require("./privacyHardRule");

// REFAL-AGENT-011: named, reusable threshold presets — the single place all
// three callers (ai.js's model-direct path, agentLoop.js's Agent respond
// step, and agentLoop.js's Agent clarify step) get their length/question
// knobs from, instead of each hand-duplicating the same literal. The safety
// checks below (internal reasoning, prohibited claim, contact/handover/
// booking-action claims, sensitive-value echo) are NOT configurable by any
// of these presets — they always run, which is what makes the legacy and
// Agent paths enforce identical safety behavior even though they differ in
// how long or how terse a reply may be.
// W1.4.3 — the ORDINARY budget. This was `maxChars: 500` alongside
// `maxSentences: 5`, which is self-contradictory: five well-formed sentences do
// not fit in 500 characters, and the mismatch is worse in Arabic and Greek where
// the same content runs longer than English. The practical effect was that a
// correct, compliant five-sentence reply got rejected as "too_long" and the
// model was retried until it produced something thinner than the rules asked
// for. 700 makes the sentence ceiling actually reachable.
//
// Deliberately NOT raised further: the point of the budget is brevity, and
// EXPANDED (1800) already exists for an explicit request for detail.
const MODEL_DRAFT_THRESHOLDS = Object.freeze({ minSentences: 1, maxSentences: 5, maxQuestions: 1, maxChars: 700 });
// Ordinary benefit questions should stay brief even when they also ask about
// tax or residency. Explicit requests for detail still use the expanded budget.
const BENEFIT_REPLY_THRESHOLDS = Object.freeze({ minSentences: 1, maxSentences: 3, maxQuestions: 1, maxChars: 500 });
// A customer can explicitly request several package facts at once (price,
// inclusions, offer, timing, ongoing fees, and exclusions). Twelve sentences
// made the validated reply budget narrower than the content contract and
// caused the Agent to discard grounded answers as a generic fallback. Keep
// the character cap as the primary size bound while allowing those complete
// multi-part answers to fit.
const AGENT_SUMMARY_THRESHOLDS = Object.freeze({ minSentences: 1, maxSentences: 16, maxQuestions: 1, maxChars: 1800 });
const AGENT_CLARIFY_THRESHOLDS = Object.freeze({ minSentences: 0, maxSentences: 2, maxQuestions: 1, maxChars: 300 });
const EXPLICIT_DETAIL_REQUEST = /\b(?:full details|all the details|all (?:the )?information|more details|in detail|detailed overview|detailed explanation|breakdown|step by step|summari[sz]e|summary|overview|what(?:'s| is) included|what does .{0,40} include|list all)\b|تفاصيل(?:\s+(?:كاملة|أكثر|اكتر))?|بالتفصيل|(?:شو|ماذا|ما الذي).{0,20}(?:بتشمل|بيشمل|يشمل|تشمل|يتضمن|تتضمن)|(?:اشرح|شرح).{0,24}(?:الخدمة|الباقة|التأسيس)|خطوة\s*بخطوة|(?:لخّص|لخص|تلخيص|ملخّص|ملخص|تلخّص|تلخص|رتّب|رتب).{0,32}(?:لي|ليّ|لنا|الباقة|الخدمة|المعلومات|التفاصيل|كل)|كل\s+(?:المعلومات|التفاصيل)|(?:αναλυτικά|λεπτομέρειες|όλες τις λεπτομέρειες|τι περιλαμβάνει|αναλυτική παρουσίαση|σύνοψη|συνοψίστε)/iu;

// Distinct requested topics can need a structured answer even when the
// customer does not literally ask for "details". This affects length only;
// it does not decide facts, eligibility, or what evidence is approved.
const REQUEST_ASPECTS = [
  /\b(?:tax|taxes|vat)\b|الضرايب|الضرائب|ضريبة|ضرايب|φορολογ|φόρος/iu,
  /\b(?:price|costs?|fees?|expenses?|charges?)\b|سعر|تكلف|رسوم|مصاريف|مصاويف|έξοδα|κόστος|χρεώσεις/iu,
  /\b(?:steps?|process|procedure|requirements?)\b|الخطوات|خطوات|إجراءات|الاجراءات|متطلبات|διαδικασία|βήματα/iu,
  /\b(?:duration|timeline|how long)\b|المدة|مدة|قديش الوقت|διάρκεια/iu,
  /\b(?:included|inclusions|excluded|exclusions|services)\b|المشمول|تشمل|يشمل|غير مشمول|الخدمات|περιλαμβάνει|υπηρεσίες/iu
];

function requestsExpandedAnswer(message) {
  const text = String(message || "").normalize("NFKC");
  const asksPackageBreakdown = /\b(?:package|bundle|formation package)\b|باقة|حزمة|πακέτ\p{L}*/iu.test(text)
    && /\b(?:include[sd]?|inclusions?|cover(?:ed|s)?)\b|داخل|تشمل|يشمل|περιλαμβάν\p{L}*/iu.test(text)
    && /\b(?:exclude[sd]?|exclusions?|not included|doesn['’]?t include)\b|ما\s*بتشمل|ما\s*يشمل|لا\s*تشمل|غير\s*شامل|δεν\s+περιλαμβάν\p{L}*|τι\s+δεν\s+περιλαμβάν\p{L}*/iu.test(text);
  return EXPLICIT_DETAIL_REQUEST.test(text) || asksPackageBreakdown || REQUEST_ASPECTS.filter(pattern => pattern.test(text)).length >= 3;
}

function responseThresholdsForMessage(message) {
  if (requestsExpandedAnswer(message)) return AGENT_SUMMARY_THRESHOLDS;
  const text = String(message || "").normalize("NFKC");
  if (/\b(?:benefits?|advantages?)\b|الفوائد|فوائد|مزايا|ميزة|شو\s+بستفيد|πλεονεκτήματ\p{L}*|οφέλη/iu.test(text)) return BENEFIT_REPLY_THRESHOLDS;
  return MODEL_DRAFT_THRESHOLDS;
}
// Legacy deterministic replies (messageRouter.js) are allowed more room: many
// are multi-part (e.g. an existing-client notice plus a follow-up question)
// and are composed by code, not a model, so the stricter model-draft length
// budget does not apply.
const LEGACY_RESPONSE_THRESHOLDS = Object.freeze({ minSentences: 0, maxSentences: 8, maxQuestions: 1, maxChars: 1000 });

// REFAL-AGENT-011: the tool registry's own names, duplicated here as a short
// literal list rather than imported from agentTools.js, because importing it
// would be circular (agentTools.js -> agentBookingTools.js -> booking.js ->
// messageRouter.js -> responsePolicy.js). Keep in sync with agentTools.js's
// TOOL_REGISTRY keys if a tool is ever renamed or added.
const TOOL_NAME_LEAK_PATTERN = /\b(?:searchApprovedKnowledge|getCustomerContext|saveCustomerFact|proposeHandover|getBookingAvailability|requestBookingAction)\b/;

const INTERNAL_REASONING_PATTERNS = Object.freeze([
  /\b(chain of thought|chain-of-thought|reasoning|internal notes?|system prompt|developer message|hidden prompt)\b/i,
  /\b(i (?:think|believe|infer) (?:the )?(?:customer|user) (?:is|wants|needs))\b/i,
  // REFAL-AGENT-011: merged in from ai.js's own separate, narrower internal-
  // reasoning regex (now removed there) — self-narrated planning phrases a
  // model sometimes leaks ("the user is asking...", "let me check...").
  /\b(?:the user (?:is asking|asks|wants)|i need to (?:answer|respond)|let me (?:check|think|review)|my (?:reasoning|analysis)|first,? i (?:need|should|will)|we need to answer)\b/i,
  /\b(?:confidence|classification|lead score|qualification score|priority label|routing decision|internal (?:id|review|source id))\s*[:=]/i,
  // Arabic equivalents of the same concepts (hidden/internal instructions,
  // chain-of-thought, internal scoring/labels) — internal-reasoning leakage
  // is not an English-only failure mode.
  /(?:تعليمات\s*(?:داخلية|النظام|سرية)|تعليماتك\s*(?:السرية|الخاصة)|الموجه\s*(?:الخفي|السري)|سلسلة\s*التفكير|التفكير\s*الداخلي|ملاحظات\s*داخلية)/iu,
  /(?:درجة\s*(?:التأهيل|الأولوية)|تصنيف\s*(?:العميل|الأولوية)|معرف\s*داخلي)\s*[:=]?/iu,
  // Greek equivalents.
  /(?:εσωτερικ(?:ές|ή)\s*(?:οδηγίες|σημειώσεις)|(?:κρυφ(?:ές|ή)|μυστικ(?:ές|ή))\s+οδηγί(?:ες|α)|οδηγίες\s*συστήματος|αλυσίδα\s*σκέψης|εσωτερική\s*σκέψη)/iu,
  /(?:βαθμολογία\s*(?:προτεραιότητας|αξιολόγησης)|ταξινόμηση\s*(?:πελάτη|προτεραιότητας)|εσωτερικό\s*αναγνωριστικό)\s*[:=]?/iu,
  /\b(?:your|lead|need|value|readiness)\s+(?:need\s+|value\s+|readiness\s+)?score\s*(?:is|:|=)?\s*[0-5](?:\s*(?:\/|out of)\s*5)?\b|\b(?:hot|warm|cold|strategic)\s+(?:lead|customer)\b/iu,
  /(?:أنت\s*(?:عميل\s*)?(?:ساخن|دافئ|بارد)|درجة\s*(?:الاحتياج|القيمة|الجاهزية)\s*(?:هي|:|=)?\s*[٠-٥0-5](?:\s*من\s*٥)?)/iu,
  /\b(?:hot|warm|cold|strategic)\s+lead\b|\b(?:need|value|readiness)\s*(?:score|:)?\s*[0-5]\s*\/\s*5\b|είσαι\s+(?:hot|warm|cold)\s+lead/iu,
  TOOL_NAME_LEAK_PATTERN
]);

const PROHIBITED_CLAIM_PATTERNS = Object.freeze([
  /\b(?:guarantee|guaranteed|certain approval|approved by the bank|will be approved|risk[- ]free|no risk)\b/i,
  /\b(?:we can secure|we will obtain|we can obtain)\b.{0,50}\b(?:permit|visa|residency|loan|approval|return|profit)\b/i,
  // ⚠ THIS ARRAY DOES NOT MATCH ANYTHING. Verified 2026-10-09.
  //
  // `validateResponse` below calls refalcoAnswer's `containsProhibitedClaim` and
  // uses `PROHIBITED_CLAIM_PATTERNS[0]` only as a LABEL for the failure reason.
  // No element of this array is ever tested against a response. The live
  // enforcement — including the Arabic and Greek guarantee terms — lives in
  // `containsProhibitedClaim` in refalcoAnswer.js, and that is where a new
  // prohibited claim must be added.
  //
  // The array is kept rather than deleted because it documents the intended
  // claim taxonomy and something outside this repo may import it (it is
  // exported). The \b placement below was also fixed in passing so it is not
  // copied as a template: \b is ASCII-only in JavaScript, so the original
  // `\b(?:guarante|…|مضمون|…)\b` could not have matched even if it were wired
  // up, and `100\s*%\b` could never match in any language because `%` is not a
  // word character.
  /\b(?:guarante|garanti)/i,
  /(?:مضمون|ضمان|موافقة مضمونة|εγγυώμαι|σίγουρη έγκριση)/iu,
  /\b100\s*(?:%|٪)|(?:مئة بالمئة|مائة بالمائة|εκατό τοις εκατό)/iu,
  /\b(?:straightforward|standard|ordinary|simple)\s+(?:business\s+)?activity\b.{0,70}\b(?:suitable|eligible|approved|should fit|will fit|is allowed|can proceed)\b/i,
  /\b(?:activity|business activity|industry)\b.{0,60}\b(?:is suitable|is eligible|is approved|should fit|will fit|is allowed)\b/i,
  /(?:نشاط|النشاط).{0,50}(?:مناسب|مقبول|معتمد|ما في مشكلة|يمكن البدء)|(?:δραστηριότητα|κλάδος).{0,50}(?:κατάλληλη|επιλέξιμη|εγκρίνεται|μπορεί να προχωρήσει)/iu
]);

const UNCONSENTED_CONTACT_COMMITMENT = /\b(?:i|we)\s+(?:will|shall|are going to)\s+(?:contact|call|follow up|reach out|send|share)\b|\b(?:you(?:'ll|\s+will)\s+be\s+notified|we(?:'ll|\s+will)\s+(?:notify|let you know)|you\s+will\s+hear\s+back)\b|\b(?:i|we)\s+(?:have\s+)?(?:asked|requested|sent)\b.{0,100}\b(?:specialist|team|contact|follow.?up|call)\b|\b(?:i|we)(?:'|’|’)ve\s+(?:asked|requested|sent)\b.{0,100}\b(?:specialist|team|contact|follow.?up|call)\b|\b(?:they|he|she|the\s+team|the\s+specialist|a\s+specialist|someone)\s+will\s+(?:contact|call|follow up|reach out)\s+you\b|\b(?:i|we)\s+can\s+(?:pass|forward|send|share|arrange)\b.{0,100}\b(?:specialist|team|contact|follow.?up|call)\b|(?:الفريق|المختص|المختصين|حدا|شخص).{0,20}(?:رح|سوف|سيقوم|ستقوم)\s*(?:يتواصل|يتابع|يتصل)|(?:رح|سوف|سيقوم|ستقوم)\s*(?:الفريق|المختص|المختصين|حدا|شخص)?\s*(?:يتواصل|يتابع|يتصل)|(?:رح|سوف|سيتم|سنقوم|سنبلغك).{0,24}(?:إبلاغك|إعلامك|نخبرك|نبلغك)|(?:η ομάδα|ο ειδικός|θα)\s*(?:θα\s*)?(?:επικοινωνήσει|καλέσει|αναλάβει)|(?:θα επικοινωνήσει|θα σας καλέσει|θα αναλάβει|θα ενημερωθείτε|θα σας ενημερώσουμε|θα λάβετε ενημέρωση|θα μάθετε)|(?:ζητώ|ζήτησα|έχω ζητήσει|υπέβαλα αίτημα).{0,80}(?:ειδικ|ομάδα)/iu;
const HANDOVER_ACTION_CLAIM = /\b(?:i|we)(?:'|’|’)ll\s+(?:pass|forward|log|record|note|submit|send|share|arrange|request)\b.{0,100}\b(?:specialist|team|contact|follow.?up|request|interest|review|inquiry)\b|\b(?:i|we)(?:'|’|’)ve\s+(?:logged|recorded|noted|submitted)\b.{0,100}\b(?:request|interest|specialist|team|contact|follow.?up|review)\b|\b(?:i|we)\s+(?:have\s+)?(?:logged|recorded|noted|submitted)\b.{0,100}\b(?:request|interest|specialist|team|contact|follow.?up|review)\b|\b(?:your|the)\s+(?:specialist(?:[- ]review)?|team|follow.?up|contact)\s+(?:request\s+)?(?:is|has been)\s+(?:already\s+)?(?:logged|recorded|noted|submitted|sent|arranged)\b|(?:رح|سوف|سنقوم).{0,30}(?:تسجيل|تدوين|إرسال|تحويل).{0,50}(?:طلب|مختص|متابعة)|(?:طلبك|طلب المتابعة|طلب المختص).{0,50}(?:تسجل|انرسل|تم تسجيل|تم إرساله)|(?:το αίτημά σας|το αίτημα παρακολούθησης).{0,60}(?:καταγράφηκε|στάλθηκε|προωθήθηκε|ανατέθηκε)|θα\s+(?:σημειώσω|καταγράψω|προωθήσω|στείλω).{0,80}(?:ειδικό|ομάδα|αίτημα|ενδιαφέρον)/iu;
// REFAL-AGENT-009. Same shape and placement as HANDOVER_ACTION_CLAIM, for the
// booking equivalent: any claim that a meeting has actually been booked,
// confirmed or scheduled. Gated by options.allowVerifiedBookingClaim, which is
// only ever passed once a booking tool has reported a real, persisted success
// — so by default a booking-completed claim can never reach a customer.
// Covers first person ("I've booked your appointment"), third person /
// passive ("your appointment is confirmed", "the meeting is set") and
// contractions ("it's confirmed") — the Ticket 008 lesson that a
// first-person-only pattern is not enough.
const BOOKING_ACTION_CLAIM = /\b(?:i|we)(?:'|’|’)(?:ll|ve)\s+(?:book|booked|schedule|scheduled|confirm|confirmed|reserve|reserved|arrange|arranged|set\s+up)\b[^.?!؟]{0,60}\b(?:appointment|meeting|call|slot|booking|time)\b|\b(?:i|we)\s+(?:will|have|had)?\s*(?:book|booked|schedule|scheduled|confirm|confirmed|reserve|reserved|arranged)\b[^.?!؟]{0,60}\b(?:appointment|meeting|call|slot|booking)\b|\b(?:your|the|this|that)\s+(?:appointment|meeting|booking|slot|call|session)\b[^.?!؟]{0,40}?\b(?:is|are|was|has\s+been|have\s+been)\s+(?:now\s+)?(?:booked|confirmed|scheduled|reserved|arranged|set|locked\s+in)\b|\byou(?:'|’|’)re\s+(?:all\s+set|confirmed|booked|scheduled)\b|\byou\s+are\s+(?:all\s+set|confirmed|booked|scheduled)\b|\b(?:it|that|this)(?:'|’|’)s\s+(?:now\s+)?(?:confirmed|booked|scheduled|reserved)\b|\b(?:booked|confirmed|scheduled)\s+you\s+(?:in|for)\b|(?:تم|تمّ)\s*(?:تأكيد|حجز|تثبيت|ترتيب)\s*(?:ال)?(?:موعد|موعدك|اجتماع|اجتماعك|الموعد|الاجتماع)|(?:موعدك|الموعد|اجتماعك|الاجتماع)\s*(?:مؤكد|محجوز|مثبّت|مثبت|تأكد|انحجز)|(?:حجزت|حجزنا|أكدت|اكدت|ثبتت|ثبّت)\s*(?:لك|لكم)?\s*(?:ال)?(?:موعد|اجتماع)|(?:رح|سوف|سأ|سن)\s*(?:أحجز|احجز|نحجز|حجز|أؤكد|اؤكد|نؤكد|ؤكد|أثبت|اثبت)|(?:το\s+)?ραντεβού\s*(?:σας)?\s*(?:έχει\s+)?(?:επιβεβαιώθηκε|επιβεβαιωθεί|επιβεβαιωμένο|κλείστηκε|κλειστεί|κλεισμένο|προγραμματίστηκε|προγραμματιστεί|οριστικοποιήθηκε|οριστικοποιηθεί)|(?:έκλεισα|κλείσαμε|επιβεβαίωσα|επιβεβαιώσαμε|έχω κλείσει)\s+(?:το\s+)?ραντεβού|θα\s+(?:κλείσω|κλείσουμε|επιβεβαιώσω|επιβεβαιώσουμε)\s+(?:το\s+)?ραντεβού/iu;
const NEGATED_ARABIC_BOOKING_SUGGESTION = /(?:ما|مش|مو)\s*(?:رح|سوف|سأ|سن)\s*(?:أقترح|اقترح|نقترح)\s+(?:ال)?(?:قيام\s+ب)?(?:حجز|ترتيب)(?:[ًٌٍ]?ا?)\s*(?:(?:ال)?(?:موعد|اجتماع)(?:\s+(?:حالياً|حاليًا|هلأ|الآن))?)?/giu;

function containsUnverifiedBookingAction(text) {
  const withoutNegatedSuggestion = String(text || "").replace(NEGATED_ARABIC_BOOKING_SUGGESTION, "");
  return BOOKING_ACTION_CLAIM.test(withoutNegatedSuggestion);
}

const CONTACT_CAPABILITY_OFFER = /\b(?:i|we)\s+can\s+(?:pass|forward|send|share|arrange)\b.{0,100}\b(?:specialist|team|contact|follow.?up|call)\b/iu;
const EXPLICIT_PERMISSION_QUESTION = /(?:\b(?:would you like|do you want|shall i|should i)\b.{0,80}\b(?:contact|call|follow.?up|specialist|team|that|this)\b|\bif you(?:'d| would) like\b.{0,80}\b(?:contact|call|follow.?up|specialist|team|arrange)\b|(?:تحب|إذا بتحب|إذا بدك|هل ترغب|هل تود).{0,80}(?:تواصل|اتصال|موعد|المختص|فريق|رتب|رتّب)|(?:θα θέλατε|αν θέλετε|θέλετε).{0,80}(?:επικοινων|κλήση|ειδικό|ραντεβού|κανονίσ))/iu;

const CONSTRUCTION_TENDER_MESSAGE = /\b(?:construction\s+tender|tender\s+(?:for\s+)?(?:construction|building)|(?:construction|building)\s+tender|bill\s+of\s+quantities|boq)\b|مناقصة\s*(?:إنشاء|بناء|عقارية)?|جدول\s+الكميات|κατασκευαστικ(?:ός|ή|ό)\s+διαγωνισμ(?:ός|ό|ο)|διαγωνισμ(?:ός|ό|ο)\s+κατασκευ/iu;
const CONSTRUCTION_PRICE_ESTIMATE = /(?:€|\$|£|\beur\b|\busd\b|\bprice\b|\bcost\b|\bestimat(?:e|ion)\b|\bquote\b|\bbid\b)|(?:θα κοστίσει|τιμή|κόστος|προσφορά|εκτίμηση)|(?:السعر|التكلفة|تقدير|عرض سعر|يورو|دولار)/iu;

function containsProhibitedConstructionEstimate(customerMessage, response) {
  return CONSTRUCTION_TENDER_MESSAGE.test(String(customerMessage || ""))
    && CONSTRUCTION_PRICE_ESTIMATE.test(String(response || ""));
}

function containsUnconsentedContactCommitment(text) {
  const value = String(text || "");
  if (CONTACT_CAPABILITY_OFFER.test(value) && EXPLICIT_PERMISSION_QUESTION.test(value)) return UNCONSENTED_CONTACT_COMMITMENT.test(value.replace(CONTACT_CAPABILITY_OFFER, ""));
  return UNCONSENTED_CONTACT_COMMITMENT.test(value);
}

function sentenceCount(text) {
  // A numbered-list prefix is a visual marker, not a sentence. Remove only
  // line-leading item numbers so decimals and punctuation within prose remain
  // part of the sentence count.
  const value = String(text || "").replace(/(^|\n)[\t ]*\d+[.)][\t ]+/gu, "$1").trim();
  if (!value) return 0;
  return value.split(/[.!?؟。！？]+(?:["'”»)]*)?(?=\s|$)|(?<=\p{Script=Greek})[;;](?:["'”»)]*)?(?=\s|$)/u).map((part) => part.trim()).filter(Boolean).length;
}

function responseSentenceParts(text) {
  const value = String(text || "").trim();
  if (!value) return [];
  const parts = [];
  const boundary = /[.!?؟。！？]+(?:["'”»)]*)?(?=\s|$)|(?<=\p{Script=Greek})[;;](?:["'”»)]*)?(?=\s|$)/gu;
  let start = 0;
  let match;
  while ((match = boundary.exec(value))) {
    const lineStart = value.lastIndexOf("\n", match.index - 1) + 1;
    const linePrefix = value.slice(lineStart, match.index);
    // Numbered-list markers are formatting, not sentence boundaries.
    if (match[0].startsWith(".") && /^\s*\d+$/u.test(linePrefix)) continue;
    const end = match.index + match[0].length;
    const part = value.slice(start, end).trim();
    if (part) parts.push(part);
    start = end;
  }
  const tail = value.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

// Repair formatting-only failures without asking the model to restate facts.
// Complete sentence content is preserved when possible; if the character cap
// makes that impossible, retain the longest complete leading portion and let
// the normal factual/safety gates validate it before delivery.
function formatResponseWithinLimits(text, thresholds = {}, language = "en", { preserveAllContent = false } = {}) {
  const maxChars = Number.isInteger(thresholds.maxChars) ? thresholds.maxChars : DEFAULT_MAX_CHARS;
  const maxSentences = Number.isInteger(thresholds.maxSentences) ? thresholds.maxSentences : DEFAULT_MAX_SENTENCES;
  const minSentences = Number.isInteger(thresholds.minSentences) ? thresholds.minSentences : DEFAULT_MIN_SENTENCES;
  const original = String(text || "").trim();
  const parts = responseSentenceParts(original);
  if (!parts.length || (parts.length === 1 && original.length > maxChars)) return null;
  const locale = languagePackKey(language);
  const separator = locale === "ar" ? "؛ " : locale === "el" ? ", " : "; ";
  const join = (items) => {
    let result = "";
    for (let index = 0; index < items.length; index += 1) {
      const part = items[index];
      if (index === items.length - 1) { result += part; break; }
      const next = items[index + 1];
      // Keep a final question as its own readable paragraph.
      if (/[?؟]$/u.test(next)) { result += `${part}\n\n`; continue; }
      // Preserve visible list structure while joining sentence boundaries.
      const nextIsListItem = /^\s*(?:[-*•]|\d+[.)])\s+/u.test(next);
      if (/[?؟]$/u.test(part)) {
        result += `${part}${nextIsListItem ? "\n" : " "}`;
        continue;
      }
      result += `${part.replace(/[.!。！？]+["'”»)]*$/u, "")}${separator.trimEnd()}${nextIsListItem ? "\n" : " "}`;
    }
    return result.trim();
  };

  // Try the fullest complete prefix first, so we only omit content when the
  // active character budget requires it. Joining sentence boundaries keeps
  // every claim and its conditions while satisfying the sentence budget.
  for (let count = parts.length; count >= (preserveAllContent ? parts.length : 1); count -= 1) {
    const candidate = join(parts.slice(0, count));
    const finalText = /[.!?؟。！？]$/u.test(candidate) ? candidate : `${candidate}.`;
    const sentences = sentenceCount(finalText);
    if (finalText !== original && sentences <= maxSentences
      && sentences >= minSentences && finalText.length <= maxChars) return finalText;
  }
  return null;
}

function questionCount(text) {
  const value = String(text || "");
  return (value.match(/[?؟]/gu) || []).length + (value.match(/(?<=\p{Script=Greek})[;;]/gu) || []).length;
}

/**
 * W1.4.2 — are the two questions in this text tightly coupled?
 *
 * Lives here rather than in goldenFormula.js to avoid a require cycle:
 * goldenFormula already depends on this module for sentence/question counting,
 * so the dependency may only run one way.
 */
function questionsAreCoupled(text) {
  const value = String(text || "").trim();
  if (!value) return false;
  if (questionCount(value) !== 2) return false;

  const firstMark = value.search(/[?؟]|(?<=\p{Script=Greek})[;;]/u);
  if (firstMark === -1) return false;
  const second = value.slice(firstMark + 1).trim();
  if (!second) return false;

  // The Greek branch uses a whitespace lookahead, NOT \b: \b is ASCII-only in
  // JavaScript, so `/^(?:και|ή)\b/` can never match.
  const conjunctionLed = /^(?:and|or)\b/iu.test(second)
    || /^(?:و|أو)/u.test(second)
    || /^(?:και|ή)(?=\s|$)/iu.test(second);
  if (!conjunctionLed) return false;

  // Being conjunction-led is NOT enough on its own, and assuming it was made
  // this rule fail open in Arabic specifically: Arabic writes the conjunction
  // attached to the following word (وامتى = "and when"), so almost any second
  // Arabic question looks conjunction-led. "What is your budget? And when do you
  // start?" would have slipped through as "coupled" in Arabic while being
  // correctly rejected in English — the exact language asymmetry this codebase
  // keeps getting bitten by.
  //
  // Genuine coupling narrows ONE decision, which in practice means the second
  // question offers alternatives to choose between ("...residential or
  // commercial?"). A second question that introduces a new subject is a second
  // topic, however it is introduced.
  const offersAlternatives = /\bor\b/iu.test(second)
    || /(?:^|\s)(?:أو|او)(?:\s|$)/u.test(second)
    || /(?:^|\s)ή(?:\s|$)/iu.test(second);
  if (!offersAlternatives) return false;

  // A long second question is a second topic however it is introduced.
  return second.length <= 70;
}

function findPattern(text, patterns) {
  return patterns.find((pattern) => pattern.test(String(text || ""))) || null;
}

function containsForbiddenCredentialRequest(text, customerMessage = "", recentConversation = []) {
  return requestsForbiddenCredential(text, { customerMessage, recentConversation }).violation;
}

function validateResponse(response, options = {}) {
  const text = String(response || "").trim();
  const minSentences = Number.isInteger(options.minSentences) ? options.minSentences : DEFAULT_MIN_SENTENCES;
  const maxSentences = Number.isInteger(options.maxSentences) ? options.maxSentences : DEFAULT_MAX_SENTENCES;
  const maxChars = Number.isInteger(options.maxChars) ? options.maxChars : DEFAULT_MAX_CHARS;
  const maxQuestions = Number.isInteger(options.maxQuestions) ? options.maxQuestions : DEFAULT_MAX_QUESTIONS;
  const sentences = sentenceCount(text);
  const questions = questionCount(text);
  const internalReasoning = findPattern(text, INTERNAL_REASONING_PATTERNS);
  // P2.2 — `options.evidence` is optional and defaults to the pre-M2 blanket
  // behaviour, so every existing caller is unaffected. A caller that HAS the
  // approved chunks passes them and an approved programme fact survives.
  const prohibitedClaim = containsProhibitedClaim(text, { evidence: options.evidence, language: options.language, semanticGrounding: options.semanticGrounding }) ? PROHIBITED_CLAIM_PATTERNS[0] : null;
  const unconsentedContactCommitment = options.allowVerifiedHandoverClaim !== true && containsUnconsentedContactCommitment(text);
  const unverifiedHandoverAction = options.allowVerifiedHandoverClaim !== true && HANDOVER_ACTION_CLAIM.test(text);
  const unverifiedBookingAction = options.allowVerifiedBookingClaim !== true && containsUnverifiedBookingAction(text);
  const sensitiveValueEcho = containsRawSecretValue(text) || containsLabeledSensitiveValue(text);
  const forbiddenCredentialRequest = containsForbiddenCredentialRequest(text, options.customerMessage, options.recentConversation);
  const constructionPriceEstimate = options.customerMessage
    ? containsProhibitedConstructionEstimate(options.customerMessage, text)
    : false;
  const reasons = [];
  if (!text) reasons.push("empty");
  if (text.length > maxChars) reasons.push("too_long");
  if (sentences < minSentences) reasons.push("too_few_sentences");
  if (sentences > maxSentences) reasons.push("too_many_sentences");
  // W1.4.2 — the One Question Rule, with the coupling exception.
  //
  // Two questions are permitted ONLY when the second is a short, conjunction-led
  // follow-on that narrows the same decision ("Which city? And is it
  // residential or commercial?"). A second topic is an interrogation however it
  // is phrased, and three questions never qualify.
  //
  // This is a REJECTION, not a warning: "too_many_questions" already fails the
  // response, and the exception only ever widens the allowance from one to two.
  // Note a single question mark joining two interrogatives ("Which city, and is
  // it residential?") counts as ONE question and never needs the exception.
  if (questions > maxQuestions) {
    const coupledAllowed = maxQuestions === 1 && questions === 2 && questionsAreCoupled(text);
    if (!coupledAllowed) reasons.push("too_many_questions");
  }
  if (internalReasoning) reasons.push("internal_reasoning");
  if (prohibitedClaim) reasons.push("prohibited_claim");
  if (unconsentedContactCommitment) reasons.push("unconsented_contact_commitment");
  if (unverifiedHandoverAction) reasons.push("unverified_handover_action");
  if (unverifiedBookingAction) reasons.push("unverified_booking_action");
  if (sensitiveValueEcho) reasons.push("sensitive_value_echo");
  if (forbiddenCredentialRequest) reasons.push("forbidden_credential_request");
  if (constructionPriceEstimate) reasons.push("construction_pricing_prohibited");
  return {
    valid: reasons.length === 0,
    text,
    sentenceCount: sentences,
    questionCount: questions,
    characterCount: text.length,
    reasons,
    internalReasoning: Boolean(internalReasoning),
    prohibitedClaim: Boolean(prohibitedClaim),
    unconsentedContactCommitment,
    unverifiedHandoverAction,
    unverifiedBookingAction,
    sensitiveValueEcho,
    forbiddenCredentialRequest,
    constructionPriceEstimate
  };
}

// REFAL-AGENT-011: moved here from messageRouter.js (and joined by the new
// hasVerifiedBookingClaim) so every caller reads "is this verified claim
// allowed" from the same policy surface that enforces it. Both only ever
// read deterministic, already-persisted metadata set by code that observed
// a real outcome (a consent-bound handover record, a booking tool's/
// booking.js's confirmed status) — never anything the model wrote.
function hasVerifiedHandoverClaim(metadata = {}) {
  const purposeBoundConsent = metadata.specialistFollowUp?.consented === true && metadata.specialistFollowUp?.purpose === "specialist_follow_up";
  const persistedHandover = Boolean(metadata.handover?.routing && metadata.handover?.summary) || metadata.handoverAlreadyRecorded === true;
  return purposeBoundConsent && persistedHandover;
}

// REFAL-AGENT-011: the booking equivalent — was entirely missing from the
// legacy path. messageRouter.js's recordHistory validated every response
// against BOOKING_ACTION_CLAIM but never had a way to mark one verified, so
// a real, deterministic booking-confirmation message from booking.js's
// bookingConfirmationMessage() always failed this gate and the conversation
// history stored a generic fallback instead of what was actually sent to the
// customer (the customer-facing WhatsApp message was unaffected — bot.js
// sends the original `response`, never the history's swapped-in fallback —
// but the stored record silently misrepresented it). `metadata.
// verifiedBookingConfirmed` is set by bot.js only from `booking.appointment?.
// status === "confirmed"`, a real store-reported status, never model text.
function hasVerifiedBookingClaim(metadata = {}) {
  return metadata.verifiedBookingConfirmed === true;
}

function safeFallbackData({ language = "en", category = "uncertainty" } = {}) {
  // Callers usually pass a two-letter locale, but the language detector and
  // several policies use the full name "greek". Slicing that value produced
  // "gr", silently selecting English for Greek fallbacks.
  const key = languagePackKey(language);
  const fallbacks = {
    en: {
      price: "I understand that cost matters. We can first clarify your needs and then arrange a review of the suitable options. What budget range should we keep in mind?",
      pricing_conflict: "I found conflicting approved prices, so I can’t confirm which currently applies. Please have the team verify it before relying on a figure.",
      trust: "It is reasonable to want clear information before proceeding. We can review the relevant details with you and answer your questions. What would you like us to clarify first?",
      timing: "Understood. Take the time you need; I can answer questions whenever it is useful.",
      not_ready: "Understood. You can compare options at your own pace. I can clarify a specific detail whenever useful.",
      uncertainty: "I don’t have approved information to confirm that detail, so I won’t guess. I can still clarify any part supported by the information we have.",
      business_information_gap: "I don’t have approved information to confirm that detail, so I won’t guess. I can still clarify any part supported by the information we have.",
      default: "I can help clarify the approved information. What part would you like to understand first?"
    },
    ar: {
      price: "أتفهم إنو موضوع التكلفة مهم. فينا أول شي نوضّح احتياجاتك وبعدين نراجع الخيارات المناسبة. شو الميزانية التقريبية يلي بدنا ناخدها بعين الاعتبار؟",
      pricing_conflict: "لقيت أسعار معتمدة متضاربة، وما بقدر أكد أي سعر بينطبق حالياً. الأفضل تتأكد من الفريق قبل ما تعتمد أي رقم.",
      trust: "من المنطقي إنك تحب توضح المعلومات قبل ما تتابع. فينا نراجع معك التفاصيل المتعلقة ونجاوب على أسئلتك. شو أول نقطة بدك نوضحها؟",
      timing: "تمام، خذ وقتك. فيني ساعدك بأي سؤال لما تكون جاهز.",
      not_ready: "أكيد، خذ وقتك بالمقارنة وما في داعي تستعجل. فيني وضّحلك أي تفصيل وقت ما بدك.",
      uncertainty: "ما عندي معلومات معتمدة بتأكد هالتفصيل، وما بدي خمّن. فيني وضّحلك أي جزء بتدعمه المعلومات المتاحة.",
      business_information_gap: "ما عندي معلومات معتمدة بتأكد هالتفصيل، وما بدي خمّن. فيني وضّحلك أي جزء بتدعمه المعلومات المتاحة.",
      default: "أكيد، فيني وضّحلك المعلومات المتاحة. شو النقطة اللي بدك تعرف عنها أكتر؟"
    },
    el: {
      price: "Καταλαβαίνω ότι το κόστος έχει σημασία. Μπορούμε πρώτα να διευκρινίσουμε τις ανάγκες σας και μετά να δούμε τις κατάλληλες επιλογές. Ποιο εύρος προϋπολογισμού να έχουμε υπόψη;",
      pricing_conflict: "Βρήκα διαφορετικές εγκεκριμένες τιμές και δεν μπορώ να επιβεβαιώσω ποια ισχύει τώρα. Καλύτερα να το ελέγξει η ομάδα πριν βασιστείτε σε κάποιο ποσό.",
      trust: "Είναι λογικό να θέλετε σαφείς πληροφορίες πριν προχωρήσετε. Μπορούμε να δούμε μαζί τις σχετικές λεπτομέρειες και να απαντήσουμε στις ερωτήσεις σας. Τι θα θέλατε να διευκρινίσουμε πρώτα;",
      timing: "Κατανοητό. Πάρτε τον χρόνο σας· μπορώ να βοηθήσω με ερωτήσεις όποτε θέλετε.",
      not_ready: "Κατανοητό. Συγκρίνετε τις επιλογές σας με τον δικό σας ρυθμό. Μπορώ να διευκρινίσω κάτι όταν το θελήσετε.",
      uncertainty: "Δεν έχω εγκεκριμένες πληροφορίες που να επιβεβαιώνουν αυτή τη λεπτομέρεια, οπότε δεν θα υποθέσω. Μπορώ να διευκρινίσω όσα υποστηρίζονται από τις διαθέσιμες πληροφορίες.",
      business_information_gap: "Δεν έχω εγκεκριμένες πληροφορίες που να επιβεβαιώνουν αυτή τη λεπτομέρεια, οπότε δεν θα υποθέσω. Μπορώ να διευκρινίσω όσα υποστηρίζονται από τις διαθέσιμες πληροφορίες.",
      default: "Μπορώ να σας εξηγήσω τις διαθέσιμες πληροφορίες. Ποιο σημείο θα θέλατε να διευκρινίσουμε;"
    }
  };
  const languagePack = fallbacks[key] || fallbacks.en;
  return {
    text: languagePack[category] || languagePack.default,
    language: key === "ar" || key === "el" ? key : "en",
    category,
    deterministic: true,
    safe: true,
    reasons: ["safe_fallback"]
  };
}

// W3.10.5 — the LOW CONFIDENCE fallback (CX 4B).
//
// Three permitted moves, and only three: ask ONE clarifying question, state the
// limitation, or route to a human. The fourth move — filling the gap from the
// model's own prose, or from the unapproved text sitting in the prompt — is the
// one this exists to prevent, so nothing the caller passes is ever interpolated
// into the returned string. `lowConfidenceFallback` takes a LANGUAGE and a
// REASON CODE, and returns one of nine fixed sentences; a reason it does not
// recognise degrades to the most conservative of them rather than echoing it.
//
// Deliberately an EXTENSION of safeFallbackData's table rather than a parallel
// set: same shape, same three languages, same `deterministic`/`safe` contract,
// so a caller can swap one for the other without learning a second surface.
const LOW_CONFIDENCE_CATEGORIES = Object.freeze({
  LOW_CONFIDENCE: "low_confidence",
  NOT_CURRENTLY_CONFIRMED: "not_currently_confirmed",
  ROUTE_TO_SPECIALIST: "route_to_specialist"
});

// The keys on the left are src/factRegister.js's `guidance` strings, verbatim.
// They are literals here rather than an import because responsePolicy.js is a
// leaf of the safety graph and must not pull in the fact catalogue, the
// taxonomy and the fact map just to pick a sentence. src/claimGroundedness.
// test.js asserts these literals still match what factRegister actually emits,
// so the copy cannot drift silently.
const LOW_CONFIDENCE_REASONS = Object.freeze({
  state_not_currently_confirmed_and_offer_specialist_follow_up: LOW_CONFIDENCE_CATEGORIES.NOT_CURRENTLY_CONFIRMED,
  unknown_fact_route_to_specialist: LOW_CONFIDENCE_CATEGORIES.ROUTE_TO_SPECIALIST,
  do_not_surface_route_to_specialist: LOW_CONFIDENCE_CATEGORIES.ROUTE_TO_SPECIALIST,
  answer_in_approved_language_or_route_to_specialist: LOW_CONFIDENCE_CATEGORIES.ROUTE_TO_SPECIALIST,
  // W3.10.8's own reason: a drafted sentence the retrieved evidence does not
  // back. Stating the limitation and asking what to check is the right move,
  // because the customer's question was understood, only unanswerable from
  // approved material.
  ungrounded_claim: LOW_CONFIDENCE_CATEGORIES.LOW_CONFIDENCE,
  no_approved_evidence: LOW_CONFIDENCE_CATEGORIES.LOW_CONFIDENCE
});

const LOW_CONFIDENCE_FALLBACKS = Object.freeze({
  en: {
    low_confidence: "I don't have approved information that confirms that, so I won't guess. Which part would you like me to check with the team?",
    not_currently_confirmed: "That detail is not currently confirmed in our approved information, so I won't state it. Would you like me to ask a specialist to confirm the current figure?",
    route_to_specialist: "I don't have approved information I can rely on for that. Would you like me to pass your question to a specialist?"
  },
  ar: {
    low_confidence: "ما عندي معلومات معتمدة بتأكد هالشي، وما بدي خمّن. شو النقطة اللي بتحب أتأكد منها مع الفريق؟",
    not_currently_confirmed: "هالتفصيل مو مأكد حالياً بالمعلومات المعتمدة عنا، وما رح أذكره. بتحب أسأل مختص يأكدلك الرقم الحالي؟",
    route_to_specialist: "ما عندي معلومات معتمدة أقدر أعتمد عليها بهالموضوع. بتحب أحوّل سؤالك لمختص؟"
  },
  el: {
    low_confidence: "Δεν έχω εγκεκριμένη πληροφορία που να το επιβεβαιώνει, οπότε δεν θα το υποθέσω. Ποιο σημείο θα θέλατε να ελέγξω με την ομάδα;",
    not_currently_confirmed: "Αυτό το στοιχείο δεν είναι επιβεβαιωμένο αυτή τη στιγμή στις εγκεκριμένες πληροφορίες, οπότε δεν θα το δηλώσω. Θέλετε να ζητήσω από ειδικό να το επιβεβαιώσει;",
    route_to_specialist: "Δεν έχω εγκεκριμένη πληροφορία στην οποία μπορώ να βασιστώ για αυτό. Θέλετε να προωθήσω την ερώτησή σας σε ειδικό;"
  }
});

// safeFallbackData above keys on `language.slice(0, 2)`, which silently sends
// GREEK to the English pack: `detectMessageLanguage` returns the WORDS
// "english" / "arabic" / "greek", and "greek".slice(0, 2) is "gr", not "el".
// Every existing caller of safeFallbackData happens to pre-map to a two-letter
// code, so that latent trap has never fired there — but src/ai.js calls this
// new function with `detectMessageLanguage`'s output directly, so it is
// resolved properly here rather than reproduced.
function languagePackKey(language) {
  const value = String(language || "").toLowerCase();
  if (value.startsWith("ar")) return "ar";
  if (value.startsWith("el") || value.startsWith("gr")) return "el";
  return "en";
}

function lowConfidenceFallback({ language = "en", reason = "ungrounded_claim" } = {}) {
  const key = languagePackKey(language);
  const pack = LOW_CONFIDENCE_FALLBACKS[key] || LOW_CONFIDENCE_FALLBACKS.en;
  // An unrecognised reason resolves to ROUTE_TO_SPECIALIST, not to the reason
  // string itself: the only safe thing to do with a confidence signal you do
  // not understand is hand the turn to a person.
  const category = LOW_CONFIDENCE_REASONS[String(reason)] || LOW_CONFIDENCE_CATEGORIES.ROUTE_TO_SPECIALIST;
  return {
    text: pack[category],
    language: key,
    category,
    reason: LOW_CONFIDENCE_REASONS[String(reason)] ? String(reason) : "unrecognized_reason",
    deterministic: true,
    safe: true,
    reasons: ["low_confidence_fallback", category]
  };
}

module.exports = {
  DEFAULT_MAX_CHARS,
  DEFAULT_MIN_SENTENCES,
  DEFAULT_MAX_SENTENCES,
  DEFAULT_MAX_QUESTIONS,
  MODEL_DRAFT_THRESHOLDS,
  BENEFIT_REPLY_THRESHOLDS,
  AGENT_SUMMARY_THRESHOLDS,
  AGENT_CLARIFY_THRESHOLDS,
  requestsExpandedAnswer,
  responseThresholdsForMessage,
  LEGACY_RESPONSE_THRESHOLDS,
  INTERNAL_REASONING_PATTERNS,
  PROHIBITED_CLAIM_PATTERNS,
  UNCONSENTED_CONTACT_COMMITMENT,
  HANDOVER_ACTION_CLAIM,
  BOOKING_ACTION_CLAIM,
  containsUnconsentedContactCommitment,
  containsProhibitedConstructionEstimate,
  sentenceCount,
  responseSentenceParts,
  formatResponseWithinLimits,
  questionCount,
  questionsAreCoupled,
  validateResponse,
  validateGeneratedResponse: validateResponse,
  safeFallbackData,
  buildSafeFallback: safeFallbackData,
  LOW_CONFIDENCE_CATEGORIES,
  LOW_CONFIDENCE_REASONS,
  LOW_CONFIDENCE_FALLBACKS,
  languagePackKey,
  lowConfidenceFallback,
  hasVerifiedHandoverClaim,
  hasVerifiedBookingClaim
};
