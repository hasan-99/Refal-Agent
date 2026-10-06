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

// REFAL-AGENT-011: named, reusable threshold presets — the single place all
// three callers (ai.js's model-direct path, agentLoop.js's Agent respond
// step, and agentLoop.js's Agent clarify step) get their length/question
// knobs from, instead of each hand-duplicating the same literal. The safety
// checks below (internal reasoning, prohibited claim, contact/handover/
// booking-action claims, sensitive-value echo) are NOT configurable by any
// of these presets — they always run, which is what makes the legacy and
// Agent paths enforce identical safety behavior even though they differ in
// how long or how terse a reply may be.
const MODEL_DRAFT_THRESHOLDS = Object.freeze({ minSentences: 1, maxSentences: 5, maxQuestions: 1, maxChars: 500 });
const AGENT_CLARIFY_THRESHOLDS = Object.freeze({ minSentences: 0, maxSentences: 2, maxQuestions: 1, maxChars: 300 });
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
  /(?:تعليمات\s*(?:داخلية|النظام)|موجه\s*النظام|سلسلة\s*التفكير|التفكير\s*الداخلي|ملاحظات\s*داخلية)/iu,
  /(?:درجة\s*(?:التأهيل|الأولوية)|تصنيف\s*(?:العميل|الأولوية)|معرف\s*داخلي)\s*[:=]?/iu,
  // Greek equivalents.
  /(?:εσωτερικ(?:ές|ή)\s*(?:οδηγίες|σημειώσεις)|οδηγίες\s*συστήματος|αλυσίδα\s*σκέψης|εσωτερική\s*σκέψη)/iu,
  /(?:βαθμολογία\s*(?:προτεραιότητας|αξιολόγησης)|ταξινόμηση\s*(?:πελάτη|προτεραιότητας)|εσωτερικό\s*αναγνωριστικό)\s*[:=]?/iu,
  TOOL_NAME_LEAK_PATTERN
]);

const PROHIBITED_CLAIM_PATTERNS = Object.freeze([
  /\b(?:guarantee|guaranteed|certain approval|approved by the bank|will be approved|risk[- ]free|no risk)\b/i,
  /\b(?:we can secure|we will obtain|we can obtain)\b.{0,50}\b(?:permit|visa|residency|loan|approval|return|profit)\b/i,
  /\b(?:guarante|garanti|مضمون|ضمان|موافقة مضمونة|εγγυώμαι|σίγουρη έγκριση)\b/i,
  /\b(?:100\s*%|مئة بالمئة|100٪)\b/i,
  /\b(?:straightforward|standard|ordinary|simple)\s+(?:business\s+)?activity\b.{0,70}\b(?:suitable|eligible|approved|should fit|will fit|is allowed|can proceed)\b/i,
  /\b(?:activity|business activity|industry)\b.{0,60}\b(?:is suitable|is eligible|is approved|should fit|will fit|is allowed)\b/i,
  /(?:نشاط|النشاط).{0,50}(?:مناسب|مقبول|معتمد|ما في مشكلة|يمكن البدء)|(?:δραστηριότητα|κλάδος).{0,50}(?:κατάλληλη|επιλέξιμη|εγκρίνεται|μπορεί να προχωρήσει)/iu
]);

