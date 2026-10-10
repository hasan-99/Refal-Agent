const test = require("node:test");
const assert = require("node:assert/strict");
const { saveCustomerFact } = require("./agentTools");
const { getConversationState } = require("./conversationState");
const { runAgentTurnForContact } = require("./agentRuntime");

test("customer facts saved to a contact profile reach the live Agent pre-send gate", async () => {
  const user = { id: "contact-1", profile: {}, history: [] };
  const store = {
    updateUser: async (_id, update) => { await update(user); return user; }
  };
  const saved = await saveCustomerFact(
    { field: "countryOfResidence", value: "Jordan", provenance: "customer_message" },
    { store, userId: user.id }
  );
  assert.equal(saved.ok, true);

  // This is the same projection and argument passed by bot.js before the live
  // runAgentTurnForContact call. It intentionally contains only customer data.
  const knownCustomerFacts = getConversationState(user).agentFacts;
  assert.deepEqual(knownCustomerFacts, { countryofresidence: "Jordan" });
  // saveCustomerFact canonicalizes keys to lower case. The question matcher
  // accepts the canonical key and does not require an extra database read.
  let decisionIndex = 0;
  const decisions = [
    { type: "clarify", text: "Which country do you live in?" },
    { type: "respond", text: "Let's continue with the next steps for your request." }
  ];
  const result = await runAgentTurnForContact({
    currentMessage: "Please explain the next steps.",
    locale: "english",
    user,
    userId: user.id,
    store,
    knownCustomerFacts,
    intents: [],
    language: "english"
  }, { decideNextStep: async () => decisions[Math.min(decisionIndex++, 1)] });

  assert.equal(result.outcome, "responded");
  assert.equal(result.steps[0].result.reasonCode, "never_reask:countryOfResidence");
  assert.equal(decisionIndex, 2);
});
