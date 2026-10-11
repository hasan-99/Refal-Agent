const test = require("node:test");
const assert = require("node:assert/strict");
const { saveCustomerFact } = require("./agentTools");
const { getConversationState } = require("./conversationState");
const { runAgentTurnForContact } = require("../scripts/helpers/scriptedGrounding");

test("customer facts saved to a contact profile reach the live Agent pre-send gate", async () => {
  const user = { id: "contact-1", profile: {}, history: [] };
  const store = {
    updateUser: async (_id, update) => { await update(user); return user; }
  };
  const saved = await saveCustomerFact(
    { field: "countryOfResidence", value: "Jordan", provenance: "customer_message" },
    { store, userId: user.id, currentMessage: "I live in Jordan.", sourceTurnId: "turn-1" }
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

test("postposed negation cannot persist as customer CRM memory", async () => {
  for (const [message, value, sourceTurnId] of [
    ["Jordan is not where I live.", "Jordan", "turn-negative-en"],
    ["الأردن مش بلد إقامتي.", "الأردن", "turn-negative-ar"]
  ]) {
    const user = { id: "contact-1", profile: {}, history: [] };
    const store = { updateUser: async (_id, update) => { await update(user); return user; } };
    const result = await saveCustomerFact(
      { field: "countryOfResidence", value, provenance: "customer_message" },
      { store, userId: user.id, currentMessage: message, sourceTurnId }
    );
    assert.equal(result.status, "not_authorized", message);
    assert.equal(result.reasonCode, "NON_AFFIRMATIVE_CUSTOMER_VALUE", message);
    assert.deepEqual(user.profile.agentFacts || {}, {}, message);
  }
});

test("affirmative not-only contrasts can be stored as customer CRM memory", async () => {
  for (const [message, value, sourceTurnId] of [
    ["Not only Jordan, but Cyprus too.", "Jordan", "turn-contrast-en"],
    ["ليس فقط الأردن، بل قبرص أيضًا.", "الأردن", "turn-contrast-ar"]
  ]) {
    const user = { id: "contact-1", profile: {}, history: [] };
    const store = { updateUser: async (_id, update) => { await update(user); return user; } };
    const result = await saveCustomerFact(
      { field: "countryOfResidence", value, provenance: "customer_message" },
      { store, userId: user.id, currentMessage: message, sourceTurnId }
    );
    assert.equal(result.status, "saved", message);
    assert.equal(user.profile.agentFacts.countryofresidence.value, value);
  }
});

test("Arabic diacritics and compatibility forms remain extractable on the CRM save path", async () => {
  for (const [message, expectedRaw, value, sourceTurnId] of [
    ["أقيم في الأُرْدُنّ", "الأُرْدُنّ", "الأردن", "turn-diacritics"],
    ["I live in Ｊｏｒｄａｎ", "Ｊｏｒｄａｎ", "Jordan", "turn-compatibility"]
  ]) {
    const user = { id: "contact-1", profile: {}, history: [] };
    const store = { updateUser: async (_id, update) => { await update(user); return user; } };
    const result = await saveCustomerFact(
      { field: "countryOfResidence", value, provenance: "customer_message" },
      { store, userId: user.id, currentMessage: message, sourceTurnId }
    );
    assert.equal(result.status, "saved", message);
    assert.equal(user.profile.agentFacts.countryofresidence.rawValue, expectedRaw);
  }
});

test("durable CRM facts rehydrated after resume remain available to the never-reask gate", async () => {
  const { crmRowToAgentFacts } = await import("../supabase/functions/rafa-agent-api/crmLeadProfile.mjs");
  const restored = crmRowToAgentFacts({
    identity_fields: { countryOfResidence: { rawValue: "JORDAN", normalizedValue: "JORDAN" } },
    opportunity_fields: { businessActivity: { rawValue: "online   retail", normalizedValue: "online retail" } },
    property_residency_fields: {}, qualification_fields: {},
    field_provenance: {
      countryOfResidence: { source: "customer_message", source_turn_id: "turn-old-1", captured_at: "2026-10-10T10:00:00Z", confidence: 1 },
      businessActivity: { source: "customer_message", source_turn_id: "turn-old-2", captured_at: "2026-10-10T10:05:00Z", confidence: 1 }
    },
    crm_correction_needed: {}
  });
  // New process/contact load: only the durable row is used to rebuild memory.
  const user = { id: "contact-1", profile: { ...restored }, history: [] };
  assert.equal(user.profile.agentFacts.countryofresidence.rawValue, "JORDAN");
  assert.equal(user.profile.agentFacts.businessactivity.sourceTurnId, "turn-old-2");
  const knownCustomerFacts = getConversationState(user).agentFacts;
  let decisionIndex = 0;
  const decisions = [
    { type: "clarify", text: "Where do you live?" },
    { type: "clarify", text: "What is your business activity?" },
    { type: "respond", text: "Thanks. I have both details and can continue." }
  ];
  const result = await runAgentTurnForContact({
    currentMessage: "What should I share next?", locale: "english", user, userId: user.id,
    store: { updateUser: async (_id, update) => { await update(user); return user; } },
    knownCustomerFacts, intents: [], language: "english"
  }, { decideNextStep: async () => decisions[Math.min(decisionIndex++, decisions.length - 1)] });
  assert.equal(result.outcome, "responded");
  assert.equal(result.steps[0].result.reasonCode, "never_reask:countryOfResidence");
  assert.equal(result.steps[1].result.reasonCode, "never_reask:businessActivity");
  assert.equal(decisionIndex, 3);
});
