"use strict";

// A narrow handoff from the deterministic WhatsApp preflight to the Agent.
// This module deliberately knows nothing about sockets, stores, or the bot's
// routing implementation: callers inject the persistence and delivery seams.

const DYNAMIC_ACTION_CAPABILITIES = Object.freeze(["upsertLead"]);
const FORBIDDEN_INTENTS = new Set([
  "complaint",
  "existing_client",
  "legal",
  "tax",
  "immigration",
  "banking",
  "permit",
  "approval",
  "appointment",
  "privacy",
  "prompt_injection"
]);

const SAFE_FALLBACKS = Object.freeze({
  en: "I can’t confirm that right now. Please try again later.",
  ar: "ما فيني أكّد هالشي هلأ. جرّب مرة تانية لاحقًا.",
  el: "Δεν μπορώ να το επιβεβαιώσω αυτή τη στιγμή. Δοκιμάστε ξανά αργότερα."
});

function nonEmptyArray(value) {
  return Array.isArray(value) && value.length > 0;
}

function collectIntents(prepared, routed) {
  const preparedIntents = prepared?.classification?.intents;
  const routedIntents = routed?.metadata?.intent?.intents;
  if (!Array.isArray(preparedIntents) && !Array.isArray(routedIntents)) return null;
  return [...new Set([
    ...(Array.isArray(preparedIntents) ? preparedIntents : []),
    ...(Array.isArray(routedIntents) ? routedIntents : [])
  ].filter((intent) => typeof intent === "string"))];
}

function hasComplianceTriggers(prepared, routed) {
  const records = [
    prepared?.complianceTriggers,
    prepared?.metadata?.complianceEscalation?.record?.triggers,
    prepared?.metadata?.complianceEscalation?.triggers,
    routed?.complianceTriggers,
    routed?.metadata?.complianceEscalation?.record?.triggers,
    routed?.metadata?.complianceEscalation?.triggers
  ];
  return records.some(nonEmptyArray);
}

function hasPrivacySafeQuestion(prepared, routed) {
  return Boolean(
    prepared?.metadata?.privacySafeQuestion ||
    routed?.metadata?.privacySafeQuestion
  );
}

function deriveDynamicActionCapabilities({ prepared, routed } = {}) {
  if (routed?.shouldUseAi !== true) return Object.freeze([]);

  // Require an explicit safety result. Missing safety data must fail closed.
  const safety = prepared?.safety;
  if (!safety || safety.restricted !== false || nonEmptyArray(safety.risks)) return Object.freeze([]);
  if (prepared?.metadata?.safety?.restricted === true || nonEmptyArray(prepared?.metadata?.safety?.risks)) {
    return Object.freeze([]);
  }
  if (hasPrivacySafeQuestion(prepared, routed) || hasComplianceTriggers(prepared, routed)) return Object.freeze([]);

  const intents = collectIntents(prepared, routed);
  if (!intents || intents.some((intent) => FORBIDDEN_INTENTS.has(intent))) return Object.freeze([]);

  // Specialist, appointment, follow-up, and compliance writes remain owned by
  // deterministic preflight branches. The only capability eligible here is a
  // lead-field write, whose Edge handler validates every field against the
  // persisted source customer message.
  return DYNAMIC_ACTION_CAPABILITIES;
}

