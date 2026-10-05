const test = require("node:test");
const assert = require("node:assert/strict");
const { getConversationState } = require("./conversationState");

test("getConversationState projects the scattered profile fields into one shape without mutating the user object", () => {
  const user = {
    id: "whatsapp:1",
    history: [{
      message: "yes please",
      at: new Date().toISOString(),
      metadata: { specialistFollowUp: { consented: true, purpose: "specialist_follow_up" } }
    }],
    profile: {
      leadQualification: { score: 22, status: "hot" },
      opportunityIntake: { type: "company_formation", missing: ["activity"] },
      opportunityIntakes: { company_formation: { type: "company_formation" } },
      existingClientState: { state: "authenticated", authenticated: true, accountDisclosureAllowed: true },
      handover: { required: true, status: "open", department: "corporate_services" },
      specialistFollowUp: { consented: true, purpose: "specialist_follow_up" },
      conversationPreferences: { noProactiveBookingOrContact: true },
      agentFacts: { companyactivity: { value: "import/export", provenance: "customer_message" } }
    }
  };
  const before = JSON.stringify(user);

  const state = getConversationState(user);

  assert.equal(JSON.stringify(user), before, "getConversationState must never mutate its input");
  assert.equal(state.leadQualification.status, "hot");
  assert.equal(state.opportunityIntake.type, "company_formation");
  assert.equal(state.opportunityIntakes.company_formation.type, "company_formation");
  assert.equal(state.existingClient.authenticated, true);
  assert.equal(state.existingClient.accountDisclosureAllowed, true);
  assert.equal(state.handover.required, true);
  assert.equal(state.handover.department, "corporate_services");
  assert.equal(state.specialistFollowUp.purpose, "specialist_follow_up");
  assert.equal(state.noProactiveBookingOrContact, true);
  assert.equal(state.consent.followUp, "granted");
  assert.equal(state.agentFacts.companyactivity, "import/export");
});

test("getConversationState defaults safely for a brand-new contact with no profile yet", () => {
  const state = getConversationState({ id: "whatsapp:2" });
  assert.equal(state.leadQualification, null);
  assert.equal(state.opportunityIntake, null);
  assert.deepEqual(state.opportunityIntakes, {});
  assert.equal(state.existingClient.state, "unauthenticated");
  assert.equal(state.existingClient.authenticated, false);
  assert.equal(state.existingClient.accountDisclosureAllowed, false);
  assert.equal(state.handover.required, false);
  assert.equal(state.specialistFollowUp, null);
  assert.equal(state.noProactiveBookingOrContact, false);
  assert.equal(state.consent.followUp, "unknown");
  assert.deepEqual(state.agentFacts, {});
});

test("getConversationState returns a frozen, non-mutable view", () => {
  const state = getConversationState({ id: "whatsapp:3", profile: { handover: { required: true } } });
  assert.equal(Object.isFrozen(state), true);
  assert.equal(Object.isFrozen(state.handover), true);
  state.handover.required = false; // silently ignored in non-strict mode
  assert.equal(state.handover.required, true);
});

test("existingClient.accountDisclosureAllowed stays false for an unauthenticated or locked state, even if a stray field claims otherwise", () => {
  const locked = getConversationState({ id: "whatsapp:4", profile: { existingClientState: { state: "locked", authenticated: false, accountDisclosureAllowed: true } } });
  assert.equal(locked.existingClient.accountDisclosureAllowed, false, "canDiscloseAccountInformation requires state === authenticated, not just a stray flag");
});
