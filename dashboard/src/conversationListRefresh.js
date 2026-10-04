export async function fetchConversationLists(fetcher = globalThis.fetch, signal) {
  const [conversationResponse, leadResponse] = await Promise.all([
    fetcher("/api/conversations", { credentials: "include", cache: "no-store", signal }),
    fetcher("/api/leads", { credentials: "include", cache: "no-store", signal })
  ]);
  const [conversationPayload, leadPayload] = await Promise.all([
    conversationResponse.json().catch(() => ({})), leadResponse.json().catch(() => ({}))
  ]);
  if (!conversationResponse.ok) throw new Error(conversationPayload.error || `Could not load conversations (${conversationResponse.status}).`);
  if (!leadResponse.ok) throw new Error(leadPayload.error || `Could not load leads (${leadResponse.status}).`);
  if (!Array.isArray(conversationPayload.conversations) || !Array.isArray(leadPayload.users)) {
    throw new Error("The inbox service returned an invalid response.");
  }
  return { rows: conversationPayload.conversations, leads: leadPayload.users };
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
