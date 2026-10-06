const DIMENSIONS = Object.freeze(["need", "value", "timing", "authority", "readiness", "fit"]);

// Owner rules: 14–19 warm, 20–24 hot, 25–30 strategic/priority.
const DEFAULT_THRESHOLDS = Object.freeze({ hot: 20, warm: 14, strategic: 25 });
const CONSENT_STATES = Object.freeze({ UNKNOWN: "unknown", GRANTED: "granted", DENIED: "denied", REVOKED: "revoked" });

const OPT_OUT_RE = /\b(?:stop|unsubscribe|do not contact|don't contact|dont contact|no contact|stop messaging|don't message|remove me|leave me alone|no more messages|don't follow up|do not follow up|no follow.?up)\b|لا\s*(?:تراسلني|ترسل لي|تتواصل(?:وا)?\s*معي|تتصل(?:وا)?\s*فيّ?|ترتب(?:وا)?\s*(?:أي\s*)?تواصل(?:\s+عني)?|تبعث(?:وا)?\s*(?:لي\s*)?(?:رسائل|متابعة)|تبعت(?:وا)?\s*(?:لي\s*)?(?:رسائل|متابعة)|أريد رسائل|اريد رسائل)|(?:أوقف|اوقف|إلغاء|الغاء)\s*(?:الرسائل|الاشتراك|التواصل)?|احذف\s*(?:رقمي|بياناتي)|(?:σταμάτα|σταματήστε|μη\s*μου\s*στέλνεις|μη\s*μου\s*στείλετε|διαγραφή|διαγράψτε|δεν\s*θέλω\s*μηνύματα|μην\s*επικοινωνείτε|μη\s*μου\s*στείλετε\s*μήνυμα|μην\s*επικοινωνήσετε\s+μαζί\s+μου)/iu;
// Consent is purpose-bound. A bare yes is meaningful only in the router's
// tracked-offer state machine and is never inferred from arbitrary history.
// REFAL-AGENT-014: JavaScript's \b is always ASCII-\w-based, even with the
// "u" flag — it never matches adjacent to Greek (or Arabic) script. The
// Greek branch below was wrapped in \b...\b, making it completely
// unreachable against any real Greek sentence (a Greek customer's explicit
// consent could never be recognized by this function). Fixed the same way
// OPT_OUT_RE/DENY_RE already handle their own non-Latin branches in this
// file: a bare, unanchored alternation instead of a \b-wrapped group. The
// English branch's existing \b-wrapped behavior is unchanged.
const OPT_IN_RE = /\b(?:contact me|keep me posted|follow up|you can message me|send me more|please message me|please follow up|please have (?:a|the) (?:specialist|team) (?:to\s+)?(?:contact me|follow up)|please ask (?:a|the) specialist to follow up|connect me (?:to|with) (?:someone|a human|a specialist|the team)|ask (?:a|the) specialist to contact me|(?:i|we) (?:request|ask) (?:(?:a|the)\s+)?(?:specialist|team) (?:to\s+)?(?:contact|call|follow up) me|i want (?:a )?(?:human|specialist) to contact me)\b|(?:نعم\s*(?:تواصل معي|تابع معي)|موافق(?:ة)?\s*(?:على التواصل|على المتابعة)|تواصل معي|تابع معي|أرسل لي|ارسل لي|يمكنك مراسلتي|خلي المختص يتواصل معي|خلي الفريق يتواصل معي)|(?:επικοινωνήστε μαζί μου|κρατήστε με ενήμερο|στείλτε μου|μπορείτε να επικοινωνήσετε|ζητώ\s+επικοινωνία\s+από\s+ειδικικό)/iu;
const DENY_RE = /\b(?:no thanks|no thank you|not now|don't follow up|do not follow up|no follow.?up|do not pressure me (?:to book|about (?:a )?call|to share)|don't pressure me (?:to book|about (?:a )?call|to share))\b|\b(?:don't|do not)\s+pressure\s+me\s+(?:to\s+)?(?:book|send\s+(?:my\s+)?contact\s+details|share\s+(?:my\s+)?contact\s+details)\b|(?:لا شكرًا|لا شكرا|ليس الآن|لا تتابع معي|لا أريد متابعة|لا بدي متابعة|ما بدي حدا يتواصل معي|مو موافقة.{0,50}(?:تواصل|اتصال)|مش موافقة.{0,50}(?:تواصل|اتصال)|مو موافق.{0,50}(?:تواصل|اتصال)|مش موافق.{0,50}(?:تواصل|اتصال))|(?:όχι ευχαριστώ|όχι τώρα|μην επικοινωνήσετε)/iu;

const GREEKLISH_CONTACT_DENIAL = /\bden\s+thelo\s+na\s+me\s+piesis\b.{0,140}\b(?:kleiso|stoicheia\s+epikoinonias|epikoinonias)\b/iu;

const PRIORITY_PATTERNS = Object.freeze([
  ["major_development", /\b(?:major|large|land|development|developer|construction|tender)\b|تطوير|أرض|إنشاء|مقاول|مناقصة|ανάπτυξη|κατασκευή|οικόπεδο/i],
  ["institutional_investment", /\b(?:institutional investor|family office|large investment|fund|portfolio|capital)\b|مستثمر مؤسسي|استثمار كبير|صندوق|επενδυτ(?:ής|ές)|οικογενειακό γραφείο/i],
  ["strategic_partnership", /\b(?:strategic partnership|partnership|joint venture|cross.?border|expansion)\b|شراكة استراتيجية|مشروع مشترك|توسع دولي|συνεργασία|κοινοπραξία|διασυνοριακ/i],
  ["sensitive_or_escalated", /\b(?:complaint|lawyer|legal|tax|immigration|media|reputation|existing client|sensitive)\b|شكوى|محامي|قانوني|ضريبة|هجرة|إعلام|سمعة|عميل حالي|ευαίσθητ|παράπονο|νομικ|φορολογ/i]
]);

function clampScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(5, Math.round(number)));
}

