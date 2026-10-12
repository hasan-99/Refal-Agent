const test = require("node:test");
const assert = require("node:assert/strict");
const { buildAgentContext } = require("./agentContext");
const { buildDecisionMessages } = require("./agentDecision");
const { runAgentTurnForContact } = require("./agentRuntime");
const { buildGroundingReviewMessages } = require("./semanticGrounding");
const { profile } = require("./companyProfile");

async function composeOffline(context, draft, inspectPrompt = () => {}) {
  return runAgentTurnForContact(context, {
    tools: {},
    decideNextStep: async ({ context: turnContext, observations, tools }) => {
      const messages = buildDecisionMessages(turnContext, observations, tools);
      inspectPrompt(messages, turnContext);
      return { type: "respond", text: draft };
    },
    assessDraft: async () => ({ valid: true, reasons: [], blockedClaims: [] })
  });
}

test("buildAgentContext only copies the explicit allowlisted fields, never a raw pass-through", () => {
  const context = buildAgentContext({
    currentMessage: "What is the price?",
    locale: "english",
    contact: { id: "whatsapp:123", name: "Rami", nameSource: "customer_stated", apiSecret: "should-never-appear" },
    recentConversation: [{ role: "user", content: "hi" }, { role: "system", content: "should be dropped" }],
    knownCustomerFacts: { companyActivity: "import/export" },
    consentState: "granted"
  });
  assert.equal(context.currentMessage, "What is the price?");
  assert.equal(context.contact.id, "whatsapp:123");
  assert.equal(context.contact.name, "Rami");
  assert.equal(context.contact.nameSource, "customer_stated");
  assert.equal(context.contact.apiSecret, undefined);
  assert.equal(context.recentConversation.length, 1);
  assert.equal(context.recentConversation[0].role, "user");
  assert.equal(context.knownCustomerFacts.companyActivity, "import/export");
  assert.equal(context.consentState, "granted");
});

test("buildAgentContext excludes contact labels without customer-stated provenance", () => {
  const context = buildAgentContext({ contact: { name: "Imported WhatsApp Label", nameSource: "contact_label" } });
  assert.equal(context.contact.name, null);
  assert.equal(context.contact.nameSource, null);
});

