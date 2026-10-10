const path = require("node:path");
const { randomUUID } = require("node:crypto");
const http = require("node:http");
const {
  default: makeWASocket,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  getContentType,
  useMultiFileAuthState
} = require("@whiskeysockets/baileys");
const P = require("pino");
const qrcode = require("qrcode-terminal");
const { loadProjectEnv } = require("./env");
const { askOpenRouter, embedText, warmEmbeddingPipeline, DEFAULT_EMBEDDING_MODEL, redactPersonalData } = require("./ai");
const { createStore } = require("./supabaseStore");
const { routeMessageResult, prepareInboundMessage, recordHistory, buildReplyEditPayload, persistWhatsAppSentMessage, wasNameRequested } = require("./messageRouter");
const { handleBookingMessage } = require("./booking");
const { generateAndEmailReport } = require("./report");
const { startMonthlyReportSchedule } = require("./reportScheduler");
const { startFollowUpSchedule } = require("./followUp");
const { startReminderSchedule } = require("./reminderScheduler");
const { startNotificationSchedule } = require("./notificationScheduler");
const { isPhoneJid, resolvePhoneJid } = require("./whatsappContact");
const { AI_LIMIT_MESSAGE, allowAiMessage, allowIncomingMessage } = require("./rateLimiter");
const { answerFromEvidence, knowledgeEvidenceMetadata, noApprovedEvidenceReply } = require("./refalcoAnswer");
const { detectMessageLanguage } = require("./language");
const { sendDisconnectAlert, sendRecoveryAlert } = require("./connectionAlerts");
const { isPairingOnly } = require("./runtimePolicy");
const { classifyLeadTemperature } = require("./leadTemperature");
const { clearLoggedOutAuth, pairingFailureMessage, shouldRequestPairingCode } = require("./whatsappPairing");
const { buildConversationContext, refreshCustomerTopicSummary } = require("./conversationMemory");
const { buildLocalConversationRecap } = require("./conversationRecap");
const { buildOperationalEvent, safeErrorDiagnostics } = require("./operationalTelemetry");
const { runShadowAgentTurn, recordShadowComparison, buildRecentConversation } = require("./agentShadow");
const { runRoutedTurn } = require("./turnRouting");
const { runAgentTurnForContact } = require("./agentRuntime");
const { TOOL_REGISTRY } = require("./agentTools");
const { getConversationState } = require("./conversationState");
const { getConsentState } = require("./leadQualification");
const { createCommitState, buildCommitTrackingToolRegistry, decideAgentTurnOutcome } = require("./agentCommitTracking");
const { buildKnowledgeSearchQuery } = require("./knowledgeQuery");
const { collectDynamicFallback, isDynamicQuestion, applyDynamicPrecedence } = require("./dynamicDataFallback");
const { detectIntent, INTENTS } = require("./intent");
const { runAgentAfterPreflight } = require("./agentWhatsAppAdapter");
const { appendGroundedHook, guardJurisdictionAnswer, observationPolicyRows, hasInformationalIntent } = require("./salesIntelligence");
const { selectOfferForTurn } = require("./offerOrchestration");
const { shouldEnterBookingPath, shouldDeferBookingHandler } = require("./buyingSignals");

const rootDir = path.join(__dirname, "..");
loadProjectEnv(rootDir);

const pairingOnly = isPairingOnly();
const authPath = process.env.BAILEYS_AUTH_PATH || path.join(rootDir, "auth_info_baileys");
const allowGroups = process.env.ALLOW_GROUPS === "true";
const selfTestPrefix = process.env.SELF_TEST_PREFIX || "!rafa";

const store = createStore();
const processedMessageIds = new Set();
let followUpTask = null;
let reminderTask = null;
let notificationTask = null;
let disconnectAlertState = null;
let activeSocket = null;
let reconnectTimer = null;
let stopping = false;
let pairingCodeRequested = false;
let whatsappConnected = false;
let localControlServer = null;
const requestedPhoneNumber = String(process.env.RAFA_PHONE_NUMBER || "").replace(/\D/g, "");
const pairingMethod = process.env.RAFA_PAIRING_METHOD === "qr" ? "qr" : "code";
let whatsappIdentityVerified = !requestedPhoneNumber;

function notifyDashboard(message) {
  if (process.send && process.connected) process.send(message);
}

function stopWorker() {
  if (stopping) return;
  stopping = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (followUpTask) followUpTask.stop();
  if (reminderTask) reminderTask.stop();
  if (notificationTask) notificationTask.stop();
  if (activeSocket) activeSocket.end(new Error("RAFA disconnected by an administrator."));
  if (localControlServer) {
    localControlServer.close();
    localControlServer = null;
  }
  notifyDashboard({ type: "connection", connection: "close" });
  const exitTimer = setTimeout(() => process.exit(0), 400);
  exitTimer.unref?.();
}

if (process.env.RAFA_DASHBOARD_MANAGED === "true") {
  process.on("message", (message) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) return;
    if (message.type === "disconnect") stopWorker();
    if (message.type === "deliver-reply-edit") void deliverReplyEdit(message);
    if (message.type === "deliver-customer-text") void deliverCustomerText(message);
  });
  process.on("disconnect", stopWorker);
  process.on("SIGTERM", stopWorker);
}

function logEvent(event, fields = {}) {
  const safeEvent = buildOperationalEvent(event, fields);
  if (store.logEvent) {
    return store.logEvent(safeEvent.event, safeEvent.fields).catch((error) => {
      console.error("RAFA event log failed:", safeErrorDiagnostics(error));
    });
  }

  console.warn("RAFA event store is unavailable:", safeEvent.event, safeEvent.fields);
}

const embeddingWarmStartedAt = performance.now();
void warmEmbeddingPipeline().then(() => {
  logEvent("response_stage", { stage: "embedding_model_warmup", durationMs: Math.round(performance.now() - embeddingWarmStartedAt) });
}).catch((error) => {
  logEvent("embedding_warmup_error", safeErrorDiagnostics(error));
});

function removeCustomerCitations(text) {
  return String(text || "")
    .replace(/\n\s*(?:sources?|المصادر)\s*:\s*[\s\S]*$/iu, "")
    .replace(/https?:\/\/\S+/giu, "")
    .trim();
}

function startDisconnectAlertTimer(disconnectedAt) {
  if (disconnectAlertState) return;

  disconnectAlertState = {
    disconnectedAt,
    alertSent: false,
    timer: setTimeout(async () => {
      try {
        await sendDisconnectAlert({ disconnectedAt });
        disconnectAlertState.alertSent = true;
        logEvent("disconnect_alert_sent", { disconnectedAt: disconnectedAt.toISOString() });
      } catch (error) {
        console.error("Disconnect alert failed:", safeErrorDiagnostics(error));
        logEvent("disconnect_alert_error", safeErrorDiagnostics(error));
      }
    }, Number(process.env.DISCONNECT_ALERT_DELAY_MS || 120000))
  };
}

