const STATES = Object.freeze({ unauthenticated: "unauthenticated", awaiting_identifier: "awaiting_identifier", awaiting_verification: "awaiting_verification", authenticated: "authenticated", failed: "failed", locked: "locked" });
const EVENTS = Object.freeze({ detect: "detect", identifier_provided: "identifier_provided", verification_requested: "verification_requested", verification_passed: "verification_passed", verification_failed: "verification_failed", reset: "reset", logout: "logout" });
const MAX_ATTEMPTS = 3;

function initialExistingClientState() { return { state: STATES.unauthenticated, attempts: 0, authenticated: false, accountDisclosureAllowed: false }; }

function beginExistingClientFlow() { return transitionExistingClientState(initialExistingClientState(), EVENTS.detect); }

function transitionExistingClientState(current = initialExistingClientState(), event, data = {}) {
  const state = { ...initialExistingClientState(), ...current };
  if (event === EVENTS.reset || event === EVENTS.logout) return initialExistingClientState();
  if (event === EVENTS.detect && [STATES.unauthenticated, STATES.failed].includes(state.state)) return { ...state, state: STATES.awaiting_identifier };
  if (event === EVENTS.identifier_provided && [STATES.awaiting_identifier, STATES.failed].includes(state.state) && String(data.identifier || "").trim()) return { ...state, state: STATES.awaiting_verification, identifierProvided: true };
  if (event === EVENTS.verification_requested && state.state === STATES.awaiting_identifier) return { ...state, state: STATES.awaiting_verification };
  if (event === EVENTS.verification_passed && state.state === STATES.awaiting_verification && data.verified === true) return { ...state, state: STATES.authenticated, authenticated: true, accountDisclosureAllowed: true, attempts: 0 };
  if (event === EVENTS.verification_failed && state.state === STATES.awaiting_verification) {
    const attempts = Number(state.attempts || 0) + 1;
    return { ...state, attempts, state: attempts >= MAX_ATTEMPTS ? STATES.locked : STATES.failed, authenticated: false, accountDisclosureAllowed: false };
  }
  return { ...state, authenticated: state.state === STATES.authenticated, accountDisclosureAllowed: state.state === STATES.authenticated };
}

function existingClientCustomerMessage(state) {
  if (state.state === STATES.authenticated) return "Your identity has been verified. I can now help with account-specific information.";
  if (state.state === STATES.locked) return "I couldn’t verify the details after several attempts. For your security, please contact the Refalco team through an approved channel.";
  return "To protect your privacy, please provide the approved identifier or verification detail for your existing client account. I can’t disclose account-specific information before verification.";
}

function canDiscloseAccountInformation(state) { return Boolean(state && state.state === STATES.authenticated && state.authenticated === true && state.accountDisclosureAllowed === true); }

function canDiscloseExistingClientDetails(state) { return canDiscloseAccountInformation(state); }

module.exports = { STATES, EVENTS, MAX_ATTEMPTS, initialExistingClientState, beginExistingClientFlow, transitionExistingClientState, existingClientCustomerMessage, canDiscloseAccountInformation, canDiscloseExistingClientDetails };
