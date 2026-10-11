const PRIVATE_FIELD = /(?:^|_)(?:user|contact|sender|recipient|push_?name|name|phone|email|body|text|message|chat|jid|from|to|target|address|turn|appointment|secret|token|password|credential)(?:_|$)|(?:^|_)id$/iu;
const SECRET_VALUE = /\b(?:bearer\s+)?(?:sk-[A-Za-z0-9_-]{12,}|(?:api|access|refresh)[_-]?(?:key|token)\s*[:=]\s*[^\s,;]+|password\s*[:=]\s*[^\s,;]+)\b/giu;
const EMAIL_VALUE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const WHATSAPP_JID = /\b\d{5,20}@[a-z0-9.-]+\b/giu;
const PHONE_VALUE = /(?<![A-Za-z0-9])\+?\d(?:[\d ().-]{5,}\d)(?![A-Za-z0-9])/gu;
// Telemetry is metadata, not a general-purpose event payload. Unknown keys
// can contain customer text even when their values do not resemble PII, so
// retain only the scalar labels and measurements emitted by current callers.
const SAFE_FIELDS = new Set([
  "traceId", "stage", "durationMs", "providerLatencyMs", "evidenceCount", "facetCount", "complete", "scope",
  "source", "enabled", "sourceCount", "model", "promptTokens", "completionTokens", "totalTokens",
  "costUsd", "providerReported", "mode", "statusCode", "status", "reason", "reasonCode",
  "stepCount", "knowledgeStatus", "toolsUsed", "toolCalls", "tool", "ok", "outcome", "decisionTypesUsed",
  "ragUsed", "ragResultStatus", "draftRejected", "rejectionReasonCodes", "deterministicCorrectionUsed",
  "fallbackUsed", "finalOutcome", "responseLength", "questionCount", "hasQuestion",
  "clarificationRequested", "expectedLocale", "detectedResponseLocale", "languageMismatch",
  "locale", "primaryIntentCategory", "secondaryGoalCount", "maxSteps", "shadowMode",
  "toolCallCount", "legacyPrimaryIntentCategory", "agentPrimaryIntentCategory", "sameIntentCategory",
  "legacyUsedBookingPath", "agentProposedBookingTool", "legacyUsedHandoverPath", "agentProposedHandover",
  "legacyResponseLength", "agentResponseLength", "agentOutcome", "agentFallbackUsed", "agentStepCount",
  "shadowDurationMs", "activeShadowTurns", "limit", "disconnectedAt", "reconnectedAt", "mappedCount",
  "recoveredAt", "language", "intentCount", "entered", "route", "aiRequired", "modelUsed",
  "userCount", "rowCount", "promptVersion", "leadTier", "buyingSignals",
  "fromMe", "upsertType", "type", "duplicate", "blocked", "active", "queued", "deletedSelfTest",
  "deletedDirect", "shouldReconnect", "messageType", "count", "errorName", "errorCode",
  "persistenceUpdated", "delivered"
]);

function redactString(value) {
  return String(value)
    .replace(SECRET_VALUE, "[redacted]")
    .replace(EMAIL_VALUE, "[redacted-email]")
    .replace(WHATSAPP_JID, "[redacted-id]")
    .replace(PHONE_VALUE, "[redacted-phone]");
}

function sanitizeOperationalValue(value, depth = 0, fieldKey = "") {
  if (depth > 5 || value === undefined || typeof value === "function") return undefined;
  if (typeof value === "string") {
    if (!SAFE_FIELDS.has(fieldKey)) return undefined;
    if (["disconnectedAt", "reconnectedAt"].includes(fieldKey) && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value)) return undefined;
    // Retained strings are operational labels and identifiers, not prose.
    // Reject free text before applying the PII/secret scrubber.
    if (!/^[A-Za-z0-9_.:/-]{1,160}$/u.test(value)) return undefined;
    return redactString(value).slice(0, 160);
  }
  if (typeof value === "number") return SAFE_FIELDS.has(fieldKey) && Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean" || value === null) return SAFE_FIELDS.has(fieldKey) ? value : undefined;
  if (Array.isArray(value)) return SAFE_FIELDS.has(fieldKey) ? value.slice(0, 30).map((item) => sanitizeOperationalValue(item, depth + 1, fieldKey)).filter((item) => item !== undefined) : undefined;
  if (typeof value !== "object") return undefined;
  const clean = {};
  for (const [key, item] of Object.entries(value).slice(0, 50)) {
    // Trace IDs are generated per request and useful for joining stage events;
    // all contact/provider IDs and source-turn links remain in protected records.
    if (!SAFE_FIELDS.has(key) || (key !== "traceId" && PRIVATE_FIELD.test(key.replace(/([a-z])([A-Z])/g, "$1_$2")))) continue;
    const safe = sanitizeOperationalValue(item, depth + 1, key);
    if (safe !== undefined) clean[key] = safe;
  }
  return clean;
}

function buildOperationalEvent(event, fields = {}) {
  const eventName = String(event || "");
  // Event names are labels, never payloads. This also prevents a future caller
  // from accidentally passing customer text as the event name.
  const safeEvent = /^[A-Za-z][A-Za-z0-9_.-]{0,99}$/u.test(eventName) ? eventName : "unknown";
  return { event: safeEvent, fields: sanitizeOperationalValue(fields) || {} };
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