async function clearDisconnectAlertOnRecovery() {
  if (!disconnectAlertState) return;

  const state = disconnectAlertState;
  clearTimeout(state.timer);
  disconnectAlertState = null;

  if (!state.alertSent) return;

  try {
    const recoveredAt = new Date();
    await sendRecoveryAlert({ disconnectedAt: state.disconnectedAt, recoveredAt });
    logEvent("recovery_alert_sent", {
      disconnectedAt: state.disconnectedAt.toISOString(),
      recoveredAt: recoveredAt.toISOString()
    });
  } catch (error) {
    console.error("Recovery alert failed:", safeErrorDiagnostics(error));
    logEvent("recovery_alert_error", safeErrorDiagnostics(error));
  }
}

function isSupportedChatId(chatId) {
  if (!chatId) return false;
  if (chatId === "status@broadcast") return false;
  if (chatId.endsWith("@broadcast")) return false;
  if (chatId.endsWith("@g.us")) return allowGroups;
  return chatId.endsWith("@s.whatsapp.net") || chatId.endsWith("@c.us") || chatId.endsWith("@lid");
}

async function rememberWhatsAppContact(userId, message, socket) {
  const pushName = String(message.pushName || "").trim();
  const phoneJid = await resolvePhoneJid(userId, message, socket?.signalRepository?.lidMapping);
  await store.updateUser(userId, (user) => {
    user.whatsapp = {
      ...(user.whatsapp || {}),
      jid: userId,
      lastSeenAt: new Date().toISOString()
    };
    if (phoneJid) user.whatsapp.phoneJid = phoneJid;

    if (pushName) {
      user.whatsapp.pushName = pushName;
      if (!user.profile.whatsappName) user.profile.whatsappName = pushName;
    }
  });
}

async function backfillKnownWhatsAppPhoneNumbers(socket) {
  try {
    const lidMapping = socket?.signalRepository?.lidMapping;
    if (typeof store.allUsers !== "function" || typeof lidMapping?.getPNsForLIDs !== "function") return;
    const users = await store.allUsers({ includeHistory: false });
    const candidates = (users || []).filter((user) => String(user.id || "").endsWith("@lid") && !user.whatsapp?.phoneJid);
    if (!candidates.length) return;
    const mappings = await lidMapping.getPNsForLIDs(candidates.map((user) => user.id));
    const byLid = new Map((mappings || []).map((mapping) => [mapping.lid, mapping.pn]));
    const updates = candidates.filter((user) => isPhoneJid(byLid.get(user.id)));
    for (let index = 0; index < updates.length; index += 5) {
      await Promise.all(updates.slice(index, index + 5).map((user) => store.updateUser(user.id, (draft) => {
        const phoneJid = byLid.get(user.id);
        if (isPhoneJid(phoneJid)) draft.whatsapp = { ...(draft.whatsapp || {}), jid: user.id, phoneJid };
      })));
    }
    if (updates.length) logEvent("whatsapp_lid_phone_mappings_backfilled", { mappedCount: updates.length });
  } catch (error) {
    logEvent("whatsapp_lid_phone_mapping_backfill_error", safeErrorDiagnostics(error));
  }
}

function unwrapMessage(content) {
  let current = content;
  for (let index = 0; index < 5; index += 1) {
    if (!current) return current;
    if (current.ephemeralMessage?.message) {
      current = current.ephemeralMessage.message;
      continue;
    }
    if (current.viewOnceMessage?.message) {
      current = current.viewOnceMessage.message;
      continue;
    }
    if (current.viewOnceMessageV2?.message) {
      current = current.viewOnceMessageV2.message;
      continue;
    }
    if (current.documentWithCaptionMessage?.message) {
      current = current.documentWithCaptionMessage.message;
      continue;
    }
    return current;
  }
  return current;
}

function messageType(message) {
  return getContentType(unwrapMessage(message?.message)) || "unknown";
}

function audioMessageContent(message) {
  return unwrapMessage(message?.message)?.audioMessage || null;
}

function extractText(message) {
  const content = unwrapMessage(message?.message);
  if (!content) return "";

  return String(
    content.conversation ||
      content.extendedTextMessage?.text ||
      content.imageMessage?.caption ||
      content.videoMessage?.caption ||
      content.buttonsResponseMessage?.selectedDisplayText ||
      content.listResponseMessage?.title ||
      content.templateButtonReplyMessage?.selectedDisplayText ||
      ""
  ).trim();
}

