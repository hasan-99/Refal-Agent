import test from "node:test";
import assert from "node:assert/strict";
import { deleteConversationTranscript } from "./conversationDelete.js";

test("conversation deletion is scoped to a valid WhatsApp JID", async () => {
  let receivedId = "";
  const result = await deleteConversationTranscript({
    deleteConversation: async (id) => { receivedId = id; return { deleted: true, deletedTurns: 2 }; }
  }, "123@s.whatsapp.net");
  assert.equal(receivedId, "123@s.whatsapp.net");
  assert.deepEqual(result, { deleted: true, deletedTurns: 2 });
});

test("invalid or missing conversation IDs fail before touching Supabase", async () => {
  let calls = 0;
  const store = { deleteConversation: async () => { calls += 1; } };
  await assert.rejects(deleteConversationTranscript(store, ""), { statusCode: 400 });
  await assert.rejects(deleteConversationTranscript(store, "all"), { statusCode: 400 });
  assert.equal(calls, 0);
});