const UNCONSENTED_CONTACT_COMMITMENT = /\b(?:i|we)\s+(?:will|shall|are going to)\s+(?:contact|call|follow up|reach out|send|share)\b|\b(?:you(?:'ll|\s+will)\s+be\s+notified|we(?:'ll|\s+will)\s+(?:notify|let you know)|you\s+will\s+hear\s+back)\b|\b(?:i|we)\s+(?:have\s+)?(?:asked|requested|sent)\b.{0,100}\b(?:specialist|team|contact|follow.?up|call)\b|\b(?:i|we)(?:'|’|’)ve\s+(?:asked|requested|sent)\b.{0,100}\b(?:specialist|team|contact|follow.?up|call)\b|\b(?:they|he|she|the\s+team|the\s+specialist|a\s+specialist|someone)\s+will\s+(?:contact|call|follow up|reach out)\s+you\b|\b(?:i|we)\s+can\s+(?:pass|forward|send|share|arrange)\b.{0,100}\b(?:specialist|team|contact|follow.?up|call)\b|(?:الفريق|المختص|المختصين|حدا|شخص).{0,20}(?:رح|سوف|سيقوم|ستقوم)\s*(?:يتواصل|يتابع|يتصل)|(?:رح|سوف|سيقوم|ستقوم)\s*(?:الفريق|المختص|المختصين|حدا|شخص)?\s*(?:يتواصل|يتابع|يتصل)|(?:رح|سوف|سيتم|سنقوم|سنبلغك).{0,24}(?:إبلاغك|إعلامك|نخبرك|نبلغك)|(?:η ομάδα|ο ειδικός|θα)\s*(?:θα\s*)?(?:επικοινωνήσει|καλέσει|αναλάβει)|(?:θα επικοινωνήσει|θα σας καλέσει|θα αναλάβει|θα ενημερωθείτε|θα σας ενημερώσουμε|θα λάβετε ενημέρωση|θα μάθετε)|(?:ζητώ|ζήτησα|έχω ζητήσει|υπέβαλα αίτημα).{0,80}(?:ειδικ|ομάδα)/iu;
const HANDOVER_ACTION_CLAIM = /\b(?:i|we)(?:'|’|’)ll\s+(?:pass|forward|log|record|note|submit|send|share|arrange|request)\b.{0,100}\b(?:specialist|team|contact|follow.?up|request|interest|review|inquiry)\b|\b(?:i|we)(?:'|’|’)ve\s+(?:logged|recorded|noted|submitted)\b.{0,100}\b(?:request|interest|specialist|team|contact|follow.?up|review)\b|\b(?:i|we)\s+(?:have\s+)?(?:logged|recorded|noted|submitted)\b.{0,100}\b(?:request|interest|specialist|team|contact|follow.?up|review)\b|\b(?:your|the)\s+(?:specialist(?:[- ]review)?|team|follow.?up|contact)\s+(?:request\s+)?(?:is|has been)\s+(?:already\s+)?(?:logged|recorded|noted|submitted|sent|arranged)\b|(?:رح|سوف|سنقوم).{0,30}(?:تسجيل|تدوين|إرسال|تحويل).{0,50}(?:طلب|مختص|متابعة)|(?:طلبك|طلب المتابعة|طلب المختص).{0,50}(?:تسجل|انرسل|تم تسجيل|تم إرساله)|(?:το αίτημά σας|το αίτημα παρακολούθησης).{0,60}(?:καταγράφηκε|στάλθηκε|προωθήθηκε|ανατέθηκε)|\bθα\s+(?:σημειώσω|καταγράψω|προωθήσω|στείλω)\b.{0,80}\b(?:ειδικό|ομάδα|αίτημα|ενδιαφέρον)\b/iu;
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
const CONTACT_CAPABILITY_OFFER = /\b(?:i|we)\s+can\s+(?:pass|forward|send|share|arrange)\b.{0,100}\b(?:specialist|team|contact|follow.?up|call)\b/iu;
const EXPLICIT_PERMISSION_QUESTION = /(?:\b(?:would you like|do you want|shall i|should i)\b.{0,80}\b(?:contact|call|follow.?up|specialist|team|that|this)\b|\bif you(?:'d| would) like\b.{0,80}\b(?:contact|call|follow.?up|specialist|team|arrange)\b|\b(?:تحب|إذا بتحب|إذا بدك|هل ترغب|هل تود)\b.{0,80}(?:تواصل|اتصال|موعد|المختص|فريق|رتب|رتّب)|\b(?:θα θέλατε|αν θέλετε|θέλετε)\b.{0,80}(?:επικοινων|κλήση|ειδικό|ραντεβού|κανονίσ))/iu;

function containsUnconsentedContactCommitment(text) {
  const value = String(text || "");
  if (CONTACT_CAPABILITY_OFFER.test(value) && EXPLICIT_PERMISSION_QUESTION.test(value)) return UNCONSENTED_CONTACT_COMMITMENT.test(value.replace(CONTACT_CAPABILITY_OFFER, ""));
  return UNCONSENTED_CONTACT_COMMITMENT.test(value);
}

function sentenceCount(text) {
  const value = String(text || "").trim();
  if (!value) return 0;
  return value.split(/[.!?؟。！？]+(?:["'”»)]*)?(?=\s|$)|(?<=\p{Script=Greek});(?:["'”»)]*)?(?=\s|$)/u).map((part) => part.trim()).filter(Boolean).length;
}

function questionCount(text) {
  const value = String(text || "");
  return (value.match(/[?؟]/gu) || []).length + (value.match(/(?<=\p{Script=Greek});/gu) || []).length;
}

function findPattern(text, patterns) {
  return patterns.find((pattern) => pattern.test(String(text || ""))) || null;
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
  const prohibitedClaim = containsProhibitedClaim(text) ? PROHIBITED_CLAIM_PATTERNS[0] : null;
  const unconsentedContactCommitment = containsUnconsentedContactCommitment(text);
  const unverifiedHandoverAction = options.allowVerifiedHandoverClaim !== true && HANDOVER_ACTION_CLAIM.test(text);
  const unverifiedBookingAction = options.allowVerifiedBookingClaim !== true && BOOKING_ACTION_CLAIM.test(text);
  const sensitiveValueEcho = containsRawSecretValue(text);
  const reasons = [];
  if (!text) reasons.push("empty");
  if (text.length > maxChars) reasons.push("too_long");
  if (sentences < minSentences) reasons.push("too_few_sentences");
  if (sentences > maxSentences) reasons.push("too_many_sentences");
  if (questions > maxQuestions) reasons.push("too_many_questions");
  if (internalReasoning) reasons.push("internal_reasoning");
  if (prohibitedClaim) reasons.push("prohibited_claim");
  if (unconsentedContactCommitment) reasons.push("unconsented_contact_commitment");
  if (unverifiedHandoverAction) reasons.push("unverified_handover_action");
  if (unverifiedBookingAction) reasons.push("unverified_booking_action");
  if (sensitiveValueEcho) reasons.push("sensitive_value_echo");
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
    sensitiveValueEcho
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
  const key = String(language).toLowerCase().slice(0, 2);
  const fallbacks = {
    en: {
      price: "I understand that cost matters. We can first clarify your needs and then arrange a review of the suitable options. What budget range should we keep in mind?",
      trust: "It is reasonable to want clear information before proceeding. We can review the relevant details with you and answer your questions. What would you like us to clarify first?",
      timing: "Understood. Take the time you need; I can answer questions whenever it is useful.",
      not_ready: "Understood. You can compare options at your own pace. I can clarify a specific detail whenever useful.",
      uncertainty: "It is sensible to assess the details before deciding. We can help clarify the options and any information still needed. What is your main concern?",
      default: "I can help clarify the approved information. What part would you like to understand first?"
    },
    ar: {
      price: "أتفهم إنو موضوع التكلفة مهم. فينا أول شي نوضّح احتياجاتك وبعدين نراجع الخيارات المناسبة. شو الميزانية التقريبية يلي بدنا ناخدها بعين الاعتبار؟",
      trust: "من المنطقي إنك تحب توضح المعلومات قبل ما تتابع. فينا نراجع معك التفاصيل المتعلقة ونجاوب على أسئلتك. شو أول نقطة بدك نوضحها؟",
      timing: "تمام، خذ وقتك. فيني ساعدك بأي سؤال لما تكون جاهز.",
      not_ready: "أكيد، خذ وقتك بالمقارنة وما في داعي تستعجل. فيني وضّحلك أي تفصيل وقت ما بدك.",
      uncertainty: "من المنطقي إنك تدرس التفاصيل قبل ما تقرر. فينا نساعدك توضح الخيارات وأي معلومة لسا ناقصة. شو أكتر شي بيشغل بالك؟",
      default: "أكيد، فيني وضّحلك المعلومات المتاحة. شو النقطة اللي بدك تعرف عنها أكتر؟"
    },
    el: {
      price: "Καταλαβαίνω ότι το κόστος έχει σημασία. Μπορούμε πρώτα να διευκρινίσουμε τις ανάγκες σας και μετά να δούμε τις κατάλληλες επιλογές. Ποιο εύρος προϋπολογισμού να έχουμε υπόψη;",
      trust: "Είναι λογικό να θέλετε σαφείς πληροφορίες πριν προχωρήσετε. Μπορούμε να δούμε μαζί τις σχετικές λεπτομέρειες και να απαντήσουμε στις ερωτήσεις σας. Τι θα θέλατε να διευκρινίσουμε πρώτα;",
      timing: "Κατανοητό. Πάρτε τον χρόνο σας· μπορώ να βοηθήσω με ερωτήσεις όποτε θέλετε.",
      not_ready: "Κατανοητό. Συγκρίνετε τις επιλογές σας με τον δικό σας ρυθμό. Μπορώ να διευκρινίσω κάτι όταν το θελήσετε.",
      uncertainty: "Είναι λογικό να αξιολογήσετε τις λεπτομέρειες πριν αποφασίσετε. Μπορούμε να βοηθήσουμε να διευκρινιστούν οι επιλογές και όποια πληροφορία λείπει ακόμα. Ποιο είναι το κύριο μέλημά σας;",
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

module.exports = {
  DEFAULT_MAX_CHARS,
  DEFAULT_MIN_SENTENCES,
  DEFAULT_MAX_SENTENCES,
  DEFAULT_MAX_QUESTIONS,
  MODEL_DRAFT_THRESHOLDS,
  AGENT_CLARIFY_THRESHOLDS,
  LEGACY_RESPONSE_THRESHOLDS,
  INTERNAL_REASONING_PATTERNS,
  PROHIBITED_CLAIM_PATTERNS,
  UNCONSENTED_CONTACT_COMMITMENT,
  HANDOVER_ACTION_CLAIM,
  BOOKING_ACTION_CLAIM,
  containsUnconsentedContactCommitment,
  sentenceCount,
  questionCount,
  validateResponse,
  validateGeneratedResponse: validateResponse,
  safeFallbackData,
  buildSafeFallback: safeFallbackData,
  hasVerifiedHandoverClaim,
  hasVerifiedBookingClaim
};