// REFAL-AGENT-030 — the full, unchanged legacy turn. Every booking/handover/
// RAG/output-policy behavior below is exactly what it was before this
// ticket; this function was only renamed (from `answerMessage`) so the new
// routing decision point below can call it as one of two interchangeable
// turn implementations. Always the one invoked when the Agent live flag is
// off (the default), and also the one invoked as the pre-side-effect
// fallback when the Agent path is selected but fails during turn setup
// (before any Agent tool call could have run) — see src/turnRouting.js.
async function runLegacyAnswerTurn(socket, chatId, userId, text, requestTrace = {}) {
  const requestStartedAt = requestTrace.startedAt || performance.now();
  const traceId = requestTrace.traceId || randomUUID();
  const stage = (name, startedAt, fields = {}) => logEvent("response_stage", {
    traceId,
    stage: name,
    durationMs: Math.round(performance.now() - startedAt),
    ...fields
  });
  let stageStartedAt = performance.now();
  await setTyping(socket, chatId, true);
  stage("typing_start", stageStartedAt);
  let response;
  let routed;
  // REFAL-AGENT-013: captured (not discarded) so the comparison below can
  // join it with the legacy outcome once both are known; still never
  // awaited by the live reply path — see the `finally` block.
  let shadowTurnPromise = Promise.resolve(null);
  // REFAL-AGENT-013: a safe, bounded-shape summary of what the LEGACY path
  // did this turn (never the response text itself beyond its length), set
  // once per branch right before that branch's own response becomes final.
  // Read only in the `finally` block below, after this function's single
  // customer-visible response has already been decided.
  let legacySummary = null;

  try {
  stageStartedAt = performance.now();
  const user = await store.ensureUser(userId);
  stage("contact_load", stageStartedAt);
  stageStartedAt = performance.now();
  const prepared = await prepareInboundMessage({ userId, incoming: String(text || "").trim(), user, store });
  stage("normalize_classify_prepare", stageStartedAt, { intentCount: prepared.classification.intents.length, language: prepared.classification.language });
  // REFAL-AGENT-010 — shadow-only: off by default (REFAL_AGENT_SHADOW_ENABLED),
  // fire-and-forget, never awaited by the live reply path, and never allowed
  // to change `response`/`routed` below. See src/agentShadow.js.
  shadowTurnPromise = runShadowAgentTurn({ userId, text, user, store, classification: prepared.classification, traceId, logEvent }).catch(() => null);
  const bookingStartedAt = performance.now();
  // Regulated and privacy-risk messages must reach the safety router first;
  // the booking parser can otherwise persist raw sensitive details.
  // Owner-approved MB-B1..B5 signals enter the existing guarded booking
  // conversation even when the intent classifier misses their phrasing. The
  // booking handler still requires a date/time and never confirms availability
  // or creates an appointment from a signal alone.
  const explicitBookingRequest = shouldEnterBookingPath(prepared);
  const bookingSelection = explicitBookingRequest ? selectOfferForTurn({
    candidates: [{ type: "booking", id: "explicit-appointment-request", mode: "action", validated: true }],
    context: { answerComplete: true, explicitBookingRequest: true, explicitBookingConsent: true }
  }) : null;
  const booking = shouldDeferBookingHandler(prepared, bookingSelection)
    ? null : await handleBookingMessage({ userId, text, store, user });
  stage("booking_gate", bookingStartedAt, { entered: Boolean(booking) });
  if (booking) {
    response = booking.response;
    stageStartedAt = performance.now();
    // REFAL-AGENT-011: verifiedBookingConfirmed is read by responsePolicy.js's
    // hasVerifiedBookingClaim from a real store-reported appointment status —
    // never from `response`/model text — so recordHistory's policy gate can
    // tell booking.js's own deterministic confirmation message apart from an
    // unverified claim and stop storing a generic fallback in its place.
    const turn = (await recordHistory(store, userId, text, response, { metadata: { ...prepared.metadata, verifiedBookingConfirmed: booking.appointment?.status === "confirmed" } })).turn;
    stage("turn_and_workflow_persistence", stageStartedAt, { route: "booking" });
    stageStartedAt = performance.now();
    try {
      const user = await store.getUser(userId);
      await refreshCustomerTopicSummary({ store, userId, user, currentMessage: text });
    } catch (error) {
      logEvent("conversation_summary_error", safeErrorDiagnostics(error));
    }
    stage("topic_summary", stageStartedAt);
    stageStartedAt = performance.now();
    await refreshLeadTemperature(userId);
    stage("lead_temperature", stageStartedAt);

    if (booking.appointment?.status === "pending_review" && booking.details && booking.user) {
      try {
        const appointmentId = booking.appointment.id;
        const payload = {
          name: booking.user.profile?.name || "",
          phone: booking.user.phone || String(userId || "").replace(/@.+$/, ""),
          startsAt: booking.details.start.toISOString(),
          timezone: booking.policy.timezone,
          purpose: booking.details.purpose,
          dashboardUrl: process.env.DASHBOARD_PUBLIC_URL || process.env.DASHBOARD_URL || ""
        };
        await store.createNotification({
          appointmentId,
          kind: "owner_review",
          expectedAppointmentStatus: "pending_review",
          idempotencyKey: `${appointmentId}:owner-review-email`,
          payload
        });
        if (process.env.OWNER_WHATSAPP_JID) {
          await store.createNotification({
            appointmentId,
            kind: "customer_message",
            recipient: process.env.OWNER_WHATSAPP_JID,
            expectedAppointmentStatus: "pending_review",
            idempotencyKey: `${appointmentId}:owner-review-whatsapp`,
            payload: { text: `New WhatsApp appointment request for review: ${payload.name || payload.phone}, ${payload.startsAt} (${payload.timezone}). ${payload.purpose}` }
          });
        }
      } catch (error) {
        console.error("Booking notification queue failed:", safeErrorDiagnostics(error));
        logEvent("booking_notification_queue_error", safeErrorDiagnostics(error));
      }
    }
    await setTyping(socket, chatId, false);
    stageStartedAt = performance.now();
    await sendStoredTextReply(socket, chatId, response, userId, turn);
    stage("whatsapp_delivery", stageStartedAt);
    stage("request_total", requestStartedAt);
    legacySummary = { primaryIntentCategory: prepared.classification.primary, usedBookingPath: true, usedHandoverPath: false, responseLength: response.length };
    return;
  }

  stageStartedAt = performance.now();
  routed = await routeMessageResult({
    userId,
    text,
    store,
    existingUser: user,
    preparedInbound: prepared
  });
  stage("route_and_deterministic_persistence", stageStartedAt, { aiRequired: routed.shouldUseAi });

  response = routed.response;
  if (routed.shouldUseAi) {
    const customerText = routed.metadata?.privacySafeQuestion || String(text || "").trim();
    const knowledgeSearchQuery = buildKnowledgeSearchQuery(customerText, routed.user, routed.metadata?.intent?.intents);
    let evidence = [];
    let stageAt = performance.now();
    try {
      const embedding = await embedText(knowledgeSearchQuery);
      stage("embedding", stageAt);
      stageAt = performance.now();
      evidence = store.searchKnowledge ? await store.searchKnowledge(knowledgeSearchQuery, embedding, DEFAULT_EMBEDDING_MODEL, 6) : [];
      stage("knowledge_retrieval", stageAt, { evidenceCount: evidence.length });
    } catch (error) {
      console.error("Refalco Group knowledge search failed:", safeErrorDiagnostics(error));
      logEvent("knowledge_search_error", safeErrorDiagnostics(error));
    }

    let dynamicResult = { requested: [], live: [], statuses: [] };
    try {
      dynamicResult = await collectDynamicFallback(store, customerText);
    } catch (error) {
      logEvent("dynamic_data_lookup_error", safeErrorDiagnostics(error));
    }
    const precedence = applyDynamicPrecedence(evidence, dynamicResult.live, dynamicResult.requested.map((item) => item.kind), {
      failClosed: isDynamicQuestion(customerText) && dynamicResult.requested.length === 0
    });
    evidence = precedence.evidence;
    const grounded = answerFromEvidence(evidence, { allowPricing: routed.metadata?.intent?.intents?.includes("pricing") === true, customerQuestion: redactPersonalData(customerText) });
    let modelRequestMade = false;
    let modelResponseUsed = false;
    const localRecap = buildLocalConversationRecap({ history: routed.user?.history || [], evidence, currentMessage: customerText, language: detectMessageLanguage(customerText), workflowState: { handover: routed.user?.profile?.handover, specialistFollowUp: routed.user?.profile?.specialistFollowUp } });
    const citations = localRecap?.citations || grounded?.citations || [];
    response = localRecap?.response || grounded?.answer || noApprovedEvidenceReply(detectMessageLanguage(customerText), { pricing: routed.metadata?.intent?.intents?.includes("pricing") });

    if (!localRecap && evidence.length && process.env.OPENROUTER_API_KEY && !allowAiMessage(userId)) {
      stageAt = performance.now();
      const knowledgeEvidence = knowledgeEvidenceMetadata(evidence);
      const turn = (await recordHistory(store, userId, text, AI_LIMIT_MESSAGE, {
        metadata: { ...routed.metadata, retrieval: "approved_knowledge", knowledgeEvidence, abstained: !grounded }
      })).turn;
      stage("turn_and_workflow_persistence", stageAt, { route: "ai_quota_limit" });
      stageStartedAt = performance.now();
      await refreshLeadTemperature(userId);
      stage("lead_temperature", stageStartedAt);
      await setTyping(socket, chatId, false);
      stageStartedAt = performance.now();
      await sendStoredTextReply(socket, chatId, AI_LIMIT_MESSAGE, userId, turn);
      stage("whatsapp_delivery", stageStartedAt);
      stage("request_total", requestStartedAt);
      logEvent("rate_limited_ai_daily", {});
      legacySummary = { primaryIntentCategory: prepared.classification.primary, usedBookingPath: false, usedHandoverPath: Boolean(routed.handover), responseLength: AI_LIMIT_MESSAGE.length };
      return;
    }

    // Give the model the approved evidence bundle even when no deterministic
    // excerpt is safe to send. The model can answer from history or clearly
    // abstain; relevance controls only the local fallback, not helpfulness.
    if (!localRecap && evidence.length && process.env.OPENROUTER_API_KEY) {
      stageAt = performance.now();
      try {
        const conversation = buildConversationContext(routed.user, { currentMessage: customerText });
        modelRequestMade = true;
        const aiResponse = await askOpenRouter({
          text: customerText,
          evidence,
          includeSources: false,
          conversationSummary: conversation.summary,
          conversationTurns: conversation.turns,
          // W1.7.7 — without this the booking rule could never be tier-aware:
          // the prompt builder always received an empty tier and therefore
          // always emitted the "do not offer a call at this stage" default,
          // which is BLK-6's behaviour under a new name. The classification is
          // internal and never shown to the customer.
          leadTier: routed.metadata?.leadTier || classifyLeadTemperature({ history: routed.user?.history || [], booking: routed.user?.booking }).status,
          buyingSignals: routed.metadata?.buyingSignals || [],
          onUsage: async (usage) => {
            try {
              await logEvent(usage.providerReported ? "ai_usage" : "ai_usage_missing", {
                source: "whatsapp",
                userId,
                model: usage.model,
                promptTokens: usage.promptTokens,
                completionTokens: usage.completionTokens,
                totalTokens: usage.totalTokens,
                costUsd: usage.costUsd,
                // W1.7.8 — so a bad answer in the logs can be traced to the
                // exact prompt version that produced it. M14 rolls the prompt
                // back independently of the code; that needs this field.
                promptVersion: usage.promptVersion
              });
            } catch (error) {
              console.error("OpenRouter usage log failed:", safeErrorDiagnostics(error));
            }
          }
        });
        if (aiResponse) {
          response = aiResponse;
          modelResponseUsed = true;
        }
        stage("model_generation", stageAt, { modelUsed: Boolean(aiResponse) });
        logEvent("ai", { enabled: Boolean(aiResponse), sourceCount: citations.length });
      } catch (error) {
        console.error("OpenRouter failed; using a localized safe reply:", safeErrorDiagnostics(error));
        // Keep the answer selected above: it is either a relevant, validated
        // excerpt from approved evidence or a precise no-approved-evidence
        // reply. Replacing it with a generic prompt loses the customer's ask.
        stage("model_generation", stageAt, { modelUsed: false });
        logEvent("ai_error", { ...safeErrorDiagnostics(error), sourceCount: citations.length });
      }
    }

    response = removeCustomerCitations(response);
    const m5Safety = guardJurisdictionAnswer({
      message: customerText, response, rows: evidence, language: detectMessageLanguage(customerText)
    });
    response = m5Safety.response;
    const hookResult = appendGroundedHook({
      message: customerText, response, language: detectMessageLanguage(customerText),
      history: routed.user?.history || [], user: routed.user, rows: evidence,
      specialistEligible: routed.metadata?.priority?.handoverRequired === true,
      answerComplete: Boolean(grounded?.answer || modelResponseUsed),
      suppressed: {
        informational: hasInformationalIntent(routed.metadata?.intent?.intents),
        complaint: (routed.metadata?.intent?.intents || []).includes(INTENTS.COMPLAINT),
        sensitive: Boolean(routed.metadata?.privacySafeQuestion || prepared.metadata?.safety?.restricted),
        declined: false,
        optOut: ["denied", "revoked"].includes(getConsentState({ user: routed.user || {}, history: routed.user?.history || [] })),
        pendingBooking: ["awaiting_details", "awaiting_confirmation"].includes(routed.user?.booking?.status),
        handoverActive: Boolean(routed.user?.profile?.handover?.status === "active"),
        complianceLock: Boolean(routed.metadata?.complianceLock?.active)
      }
    });
    response = hookResult.response;
    if (hookResult.salesOffer) routed.metadata.salesOffer = hookResult.salesOffer;
    if (hookResult.specialistOffer) routed.metadata.specialistOffer = hookResult.specialistOffer;
    if (routed.metadata?.privacySafeQuestion) {
      const reminder = {
        arabic: "ولحماية خصوصيتك، لا تبعت كلمات مرور أو بيانات بطاقات أو دخول هون.",
        greek: "Για την προστασία του απορρήτου σας, μην στέλνετε κωδικούς πρόσβασης, στοιχεία κάρτας ή τραπεζικά στοιχεία εδώ.",
        english: "For your privacy, please don’t send passwords, card details, or account credentials here."
      }[detectMessageLanguage(customerText)] || "For your privacy, please don’t send passwords, card details, or account credentials here.";
      response = `${response} ${reminder}`.trim();
    }

    stageAt = performance.now();
    const knowledgeEvidence = knowledgeEvidenceMetadata(evidence, {
      modelRequestMade,
      modelResponseUsed,
      fallbackCitations: citations
    });
    routed.turn = (await recordHistory(store, userId, text, response, {
      metadata: { ...routed.metadata, retrieval: dynamicResult.requested.length ? "approved_knowledge_and_live_data" : "approved_knowledge", dynamicData: dynamicResult.statuses, dynamicConflictDecisions: precedence.decisions, citations, knowledgeEvidence, abstained: !grounded }
    })).turn;
    stage("turn_and_workflow_persistence", stageAt, { route: "knowledge_answer" });
  }

  stageStartedAt = performance.now();
  if (!routed.shouldUseAi || routed.turn) await refreshLeadTemperature(userId);
  stage("lead_temperature", stageStartedAt);
  if (routed.turn) {
    stageStartedAt = performance.now();
    try {
      if (!routed.metadata?.privacySafeQuestion) await refreshCustomerTopicSummary({ store, userId, user: routed.user, currentMessage: text });
    } catch (error) {
      logEvent("conversation_summary_error", safeErrorDiagnostics(error));
    }
    stage("topic_summary", stageStartedAt);
  }

  legacySummary = { primaryIntentCategory: prepared.classification.primary, usedBookingPath: false, usedHandoverPath: Boolean(routed.handover), responseLength: typeof response === "string" ? response.length : 0 };

  } finally {
    stageStartedAt = performance.now();
    await setTyping(socket, chatId, false);
    stage("typing_stop", stageStartedAt);
    // REFAL-AGENT-013: fire-and-forget, after the customer has already been
    // replied to on every path above — never awaited, never allowed to
    // affect `response`/`routed`. No-ops entirely when shadow mode is
    // disabled (`shadowTurnPromise` resolves to null) or legacySummary was
    // never set (an exception before any branch completed).
    void recordShadowComparison({ shadowTurnPromise, legacySummary, traceId, logEvent }).catch(() => {});
  }

  stageStartedAt = performance.now();
  await sendStoredTextReply(socket, chatId, response, userId, routed.turn);
  stage("whatsapp_delivery", stageStartedAt);
  stage("request_total", requestStartedAt);
}