function normalizeAgentResponse(result) {
  if (typeof result === "string" && result.trim()) return result.trim();
  for (const value of [result?.responseText, result?.response]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

async function fallbackText(safeFallback, details) {
  if (typeof safeFallback === "function") {
    try {
      const text = await safeFallback(details);
      if (typeof text === "string" && text.trim()) return text.trim();
    } catch {
      // A broken fallback provider must not cause a post-persistence retry.
    }
  }
  const locale = String(details.locale || "").toLowerCase();
  return locale.startsWith("ar") ? SAFE_FALLBACKS.ar
    : locale.startsWith("el") || locale.startsWith("greek") ? SAFE_FALLBACKS.el
      : SAFE_FALLBACKS.en;
}

/**
 * Continue only after deterministic policy has already returned `routed`.
 * `persistTurn` must create the one source turn and return its persisted id;
 * `updateTurn` must patch that same row; `send` must perform one customer send.
 * Once source-turn persistence succeeds, this function never throws, so an
 * outer route cannot retry the customer turn through the legacy path.
 */
async function runAgentAfterPreflight({
  prepared,
  routed,
  userId,
  sourceMessage,
  locale = "english",
  pendingResponse = "Your message is being processed.",
  metadata = {}
} = {}, {
  persistTurn,
  runAgent,
  updateTurn,
  send,
  safeFallback
} = {}) {
  if (typeof send !== "function") throw new TypeError("runAgentAfterPreflight requires a send function.");

  if (routed?.shouldUseAi !== true) {
    const response = typeof routed?.response === "string" ? routed.response : "";
    const turn = routed?.turn || null;
    try {
      await send(response, turn);
      return { route: "deterministic", response, turn, sent: true, sideEffectCommitted: false };
    } catch (error) {
      return { route: "deterministic", response, turn, sent: false, deliveryError: error };
    }
  }

  if (typeof persistTurn !== "function" || typeof runAgent !== "function" || typeof updateTurn !== "function") {
    throw new TypeError("AI-eligible Agent turns require persistTurn, runAgent, and updateTurn functions.");
  }
  if (typeof userId !== "string" || !userId.trim()) throw new TypeError("Agent turns require a trusted user ID.");
  if (typeof sourceMessage !== "string" || !sourceMessage.trim()) throw new TypeError("Agent turns require the current source message.");

  // No model or action may run without a durable, contact-scoped source turn.
  // A rejected insert can be an ambiguous commit (the server may have saved
  // it before the response was lost), so it must never escape to the legacy
  // route and risk inserting the same customer message again.
  let turn;
  try {
    turn = await persistTurn({
      userId,
      message: sourceMessage,
      response: pendingResponse,
      metadata: { ...metadata, ...(routed.metadata || {}) }
    });
  } catch (error) {
    const response = await fallbackText(safeFallback, { stage: "persist", error, locale, turn: null, userId });
    try {
      await send(response, null);
      return { route: "agent_persistence_uncertain", response, turn: null, sent: true, persistenceUncertain: true };
    } catch (deliveryError) {
      return { route: "agent_persistence_uncertain", response, turn: null, sent: false, persistenceUncertain: true, deliveryError };
    }
  }
  const sourceTurnId = typeof turn?.id === "string" && turn.id.trim() ? turn.id.trim() : null;
  if (!sourceTurnId) {
    const response = await fallbackText(safeFallback, { stage: "persist", error: new Error("Persisted source turn is missing its ID."), locale, turn, userId });
    try {
      await send(response, turn || null);
      return { route: "agent_persistence_uncertain", response, turn: turn || null, sent: true, persistenceUncertain: true };
    } catch (deliveryError) {
      return { route: "agent_persistence_uncertain", response, turn: turn || null, sent: false, persistenceUncertain: true, deliveryError };
    }
  }

  const allowedCapabilities = deriveDynamicActionCapabilities({ prepared, routed });
  let response = null;
  let agentError = null;
  let updatedTurn = turn;
  try {
    if (typeof runAgent !== "function") throw new TypeError("runAgent is required.");
    response = normalizeAgentResponse(await runAgent({ sourceTurnId, allowedCapabilities }));
    if (!response) agentError = new Error("Agent returned no usable response.");
  } catch (error) {
    agentError = error;
  }
  if (!response) {
    response = await fallbackText(safeFallback, { stage: "agent", error: agentError, locale, turn, userId });
  }

  let persistenceUpdated = true;
  try {
    const patched = await updateTurn({
      userId,
      turnId: sourceTurnId,
      patch: { response }
    });
    if (patched && typeof patched === "object") updatedTurn = patched;
  } catch (error) {
    // The response is still sent once, but it cannot be represented as saved.
    // Use neutral wording and never retry the patch or the legacy turn.
    persistenceUpdated = false;
    response = await fallbackText(safeFallback, { stage: "update", error, locale, turn, userId });
  }

  try {
    await send(response, updatedTurn);
    return {
      route: "agent",
      response,
      turn: updatedTurn,
      sourceTurnId,
      allowedCapabilities,
      sent: true,
      persistenceUpdated,
      agentError: agentError || null
    };
  } catch (error) {
    // Never throw after source-turn persistence: the outer router must not
    // retry and potentially duplicate a committed action or customer send.
    return {
      route: "agent",
      response,
      turn: updatedTurn,
      sourceTurnId,
      allowedCapabilities,
      sent: false,
      persistenceUpdated,
      deliveryError: error,
      agentError: agentError || null
    };
  }
}

module.exports = {
  deriveDynamicActionCapabilities,
  runAgentAfterPreflight,
  FORBIDDEN_INTENTS,
  DYNAMIC_ACTION_CAPABILITIES
};
