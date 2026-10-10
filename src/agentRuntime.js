// REFAL-AGENT-007 — the real, callable (but not yet live) integration point
// for one Agent turn: wires the actual embedding function and a real store
// into the Ticket 001-006 tool registry and the Ticket 003-005 loop, driven
// by the Ticket 004 model decision step.
//
// Nothing in src/bot.js calls this yet (Tickets 010/017). This file exists
// so the full chain — decide -> tool -> real RAG retrieval -> respond -> the
// deterministic policy gate — can be exercised and tested end to end before
// any live traffic ever reaches it.

const { buildAgentContext } = require("./agentContext");
const { runAgentTurn, DEFAULT_MAX_STEPS } = require("./agentLoop");
const { decideNextStep: defaultDecideNextStep } = require("./agentDecision");
const { TOOL_REGISTRY } = require("./agentTools");
const { embedText: defaultEmbedText, DEFAULT_EMBEDDING_MODEL } = require("./ai");
const { INTENTS } = require("./intent");
const { validateResponse, MODEL_DRAFT_THRESHOLDS } = require("./responsePolicy");

// Factual customer questions must not depend on the model remembering to ask
// for its evidence first. Retrieve approved knowledge deterministically for
// these routed intents, then let the Agent reason over that bounded result.
const KNOWLEDGE_REQUIRED_INTENTS = new Set([
  INTENTS.COMPANY_INFO, INTENTS.BUSINESS_AREAS, INTENTS.PRICING, INTENTS.SERVICES,
  INTENTS.CONTACT, INTENTS.COMPANY_FORMATION, INTENTS.ACCOUNTING, INTENTS.VAT,
  INTENTS.CYPRUS_BUSINESS_EXPANSION, INTENTS.BUSINESS_RELOCATION, INTENTS.RESIDENCY_ENQUIRY,
  INTENTS.REAL_ESTATE_PURCHASE, INTENTS.REAL_ESTATE_INVESTMENT, INTENTS.LAND_OWNER,
  INTENTS.PROPERTY_DEVELOPMENT, INTENTS.CONSTRUCTION_TENDER, INTENTS.PROJECT_MANAGEMENT,
  INTENTS.INVESTMENT_OPPORTUNITY, INTENTS.INVESTMENT_PARTNERSHIP, INTENTS.STRATEGIC_PARTNERSHIP,
  INTENTS.INFRASTRUCTURE, INTENTS.TECHNOLOGY, INTENTS.OPERATIONS, INTENTS.STRATEGIC_ASSETS,
  INTENTS.BUSINESS_PROPOSAL, INTENTS.PROJECT_ENQUIRY, INTENTS.GENERAL_INFORMATION,
  INTENTS.REAL_ESTATE, INTENTS.LAND_DEVELOPMENT, INTENTS.CONSTRUCTION,
  INTENTS.CORPORATE_SERVICES, INTENTS.INVESTMENT, INTENTS.PARTNERSHIP
]);
const BROAD_COMPANY_INTENTS = new Set([
  INTENTS.COMPANY_INFO, INTENTS.BUSINESS_AREAS, INTENTS.SERVICES, INTENTS.CORPORATE_SERVICES
]);
const SPECIALIZED_SERVICE_INTENTS = new Set([
  INTENTS.PRICING, INTENTS.COMPANY_FORMATION, INTENTS.ACCOUNTING, INTENTS.VAT,
  INTENTS.CYPRUS_BUSINESS_EXPANSION, INTENTS.BUSINESS_RELOCATION, INTENTS.RESIDENCY_ENQUIRY,
  INTENTS.REAL_ESTATE_PURCHASE, INTENTS.REAL_ESTATE_INVESTMENT, INTENTS.LAND_OWNER,
  INTENTS.PROPERTY_DEVELOPMENT, INTENTS.CONSTRUCTION_TENDER, INTENTS.PROJECT_MANAGEMENT,
  INTENTS.INVESTMENT_OPPORTUNITY, INTENTS.INVESTMENT_PARTNERSHIP, INTENTS.STRATEGIC_PARTNERSHIP,
  INTENTS.INFRASTRUCTURE, INTENTS.TECHNOLOGY, INTENTS.OPERATIONS, INTENTS.STRATEGIC_ASSETS,
  INTENTS.BUSINESS_PROPOSAL, INTENTS.PROJECT_ENQUIRY, INTENTS.REAL_ESTATE,
  INTENTS.LAND_DEVELOPMENT, INTENTS.CONSTRUCTION, INTENTS.INVESTMENT, INTENTS.PARTNERSHIP
]);
const BROAD_SERVICE_FOLLOWUPS = Object.freeze({
  en: "Which area would you like to hear more about?",
  ar: "أي مجال حابب تعرف عنه أكثر؟",
  el: "Ποιον τομέα θα θέλατε να μάθετε καλύτερα;"
});
const COMPANY_OVERVIEW_RETRIEVAL_TERMS = [
  "Refalco Group company overview: company formation and structuring, tax and accounting, investment, real estate and property development, comprehensive investment and structural solutions.",
  "تأسيس الشركات والهيكلة، ملفات الضريبة والمحاسبة، الملفات الاستثمارية، العقار والتطوير، حلول استثمارية وهيكلية شاملة."
].join(" ");

