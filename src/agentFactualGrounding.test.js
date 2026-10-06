// REFAL-AGENT-028 — integration coverage for the factual-grounding gate
// wired into the real Agent loop (src/agentLoop.js) via the real
// TOOL_REGISTRY's searchApprovedKnowledge tool (same real chain
// src/agentRagEvidence.test.js uses for Ticket 027). Unit-level coverage for
// each individual check lives in src/groundingPolicy.test.js; this file
// proves the gate actually fires inside runAgentTurn, drives the existing
// Ticket 005 retry/correction behavior, and is not weaker than legacy for an
// equivalent claim/evidence case.

const test = require("node:test");
const assert = require("node:assert/strict");
const { runAgentTurn } = require("./agentLoop");
const { TOOL_REGISTRY } = require("./agentTools");
const { buildAgentContext } = require("./agentContext");
const { containsUnsupportedPackageInclusion } = require("./groundingPolicy");

function scriptedDecider(decisions) {
  let index = 0;
  return async () => decisions[Math.min(index++, decisions.length - 1)];
}

function storeWith(content) {
  return { searchKnowledge: async () => [{ heading: "Approved information", content }] };
}

const EVIDENCE_TEXT = "REFALCO provides Company Formation for EUR 1500. Accounting services are also available.";

// --- Important Integration Test (ticket-required, cases A/B/C) -------------

test("Important Integration Test — Case A: a response that only restates grounded facts is allowed", async () => {
  const context = buildAgentContext({ currentMessage: "What services do you provide and how much does company formation cost?", locale: "english" });
  const decide = scriptedDecider([
    { type: "tool", tool: "searchApprovedKnowledge", args: { query: "services and company formation price" } },
    { type: "respond", text: "REFALCO offers Company Formation for EUR 1500 and Accounting services." }
  ]);
  const result = await runAgentTurn(context, { decideNextStep: decide, tools: TOOL_REGISTRY, toolContext: { store: storeWith(EVIDENCE_TEXT), embedText: async () => null } });
  assert.equal(result.outcome, "responded");
  assert.equal(result.response, "REFALCO offers Company Formation for EUR 1500 and Accounting services.");
});

test("Important Integration Test — Case B: an unsupported price (EUR 2500 vs evidence's EUR 1500) is rejected, never sent, and the turn safely falls back", async () => {
  const context = buildAgentContext({ currentMessage: "What services do you provide and how much does company formation cost?", locale: "english" });
  // Every respond attempt after the tool call repeats the same unsupported
  // price — proves the gate rejects it every time, not just once, and the
  // turn ends in a safe deterministic fallback rather than ever sending it.
  const decide = scriptedDecider([
    { type: "tool", tool: "searchApprovedKnowledge", args: { query: "services and company formation price" } },
    { type: "respond", text: "REFALCO offers Company Formation for EUR 2500 and Accounting services." }
  ]);
  const result = await runAgentTurn(context, { decideNextStep: decide, tools: TOOL_REGISTRY, toolContext: { store: storeWith(EVIDENCE_TEXT), embedText: async () => null }, maxSteps: 2 });
  assert.notEqual(result.outcome, "responded");
  assert.equal(result.outcome, "response_rejected");
  assert.match(result.reason, /unsupported_price_claim/);
  assert.equal(typeof result.response, "string");
  assert.notEqual(result.response, "REFALCO offers Company Formation for EUR 2500 and Accounting services.");
});

test("Important Integration Test — Case C: unsupported added services (Payroll, Legal Representation) are rejected; a corrected second draft without them succeeds (tests 15/16/26/27)", async () => {
  const context = buildAgentContext({ currentMessage: "What services do you provide and how much does company formation cost?", locale: "english" });
  const decide = scriptedDecider([
    { type: "tool", tool: "searchApprovedKnowledge", args: { query: "services and company formation price" } },
    // Step 2: supported price + an unsupported service addition — must be rejected (test 15).
    { type: "respond", text: "REFALCO offers Company Formation for EUR 1500, Accounting, Payroll and Legal Representation." },
    // Step 3: the corrected draft drops the unsupported items — must succeed (test 16/27).
    { type: "respond", text: "REFALCO offers Company Formation for EUR 1500 and Accounting services." }
  ]);
  const result = await runAgentTurn(context, { decideNextStep: decide, tools: TOOL_REGISTRY, toolContext: { store: storeWith(EVIDENCE_TEXT), embedText: async () => null }, maxSteps: 3 });
  assert.equal(result.outcome, "responded");
  assert.equal(result.response, "REFALCO offers Company Formation for EUR 1500 and Accounting services.");
  assert.equal(result.stepCount, 3);
  // Test 26: the rejection became a structured observation the retried
  // decision could see, not a silent edit or a thrown error.
  const rejectionStep = result.steps.find((step) => step.tool === "responsePolicyCheck");
  assert.ok(rejectionStep, "expected a responsePolicyCheck rejection observation between the bad draft and the corrected one");
  assert.match(rejectionStep.result.reasonCode, /unsupported_package_claim/);
});

