const test = require("node:test");
const assert = require("node:assert/strict");
const { runAgentTurnForContact, buildToolContext } = require("./agentRuntime");

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
