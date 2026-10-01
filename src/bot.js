const path = require("node:path");
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
const { askOpenRouter, embedText, DEFAULT_EMBEDDING_MODEL } = require("./ai");
const { createStore } = require("./supabaseStore");
const { routeMessageResult, prepareInboundMessage, buildReplyEditPayload, persistWhatsAppSentMessage } = require("./messageRouter");
const { handleBookingMessage } = require("./booking");
const { generateAndEmailReport } = require("./report");
const { startMonthlyReportSchedule } = require("./reportScheduler");
const { startFollowUpSchedule } = require("./followUp");
const { startReminderSchedule } = require("./reminderScheduler");
const { startNotificationSchedule } = require("./notificationScheduler");
const { AI_LIMIT_MESSAGE, allowAiMessage, allowIncomingMessage } = require("./rateLimiter");
const { answerFromEvidence, noApprovedEvidenceReply } = require("./refalcoAnswer");
const { detectMessageLanguage } = require("./language");
const { sendDisconnectAlert, sendRecoveryAlert } = require("./connectionAlerts");
const { isPairingOnly } = require("./runtimePolicy");
const { classifyLeadTemperature } = require("./leadTemperature");
const { clearLoggedOutAuth, pairingFailureMessage, shouldRequestPairingCode } = require("./whatsappPairing");
const { buildConversationContext, refreshCustomerTopicSummary } = require("./conversationMemory");

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
  if (store.logEvent) {
    store.logEvent(event, fields).catch((error) => {
      console.error("RAFA event log failed:", error.message);
    });
    return;
  }

  console.warn("RAFA event store is unavailable:", event, fields);
}

function messagePreview(text) {
  return String(text || "").replace(/\s+/g, " ").slice(0, 120);
}

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
        console.error("Disconnect alert failed:", error.message);
        logEvent("disconnect_alert_error", { message: error.message });
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
    console.error("Recovery alert failed:", error.message);
    logEvent("recovery_alert_error", { message: error.message });
  }
}

function isSupportedChatId(chatId) {
  if (!chatId) return false;
  if (chatId === "status@broadcast") return false;
  if (chatId.endsWith("@broadcast")) return false;
  if (chatId.endsWith("@g.us")) return allowGroups;
  return chatId.endsWith("@s.whatsapp.net") || chatId.endsWith("@c.us") || chatId.endsWith("@lid");
}

