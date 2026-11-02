"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EdgeApiStore } = require("./supabaseStore");

test("attachment upload uses only its scoped signed token and never sends bytes through history or public URLs", async (t) => {
  const calls = [];
  const fileBytes = Buffer.from("private-file-content");
  t.mock.method(globalThis, "fetch", async (input, options) => {
    const url = new URL(input);
    calls.push({ url, options });
    if (url.pathname.endsWith("/attachments/prepare")) return new Response(JSON.stringify({
      attachmentId: "10000000-0000-4000-8000-000000000001",
      storagePath: "refalco/20000000-0000-4000-8000-000000000002/cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc/10000000-0000-4000-8000-000000000001",
      token: "scoped-upload-token"
    }), { status: 200 });
    if (url.pathname.startsWith("/storage/v1/object/upload/sign/")) return new Response("{}", { status: 200 });
    if (url.pathname.endsWith("/attachments/complete")) return new Response(JSON.stringify({ attachment: {
      id: "10000000-0000-4000-8000-000000000001", status: "uploaded", fileName: "invoice.pdf", contentType: "application/pdf", sizeBytes: fileBytes.length
    } }), { status: 200 });
    throw new Error(`Unexpected request path: ${url.pathname}`);
  });
  const store = new EdgeApiStore({ apiUrl: "https://project.supabase.co/functions/v1/rafa-agent-api", supabaseUrl: "https://project.supabase.co", key: "publishable-test-key", apiSecret: "api-secret" });
  const upload = await store.prepareAttachment({ userId: "12345@s.whatsapp.net", messageId: "provider-message", fileName: "invoice.pdf",
    contentType: "application/pdf", sizeBytes: fileBytes.length, sha256: "a".repeat(64) });
  await store.uploadAttachment(upload, fileBytes, "application/pdf");
  const completed = await store.completeAttachment({ userId: "12345@s.whatsapp.net", messageId: "provider-message", attachmentId: upload.attachmentId });

  assert.equal(completed.status, "uploaded");
  assert.equal(calls.length, 3);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    userId: "12345@s.whatsapp.net", messageId: "provider-message", fileName: "invoice.pdf",
    contentType: "application/pdf", sizeBytes: fileBytes.length, sha256: "a".repeat(64)
  });
  assert.equal(calls[1].url.searchParams.get("token"), "scoped-upload-token");
  assert.equal(calls[1].options.method, "PUT");
  assert.equal(calls[1].options.headers.authorization, "Bearer publishable-test-key");
  assert.deepEqual(calls[1].options.body, fileBytes);
  assert.doesNotMatch(calls[2].options.body, /storagePath|token|url/iu);
});
