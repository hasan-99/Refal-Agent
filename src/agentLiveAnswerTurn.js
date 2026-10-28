"use strict";

// Import-safe composition for the live Agent answer turn. Transport, storage,
// telemetry, and typing are injected so the same post-response path can be
// exercised without starting the WhatsApp worker.
const { routeMessageResult, prepareInboundMessage, recordHistory, latestCustomerStatedName } = require("./messageRouter");
const { runAgentTurnForContact, buildToolContext, isCompanyFactualTurn, prefetchKnowledgeSearch } = require("./agentRuntime");
const { latencyFlags, getKnowledgeVersionReader } = require("./knowledgeCache");
const { getSessionEvidenceCache } = require("./sessionEvidenceCache");
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
const { identityFromProfile } = require("./companyIdentitySettings");
const { INTENTS } = require("./intent");
const { RESPONSE_STYLE_DEFAULTS } = require("./responseStyle");
const { BUSINESS_GUIDANCE_DEFAULTS } = require("./businessGuidance");
const { conversationFlags, anyConversationFlag } = require("./conversationFlags");
const { buildSessionMemory, getSessionMemoryStore, sameName } = require("./sessionMemory");
const { readProfileMemory, deriveProfileUpdate, persistProfileMemory } = require("./userProfileMemory");
const { createQualityCounters, turnQualityFields } = require("./conversationQuality");

const NON_TOPIC_INTENTS = new Set([INTENTS.GREETING, INTENTS.SMALL_TALK, INTENTS.AGENT_IDENTITY, INTENTS.UNKNOWN, INTENTS.PROMPT_INJECTION,
  INTENTS.UNRELATED, INTENTS.LANGUAGE_CAPABILITY, INTENTS.COMPLAINT, INTENTS.PRIVACY]);

// Live-only facts for the session memory overlay: outcome, evidence refs,
// non-search tool results. Ids, statuses and counts only, never text.
function sessionOverlayFromResult(agentResult = {}, { intents = [], handoffStatus = null } = {}) {
  const steps = Array.isArray(agentResult.steps) ? agentResult.steps : [];
  const evidenceRefs = [...new Set(steps.flatMap((step) => step?.result?.modelObservation?.type === "approved_knowledge" ? step.result.modelObservation.evidence || [] : [])
    .map((item) => item?.sourceRef).filter((ref) => typeof ref === "string"))];
  const searches = steps.filter((step) => step?.tool === "searchApprovedKnowledge" && step?.result?.ok === true);
  const topics = (Array.isArray(intents) ? intents : []).filter((intent) => typeof intent === "string" && !NON_TOPIC_INTENTS.has(intent)).map((intent) => intent.replace(/_/gu, " "));
  const clean = ["responded", "clarified"].includes(agentResult.outcome);
  const searchedWithoutEvidence = searches.length > 0 && evidenceRefs.length === 0;
  return {
    answered: agentResult.outcome === "responded" && !(topics.length && searchedWithoutEvidence),
    clarified: agentResult.outcome === "clarified",
    unanswered: topics.length > 0 && (!clean || searchedWithoutEvidence),
    unansweredReason: !clean ? String(agentResult.outcome || "not_clean").slice(0, 40) : searchedWithoutEvidence ? "no_approved_evidence" : null,
    topics, evidenceRefs,
    search: searches.length ? { itemCount: searches.reduce((sum, step) => sum + (step.result.modelObservation?.evidence?.length || 0), 0) } : null,
    toolResults: steps.filter((step) => step?.tool && !["searchApprovedKnowledge", "previousTurnApprovedKnowledge", "responsePolicyCheck"].includes(step.tool))
      .map((step) => ({ tool: step.tool, ok: step?.result?.ok === true, status: step?.result?.status || "" })),
    handoffStatus
  };
}