async function rememberWhatsAppContact(userId, message) {
  const pushName = String(message.pushName || "").trim();
  await store.updateUser(userId, (user) => {
    user.whatsapp = {
      ...(user.whatsapp || {}),
      jid: userId,
      lastSeenAt: new Date().toISOString()
    };

    if (pushName) {
      user.whatsapp.pushName = pushName;
      if (!user.profile.whatsappName) user.profile.whatsappName = pushName;
    }
  });
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

async function answerMessage(socket, chatId, userId, text) {
  await setTyping(socket, chatId, true);
  let response;
  let routed;

  try {
  const user = await store.ensureUser(userId);
  const prepared = await prepareInboundMessage({ userId, incoming: String(text || "").trim(), user, store });
  const booking = await handleBookingMessage({ userId, text, store, user });
  if (booking) {
    response = booking.response;
    const turn = await store.addHistory(userId, text, response, { automated: true, source: "whatsapp", metadata: prepared.metadata });
    try {
      const user = await store.getUser(userId);
      await refreshCustomerTopicSummary({ store, userId, user, currentMessage: text });
    } catch (error) {
      logEvent("conversation_summary_error", { userId, message: error.message });
    }
    await refreshLeadTemperature(userId);

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
        console.error("Booking notification queue failed:", error.message);
        logEvent("booking_notification_queue_error", { message: String(error?.message || "Queue unavailable").slice(0, 300) });
      }
    }
    await setTyping(socket, chatId, false);
    await sendStoredTextReply(socket, chatId, response, userId, turn);
    return;
  }

  routed = await routeMessageResult({
    userId,
    text,
    store,
    existingUser: user
  });

  response = routed.response;
  if (routed.shouldUseAi) {
    let evidence = [];
    try {
      const embedding = await embedText(text);
      evidence = store.searchKnowledge ? await store.searchKnowledge(text, embedding, DEFAULT_EMBEDDING_MODEL, 6) : [];
    } catch (error) {
      console.error("Refalco knowledge search failed:", error.message);
      logEvent("knowledge_search_error", { message: error.message });
    }

    const grounded = answerFromEvidence(evidence);
    const citations = grounded?.citations || [];
    response = grounded?.answer || noApprovedEvidenceReply(detectMessageLanguage(text));

    if (evidence.length && process.env.OPENROUTER_API_KEY && !allowAiMessage(userId)) {
      const turn = await store.addHistory(userId, text, AI_LIMIT_MESSAGE, { automated: true, source: "whatsapp", metadata: routed.metadata });
      await refreshLeadTemperature(userId);
      await setTyping(socket, chatId, false);
      await sendStoredTextReply(socket, chatId, AI_LIMIT_MESSAGE, userId, turn);
      logEvent("rate_limited_ai_daily", { userId });
      return;
    }

    if (grounded && process.env.OPENROUTER_API_KEY) {
      try {
        const conversation = buildConversationContext(routed.user, { currentMessage: text });
        const aiResponse = await askOpenRouter({
          text,
          evidence,
          includeSources: false,
          conversationSummary: conversation.summary,
          conversationTurns: conversation.turns,
          onUsage: async (usage) => {
            try {
              await store.logEvent(usage.providerReported ? "ai_usage" : "ai_usage_missing", {
                source: "whatsapp",
                userId,
                model: usage.model,
                promptTokens: usage.promptTokens,
                completionTokens: usage.completionTokens,
                totalTokens: usage.totalTokens,
                costUsd: usage.costUsd
              });
            } catch (error) {
              console.error("OpenRouter usage log failed:", error.message);
            }
          }
        });
        if (aiResponse) response = aiResponse;
        logEvent("ai", { enabled: Boolean(aiResponse), sourceCount: citations.length, userId });
      } catch (error) {
        console.error("OpenRouter failed; using the source excerpt:", error.message);
        logEvent("ai_error", { message: error.message, sourceCount: citations.length, userId });
      }
    }

    response = removeCustomerCitations(response);

    routed.turn = await store.addHistory(userId, text, response, {
      automated: true,
      source: "whatsapp",
      metadata: { ...routed.metadata, retrieval: "approved_knowledge", citations, abstained: !grounded }
    });
  }

  if (!routed.shouldUseAi || routed.turn) await refreshLeadTemperature(userId);
  if (routed.turn) {
    try {
      await refreshCustomerTopicSummary({ store, userId, user: routed.user, currentMessage: text });
    } catch (error) {
      logEvent("conversation_summary_error", { userId, message: error.message });
    }
  }

  } finally {
    await setTyping(socket, chatId, false);
  }

  await sendStoredTextReply(socket, chatId, response, userId, routed.turn);
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
    console.error("Lead temperature update failed:", error.message);
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
    console.error("Lead temperature history backfill failed:", error.message);
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
    console.error("RAFA local control failed:", error.message);
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
    logEvent("presence_error", { chatId, message: error.message });
  }
}

