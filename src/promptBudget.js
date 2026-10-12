// Conservative request-side ceiling for model input. Count the UTF-8 bytes of
// the complete serialized request (messages, tool-call metadata, response
// schema, and other body fields), then reserve framing tokens per message and
// for the request. This is a conservative ceiling proxy, not provider usage.
const MAX_PROMPT_TOKEN_CEILING = 40000;
const PROMPT_MESSAGE_FRAMING_TOKEN_RESERVE = 16;
const PROMPT_GLOBAL_FRAMING_TOKEN_RESERVE = 64;

function promptTokenUpperBound(requestOrMessages) {
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
  return Buffer.byteLength(serialized, "utf8")
    + ((Array.isArray(messages) ? messages.length : 0) * PROMPT_MESSAGE_FRAMING_TOKEN_RESERVE)
    + PROMPT_GLOBAL_FRAMING_TOKEN_RESERVE;
}

function isPromptWithinTokenCeiling(requestOrMessages) {
  return promptTokenUpperBound(requestOrMessages) <= MAX_PROMPT_TOKEN_CEILING;
}

function assertPromptWithinTokenCeiling(requestOrMessages) {
  const upperBound = promptTokenUpperBound(requestOrMessages);
  if (upperBound > MAX_PROMPT_TOKEN_CEILING) {
    const error = new Error("Model prompt exceeds the configured input token ceiling.");
    error.code = "PROMPT_TOKEN_CEILING_EXCEEDED";
    throw error;
  }
  return upperBound;
}

module.exports = {
  MAX_PROMPT_TOKEN_CEILING,
  PROMPT_MESSAGE_FRAMING_TOKEN_RESERVE,
  PROMPT_GLOBAL_FRAMING_TOKEN_RESERVE,
  promptTokenUpperBound,
  isPromptWithinTokenCeiling,
  assertPromptWithinTokenCeiling
};
