// The model interprets customer language and selects authorized tools. Code
// remains responsible for tool authorization and every deterministic policy.
const { buildAgentContext } = require("./agentContext");
const { runAgentTurn, DEFAULT_MAX_STEPS } = require("./agentLoop");
const { decideNextStep: defaultDecideNextStep } = require("./agentDecision");
const { TOOL_REGISTRY, MAX_RAG_EVIDENCE_ITEMS } = require("./agentTools");
const { embedText: defaultEmbedText, DEFAULT_EMBEDDING_MODEL } = require("./ai");
const { assessAgentDraft } = require("./semanticGrounding");
const { getKnowledgeReranker } = require("./knowledgeRerank");
const { getRetrievalCache } = require("./knowledgeCache");
const { INTENTS } = require("./intent");
const { detectSupportIntent } = require("./knowledgeIntents");
const { redactPersonalData } = require("./ai");

function buildToolContext({
  store, user, userId, intents = [], language, embedText = defaultEmbedText,
  embeddingModel = DEFAULT_EMBEDDING_MODEL, matchCount = MAX_RAG_EVIDENCE_ITEMS,
  inboundMessageId = null, sourceTurnId = null, consentState = "unknown",
  allowedCapabilities = [], policy = null, currentMessage = "",
  knowledgeReranker = getKnowledgeReranker(), retrievalCache = getRetrievalCache(store)
} = {}) {
  return {
    store, user, userId, intents, language, embedText, embeddingModel, matchCount, knowledgeReranker, retrievalCache,
    inboundMessageId, sourceTurnId, consentState,
    currentMessage: String(currentMessage || "").slice(0, 4000),
    allowedCapabilities: Object.freeze([...new Set((Array.isArray(allowedCapabilities) ? allowedCapabilities : []).filter((value) => typeof value === "string"))]),
    policy
  };
}

// RAFA_FACTUAL_SEARCH_FIRST. Intents that are not about company facts. Any
// other classified intent (pricing, formation, tax, banking, complaint, ...)
// means the answer will need approved knowledge, so searching first saves the
// draft, grounding rejection, search, redraft round trip.
const NON_FACTUAL_INTENTS = new Set([INTENTS.GREETING, INTENTS.SMALL_TALK, INTENTS.AGENT_IDENTITY, INTENTS.LANGUAGE_CAPABILITY,
  INTENTS.APPOINTMENT, INTENTS.CONTACT, INTENTS.EXISTING_CLIENT, INTENTS.PRIVACY, INTENTS.PROMPT_INJECTION, INTENTS.UNRELATED, INTENTS.UNKNOWN]);

/**
 * Whether this turn clearly asks for company facts. Uses the preflight
 * classification first. When it found no topic (only "unknown"), the same
 * meaning-based support-intent probe the retrieval uses (guarantee, refund,
 * complaint, tax, payment, government fees, timeline, documents) decides.
 */
async function isCompanyFactualTurn({ intents = [], operation = "none", socialOnlyTurn = false, currentMessage = "", embedText } = {}) {
  if (socialOnlyTurn || operation !== "none" || !String(currentMessage || "").trim()) return { factual: false, basis: "not_applicable" };
  const list = Array.isArray(intents) ? intents : [];
  if (list.includes(INTENTS.PROMPT_INJECTION) || list.includes(INTENTS.EXISTING_CLIENT)) return { factual: false, basis: "excluded_intent" };
  if (list.some((intent) => !NON_FACTUAL_INTENTS.has(intent))) return { factual: true, basis: "preflight_intent" };
  if (!list.length || !list.every((intent) => intent === INTENTS.UNKNOWN) || typeof embedText !== "function") return { factual: false, basis: "non_factual_intent" };
  try {
    const { loadSupportIntentProfiles } = require("./agentTools");
    const [embedding, profiles] = await Promise.all([embedText(String(currentMessage).slice(0, 1000)), loadSupportIntentProfiles(embedText)]);
    const intent = detectSupportIntent(embedding, profiles);
    return intent ? { factual: true, basis: "support_intent", supportIntent: intent.id } : { factual: false, basis: "no_support_intent" };
  } catch {
    return { factual: false, basis: "probe_failed" };
  }
}