// --- NO EVIDENCE (required tests 17/18) -------------------------------------

test("[028-17] no_evidence: an invented company fact is rejected, never sent", async () => {
  const context = buildAgentContext({ currentMessage: "What services do you provide?", locale: "english" });
  const decide = scriptedDecider([
    { type: "tool", tool: "searchApprovedKnowledge", args: { query: "services" } },
    { type: "respond", text: "REFALCO offers Company Formation for EUR 1500 and Accounting services." }
  ]);
  const result = await runAgentTurn(context, { decideNextStep: decide, tools: TOOL_REGISTRY, toolContext: { store: { searchKnowledge: async () => [] }, embedText: async () => null }, maxSteps: 2 });
  assert.notEqual(result.outcome, "responded");
  assert.match(result.reason, /unsupported/);
});

test("[028-18] no_evidence: a safe uncertainty response is allowed", async () => {
  const context = buildAgentContext({ currentMessage: "Do you offer cryptocurrency custody services?", locale: "english" });
  const decide = scriptedDecider([
    { type: "tool", tool: "searchApprovedKnowledge", args: { query: "cryptocurrency custody" } },
    { type: "respond", text: "I don't have approved information confirming that service. I can check with the team if useful." }
  ]);
  const result = await runAgentTurn(context, { decideNextStep: decide, tools: TOOL_REGISTRY, toolContext: { store: { searchKnowledge: async () => [] }, embedText: async () => null } });
  assert.equal(result.outcome, "responded");
});

// --- AGENT RECOVERY (required test 28) --------------------------------------

test("[028-28] a draft that never becomes grounded within the step budget ends in the generic safe fallback, not silence or a crash", async () => {
  const context = buildAgentContext({ currentMessage: "What services do you provide?", locale: "english" });
  const alwaysUnsupported = async () => ({ type: "respond", text: "REFALCO offers Company Formation for EUR 1500, Accounting, Payroll and Legal Representation." });
  const decide = scriptedDecider([{ type: "tool", tool: "searchApprovedKnowledge", args: { query: "services" } }]);
  let callCount = 0;
  const combinedDecide = async (args) => {
    callCount += 1;
    return callCount === 1 ? decide() : alwaysUnsupported();
  };
  const result = await runAgentTurn(context, { decideNextStep: combinedDecide, tools: TOOL_REGISTRY, toolContext: { store: storeWith(EVIDENCE_TEXT), embedText: async () => null }, maxSteps: 3 });
  assert.equal(result.outcome, "response_rejected");
  assert.equal(typeof result.response, "string");
  assert.notEqual(result.response, "");
  assert.doesNotMatch(result.response, /Payroll|Legal Representation/);
});

// --- LEGACY REGRESSION (required test 30) -----------------------------------

test("[028-30] Agent-path factual safety is not weaker than legacy for an equivalent claim/evidence case", async () => {
  const claim = "The €999 package includes document preparation, name reservation, and application follow-up.";
  const legacyEvidence = [{ content: "The €999 package covers four months of company secretary and registered address." }];
  // Legacy (src/ai.js, via the moved, unchanged containsUnsupportedPackageInclusion) already rejects this.
  assert.equal(containsUnsupportedPackageInclusion(claim, legacyEvidence), true);

  // The Agent path, given the identical claim and equivalent evidence, must reject it too.
  const context = buildAgentContext({ currentMessage: "What does the €999 package include?", locale: "english" });
  const decide = scriptedDecider([
    { type: "tool", tool: "searchApprovedKnowledge", args: { query: "999 package" } },
    { type: "respond", text: claim }
  ]);
  const result = await runAgentTurn(context, { decideNextStep: decide, tools: TOOL_REGISTRY, toolContext: { store: storeWith(legacyEvidence[0].content), embedText: async () => null }, maxSteps: 2 });
  assert.notEqual(result.outcome, "responded");
  assert.match(result.reason, /unsupported_package_claim/);
});
