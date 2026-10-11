"use strict";

// Import-safe composition for the live Agent answer turn. Transport, storage,
// telemetry, and typing are injected so the same post-response path can be
// exercised without starting the WhatsApp worker.
const { routeMessageResult, prepareInboundMessage, recordHistory } = require("./messageRouter");
const { runAgentTurnForContact } = require("./agentRuntime");
const { TOOL_REGISTRY } = require("./agentTools");
const { getConversationState } = require("./conversationState");
const { getConsentState } = require("./leadQualification");
const { createCommitState, buildCommitTrackingToolRegistry, decideAgentTurnOutcome } = require("./agentCommitTracking");
const { detectIntent, INTENTS } = require("./intent");
const { runAgentAfterPreflight, safeAgentSourceMessage } = require("./agentWhatsAppAdapter");
const { appendGroundedHook, guardJurisdictionAnswer, observationPolicyRows, hasInformationalIntent } = require("./salesIntelligence");
const { buildRecentConversation } = require("./agentShadow");
const { refreshCustomerTopicSummaryFromStore } = require("./conversationMemory");
const { safeErrorDiagnostics } = require("./operationalTelemetry");
const { deriveOpenQuestion } = require("./openQuestion");

async function runAgentLiveAnswerTurn({ socket, chatId, userId, text, providerMessageId = null } = {}, {
  store,
  logEvent = async () => {},
  setTyping = async () => {},
  sendStoredTextReply = async () => {},
  agentOptions = {},
  embedText,
  toolRegistry = TOOL_REGISTRY
} = {}) {
  if (!store) throw new TypeError("Agent live answer turn requires a store.");
  await setTyping(socket, chatId, true);
  const user = await store.ensureUser(userId);
  const bookingState = user?.booking?.status;
  if (["awaiting_details", "awaiting_confirmation"].includes(bookingState) || detectIntent(text).intents.includes(INTENTS.APPOINTMENT)) {
    throw new Error("Appointment turn remains owned by the deterministic booking workflow.");
  }
  const prepared = await prepareInboundMessage({ userId, incoming: String(text || "").trim(), user, store });
  const routed = await routeMessageResult({ userId, text, store, existingUser: user, preparedInbound: prepared });
  const language = prepared.classification?.language || user?.profile?.language || "english";
  const agentMessage = safeAgentSourceMessage(text, prepared, routed);
  let selectedSalesOffer = null;
  let selectedSpecialistOffer = null;
  const result = await runAgentAfterPreflight({
    prepared, routed, userId, sourceMessage: String(agentMessage || ""), locale: language,
    metadata: prepared.metadata || {}, pendingResponse: "Your message is being processed."
  }, {
    persistTurn: async ({ message, response, metadata }) => (await recordHistory(store, userId, message, response, { metadata }, { bestEffortWorkflowWrites: true })).turn,
    runAgent: async ({ sourceTurnId, allowedCapabilities }) => {
      const currentUser = await store.getUser(userId);
      const history = Array.isArray(currentUser?.history) ? currentUser.history : [];
      const priorHistory = history.filter((turn) => turn.id !== sourceTurnId);
      const conversationState = getConversationState(currentUser || {});
      const consentState = getConsentState({ user: currentUser || {}, history }) || "unknown";
      const commitState = createCommitState();
      const agentResult = await runAgentTurnForContact({
        currentMessage: String(agentMessage || ""), locale: language,
        contact: { id: userId, name: currentUser?.profile?.name || null },
        recentConversation: buildRecentConversation(priorHistory),
        conversationState, knownCustomerFacts: conversationState.agentFacts, currentOpenQuestion: deriveOpenQuestion(priorHistory.at(-1)),
        consentState, allowedCapabilities, sourceTurnId, store, user: currentUser, userId,
        intents: routed.metadata?.intent?.intents || prepared.classification?.intents || [],
        language, inboundMessageId: providerMessageId || null,
        leadTier: routed.metadata?.leadTier || "", buyingSignals: routed.metadata?.buyingSignals || []
      }, {
        tools: buildCommitTrackingToolRegistry(toolRegistry, commitState),
        onModelCall: ({ durationMs }) => logEvent("agent_model_call", { durationMs }),
        onModelUsage: (usage) => logEvent(usage.providerReported ? "ai_usage" : "ai_usage_missing", {
          source: "whatsapp-agent",
          model: usage.model,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
          costUsd: usage.costUsd,
          providerReported: usage.providerReported
        }),
        ...agentOptions,
        ...(embedText ? { embedText } : {})
      });
      const decision = decideAgentTurnOutcome({ result: agentResult, commitState, locale: language });
      if (!decision.send) {
        const failedStep = Array.isArray(agentResult.steps) ? agentResult.steps.find((step) => step?.result?.ok === false) : null;
        const knowledgeStep = Array.isArray(agentResult.steps) ? agentResult.steps.find((step) => step?.tool === "searchApprovedKnowledge") : null;
        await logEvent("agent_turn_not_clean", {
          outcome: String(agentResult.outcome || "unknown").slice(0, 40),
          reasonCode: /^[A-Za-z0-9_:,-]{1,100}$/u.test(String(agentResult.reason || ""))
            ? String(agentResult.reason).slice(0, 100) : String(failedStep?.result?.reasonCode || "not_clean").slice(0, 80),
          stepCount: Number.isInteger(agentResult.stepCount) ? agentResult.stepCount : 0,
          knowledgeStatus: String(knowledgeStep?.result?.modelObservation?.status || "not_retrieved").slice(0, 30),
          toolsUsed: Array.isArray(agentResult.toolsUsed) ? agentResult.toolsUsed.filter((tool) => typeof tool === "string").slice(0, 12) : []
        });
      }
      if (!decision.send || agentResult.outcome !== "responded") return decision.send ? decision.responseText : null;
      const policyRows = observationPolicyRows(agentResult.steps);
      const jurisdiction = guardJurisdictionAnswer({ message: agentMessage, response: decision.responseText, rows: policyRows, language });
      const hook = appendGroundedHook({
        message: agentMessage, response: jurisdiction.response, language,
        history: history.filter((turn) => turn.id !== sourceTurnId), user: currentUser, rows: policyRows,
        specialistEligible: routed.metadata?.priority?.handoverRequired === true, answerComplete: true,
        suppressed: {
          informational: hasInformationalIntent(routed.metadata?.intent?.intents),
          complaint: (routed.metadata?.intent?.intents || []).includes(INTENTS.COMPLAINT),
          sensitive: Boolean(prepared.metadata?.privacySafeQuestion || prepared.metadata?.safety?.restricted),
          optOut: ["denied", "revoked"].includes(consentState),
          pendingBooking: ["awaiting_details", "awaiting_confirmation"].includes(currentUser?.booking?.status),
          handoverActive: Boolean(currentUser?.profile?.handover?.status === "active"),
          complianceLock: Boolean(routed.metadata?.complianceLock?.active)
        }
      });
      selectedSalesOffer = hook.salesOffer;
      selectedSpecialistOffer = hook.specialistOffer;
      return hook.response;
    },
    updateTurn: ({ turnId, patch }) => store.updateHistoryTurn(userId, turnId,
      selectedSalesOffer || selectedSpecialistOffer
        ? { ...patch, metadata: { ...(selectedSalesOffer ? { salesOffer: selectedSalesOffer } : {}), ...(selectedSpecialistOffer ? { specialistOffer: selectedSpecialistOffer } : {}) } }
        : patch),
    afterTurnPersisted: async ({ turnId, message }) => {
      try { await refreshCustomerTopicSummaryFromStore({ store, userId, currentMessage: message, sourceTurnId: turnId }); }
      catch (error) { await logEvent("conversation_summary_error", safeErrorDiagnostics(error)); }
    },
    send: async (response, turn) => {
      await setTyping(socket, chatId, false);
      await sendStoredTextReply(socket, chatId, response, userId, turn);
    }
  });
  if (result.persistenceUpdated === false) {
    try { await logEvent("agent_reply_persistence_failed", { persistenceUpdated: false, delivered: result.sent === true }); }
    catch { /* Observability must not cause a persisted customer turn to be retried. */ }
  }
  if (result.sent !== true) {
    try { await logEvent("agent_reply_delivery_failed", {
      sourceTurnId: result.sourceTurnId || null, persistenceUpdated: result.persistenceUpdated === true
    }); } catch { /* Delivery has an ambiguous outcome; never route it through a retry. */ }
  }
  return {
    outcome: result.route, responseLength: result.response.length,
    sourceTurnId: result.sourceTurnId || null, delivered: result.sent === true,
    persistenceUpdated: result.persistenceUpdated === true
  };
}

module.exports = { runAgentLiveAnswerTurn };