/**
 * Runs the approved-knowledge search once before the first decision, with the
 * customer's (redacted) message as the query. Read-only and never throws: a
 * failure comes back as the tool's own error observation, which the loop
 * treats exactly like a failed model-requested search.
 */
async function prefetchKnowledgeSearch({ tools = TOOL_REGISTRY, toolContext, currentMessage, onToolCall } = {}) {
  const tool = tools?.searchApprovedKnowledge;
  const query = redactPersonalData(String(currentMessage || "")).trim().slice(0, 1000);
  if (typeof tool?.run !== "function" || !query) return null;
  const args = { query };
  const started = performance.now();
  let result;
  try { result = await tool.run(args, toolContext); }
  catch (error) { result = { ok: false, status: "error", reasonCode: /^[A-Z][A-Z0-9_.-]{0,39}$/u.test(String(error?.code || "")) ? error.code : "TOOL_THREW" }; }
  const observation = { step: 0, tool: "searchApprovedKnowledge", args, result, prefetched: true };
  try {
    await onToolCall?.({ step: 0, tool: "searchApprovedKnowledge", args, result, durationMs: Math.max(0, Math.round(performance.now() - started)),
      evidenceCount: result?.modelObservation?.evidence?.length || 0, prefetched: true,
      candidateCount: result?.trace?.candidateCount, candidateIds: result?.trace?.candidateIds, selectionStatus: result?.trace?.selectionStatus,
      evidenceIds: (result?.modelObservation?.evidence || []).map((item) => item.sourceRef).filter(Boolean) });
  } catch { /* Telemetry must not change the turn. */ }
  return observation;
}

async function runAgentTurnForContact({
  currentMessage, locale, contact, recentConversation, priorConfiguredIntroduction, intents, conversationState,
  knownCustomerFacts, currentOpenQuestion, socialOnlyTurn, fastSocialTurn = false, consentState, allowedCapabilities,
  leadTier, buyingSignals, conversationPreferences, contextualWorkflow, store, user, userId, language, embedText,
  embeddingModel, matchCount, inboundMessageId, sourceTurnId, policy, responseStyle, businessGuidance, companyIdentity
} = {}, {
  decideNextStep = defaultDecideNextStep, onModelCall, onModelUsage,
  onToolCall, onPolicyRejection, onPromptBudget, assessDraft = assessAgentDraft, tools: registry = TOOL_REGISTRY, maxSteps = DEFAULT_MAX_STEPS,
  initialObservations = []
} = {}) {
  // RAFA_FAST_SOCIAL_PATH: a deterministic social turn gets no tools at all,
  // so it can neither search nor act. The draft is still grounding-reviewed.
  const tools = fastSocialTurn === true && socialOnlyTurn === true ? {} : registry;
  const context = buildAgentContext({
    currentMessage, locale, contact, recentConversation, priorConfiguredIntroduction, intents, conversationState,
    knownCustomerFacts, currentOpenQuestion, socialOnlyTurn, fastSocialTurn, consentState, allowedCapabilities,
    leadTier, buyingSignals, conversationPreferences, contextualWorkflow, responseStyle, businessGuidance, companyIdentity
  });
  const toolContext = buildToolContext({
    store, user, userId, intents, language, embedText, embeddingModel, matchCount,
    inboundMessageId, sourceTurnId, consentState, allowedCapabilities, policy, currentMessage
  });
  const measuredDecideNextStep = decideNextStep === defaultDecideNextStep
    ? (args) => decideNextStep(args, { onModelCall, onModelUsage, tools: args.tools || tools })
    : decideNextStep;
  if (typeof assessDraft !== "function") throw new TypeError("Production Agent requires independent grounding assessment.");
  const measuredAssessDraft = (args) => assessDraft(args, { onModelCall, onModelUsage });

  return runAgentTurn(context, { decideNextStep: measuredDecideNextStep, assessDraft: measuredAssessDraft, tools, toolContext, maxSteps, onToolCall, onPolicyRejection, onPromptBudget,
    initialObservations: Object.keys(tools).length ? initialObservations : [] });
}

module.exports = { runAgentTurnForContact, buildToolContext, isCompanyFactualTurn, prefetchKnowledgeSearch };
