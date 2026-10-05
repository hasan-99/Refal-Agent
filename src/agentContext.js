// Builds the trusted, structured input for one Agent turn (see agentLoop.js).
//
// This is deliberately a narrow allowlist copy, not a pass-through of
// whatever the caller has lying around: it protects the Agent decision step
// from ever seeing secrets, raw WhatsApp transport internals, or more
// personal data than it needs to help with the current message.

function safeTrim(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function buildAgentContext({
  currentMessage,
  locale,
  contact = {},
  recentConversation = [],
  conversationState = {},
  knownCustomerFacts = {},
  currentOpenQuestion = null,
  consentState = "unknown",
  allowedCapabilities = []
} = {}) {
  return Object.freeze({
    currentMessage: safeTrim(currentMessage, 2000),
    locale: safeTrim(locale, 20) || "unknown",
    contact: Object.freeze({
      id: safeTrim(contact.id, 120),
      name: safeTrim(contact.name, 120) || null
    }),
    recentConversation: Object.freeze(
      (Array.isArray(recentConversation) ? recentConversation : [])
        .slice(-12)
        .filter((turn) => turn && ["user", "assistant"].includes(turn.role) && typeof turn.content === "string")
        .map((turn) => Object.freeze({ role: turn.role, content: safeTrim(turn.content, 1200) }))
    ),
    conversationState: Object.freeze({ ...conversationState }),
    knownCustomerFacts: Object.freeze({ ...knownCustomerFacts }),
    currentOpenQuestion: currentOpenQuestion ? safeTrim(currentOpenQuestion, 300) : null,
    consentState: safeTrim(consentState, 20) || "unknown",
    allowedCapabilities: Object.freeze([...new Set((Array.isArray(allowedCapabilities) ? allowedCapabilities : []).map((v) => String(v)))])
  });
}

module.exports = { buildAgentContext };
