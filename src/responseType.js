"use strict";

const { INTENTS, detectIntents } = require("./intent");

const RESPONSE_TYPES = Object.freeze(["social_response", "document_review", "pricing_answer", "service_answer", "direct_answer", "safe_refusal"]);

function isTranslationRequest(message) {
  const text = String(message || "").normalize("NFKC");
  return /\b(?:translate|translation|how\s+(?:do|would|can)\s+(?:i|you)\s+say)\b.{0,180}\b(?:into|to|in)\s+(?:arabic|english|greek)\b|\b(?:translate|translation)\b.{0,180}(?:العربية|الإنجليزية|اليونانية)|(?:ترجم|ترجمة|كيف\s+(?:أقول|اقول|تقول)).{0,180}(?:(?:إلى|الى|ل)?(?:العربية|الإنجليزية|اليونانية)|بالعربية|بالإنجليزية|باليونانية)|(?:μετάφρασ\p{L}*|πώς\s+(?:λέγεται|θα\s+πω)|πώς\s+το\s+λέμε).{0,180}στα\s+(?:ελληνικ\p{L}*|αγγλικ\p{L}*|αραβικ\p{L}*)/iu.test(text);
}

function translationTargetLanguage(message) {
  if (!isTranslationRequest(message)) return null;
  const text = String(message || "").normalize("NFKC");
  if (/\barabic\b|αραβικ\p{L}*|(?:العربية|بالعربية|للعربية)/iu.test(text)) return "arabic";
  if (/\benglish\b|αγγλικ\p{L}*|(?:الإنجليزية|بالإنجليزية|للإنجليزية)/iu.test(text)) return "english";
  if (/\bgreek\b|ελληνικ\p{L}*|(?:اليونانية|باليونانية|لليونانية)/iu.test(text)) return "greek";
  return null;
}

function isPackageTermsRequest(message) {
  const text = String(message || "").normalize("NFKC");
  return /\b(?:package|bundle|plan|offer)\b.{0,120}\b(?:include|included|inclusions|exclude|excluded|exclusions|cover|covers)\b|\b(?:include|included|inclusions|exclude|excluded|exclusions)\b.{0,120}\b(?:package|bundle|plan|offer)\b|(?:باقة|الباقة|حزمة).{0,120}(?:داخل|تشمل|بتشمل|ما\s*بتشمل|لا\s*تشمل|مش\s*شامل|غير\s*شامل|يورو|€|سعر|تكلفة)|(?:πακέτ\p{L}*).{0,120}(?:περιλαμβάν\p{L}*|δεν\s+περιλαμβάν\p{L}*|τι\s+δεν\s+περιλαμβάν\p{L}*)/iu.test(text);
}

// Select a per-turn answer mode from the existing trusted preflight results.
// This labels the task for generation, retry, and dashboard diagnostics; it
// does not contain or select customer-facing wording.
function resolveResponseType({ intents = [], additionalIntents = [], socialOnlyTurn = false, attachmentReviewContinuation = false,
  attachmentReviewPending = false, safetyRestricted = false, currentMessage = "" } = {}) {
  const lexicalIntents = typeof currentMessage === "string" && currentMessage.trim() ? detectIntents(currentMessage) : [];
  const current = new Set([...(Array.isArray(intents) ? intents : []), ...(Array.isArray(additionalIntents) ? additionalIntents : []), ...lexicalIntents]);
  if (current.has(INTENTS.PROMPT_INJECTION) || current.has(INTENTS.PRIVACY)) return "safe_refusal";
  if (attachmentReviewContinuation === true || attachmentReviewPending === true) return "document_review";
  if (socialOnlyTurn === true) return "social_response";
  if (isTranslationRequest(currentMessage)) return "direct_answer";
  if (isPackageTermsRequest(currentMessage)) return "pricing_answer";
  if (current.has(INTENTS.PRICING)) return "pricing_answer";
  if ([INTENTS.SERVICES, INTENTS.COMPANY_FORMATION, INTENTS.COMPANY_INFO, INTENTS.BUSINESS_AREAS].some((intent) => current.has(intent))) return "service_answer";
  if (safetyRestricted) return "safe_refusal";
  return "direct_answer";
}

function isResponseType(value) {
  return RESPONSE_TYPES.includes(value);
}

function responseTypeInstruction(value) {
  const type = isResponseType(value) ? value : "direct_answer";
  const instructions = {
    social_response: "Respond naturally to the current social message; do not turn it into a company-information answer.",
    document_review: "Continue the requested document review using the actual uploaded document. Do not replace it with a company-information answer or ask again what to review.",
    pricing_answer: "Answer the customer's pricing request directly from current approved evidence. If they ask about package terms, address each requested inclusion and exclusion, and preserve relevant price, VAT, period, offer limitation and registration-confirmation conditions stated in the evidence. State an unavailable term only as unconfirmed. Do not add possible fee categories, no-hidden-fee assurances, or a qualification question unless supported and needed to answer this request. If an item is included only for a period, state that period before describing later renewal or separate charges; do not imply charges apply during the included period.",
    service_answer: "Answer the requested service question directly from current approved evidence and stay within its scope.",
    direct_answer: "Answer the customer's current request directly when supported; ask for clarification only when a necessary detail is genuinely missing.",
    safe_refusal: "Refuse the unsafe request in the customer's language and offer only a supported safe alternative."
  };
  return `Required response type: ${type}. ${instructions[type]}`;
}

module.exports = { RESPONSE_TYPES, isResponseType, isTranslationRequest, translationTargetLanguage, resolveResponseType, responseTypeInstruction };
