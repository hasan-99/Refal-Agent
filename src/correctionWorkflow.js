const CORRECTION_MARKERS = Object.freeze([
  /\b(?:correction|correct(?:ion)?)\b/i,
  // Treat update/change as a correction only when the customer marks it as
  // one. Questions such as "has the package changed?" or "any update?" are
  // requests for information, not corrections to their profile.
  /\b(?:update|updated|change|changed|replace|instead)\s*[:：-]\s*/i,
  /\b(?:that|this|the)\s+(?:is|was)\s+(?:wrong|incorrect|not right)\b/i,
  /\b(?:information|details?|data)\s+(?:is|are|was|were)\s+(?:wrong|incorrect|not right)\b/i,
  /\b(?:no|not)\s+(?:that|this|it)\b/i,
  /(?:تصحيح|التصحيح|المعلومة\s+(?:خاطئة|غير\s+صحيحة)|هذا\s+خطأ|غير\s+صحيح)/i,
  /(?:διόρθωση|διορθώστε|λάθος|δεν\s+είναι\s+σωστό)/i
]);

const FIELD_ALIASES = Object.freeze({
  name: /^(?:name|full\s+name|όνομα|ονοματεπώνυμο|الاسم|الاسم\s+الكامل)$/i,
  company: /^(?:company|business|company\s+name|εταιρεία|εταιρια|الشركة|اسم\s+الشركة)$/i,
  position: /^(?:position|role|job\s+title|θέση|المسمى\s+الوظيفي|المنصب)$/i,
  country: /^(?:country|location|χώρα|الدولة|البلد)$/i,
  phone: /^(?:phone|mobile|telephone|τηλέφωνο|الهاتف|رقم\s+الهاتف)$/i,
  email: /^(?:email|e-mail|ηλεκτρονικό\s+ταχυδρομείο|البريد\s+الإلكتروني)$/i,
  need: /^(?:need|requirement|request|ανάγκη|الاحتياج|الطلب)$/i,
  timeline: /^(?:timeline|timeframe|χρονικό\s+διάστημα|المدة|الجدول\s+الزمني)$/i,
  budget: /^(?:budget|προϋπολογισμός|الميزانية)$/i
});

const FIELD_LABELS = Object.freeze(Object.entries(FIELD_ALIASES));
const MAX_VALUE_LENGTH = 500;

function normalizeText(value) {
  return String(value == null ? "" : value).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

function isExplicitCorrection(text) {
  const input = normalizeText(text);
  return Boolean(input) && CORRECTION_MARKERS.some((marker) => marker.test(input));
}

function normalizeField(field) {
  const input = normalizeText(field);
  const match = FIELD_LABELS.find(([, pattern]) => pattern.test(input));
  return match ? match[0] : null;
}

function safeValue(value) {
  const normalized = normalizeText(value).replace(/^[-:;,]+\s*/, "").replace(/[.!?]+$/, "").trim();
  if (!normalized || normalized.length > MAX_VALUE_LENGTH) return null;
  if (/(?:ignore|disregard)\s+(?:all\s+)?(?:previous\s+)?instructions/i.test(normalized)) return null;
  if (/\b(?:system|developer|assistant)\s+(?:prompt|message|instruction)\b/i.test(normalized)) return null;
  return normalized;
}

function extractCorrection(text) {
  const input = normalizeText(text);
  if (!isExplicitCorrection(input)) return null;

  // Deliberately require a recognizable field label. This avoids treating
  // vague disagreement as a structured fact.
  const fieldPattern = "(?:name|full\\s+name|company|business|company\\s+name|position|role|job\\s+title|country|location|phone|mobile|telephone|email|e-mail|need|requirement|request|timeline|timeframe|budget|όνομα|ονοματεπώνυμο|εταιρεία|εταιρια|χώρα|τηλέφωνο|الاسم|الشركة|اسم\\s+الشركة|المنصب|الدولة|الهاتف|البريد\\s+الإلكتروني|الاحتياج|الطلب|المدة|الجدول\\s+الزمني|الميزانية)";
  const match = input.match(new RegExp("(?:^|[.;,،:]\\s*|\\b(?:correction|correct(?:ion)?|update|change|replace|instead)\\s*[:：-]?\\s*|(?:تصحيح|التصحيح|διόρθωση)\\s*[:：-]?\\s*)(?:η|ο|το|ال)?\\s*(" + fieldPattern + ")\\s*(?:is|was|should\\s+be|=|:|هو|هي|είναι|είχε|:)\\s*(.+)$", "iu"));
  if (!match) return null;

  const field = normalizeField(match[1]);
  const value = safeValue(match[2]);
  if (!field || !value) return null;
  return { field, value, source: "customer_provided", confidence: "explicit" };
}

function createCorrectionEvent({ userId, text, sourceTurnId = null, previousValue = null, timestamp = new Date().toISOString() } = {}) {
  const message = normalizeText(text);
  if (!isExplicitCorrection(message)) return null;
  const correction = extractCorrection(message);
  return {
    type: "correction",
    userId: userId == null ? null : String(userId),
    sourceTurnId: sourceTurnId == null ? null : String(sourceTurnId),
    timestamp,
    explicit: true,
    field: correction ? correction.field : null,
    previousValue: previousValue == null ? null : safeValue(previousValue),
    correctedValue: correction ? correction.value : null,
    source: "customer_provided",
    status: correction ? "extracted" : "needs_clarification"
  };
}

module.exports = { CORRECTION_MARKERS, FIELD_ALIASES, MAX_VALUE_LENGTH, isExplicitCorrection, normalizeField, extractCorrection, createCorrectionEvent };
