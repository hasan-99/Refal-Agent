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
const { runAgentAfterPreflight, safeAgentSourceMessage } = require("./agentWhatsAppAdapter");
const { buildRecentConversation } = require("./agentShadow");
const { refreshCustomerTopicSummaryFromStore } = require("./conversationMemory");
const { safeErrorDiagnostics } = require("./operationalTelemetry");
const { deriveOpenQuestion } = require("./openQuestion");
const { randomUUID } = require("node:crypto");
const { sanitizeControlledInspection } = require("./controlledDiagnostics");
const { profile } = require("./companyProfile");
const { INTENTS } = require("./intent");

function isSocialOnlyClassification(classification = {}) {
  const intents = Array.isArray(classification.intents) ? classification.intents : [];
  const socialIntents = new Set([INTENTS.GREETING, INTENTS.SMALL_TALK, INTENTS.AGENT_IDENTITY, INTENTS.UNKNOWN]);
  return classification.operation === "none"
    && intents.some((intent) => [INTENTS.GREETING, INTENTS.SMALL_TALK, INTENTS.AGENT_IDENTITY].includes(intent))
    && intents.every((intent) => socialIntents.has(intent));
}

async function runAgentLiveAnswerTurn({ socket, chatId, userId, text, providerMessageId = null, traceId = randomUUID() } = {}, {
  store,
  logEvent = async () => {},
  setTyping = async () => {},
  sendStoredTextReply = async () => {},
  agentOptions = {},
  preflightOptions = {},
  embedText,
  toolRegistry = TOOL_REGISTRY
} = {}) {
  if (!store) throw new TypeError("Agent live answer turn requires a store.");
  await setTyping(socket, chatId, true);
  const user = await store.ensureUser(userId);
  const controlled = user?.profile?.qaControlledDiagnostics === true && user?.profile?.followUpBlocked === true;
  const sessionStartForPreflight = controlled ? Date.parse(user?.profile?.qaSessionStartedAt || "") : NaN;
  const preflightUser = Number.isFinite(sessionStartForPreflight) ? { ...user,
    history: (user.history || []).filter((turn) => Date.parse(turn.at) >= sessionStartForPreflight) } : user;
  const activeRegistry = controlled ? Object.fromEntries(Object.entries(toolRegistry).filter(([name]) =>
    ["searchApprovedKnowledge", "lookupActiveOffer", "lookupRenewalFees", "lookupGovernmentFees", "searchPropertyInventory", "lookupReservationRules"].includes(name))) : toolRegistry;
  const bookingState = user?.booking?.status;
  const prepared = await prepareInboundMessage({ userId, incoming: String(text || "").trim(), user: preflightUser, store, contextual: true,
    ...preflightOptions, onModelCall: (measurement) => logEvent("agent_model_call", { ...measurement, traceId }) });
  const socialOnlyTurn = isSocialOnlyClassification(prepared.classification);
  prepared.metadata.traceId = traceId;
  if (["awaiting_details", "awaiting_confirmation"].includes(bookingState) || prepared.classification?.operation === "booking_request") {
    const error = new Error("Appointment turn remains owned by the deterministic booking workflow.");
    error.code = "BOOKING_WORKFLOW_REQUIRED";
    error.preparedInbound = prepared;
    throw error;
  }
  const routed = await routeMessageResult({ userId, text, store, existingUser: user, preparedInbound: prepared });
  const language = prepared.classification?.language || user?.profile?.language || "english";
  const agentMessage = safeAgentSourceMessage(text, prepared, routed);
  const result = await runAgentAfterPreflight({
    prepared, routed, userId, sourceMessage: String(agentMessage || ""), locale: language,
    metadata: prepared.metadata || {}, pendingResponse: "Your message is being processed."
  }, {
    persistTurn: async ({ message, response, metadata }) => (await recordHistory(store, userId, message, response, { metadata }, { bestEffortWorkflowWrites: true })).turn,
    runAgent: async ({ sourceTurnId, allowedCapabilities }) => {
      const currentUser = await store.getUser(userId);
      const history = Array.isArray(currentUser?.history) ? currentUser.history : [];
      const sessionStart = controlled ? Date.parse(currentUser?.profile?.qaSessionStartedAt || "") : NaN;
      const priorHistory = history.filter((turn) => turn.id !== sourceTurnId && (!Number.isFinite(sessionStart) || Date.parse(turn.at) >= sessionStart));
      const brand = profile.brand.toLocaleLowerCase();
      const group = profile.groupName.toLocaleLowerCase();
      const priorConfiguredIntroduction = priorHistory.some((turn) => {
        const response = typeof turn?.response === "string" ? turn.response.toLocaleLowerCase() : "";
        return Boolean(brand && group && response.includes(brand) && response.includes(group));
      });
      const conversationState = getConversationState(currentUser || {});
      const consentState = getConsentState({ user: currentUser || {}, history }) || "unknown";
      const commitState = createCommitState();
      const agentResult = await runAgentTurnForContact({
        currentMessage: String(agentMessage || ""), locale: language,
        contact: {
          id: userId,
          // Prefer an explicit name in the current message for this reply only.
          // It is not persisted as profile memory; the transcript remains the
          // durable record and can provide continuity on later turns.
          name: prepared?.currentTurnCustomerName || currentUser?.profile?.name || null,
          nameSource: prepared?.currentTurnCustomerName ? "customer_stated" : currentUser?.profile?.nameSource || null
        },
        recentConversation: buildRecentConversation(priorHistory),
        priorConfiguredIntroduction,
        conversationState, knownCustomerFacts: conversationState.agentFacts,
        currentOpenQuestion: socialOnlyTurn ? null : deriveOpenQuestion(priorHistory.at(-1)), socialOnlyTurn,
        consentState, allowedCapabilities, sourceTurnId, store, user: currentUser, userId,
        intents: routed.metadata?.intent?.intents || prepared.classification?.intents || [],
        language, inboundMessageId: providerMessageId || null,
        leadTier: routed.metadata?.leadTier || "", buyingSignals: routed.metadata?.buyingSignals || [],
        conversationPreferences: currentUser?.profile?.conversationPreferences || {},
        contextualWorkflow: prepared.classification?.operation || "none"
      }, {
        ...agentOptions,
        tools: buildCommitTrackingToolRegistry(activeRegistry, commitState),
        onModelCall: async (measurement) => {
          await logEvent("agent_model_call", { ...measurement, traceId, sourceTurnId });
          await agentOptions.onModelCall?.(measurement);
        },
        onToolCall: async ({ step, tool, args, result, durationMs, evidenceCount, evidenceChars, evidenceIds, skipped, ...measurements }) => {
          await logEvent("agent_tool_call", {
          traceId, sourceTurnId, step, tool, query: args?.query, searchQueries: result?.trace?.searchQueries, status: result?.status || (result?.ok ? "ok" : "error"),
          reasonCode: result?.reasonCode, durationMs, evidenceCount, evidenceChars, evidenceIds,
          ...measurements, ...(result?.trace || {}),
          resultCount: Array.isArray(result?.data) ? result.data.length : evidenceCount,
          ...(skipped ? { outcome: "skipped" } : {})
          });
          await agentOptions.onToolCall?.({ step, tool, args, result, durationMs, evidenceCount, evidenceChars, evidenceIds, skipped, ...measurements });
        },
        onPolicyRejection: async ({ step, type, reasonCodes, draft, evidence, claims }) => {
          await logEvent("agent_policy_rejected", { traceId, sourceTurnId, step, tool: type, validationReasons: reasonCodes });
          await agentOptions.onPolicyRejection?.({ step, type, reasonCodes, draft, evidence, claims });
          if (controlled && typeof store.saveControlledInspection === "function") {
            const inspection = sanitizeControlledInspection({ traceId, step, type, reasonCodes, draft, evidence, claims },
              [userId, currentUser?.phone, currentUser?.profile?.name]);
            if (inspection) {
              try {
                const saved = await store.saveControlledInspection(userId, sourceTurnId, inspection);
                await logEvent("agent_inspection_saved", { traceId, step, inspectionId: saved?.inspectionId });
              } catch (error) { await logEvent("agent_inspection_persistence_failed", { traceId, step, ...safeErrorDiagnostics(error) }); }
            }
          }
        },
        onModelUsage: (usage) => logEvent(usage.providerReported ? "ai_usage" : "ai_usage_missing", {
          traceId, sourceTurnId,
          source: "whatsapp-agent",
          model: usage.model,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
          costUsd: usage.costUsd,
          providerReported: usage.providerReported
        }),
        ...(embedText ? { embedText } : {})
      });
      const decision = decideAgentTurnOutcome({ result: agentResult, commitState, locale: language });
      await logEvent("agent_turn_completed", { traceId, sourceTurnId, outcome: agentResult.outcome,
        stepCount: agentResult.stepCount, toolsUsed: agentResult.toolsUsed, terminationCause: agentResult.reason || "validated_answer" });
      if (!decision.send) {
        const failedStep = Array.isArray(agentResult.steps) ? agentResult.steps.find((step) => step?.result?.ok === false) : null;
        const knowledgeStep = Array.isArray(agentResult.steps) ? agentResult.steps.find((step) => step?.tool === "searchApprovedKnowledge") : null;
        await logEvent("agent_turn_not_clean", {
          traceId,
          outcome: String(agentResult.outcome || "unknown").slice(0, 40),
          reasonCode: /^[A-Za-z0-9_:,-]{1,100}$/u.test(String(agentResult.reason || ""))
            ? String(agentResult.reason).slice(0, 100) : String(failedStep?.result?.reasonCode || "not_clean").slice(0, 80),
          stepCount: Number.isInteger(agentResult.stepCount) ? agentResult.stepCount : 0,
          knowledgeStatus: String(knowledgeStep?.result?.modelObservation?.status || "not_retrieved").slice(0, 30),
          toolsUsed: Array.isArray(agentResult.toolsUsed) ? agentResult.toolsUsed.filter((tool) => typeof tool === "string").slice(0, 12) : []
        });
      }
      if (!decision.send || agentResult.outcome !== "responded") return decision.send ? decision.responseText : null;
      return decision.responseText;
    },
    updateTurn: ({ turnId, patch }) => store.updateHistoryTurn(userId, turnId, patch),
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
