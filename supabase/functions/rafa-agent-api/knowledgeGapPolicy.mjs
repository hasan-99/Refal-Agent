// Knowledge Gaps: the shared, dependency-free policy.
//
// One module, three runtimes: the Node worker (dynamic import from
// src/knowledgeGapRecorder.js), this Edge function (knowledgeGapEvents.mjs) and
// the dashboard API (dashboard/knowledgeGapsAdmin.js). It never performs I/O.
//
// Nothing here decides what a customer is told. Gap recording runs after the
// answer decision, and the agent never publishes knowledge from a gap.

// ----------------------------------------------------------------- vocabulary

export const GAP_REASONS = Object.freeze([
  "missing_knowledge", "weak_retrieval", "partial_knowledge", "conflicting_knowledge", "expired_knowledge",
  "unsupported_request", "agent_failure", "system_failure", "needs_review"
]);

export const GAP_STATUSES = Object.freeze([
  "open", "reviewing", "needs_knowledge", "needs_retrieval_fix", "needs_agent_fix", "resolved", "verified", "ignored"
]);

export const GAP_STATUS_LABELS = Object.freeze({
  open: "Open", reviewing: "Reviewing", needs_knowledge: "Needs Knowledge", needs_retrieval_fix: "Needs Retrieval Fix",
  needs_agent_fix: "Needs Agent Fix", resolved: "Resolved", verified: "Resolved/Verified", ignored: "Ignored"
});

export const GAP_PRIORITIES = Object.freeze(["critical", "high", "medium", "low"]);

export const GAP_REASON_LABELS = Object.freeze({
  missing_knowledge: "Missing knowledge", weak_retrieval: "Weak retrieval", partial_knowledge: "Partial knowledge",
  conflicting_knowledge: "Conflicting knowledge", expired_knowledge: "Expired knowledge",
  unsupported_request: "Unsupported request", agent_failure: "Agent issue", system_failure: "System failure",
  needs_review: "Needs review"
});

// Gaps for the same question only group inside one lane. A prompt-ceiling
// outage or a deliberately refused request must never inflate a knowledge gap.
export function reasonLane(reason) {
  if (reason === "system_failure") return "system";
  if (reason === "unsupported_request") return "unsupported";
  return "knowledge";
}

// ------------------------------------------------------------------ privacy

// Applied AFTER src/ai.js redactPersonalData on the worker, and again on the
// Edge function as defence in depth. Idempotent: redacting twice is a no-op.
// It removes values, never topic words: "Can I change my company address?"
// keeps "address" because no address value is present.
const ID_LABELS = "passport|passport\\s+(?:no|number)|id\\s+(?:card|no|number)|identity\\s+(?:card|number)|national\\s+id|tic|tax\\s+id|tin|vat\\s+(?:no|number)|ssn|social\\s+security|"
  + "رقم\\s+(?:الهوية|الجواز|جواز\\s+السفر|الضريبي)|جواز\\s+سفري|هويتي|"
  + "διαβατήριο|αριθμός\\s+ταυτότητας|ταυτότητα|αφμ";
const PAYMENT_LABELS = "iban|swift|bic|sort\\s+code|routing\\s+number|account\\s+(?:no|number)|card\\s+(?:no|number)|cvv|cvc|security\\s+code|expiry|"
  + "رقم\\s+(?:الحساب|البطاقة)|ايبان|آيبان|"
  + "αριθμός\\s+λογαριασμού|αριθμός\\s+κάρτας";

