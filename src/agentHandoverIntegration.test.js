// REFAL-AGENT-008 — handover tool integration.
//
// proposeHandover (agentTools.js, Ticket 001) only ever checks authorization
// and builds an unpersisted payload — it never calls store.createHandover.
// Real persistence stays exactly where it already happens today
// (messageRouter.js's recordHistory), and this agent path is not wired into
// that yet (Tickets 010/017). That means EVERY respond/clarify draft this
// loop can currently produce after calling proposeHandover is describing an
// action that has NOT actually been persisted — so the deterministic output
// gate (responsePolicy's unconsentedContactCommitment / unverifiedHandoverAction
// checks, already wired into agentLoop.js with no opt-out) must block any
// draft that claims otherwise, in both the denied and authorized cases.
// These tests prove that boundary holds for the real tool + real loop
// wired together, not just each piece in isolation.

const test = require("node:test");
const assert = require("node:assert/strict");
const { runAgentTurn } = require("./agentLoop");
const { TOOL_REGISTRY } = require("./agentTools");

function scriptedDecider(decisions) {
  let index = 0;
  return async () => decisions[Math.min(index++, decisions.length - 1)];
}

const CONTEXT = { currentMessage: "Can someone review my case?", locale: "english" };

test("without consent, proposeHandover returns not_authorized and a completed-action claim built on top of it is rejected, not delivered", async () => {
  const user = { id: "whatsapp:1", profile: { name: "Rami" }, history: [{ message: "please review my case", at: new Date().toISOString() }] };
  const decide = scriptedDecider([
    { type: "tool", tool: "proposeHandover", args: { reason: "construction tender" } },
    // A model might (wrongly) assume the tool call itself means it can now
    // claim the action happened — this must still be rejected.
    { type: "respond", text: "I've asked a specialist to review your case and they will contact you shortly." }
  ]);

  const result = await runAgentTurn(CONTEXT, { decideNextStep: decide, tools: TOOL_REGISTRY, toolContext: { user, intents: ["construction"] }, maxSteps: 4 });

  assert.equal(result.steps[0].tool, "proposeHandover");
  assert.equal(result.steps[0].result.ok, false);
  assert.equal(result.steps[0].result.reasonCode, "CONSENT_REQUIRED");
  // The loop must not have delivered the completed-action claim as the final response.
  assert.notEqual(result.outcome, "responded");
  assert.ok(["response_rejected", "invalid_decision"].includes(result.outcome) || result.response !== "I've asked a specialist to review your case and they will contact you shortly.");
});

test("with consent granted, proposeHandover authorizes a payload, but the Agent still cannot claim the handover already happened (nothing has been persisted yet)", async () => {
  const user = {
    id: "whatsapp:1",
    profile: { name: "Rami" },
    history: [{
      message: "yes please",
      at: new Date().toISOString(),
      metadata: { specialistFollowUp: { consented: true, purpose: "specialist_follow_up" } }
    }]
  };
  const decide = scriptedDecider([
    { type: "tool", tool: "proposeHandover", args: { reason: "construction tender" } },
    { type: "respond", text: "I've logged your request and a specialist will contact you." }
  ]);

  const result = await runAgentTurn(CONTEXT, { decideNextStep: decide, tools: TOOL_REGISTRY, toolContext: { user, intents: ["construction"] }, maxSteps: 4 });

  assert.equal(result.steps[0].result.ok, true);
  assert.equal(result.steps[0].result.status, "authorized");
  // Authorized-but-not-yet-persisted must still not reach the customer as a completed action.
  assert.notEqual(result.response, "I've logged your request and a specialist will contact you.");
});

test("with consent granted, a correctly-scoped offer (not a completed-action claim) is allowed through", async () => {
  const user = {
    id: "whatsapp:1",
    profile: { name: "Rami" },
    history: [{
      message: "yes please",
      at: new Date().toISOString(),
      metadata: { specialistFollowUp: { consented: true, purpose: "specialist_follow_up" } }
    }]
  };
  const decide = scriptedDecider([
    { type: "tool", tool: "proposeHandover", args: { reason: "construction tender" } },
    { type: "respond", text: "A specialist can review your construction tender case." }
  ]);

  const result = await runAgentTurn(CONTEXT, { decideNextStep: decide, tools: TOOL_REGISTRY, toolContext: { user, intents: ["construction"] }, maxSteps: 4 });

  assert.equal(result.outcome, "responded");
  assert.equal(result.response, "A specialist can review your construction tender case.");
});

test("proposeHandover never calls store.createHandover itself — persistence stays exactly where it already happens today", async () => {
  let createHandoverCalled = false;
  const store = { createHandover: async () => { createHandoverCalled = true; } };
  const user = {
    id: "whatsapp:1",
    profile: { name: "Rami" },
    history: [{
      message: "yes please",
      at: new Date().toISOString(),
      metadata: { specialistFollowUp: { consented: true, purpose: "specialist_follow_up" } }
    }]
  };
  const decide = scriptedDecider([{ type: "tool", tool: "proposeHandover", args: { reason: "construction tender" } }]);

  await runAgentTurn(CONTEXT, { decideNextStep: decide, tools: TOOL_REGISTRY, toolContext: { user, store, intents: ["construction"] }, maxSteps: 1 });

  assert.equal(createHandoverCalled, false, "this agent path must not open a second, less-audited write path for handovers");
});