function requiresApprovedKnowledge(intents) {
  return Array.isArray(intents) && intents.some((intent) => KNOWLEDGE_REQUIRED_INTENTS.has(intent));
}

function appendBroadServiceFollowup(result, { intents, locale, currentMessage } = {}) {
  if (result?.outcome !== "responded" || typeof result.response !== "string") return result;
  if (!Array.isArray(intents) || !intents.includes(INTENTS.SERVICES)
      || intents.some((intent) => SPECIALIZED_SERVICE_INTENTS.has(intent))) return result;
  if (/[?؟]/u.test(result.response)) return result;
  const language = String(locale || "").toLowerCase();
  const key = language.startsWith("ar") ? "ar" : language.startsWith("el") || language.startsWith("greek") ? "el" : "en";
  const response = `${result.response.trim()} ${BROAD_SERVICE_FOLLOWUPS[key]}`;
  const checked = validateResponse(response, { ...MODEL_DRAFT_THRESHOLDS, customerMessage: currentMessage });
  return checked.valid ? { ...result, response: checked.text } : result;
}

async function initialKnowledgeObservation(currentMessage, intents, toolContext, tools) {
  if (!requiresApprovedKnowledge(intents)) return [];
  const tool = tools?.searchApprovedKnowledge;
  const message = String(currentMessage || "").trim().slice(0, 1000);
  const query = Array.isArray(intents) && intents.some((intent) => BROAD_COMPANY_INTENTS.has(intent))
    ? `${message}\n${COMPANY_OVERVIEW_RETRIEVAL_TERMS}`.slice(0, 1800)
    : message;
  const args = { query };
  let result;
  try {
    if (typeof tool?.run !== "function") throw new Error("Approved knowledge search is unavailable.");
    result = await tool.run(args, toolContext);
  } catch (error) {
    result = {
      ok: false,
      status: "error",
      reasonCode: "RETRIEVAL_FAILED",
      message: String(error?.message || error).slice(0, 200),
      modelObservation: { type: "approved_knowledge", status: "error", evidence: [], truncated: false }
    };
  }
  return [{ step: 0, tool: "searchApprovedKnowledge", args, result }];
}

// Everything a tool might need, bound once per turn. Deliberately narrow:
// only what the Ticket 001 tools actually read (store, user, userId, intents,
// language, embedding settings) — never raw transport/session internals.
function buildToolContext({
  store,
  user,
  userId,
  intents = [],
  language,
  embedText = defaultEmbedText,
  embeddingModel = DEFAULT_EMBEDDING_MODEL,
  matchCount = 6,
  // REFAL-AGENT-009 booking-tool dependencies.
  // `inboundMessageId` is the real WhatsApp provider message id — the same id
  // the dedup layer in bot.js already claims against — so a duplicate-delivered
  // message naturally produces the same derived idempotencyKey and cannot
  // become a second appointment. Optional: without it the booking write tool
  // fails closed rather than inventing a fresh random key per call.
  // `policy` is the already-loaded booking policy; when omitted the tools read
  // it once via store.getBookingPolicy().
  inboundMessageId = null,
  // M4 receipt foreign key: a persisted conversation-turn UUID supplied by
  // the trusted caller. Provider message ids remain separate for booking
  // idempotency and are never substituted for this database identity.
  sourceTurnId = null,
  consentState = "unknown",
  allowedCapabilities = [],
  policy = null
} = {}) {
  return {
    store, user, userId, intents, language, embedText, embeddingModel, matchCount,
    inboundMessageId, sourceTurnId, consentState,
    allowedCapabilities: Object.freeze([...new Set((Array.isArray(allowedCapabilities) ? allowedCapabilities : []).filter((value) => typeof value === "string"))]),
    policy
  };
}

// The one real entry point for a full Agent turn. `store` and `user` must
// already be loaded by the caller (never fetched again here — see the
// double-load race documented in docs/refal-agent-refactor-progress.md).
async function runAgentTurnForContact({
  currentMessage,
  locale,
  contact,
  recentConversation,
  conversationState,
  knownCustomerFacts,
  currentOpenQuestion,
  consentState,
  allowedCapabilities,
  leadTier,
  buyingSignals,
  store,
  user,
  userId,
  intents,
  language,
  embedText,
  embeddingModel,
  matchCount,
  inboundMessageId,
  sourceTurnId,
  policy
} = {}, {
  decideNextStep = defaultDecideNextStep,
  tools = TOOL_REGISTRY,
  maxSteps = DEFAULT_MAX_STEPS
} = {}) {
  const context = buildAgentContext({
    currentMessage,
    locale,
    contact,
    recentConversation,
    conversationState,
    knownCustomerFacts,
    currentOpenQuestion,
    consentState,
    allowedCapabilities,
    leadTier,
    buyingSignals
  });
  const toolContext = buildToolContext({
    store, user, userId, intents, language, embedText, embeddingModel, matchCount,
    inboundMessageId, sourceTurnId, consentState, allowedCapabilities, policy
  });
  const initialObservations = await initialKnowledgeObservation(currentMessage, intents, toolContext, tools);
  const result = await runAgentTurn(context, { decideNextStep, tools, toolContext, maxSteps, initialObservations });
  return appendBroadServiceFollowup(result, { intents, locale, currentMessage });
}

module.exports = { runAgentTurnForContact, buildToolContext, requiresApprovedKnowledge, appendBroadServiceFollowup };
