import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { normalizeWhatsAppNumber } from "./phoneNumber.js";

export { normalizeWhatsAppNumber };

export function createWhatsAppController({ botRoot, spawn = nodeSpawn, timers = globalThis, replyEditTimeoutMs = 15000 }) {
  let child = null;
  let state = "disconnected";
  let phoneNumber = "";
  let pairingCode = "";
  let pairingQr = "";
  let pairingMethod = "code";
  let error = "";
  let connectedAt = null;
  let startupTimer = null;
  let workerConnected = false;
  const pendingReplyEdits = new Map();
  const pendingCustomerTexts = new Map();

  function rejectPendingReplyEdits(message) {
    for (const [requestId, pending] of pendingReplyEdits) {
      timers.clearTimeout(pending.timer);
      pendingReplyEdits.delete(requestId);
      pending.reject(new Error(message));
    }
    for (const [requestId, pending] of pendingCustomerTexts) {
      timers.clearTimeout(pending.timer);
      pendingCustomerTexts.delete(requestId);
      pending.reject(new Error(message));
    }
  }

  function clearStartupTimer() {
    if (startupTimer) timers.clearTimeout(startupTimer);
    startupTimer = null;
  }

  function snapshot() {
    return { state, phoneNumber, pairingCode, pairingQr, pairingMethod, error, connectedAt, managed: Boolean(child) };
  }

  function handleMessage(message) {
    if (!message || typeof message !== "object" || Array.isArray(message)) return;
    if (message.type === "reply-edit-result") {
      if (typeof message.requestId !== "string") return;
      const pending = pendingReplyEdits.get(message.requestId);
      if (!pending) return;
      pendingReplyEdits.delete(message.requestId);
      timers.clearTimeout(pending.timer);
      if (message.ok === true && message.result && typeof message.result === "object" &&
          message.result.status === "sent" && message.result.action === pending.mode &&
          (message.result.key === null || (message.result.key && typeof message.result.key === "object" && !Array.isArray(message.result.key)))) {
        pending.resolve({ key: message.result.key, action: message.result.action, status: "sent" });
      } else {
        const safeError = typeof message.error === "string" ? message.error.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 200) : "WhatsApp could not deliver the reply update.";
        pending.reject(new Error(safeError || "WhatsApp could not deliver the reply update."));
      }
      return;
    }
    if (message.type === "customer-text-result") {
      const pending = pendingCustomerTexts.get(message.requestId);
      if (!pending) return;
      pendingCustomerTexts.delete(message.requestId);
      timers.clearTimeout(pending.timer);
      if (message.ok === true && message.result?.status === "sent") pending.resolve(message.result);
      else pending.reject(new Error(String(message.error || "WhatsApp could not deliver the message.").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 200)));
      return;
    }
    if (message.type === "pairing-code" && state !== "disconnected") {
      pairingCode = String(message.code || "").replace(/[^A-Z0-9-]/gi, "").slice(0, 16);
      pairingQr = "";
      state = "pairing";
      error = "";
      return;
    }
    if (message.type === "pairing-qr" && state !== "disconnected") {
      pairingQr = String(message.qr || "").slice(0, 12000);
      pairingCode = "";
      state = "pairing";
      error = "";
      return;
    }
    if (message.type === "connection") {
      if (state === "stopping" || state === "error") return;
      if (message.connection === "open") {
        clearStartupTimer();
        pairingCode = "";
        pairingQr = "";
        phoneNumber = normalizeWhatsAppNumber(message.phoneNumber) || phoneNumber;
        state = "connected";
        workerConnected = true;
        connectedAt = new Date().toISOString();
        error = "";
      } else if (message.connection === "connecting" && state !== "pairing") {
        workerConnected = false;
        state = "connecting";
      } else if (message.connection === "close" && child) {
        workerConnected = false;
        rejectPendingReplyEdits("WhatsApp worker is not connected.");
        pairingCode = "";
        pairingQr = "";
        state = "connecting";
      }
      return;
    }
    if (message.type === "worker-error") {
      workerConnected = false;
      rejectPendingReplyEdits("WhatsApp worker is not connected.");
      clearStartupTimer();
      pairingCode = "";
      pairingQr = "";
      state = "error";
      error = String(message.message || "WhatsApp connection failed.").slice(0, 300);
    }
  }

  function connect(value, method = "code") {
    const normalized = normalizeWhatsAppNumber(value);
    if (!normalized) {
      const invalid = new Error("Enter a valid WhatsApp number in international format, including country code, and check every digit.");
      invalid.statusCode = 400;
      throw invalid;
    }
    if (method !== "code" && method !== "qr") {
      const invalid = new Error("Choose phone code or QR pairing.");
      invalid.statusCode = 400;
      throw invalid;
    }
    if (child) {
      const conflict = new Error("The dashboard already has a WhatsApp connection attempt in progress.");
      conflict.statusCode = 409;
      throw conflict;
    }

    clearStartupTimer();
    phoneNumber = normalized;
    pairingCode = "";
    pairingQr = "";
    pairingMethod = method;
    error = "";
    connectedAt = null;
    state = "connecting";
    workerConnected = false;
    try {
      child = spawn(process.execPath, ["src/bot.js"], {
        cwd: botRoot,
        env: { ...process.env, RAFA_PHONE_NUMBER: normalized, RAFA_PAIRING_METHOD: method, RAFA_DASHBOARD_MANAGED: "true" },
        stdio: ["ignore", "ignore", "pipe", "ipc"]
      });
    } catch (cause) {
      child = null;
      state = "error";
      error = "Could not start the WhatsApp worker.";
      throw Object.assign(new Error(error), { cause });
    }

    child.stderr?.on("data", (chunk) => {
      const detail = String(chunk || "").match(/WhatsApp pairing-code request failed:\s*([^\r\n]+)/)?.[1];
      if (detail && state !== "error") {
        state = "error";
        error = `WhatsApp pairing failed: ${detail.slice(0, 180)}`;
        pairingCode = "";
      }
    });
    child.on("message", handleMessage);
    child.on("error", () => {
      clearStartupTimer();
      pairingCode = "";
      pairingQr = "";
      state = "error";
      workerConnected = false;
      rejectPendingReplyEdits("WhatsApp worker is not connected.");
      error = "The WhatsApp worker could not start.";
      child = null;
    });
    child.on("exit", (code) => {
      clearStartupTimer();
      const wasStopping = state === "stopping";
      const hadError = state === "error";
      child = null;
      pairingCode = "";
      pairingQr = "";
      state = wasStopping ? "disconnected" : hadError || code !== 0 ? "error" : "disconnected";
      workerConnected = false;
      rejectPendingReplyEdits("WhatsApp worker is not connected.");
      if (state === "error" && !error) error = "The WhatsApp worker stopped unexpectedly.";
      if (state === "disconnected") error = "";
    });
    startupTimer = timers.setTimeout(() => {
      if (child && state === "connecting") {
        state = "error";
        error = "WhatsApp did not respond. Check the server connection and try again.";
        child.send?.({ type: "disconnect" });
      }
    }, 45000);
    return snapshot();
  }

  function disconnect() {
    if (!child) {
      state = "disconnected";
      pairingCode = "";
      pairingQr = "";
      connectedAt = null;
      error = "";
      return snapshot();
    }
    clearStartupTimer();
    state = "stopping";
    workerConnected = false;
    rejectPendingReplyEdits("WhatsApp worker is not connected.");
    pairingCode = "";
    pairingQr = "";
    child.send?.({ type: "disconnect" }, (sendError) => {
      if (sendError && child) child.kill();
    });
    const worker = child;
    timers.setTimeout(() => {
      if (child === worker) worker.kill();
    }, 5000);
    return snapshot();
  }

  function deliverReplyEdit({ userId, text, mode, messageKey = null } = {}) {
    if (!child || !workerConnected || state !== "connected") {
      return Promise.reject(new Error("WhatsApp worker is not connected."));
    }
    const jid = String(userId || "");
    const content = typeof text === "string" ? text.trim() : "";
    if (!/^(?:\d+|[A-Za-z0-9._-]+)@(?:s\.whatsapp\.net|c\.us|lid)$/.test(jid) || !content || content.length > 4000 ||
        !["platform_edit", "correction_resend"].includes(mode)) {
      return Promise.reject(new Error("Invalid reply update request."));
    }
    if (mode === "platform_edit" && (!messageKey || typeof messageKey !== "object" || Array.isArray(messageKey) ||
        messageKey.fromMe !== true || messageKey.remoteJid !== jid || typeof messageKey.id !== "string" ||
        !/^[A-Za-z0-9_-]{8,128}$/.test(messageKey.id))) {
      return Promise.reject(new Error("Original WhatsApp message key is invalid."));
    }

    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = timers.setTimeout(() => {
        pendingReplyEdits.delete(requestId);
        reject(new Error("WhatsApp reply update timed out."));
      }, replyEditTimeoutMs);
      pendingReplyEdits.set(requestId, { resolve, reject, timer, mode });
      try {
        child.send({ type: "deliver-reply-edit", requestId, userId: jid, text: content, mode, messageKey }, (sendError) => {
          if (!sendError) return;
          const pending = pendingReplyEdits.get(requestId);
          if (!pending) return;
          pendingReplyEdits.delete(requestId);
          timers.clearTimeout(pending.timer);
          pending.reject(new Error("WhatsApp worker could not accept the reply update."));
        });
      } catch {
        const pending = pendingReplyEdits.get(requestId);
        if (!pending) return;
        pendingReplyEdits.delete(requestId);
        timers.clearTimeout(pending.timer);
        pending.reject(new Error("WhatsApp worker could not accept the reply update."));
      }
    });
  }

  function deliverCustomerText({ userId, text } = {}) {
    if (!child || !workerConnected || state !== "connected") return Promise.reject(new Error("WhatsApp worker is not connected."));
    const jid = String(userId || "");
    const content = typeof text === "string" ? text.trim() : "";
    if (!/^(?:\d+|[A-Za-z0-9._-]+)@(?:s\.whatsapp\.net|c\.us|lid)$/.test(jid) || !content || content.length > 1500) return Promise.reject(new Error("Invalid customer message."));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = timers.setTimeout(() => { pendingCustomerTexts.delete(requestId); reject(new Error("WhatsApp message delivery timed out.")); }, replyEditTimeoutMs);
      pendingCustomerTexts.set(requestId, { resolve, reject, timer });
      child.send({ type: "deliver-customer-text", requestId, userId: jid, text: content }, (error) => {
        if (!error) return;
        const pending = pendingCustomerTexts.get(requestId);
        if (!pending) return;
        pendingCustomerTexts.delete(requestId); timers.clearTimeout(pending.timer);
        pending.reject(new Error("WhatsApp worker could not accept the customer message."));
      });
    });
  }

  return { connect, disconnect, snapshot, deliverReplyEdit, deliverCustomerText };
}
