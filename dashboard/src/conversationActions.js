export const conversationDeleteConfirmation = (displayName) => [
  `Delete the conversation history for ${displayName}?`,
  "This permanently removes the customer's messages and REFAL's replies from Supabase.",
  "The contact/lead record, appointments, and related workflow or audit records will remain.",
  "This cannot be undone."
].join("\n\n");

export async function requestConversationDeletion({ userId, displayName, confirmed = false, confirm = globalThis.confirm, fetcher = globalThis.fetch }) {
  if (typeof userId !== "string" || !userId.trim()) throw new Error("A WhatsApp conversation is required.");
  if (!confirmed && (typeof confirm !== "function" || !confirm(conversationDeleteConfirmation(displayName || userId)))) return { cancelled: true };

  const response = await fetcher(`/api/conversations/${encodeURIComponent(userId)}`, {
    method: "DELETE",
    credentials: "include",
    cache: "no-store"
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "Could not delete this conversation.");
  if (payload.deleted !== true) throw new Error("The conversation was not deleted.");
  return { cancelled: false, deletedTurns: Number(payload.deletedTurns) || 0 };
}
