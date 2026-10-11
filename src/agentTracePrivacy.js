// Shared Node/Edge contract. Operational traces never contain drafted answers,
// customer identifiers, tool payloads, prompts, or model reasoning.
const TRACE_FIELDS = new Set([
  "traceId", "sourceTurnId", "stage", "durationMs", "outcome", "reasonCode", "status", "tool", "toolName",
  "query", "searchQueries", "searchRound", "resultCount", "candidateCount", "excludedCount",
  "evidenceCount", "evidenceChars", "evidenceIds", "documentIds", "sectionIds", "chunkIds",
  "evidencePassed", "validationReasons", "policyCode", "step", "stepCount", "maxSteps",
  "toolCallCount", "toolCallLimit", "retryCount", "knowledgeStatus", "toolsUsed", "toolCalls",
  "ok", "fallbackUsed", "finalOutcome", "responseLength", "draftRejected", "rejectionReasonCodes",
  "deterministicCorrectionUsed", "ragUsed", "ragResultStatus", "limit", "shadowMode", "reason",
  "outputChars", "limitReached", "terminationCause", "model", "providerStatus", "errorCode",
  "errorName", "statusCode", "timingMs", "persistenceUpdated", "delivered", "newEvidenceCount",
  "omittedEvidenceCount", "replacementCount", "budgetLimited", "questionCount", "hasQuestion",
  "clarificationRequested", "expectedLocale", "detectedResponseLocale", "languageMismatch",
  "locale", "primaryIntentCategory", "secondaryGoalCount", "decisionTypesUsed", "inspectionId",
  "retainedIds", "excludedIds", "catalogueOmittedIds", "contextOmittedIds", "replacedIds", "candidateIds", "newCandidateCount",
  "selectionDurationMs", "selectionStatus", "providerErrorCode", "promptTokens", "completionTokens",
  "totalTokens", "costUsd", "estimatedCostUsd", "usage", "inputTokens", "outputTokens"
]);
const TRACE_CODES = new Set(["validationReasons", "rejectionReasonCodes", "toolsUsed", "decisionTypesUsed"]);
const TRACE_CODE = /^[A-Za-z0-9_.:/,-]{1,160}$/u;
// Evidence references include hashes and document:section references, not just UUIDs.
const TRACE_REFERENCE = /^(?:[0-9a-f-]{16,64}|[0-9a-f-]{16,64}[:/][A-Za-z0-9_.:-]{1,80})$/iu;
const TRACE_SECRET = /\b(?:bearer\s+[A-Za-z0-9_.-]{12,}|sk-[A-Za-z0-9_-]{12,}|(?:api|access|refresh)[_-]?(?:key|token)\s*[:=]\s*[^\s,;]+|password\s*[:=]\s*[^\s,;]+|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})/giu;
const TRACE_EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const TRACE_PHONE = /(?<![A-Za-z0-9])\+?\d(?:[\d ().-]{5,}\d)(?![A-Za-z0-9])/gu;
const TRACE_JID = /\b\d{5,20}@[a-z0-9.-]+\b/giu;
const TRACE_IBAN = /(?<![\p{L}\p{N}])[A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]){11,30}(?![\p{L}\p{N}])/giu;
const TRACE_PRIVATE_LABEL = /(?:\b(?:passport|national\s+id|account\s+number|otp|pin|passcode)\b|رقم\s*(?:الحساب|الجواز|الهوية)|كلمة\s*(?:المرور|السر)|αριθμός\s*(?:λογαριασμού|διαβατηρίου|ταυτότητας)|κωδικός)\s*[:=]\s*[^\n;.!؟?]{1,100}/giu;

function redactTraceText(value) {
  return String(value).replace(TRACE_SECRET, "[redacted]").replace(TRACE_EMAIL, "[redacted]")
    .replace(TRACE_IBAN, "[redacted]").replace(TRACE_PRIVATE_LABEL, "[redacted]")
    .replace(TRACE_JID, "[redacted]").replace(TRACE_PHONE, "[redacted]");
}

function sanitizeAgentTraceFields(fields = {}) {
  const clean = {};
  for (const [key, value] of Object.entries(fields || {})) {
    if (!TRACE_FIELDS.has(key)) continue;
    if (typeof value === "number" && Number.isFinite(value)) clean[key] = value;
    else if (typeof value === "boolean" || value === null) clean[key] = value;
    else if (typeof value === "string") {
      if (key === "query") clean[key] = redactTraceText(value).replace(/[\r\n\t]+/gu, " ").slice(0, 240);
      else if (TRACE_CODE.test(value)) clean[key] = value;
    } else if (key === "searchQueries" && Array.isArray(value)) {
      clean[key] = value.slice(0, 4).filter((item) => typeof item === "string")
        .map((item) => redactTraceText(item).replace(/[\r\n\t]+/gu, " ").slice(0, 240));
    } else if (Array.isArray(value) && (TRACE_CODES.has(key) || /Ids$/u.test(key))) {
      const pattern = TRACE_CODES.has(key) ? TRACE_CODE : TRACE_REFERENCE;
      clean[key] = value.slice(0, 60).filter((item) => typeof item === "string" && pattern.test(item));
    } else if (key === "toolCalls" && Array.isArray(value)) {
      clean[key] = value.slice(0, 20).filter((item) => item && typeof item === "object")
        .map((item) => sanitizeAgentTraceFields({ tool: item.tool, status: item.status, ok: item.ok, reasonCode: item.reasonCode }));
    }
  }
  return clean;
}

module.exports = { sanitizeAgentTraceFields, redactTraceText };
