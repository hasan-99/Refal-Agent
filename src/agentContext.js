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
  priorConfiguredIntroduction = false,
  conversationState = {},
  knownCustomerFacts = {},
  currentOpenQuestion = null,
  consentState = "unknown",
  allowedCapabilities = [],
  leadTier = "",
  buyingSignals = [],
  conversationPreferences = {},
  contextualWorkflow = "none"
} = {}) {
  const safeLeadTier = ["informational", "cold", "warm", "hot", "strategic"].includes(leadTier) ? leadTier : "";
  const safeBuyingSignals = [...new Set((Array.isArray(buyingSignals) ? buyingSignals : [])
    .map((signal) => typeof signal === "string" ? signal : signal?.id)
    .filter((id) => /^MB-B[1-5]$/.test(String(id || ""))))];
  return Object.freeze({
    currentMessage: safeTrim(currentMessage, 2000),
    locale: safeTrim(locale, 20) || "unknown",
    contact: Object.freeze({
      id: safeTrim(contact.id, 120),
      // Only names explicitly captured from customer wording are eligible for
      // personalization. Transport/contact labels and inferred names stay out.
      name: contact.nameSource === "customer_stated" ? safeTrim(contact.name, 80) || null : null,
      nameSource: contact.nameSource === "customer_stated" ? "customer_stated" : null
    }),
    recentConversation: Object.freeze(
      (Array.isArray(recentConversation) ? recentConversation : [])
        // buildRecentConversation supplies up to 12 transcript turns as
        // role-tagged user/assistant messages. Keep both sides of those turns;
        // truncating to 12 messages here silently cut that context in half.
        .slice(-24)
        .filter((turn) => turn && ["user", "assistant"].includes(turn.role) && typeof turn.content === "string")
        .map((turn) => Object.freeze({ role: turn.role, content: safeTrim(turn.content, 1200) }))
    ),
    // The transcript sent to the model is intentionally bounded. Preserve this
    // small continuity fact from the already-loaded full history so an older
    // introduction does not disappear when the prompt window advances.
    priorConfiguredIntroduction: priorConfiguredIntroduction === true,
    conversationState: Object.freeze({ ...conversationState }),
    knownCustomerFacts: Object.freeze({ ...knownCustomerFacts }),
    currentOpenQuestion: currentOpenQuestion ? safeTrim(currentOpenQuestion, 300) : null,
    consentState: safeTrim(consentState, 20) || "unknown",
    conversationPreferences: Object.freeze({ noProactiveBookingOrContact: conversationPreferences.noProactiveBookingOrContact === true }),
    contextualWorkflow: safeTrim(contextualWorkflow, 40),
    leadTier: safeLeadTier,
    buyingSignals: Object.freeze(safeBuyingSignals),
    allowedCapabilities: Object.freeze([...new Set((Array.isArray(allowedCapabilities) ? allowedCapabilities : []).map((v) => String(v)))])
  });
}

module.exports = { buildAgentContext };
