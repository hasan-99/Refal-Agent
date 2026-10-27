import test from "node:test";
import assert from "node:assert/strict";
import { conversationDeleteConfirmation, requestConversationDeletion } from "./src/conversationActions.js";

test("conversation reset asks for confirmation and explains memory and operational retention", () => {
  const message = conversationDeleteConfirmation("مش");
  assert.match(message, /messages, REFAL's replies, and conversation-derived memory/);
  assert.match(message, /next message starts a fresh conversation/);
  assert.match(message, /contact record, appointments, handovers, complaints, audit records, and contact restrictions will remain/);
  assert.match(message, /cannot be undone/i);
});

test("canceling the delete confirmation makes no request", async () => {
  let requests = 0;
  const result = await requestConversationDeletion({
    userId: "123@s.whatsapp.net",
    displayName: "Customer",
    confirm: () => false,
    fetcher: async () => { requests += 1; }
  });
  assert.deepEqual(result, { cancelled: true });
  assert.equal(requests, 0);
});

test("confirmed deletion sends an authenticated DELETE for only the selected conversation", async () => {
  let request;
  const result = await requestConversationDeletion({
    userId: "123@s.whatsapp.net",
    displayName: "Customer",
    confirm: () => true,
    fetcher: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ deleted: true, deletedTurns: 3 }) };
    }
  });
  assert.deepEqual(result, { cancelled: false, deletedTurns: 3 });
  assert.equal(request.url, "/api/conversations/123%40s.whatsapp.net");
  assert.equal(request.options.method, "DELETE");
  assert.equal(request.options.credentials, "include");
});

test("in-app confirmation skips the browser-native confirm dialog", async () => {
  let requested = false;
  const result = await requestConversationDeletion({
    userId: "123@s.whatsapp.net",
    confirmed: true,
    confirm: () => { throw new Error("Native confirmation must not be shown."); },
    fetcher: async () => { requested = true; return { ok: true, json: async () => ({ deleted: true, deletedTurns: 0 }) }; }
  });
  assert.deepEqual(result, { cancelled: false, deletedTurns: 0 });
  assert.equal(requested, true);
});

test("failed server deletion is surfaced and not reported as success", async () => {
  await assert.rejects(requestConversationDeletion({
    userId: "123@s.whatsapp.net",
    confirm: () => true,
    fetcher: async () => ({ ok: false, json: async () => ({ error: "Not authorized." }) })
  }), /Not authorized/);
});