// REFAL-AGENT-030 — the Agent live turn. Only ever invoked when
// REFAL_AGENT_LIVE_ENABLED is explicitly "true" (default off; not enabled by
// this ticket — see src/turnRouting.js). Deliberately minimal: it proves the
// routing/fallback/rollback contract this ticket requires, not full
// production parity with the legacy turn (richer classification-aware
// context and response-history persistence parity are REFAL-AGENT-017's
// job). Everything that can throw here (store/user load, Agent context
// build) happens BEFORE any customer-visible send, so a thrown error always
// leaves this turn pre-side-effect-safe for turnRouting.js's legacy
// fallback — runAgentTurn itself never throws for an ordinary bad
// decision/tool/policy outcome (see agentLoop.js), it only ever resolves
// with a safe response text, which is sent exactly once below.
async function runAgentLiveAnswerTurn(socket, chatId, userId, text, requestTrace = {}, providerMessageId = null) {
  await setTyping(socket, chatId, true);
  const user = await store.ensureUser(userId);
  const bookingState = user?.booking?.status;
  // Booking has a deterministic state machine and remains its sole owner.
  // Route it to legacy before preflight can persist or trigger anything.
  if (["awaiting_details", "awaiting_confirmation"].includes(bookingState) || detectIntent(text).intents.includes(INTENTS.APPOINTMENT)) {
    throw new Error("Appointment turn remains owned by the deterministic booking workflow.");
  }
  const prepared = await prepareInboundMessage({ userId, incoming: String(text || "").trim(), user, store });
  const routed = await routeMessageResult({ userId, text, store, existingUser: user, preparedInbound: prepared });
  const language = prepared.classification?.language || user?.profile?.language || "english";
  let selectedSalesOffer = null;
  let selectedSpecialistOffer = null;
  const result = await runAgentAfterPreflight({
    prepared,
    routed,
    userId,
    sourceMessage: String(text || ""),
    locale: language,
    metadata: prepared.metadata || {},
    pendingResponse: "Your message is being processed."
  }, {
    persistTurn: async ({ message, response, metadata }) => (await recordHistory(store, userId, message, response, { metadata }, { bestEffortWorkflowWrites: true })).turn,
    runAgent: async ({ sourceTurnId, allowedCapabilities }) => {
      const currentUser = await store.getUser(userId);
      const history = Array.isArray(currentUser?.history) ? currentUser.history : [];
      const conversationState = getConversationState(currentUser || {});
      const consentState = getConsentState({ user: currentUser || {}, history }) || "unknown";
      const commitState = createCommitState();
      const agentResult = await runAgentTurnForContact({
        currentMessage: String(text || ""),
        locale: language,
        contact: { id: userId, name: currentUser?.profile?.name || null },
        recentConversation: buildRecentConversation(history.filter((turn) => turn.id !== sourceTurnId)),
        conversationState,
        knownCustomerFacts: conversationState.agentFacts,
        currentOpenQuestion: null,
        consentState,
        allowedCapabilities,
        sourceTurnId,
        store,
        user: currentUser,
        userId,
        intents: routed.metadata?.intent?.intents || prepared.classification?.intents || [],
        language,
        inboundMessageId: providerMessageId || null,
        leadTier: routed.metadata?.leadTier || "",
        buyingSignals: routed.metadata?.buyingSignals || []
      }, { tools: buildCommitTrackingToolRegistry(TOOL_REGISTRY, commitState) });
      const decision = decideAgentTurnOutcome({ result: agentResult, commitState, locale: language });
      if (!decision.send || agentResult.outcome !== "responded") return decision.send ? decision.responseText : null;
      const policyRows = observationPolicyRows(agentResult.steps);
      const jurisdiction = guardJurisdictionAnswer({ message: text, response: decision.responseText, rows: policyRows, language });
      let response = jurisdiction.response;
      const hook = appendGroundedHook({
        message: text, response, language, history: history.filter((turn) => turn.id !== sourceTurnId),
        user: currentUser, rows: policyRows,
        specialistEligible: routed.metadata?.priority?.handoverRequired === true,
        answerComplete: true,
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
      response = hook.response;
      selectedSalesOffer = hook.salesOffer;
      selectedSpecialistOffer = hook.specialistOffer;
      return response;
    },
    updateTurn: ({ turnId, patch }) => store.updateHistoryTurn(userId, turnId,
      selectedSalesOffer || selectedSpecialistOffer ? { ...patch, metadata: { ...(selectedSalesOffer ? { salesOffer: selectedSalesOffer } : {}), ...(selectedSpecialistOffer ? { specialistOffer: selectedSpecialistOffer } : {}) } } : patch),
    send: async (response, turn) => {
      await setTyping(socket, chatId, false);
      await sendStoredTextReply(socket, chatId, response, userId, turn);
    }
  });
  return { outcome: result.route, responseLength: result.response.length, sourceTurnId: result.sourceTurnId || null };
}

// REFAL-AGENT-030 — the one live decision point: legacy vs. Agent, exactly
// once per inbound turn. Thin by design — all the actual turn behavior lives
// in runLegacyAnswerTurn/runAgentLiveAnswerTurn above; this function only
// ever decides which of them owns this turn and sends for it (never both —
// see src/turnRouting.js's runRoutedTurn and its dedicated tests, which
// cover this decision point without needing a live Baileys socket).
async function answerMessage(socket, chatId, userId, text, requestTrace = {}, providerMessageId = null) {
  return runRoutedTurn(
    { socket, chatId, userId, text, requestTrace, providerMessageId },
    {
      runLegacyTurn: () => runLegacyAnswerTurn(socket, chatId, userId, text, requestTrace),
      runAgentTurn: () => runAgentLiveAnswerTurn(socket, chatId, userId, text, requestTrace, providerMessageId)
    }
  );
}

async function refreshLeadTemperature(userId) {
  try {
    const user = await store.getUser(userId);
    const result = classifyLeadTemperature({ history: user?.history || [], booking: user?.booking });
    await store.updateUser(userId, (draft) => {
      draft.profile = draft.profile || {};
      draft.profile.leadTemperature = { ...result, updatedAt: new Date().toISOString(), source: "conversation_signals_v1" };
    });
  } catch (error) {
    console.error("Lead temperature update failed:", safeErrorDiagnostics(error));
  }
}

async function backfillLeadTemperatures() {
  try {
    const users = await store.allUsers({ includeHistory: true });
    for (const user of users) {
      if (user.profile?.leadTemperature?.status) continue;
      const result = classifyLeadTemperature({ history: user.history || [], booking: user.booking });
      await store.updateUser(user.id, (draft) => {
        draft.profile = draft.profile || {};
        draft.profile.leadTemperature = { ...result, updatedAt: new Date().toISOString(), source: "conversation_signals_v1" };
      });
    }
  } catch (error) {
    console.error("Lead temperature history backfill failed:", safeErrorDiagnostics(error));
  }
}

async function sendTextReply(socket, chatId, response) {
  return socket.sendMessage(chatId, { text: response });
}

async function sendStoredTextReply(socket, chatId, response, userId, turn) {
  const sent = await sendTextReply(socket, chatId, response);
  try {
    await persistWhatsAppSentMessage({ store, userId, response, turn, sentMessage: sent });
  } catch (error) {
    logEvent("whatsapp_reply_key_persistence_error", {
      turnId: turn?.id || null,
      statusCode: Number(error?.statusCode || error?.status || 0) || null
    });
  }
  return sent;
}

function replyEditError(error) {
  const status = error?.output?.statusCode || error?.statusCode;
  if (status === 401 || status === 403) return "WhatsApp rejected the message update.";
  if (status === 404) return "The original WhatsApp message could not be found.";
  return "WhatsApp could not deliver the reply update.";
}

async function deliverReplyEdit(request) {
  const requestId = typeof request?.requestId === "string" && /^[a-f0-9-]{36}$/i.test(request.requestId)
    ? request.requestId
    : null;
  if (!requestId || !process.connected) return;
  const reply = (ok, fields = {}) => notifyDashboard({ type: "reply-edit-result", requestId, ok, ...fields });
  try {
    const result = await performReplyEdit(request);
    reply(true, { result });
  } catch (error) {
    reply(false, { error: replyEditError(error) });
  }
}

async function performReplyEdit(request) {
  if (!whatsappConnected || !activeSocket || !whatsappIdentityVerified || stopping) {
    throw new Error("WhatsApp worker is not connected.");
  }

  const { userId, text, mode, messageKey } = request;
  if (typeof userId !== "string" || typeof text !== "string" || !text.trim() || text.length > 4000 ||
      !["platform_edit", "correction_resend"].includes(mode)) {
    throw new Error("Invalid reply update request.");
  }
  if (!/^(?:\d+|[A-Za-z0-9._-]+)@(?:s\.whatsapp\.net|c\.us|lid)$/.test(userId)) {
    throw new Error("Invalid WhatsApp destination.");
  }

  const payload = buildReplyEditPayload({ userId, text, mode, messageKey });
  const sentMessage = await activeSocket.sendMessage(userId, payload);
  return { key: sentMessage?.key || null, action: mode, status: "sent" };
}

async function deliverCustomerText(request) {
  const requestId = String(request?.requestId || "");
  const reply = (ok, fields = {}) => notifyDashboard({ type: "customer-text-result", requestId, ok, ...fields });
  try {
    if (!whatsappConnected || !activeSocket || !whatsappIdentityVerified || stopping) throw new Error("WhatsApp worker is not connected.");
    const userId = String(request.userId || "");
    const text = String(request.text || "").trim();
    if (!/^(?:\d+|[A-Za-z0-9._-]+)@(?:s\.whatsapp\.net|c\.us|lid)$/.test(userId) || !text || text.length > 1500) throw new Error("Invalid customer message.");
    const sent = await activeSocket.sendMessage(userId, { text });
    reply(true, { result: { status: "sent", key: sent?.key || null } });
  } catch (error) {
    reply(false, { error: String(error?.message || "WhatsApp could not deliver the message.").slice(0, 200) });
  }
}

function startLocalControlServer() {
  const token = process.env.RAFA_LOCAL_CONTROL_TOKEN || process.env.RAFA_DASHBOARD_SUPABASE_SECRET || process.env.RAFA_API_SECRET;
  const port = Number(process.env.RAFA_LOCAL_CONTROL_PORT || 8792);
  if (!token || localControlServer || pairingOnly) return;

  localControlServer = http.createServer((req, res) => {
    void (async () => {
      res.setHeader("content-type", "application/json");
      if (req.method !== "POST" || req.url !== "/reply-edit") {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "Not found" }));
        return;
      }
      if (req.headers["x-rafa-local-control-token"] !== token) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
      const body = await readJsonBody(req, 12000);
      const result = await performReplyEdit(body);
      res.end(JSON.stringify({ result }));
    })().catch((error) => {
      res.statusCode = 502;
      res.end(JSON.stringify({ error: replyEditError(error) }));
    });
  });

  localControlServer.listen(port, "127.0.0.1", () => {
    console.log(`RAFA local control listening on 127.0.0.1:${port}`);
  });
  localControlServer.on("error", (error) => {
    console.error("RAFA local control failed:", safeErrorDiagnostics(error));
    localControlServer = null;
  });
}

