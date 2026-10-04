const WHATSAPP_CONVERSATION_ID = /^(?:\d+|[A-Za-z0-9._-]+)@(?:s\.whatsapp\.net|c\.us|lid)$/;

export async function deleteConversationTranscript(store, userId) {
  const id = String(userId || "").trim();
  if (!WHATSAPP_CONVERSATION_ID.test(id)) {
    throw Object.assign(new Error("A valid WhatsApp conversation is required."), { statusCode: 400 });
  }
  if (typeof store?.deleteConversation !== "function") {
    throw new Error("Conversation deletion is not available.");
  }
  return store.deleteConversation(id);
}
