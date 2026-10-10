const test = require("node:test");
const assert = require("node:assert/strict");
const { runAgentTurnForContact, buildToolContext } = require("./agentRuntime");
const { INTENTS } = require("./intent");

function scriptedDecider(decisions) {
  let index = 0;
  return async () => decisions[Math.min(index++, decisions.length - 1)];
}

test("buildToolContext binds the real embedText/embeddingModel defaults when the caller doesn't override them", () => {
  const ctx = buildToolContext({ store: {}, user: {}, userId: "u1" });
  assert.equal(typeof ctx.embedText, "function");
  assert.equal(typeof ctx.embeddingModel, "string");
  assert.equal(ctx.matchCount, 6);
});

test("buildToolContext passes trusted M4 contact, source-turn, consent, language, and capability context", () => {
  const ctx = buildToolContext({
    store: {}, user: {}, userId: "contact-1", inboundMessageId: "wa-provider-turn-9", sourceTurnId: "persisted-turn-uuid",
    language: "arabic", consentState: "granted", allowedCapabilities: ["upsertLead", "scheduleFollowUp"]
  });
  assert.equal(ctx.sourceTurnId, "persisted-turn-uuid");
  assert.equal(ctx.inboundMessageId, "wa-provider-turn-9");
  assert.equal(ctx.userId, "contact-1");
  assert.equal(ctx.consentState, "granted");
  assert.equal(ctx.language, "arabic");
  assert.deepEqual(ctx.allowedCapabilities, ["upsertLead", "scheduleFollowUp"]);
  assert.equal(Object.isFrozen(ctx.allowedCapabilities), true);
});

test("RAG is never invoked when the Agent's decision never asks for it (e.g. a simple acknowledgement)", async () => {
  let searchCalls = 0;
  const store = { searchKnowledge: async () => { searchCalls += 1; return []; } };
  const decide = scriptedDecider([{ type: "respond", text: "You're welcome, happy to help anytime." }]);

  const result = await runAgentTurnForContact(
    { currentMessage: "thank you", locale: "english", store, user: { id: "u1" }, userId: "u1" },
    { decideNextStep: decide }
  );

  assert.equal(result.outcome, "responded");
  assert.equal(searchCalls, 0, "a plain acknowledgement must never trigger a knowledge search");
});

test("factual services intents retrieve approved knowledge before the model decides, even if it tries to answer immediately", async () => {
  let searchCalls = 0;
  let observationsSeenByModel = null;
  const store = {
    searchKnowledge: async (query) => {
      searchCalls += 1;
      assert.match(query, /^What services do you offer\?/);
      assert.match(query, /company formation and structuring/);
      assert.match(query, /العقار والتطوير/u);
      return [{ heading: "Company formation", content: "We provide company formation support." }];
    }
  };
  const decide = async ({ observations }) => {
    observationsSeenByModel = observations;
    return { type: "respond", text: "We provide company formation support." };
  };

  const result = await runAgentTurnForContact({
    currentMessage: "What services do you offer?",
    locale: "english",
    store,
    user: { id: "u1" },
    userId: "u1",
    intents: [INTENTS.SERVICES],
    embedText: async () => [1]
  }, { decideNextStep: decide });

  assert.equal(searchCalls, 1);
  assert.equal(observationsSeenByModel[0].tool, "searchApprovedKnowledge");
  assert.equal(observationsSeenByModel[0].result.modelObservation.status, "found");
  assert.equal(result.outcome, "responded");
  assert.equal(result.response, "We provide company formation support. Which area would you like to hear more about?");
  assert.deepEqual(result.toolsUsed, ["searchApprovedKnowledge"]);
});

test("broad Arabic service answers get one neutral next question, while focused requests keep their answer", async () => {
  const { appendBroadServiceFollowup } = require("./agentRuntime");
  const broad = appendBroadServiceFollowup(
    { outcome: "responded", response: "خدماتنا تشمل تأسيس الشركات والعقار." },
    { intents: [INTENTS.SERVICES], locale: "arabic", currentMessage: "شو هي خدماتكم؟" }
  );
  assert.equal(broad.response, "خدماتنا تشمل تأسيس الشركات والعقار. أي مجال حابب تعرف عنه أكثر؟");
  const alreadyInteractive = appendBroadServiceFollowup(
    { outcome: "responded", response: "خدماتنا تشمل تأسيس الشركات. أي مجال يهمك؟" },
    { intents: [INTENTS.SERVICES], locale: "arabic", currentMessage: "شو هي خدماتكم؟" }
  );
  assert.equal(alreadyInteractive.response, "خدماتنا تشمل تأسيس الشركات. أي مجال يهمك؟");
  const focused = appendBroadServiceFollowup(
    { outcome: "responded", response: "Company formation is one of our services." },
    { intents: [INTENTS.SERVICES, INTENTS.COMPANY_FORMATION], locale: "english", currentMessage: "Do you offer company formation?" }
  );
  assert.equal(focused.response, "Company formation is one of our services.");
});

test("a real end-to-end turn: decide calls searchApprovedKnowledge, the real tool reaches the injected embedText and store, and the answer is grounded in the returned evidence", async () => {
  let searchArgs = null;
  const store = {
    searchKnowledge: async (query, embedding, embeddingModel, matchCount) => {
      searchArgs = { query, embedding, embeddingModel, matchCount };
      return [{ heading: "Company formation price", content: "The published company formation price is EUR 1500." }];
    }
  };
  const fakeEmbedText = async (text) => [text.length]; // deterministic stand-in, no real transformer pipeline in a unit test

  const decide = scriptedDecider([
    { type: "tool", tool: "searchApprovedKnowledge", args: { query: "company formation price" } },
    { type: "respond", text: "The published company formation price is EUR 1500." }
  ]);

  const result = await runAgentTurnForContact(
    {
      currentMessage: "What is the price to create a Cyprus company?",
      locale: "english",
      store,
      user: { id: "u1" },
      userId: "u1",
      embedText: fakeEmbedText,
      embeddingModel: "test-model"
    },
    { decideNextStep: decide }
  );

  assert.equal(result.outcome, "responded");
  assert.match(result.response, /EUR 1500/);
  assert.equal(result.toolsUsed[0], "searchApprovedKnowledge");
  assert.deepEqual(searchArgs.embedding, [String("company formation price").length]);
  assert.equal(searchArgs.embeddingModel, "test-model");
  assert.equal(searchArgs.matchCount, 6);
});

test("a knowledge-search failure becomes a structured observation, not a crash, and the Agent can still respond from the recent conversation", async () => {
  const store = { searchKnowledge: async () => { throw new Error("edge function unreachable"); } };
  const decide = scriptedDecider([
    { type: "tool", tool: "searchApprovedKnowledge", args: { query: "price" } },
    { type: "respond", text: "I can't confirm the current price right now, but I can help with anything else." }
  ]);

  const result = await runAgentTurnForContact(
    { currentMessage: "What is the price?", locale: "english", store, user: { id: "u1" }, userId: "u1", embedText: async () => null },
    { decideNextStep: decide }
  );

  assert.equal(result.outcome, "responded");
  assert.equal(result.steps[0].result.ok, false);
  assert.equal(result.steps[0].result.status, "error");
  assert.equal(result.steps[0].result.reasonCode, "RETRIEVAL_FAILED");
});
