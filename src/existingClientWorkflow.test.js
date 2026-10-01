const test = require("node:test");
const assert = require("node:assert/strict");
const { EVENTS, STATES, canDiscloseAccountInformation, initialExistingClientState, transitionExistingClientState } = require("./existingClientWorkflow");

test("existing-client authentication transitions require a trusted verification result", () => {
  let state = transitionExistingClientState(initialExistingClientState(), EVENTS.detect);
  assert.equal(state.state, STATES.awaiting_identifier);
  state = transitionExistingClientState(state, EVENTS.identifier_provided, { identifier: "client-123" });
  assert.equal(state.state, STATES.awaiting_verification);
  state = transitionExistingClientState(state, EVENTS.verification_passed, { verified: false });
  assert.equal(state.state, STATES.awaiting_verification);
  state = transitionExistingClientState(state, EVENTS.verification_passed, { verified: true });
  assert.equal(state.state, STATES.authenticated);
  assert.equal(canDiscloseAccountInformation(state), true);
});

test("three failed attempts lock the state and prevent account disclosure", () => {
  let state = transitionExistingClientState(initialExistingClientState(), EVENTS.detect);
  state = transitionExistingClientState(state, EVENTS.identifier_provided, { identifier: "client-123" });
  for (let i = 0; i < 3; i++) {
    state = transitionExistingClientState(state, EVENTS.verification_failed);
    if (i < 2) state = transitionExistingClientState(state, EVENTS.identifier_provided, { identifier: "client-123" });
  }
  assert.equal(state.state, STATES.locked);
  assert.equal(canDiscloseAccountInformation(state), false);
});
