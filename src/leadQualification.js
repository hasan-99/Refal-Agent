const DIMENSIONS = Object.freeze(["need", "value", "timing", "authority", "readiness", "fit"]);

const DEFAULT_THRESHOLDS = Object.freeze({ hot: 22, warm: 12 });
const CONSENT_STATES = Object.freeze({ UNKNOWN: "unknown", GRANTED: "granted", DENIED: "denied", REVOKED: "revoked" });

const OPT_OUT_RE = /\b(?:stop|unsubscribe|do not contact|don't contact|dont contact|stop messaging|don't message|remove me|leave me alone|no more messages)\b|لا\s*(?:تراسلني|ترسل لي|ترسلولي|أريد رسائل|اريد رسائل)|(?:أوقف|اوقف|إلغاء|الغاء)\s*(?:الرسائل|الاشتراك|التواصل)?|احذف\s*(?:رقمي|بياناتي)|(?:σταμάτα|σταματήστε|μη\s*μου\s*στέλνεις|μη\s*μου\s*στείλετε|διαγραφή|διαγράψτε|δεν\s*θέλω\s*μηνύματα)/i;
const OPT_IN_RE = /\b(?:yes|yeah|yep|ok|okay|sure|contact me|keep me posted|follow up|you can message me|send me more)\b|(?:نعم|موافق|موافقة|تواصل معي|تابع معي|أرسل لي|ارسل لي|يمكنك مراسلتي|يمكنك مراسلتي)|\b(?:ναι|εντάξει|επικοινωνήστε μαζί μου|κρατήστε με ενήμερο|στείλτε μου|μπορείτε να επικοινωνήσετε)\b/i;

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
  const supplied = profile.qualification?.dimensions || profile.leadQualification?.dimensions || {};
  const source = { ...supplied, ...dimensions };
  const result = {};
  for (const dimension of DIMENSIONS) result[dimension] = clampScore(source[dimension]);

  const setAtLeast = (name, value) => { result[name] = Math.max(result[name], value); };
  if (/\b(interested|need|looking for|information|tell me more|price|pricing|cost|property|project|service)\b|مهتم|أحتاج|معلومات|السعر|مشروع|عقار|υπηρεσία|ενδιαφέρ/i.test(lower)) setAtLeast("need", 3);
  if (/\b(invest|budget|€|eur|million|portfolio|large|commercial|corporate)\b|استثمار|ميزانية|مليون|محفظة|تجاري|شركة|επένδυση|προϋπολογισ/i.test(lower)) setAtLeast("value", 3);
  if (/\b(today|tomorrow|this week|urgent|asap|deadline|soon|now)\b|اليوم|غدا|بكرة|عاجل|قريب|موعد نهائي|άμεσα|επείγον|αυτή την εβδομάδα/i.test(lower)) setAtLeast("timing", 4);
  if (/\b(i am the|i'm the|owner|director|decision maker|representing|company)\b|أنا المالك|المدير|صاحب القرار|أمثل|شركة|ιδιοκτήτης|διευθυντής|εκπροσωπώ/i.test(lower)) setAtLeast("authority", 3);
  if (/\b(book|booking|appointment|schedule|meeting|call|next step|send details|how do we proceed)\b|حجز|موعد|اجتماع|مكالمة|الخطوة التالية|كيف نبدأ|ραντεβού|συνάντηση|επόμενο βήμα/i.test(lower) || ["booked", "confirmed"].includes(String(booking?.status || "").toLowerCase())) setAtLeast("readiness", 4);
  if (/\b(refalco|real estate|real-estate|construction|development|investment|business|corporate)\b|رفالكو|عقارات|إنشاء|تطوير|استثمار|أعمال|εταιρεία|ακίνητ|κατασκευ/i.test(lower)) setAtLeast("fit", 3);
  return result;
}

function ownerThresholds(input = {}) {
  const source = input.thresholds || input.ownerThresholds || {};
  const hot = Number.isFinite(Number(source.hot)) ? Number(source.hot) : Number(process.env.LEAD_HOT_THRESHOLD || DEFAULT_THRESHOLDS.hot);
  const warm = Number.isFinite(Number(source.warm)) ? Number(source.warm) : Number(process.env.LEAD_WARM_THRESHOLD || DEFAULT_THRESHOLDS.warm);
  return { hot: Math.max(warm, Math.min(30, hot)), warm: Math.max(0, Math.min(30, warm)) };
}

function qualifyLead({ history = [], profile = {}, booking = null, dimensions = {}, thresholds, ownerThresholds: configuredThresholds } = {}) {
  const scored = inferDimensions({ history, profile, booking, dimensions });
  const total = DIMENSIONS.reduce((sum, name) => sum + scored[name], 0);
  const context = detectPriority(textOfHistory(history));
  const limits = ownerThresholds({ thresholds: thresholds || configuredThresholds });
  const status = context.priority ? "priority" : total >= limits.hot ? "hot" : total >= limits.warm ? "warm" : total > 0 ? "cold" : "unclassified";
  return { dimensions: scored, total, max: 30, status, tier: status, thresholds: limits, ...context };
}

function consentFromText(text) {
  const value = String(text || "");
  if (OPT_OUT_RE.test(value)) return CONSENT_STATES.REVOKED;
  if (OPT_IN_RE.test(value)) return CONSENT_STATES.GRANTED;
  return CONSENT_STATES.UNKNOWN;
}

function getConsentState({ user = {}, history = user.history || [] } = {}) {
  const stored = user.consent?.followUp || user.followUpConsent;
  if ([...Object.values(CONSENT_STATES)].includes(stored)) return stored;
  let state = CONSENT_STATES.UNKNOWN;
  for (const turn of history) {
    const detected = consentFromText(turn?.message);
    if (detected !== CONSENT_STATES.UNKNOWN) state = detected;
  }
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
  clampScore,
  consentFromText,
  detectPriority,
  getConsentState,
  hasFollowUpPermission,
  inferDimensions,
  ownerThresholds,
  qualifyLead,
  recordFollowUpConsent,
  scoreLead: qualifyLead
};
