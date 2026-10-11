const test = require("node:test");
const assert = require("node:assert/strict");
const { buildAgentContext } = require("./agentContext");

test("buildAgentContext only copies the explicit allowlisted fields, never a raw pass-through", () => {
  const context = buildAgentContext({
    currentMessage: "What is the price?",
    locale: "english",
    contact: { id: "whatsapp:123", name: "Rami", apiSecret: "should-never-appear" },
    recentConversation: [{ role: "user", content: "hi" }, { role: "system", content: "should be dropped" }],
    knownCustomerFacts: { companyActivity: "import/export" },
    consentState: "granted"
  });
  assert.equal(context.currentMessage, "What is the price?");
  assert.equal(context.contact.id, "whatsapp:123");
  assert.equal(context.contact.name, "Rami");
  assert.equal(context.contact.apiSecret, undefined);
  assert.equal(context.recentConversation.length, 1);
  assert.equal(context.recentConversation[0].role, "user");
  assert.equal(context.knownCustomerFacts.companyActivity, "import/export");
  assert.equal(context.consentState, "granted");
});

test("buildAgentContext is defensive against missing/garbage input", () => {
  const context = buildAgentContext();
  assert.equal(context.currentMessage, "");
  assert.equal(context.locale, "unknown");
  assert.deepEqual(context.recentConversation, []);
  assert.equal(context.currentOpenQuestion, null);
  assert.equal(context.consentState, "unknown");
});

test("the full twelve-turn window reaches both generation and validation", () => {
  const { buildDecisionMessages } = require("./agentDecision");
  const { buildGroundingReviewMessages } = require("./semanticGrounding");
  const { MAX_PROMPT_TOKEN_CEILING, promptTokenUpperBound } = require("./promptBudget");
  const exclusion = "I only want company formation; I am not interested in investment or property.";
  const history = Array.from({ length: 24 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `conversation message ${index}`
  }));
  history[2] = { role: "user", content: exclusion };
  const context = buildAgentContext({ currentMessage: "What support continues after formation?", recentConversation: history });

  assert.equal(context.recentConversation.length, 24);
  assert.ok(context.recentConversation.some((turn) => turn.content === exclusion));
  const decision = buildDecisionMessages(context);
  assert.ok(decision.some((message) => message.content.includes(exclusion)));
  assert.ok(promptTokenUpperBound(decision) < MAX_PROMPT_TOKEN_CEILING - 3000);
  const review = buildGroundingReviewMessages({ text: "A supported answer.", context });
  assert.ok(JSON.parse(review[1].content).history.some((turn) => turn.content === exclusion));
});

test("buildAgentContext returns a frozen object that cannot be mutated downstream", () => {
  const context = buildAgentContext({ currentMessage: "hi" });
  assert.equal(Object.isFrozen(context), true);
  context.currentMessage = "tampered"; // silently ignored in non-strict mode
  assert.equal(context.currentMessage, "hi");
});

test("qualification tier and buying-signal IDs are allowlisted in Agent context", () => {
  const context = buildAgentContext({
    leadTier: "hot",
    buyingSignals: [{ id: "MB-B4" }, { id: "customer-controlled" }, { id: "MB-B4" }]
  });
  assert.equal(context.leadTier, "hot");
  assert.deepEqual(context.buyingSignals, ["MB-B4"]);
  assert.equal(Object.isFrozen(context.buyingSignals), true);
  assert.equal(buildAgentContext({ leadTier: "superuser", buyingSignals: ["MB-B7"] }).leadTier, "");
});
