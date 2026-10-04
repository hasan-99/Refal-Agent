const PRIORITY_RANK = { normal: 0, high: 1, urgent: 2 };

function plausibleCustomerName(value) {
  const name = String(value || "").replace(/\s+/g, " ").trim();
  if (name.length < 2 || name.length > 60 || !/^\p{L}[\p{L}\p{M} .'-]*$/u.test(name) || name.split(/\s+/u).length > 4) return false;
  return !/(?:^|\s)(?:hello|hi|hey|who|what|how|services?|service|مرحبا|مرحبًا|أهلا|اهلا|شو|ماذا|كيف|خدمات|خدمة|ما|هل|من|τι|ποιος|ποια|υπηρεσίες)(?:$|\s)/iu.test(name);
}

function safeText(value, max = 500) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max)
    .replace(/(?:password|passcode|pin|token|api[_ -]?key|secret|cvv)\s*[:=]?\s*\S+/giu, "[redacted]")
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Z]{2,}\b/giu, "[email withheld]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "[phone withheld]");
}

function redactFinancialSecrets(value) {
  return String(value ?? "")
    .replace(/\b(?:iban|account(?:\s+number)?|bank\s+account|otp|one[- ]time\s+(?:password|code)|verification code|cvv|cvc|security code|passport(?:\s+(?:number|no\.?))?|national id(?:\s+(?:number|no\.?))?|identity card(?:\s+(?:number|no\.?))?)\b\s*(?:is|:|#|=)?\s*[A-Z0-9][A-Z0-9\s-]{2,40}/giu, "[redacted]")
    .replace(/(?:رقم\s*(?:الحساب|الآيبان|الايبان|الجواز|الهوية)|(?:رمز|كود)\s*(?:التحقق|التأكيد|لمرة\s*واحدة)|رقم\s*البطاقة|αριθμός\s*(?:λογαριασμού|διαβατηρίου|ταυτότητας)|κωδικός\s*(?:επιβεβαίωσης|μιας\s+χρήσης))[^.!؟?\n]{0,80}/giu, "[redacted]")
    .replace(/(?<![\p{L}\p{N}])[A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]){11,30}(?![\p{L}\p{N}])/giu, "[redacted]");
}

function sanitizeTree(value, depth = 0) {
  if (depth > 8 || value == null) return value ?? null;
  if (typeof value === "string") return redactFinancialSecrets(value).replace(/(?:password|passcode|pin|token|api[_ -]?key|secret)\s*[:=]?\s*\S+/giu, "[redacted]");
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeTree(item, depth + 1));
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [key, /(?:iban|account|otp|verification|cvv|cvc|passport|national.?id|identity.?card|security.?code)/iu.test(key) ? "[redacted]" : sanitizeTree(item, depth + 1)]));
  return value;
}

