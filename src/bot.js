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
const { askOpenRouter, embedText, embedQueryTexts, warmEmbeddingPipeline, DEFAULT_EMBEDDING_MODEL, redactPersonalData } = require("./ai");
const { createStore } = require("./supabaseStore");
const { routeMessageResult, prepareInboundMessage, recordHistory, buildReplyEditPayload, persistWhatsAppSentMessage, wasNameRequested } = require("./messageRouter");
const { handleBookingMessage } = require("./booking");
const { generateAndEmailReport } = require("./report");
const { startMonthlyReportSchedule } = require("./reportScheduler");
const { startFollowUpSchedule } = require("./followUp");
const { startReminderSchedule } = require("./reminderScheduler");
const { startNotificationSchedule } = require("./notificationScheduler");
const { isPhoneJid, resolvePhoneJid } = require("./whatsappContact");
const { AI_LIMIT_MESSAGE, checkAiMessage, checkIncomingMessage } = require("./rateLimiter");
const { detectMessageLanguage, inboundRetryMessage } = require("./language");
const { sendDisconnectAlert, sendRecoveryAlert } = require("./connectionAlerts");
const { isPairingOnly } = require("./runtimePolicy");
const { classifyLeadTemperature } = require("./leadTemperature");
const { refreshCustomerTopicSummary } = require("./conversationMemory");
const { clearLoggedOutAuth, pairingFailureMessage, shouldRequestPairingCode } = require("./whatsappPairing");
const { buildOperationalEvent, safeErrorDiagnostics } = require("./operationalTelemetry");
const { createMessageExecutor, parseMessageQueueLimit } = require("./messageConcurrency");
const { claimInboundReceipt } = require("./inboundMessageReceipt");
const { runAgentLiveAnswerTurn: runAgentLiveAnswerTurnComposition } = require("./agentLiveAnswerTurn");

const rootDir = path.join(__dirname, "..");
loadProjectEnv(rootDir);

const pairingOnly = isPairingOnly();
const authPath = process.env.BAILEYS_AUTH_PATH || path.join(rootDir, "auth_info_baileys");
const allowGroups = process.env.ALLOW_GROUPS === "true";
const selfTestPrefix = process.env.SELF_TEST_PREFIX || "!rafa";

const store = createStore();
const processedMessageIds = new Set();
const inboundMessageExecutor = createMessageExecutor({
  concurrency: Number(process.env.RAFA_INBOUND_CONCURRENCY) || 8,
  maxQueue: parseMessageQueueLimit(process.env.RAFA_INBOUND_QUEUE_LIMIT)
});
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
// Booking state transitions remain deterministic after contextual classification.
async function runOperationalBookingTurn(socket, chatId, userId, text, requestTrace, prepared) {
  const requestStartedAt = performance.now();
  const user = await store.getUser(userId);
  if (prepared.safety?.restricted || prepared.complianceTriggers?.length) throw Object.assign(new Error("Booking restricted by policy."), { code: "BOOKING_POLICY_RESTRICTED" });
  if (user.profile?.qaControlledDiagnostics === true) throw Object.assign(new Error("Controlled test cannot create bookings."), { code: "TEST_ACTION_FORBIDDEN" });
  const traceId = requestTrace.traceId;
  const stage = (name, startedAt, fields = {}) => logEvent("response_stage", { traceId, stage: name, durationMs: Math.round(performance.now() - startedAt), ...fields });
  let stageStartedAt;
  let response;
  const booking = await handleBookingMessage({ userId, text, store, user });
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

    if (["pending_review", "pending_calendar", "creating"].includes(booking.appointment?.status) && booking.details && booking.user) {
      try {
        const appointmentId = booking.appointment.id;
        const expectedAppointmentStatus = booking.appointment.status;
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
          expectedAppointmentStatus,
          idempotencyKey: `${appointmentId}:owner-review-email`,
          payload
        });
        if (process.env.OWNER_WHATSAPP_JID) {
          await store.createNotification({
            appointmentId,
            kind: "customer_message",
            recipient: process.env.OWNER_WHATSAPP_JID,
            expectedAppointmentStatus,
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
    return;
  }

  throw Object.assign(new Error("Booking request could not be processed."), { code: "BOOKING_NOT_PROCESSED" });
}

// One contextual composition owns customer answers and correlated telemetry.
async function runAgentLiveAnswerTurn(socket, chatId, userId, text, requestTrace = {}, providerMessageId = null) {
  return runAgentLiveAnswerTurnComposition(
    { socket, chatId, userId, text, providerMessageId, traceId: requestTrace.traceId },
    {
      store,
      logEvent,
      setTyping,
      sendStoredTextReply,
      embedText
    }
  );
}

// Booking actions retain their deterministic authorization and confirmation path.
async function answerMessage(socket, chatId, userId, text, requestTrace = {}, providerMessageId = null) {
  try {
    return await runAgentLiveAnswerTurn(socket, chatId, userId, text, requestTrace, providerMessageId);
  } catch (error) {
    if (error.code === "BOOKING_WORKFLOW_REQUIRED") {
      return runOperationalBookingTurn(socket, chatId, userId, text, requestTrace, error.preparedInbound);
    }
    throw error;
  }
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
  let receiptLeaseToken = null;
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

    if (!fromMe) {
      try {
        const stageStartedAt = performance.now();
        const receipt = await claimInboundReceipt(store, remoteJid, providerMessageId);
        stage("inbound_receipt_claim", stageStartedAt, { duplicate: receipt.duplicate });
        if (receipt.duplicate) {
          logEvent("duplicate_inbound_message_ignored", { duplicate: true });
          return;
        }
        persistentReceipt = true;
        receiptLeaseToken = receipt.leaseToken;
      } catch (error) {
        logEvent("inbound_message_dedupe_error", safeErrorDiagnostics(error));
        // The durable receipt is the cross-worker duplicate guard. Processing
        // when it cannot be verified could repeat a handover or other action.
        try {
          await sendTextReplyWithPresence(socket, remoteJid, inboundRetryMessage(detectMessageLanguage(extractText(message))));
        } catch (sendError) {
          logEvent("whatsapp_error_reply_failed", safeErrorDiagnostics(sendError));
        }
        return;
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

    const incomingRateLimit = await checkIncomingMessage(remoteJid, { store });
    if (incomingRateLimit.source === "local_fallback") logEvent("shared_rate_limit_fallback", { scope: "incoming_minute" });
    if (!incomingRateLimit.allowed) {
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
      try {
        const completion = await store.completeInboundMessage(remoteJid, providerMessageId, receiptLeaseToken);
        if (completion?.processed !== true) logEvent("inbound_message_receipt_fence_lost", {});
      }
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
    await Promise.all((messages || []).map(async (message) => {
      const userId = message.key?.remoteJid;
      try {
        await inboundMessageExecutor.run(userId, () => handleMessage(socket, message, type));
      } catch (error) {
        if (error?.code !== "MESSAGE_QUEUE_FULL") {
          logEvent("inbound_message_executor_error", safeErrorDiagnostics(error));
          return;
        }
        const stats = inboundMessageExecutor.getStats();
        logEvent("inbound_message_queue_full", { active: stats.active, queued: stats.queued });
        if (!message.key?.fromMe && isSupportedChatId(userId)) {
          try {
            await sendTextReplyWithPresence(socket, userId, inboundRetryMessage(detectMessageLanguage(extractText(message)), "busy"));
          } catch (sendError) {
            logEvent("whatsapp_overload_reply_failed", safeErrorDiagnostics(sendError));
          }
        }
      }
    }));
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
