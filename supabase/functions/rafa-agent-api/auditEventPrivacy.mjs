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
const AGENT_TRACE_FIELDS = new Set(["traceId", "stage", "durationMs", "outcome", "reasonCode", "status", "tool", "toolName", "query", "searchQueries", "searchRound", "resultCount", "evidenceCount", "evidenceChars", "evidenceIds", "documentIds", "sectionIds", "chunkIds", "evidencePassed", "validationReasons", "policyCode", "step", "stepCount", "maxSteps", "toolCallCount", "toolCallLimit", "retryCount", "limitReached", "terminationCause", "model", "providerStatus", "errorCode", "timingMs", "outputChars"]);
const TRACE_SECRET = /\b(?:bearer\s+)?(?:sk-[A-Za-z0-9_-]{12,}|(?:api|access|refresh)[_-]?(?:key|token)\s*[:=]\s*[^\s,;]+|password\s*[:=]\s*[^\s,;]+)\b/giu;
const TRACE_PHONE = /(?<![A-Za-z0-9])\+?\d(?:[\d ().-]{5,}\d)(?![A-Za-z0-9])/gu;
const TRACE_JID = /\b\d{5,20}@[a-z0-9.-]+\b/giu;

export function sanitizeAgentOperationalFields(fields = {}) {
  const clean = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!AGENT_TRACE_FIELDS.has(key)) continue;
    if (typeof value === "number" && Number.isFinite(value)) clean[key] = value;
    else if (typeof value === "boolean" || value === null) clean[key] = value;
    else if (typeof value === "string") {
      let safe = value.replace(TRACE_SECRET, "[redacted]").replace(EMAIL, "[redacted]").replace(TRACE_JID, "[redacted]").replace(TRACE_PHONE, "[redacted]");
      if (key === "query") safe = safe.replace(/[\r\n\t]+/gu, " ").slice(0, 240);
      else if (["outcome", "reasonCode", "status", "tool", "toolName", "stage", "terminationCause", "errorCode", "providerStatus"].includes(key)) {
        if (!/^[A-Za-z0-9_.:/-]{1,120}$/u.test(safe)) continue;
        safe = safe.slice(0, 120);
      } else safe = safe.slice(0, 180);
      clean[key] = safe;
    } else if (Array.isArray(value) && /(?:Ids|Reasons)$/u.test(key)) {
      clean[key] = value.slice(0, 30).filter((item) => typeof item === "string" && /^[0-9a-f-]{16,64}$/iu.test(item));
    } else if (key === "searchQueries" && Array.isArray(value)) {
      clean[key] = value.slice(0, 4).filter((item) => typeof item === "string")
        .map((item) => item.replace(TRACE_SECRET, "[redacted]").replace(EMAIL, "[redacted]").replace(TRACE_JID, "[redacted]").replace(TRACE_PHONE, "[redacted]").replace(/[\r\n\t]+/gu, " ").slice(0, 240));
    }
  }
  return clean;
}

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