function safeRequirements(value) {
  if (typeof value === "string") return value.trim() === "[object Object]" ? null : safeText(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = [];
  const visit = (item, prefix = "", depth = 0) => {
    if (depth > 3 || !item || typeof item !== "object") return;
    for (const [key, nested] of Object.entries(item).slice(0, 30)) {
      const label = [prefix, String(key).slice(0, 80)].filter(Boolean).join(".");
      if (nested && typeof nested === "object" && !Array.isArray(nested)) visit(nested, label, depth + 1);
      else if (nested != null && String(nested).trim()) entries.push(`${label}: ${safeText(nested, 120)}`);
    }
  };
  visit(value);
  return entries.slice(0, 12).join("; ") || null;
}

export function sanitizeHandoverSummary(summary = {}) {
  const value = sanitizeTree(summary && typeof summary === "object" && !Array.isArray(summary) ? summary : {});
  const customer = value.customer && typeof value.customer === "object" && !Array.isArray(value.customer) ? value.customer : {};
  const candidate = String(customer.name || customer.fullName || "").trim();
  return {
    ...value,
    customer: { ...customer, name: plausibleCustomerName(candidate) ? candidate : null },
    requirements: safeRequirements(value.requirements)
  };
}

export function sanitizeInboundHistoryText(value = "") {
  const text = String(value || "");
  const privacyRisk = /(?:api[_ -]?key|access token|secret|password|passcode|\bpin\b|credit card|banking credentials|\b(?:iban|otp|one[- ]time (?:password|code)|verification code|cvv|cvc|passport(?: number| no\.?)?|national id(?: number| no\.?)?|identity card(?: number| no\.?)?|account number|bank account)\b\s*(?:is|:|#|=)?\s*[A-Z0-9][A-Z0-9\s-]{2,40}|(?<![\p{L}\p{N}])[A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]){11,30}(?![\p{L}\p{N}])|كلمة المرور|كلمة السر|رمز|رقم (?:الحساب|الآيبان|الايبان|الجواز|الهوية)|رقم التعريف|بطاقة|بيانات البنك|κωδικό|κωδικός|κάρτα|τραπεζικά στοιχεία|αριθμός (?:λογαριασμού|διαβατηρίου|ταυτότητας))/iu.test(text);
  return privacyRisk ? "[message omitted: potentially sensitive credentials]" : redactFinancialSecrets(text).slice(0, 10000);
}

export function buildSafeHistoryInsert(user, body) {
  return {
    contact_id: user.contactId,
    user_id: user.id,
    message: sanitizeInboundHistoryText(body.message),
    response: sanitizeInboundHistoryText(body.response),
    automated: Boolean(body.automated),
    source: String(body.source || "whatsapp"),
    metadata: sanitizeTree(body.metadata || {}),
    at: body.at || new Date().toISOString()
  };
}

export function hasPurposeBoundFollowUpConsent(consent, sourceTurn) {
  return consent?.state === "granted" && Boolean(consent?.source_turn_id) &&
    String(sourceTurn?.id || "") === String(consent.source_turn_id) &&
    sourceTurn?.metadata?.specialistFollowUp?.consented === true &&
    sourceTurn?.metadata?.specialistFollowUp?.purpose === "specialist_follow_up";
}

function summarySnapshot(summary = {}) {
  return Object.fromEntries(["intent", "primaryIntent", "need", "opportunity", "nextAction"]
    .filter((key) => summary[key] !== undefined && summary[key] !== null && String(summary[key]).trim())
    .map((key) => [key, String(summary[key]).slice(0, 1200)]));
}

function requestReference({ sourceTurnId, createdAt, department, priority, summary }) {
  return {
    sourceTurnId: sourceTurnId || null,
    createdAt: createdAt || new Date().toISOString(),
    department,
    priority,
    summary: summarySnapshot(summary)
  };
}

export function mergeActiveHandover(existing, incoming, { sourceTurnId, now = new Date().toISOString() } = {}) {
  const oldSummary = sanitizeHandoverSummary(existing.summary);
  const newSummary = sanitizeHandoverSummary(incoming.summary);
  const history = Array.isArray(oldSummary.relatedRequests)
    ? [...oldSummary.relatedRequests]
    : [requestReference({ sourceTurnId: existing.source_turn_id, createdAt: existing.created_at, department: existing.department, priority: existing.priority, summary: oldSummary })];
  if (!sourceTurnId || !history.some((request) => request.sourceTurnId === sourceTurnId)) {
    history.push(requestReference({ sourceTurnId, createdAt: now, department: incoming.department, priority: incoming.priority, summary: newSummary }));
  }

  const preserveExisting = (PRIORITY_RANK[existing.priority] || 0) > (PRIORITY_RANK[incoming.priority] || 0);
  const department = incoming.department === "general" && existing.department !== "general" ? existing.department : incoming.department;
  const priority = preserveExisting ? existing.priority : incoming.priority;
  const status = incoming.status || existing.status;
  return {
    department,
    priority,
    status,
    summary: { ...(preserveExisting ? oldSummary : newSummary), relatedRequests: history.slice(-50) },
    source_turn_id: sourceTurnId || existing.source_turn_id || null,
    resolved_at: status === "resolved" || status === "cancelled" ? now : null
  };
}
