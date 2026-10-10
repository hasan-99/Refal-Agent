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
