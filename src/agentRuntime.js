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
  return runAgentTurn(context, { decideNextStep, tools, toolContext, maxSteps });
}

module.exports = { runAgentTurnForContact, buildToolContext };
