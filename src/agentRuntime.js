// The model interprets customer language and selects authorized tools. Code
// remains responsible for tool authorization and every deterministic policy.
const { buildAgentContext } = require("./agentContext");
const { runAgentTurn, DEFAULT_MAX_STEPS } = require("./agentLoop");
const { decideNextStep: defaultDecideNextStep } = require("./agentDecision");
const { TOOL_REGISTRY, MAX_RAG_EVIDENCE_ITEMS } = require("./agentTools");
const { embedText: defaultEmbedText, DEFAULT_EMBEDDING_MODEL } = require("./ai");

function buildToolContext({
  store, user, userId, intents = [], language, embedText = defaultEmbedText,
  embeddingModel = DEFAULT_EMBEDDING_MODEL, matchCount = MAX_RAG_EVIDENCE_ITEMS,
  inboundMessageId = null, sourceTurnId = null, consentState = "unknown",
  allowedCapabilities = [], policy = null, currentMessage = ""
} = {}) {
  return {
    store, user, userId, intents, language, embedText, embeddingModel, matchCount,
    inboundMessageId, sourceTurnId, consentState,
    currentMessage: String(currentMessage || "").slice(0, 4000),
    allowedCapabilities: Object.freeze([...new Set((Array.isArray(allowedCapabilities) ? allowedCapabilities : []).filter((value) => typeof value === "string"))]),
    policy
  };
}

async function runAgentTurnForContact({
  currentMessage, locale, contact, recentConversation, conversationState,
  knownCustomerFacts, currentOpenQuestion, consentState, allowedCapabilities,
  leadTier, buyingSignals, store, user, userId, intents, language, embedText,
  embeddingModel, matchCount, inboundMessageId, sourceTurnId, policy
} = {}, {
  decideNextStep = defaultDecideNextStep, onModelCall, onModelUsage,
  onToolCall, onPolicyRejection, tools = TOOL_REGISTRY, maxSteps = DEFAULT_MAX_STEPS
} = {}) {
  const context = buildAgentContext({
    currentMessage, locale, contact, recentConversation, conversationState,
    knownCustomerFacts, currentOpenQuestion, consentState, allowedCapabilities,
    leadTier, buyingSignals
  });
  const toolContext = buildToolContext({
    store, user, userId, intents, language, embedText, embeddingModel, matchCount,
    inboundMessageId, sourceTurnId, consentState, allowedCapabilities, policy, currentMessage
  });
  const measuredDecideNextStep = decideNextStep === defaultDecideNextStep
    ? (args) => decideNextStep(args, { onModelCall, onModelUsage, tools: args.tools || tools })
    : decideNextStep;
  return runAgentTurn(context, { decideNextStep: measuredDecideNextStep, tools, toolContext, maxSteps, onToolCall, onPolicyRejection });
}

module.exports = { runAgentTurnForContact, buildToolContext };
