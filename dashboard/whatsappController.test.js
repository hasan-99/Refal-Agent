import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createWhatsAppController, normalizeWhatsAppNumber } from "./whatsappController.js";

function harness() {
  const children = [];
  const activeTimers = new Set();
  const timers = {
    setTimeout: (callback, delay) => { const timer = { callback, delay }; activeTimers.add(timer); return timer; },
    clearTimeout: (timer) => activeTimers.delete(timer)
  };
  const controller = createWhatsAppController({
    botRoot: "/rafa",
    timers,
    spawn: (...args) => {
      const child = new EventEmitter();
      child.stderr = new EventEmitter();
      child.send = (message, callback) => { child.messages.push(message); callback?.(); };
      child.kill = () => child.emit("exit", 1);
      child.messages = [];
      child.args = args;
      children.push(child);
      return child;
    }
  });
  return { controller, children, activeTimers };
}

function markConnected(child) {
  child.emit("message", { type: "connection", connection: "open", phoneNumber: "+35799123456" });
}

test("normalizes international numbers and rejects ambiguous or invalid input", () => {
  assert.equal(normalizeWhatsAppNumber("+357 (99) 123-456"), "+35799123456");
  assert.equal(normalizeWhatsAppNumber("+3599260049"), "+3599260049");
  assert.equal(normalizeWhatsAppNumber("+359123456789"), "");
  assert.equal(normalizeWhatsAppNumber("+359 88 123 4567"), "+359881234567");
  assert.equal(normalizeWhatsAppNumber("0035799123456"), "");
  assert.equal(normalizeWhatsAppNumber("+012345678"), "");
  assert.equal(normalizeWhatsAppNumber("+357abc99123456"), "");
  assert.equal(normalizeWhatsAppNumber("+1234567"), "");
});

test("connect launches one managed worker with the requested number and streams pairing state", () => {
  const { controller, children } = harness();
  const result = controller.connect("+357 99123456");
  assert.equal(result.state, "connecting");
  assert.equal(result.phoneNumber, "+35799123456");
  assert.equal(children.length, 1);
  assert.equal(children[0].args[2].env.RAFA_PHONE_NUMBER, "+35799123456");
  assert.equal(children[0].args[2].env.RAFA_PAIRING_METHOD, "code");
  assert.equal(children[0].args[2].env.RAFA_DASHBOARD_MANAGED, "true");

  children[0].emit("message", { type: "pairing-code", code: "ABCD-EFGH" });
  assert.equal(controller.snapshot().state, "pairing");
  assert.equal(controller.snapshot().pairingCode, "ABCD-EFGH");
  assert.throws(() => controller.connect("+35799123456"), { statusCode: 409 });

  children[0].emit("message", { type: "connection", connection: "open", phoneNumber: "+35799123456" });
  assert.equal(controller.snapshot().state, "connected");
  assert.equal(controller.snapshot().pairingCode, "");
});

test("QR pairing state stays ephemeral and carries the expected account number", () => {
  const { controller, children } = harness();
  const result = controller.connect("+35799260049", "qr");
  assert.equal(result.phoneNumber, "+35799260049");
  assert.equal(children[0].args[2].env.RAFA_PAIRING_METHOD, "qr");
  children[0].emit("message", { type: "pairing-qr", qr: "temporary-qr-payload" });
  assert.equal(controller.snapshot().state, "pairing");
  assert.equal(controller.snapshot().pairingMethod, "qr");
  assert.equal(controller.snapshot().pairingQr, "temporary-qr-payload");
  children[0].emit("message", { type: "connection", connection: "open", phoneNumber: "+35799260049" });
  assert.equal(controller.snapshot().state, "connected");
  assert.equal(controller.snapshot().pairingQr, "");
});

test("rejects unsupported pairing methods before starting a worker", () => {
  const { controller, children } = harness();
  assert.throws(() => controller.connect("+35799260049", "sms"), { statusCode: 400 });
  assert.equal(children.length, 0);
});