test("buildAgentContext permits only explicitly trusted honorifics and drops guessed titles", () => {
  const trusted = buildAgentContext({ contact: { name: "Sami", nameSource: "customer_stated", honorific: "أستاذ", honorificSource: "owner_configured" } });
  const guessed = buildAgentContext({ contact: { name: "Sami", nameSource: "customer_stated", honorific: "أستاذ", honorificSource: "contact_label" } });
  assert.equal(trusted.contact.honorific, "أستاذ");
  assert.equal(trusted.contact.honorificSource, "owner_configured");
  assert.equal(guessed.contact.honorific, null);
  assert.equal(guessed.contact.honorificSource, null);
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

test("a returning customer's first assistant reply can greet them and introduce configured identity", async () => {
  const context = buildAgentContext({
    currentMessage: "مرحبا",
    locale: "arabic",
    contact: { id: "offline-contact", name: "حسن", nameSource: "customer_stated" },
    recentConversation: []
  });
  const draft = "أهلاً حسن، أنا REFAL، مساعد الأعمال الرقمي لدى Refalco Group. كيف بقدر أساعدك؟";
  let prompt;
  const result = await composeOffline(context, draft, (messages) => { prompt = messages; });

  assert.equal(result.outcome, "responded");
  assert.equal(result.response, draft);
  assert.match(prompt[0].content, /first assistant response.*introduce your configured name, role and group/s);
  assert.match(prompt[1].content, /Explicit trusted customer name for natural address only.*حسن/u);
  assert.match(draft, new RegExp(profile.brand));
  assert.match(draft, new RegExp(profile.groupName));
});

test("later turns carry the introduction in history and continue without another greeting", async () => {
  const firstReply = "أهلاً حسن، أنا REFAL، مساعد الأعمال الرقمي لدى Refalco Group. كيف بقدر أساعدك؟";
  const context = buildAgentContext({
    currentMessage: "بدي أعرف عن تأسيس شركة بقبرص.",
    locale: "arabic",
    contact: { id: "offline-contact", name: "حسن", nameSource: "customer_stated" },
    recentConversation: [
      { role: "user", content: "مرحبا" },
      { role: "assistant", content: firstReply }
    ]
  });
  const draft = "أكيد، فيني أوضح لك المعلومات المعتمدة عن التأسيس. شو النشاط اللي عم تفكر فيه؟";
  let prompt;
  const result = await composeOffline(context, draft, (messages) => { prompt = messages; });
  const review = buildGroundingReviewMessages({ text: draft, context });
  const reviewerInput = JSON.parse(review[1].content);

  assert.equal(result.outcome, "responded");
  assert.equal(result.response, draft);
  assert.match(prompt[0].content, /later turns, continue directly.*without repeating your introduction or a generic opening greeting/s);
  assert.match(prompt[1].content, new RegExp(firstReply));
  assert.match(review[0].content, /ongoing conversation.*repeated self-introduction or generic opening greeting is a context issue/s);
  assert.equal(reviewerInput.history[1].content, firstReply);
  assert.doesNotMatch(result.response, /REFAL|Refalco Group|أهلاً حسن/u);
});

test("an explicit name correction in conversation context overrides the saved address name", async () => {
  const context = buildAgentContext({
    currentMessage: "What can we do next?",
    contact: { id: "offline-contact", name: "Sami", nameSource: "customer_stated" },
    recentConversation: [
      { role: "assistant", content: "I have you as Hasan." },
      { role: "user", content: "My name is Sami" }
    ]
  });
  const draft = "Thanks, Sami. What would you like to do next?";
  let prompt;
  await composeOffline(context, draft, (messages) => { prompt = messages; });
  const review = buildGroundingReviewMessages({ text: draft, context });
  const reviewerInput = JSON.parse(review[1].content);

  assert.match(prompt[1].content, /Explicit trusted customer name for natural address only.*Sami/u);
  assert.match(prompt[1].content, /customer: \[personal detail\]/u);
  assert.equal(reviewerInput.customerName, "Sami");
  assert.equal(reviewerInput.history[1].content, "[personal detail]");
  assert.match(prompt[0].content, /explicit correction override a saved name/);
  assert.match(prompt[0].content, /never guess a name, title or honorific/iu);
});

test("an explicitly configured Arabic honorific reaches generation and validation without being inferred", async () => {
  const context = buildAgentContext({
    currentMessage: "مرحبا",
    locale: "arabic",
    contact: { id: "offline-contact", name: "Sami", nameSource: "customer_stated", honorific: "أستاذ", honorificSource: "owner_configured" },
    recentConversation: [{ role: "user", content: "مرحبا" }]
  });
  const draft = "أكيد أستاذ سامي، كيف بقدر أساعدك؟";
  let prompt;
  const result = await composeOffline(context, draft, (messages) => { prompt = messages; });
  const review = buildGroundingReviewMessages({ text: draft, context });
  const reviewerInput = JSON.parse(review[1].content);
  assert.equal(result.response, draft);
  assert.match(prompt[1].content, /Explicit trusted customer honorific.*أستاذ/u);
  assert.match(prompt[0].content, /Use a title or honorific only when provided in the explicit trusted customer honorific field/u);
  assert.equal(reviewerInput.customerHonorific, "أستاذ");
  assert.match(review[0].content, /Use a title or honorific only when it is supplied in the explicit trusted honorific field/u);
});

test("needs discovery reflects the customer's problem, answers first, and asks one relevant question", async () => {
  const request = "I run a small company. Most enquiries arrive on WhatsApp and Instagram, and replies are often delayed. I am not sure where to start.";
  const context = buildAgentContext({
    currentMessage: request,
    locale: "english",
    contact: { id: "offline-contact", name: "Rami", nameSource: "customer_stated" },
    recentConversation: [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hello, I'm REFAL, Refalco Group's digital business agent. How can I help?" }
    ]
  });
  const draft = "The first useful step is to identify where the reply delays happen most. Which channel is the bigger problem today?";
  let prompt;
  const result = await composeOffline(context, draft, (messages) => { prompt = messages; });

  assert.equal(result.outcome, "responded");
  assert.equal(result.response, draft);
  assert.match(prompt[1].content, new RegExp(request));
  assert.match(prompt[0].content, /Answer the customer's question first/);
  assert.match(prompt[0].content, /Ask at most one question/);
  assert.equal((draft.match(/\?/gu) || []).length, 1);
  assert.match(draft, /reply delays/iu);
  assert.match(draft, /Which channel/iu);
});
