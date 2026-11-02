import test from "node:test";
import assert from "node:assert/strict";
import { registerPrivateAttachmentPreviewRoute } from "./privateAttachmentPreview.js";

const attachmentId = "d42c5166-ead7-43bc-975a-3b941ab9d906";
const turnId = "c6052be0-f2bf-4c80-93e5-68532def08a3";
const userId = "210277387751547@lid";

function makeRoute(overrides = {}) {
  let handler;
  const calls = { find: [], read: [], sign: [] };
  const app = { get(_path, _middleware, callback) { handler = callback; } };
  registerPrivateAttachmentPreviewRoute(app, {
    requireAdmin(_req, _res, next) { next(); },
    findConversationTurn: async (...args) => {
      calls.find.push(args);
      return { id: turnId, metadata: { attachment: { id: attachmentId, messageId: "provider-message" } } };
    },
    readLinkedAttachment: async (input) => {
      calls.read.push(input);
      return { storagePath: "refalco/contact/hash/attachment", status: "linked" };
    },
    createSignedPreviewUrl: async (...args) => {
      calls.sign.push(args);
      return "https://project.example/storage/v1/object/sign/private/file?token=short-lived";
    },
    ...overrides
  });
  return { handler, calls };
}

async function invoke(handler, params = { userId, attachmentId }) {
  const response = {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    json(body) { this.body = body; return this; }
  };
  await handler({ params }, response);
  return response;
}

test("private attachment preview signs only a file linked to the requested conversation turn", async () => {
  const { handler, calls } = makeRoute();
  const response = await invoke(handler);

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["Cache-Control"], "no-store");
  assert.deepEqual(response.body, {
    url: "https://project.example/storage/v1/object/sign/private/file?token=short-lived",
    expiresIn: 120
  });
  assert.deepEqual(calls.find, [[userId, attachmentId]]);
  assert.deepEqual(calls.read, [{ attachmentId, turnId, messageId: "provider-message" }]);
  assert.equal(calls.sign.length, 1);
});

test("private attachment preview returns not found when the conversation does not own the attachment", async () => {
  let reads = 0;
  let signs = 0;
  const { handler } = makeRoute({
    findConversationTurn: async () => null,
    readLinkedAttachment: async () => { reads += 1; return null; },
    createSignedPreviewUrl: async () => { signs += 1; return ""; }
  });
  const response = await invoke(handler);

  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.body, { error: "Attachment not found." });
  assert.equal(reads, 0);
  assert.equal(signs, 0);
});

test("private attachment preview rejects malformed IDs before looking up customer data", async () => {
  const { handler, calls } = makeRoute();
  const response = await invoke(handler, { userId, attachmentId: "../private" });

  assert.equal(response.statusCode, 404);
  assert.equal(calls.find.length, 0);
});

test("private attachment preview does not expose storage errors or signed URLs on failure", async () => {
  const { handler } = makeRoute({ createSignedPreviewUrl: async () => { throw new Error("private bucket details"); } });
  const response = await invoke(handler);

  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.body, { error: "Attachment preview is temporarily unavailable." });
});
