// Conservative request-side ceiling for model input. Count the UTF-8 bytes of
// the complete serialized request (messages, tool-call metadata, response
// schema, and other body fields), then reserve framing tokens per message and
// for the request. This is a conservative ceiling proxy, not provider usage.
const MAX_PROMPT_TOKEN_CEILING = 40000;
const PROMPT_MESSAGE_FRAMING_TOKEN_RESERVE = 16;
const PROMPT_GLOBAL_FRAMING_TOKEN_RESERVE = 64;

// Per-surface ceilings, in the same conservative byte-based units. Measured
// 2026-10-28: production decision calls averaged about 5.4 request bytes per
// provider-reported prompt token, and both configured models (Claude Sonnet
// 5.5, GPT-6 Luna) accept 1,000,000 tokens. 56000 bytes is about 10.4k real
// tokens (about 1% of that window), so this stays a cost guard, not a model
// limit. Preflight and knowledge selection keep the 40000 default.
const DECISION_PROMPT_CEILING = 56000;
const GROUNDING_PROMPT_CEILING = 56000;

// Explicit decision-prompt budget (bytes). Priority, highest first:
//   core rules + current message (never trimmed), approved evidence (reserved),
//   recent history (bounded, trimmed oldest first), tool metadata (compacted),
//   secondary guidance (dropped first). Measured on 2026-10-28: an approved
//   section renders to 1.9-2.3 KB (p50 1.66 KB, p90 1.80 KB, max 2.12 KB of
//   content), so the reserve holds at least five complete p90 sections and the
//   cap about seven, which also keeps the grounding review within its ceiling.
const DECISION_PROMPT_BUDGET = Object.freeze({
  ceiling: DECISION_PROMPT_CEILING,
  // response_format schema, model and provider fields (measured 644 bytes)
  // plus evidence-block headers and JSON escaping not counted per item.
  requestOverhead: 1500,
  evidenceReserve: 12000,
  evidenceMax: 16000,
  historyMax: 8000,
  historyReduced: 4000,
  historyMin: 1500
});
const GROUNDING_HISTORY_MAX = 6000;

function truncateToBytes(text, maxBytes) {
  let value = String(text || "");
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  while (value && Buffer.byteLength(value, "utf8") > Math.max(0, maxBytes - 4)) value = value.slice(0, Math.floor(value.length * 0.9));
  return `${value.trimEnd()} …`;
}

/**
 * Bounds a {role, content} transcript to maxBytes, in this order:
 *   1. the latest two turns (normally the last customer message and the last
 *      reply), truncated only if they alone exceed the bound, so a follow-up
 *      can still be resolved;
 *   2. earlier CUSTOMER messages, newest first: they carry explicit
 *      preferences and exclusions ("not interested in property") that must
 *      outlive trimming;
 *   3. earlier assistant replies, newest first, each shortened to 900 bytes.
 *      They are context only, never evidence, so they are dropped first.
 * Original order is preserved. Returns the kept turns and the omitted count.
 */
function boundRecentConversation(turns = [], maxBytes = DECISION_PROMPT_BUDGET.historyMax) {
  const list = Array.isArray(turns) ? turns : [];
  const cost = (content) => Buffer.byteLength(content, "utf8") + 24;
  const keep = new Map();
  let used = 0;
  const tail = list.length - 2;
  for (let index = list.length - 1; index >= Math.max(0, tail); index -= 1) {
    let content = String(list[index]?.content || "");
    if (used + cost(content) > maxBytes) content = truncateToBytes(content, Math.max(240, maxBytes - used - 24));
    keep.set(index, content);
    used += cost(content);
  }
  for (const role of ["user", "assistant"]) {
    for (let index = tail - 1; index >= 0; index -= 1) {
      if ((list[index]?.role === "assistant" ? "assistant" : "user") !== role) continue;
      const content = role === "assistant" ? truncateToBytes(String(list[index]?.content || ""), 900) : String(list[index]?.content || "");
      if (used + cost(content) > maxBytes) continue;
      keep.set(index, content);
      used += cost(content);
    }
  }
  const kept = [...keep.keys()].sort((a, b) => a - b).map((index) => ({ ...list[index], content: keep.get(index) }));
  return { turns: kept, omitted: list.length - kept.length, bytes: used };
}

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

function assertPromptWithinTokenCeiling(requestOrMessages, ceiling = MAX_PROMPT_TOKEN_CEILING) {
  const upperBound = promptTokenUpperBound(requestOrMessages);
  if (upperBound > ceiling) {
    const error = new Error("Model prompt exceeds the configured input token ceiling.");
    error.code = "PROMPT_TOKEN_CEILING_EXCEEDED";
    throw error;
  }
  return upperBound;
}

module.exports = {
  MAX_PROMPT_TOKEN_CEILING,
  DECISION_PROMPT_CEILING,
  GROUNDING_PROMPT_CEILING,
  DECISION_PROMPT_BUDGET,
  GROUNDING_HISTORY_MAX,
  boundRecentConversation,
  truncateToBytes,
  PROMPT_MESSAGE_FRAMING_TOKEN_RESERVE,
  PROMPT_GLOBAL_FRAMING_TOKEN_RESERVE,
  promptTokenUpperBound,
  isPromptWithinTokenCeiling,
  assertPromptWithinTokenCeiling
};
