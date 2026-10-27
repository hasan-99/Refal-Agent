// Keep the Edge provider boundary under the same conservative input ceiling as
// the Node WhatsApp and Agent-decision paths. Count serialized request bytes,
// including all body fields, then add per-message/request framing.
export const MAX_PROMPT_TOKEN_CEILING = 40_000;
export const PROMPT_MESSAGE_FRAMING_TOKEN_RESERVE = 16;
export const PROMPT_GLOBAL_FRAMING_TOKEN_RESERVE = 64;

export function promptTokenUpperBound(requestOrMessages) {
  if (!requestOrMessages || typeof requestOrMessages !== "object") return Infinity;
  const messages = Array.isArray(requestOrMessages)
    ? requestOrMessages
    : requestOrMessages.messages;
  let serialized;
  try {
    serialized = JSON.stringify(requestOrMessages);
  } catch {
    return Infinity;
  }
  if (typeof serialized !== "string") return Infinity;
  return new TextEncoder().encode(serialized).byteLength
    + ((Array.isArray(messages) ? messages.length : 0) * PROMPT_MESSAGE_FRAMING_TOKEN_RESERVE)
    + PROMPT_GLOBAL_FRAMING_TOKEN_RESERVE;
}

export function isPromptWithinTokenCeiling(messages) {
  return promptTokenUpperBound(messages) <= MAX_PROMPT_TOKEN_CEILING;
}
