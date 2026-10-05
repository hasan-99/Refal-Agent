const test = require("node:test");
const assert = require("node:assert/strict");
const { TOOL_REGISTRY, searchApprovedKnowledge, getCustomerContext, saveCustomerFact, proposeHandover } = require("./agentTools");

test("searchApprovedKnowledge rejects an empty query without calling the store", async () => {
  let called = false;
  const store = { searchKnowledge: async () => { called = true; return []; } };
  const result = await searchApprovedKnowledge({ query: "   " }, { store });
  assert.equal(result.ok, false);
  assert.equal(result.status, "invalid_input");
  assert.equal(called, false);
});

test("searchApprovedKnowledge distinguishes no_evidence from found", async () => {
  const emptyStore = { searchKnowledge: async () => [] };
  const empty = await searchApprovedKnowledge({ query: "price of a company" }, { store: emptyStore, embedText: async () => null });
  assert.equal(empty.ok, true);
  assert.equal(empty.status, "no_evidence");
  assert.deepEqual(empty.data, []);

  const foundStore = { searchKnowledge: async () => [{ heading: "Company formation price", content: "...", source_name: "Services page" }] };
  const found = await searchApprovedKnowledge({ query: "price of a company" }, { store: foundStore, embedText: async () => [0.1] });
  assert.equal(found.ok, true);
  assert.equal(found.status, "found");
  assert.equal(found.data.length, 1);
  assert.deepEqual(found.userSafeSummary, ["Company formation price"]);
});

test("searchApprovedKnowledge distinguishes a real retrieval error from no evidence", async () => {
  const failingStore = { searchKnowledge: async () => { throw new Error("edge function down"); } };
  const result = await searchApprovedKnowledge({ query: "price" }, { store: failingStore, embedText: async () => null });
  assert.equal(result.ok, false);
  assert.equal(result.status, "error");
  assert.equal(result.reasonCode, "RETRIEVAL_FAILED");
});

test("searchApprovedKnowledge tolerates a broken local embedding pipeline", async () => {
  const store = { searchKnowledge: async (query, embedding) => { assert.equal(embedding, null); return [{ heading: "X" }]; } };
  const result = await searchApprovedKnowledge({ query: "price" }, { store, embedText: async () => { throw new Error("pipeline not loaded"); } });
  assert.equal(result.ok, true);
});

test("getCustomerContext never re-fetches the contact and only returns a safe subset", () => {
  const user = {
    id: "whatsapp:1",
    profile: {
      language: "english",
      agentFacts: { companyActivity: { value: "import/export", provenance: "customer_message" } },
      conversationPreferences: { noProactiveBookingOrContact: true },
      handover: { required: true },
      existingClientState: { authenticated: true },
      whatsappServiceSecret: "should-never-appear"
    },
    history: []
  };
  const result = getCustomerContext({}, { user });
  assert.equal(result.ok, true);
  assert.equal(result.data.knownFacts.companyActivity, "import/export");
  assert.equal(result.data.noProactiveBookingOrContact, true);
  assert.equal(result.data.hasOpenHandover, true);
  assert.equal(result.data.existingClientVerified, true);
  assert.equal(JSON.stringify(result.data).includes("should-never-appear"), false);
});

test("getCustomerContext fails predictably when no user was loaded", () => {
  const result = getCustomerContext({}, {});
  assert.equal(result.ok, false);
  assert.equal(result.status, "not_found");
});

test("saveCustomerFact only accepts customer_message provenance", async () => {
  const updates = [];
  const store = { updateUser: async (userId, updater) => { const draft = {}; await updater(draft); updates.push(draft); } };

  const modelGuess = await saveCustomerFact({ field: "companyActivity", value: "import/export", provenance: "model_inference" }, { store, userId: "u1" });
  assert.equal(modelGuess.ok, false);
  assert.equal(modelGuess.reasonCode, "INVALID_PROVENANCE");
  assert.equal(updates.length, 0);

  const real = await saveCustomerFact({ field: "companyActivity", value: "import/export", provenance: "customer_message" }, { store, userId: "u1" });
  assert.equal(real.ok, true);
  assert.equal(updates[0].profile.agentFacts.companyactivity.value, "import/export");
});

test("saveCustomerFact normalizes field-name casing so the same fact can't fragment into two keys", async () => {
  const draft = { profile: {} };
  const store = { updateUser: async (userId, updater) => { await updater(draft); } };

  await saveCustomerFact({ field: "companyActivity", value: "import/export", provenance: "customer_message" }, { store, userId: "u1" });
  const first = await saveCustomerFact({ field: "COMPANYACTIVITY", value: "real estate", provenance: "customer_message" }, { store, userId: "u1" });

  assert.equal(first.ok, true);
  assert.equal(first.data.field, "companyactivity");
  assert.equal(Object.keys(draft.profile.agentFacts).length, 1);
  assert.equal(draft.profile.agentFacts.companyactivity.value, "real estate");
});

test("saveCustomerFact rejects an invalid field name or an object value", async () => {
  const store = { updateUser: async () => { throw new Error("should not be called"); } };
  const badField = await saveCustomerFact({ field: "../../etc/passwd", value: "x", provenance: "customer_message" }, { store, userId: "u1" });
  assert.equal(badField.ok, false);
  assert.equal(badField.reasonCode, "INVALID_FIELD_NAME");

  const badValue = await saveCustomerFact({ field: "companyActivity", value: { nested: true }, provenance: "customer_message" }, { store, userId: "u1" });
  assert.equal(badValue.ok, false);
  assert.equal(badValue.reasonCode, "INVALID_VALUE");
});

test("proposeHandover refuses without granted consent and never persists", async () => {
  const user = { id: "whatsapp:1", profile: { name: "Rami" }, history: [{ message: "hello", at: new Date().toISOString() }] };
  const result = await proposeHandover({ reason: "construction tender" }, { user, intents: ["construction"] });
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, "CONSENT_REQUIRED");
});

test("proposeHandover authorizes and builds a summary once consent is granted, without writing to a store", async () => {
  // Consent is purpose-bound (see leadQualification.getConsentState): a bare
  // opt-in phrase alone is not enough, it must be tied to a tracked offer.
  const user = {
    id: "whatsapp:1",
    profile: { name: "Rami" },
    history: [{
      message: "yes please",
      at: new Date().toISOString(),
      metadata: { specialistFollowUp: { consented: true, purpose: "specialist_follow_up" } }
    }]
  };
  const result = await proposeHandover({ reason: "construction tender" }, { user, intents: ["construction"], language: "english" });
  assert.equal(result.ok, true);
  assert.equal(result.status, "authorized");
  assert.equal(result.data.summary.format, "REFAL LEAD SUMMARY");
});

test("the tool registry only exposes the explicit named tools", () => {
  // REFAL-AGENT-009 merged the two booking tools into this same registry
  // object; there must never be a second, competing registry.
  assert.deepEqual(Object.keys(TOOL_REGISTRY).sort(), ["getBookingAvailability", "getCustomerContext", "proposeHandover", "requestBookingAction", "saveCustomerFact", "searchApprovedKnowledge"]);
  for (const tool of Object.values(TOOL_REGISTRY)) {
    assert.equal(typeof tool.description, "string");
    assert.equal(typeof tool.run, "function");
  }
});
