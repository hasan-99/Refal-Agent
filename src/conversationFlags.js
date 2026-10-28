"use strict";

// Feature flags for the conversational-behaviour upgrade. All default OFF and
// only the exact value "on" (case-insensitive, trimmed) enables one, the same
// convention as latencyFlags in src/knowledgeCache.js. With every flag off the
// decision prompt, the gates and the stored data are byte-identical to before.
//
//   RAFA_STRUCTURED_SESSION_MEMORY=on       per-conversation structured memory, rendered as a
//                                           bounded customer-context block in the decision prompt
//   RAFA_SESSION_MEMORY_IDLE_TTL_MS=7200000 idle time after which a conversation is a new session
//   RAFA_USER_PROFILE_MEMORY=on             durable, allowlisted per-contact profile (rafa_contacts.profile.memoryProfile)
//   RAFA_USER_PROFILE_RETENTION_DAYS=180    profile entries older than this are ignored and dropped on write
//   RAFA_ANSWER_FIRST_STYLE=on              compact answer-first style rule + name-at-start de-duplication
//   RAFA_TRUTHFUL_ACTION_STATES=on          deterministic post-draft guard for handoff/booking/record/
//                                           response-time/security/complaint/memory-mechanics claims
//   RAFA_SMART_FOLLOWUPS=on                 strips vague or repeated follow-up questions, limits clarifications

function flagOn(value) {
  return String(value || "").trim().toLowerCase() === "on";
}

function boundedInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function conversationFlags(env = process.env) {
  return {
    structuredSessionMemory: flagOn(env.RAFA_STRUCTURED_SESSION_MEMORY),
    userProfileMemory: flagOn(env.RAFA_USER_PROFILE_MEMORY),
    answerFirstStyle: flagOn(env.RAFA_ANSWER_FIRST_STYLE),
    truthfulActionStates: flagOn(env.RAFA_TRUTHFUL_ACTION_STATES),
    smartFollowups: flagOn(env.RAFA_SMART_FOLLOWUPS),
    // 2 hours by default: a customer who steps away and comes back the same
    // afternoon (or whose WhatsApp socket reconnects) keeps the session.
    sessionIdleTtlMs: boundedInt(env.RAFA_SESSION_MEMORY_IDLE_TTL_MS, 7_200_000, 300_000, 86_400_000),
    profileRetentionDays: boundedInt(env.RAFA_USER_PROFILE_RETENTION_DAYS, 180, 1, 730)
  };
}

function anyConversationFlag(flags = conversationFlags()) {
  return flags.structuredSessionMemory || flags.userProfileMemory || flags.answerFirstStyle
    || flags.truthfulActionStates || flags.smartFollowups;
}

module.exports = { conversationFlags, anyConversationFlag, flagOn };
