export async function fetchConversationLists(fetcher = globalThis.fetch, signal) {
  const response = await fetcher("/api/conversations", { credentials: "include", cache: "no-store", signal });
  const conversationPayload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(conversationPayload.error || `Could not load conversations (${response.status}).`);
  if (!Array.isArray(conversationPayload.conversations) || !Array.isArray(conversationPayload.leads)) {
    throw new Error("The inbox service returned an invalid response.");
  }
  return { rows: conversationPayload.conversations, leads: conversationPayload.leads };
}

export function watchForConversationListChanges({
  refresh,
  windowTarget = globalThis.window,
  documentTarget = globalThis.document,
  intervalMs = 15000,
  setIntervalFn = globalThis.setInterval,
  clearIntervalFn = globalThis.clearInterval
}) {
  if (typeof refresh !== "function" || !windowTarget || !documentTarget) return () => {};
  const refreshIfVisible = () => {
    if (documentTarget.visibilityState === "visible") refresh();
  };
  const onVisibilityChange = () => refreshIfVisible();
  const timer = setIntervalFn(refreshIfVisible, intervalMs);
  windowTarget.addEventListener("focus", refreshIfVisible);
  documentTarget.addEventListener("visibilitychange", onVisibilityChange);
  return () => {
    clearIntervalFn(timer);
    windowTarget.removeEventListener("focus", refreshIfVisible);
    documentTarget.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