// Per-turn latency and cache counters for agent_turn_completed. Counts,
// durations and statuses only, never message text, queries or evidence.
function createTurnMetrics() {
  const metrics = { llmCalls: 0, decisionModelCalls: 0, decisionModelMs: 0, groundingModelCalls: 0, groundingModelMs: 0,
    finalAnswerModelMs: null, knowledgeSearches: 0, knowledgeSearchMs: 0, dbSearchMs: 0, embeddingMs: 0, fusionMs: 0, rerankMs: 0,
    versionCheckMs: 0, dbRpcMs: 0, dbExpandMs: 0, dbPolicyMs: 0, searchCacheHits: 0, searchCacheMisses: 0, rerankCacheHits: 0, rerankCacheMisses: 0, repeatedSearchesSkipped: 0 };
  return {
    metrics,
    modelCall(measurement = {}) {
      const durationMs = Number.isFinite(measurement.durationMs) ? measurement.durationMs : 0;
      const outcome = String(measurement.outcome || "");
      if (/fast_path$/u.test(outcome)) return;
      metrics.llmCalls += 1;
      if (measurement.stage === "validation") { metrics.groundingModelCalls += 1; metrics.groundingModelMs += durationMs; return; }
      metrics.decisionModelCalls += 1;
      metrics.decisionModelMs += durationMs;
      if (outcome === "decision_respond" || outcome === "decision_clarify") metrics.finalAnswerModelMs = durationMs;
    },
    toolCall({ tool, result, durationMs, skipped } = {}) {
      if (tool !== "searchApprovedKnowledge") return;
      if (skipped) { metrics.repeatedSearchesSkipped += 1; return; }
      metrics.knowledgeSearches += 1;
      metrics.knowledgeSearchMs += Number.isFinite(durationMs) ? durationMs : 0;
      const timing = result?.trace?.timing || {};
      metrics.dbSearchMs += Number(timing.searchMs) || 0;
      metrics.embeddingMs += Number(timing.embeddingMs) || 0;
      metrics.fusionMs += Number(timing.fusionMs) || 0;
      metrics.rerankMs += Number(timing.rerankMs) || 0;
      metrics.versionCheckMs += Number(timing.versionMs) || 0;
      metrics.dbRpcMs += Number(timing.server?.rpcMs) || 0;
      metrics.dbExpandMs += Number(timing.server?.expandMs) || 0;
      metrics.dbPolicyMs += Number(timing.server?.policyMs) || 0;
      metrics.searchCacheHits += Number(result?.trace?.cache?.search?.hits) || 0;
      metrics.searchCacheMisses += Number(result?.trace?.cache?.search?.misses) || 0;
      if (result?.trace?.rerank?.cache === "hit") metrics.rerankCacheHits += 1;
      if (result?.trace?.rerank?.cache === "miss") metrics.rerankCacheMisses += 1;
    }
  };
}

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
  const turnStartedAt = performance.now();
  const timing = {};
  const flags = latencyFlags();
  const turnMetrics = createTurnMetrics();
  // Conversation-behaviour flags. All off: none of the code below runs and the
  // Agent context, prompts, gates and events are exactly as before.
  const convoFlags = conversationFlags();
  const convoFeatures = anyConversationFlag(convoFlags) ? { structuredSessionMemory: convoFlags.structuredSessionMemory,
    answerFirstStyle: convoFlags.answerFirstStyle, truthfulActionStates: convoFlags.truthfulActionStates, smartFollowups: convoFlags.smartFollowups } : null;
  const qualityCounters = convoFeatures ? createQualityCounters() : null;
  const sessionMemoryStore = convoFeatures ? getSessionMemoryStore({ idleTtlMs: convoFlags.sessionIdleTtlMs }) : null;
  let sessionState = null;
  let persistOutcome = null;
  let completedResponseText = null;
  let profileMemoryStatus = null;
  let pendingProfileUpdate = null;
  // The knowledge version stamp is read once at the start of the turn, in
  // parallel with setup and preflight; the reader trusts it for 5 seconds.
  const versionReader = flags.sessionEvidenceCache || flags.searchCache ? getKnowledgeVersionReader(store) : null;
  void versionReader?.read();
  const measure = async (key, action) => {
    const startedAt = performance.now();
    try { return await action(); }
    finally { timing[key] = Math.max(0, Math.round(performance.now() - startedAt)); }
  };
  let completedAgentResult = null;
  let completedSourceTurnId = null;
  let user;
  let responseStyle = RESPONSE_STYLE_DEFAULTS;
  let businessGuidance = BUSINESS_GUIDANCE_DEFAULTS;
  let companyIdentity = identityFromProfile(profile);
  await measure("setupDurationMs", async () => {
    await setTyping(socket, chatId, true);
    user = await store.ensureUser(userId);
    const settingsReads = await Promise.allSettled([
      typeof store.getResponseStyle === "function" ? store.getResponseStyle() : Promise.resolve(null),
      typeof store.getCompanyIdentity === "function" ? store.getCompanyIdentity() : Promise.resolve(null),
      typeof store.getBusinessGuidance === "function" ? store.getBusinessGuidance() : Promise.resolve(null)
    ]);
    if (settingsReads[0].status === "fulfilled" && settingsReads[0].value) responseStyle = settingsReads[0].value;
    if (settingsReads[1].status === "fulfilled" && settingsReads[1].value) companyIdentity = settingsReads[1].value;
    if (settingsReads[2].status === "fulfilled" && settingsReads[2].value) businessGuidance = settingsReads[2].value;
  });
  const controlled = user?.profile?.qaControlledDiagnostics === true && user?.profile?.followUpBlocked === true;
  const sessionStartForPreflight = controlled ? Date.parse(user?.profile?.qaSessionStartedAt || "") : NaN;
  const preflightUser = Number.isFinite(sessionStartForPreflight) ? { ...user,
    history: (user.history || []).filter((turn) => Date.parse(turn.at) >= sessionStartForPreflight) } : user;
  const activeRegistry = controlled ? Object.fromEntries(Object.entries(toolRegistry).filter(([name]) =>
    ["searchApprovedKnowledge", "lookupActiveOffer", "lookupRenewalFees", "lookupGovernmentFees", "searchPropertyInventory", "lookupReservationRules"].includes(name))) : toolRegistry;
  const bookingState = user?.booking?.status;
  const prepared = await measure("preflightDurationMs", () => prepareInboundMessage({ userId, incoming: String(text || "").trim(), user: preflightUser, store, contextual: true,
    ...preflightOptions, onModelCall: (measurement) => { timing.preflightOutcome = String(measurement?.outcome || "").slice(0, 40); turnMetrics.modelCall(measurement); return logEvent("agent_model_call", { ...measurement, traceId }); } }));
  const socialOnlyTurn = isSocialOnlyClassification(prepared.classification);
  const fastSocialTurn = socialOnlyTurn && prepared.classification?.source === "deterministic_social_fast_path";
  prepared.metadata.traceId = traceId;
  if (["awaiting_details", "awaiting_confirmation"].includes(bookingState) || prepared.classification?.operation === "booking_request") {
    const error = new Error("Appointment turn remains owned by the deterministic booking workflow.");
    error.code = "BOOKING_WORKFLOW_REQUIRED";
    error.preparedInbound = prepared;
    throw error;
  }
  const routed = await measure("routeDurationMs", () => routeMessageResult({ userId, text, store, existingUser: user, preparedInbound: prepared }));
  const language = prepared.classification?.language || user?.profile?.language || "english";
  const agentMessage = safeAgentSourceMessage(text, prepared, routed);
  // RAFA_SESSION_EVIDENCE_CACHE: approved evidence from the immediately
  // previous turn, offered only if the knowledge version is unchanged and
  // every chunk is still approved and unexpired.
  const sessionEvidence = flags.sessionEvidenceCache ? getSessionEvidenceCache({ ttlMs: flags.sessionEvidenceTtlMs }) : null;
  let evidenceReuse = { status: sessionEvidence ? (socialOnlyTurn ? "skipped_social" : "none") : "disabled" };
  let turnKnowledgeVersion = null;
  if (sessionEvidence && !socialOnlyTurn && routed?.shouldUseAi === true) {
    turnKnowledgeVersion = await measure("evidenceReuseLookupDurationMs", () => versionReader.read());
    evidenceReuse = sessionEvidence.lookup({ sessionKey: userId, previousTurnId: preflightUser?.history?.at(-1)?.id || null, knowledgeVersion: turnKnowledgeVersion });
  }
  // RAFA_FACTUAL_SEARCH_FIRST: a company-fact turn with no reusable evidence
  // searches before the first draft. The search is read-only and starts now so
  // it overlaps persisting the source turn; no model call or action runs
  // before that turn is durable.
  let searchFirst = { factual: false, basis: flags.factualSearchFirst ? "not_applicable" : "disabled" };
  let prefetchPromise = null;
  if (flags.factualSearchFirst && routed?.shouldUseAi === true && evidenceReuse.status !== "hit" && activeRegistry.searchApprovedKnowledge) {
    const prefetchContext = buildToolContext({ store, user: preflightUser, userId, language, currentMessage: String(agentMessage || ""),
      intents: routed.metadata?.intent?.intents || prepared.classification?.intents || [], ...(embedText ? { embedText } : {}) });
    const probeEmbed = prefetchContext.retrievalCache ? prefetchContext.retrievalCache.embedFor(prefetchContext.embedText) : prefetchContext.embedText;
    searchFirst = await measure("searchFirstDecisionDurationMs", () => isCompanyFactualTurn({ intents: prefetchContext.intents,
      operation: prepared.classification?.operation || "none", socialOnlyTurn, currentMessage: agentMessage, embedText: probeEmbed }));
    if (searchFirst.factual) {
      prefetchPromise = prefetchKnowledgeSearch({ tools: activeRegistry, toolContext: prefetchContext, currentMessage: agentMessage,
        onToolCall: async ({ step, tool, args, result, durationMs, ...measurements }) => {
          turnMetrics.toolCall({ tool, result, durationMs });
          await logEvent("agent_tool_call", { traceId, step, tool, status: result?.status || (result?.ok ? "ok" : "error"), reasonCode: result?.reasonCode,
            durationMs, ...measurements, ...(result?.trace || {}), searchQueries: undefined });
        } });
    }
  }
  const result = await runAgentAfterPreflight({
    prepared, routed, userId, sourceMessage: String(agentMessage || ""), locale: language,
    metadata: prepared.metadata || {}, pendingResponse: "Your message is being processed."
  }, {
    persistTurn: async ({ message, response, metadata }) => measure("sourceTurnPersistDurationMs", async () => {
      const recorded = await recordHistory(store, userId, message, response, { metadata }, { bestEffortWorkflowWrites: true });
      // Kept for the handoff state machine; read only when a flag is on.
      persistOutcome = { handoverRequested: recorded?.handoverPersisted !== undefined || Boolean(recorded?.turn?.metadata?.handover),
        handoverPersisted: recorded?.handoverPersisted };
      return recorded.turn;
    }),
    runAgent: async ({ sourceTurnId, allowedCapabilities }) => {
      completedSourceTurnId = sourceTurnId;
      const currentUser = await measure("contextLoadDurationMs", () => store.getUser(userId));
      const history = Array.isArray(currentUser?.history) ? currentUser.history : [];
      const sessionStart = controlled ? Date.parse(currentUser?.profile?.qaSessionStartedAt || "") : NaN;
      const priorHistory = history.filter((turn) => turn.id !== sourceTurnId && (!Number.isFinite(sessionStart) || Date.parse(turn.at) >= sessionStart));
      const priorCustomerName = latestCustomerStatedName(priorHistory);
      const brand = companyIdentity.brand.toLocaleLowerCase();
      const group = companyIdentity.groupName.toLocaleLowerCase();
      const priorConfiguredIntroduction = priorHistory.some((turn) => {
        const response = typeof turn?.response === "string" ? turn.response.toLocaleLowerCase() : "";
        return Boolean(brand && group && response.includes(brand) && response.includes(group));
      });
      const conversationState = getConversationState(currentUser || {});
      const consentState = getConsentState({ user: currentUser || {}, history }) || "unknown";
      const commitState = createCommitState();
      const turnIntents = routed.metadata?.intent?.intents || prepared.classification?.intents || [];
      let contactForAgent = {
        id: userId,
        // Keep customer-stated names transient: the latest explicit name in
        // this conversation transcript is the durable source for continuity.
        // A saved profile name is only a fallback when the transcript has no
        // explicit name (for example, older contacts with imported memory).
        name: prepared?.currentTurnCustomerName || priorCustomerName || currentUser?.profile?.name || null,
        nameSource: prepared?.currentTurnCustomerName || priorCustomerName
          ? "customer_stated" : currentUser?.profile?.nameSource || null
      };
      if (convoFeatures) {
        await measure("sessionMemoryDurationMs", async () => {
          const profileMemory = convoFlags.userProfileMemory ? readProfileMemory(currentUser, { retentionDays: convoFlags.profileRetentionDays }) : null;
          sessionState = buildSessionMemory({ history: priorHistory, currentMessage: String(agentMessage || ""), language, user: currentUser || {},
            currentTurn: { id: sourceTurnId, intents: turnIntents, handoverRequested: persistOutcome?.handoverRequested === true,
              handoverPersisted: persistOutcome?.handoverPersisted, specialistRequested: prepared.classification?.operation === "specialist_request" },
            overlay: sessionMemoryStore.overlay(userId), profileMemory, evidenceReuse, idleTtlMs: convoFlags.sessionIdleTtlMs });
          if (convoFlags.userProfileMemory) {
            const existing = profileMemory || (currentUser?.profile?.memoryProfile ? { fields: {} } : null);
            pendingProfileUpdate = deriveProfileUpdate(sessionState, existing);
          }
        });
        if (convoFlags.structuredSessionMemory) {
          // Only a confirmed customer-stated name (session or durable profile)
          // is used. A corrected or forgotten name is never re-used, and a
          // WhatsApp/contact label never becomes a name.
          const name = sessionState.user?.name?.status === "confirmed" ? sessionState.user.name.value : null;
          const rejected = (value) => (sessionState.user?.nameCorrections || []).some((entry) => sameName(entry.value, value));
          const fallbackAllowed = !name && contactForAgent.name && !rejected(contactForAgent.name) && !sessionState.conversation?.forgetRequested && !sessionState.user?.forgotten;
          contactForAgent = name ? { id: userId, name, nameSource: "customer_stated" }
            : fallbackAllowed ? contactForAgent : { id: userId, name: null, nameSource: null };
        }
      }
      const initialObservations = [
        ...(evidenceReuse.status === "hit" ? [evidenceReuse.observation] : []),
        ...(prefetchPromise ? [await measure("searchFirstWaitDurationMs", () => prefetchPromise)].filter(Boolean) : [])
      ];
      const agentResult = await measure("agentExecutionDurationMs", () => runAgentTurnForContact({
        currentMessage: String(agentMessage || ""), locale: language,
        responseStyle,
        businessGuidance,
        companyIdentity,
        contact: contactForAgent,
        recentConversation: buildRecentConversation(priorHistory),
        priorConfiguredIntroduction,
        conversationState, knownCustomerFacts: conversationState.agentFacts,
        currentOpenQuestion: socialOnlyTurn ? null : deriveOpenQuestion(priorHistory.at(-1)), socialOnlyTurn, fastSocialTurn,
        consentState, allowedCapabilities, sourceTurnId, store, user: currentUser, userId,
        intents: routed.metadata?.intent?.intents || prepared.classification?.intents || [],
        language, inboundMessageId: providerMessageId || null,
        leadTier: routed.metadata?.leadTier || "", buyingSignals: routed.metadata?.buyingSignals || [],
        conversationPreferences: currentUser?.profile?.conversationPreferences || {},
        contextualWorkflow: prepared.classification?.operation || "none",
        ...(convoFeatures ? { conversationFeatures: convoFeatures, sessionState, conversationQuality: qualityCounters } : {})
      }, {
        ...agentOptions,
        tools: buildCommitTrackingToolRegistry(activeRegistry, commitState),
        initialObservations,
        onModelCall: async (measurement) => {
          turnMetrics.modelCall(measurement);
          await logEvent("agent_model_call", { ...measurement, traceId, sourceTurnId });
          await agentOptions.onModelCall?.(measurement);
        },
        onToolCall: async ({ step, tool, args, result, durationMs, evidenceCount, evidenceChars, evidenceIds, skipped, ...measurements }) => {
          turnMetrics.toolCall({ tool, result, durationMs, skipped });
          await logEvent("agent_tool_call", {
          traceId, sourceTurnId, step, tool, query: args?.query, searchQueries: result?.trace?.searchQueries, status: result?.status || (result?.ok ? "ok" : "error"),
          reasonCode: result?.reasonCode, durationMs, evidenceCount, evidenceChars, evidenceIds,
          ...measurements, ...(result?.trace || {}),
          resultCount: Array.isArray(result?.data) ? result.data.length : evidenceCount,
          ...(skipped ? { outcome: "skipped" } : {})
          });
          await agentOptions.onToolCall?.({ step, tool, args, result, durationMs, evidenceCount, evidenceChars, evidenceIds, skipped, ...measurements });
        },
        // Prompt budget per decision: sizes and counts only, no content.
        onPromptBudget: async (report) => {
          timing.promptBudget = { layout: report.layout, totalBytes: report.totalBytes, headroomBytes: report.headroomBytes,
            systemBytes: report.systemBytes, historyBytes: report.historyBytes, evidenceBudgetBytes: report.evidenceBudgetBytes,
            evidenceItemsIncluded: report.evidenceItemsIncluded, evidenceItemsDropped: report.evidenceItemsDropped,
            ...(report.sessionStateBytes !== undefined ? { sessionStateBytes: report.sessionStateBytes } : {}) };
          if (report.evidenceItemsIncluded > 0 || report.evidenceItemsDropped > 0) await logEvent("agent_prompt_budget", { traceId, sourceTurnId, ...report });
          await agentOptions.onPromptBudget?.(report);
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
      }));
      const decision = decideAgentTurnOutcome({ result: agentResult, commitState, locale: language });
      completedAgentResult = agentResult;
      if (convoFeatures) {
        completedResponseText = decision.send ? decision.responseText : null;
        try {
          sessionMemoryStore.recordTurn(userId, sourceTurnId, sessionOverlayFromResult(agentResult, { intents: turnIntents,
            handoffStatus: sessionState?.actions?.handoff?.verified ? sessionState.actions.handoff.status : null }));
        } catch { /* The overlay is an optimisation; the transcript rebuild stays authoritative. */ }
      }
      if (agentResult.outcome === "prompt_budget_exhausted") {
        await logEvent("prompt_budget_exhausted", { traceId, sourceTurnId, stepCount: agentResult.stepCount, ...(timing.promptBudget || {}) });
      }
      if (sessionEvidence && !socialOnlyTurn) {
        // Recorded under the version read BEFORE this turn searched, so a
        // knowledge change during the turn can only cause a miss next turn.
        try { timing.evidenceRecorded = sessionEvidence.record({ sessionKey: userId, sourceTurnId, knowledgeVersion: turnKnowledgeVersion,
          language, observations: agentResult.steps }).recorded === true; } catch { timing.evidenceRecorded = false; }
      }
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
    updateTurn: ({ turnId, patch }) => measure("turnUpdateDurationMs", () => store.updateHistoryTurn(userId, turnId, patch)),
    afterTurnPersisted: async ({ turnId, message }) => {
      try { await measure("topicSummaryDurationMs", () => refreshCustomerTopicSummaryFromStore({ store, userId, currentMessage: message, sourceTurnId: turnId })); }
      catch (error) { await logEvent("conversation_summary_error", safeErrorDiagnostics(error)); }
    },
    send: async (response, turn) => {
      await measure("replyDeliveryDurationMs", async () => {
        await setTyping(socket, chatId, false);
        await sendStoredTextReply(socket, chatId, response, userId, turn);
      });
    }
  });
  if (pendingProfileUpdate) {
    // RAFA_USER_PROFILE_MEMORY: written after the reply, best effort, so it
    // adds no latency before the answer and a failure changes nothing.
    profileMemoryStatus = (await persistProfileMemory(store, userId, pendingProfileUpdate)).status;
  }
  if (completedAgentResult) {
    timing.postAnswerDurationMs = Math.max(0, (timing.turnUpdateDurationMs || 0) + (timing.topicSummaryDurationMs || 0) + (timing.replyDeliveryDurationMs || 0));
    timing.totalDurationMs = Math.max(0, Math.round(performance.now() - turnStartedAt));
    await logEvent("agent_turn_completed", { traceId, sourceTurnId: completedSourceTurnId, outcome: completedAgentResult.outcome,
      stepCount: completedAgentResult.stepCount, toolsUsed: completedAgentResult.toolsUsed,
      terminationCause: completedAgentResult.reason || "validated_answer", delivered: result.sent === true,
      persistenceUpdated: result.persistenceUpdated === true, ...timing, ...turnMetrics.metrics,
      fastSocialPath: fastSocialTurn, evidenceReuse: evidenceReuse.status,
      reusedChunkCount: evidenceReuse.status === "hit" ? evidenceReuse.chunkIds.length : 0,
      searchFirst: searchFirst.basis, searchFirstSupportIntent: searchFirst.supportIntent || null, searchPrefetched: Boolean(prefetchPromise),
      ...(convoFeatures ? { ...turnQualityFields({ counters: qualityCounters, sessionState, responseText: completedResponseText || "", agentResult: completedAgentResult }),
        profileMemory: profileMemoryStatus } : {}) });
  }
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
