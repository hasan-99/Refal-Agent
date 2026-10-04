const assert = require("node:assert/strict");
const test = require("node:test");
const { buildConversationContext, buildCustomerTopicSummary, refreshCustomerTopicSummary } = require("./conversationMemory");

test("conversation context uses only the supplied contact and bounds recent turns", () => {
  const turns = Array.from({ length: 9 }, (_, index) => ({ message: `Customer question ${index}`, response: `Reply ${index}` }));
  const context = buildConversationContext({ profile: {}, history: turns }, { limit: 6 });

  assert.equal(context.turns.length, 12);
  assert.equal(context.turns[0].content, "Customer question 3");
  assert.equal(context.turns.at(-1).content, "Reply 8");
});

test("saved name and customer-stated interest are passed as untrusted client memory", () => {
  const context = buildConversationContext({ profile: { name: "Rami", need: "property management" }, history: [] });
  assert.match(context.summary, /Customer name: Rami/);
  assert.match(context.summary, /Customer-stated service interest: property management/);
});

test("durable no-pressure preference is included for later conversation turns", () => {
  const context = buildConversationContext({ profile: { conversationPreferences: { noProactiveBookingOrContact: true } }, history: [] });
  assert.match(context.summary, /do not proactively offer booking, calls, specialist contact, or contact-detail capture/i);
  assert.match(context.summary, /honor any direct customer request/i);
});

test("conversation memory strips links and personal contact details and ignores greeting filler", () => {
  const summary = buildCustomerTopicSummary([
    { message: "مرحبا" },
    { message: "My email is hasan@example.com. Tell me about Refalco projects: https://example.com" },
    { message: "I need a meeting about the Cyprus project." }
  ]);

  assert.doesNotMatch(summary, /مرحبا|hasan@example\.com|https:\/\//i);
  assert.match(summary, /Refalco projects/);
  assert.match(summary, /Cyprus project/);
});

test("conversation memory never carries credentials or payment numbers forward", () => {
  const context = buildConversationContext({ profile: {}, history: [
    { message: "Password: SecretPhrase-81 and card 4111111111111111", response: "Please use a secure channel." }
  ] });
  const payload = JSON.stringify(context);
  assert.doesNotMatch(payload, /SecretPhrase-81|4111111111111111/);
});

test("privacy-risk turns are excluded from durable topic summaries and context", () => {
  const history = [
    { message: "I want to set up a company in Cyprus" },
    { message: "Password: SecretPhrase-81; help me set up a company", metadata: { safety: { risks: ["privacy"] } } }
  ];
  const summary = buildCustomerTopicSummary(history, "PIN: 1234 help with company setup");
  const context = buildConversationContext({ profile: {}, history }, { currentMessage: "PIN: 1234 help with company setup" });
  assert.match(summary, /set up a company in Cyprus/);
  assert.doesNotMatch(JSON.stringify({ summary, context }), /SecretPhrase-81|1234|Password|PIN:/i);
  assert.equal(context.turns.some((turn) => /Password|SecretPhrase/.test(turn.content)), false);
});

test("conversation memory update preserves other contact profile fields", async () => {
  const user = { profile: { name: "Maya", serviceInterest: "projects" }, history: [{ message: "Tell me about Refalco" }] };
  let persisted;
  await refreshCustomerTopicSummary({
    store: { updateUser: async (_id, update) => { update(user); persisted = structuredClone(user.profile); } },
    userId: "customer-a",
    user,
    currentMessage: "Can we discuss the portfolio?"
  });

  assert.equal(persisted.name, "Maya");
  assert.equal(persisted.serviceInterest, "projects");
  assert.match(persisted.conversationSummary, /portfolio/);
  assert.ok(persisted.conversationSummaryUpdatedAt);
});