const REDACTIONS = [
  [/https?:\/\/[^\s<>"']+/giu, "[url]"],
  [/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/gu, "[email]"],
  [/\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b/gu, "[iban]"],
  [new RegExp(`(${PAYMENT_LABELS})\\s*(?:is|:|#|=|هو|είναι)?\\s*[A-Z0-9][A-Z0-9 /-]{2,34}`, "giu"), "$1 [payment-detail]"],
  [new RegExp(`(${ID_LABELS})\\s*(?:is|no\\.?|number|:|#|=|هو|είναι)?\\s*[A-Z0-9][A-Z0-9-]{4,19}`, "giu"), "$1 [id-number]"],
  // Card or account style digit runs before the phone matcher sees them.
  [/\b\d(?:[ -]?\d){12,18}\b/gu, "[payment-detail]"],
  [/(?:\+|00)?\d[\d\s().-]{6,}\d/gu, (match) => (match.replace(/\D/gu, "").length >= 8 ? "[phone]" : match)],
  // Mixed letter+digit tokens with 3+ digits read as an ID or reference.
  [/(?<![\p{L}\p{N}[\]-])(?=[A-Za-z0-9-]*\d[A-Za-z0-9-]*\d[A-Za-z0-9-]*\d)(?=[A-Za-z0-9-]*[A-Za-z])[A-Za-z0-9-]{6,20}(?![\p{L}\p{N}-])/gu, "[id-number]"],
  [/\b(?:p\.?\s?o\.?\s*box|ص\.?\s?ب\.?)\s*\d{1,7}\b/giu, "[address]"],
  [/\b\d{1,5}[A-Za-z]?,?\s+(?:[\p{L}'’.-]+\s+){0,4}(?:street|st\.|road|rd\.|avenue|ave\.|boulevard|blvd\.?|lane|drive|square|odos|leoforos)\b/giu, "[address]"],
  [/(?:شارع|طريق|جادة)\s+[\p{L}\p{N}]+(?:\s+[\p{L}\p{N}]+){0,3}\s*(?:رقم\s*)?\d*/gu, "[address]"],
  [/(?:οδός|οδ\.|λεωφόρος|λεωφ\.)\s+[\p{L}]+(?:\s+[\p{L}]+){0,3}\s*\d*/giu, "[address]"]
];

export function redactGapText(value, max = 500) {
  let text = String(value ?? "").normalize("NFKC").replace(/[\u0000-\u001f\u007f]+/gu, " ");
  for (const [pattern, replacement] of REDACTIONS) text = text.replace(pattern, replacement);
  return text.replace(/\s+/gu, " ").trim().slice(0, max);
}

// Reported by tests and the Edge validator: a stored text must not still
// contain an obvious contact value after redaction.
export function containsObviousPii(value) {
  const text = String(value ?? "");
  return /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/u.test(text)
    || /(?:\+|00)?\d(?:[\s().-]?\d){7,}/u.test(text)
    || /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/u.test(text);
}

// --------------------------------------------------------------- fingerprint

export function normalizeGapQuestion(value) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase()
    .replace(/[ً-ٰٟـ]/gu, "")
    .replace(/[أإآ]/gu, "ا").replace(/ى/gu, "ي").replace(/ة/gu, "ه")
    .normalize("NFD").replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}[\]]+/gu, " ").replace(/\s+/gu, " ").trim();
}

// cyrb53: a small deterministic non-cryptographic hash. It only keys de-dupe
// of already-redacted text; it is never used as a privacy control.
export function gapFingerprint(value) {
  const text = normalizeGapQuestion(value);
  let h1 = 0xdeadbeef ^ text.length;
  let h2 = 0x41c6ce57 ^ text.length;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

export function gapTitle(question) {
  const text = redactGapText(question, 160).replace(/^[\s\p{P}]+/u, "");
  if (!text) return "Unlabelled question";
  return text.length > 140 ? `${text.slice(0, 137).trimEnd()}...` : text.charAt(0).toLocaleUpperCase() + text.slice(1);
}

export function languageCode(value) {
  const text = String(value || "").toLowerCase();
  if (text.startsWith("ar")) return "ar";
  if (text.startsWith("el") || text.startsWith("gr")) return "el";
  if (text.startsWith("en")) return "en";
  return "und";
}

// ------------------------------------------------------- category and intent

// The contextual classifier often returns several intents. The category is the
// most specific domain present, so a pricing question about company formation
// is "corporate" (and flagged price-sensitive), never merged with a pricing
// question about residency.
const CATEGORY_BY_INTENT = Object.freeze({
  privacy: "unsupported", prompt_injection: "unsupported", unrelated: "unsupported",
  complaint: "support", existing_client: "support",
  legal: "legal", approval: "legal",
  tax: "tax", vat: "tax",
  immigration: "immigration", residency_enquiry: "immigration", permit: "immigration",
  banking: "banking",
  company_formation: "corporate", corporate_services: "corporate", accounting: "corporate",
  cyprus_business_expansion: "corporate", business_relocation: "corporate",
  real_estate: "real_estate", real_estate_purchase: "real_estate", real_estate_investment: "real_estate",
  land_owner: "real_estate", property_development: "real_estate", land_development: "real_estate",
  construction: "real_estate", construction_tender: "real_estate", project_management: "real_estate",
  investment: "investment", investment_opportunity: "investment", investment_partnership: "investment",
  strategic_partnership: "investment", partnership: "investment", strategic_assets: "investment",
  business_proposal: "investment", infrastructure: "investment", project_enquiry: "investment",
  pricing: "pricing",
  appointment: "appointment",
  company_info: "company_info", services: "company_info", business_areas: "company_info", contact: "company_info",
  agent_identity: "company_info", language_capability: "company_info",
  supplier: "general", career: "general", media: "general", technology: "general", operations: "general",
  general_information: "general", unknown: "general"
});

const CATEGORY_ORDER = Object.freeze(["unsupported", "support", "legal", "tax", "immigration", "banking", "corporate",
  "real_estate", "investment", "pricing", "appointment", "company_info", "general"]);

export const GAP_CATEGORIES = CATEGORY_ORDER;

export function gapCategoryForIntents(intents = []) {
  const list = (Array.isArray(intents) ? intents : []).map((intent) => String(intent || "").toLowerCase()).filter(Boolean);
  let best = { category: "general", intent: list.find((intent) => !["greeting", "small_talk"].includes(intent)) || "" };
  let bestIndex = CATEGORY_ORDER.length - 1;
  for (const intent of list) {
    const category = CATEGORY_BY_INTENT[intent];
    const index = category ? CATEGORY_ORDER.indexOf(category) : -1;
    if (index >= 0 && index < bestIndex) { best = { category, intent }; bestIndex = index; }
  }
  return best;
}

export function categoriesCompatible(a, b) {
  const left = String(a || "general");
  const right = String(b || "general");
  if (left === "unsupported" || right === "unsupported") return left === right;
  return left === right || left === "general" || right === "general";
}

// ------------------------------------------------------- sensitive / blocking

const SENSITIVE_PATTERNS = Object.freeze({
  price: /\b(?:price|prices|pricing|cost|costs|fee|fees|charge|charges|how much|quote|budget|discount)\b|سعر|أسعار|اسعار|تكلف|كلفة|رسوم|بكم|كم (?:سعر|تكلف|يكلف|بتكلف|حق)|خصم|τιμή|τιμές|κόστος|κοστίζει|χρέωση|αμοιβή|έκπτωση/iu,
  refund: /\b(?:refund|refunds|refundable|money back|reimburse|chargeback|cancel(?:lation)?)\b|استرداد|استرجاع|ارجاع المبلغ|رجوع المبلغ|إلغاء|الغاء|επιστροφή χρημάτων|ακύρωση|αποζημίωση/iu,
  payment: /\b(?:pay|paid|payment|payments|instal+ments?|deposit|invoice|card|transfer|crypto|bitcoin)\b|دفع|الدفع|أدفع|ادفع|قسط|أقساط|اقساط|عربون|تحويل|فاتورة|πληρωμή|πληρώσω|δόσεις|προκαταβολή|τιμολόγιο/iu,
  legal: /\b(?:legal|legally|law|laws|lawyer|contract|liability|court|compliance|licen[cs]e|regulat\w*)\b|قانون|قانوني|محامي|عقد|محكمة|ترخيص|νομικ|νόμος|δικηγόρ|σύμβαση|δικαστήριο|άδεια/iu,
  tax: /\b(?:tax|taxes|taxation|vat|non-dom|tax resident|withholding)\b|ضريب|ضرائب|القيمة المضافة|φόρο|φόρος|φορολογ|ΦΠΑ/iu,
  guarantee: /\b(?:guarantee|guaranteed|guarantees|warrant(?:y|ee)|promise|assured)\b|ضمان|مضمون|تضمن|تضمنون|أكيد|εγγύηση|εγγυημένο|εγγυάστε/iu
});
const SENSITIVE_INTENTS = Object.freeze({ pricing: "price", legal: "legal", tax: "tax", vat: "tax", approval: "guarantee" });

export function detectSensitiveTopics(question, intents = []) {
  const topics = new Set();
  const text = String(question || "");
  for (const [topic, pattern] of Object.entries(SENSITIVE_PATTERNS)) if (pattern.test(text)) topics.add(topic);
  for (const intent of Array.isArray(intents) ? intents : []) if (SENSITIVE_INTENTS[intent]) topics.add(SENSITIVE_INTENTS[intent]);
  return [...topics].sort();
}

// Purchase / onboarding blocking: a gap on these paths stops a sale or a new
// client from starting, so it weighs more than a general curiosity question.
const BLOCKING_INTENTS = new Set(["pricing", "company_formation", "corporate_services", "appointment", "real_estate_purchase",
  "residency_enquiry", "immigration", "permit", "banking", "investment_opportunity", "existing_client"]);
const BLOCKING_CATEGORIES = new Set(["corporate", "immigration", "banking", "pricing", "appointment"]);

export function isBlockingTopic({ intent, category, intents = [] } = {}) {
  return BLOCKING_INTENTS.has(String(intent || "")) || BLOCKING_CATEGORIES.has(String(category || ""))
    || (Array.isArray(intents) && intents.some((value) => BLOCKING_INTENTS.has(value)));
}

// ------------------------------------------------------------ classification
//
// DECISION TABLE (first matching row wins; every input is a deterministic
// signal from the finished agent turn, never a model judgment):
//
//  #  condition                                                          -> reason                 confidence
//  0  social-only turn, or every intent is greeting/small_talk/identity   -> NOT RECORDED
//  1  outcome decision_failed | validation_failed | knowledge_unavailable,
//     or the turn reason / any step reasonCode is a system code
//     (PROMPT_TOKEN_CEILING_EXCEEDED, MODEL_CALL_FAILED, RETRIEVAL_FAILED,
//     KNOWLEDGE_SEARCH_FAILED, provider/timeout/HTTP codes, ...),
//     or any approved-knowledge search returned status "error"           -> system_failure         high
//  2  intent privacy | prompt_injection | unrelated, or a policy code that
//     refuses the request (forbidden_credential_request, ...)            -> unsupported_request    high (analytics only)
//  3  outcome responded | clarified, no correction, no policy rejection,
//     and either no search ran or a search returned approved evidence    -> NOT RECORDED (grounded)
//  4  an evidence/candidate row or the server-side probe shows matching
//     approved knowledge whose valid_until has passed, and no current
//     evidence was selected                                              -> expired_knowledge      high
//  5  contradicted_by_evidence and >= 2 evidence documents share a topic
//     or fact id                                                         -> conflicting_knowledge  medium
//  6  no approved search ran, yet the turn was rejected for missing
//     evidence or did not finish cleanly                                 -> agent_failure          medium
//  7  search ran and returned zero approved evidence (every search
//     no_evidence / empty)                                               -> missing_knowledge      high when the turn
//                                                                           was not clean or was rejected for
//                                                                           evidence, medium when it answered
//  8  evidence was returned, the rejections are knowledge-gap codes only,
//     and no section was a primary (current-wording) match, or retrieval
//     was exhausted with no new evidence                                 -> weak_retrieval         medium
//  9  evidence was returned and knowledge-gap codes trimmed or blocked
//     part of the answer                                                 -> partial_knowledge      medium
// 10  outcome invalid_decision | max_steps_reached | clarify_rejected |
//     response_rejected with behaviour codes only                        -> agent_failure          high
// 11  anything else (mixed or unknown signals)                           -> needs_review           low
//
// Low confidence is always stored as needs_review with the suspected reason
// kept alongside, so an uncertain signal never lands in the wrong queue.

const SYSTEM_CODE = /^(?:PROMPT_TOKEN_CEILING_EXCEEDED|MODEL_CALL_FAILED|RETRIEVAL_FAILED|KNOWLEDGE_SEARCH_FAILED|SEARCH_UNAVAILABLE|TOOL_THREW|EMBEDDING_FAILED|CIRCUIT_OPEN|MODEL_CIRCUIT_OPEN|grounding_review_failed|grounding_verdict_invalid)$|^(?:PROVIDER|OPENROUTER|HTTP|TIMEOUT|RATE_LIMIT|NETWORK|UPSTREAM|ABORT)[A-Z0-9_.-]*$|(?:_TIMEOUT|_FAILED|_UNAVAILABLE|_ERROR|_EXCEEDED)$/u;
const SYSTEM_OUTCOMES = new Set(["decision_failed", "validation_failed", "knowledge_unavailable"]);
const UNSUPPORTED_INTENTS = new Set(["privacy", "prompt_injection", "unrelated"]);
const UNSUPPORTED_CODES = new Set(["forbidden_credential_request", "construction_pricing_prohibited", "cross_customer_request", "privacy_request"]);
export const KNOWLEDGE_GAP_CODES = Object.freeze(new Set(["no_approved_evidence", "entities_not_in_evidence", "service_not_established",
  "unsupported_relation", "unsupported_guarantee", "unsupported_price_claim", "unsupported_numeric_claim", "unsupported_package_claim",
  "unsupported_brand_claim", "unsupported_url_claim", "condition_missing", "question_not_answered", "prohibited_claim",
  "repeated_blocked_claim_without_evidence_progress"]));
const SOCIAL_INTENTS = new Set(["greeting", "small_talk", "agent_identity"]);
const AGENT_OUTCOMES = new Set(["invalid_decision", "max_steps_reached", "clarify_rejected", "response_rejected"]);

// Decision table row 4, server side: the Edge function's lexical probe found
// approved knowledge for this question that has passed valid_until.
export function classifyExpiredUpgrade(reason, expiredMatchCount) {
  return reason === "missing_knowledge" && Number(expiredMatchCount) > 0 ? "expired_knowledge" : reason;
}

export function isSystemCode(code) {
  return SYSTEM_CODE.test(String(code || ""));
}

function splitCodes(value) {
  return String(value || "").split(",").map((code) => code.trim()).filter(Boolean);
}

// `signals` is built by src/knowledgeGapRecorder.js extractGapSignals. Every
// field is optional so a partial trace degrades to needs_review, never a throw.
export function classifyKnowledgeGap(signals = {}) {
  const outcome = String(signals.outcome || "unknown");
  const intents = (Array.isArray(signals.intents) ? signals.intents : []).map(String);
  const rejectionCodes = [...new Set((Array.isArray(signals.rejectionCodes) ? signals.rejectionCodes : []).map(String))];
  const turnCodes = splitCodes(signals.turnReason);
  const stepCodes = (Array.isArray(signals.stepReasonCodes) ? signals.stepReasonCodes : []).flatMap(splitCodes);
  const searches = Array.isArray(signals.searches) ? signals.searches : [];
  const searchRan = searches.length > 0;
  const evidenceCount = searches.reduce((sum, item) => sum + (Number(item?.evidenceCount) || 0), 0);
  const candidateCount = searches.reduce((sum, item) => sum + (Number(item?.candidateCount) || 0), 0);
  const result = (reason, confidence, rule, extra = {}) => {
    const lowConfidence = confidence === "low";
    return { record: true, reason: lowConfidence ? "needs_review" : reason, suspectedReason: reason, confidence, rule, ...extra };
  };

  if (signals.socialOnlyTurn === true || (intents.length > 0 && intents.every((intent) => SOCIAL_INTENTS.has(intent) || intent === "unknown")
    && intents.some((intent) => SOCIAL_INTENTS.has(intent)))) {
    return { record: false, skip: "social_turn", rule: 0 };
  }
  if (SYSTEM_OUTCOMES.has(outcome) || [...turnCodes, ...stepCodes].some(isSystemCode)
    || searches.some((item) => item?.status === "error" || item?.status === "search_unavailable")) {
    return result("system_failure", "high", 1);
  }
  if (intents.some((intent) => UNSUPPORTED_INTENTS.has(intent)) || rejectionCodes.some((code) => UNSUPPORTED_CODES.has(code))
    || turnCodes.some((code) => UNSUPPORTED_CODES.has(code))) {
    return result("unsupported_request", "high", 2, { analyticsOnly: true });
  }
  const clean = ["responded", "clarified"].includes(outcome);
  const rejected = rejectionCodes.length > 0 || turnCodes.length > 0 && !clean;
  if (clean && signals.corrected !== true && rejectionCodes.length === 0 && (!searchRan || evidenceCount > 0)) {
    return { record: false, skip: "grounded_answer", rule: 3 };
  }
  if ((Number(signals.expiredMatches) || 0) > 0 && evidenceCount === 0) return result("expired_knowledge", "high", 4);
  const allCodes = [...rejectionCodes, ...turnCodes];
  if (allCodes.includes("contradicted_by_evidence") && signals.evidenceOverlap === true) return result("conflicting_knowledge", "medium", 5);
  const knowledgeCodes = allCodes.filter((code) => KNOWLEDGE_GAP_CODES.has(code));
  const behaviourCodes = allCodes.filter((code) => !KNOWLEDGE_GAP_CODES.has(code) && !isSystemCode(code));
  if (!searchRan && (knowledgeCodes.length > 0 || !clean)) return result("agent_failure", "medium", 6, { detail: "no_approved_search" });
  if (searchRan && evidenceCount === 0) {
    return result("missing_knowledge", !clean || knowledgeCodes.length > 0 ? "high" : "medium", 7);
  }
  if (evidenceCount > 0 && knowledgeCodes.length > 0 && behaviourCodes.length === 0) {
    const noPrimaryMatch = searches.every((item) => !(Number(item?.primaryMatchCount) > 0));
    const exhausted = searches.some((item) => item?.status === "no_new_evidence" || item?.status === "search_exhausted");
    if (noPrimaryMatch || (exhausted && !clean)) return result("weak_retrieval", "medium", 8, { candidateCount });
    return result("partial_knowledge", "medium", 9);
  }
  if (evidenceCount > 0 && clean && signals.corrected === true && behaviourCodes.length === 0) return result("partial_knowledge", "medium", 9);
  if ((AGENT_OUTCOMES.has(outcome) || rejected) && behaviourCodes.length > 0 && knowledgeCodes.length === 0) return result("agent_failure", "high", 10);
  if (AGENT_OUTCOMES.has(outcome) && allCodes.length === 0) return result("agent_failure", "medium", 10);
  return result(knowledgeCodes.length ? "partial_knowledge" : "agent_failure", "low", 11);
}

// ------------------------------------------------------------------ aspects
//
// Measured on the labelled set: multilingual-e5-small scores minimal pairs
// such as "how much does registration cost" vs "how long does registration
// take" at 0.96 (Arabic) and "change company address" vs "change company
// name" at 0.97, while real cross-language paraphrases can sit at 0.75. The
// local cross-encoder fails the same pairs. No embedding threshold separates
// them, so grouping adds a deterministic aspect guard: WHAT is asked (facet)
// and ABOUT WHICH THING (object), in English, Arabic and Greek.
//
//   conflict  both questions name a facet and the facets are disjoint, or both
//             name an object and the objects are disjoint -> never merge
//   strong    no conflict, and they share a facet AND an object -> the normal
//             threshold applies
//   weak      no conflict, only a facet or only an object is shared -> treated
//             like unknown (the held-out set showed "residency" alone joins
//             "family residency" with "permit timing")
//   unknown   nothing the other side can confirm -> only a near-duplicate
//             (strictThreshold) may merge
// A group keeps the aspects of its FOUNDING question. They are never widened
// by later members, so a group cannot drift into neighbouring topics.
const FACET_PATTERNS = Object.freeze({
  cost: /\b(?:price|prices|pricing|cost|costs|fee|fees|charge|charges|how much|expensive|cheap|quote)\b|تكلف|كلفة|سعر|أسعار|اسعار|رسوم|بكم|كم يكلف|كم بتكلف|κόστ|κοστίζ|τιμή|τιμές|χρέωσ|αμοιβ|πόσο κάνει/iu,
  duration: /\b(?:how long|how many (?:days|weeks|months)|duration|timeline|timeframe|turnaround)\b|يستغرق|تستغرق|مدة|المدة|كم يوم|كم أسبوع|كم شهر|πόσο χρόνο|πόσες (?:μέρες|ημέρες|εβδομάδες)|διάρκεια/iu,
  documents: /\b(?:documents?|paperwork|papers)\b|مستند|أوراق|اوراق|وثائق|έγγραφ|δικαιολογητικ|χαρτιά/iu,
  change: /\b(?:change(?! my mind)|changing|changed|modify|amend|rename|renaming|move|moving|relocate|transfer(?:ring)? (?:the|our|my) (?:office|address|registered))\b|أغير|اغير|تغيير|نغير|يغير|تعديل|أعدل|ننقل|نقل|انقل|أنقل|αλλάξ|αλλαγ|μετακιν|μεταφορ|τροποποι/iu,
  cancel_refund: /\b(?:refund|refunds|refundable|money back|reimburs\w*|cancel|cancell?ation|change my mind)\b|استرداد|استرجاع|ارجاع|إرجاع|ألغي|الغي|إلغاء|الغاء|επιστροφ|ακυρ|πίσω τα χρήματα/iu,
  installments: /\b(?:instal+ments?|payment plan|pay in parts|monthly payments?)\b|أقساط|اقساط|تقسيط|δόσεις/iu,
  crypto_payment: /\b(?:crypto\w*|bitcoin|btc|usdt|ethereum)\b|عملات رقمية|العملات الرقمية|عملة رقمية|بيتكوين|κρυπτο/iu,
  card_payment: /\b(?:credit card|debit card|pay by card|card payment|visa card|mastercard)\b|بطاقة ائتمان|بالبطاقة|πιστωτική|με κάρτα/iu,
  close: /\b(?:close|closing|dissolve|dissolution|strike off|struck off|liquidat\w*|wind up|deregister)\b|أغلق|اغلق|إغلاق|اغلاق|تصفية|حل الشركة|شطب|κλείσ|διάλυσ|εκκαθάρισ/iu,
  hours: /\b(?:opening hours|working hours|business hours|office hours|hours)\b|\bwhen\b.*\bopen\b|ساعات|الدوام|دوام|مواعيد العمل|أوقات العمل|ωράριο|ώρες λειτουργίας|ανοιχτ/iu,
  location: /\b(?:where|located|location|what is your (?:office )?address)\b|وين|أين|اين|موقع|مكان|πού|τοποθεσία|βρίσκεται|βρίσκεστε/iu,
  eligibility: /\b(?:do i need to|need to register|mandatory|obligatory|required to|must i|have to|eligible|qualify)\b|لازم|يجب|إلزامي|الزامي|مؤهل|υποχρεωτικ|πρέπει να|δικαιούμαι/iu,
  guarantee: /\b(?:guarantee|guaranteed|guarantees|warrant(?:y|ee))\b|ضمان|مضمون|تضمن|تضمنون|εγγύηση|εγγυημέν|εγγυάστε/iu,
  service_offering: /\b(?:do you (?:provide|offer|assist|help|supply|handle)|can you (?:help|supply|provide|assist|arrange))\b|تساعد|توفرون|تقدمون|بتوفروا|προσφέρετε|βοηθάτε|παρέχετε/iu
});
const OBJECT_PATTERNS = Object.freeze({
  company_address: /\b(?:registered (?:office|address|seat)|company(?:'s)? address|business address)\b|عنوان الشركة|مقر الشركة|المقر المسجل|عنوان مسجل|διεύθυνση της εταιρείας|εταιρική διεύθυνση|έδρα/iu,
  company_name: /\b(?:company(?:'s)? name|business name|name of (?:my|the|our) company|renam\w+|name)\b|اسم الشركة|اسم شركتي|الاسم التجاري|تغيير الاسم|όνομα|επωνυμία/iu,
  refal_office: /\byour offices?\b|مكتبكم|مكاتبكم|مكتبك|γραφείο σας|γραφεία σας/iu,
  bank_account: /\bbank account|\bbanking\b|حساب بنكي|حساب مصرفي|حساب في البنك|τραπεζικ/iu,
  vat: /\bvat\b|القيمة المضافة|φπα/iu,
  tax_residency: /\btax resid\w*|\bnon-dom\b|\b(?:60|183)-day\b|مقيم ضريبي|الإقامة الضريبية|اقامة ضريبية|φορολογικ\w* κάτοικ/iu,
  residency: /\b(?:residency|residence permit|permanent residence|visa|golden visa|immigration)\b|إقامة|اقامة|تأشيرة|فيزا|άδεια διαμονής|διαμονή|βίζα/iu,
  property: /\b(?:property|properties|house|apartment|villa|real estate|land)\b|عقار|شقة|فيلا|أرض|ارض|ακίνητ|σπίτι|διαμέρισμα|βίλα|οικόπεδο/iu,
  director_shareholder: /\b(?:director|directors|shareholder|shareholders|nominee|secretary)\b|مدير|مساهم|διευθυντ|μέτοχ/iu
});

export function questionAspects(question) {
  const text = String(question || "").normalize("NFKC");
  const facets = Object.entries(FACET_PATTERNS).filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
  let objects = Object.entries(OBJECT_PATTERNS).filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
  // "tax residency" is its own object, not immigration residency.
  if (objects.includes("tax_residency")) objects = objects.filter((name) => name !== "residency");
  return { facets: facets.sort(), objects: objects.sort() };
}

function disjoint(left = [], right = []) {
  return left.length > 0 && right.length > 0 && !left.some((value) => right.includes(value));
}

export function compareAspects(left = {}, right = {}) {
  const facetsA = Array.isArray(left.facets) ? left.facets : [];
  const facetsB = Array.isArray(right.facets) ? right.facets : [];
  const objectsA = Array.isArray(left.objects) ? left.objects : [];
  const objectsB = Array.isArray(right.objects) ? right.objects : [];
  if (disjoint(facetsA, facetsB) || disjoint(objectsA, objectsB)) return "conflict";
  const sharedFacet = facetsA.some((value) => facetsB.includes(value));
  const sharedObject = objectsA.some((value) => objectsB.includes(value));
  if (sharedFacet && sharedObject) return "strong";
  if (sharedFacet || sharedObject) return "weak";
  return "unknown";
}

// --------------------------------------------------------------- grouping

// Calibrated with the real local multilingual-e5-small on the labelled set in
// scripts/knowledgeGapCalibrationSet.js (scripts/calibrateKnowledgeGapGrouping.js,
// 8 deterministic arrival orders, pairwise metrics of the resulting groups):
//   design set (54 q, 15 topics)    precision 1.000, recall 0.443
//   held-out set (34 q, 11 topics)  precision 1.000, recall 0.000 (lexicon does
//                                   not know those topics: only near-duplicates merge)
//   both sets mixed (88 q)          precision 1.000, recall 0.271
// threshold 0.84 sits one notch above the design-set optimum (0.81).
// strictThreshold 0.94: at 0.92 the mixed set already shows cross-topic false
// merges, 0.93 is the edge. Low recall is deliberate: a missed merge costs an
// extra row, a false merge hides a gap inside another one.
export const GAP_GROUPING = Object.freeze({ dimensions: 384, threshold: 0.84, strictThreshold: 0.94, margin: 0.0, candidateLimit: 8 });

export function toUnitVector(values, dimensions = GAP_GROUPING.dimensions) {
  if (!Array.isArray(values) && !(ArrayBuffer.isView(values))) return null;
  const vector = Array.from(values).slice(0, dimensions).map(Number);
  if (vector.length !== dimensions || vector.some((value) => !Number.isFinite(value))) return null;
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!(norm > 0)) return null;
  return vector.map((value) => value / norm);
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let dot = 0; let left = 0; let right = 0;
  for (let index = 0; index < a.length; index += 1) { dot += a[index] * b[index]; left += a[index] * a[index]; right += b[index] * b[index]; }
  return left > 0 && right > 0 ? dot / Math.sqrt(left * right) : null;
}

// Mirrors the SQL centroid update in rafa_record_knowledge_gap_event: the
// running mean of unit vectors, re-normalised.
export function updateCentroid(centroid, count, embedding) {
  const next = toUnitVector(embedding, embedding?.length || GAP_GROUPING.dimensions);
  if (!next) return centroid;
  if (!centroid || !(count > 0)) return next;
  return toUnitVector(centroid.map((value, index) => value * count + next[index]), centroid.length);
}

// candidates: [{ id, similarity, category, reason, status, facets, objects }]
// already scored against the group centroid; facets/objects are the group's
// accumulated aspects. Returns the group to join, or null for a new group.
// Conservative by design: below threshold, a different lane, an incompatible
// category, an aspect conflict, or an ambiguous near-tie all open a new group.
export function decideGapGroup(event = {}, candidates = [], config = GAP_GROUPING) {
  const lane = reasonLane(event.reason);
  const eventAspects = event.aspects || questionAspects(event.question);
  const strict = Number.isFinite(config.strictThreshold) ? config.strictThreshold : 0.95;
  const eligible = (Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => candidate && Number.isFinite(Number(candidate.similarity)))
    .filter((candidate) => reasonLane(candidate.reason) === lane && categoriesCompatible(candidate.category, event.category))
    .map((candidate) => ({ ...candidate, aspectMatch: compareAspects(eventAspects, { facets: candidate.facets, objects: candidate.objects }) }))
    .filter((candidate) => candidate.aspectMatch !== "conflict")
    .filter((candidate) => Number(candidate.similarity) >= (candidate.aspectMatch === "strong" ? config.threshold : strict))
    .sort((a, b) => Number(b.similarity) - Number(a.similarity));
  const best = eligible[0];
  if (!best) {
    const top = (Array.isArray(candidates) ? candidates : []).map((candidate) => Number(candidate?.similarity)).filter(Number.isFinite).sort((a, b) => b - a)[0];
    return { groupId: null, decision: "new_group", bestSimilarity: Number.isFinite(top) ? top : null };
  }
  const runnerUp = eligible[1];
  if (config.margin > 0 && runnerUp && Number(best.similarity) - Number(runnerUp.similarity) < config.margin
    && runnerUp.category !== best.category) {
    return { groupId: null, decision: "ambiguous_new_group", bestSimilarity: Number(best.similarity) };
  }
  return { groupId: best.id, decision: "join", bestSimilarity: Number(best.similarity), aspectMatch: best.aspectMatch };
}

// ----------------------------------------------------------------- priority
//
// PRIORITY FORMULA (computed on read from live group statistics, so it can
// never go stale; an administrator override always wins):
//
//   frequency   occurrences >= 20: 3 | >= 8: 2 | >= 3: 1 | else 0
//   growth      last 7 days >= 3 and >= 2x the previous 7 days: 2 | last 7 > previous 7: 1
//   impact      distinct contacts >= 5: 2 | >= 2: 1
//   blocking    purchase / onboarding path (pricing, formation, residency, banking, booking): 2
//   sensitive   price, refund, payment, legal, tax or guarantee topic: 2
//   no safe     share of events that ended in a safe fallback (no usable answer) >= 50%: 2 | > 0: 1
//
//   score >= 9 critical | >= 6 high | >= 3 medium | else low
//   floor: a sensitive topic with no safe answer seen 3+ times is at least high
//   cap:   unsupported_request is always low (analytics only); system_failure is at most medium
export function computeGapPriority(stats = {}) {
  if (GAP_PRIORITIES.includes(stats.override)) return { priority: stats.override, score: null, overridden: true, factors: {} };
  const count = Number(stats.count) || 0;
  const last7 = Number(stats.last7Days) || 0;
  const previous7 = Number(stats.previous7Days) || 0;
  const contacts = Number(stats.distinctContacts) || 0;
  const noSafe = Number(stats.noSafeAnswerCount) || 0;
  const sensitive = Array.isArray(stats.sensitiveTopics) ? stats.sensitiveTopics.length > 0 : stats.sensitiveTopics === true;
  const factors = {
    frequency: count >= 20 ? 3 : count >= 8 ? 2 : count >= 3 ? 1 : 0,
    growth: last7 >= 3 && last7 >= 2 * Math.max(1, previous7) ? 2 : last7 > previous7 ? 1 : 0,
    impact: contacts >= 5 ? 2 : contacts >= 2 ? 1 : 0,
    blocking: stats.blocking === true ? 2 : 0,
    sensitive: sensitive ? 2 : 0,
    noSafeAnswer: count > 0 && noSafe / count >= 0.5 ? 2 : noSafe > 0 ? 1 : 0
  };
  const score = Object.values(factors).reduce((sum, value) => sum + value, 0);
  let priority = score >= 9 ? "critical" : score >= 6 ? "high" : score >= 3 ? "medium" : "low";
  if (sensitive && noSafe > 0 && count >= 3 && ["medium", "low"].includes(priority)) priority = "high";
  if (stats.reason === "unsupported_request" || stats.analyticsOnly === true) priority = "low";
  if (stats.reason === "system_failure" && ["critical", "high"].includes(priority)) priority = "medium";
  return { priority, score, overridden: false, factors };
}

// ------------------------------------------------------------------ actions

export const GAP_ACTIONS = Object.freeze({
  start_review: { from: ["open"], to: "reviewing" },
  create_knowledge: { from: ["open", "reviewing", "needs_knowledge", "needs_retrieval_fix", "needs_agent_fix"], to: "needs_knowledge" },
  link_created: { from: ["open", "reviewing", "needs_knowledge", "needs_retrieval_fix", "needs_agent_fix"], to: "needs_knowledge" },
  link_existing: { from: ["open", "reviewing", "needs_knowledge", "needs_retrieval_fix", "needs_agent_fix"], to: null },
  improve_existing: { from: ["open", "reviewing", "needs_knowledge", "needs_retrieval_fix", "needs_agent_fix"], to: "needs_knowledge" },
  mark_retrieval_issue: { from: ["open", "reviewing", "needs_knowledge", "needs_agent_fix"], to: "needs_retrieval_fix", reason: "weak_retrieval" },
  mark_agent_issue: { from: ["open", "reviewing", "needs_knowledge", "needs_retrieval_fix"], to: "needs_agent_fix", reason: "agent_failure" },
  ignore: { from: ["open", "reviewing", "needs_knowledge", "needs_retrieval_fix", "needs_agent_fix"], to: "ignored", requiresReason: true },
  resolve: { from: ["open", "reviewing", "needs_knowledge", "needs_retrieval_fix", "needs_agent_fix"], to: "resolved", requiresReason: true },
  reopen: { from: ["resolved", "verified", "ignored"], to: "open", requiresReason: true },
  assign: { from: GAP_STATUSES, to: null },
  set_priority: { from: GAP_STATUSES, to: null }
});

export function planGapAction(action, currentStatus, { markWeakRetrieval = false } = {}) {
  const rule = GAP_ACTIONS[action];
  if (!rule) return { ok: false, error: "Unknown knowledge gap action." };
  if (!rule.from.includes(currentStatus)) return { ok: false, error: `This action is not available while the gap is ${GAP_STATUS_LABELS[currentStatus] || currentStatus}.` };
  let to = rule.to;
  let reason = rule.reason || null;
  if (action === "link_existing") {
    if (markWeakRetrieval) { to = "needs_retrieval_fix"; reason = "weak_retrieval"; }
    else to = currentStatus === "open" ? "reviewing" : currentStatus;
  }
  return { ok: true, status: to || currentStatus, reason, requiresReason: rule.requiresReason === true };
}

// Prefill for "Create Knowledge From Gap": title, representative questions and
// category only. The factual answer and its source are left for the
// administrator; the saved draft lands pending in the existing review flow.
export const GAP_DRAFT_ANSWER_MARKER = "[Write the approved answer and cite its source here before saving.]";

export function buildKnowledgeDraftPrefill(group = {}, examples = []) {
  const questions = [...new Set([group.title, ...examples.map((item) => item?.question || item)].map((value) => redactGapText(value, 300)).filter(Boolean))].slice(0, 6);
  const category = String(group.category || "general");
  const languages = Array.isArray(group.languages) ? group.languages : [];
  const content = [
    "Customer questions this entry must answer:",
    ...questions.map((question) => `- ${question}`),
    "",
    `Category: ${category}${group.intent ? ` | Intent: ${group.intent}` : ""}`,
    "",
    "Approved answer:",
    GAP_DRAFT_ANSWER_MARKER
  ].join("\n");
  return {
    title: gapTitle(group.title || questions[0] || "Knowledge gap"),
    content,
    language: languages.includes("en") || !languages.length ? "en" : languages[0],
    category,
    intent: group.intent || "",
    questions,
    answerMarker: GAP_DRAFT_ANSWER_MARKER
  };
}

// Admin recording switch, stored in rafa_settings under SETTINGS_KEY. The
// worker records only when its RAFA_KNOWLEDGE_GAPS master flag is on AND this
// switch is on. No row yet means "on" so enabling the master flag behaves as
// before; an unreadable setting means "off" (the worker fails closed).
export const KNOWLEDGE_GAP_SETTINGS_KEY = "knowledge_gaps";
export const KNOWLEDGE_GAP_SETTINGS_DEFAULTS = Object.freeze({ recording: true });

export function validateKnowledgeGapSettings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Knowledge gap settings must be an object.");
  if (typeof value.recording !== "boolean") throw new Error("recording must be true or false.");
  return { recording: value.recording };
}

export function readKnowledgeGapSettings(stored) {
  try { return validateKnowledgeGapSettings(stored); }
  catch { return { ...KNOWLEDGE_GAP_SETTINGS_DEFAULTS }; }
}
