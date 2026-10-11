const REDACTED = "[redacted]";
const PRIVATE_KEY = /(?:email|phone|whatsapp|contact|customer|user|actor|reviewer|reason|message|response|content|error|name|address|iban|passport|token|secret|credential|account)/iu;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const LABELED_SECRET = /\b(password|passcode|pin|token|api[\s_-]*key|access[\s_-]*token|secret|iban|account(?: number)?|passport(?: number)?)\b\s*(?:is|:|=)?\s*[^\s,;]+/giu;
const LABELED_SECRET_UNICODE = /(كلمة\s*(?:المرور|السر)|رمز\s*(?:الدخول|التعريف)?|بيانات\s*(?:الدخول|البنك)|κωδικός|κωδικό|κάρτα|τραπεζικά\s+στοιχεία)[^.!؟?\n]{0,180}/giu;
const ENUM_KEY = /^(?:action|state|status|category|channel|source|level|trigger|department|intent|workflow|field|fields|operation|reasonCode|code|reportDate|type|upsertType|appointmentId|blockId|notificationId|handoverId|sourceTurnId|id)$/iu;
const ENUM_VALUE = /^[a-z][a-z0-9_-]{0,60}$/iu;
const DATE_VALUE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/u;
const ID_VALUE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[a-z][a-z0-9_-]{0,30}-[a-z0-9_-]{1,30})$/iu;
const SAFE_USAGE_COUNTS = new Set(["promptTokens", "completionTokens", "totalTokens"]);

export function redactAuditEventFields(value, parentKey = "") {
  if (Array.isArray(value)) return value.map((item) => redactAuditEventFields(item, parentKey));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      SAFE_USAGE_COUNTS.has(key) && Number.isSafeInteger(item) && item >= 0
        ? item
        : PRIVATE_KEY.test(key) ? REDACTED : redactAuditEventFields(item, key)
    ]));
  }
  if (typeof value !== "string") return value;
  if (ENUM_KEY.test(parentKey)) {
    if (/^(?:reportDate)$/iu.test(parentKey)) return DATE_VALUE.test(value) ? value : REDACTED;
    if (/^(?:appointmentId|blockId|notificationId|handoverId|sourceTurnId|id)$/iu.test(parentKey)) return ID_VALUE.test(value) ? value : REDACTED;
    if (ENUM_VALUE.test(value)) return value.replace(EMAIL, REDACTED)
    .replace(LABELED_SECRET, (_match, label) => `${label}: ${REDACTED}`)
    .replace(LABELED_SECRET_UNICODE, (_match, label) => `${label}: ${REDACTED}`);
  }
  return REDACTED;
}
