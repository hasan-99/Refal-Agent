const PRIVATE_FIELD = /(?:^|_)(?:user|contact|sender|recipient|push_?name|name|phone|email|body|text|message|chat|jid|from|to|target|address|turn|appointment|secret|token|password|credential)(?:_|$)|(?:^|_)id$/iu;
const SECRET_VALUE = /\b(?:bearer\s+)?(?:sk-[A-Za-z0-9_-]{12,}|(?:api|access|refresh)[_-]?(?:key|token)\s*[:=]\s*[^\s,;]+|password\s*[:=]\s*[^\s,;]+)\b/giu;
const EMAIL_VALUE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const WHATSAPP_JID = /\b\d{5,20}@[a-z0-9.-]+\b/giu;
const PHONE_VALUE = /(?<![A-Za-z0-9])\+?\d(?:[\d ().-]{5,}\d)(?![A-Za-z0-9])/gu;

function redactString(value) {
  return String(value)
    .replace(SECRET_VALUE, "[redacted]")
    .replace(EMAIL_VALUE, "[redacted-email]")
    .replace(WHATSAPP_JID, "[redacted-id]")
    .replace(PHONE_VALUE, "[redacted-phone]");
}

function sanitizeOperationalValue(value, depth = 0) {
  if (depth > 5 || value === undefined || typeof value === "function") return undefined;
  if (typeof value === "string") return redactString(value).slice(0, 500);
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => sanitizeOperationalValue(item, depth + 1)).filter((item) => item !== undefined);
  if (typeof value !== "object") return undefined;
  const clean = {};
  for (const [key, item] of Object.entries(value).slice(0, 50)) {
    // Trace IDs are generated per request and useful for joining stage events;
    // all contact/provider IDs and source-turn links remain in protected records.
    const aggregateMetric = /^(?:promptTokens|completionTokens|totalTokens|costUsd)$/u.test(key);
    if (key !== "traceId" && !aggregateMetric && PRIVATE_FIELD.test(key.replace(/([a-z])([A-Z])/g, "$1_$2"))) continue;
    const safe = sanitizeOperationalValue(item, depth + 1);
    if (safe !== undefined) clean[key] = safe;
  }
  return clean;
}

function buildOperationalEvent(event, fields = {}) {
  return { event: String(event || "unknown").slice(0, 100), fields: sanitizeOperationalValue(fields) || {} };
}

function safeErrorDiagnostics(error) {
  const result = {};
  const name = String(error?.name || "Error");
  if (/^[A-Za-z][A-Za-z0-9_.-]{0,39}$/.test(name)) result.errorName = name;
  const code = String(error?.code || error?.cause?.code || "");
  if (/^[A-Z][A-Z0-9_.-]{0,39}$/.test(code)) result.errorCode = code;
  const status = Number(error?.statusCode || error?.status || error?.response?.status);
  if (Number.isInteger(status) && status >= 100 && status <= 599) result.statusCode = status;
  return result;
}

module.exports = { buildOperationalEvent, redactString, sanitizeOperationalValue, safeErrorDiagnostics };