function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > maxBytes) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      try { resolve(JSON.parse(raw || "{}")); }
      catch { reject(new Error("Invalid JSON body.")); }
    });
    req.on("error", reject);
  });
}

async function sendTextReplyWithPresence(socket, chatId, response) {
  await setTyping(socket, chatId, true);
  await setTyping(socket, chatId, false);
  await sendTextReply(socket, chatId, response);
}

async function setTyping(socket, chatId, isTyping) {
  if (!socket.sendPresenceUpdate || !chatId) return;
  try {
    await socket.sendPresenceUpdate(isTyping ? "composing" : "paused", chatId);
  } catch (error) {
    logEvent("presence_error", safeErrorDiagnostics(error));
  }
}

async function handleMessage(socket, message, upsertType) {
  const inboundStartedAt = performance.now();
  const traceId = randomUUID();
  const stage = (name, startedAt, fields = {}) => logEvent("response_stage", {
    traceId,
    stage: name,
    durationMs: Math.round(performance.now() - startedAt),
    ...fields
  });
  const remoteJid = message.key?.remoteJid;
  const fromMe = Boolean(message.key?.fromMe);
  const id = `${remoteJid || "unknown"}:${message.key?.id || "no-id"}:${fromMe}`;
  const providerMessageId = String(message.key?.id || "");
  let persistentReceipt = false;
  let receiptShouldComplete = false;

  if (processedMessageIds.has(id)) return;
  processedMessageIds.add(id);
  if (processedMessageIds.size > 1000) processedMessageIds.delete(processedMessageIds.values().next().value);

  try {
    logEvent("message", {
      fromMe,
      upsertType,
      type: messageType(message)
    });

    if (fromMe) {
      await handleSelfTestMessage(socket, message);
      return;
    }

    if (!isSupportedChatId(remoteJid)) {
      logEvent("ignored", { reason: "unsupported_chat", type: messageType(message) });
      receiptShouldComplete = true;
      return;
    }

    if (!fromMe && providerMessageId && typeof store.claimInboundMessage === "function") {
      try {
        const stageStartedAt = performance.now();
        const receipt = await store.claimInboundMessage(remoteJid, providerMessageId);
        stage("inbound_receipt_claim", stageStartedAt, { duplicate: Boolean(receipt.duplicate) });
        if (receipt.duplicate || receipt.claimed === false) {
          logEvent("duplicate_inbound_message_ignored", { duplicate: true });
          return;
        }
        persistentReceipt = true;
      } catch (error) {
        logEvent("inbound_message_dedupe_error", safeErrorDiagnostics(error));
      }
    }

    let stageStartedAt = performance.now();
    await rememberWhatsAppContact(remoteJid, message, socket);
    stage("whatsapp_contact_refresh", stageStartedAt);

    if (typeof store.isContactBlocked === "function") {
      try {
        stageStartedAt = performance.now();
        const blocked = await store.isContactBlocked(remoteJid);
        stage("blocklist_check", stageStartedAt, { blocked: Boolean(blocked) });
        if (blocked) {
          logEvent("blocked_contact_message_ignored", { blocked: true });
          receiptShouldComplete = true;
          return;
        }
      } catch (error) {
        logEvent("blocklist_check_error", safeErrorDiagnostics(error));
        return; // Do not send customer or automated messages when block status cannot be verified.
      }
    }

    if (!allowIncomingMessage(remoteJid)) {
      logEvent("rate_limited_per_minute", {});
      receiptShouldComplete = true;
      return;
    }

    let text = extractText(message);
    const hadAudio = Boolean(audioMessageContent(message));
    if (hadAudio) logEvent("voice_transcription_unavailable", { messageType: "audio" });

    if (!text) {
      const response = hadAudio
        ? "Sorry, I could not transcribe that voice note. Please send it as text."
        : "Please send text only.";
      await store.addHistory(remoteJid, `[${messageType(message)}]`, response);
      await sendTextReplyWithPresence(socket, remoteJid, response);
      receiptShouldComplete = true;
      return;
    }

    stage("inbound_preprocess", inboundStartedAt, { messageType: messageType(message) });
    await answerMessage(socket, remoteJid, remoteJid, text, { traceId, startedAt: inboundStartedAt }, providerMessageId);
    receiptShouldComplete = true;
    logEvent("replied", { mode: "customer" });
  } catch (error) {
    console.error("Failed to handle message:", safeErrorDiagnostics(error));
    logEvent("error", { mode: "customer", ...safeErrorDiagnostics(error) });
    if (remoteJid && isSupportedChatId(remoteJid)) {
      try {
        await sendTextReplyWithPresence(socket, remoteJid, "Sorry, something went wrong. Please try again.");
        receiptShouldComplete = true;
      } catch (sendError) {
        logEvent("whatsapp_error_reply_failed", safeErrorDiagnostics(sendError));
      }
    }
  } finally {
    if (persistentReceipt && receiptShouldComplete) {
      try { await store.completeInboundMessage(remoteJid, providerMessageId); }
      catch (error) { logEvent("inbound_message_receipt_complete_error", safeErrorDiagnostics(error)); }
    } else if (!receiptShouldComplete && !fromMe) {
      processedMessageIds.delete(id);
    }
  }
}