async function handleMessage(socket, message, upsertType) {
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
      id: message.key?.id,
      from: remoteJid,
      fromMe,
      pushName: message.pushName,
      upsertType,
      type: messageType(message),
      body: messagePreview(extractText(message))
    });

    if (fromMe) {
      await handleSelfTestMessage(socket, message);
      return;
    }

    if (!isSupportedChatId(remoteJid)) {
      logEvent("ignored", { reason: "unsupported_chat", from: remoteJid, type: messageType(message) });
      receiptShouldComplete = true;
      return;
    }

    if (!fromMe && providerMessageId && typeof store.claimInboundMessage === "function") {
      try {
        const receipt = await store.claimInboundMessage(remoteJid, providerMessageId);
        if (receipt.duplicate || receipt.claimed === false) {
          logEvent("duplicate_inbound_message_ignored", { userId: remoteJid, messageId: providerMessageId });
          return;
        }
        persistentReceipt = true;
      } catch (error) {
        logEvent("inbound_message_dedupe_error", { userId: remoteJid, message: String(error?.message || "Message receipt store unavailable").slice(0, 200) });
      }
    }

    await rememberWhatsAppContact(remoteJid, message);

    if (typeof store.isContactBlocked === "function") {
      try {
        if (await store.isContactBlocked(remoteJid)) {
          logEvent("blocked_contact_message_ignored", { userId: remoteJid, messageId: message.key?.id || "" });
          receiptShouldComplete = true;
          return;
        }
      } catch (error) {
        logEvent("blocklist_check_error", { userId: remoteJid, message: String(error?.message || "Blocklist check failed").slice(0, 200) });
        return; // Do not send customer or automated messages when block status cannot be verified.
      }
    }

    if (!allowIncomingMessage(remoteJid)) {
      logEvent("rate_limited_per_minute", { userId: remoteJid });
      receiptShouldComplete = true;
      return;
    }

    let text = extractText(message);
    const hadAudio = Boolean(audioMessageContent(message));
    if (hadAudio) logEvent("voice_transcription_unavailable", { userId: remoteJid });

    if (!text) {
      const response = hadAudio
        ? "Sorry, I could not transcribe that voice note. Please send it as text."
        : "Please send text only.";
      await store.addHistory(remoteJid, `[${messageType(message)}]`, response);
      await sendTextReplyWithPresence(socket, remoteJid, response);
      receiptShouldComplete = true;
      return;
    }

    await answerMessage(socket, remoteJid, remoteJid, text);
    receiptShouldComplete = true;
    logEvent("replied", { mode: "customer", to: remoteJid });
  } catch (error) {
    console.error("Failed to handle message:", error);
    logEvent("error", { mode: "customer", message: error.message });
    if (remoteJid && isSupportedChatId(remoteJid)) {
      try {
        await sendTextReplyWithPresence(socket, remoteJid, "Sorry, something went wrong. Please try again.");
        receiptShouldComplete = true;
      } catch (sendError) {
        logEvent("whatsapp_error_reply_failed", { userId: remoteJid, message: String(sendError?.message || "Fallback delivery failed").slice(0, 200) });
      }
    }
  } finally {
    if (persistentReceipt && receiptShouldComplete) {
      try { await store.completeInboundMessage(remoteJid, providerMessageId); }
      catch (error) { logEvent("inbound_message_receipt_complete_error", { userId: remoteJid, message: String(error?.message || "Could not complete receipt").slice(0, 200) }); }
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
      logEvent("ignored", { reason: "unsupported_self_test_target", target: remoteJid });
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
        console.error("Manual report failed:", error.message);
        logEvent("manual_report_error", { message: error.message });
        await sendTextReplyWithPresence(socket, remoteJid, `Report failed: ${error.message}`);
      }
      return;
    }

    if (text.toLowerCase() === "reset") {
      const deletedSelfTest = await store.deleteUser(selfTestUserId);
      const deletedDirect = await store.deleteUser(remoteJid);
      logEvent("self_test_reset", { remoteJid, deletedSelfTest, deletedDirect });
      await sendTextReplyWithPresence(socket, remoteJid, `Self-test memory cleared. Send "${selfTestPrefix} hi" to start as a brand-new user.`);
      return;
    }

    await answerMessage(socket, remoteJid, selfTestUserId, text);
    logEvent("replied", { mode: "self-test", to: remoteJid });
  } catch (error) {
    console.error("Failed to handle self-test message:", error);
    logEvent("error", { mode: "self-test", message: error.message });
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
        console.error(message);
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
      console.log(`Auth folder: ${authPath}`);
      console.log(`AI: ${process.env.OPENROUTER_API_KEY ? `enabled (${process.env.OPENROUTER_MODEL || "openrouter/free"})` : "disabled"}`);
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
            console.error("Failed to reconnect WhatsApp:", error);
            logEvent("connection_error", { message: error.message });
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
            console.error("Could not clear logged-out WhatsApp credentials:", error.message);
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
  console.error("Failed to start RAFA:", error);
  logEvent("startup_error", { message: error.message });
  notifyDashboard({ type: "worker-error", message: "RAFA could not start the WhatsApp worker. Check server configuration." });
  process.exitCode = 1;
});