function textOfHistory(history = []) {
  return history.map((turn) => String(turn?.message || turn?.text || "")).filter(Boolean).join("\n");
}

function detectPriority(text) {
  const value = String(text || "");
  for (const [reason, pattern] of PRIORITY_PATTERNS) if (pattern.test(value)) return { priority: true, priorityReason: reason };
  return { priority: false, priorityReason: null };
}

function inferDimensions({ history = [], profile = {}, booking = null, dimensions = {} } = {}) {
  const text = textOfHistory(history);
  const lower = text.toLowerCase();
  // Recompute from customer-authored history; do not let old inferred scores become permanent facts.
  const supplied = profile.qualification?.dimensions || {};
  const source = { ...supplied, ...dimensions };
  const result = {};
  for (const dimension of DIMENSIONS) result[dimension] = clampScore(source[dimension]);

  const setAtLeast = (name, value) => { result[name] = Math.max(result[name], value); };
  if (/\b(interested|need|looking for|information|tell me more|price|pricing|cost|property|project|service)\b|مهتم|أحتاج|معلومات|السعر|مشروع|عقار|υπηρεσία|ενδιαφέρ/i.test(lower)) setAtLeast("need", 3);
  if (/\b(invest|budget|€|eur|million|portfolio|large|commercial|corporate)\b|استثمار|ميزانية|مليون|محفظة|تجاري|شركة|επένδυση|προϋπολογισ/i.test(lower)) setAtLeast("value", 3);
  if (/\b(today|tomorrow|this week|urgent|asap|deadline|soon|now)\b|اليوم|غدا|بكرة|عاجل|قريب|موعد نهائي|άμεσα|επείγον|αυτή την εβδομάδα/i.test(lower)) setAtLeast("timing", 4);
  if (/\b(i am the|i'm the|owner|director|decision maker|representing|company owner|founder|principal)\b|أنا المالك|مالك الشركة|صاحب الشركة|مؤسس الشركة|المدير|صاحب القرار|أمثل|ιδιοκτήτης|διευθυντής|εκπροσωπώ/i.test(lower)) setAtLeast("authority", 3);
  if (/\b(book|booking|appointment|schedule|meeting|call|next step|send details|how do we proceed)\b|حجز|موعد|اجتماع|مكالمة|الخطوة التالية|كيف نبدأ|ραντεβού|συνάντηση|επόμενο βήμα/i.test(lower) || ["booked", "confirmed"].includes(String(booking?.status || "").toLowerCase())) setAtLeast("readiness", 4);
  if (/\b(refalco|real estate|real-estate|construction|development|investment|business|corporate)\b|رفالكو|عقارات|إنشاء|تطوير|استثمار|أعمال|εταιρεία|ακίνητ|κατασκευ/i.test(lower)) setAtLeast("fit", 3);
  return result;
}

function ownerThresholds(input = {}) {
  const source = input.thresholds || input.ownerThresholds || {};
  const hot = Number.isFinite(Number(source.hot)) ? Number(source.hot) : Number(process.env.LEAD_HOT_THRESHOLD || DEFAULT_THRESHOLDS.hot);
  const warm = Number.isFinite(Number(source.warm)) ? Number(source.warm) : Number(process.env.LEAD_WARM_THRESHOLD || DEFAULT_THRESHOLDS.warm);
  const strategic = Number.isFinite(Number(source.strategic)) ? Number(source.strategic) : Number(process.env.LEAD_STRATEGIC_THRESHOLD || DEFAULT_THRESHOLDS.strategic);
  return {
    hot: Math.max(warm, Math.min(strategic, Math.min(30, hot))),
    warm: Math.max(0, Math.min(30, warm)),
    strategic: Math.max(hot, Math.min(30, strategic))
  };
}

function qualifyLead({ history = [], profile = {}, booking = null, dimensions = {}, thresholds, ownerThresholds: configuredThresholds } = {}) {
  const scored = inferDimensions({ history, profile, booking, dimensions });
  const total = DIMENSIONS.reduce((sum, name) => sum + scored[name], 0);
  const context = detectPriority(textOfHistory(history));
  const limits = ownerThresholds({ thresholds: thresholds || configuredThresholds });
  const status = context.priority || total >= limits.strategic ? "priority" : total >= limits.hot ? "hot" : total >= limits.warm ? "warm" : total > 0 ? "cold" : "unclassified";
  return { dimensions: scored, total, max: 30, status, tier: status, thresholds: limits, ...context };
}

function consentFromText(text) {
  const value = String(text || "");
  if (OPT_OUT_RE.test(value)) return CONSENT_STATES.REVOKED;
  if (DENY_RE.test(value) || GREEKLISH_CONTACT_DENIAL.test(value)) return CONSENT_STATES.DENIED;
  if (OPT_IN_RE.test(value)) return CONSENT_STATES.GRANTED;
  return CONSENT_STATES.UNKNOWN;
}

function getConsentState({ user = {}, history = user.history || [] } = {}) {
  const stored = user.consent?.followUp || user.followUpConsent;
  let state = CONSENT_STATES.UNKNOWN;
  let latestGrantAt = NaN;
  for (const turn of history) {
    const text = String(turn?.message || "");
    const detected = consentFromText(text);
    const trackedConsent = turn?.metadata?.specialistFollowUp?.consented === true && turn?.metadata?.specialistFollowUp?.purpose === "specialist_follow_up";
    const contextualYes = turn?.metadata?.specialistFollowUp?.consented === true && turn?.metadata?.specialistFollowUp?.trackedOffer === true && /^(?:yes|yeah|yep|sure|of course|ναι|βεβαίως|طبعًا|أكيد|اكيد|موافق(?:ة)?)\s*[.!،]*$/iu.test(text.trim());
    const effective = trackedConsent || contextualYes ? CONSENT_STATES.GRANTED : detected === CONSENT_STATES.GRANTED ? CONSENT_STATES.UNKNOWN : detected;
    if (effective !== CONSENT_STATES.UNKNOWN) state = effective;
    if (effective === CONSENT_STATES.GRANTED && turn?.at) latestGrantAt = new Date(turn.at).getTime();
  }
  // Honor stored denial when transcript history is missing; a newer, fully
  // tagged source turn may explicitly restore consent after a revocation.
  const storedAt = new Date(user.consent?.followUpUpdatedAt || user.consent?.updatedAt || 0).getTime();
  if ([CONSENT_STATES.REVOKED, CONSENT_STATES.DENIED].includes(stored) && !(Number.isFinite(latestGrantAt) && latestGrantAt > storedAt)) return stored;
  // Legacy stored "granted" flags without a qualifying source turn fail closed.
  return state;
}

function hasFollowUpPermission(user, { requireExplicit = true } = {}) {
  if (!user?.id || user.id.startsWith("self-test:")) return false;
  if (user.blocked || user.consent?.blocked || user.followUpBlocked) return false;
  const state = getConsentState({ user });
  return requireExplicit ? state === CONSENT_STATES.GRANTED : ![CONSENT_STATES.REVOKED, CONSENT_STATES.DENIED].includes(state);
}

function recordFollowUpConsent(user, message, now = new Date()) {
  const next = consentFromText(message);
  if (next === CONSENT_STATES.UNKNOWN) return user;
  const current = getConsentState({ user });
  if (current === next && user.consent?.followUp?.at) return user;
  const copy = { ...user, consent: { ...(user.consent || {}), followUp: next, followUpUpdatedAt: new Date(now).toISOString() } };
  copy.followUpConsent = next;
  return copy;
}

module.exports = {
  CONSENT_STATES,
  DEFAULT_THRESHOLDS,
  DIMENSIONS,
  OPT_IN_RE,
  OPT_OUT_RE,
  DENY_RE,
  clampScore,
  consentFromText,
  detectPriority,
  getConsentState,
  hasFollowUpPermission,
  inferDimensions,
  ownerThresholds,
  qualifyLead,
  calculateLeadQualification: qualifyLead,
  getLeadQualification: qualifyLead,
  detectConsent: consentFromText,
  detectOptOut: (text) => consentFromText(text) === CONSENT_STATES.REVOKED,
  canFollowUp: hasFollowUpPermission,
  recordFollowUpConsent,
  scoreLead: qualifyLead
};
