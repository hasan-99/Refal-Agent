const assert = require("node:assert/strict");
const test = require("node:test");
const { buildConversationContext, buildCustomerTopicSummary, refreshCustomerTopicSummary, refreshCustomerTopicSummaryFromStore, safeMemoryText } = require("./conversationMemory");

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
    { message: "My email is hasan@example.com. Tell me about Refalco Group projects: https://example.com" },
    { message: "I need a meeting about the Cyprus project." }
  ]);

  assert.doesNotMatch(summary, /مرحبا|hasan@example\.com|https:\/\//i);
  assert.match(summary, /Refalco Group projects/);
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
  const user = { profile: { name: "Maya", serviceInterest: "projects" }, history: [{ message: "Tell me about Refalco Group" }] };
  let persisted;
  await refreshCustomerTopicSummary({
    store: { updateUser: async (_id, update) => { update(user); persisted = structuredClone(user.profile); } },
    userId: "customer-a",
    user,
    currentMessage: "Can we discuss the portfolio?",
    sourceTurnId: "11111111-1111-4111-8111-111111111111"
  });

  assert.equal(persisted.name, "Maya");
  assert.equal(persisted.serviceInterest, "projects");
  assert.match(persisted.conversationSummary, /portfolio/);
  assert.ok(persisted.conversationSummaryUpdatedAt);
  assert.equal(persisted.conversationSummarySourceTurnId, "11111111-1111-4111-8111-111111111111");
});

test("conversation memory removes residential addresses before summary and prompt context", () => {
  const history = [
    { message: "I have 3 children and we live at 18 Akrotiri Street." },
    { message: "عنوان منزلي هو شارع الزيتون 18، وأحتاج معلومات عن تأسيس شركة." },
    { message: "Μένω στην οδό Κύπρου 12 και θέλω να μάθω για σύσταση εταιρείας." }
  ];
  const summary = buildCustomerTopicSummary(history);
  const context = buildConversationContext({ profile: {}, history });
  assert.doesNotMatch(JSON.stringify({ summary, context }), /Akrotiri Street|شارع الزيتون 18|Κύπρου 12/u);
  assert.doesNotMatch(summary, /\[\[\[/u, "multilingual redaction markers should not nest");
  assert.match(summary, /children/iu);
  assert.match(summary, /εταιρεία/u);
});

test("address redaction preserves place names and non-residential Arabic address wording", () => {
  const ordinary = [
    "We work on Wall Street.",
    "عنوان المقال هو كيف نبدأ شركة في قبرص.",
    "عنوان المشروع: خطة التوسع في أوروبا."
  ];
  for (const text of ordinary) assert.equal(safeMemoryText(text), text);
});

test("address redaction still removes numbered residential addresses in English, Arabic and Greek", () => {
  const addresses = [
    ["I live at 18 Akrotiri Street.", /18 Akrotiri Street/u],
    ["عنوان السكن: شارع الزيتون 18، وأحتاج معلومات عن تأسيس شركة.", /شارع الزيتون 18/u],
    ["Μένω στην οδό Κύπρου 12 και θέλω να μάθω για σύσταση εταιρείας.", /Κύπρου 12/u]
  ];
  for (const [text, address] of addresses) {
    assert.doesNotMatch(safeMemoryText(text), address);
  }
});

test("post-turn summary refresh reads the persisted turn before writing its summary", async () => {
  const user = {
    profile: { name: "Maya" },
    history: [{ message: "Tell me about company formation." }]
  };
  let reads = 0;
  await refreshCustomerTopicSummaryFromStore({
    store: {
      getUser: async (id) => { assert.equal(id, "customer-a"); reads += 1; return user; },
      updateUser: async (id, update) => { assert.equal(id, "customer-a"); update(user); }
    },
    userId: "customer-a",
    currentMessage: "Can you explain the buying process?",
    sourceTurnId: "11111111-1111-4111-8111-111111111112"
  });

  assert.equal(reads, 1);
  assert.match(user.profile.conversationSummary, /company formation/);
  assert.match(user.profile.conversationSummary, /buying process/);
  assert.equal(user.profile.conversationSummarySourceTurnId, "11111111-1111-4111-8111-111111111112");
});