test("disconnect stops the managed worker without clearing the linked number", () => {
  const { controller, children } = harness();
  controller.connect("+35799123456");
  const stopped = controller.disconnect();
  assert.equal(stopped.state, "stopping");
  assert.deepEqual(children[0].messages, [{ type: "disconnect" }]);
  children[0].emit("exit", 0);
  assert.equal(controller.snapshot().state, "disconnected");
  assert.equal(controller.snapshot().phoneNumber, "+35799123456");
  assert.equal(controller.snapshot().pairingCode, "");
});

test("worker errors clear any ephemeral pairing code", () => {
  const { controller, children } = harness();
  controller.connect("+35799123456");
  children[0].emit("message", { type: "pairing-code", code: "ABCD-EFGH" });
  children[0].emit("message", { type: "worker-error", message: "Pairing failed" });
  assert.equal(controller.snapshot().state, "error");
  assert.equal(controller.snapshot().pairingCode, "");
  assert.equal(controller.snapshot().error, "Pairing failed");
});

test("delivers a platform edit over correlated worker IPC and resolves the exact result", async () => {
  const { controller, children } = harness();
  controller.connect("+35799123456");
  const child = children[0];
  markConnected(child);
  const messageKey = { remoteJid: "35799123456@s.whatsapp.net", fromMe: true, id: "ABCDEF123456" };
  const pending = controller.deliverReplyEdit({ userId: messageKey.remoteJid, text: "Updated answer", mode: "platform_edit", messageKey });
  const request = child.messages.at(-1);
  assert.equal(request.type, "deliver-reply-edit");
  assert.match(request.requestId, /^[a-f0-9-]{36}$/i);
  assert.deepEqual(request.messageKey, messageKey);
  child.emit("message", {
    type: "reply-edit-result",
    requestId: request.requestId,
    ok: true,
    result: { key: messageKey, action: "platform_edit", status: "sent" }
  });
  assert.deepEqual(await pending, { key: messageKey, action: "platform_edit", status: "sent" });
});

test("delivers customer booking notifications only through the connected managed worker", async () => {
  const { controller, children } = harness();
  await assert.rejects(controller.deliverCustomerText({ userId: "35799123456@s.whatsapp.net", text: "Confirmed" }), /not connected/i);
  controller.connect("+35799123456");
  const child = children[0];
  markConnected(child);
  const pending = controller.deliverCustomerText({ userId: "35799123456@s.whatsapp.net", text: "Your appointment is confirmed." });
  const request = child.messages.at(-1);
  assert.equal(request.type, "deliver-customer-text");
  child.emit("message", { type: "customer-text-result", requestId: request.requestId, ok: true, result: { status: "sent", key: null } });
  assert.deepEqual(await pending, { status: "sent", key: null });
  await assert.rejects(controller.deliverCustomerText({ userId: "not-a-whatsapp-id", text: "No" }), /Invalid customer message/i);
});

test("rejects disconnected delivery, invalid keys, and worker failures", async () => {
  const { controller, children } = harness();
  await assert.rejects(controller.deliverReplyEdit({ userId: "35799123456@s.whatsapp.net", text: "No", mode: "platform_edit" }), /not connected/i);
  controller.connect("+35799123456");
  const child = children[0];
  markConnected(child);
  await assert.rejects(controller.deliverReplyEdit({
    userId: "35799123456@s.whatsapp.net", text: "No", mode: "platform_edit",
    messageKey: { remoteJid: "35799123456@s.whatsapp.net", fromMe: false, id: "ABCDEF123456" }
  }), /key is invalid/i);
  const pending = controller.deliverReplyEdit({ userId: "35799123456@s.whatsapp.net", text: "Correction", mode: "correction_resend" });
  const request = child.messages.at(-1);
  child.emit("message", { type: "reply-edit-result", requestId: request.requestId, ok: false, error: "WhatsApp could not deliver the reply update." });
  await assert.rejects(pending, /could not deliver/i);
});

test("reply edit requests reject after their deadline", async () => {
  const { controller, children, activeTimers } = harness();
  controller.connect("+35799123456");
  const child = children[0];
  markConnected(child);
  const pending = controller.deliverReplyEdit({ userId: "35799123456@s.whatsapp.net", text: "Correction", mode: "correction_resend" });
  const timeout = [...activeTimers].find((timer) => timer.delay === 15000);
  assert.ok(timeout);
  timeout.callback();
  await assert.rejects(pending, /timed out/i);
});