async function handleSelfTestMessage(socket, message) {
  const remoteJid = message.key?.remoteJid;

  try {
    const body = extractText(message);
    if (!body.toLowerCase().startsWith(selfTestPrefix.toLowerCase())) return;

    if (!isSupportedChatId(remoteJid)) {
      logEvent("ignored", { reason: "unsupported_self_test_target" });
      return;
    }

    const text = body.slice(selfTestPrefix.length).trim();
    if (!text) {
      await sendTextReplyWithPresence(socket, remoteJid, `Self-test mode is on. Send "${selfTestPrefix} hi" or "${selfTestPrefix} services".`);
      return;
    }

    const selfTestUserId = `self-test:${remoteJid}`;
    if (text.toLowerCase() === "report") {
      try {
        const report = await generateAndEmailReport({ store });
        logEvent("manual_report_sent", {
          userCount: report.userCount,
          rowCount: report.rowCount
        });
        await sendTextReplyWithPresence(socket, remoteJid, `Report generated and emailed. Users: ${report.userCount}. Rows: ${report.rowCount}.`);
      } catch (error) {
        console.error("Manual report failed:", safeErrorDiagnostics(error));
        logEvent("manual_report_error", safeErrorDiagnostics(error));
        await sendTextReplyWithPresence(socket, remoteJid, `Report failed: ${error.message}`);
      }
      return;
    }

    if (text.toLowerCase() === "reset") {
      const deletedSelfTest = await store.deleteUser(selfTestUserId);
      const deletedDirect = await store.deleteUser(remoteJid);
    logEvent("self_test_reset", { deletedSelfTest, deletedDirect });
      await sendTextReplyWithPresence(socket, remoteJid, `Self-test memory cleared. Send "${selfTestPrefix} hi" to start as a brand-new user.`);
      return;
    }

    await answerMessage(socket, remoteJid, selfTestUserId, text);
    logEvent("replied", { mode: "self-test" });
  } catch (error) {
    console.error("Failed to handle self-test message:", safeErrorDiagnostics(error));
    logEvent("error", { mode: "self-test", ...safeErrorDiagnostics(error) });
    if (remoteJid && isSupportedChatId(remoteJid)) {
      await sendTextReplyWithPresence(socket, remoteJid, "Sorry, something went wrong. Please try again.");
    }
  }
}

