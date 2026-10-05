const DEFAULT_MAX_CHARS = 500;
const DEFAULT_MIN_SENTENCES = 2;
const DEFAULT_MAX_SENTENCES = 5;
const DEFAULT_MAX_QUESTIONS = 1;
const { containsProhibitedClaim } = require("./refalcoAnswer");

const INTERNAL_REASONING_PATTERNS = Object.freeze([
  /\b(chain of thought|chain-of-thought|reasoning|internal notes?|system prompt|developer message|hidden prompt)\b/i,
  /\b(i (?:think|believe|infer) (?:the )?(?:customer|user) (?:is|wants|needs))\b/i,
  /\b(?:confidence|classification|lead score|qualification score)\s*[:=]/i
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
    unverifiedBookingAction
  };
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
      timing: "تمام، خذ وقتك. فيني ساعدك بأي سؤال لما تكون جاهز.",
      not_ready: "أكيد، خذ وقتك بالمقارنة وما في داعي تستعجل. فيني وضّحلك أي تفصيل وقت ما بدك.",
      default: "أكيد، فيني وضّحلك المعلومات المتاحة. شو النقطة اللي بدك تعرف عنها أكتر؟"
    },
    el: {
      timing: "Κατανοητό. Πάρτε τον χρόνο σας· μπορώ να βοηθήσω με ερωτήσεις όποτε θέλετε.",
      not_ready: "Κατανοητό. Συγκρίνετε τις επιλογές σας με τον δικό σας ρυθμό. Μπορώ να διευκρινίσω κάτι όταν το θελήσετε.",
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
  buildSafeFallback: safeFallbackData
};
