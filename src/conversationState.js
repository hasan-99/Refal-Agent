// REFAL-AGENT-006 — a single, canonical conversation-state projection.
//
// Scope decision (see docs/refal-agent-refactor-progress.md decision log):
// this WRAPS the existing scattered profile fields rather than migrating
// where/how they are written. The ~7 fields this reads
// (profile.leadQualification, profile.opportunityIntake(s),
// profile.existingClientState, profile.handover, profile.specialistFollowUp,
// profile.conversationPreferences.noProactiveBookingOrContact, user.consent)
// are written by messageRouter.js, existingClientWorkflow.js, and
// leadQualification.js today, each with its own existing test coverage. A
// full migration of those write call sites is a separate, even-more-isolated
// change (not this ticket) — this file's job is to give every NEW reader
// (starting with the Agent's getCustomerContext tool) exactly one place to
// ask "what do we know about this conversation," instead of each call site
// re-deriving the scattered shape itself.
//
// This module never writes; it is a pure projection of an already-loaded
// user object.

const { getConsentState } = require("./leadQualification");
const { canDiscloseAccountInformation } = require("./existingClientWorkflow");

function getConversationState(user = {}) {
  const profile = user.profile || {};
  const handover = profile.handover || {};
  const existingClient = profile.existingClientState || null;

  return Object.freeze({
    leadQualification: profile.leadQualification || null,
    opportunityIntake: profile.opportunityIntake || null,
    opportunityIntakes: Object.freeze({ ...(profile.opportunityIntakes || {}) }),
    existingClient: Object.freeze({
      state: existingClient?.state || "unauthenticated",
      authenticated: Boolean(existingClient?.authenticated),
      accountDisclosureAllowed: existingClient ? canDiscloseAccountInformation(existingClient) : false
    }),
    handover: Object.freeze({
      required: Boolean(handover.required),
      status: handover.status || null,
      department: handover.department || null
    }),
    specialistFollowUp: profile.specialistFollowUp ? Object.freeze({ ...profile.specialistFollowUp }) : null,
    noProactiveBookingOrContact: Boolean(profile.conversationPreferences?.noProactiveBookingOrContact),
    consent: Object.freeze({ followUp: getConsentState({ user, history: user.history || [] }) || "unknown" }),
    agentFacts: Object.freeze(
      Object.fromEntries(Object.entries(profile.agentFacts || {}).map(([field, record]) => [field, record?.value ?? null]))
    )
  });
}

module.exports = { getConversationState };