async function startBaileysClient() {
  if (stopping) return;
  const { state, saveCreds } = await useMultiFileAuthState(authPath);
  const { version } = await fetchLatestBaileysVersion();
  const socket = makeWASocket({
    version,
    auth: state,
    logger: P({ level: process.env.BAILEYS_LOG_LEVEL || "silent" }),
    printQRInTerminal: false,
    browser: ["RAFA", "Chrome", "1.0.0"]
  });
  activeSocket = socket;
  notifyDashboard({ type: "connection", connection: "connecting" });

  socket.ev.on("creds.update", saveCreds);

  socket.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !requestedPhoneNumber) {
      console.log("\nScan this QR in WhatsApp: Settings > Linked devices > Link a device\n");
      qrcode.generate(qr, { small: true });
    }

    if (qr && pairingMethod === "qr" && requestedPhoneNumber && !state.creds.registered) {
      notifyDashboard({ type: "pairing-qr", qr });
    }

    if (pairingMethod === "code" && shouldRequestPairingCode({ qr, phoneNumber: requestedPhoneNumber, registered: state.creds.registered, pairingCodeRequested })) {
      pairingCodeRequested = true;
      try {
        const code = await socket.requestPairingCode(requestedPhoneNumber);
        notifyDashboard({ type: "pairing-code", code });
      } catch (error) {
        pairingCodeRequested = false;
        const message = pairingFailureMessage(error, requestedPhoneNumber);
        notifyDashboard({ type: "worker-error", message });
        console.error("WhatsApp pairing-code request failed:", safeErrorDiagnostics(error));
        stopWorker();
      }
    }

    if (connection === "open") {
      const linkedPhone = String(state.creds.me?.id || "").split("@")[0].split(":")[0].replace(/\D/g, "");
      if (requestedPhoneNumber && (!linkedPhone || linkedPhone !== requestedPhoneNumber)) {
        notifyDashboard({ type: "worker-error", message: "The saved WhatsApp session belongs to a different number. Unlink that device in WhatsApp before connecting this number." });
        whatsappIdentityVerified = false;
        stopWorker();
        socket.end(new Error("Saved WhatsApp number does not match the requested number."));
        return;
      }
      whatsappIdentityVerified = true;
      whatsappConnected = true;
      await clearDisconnectAlertOnRecovery();
      notifyDashboard({ type: "connection", connection: "open", phoneNumber: linkedPhone ? `+${linkedPhone}` : "" });
      void backfillKnownWhatsAppPhoneNumbers(socket);

      if (!pairingOnly) {
        void backfillLeadTemperatures();
        if (followUpTask) followUpTask.stop();
        followUpTask = startFollowUpSchedule({
          store,
          sendFollowUp: async (userId, text) => {
            await socket.sendMessage(userId, { text });
          },
          logEvent
        });
        if (reminderTask) reminderTask.stop();
        reminderTask = startReminderSchedule({ store, socket, logEvent });
      } else {
        console.log("Pairing-only mode: customer messages and scheduled sends are disabled.");
      }

      console.log("RAFA WhatsApp agent is ready.");
      console.log("Data store: Supabase");
      console.log("WhatsApp credentials: local session store");
      console.log(`AI: ${process.env.OPENROUTER_API_KEY ? `enabled (${require("./openrouterPrivacy").resolveOpenRouterModel(process.env.OPENROUTER_MODEL)})` : "disabled"}`);
      if (!pairingOnly) console.log(`Self-test: send "${selfTestPrefix} hi" from your linked WhatsApp account.`);
      startLocalControlServer();
      logEvent("ready", {});
    }

    if (connection === "close") {
      whatsappConnected = false;
      if (activeSocket === socket) activeSocket = null;
      if (reminderTask) {
        reminderTask.stop();
        reminderTask = null;
      }
      const statusCode = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.statusCode;
      const shouldReconnect = !stopping && statusCode !== DisconnectReason.loggedOut;
      notifyDashboard({ type: "connection", connection: "close" });
      console.log(`WhatsApp connection closed. Reconnecting: ${shouldReconnect}`);
      logEvent("connection_close", { statusCode, shouldReconnect });

      if (shouldReconnect) {
        if (!pairingOnly) startDisconnectAlertTimer(new Date());
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          startBaileysClient().catch((error) => {
            console.error("Failed to reconnect WhatsApp:", safeErrorDiagnostics(error));
            logEvent("connection_error", safeErrorDiagnostics(error));
            notifyDashboard({ type: "worker-error", message: "WhatsApp connection failed while reconnecting." });
          });
        }, 3000);
      } else {
        if (stopping) {
          console.log("WhatsApp worker stopped by the dashboard; linked-device credentials were preserved.");
        } else {
          try {
            await clearLoggedOutAuth(authPath);
            console.log("WhatsApp logged out; invalid local credentials were cleared for a fresh pairing.");
          } catch (error) {
            console.error("Could not clear logged-out WhatsApp credentials:", safeErrorDiagnostics(error));
          }
        }
        if (!stopping && process.env.RAFA_DASHBOARD_MANAGED === "true") {
          notifyDashboard({ type: "worker-error", message: "WhatsApp logged out this linked device. Its invalid session was reset; reconnect from the dashboard to get a fresh pairing code." });
          stopWorker();
        }
      }
    }
  });

  socket.ev.on("messages.upsert", async ({ messages, type }) => {
    if (!whatsappIdentityVerified || stopping) return;
    if (pairingOnly) {
      if (messages?.length) logEvent("pairing_only_messages_ignored", { count: messages.length });
      return;
    }
    for (const message of messages || []) {
      await handleMessage(socket, message, type);
    }
  });
}

if (!pairingOnly) {
  notificationTask = startNotificationSchedule({
    store,
    socket: {
      sendMessage(userId, payload) {
        if (!whatsappConnected || !activeSocket) throw new Error("WhatsApp is not connected; customer notification will be retried.");
        return activeSocket.sendMessage(userId, payload);
      }
    },
    logEvent
  });
  startMonthlyReportSchedule({
    store,
    onReport: generateAndEmailReport,
    logEvent
  });
}

startBaileysClient().catch((error) => {
  console.error("Failed to start RAFA:", safeErrorDiagnostics(error));
  logEvent("startup_error", safeErrorDiagnostics(error));
  notifyDashboard({ type: "worker-error", message: "RAFA could not start the WhatsApp worker. Check server configuration." });
  process.exitCode = 1;
});
