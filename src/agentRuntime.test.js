const test = require("node:test");
const assert = require("node:assert/strict");
const { runAgentTurnForContact, buildToolContext } = require("./agentRuntime");
const { decideNextStep: defaultDecideNextStep } = require("./agentDecision");

function scriptedDecider(decisions) {
  let index = 0;
  return async () => decisions[Math.min(index++, decisions.length - 1)];
}

test("tool context binds trusted identity, current turn, consent, capabilities, and embedding defaults", () => {
  const context = buildToolContext({ store: {}, user: {}, userId: "contact-1", sourceTurnId: "turn-1", currentMessage: "I live in Jordan.", consentState: "denied", allowedCapabilities: ["upsertLead"] });
  assert.equal(typeof context.embedText, "function");
  assert.equal(context.sourceTurnId, "turn-1");
  assert.equal(context.currentMessage, "I live in Jordan.");
  assert.equal(context.consentState, "denied");
  assert.deepEqual(context.allowedCapabilities, ["upsertLead"]);
  assert.equal(Object.isFrozen(context.allowedCapabilities), true);
});

test("the model decides when and how to search; there is no intent-triggered prefetch", async () => {
  let searches = 0;
  const result = await runAgentTurnForContact({
    currentMessage: "thank you", locale: "english", store: { searchKnowledge: async () => { searches += 1; return []; } }, user: {}, userId: "u1"
  }, { decideNextStep: scriptedDecider([{ type: "respond", text: "You're welcome, happy to help anytime." }]) });
  assert.equal(result.outcome, "responded");
  assert.equal(searches, 0);
  assert.equal(result.steps.length, 0);
});

test("a broad colloquial services request can retrieve and answer from approved evidence", async () => {
  const searches = [];
  const store = { searchKnowledge: async (query) => {
    searches.push(query);
    return [{ document_id: "doc-1", section_index: "0", chunk_id: "chunk-1", document_title: "Approved profile", heading: "Service portfolio", content: "المجموعة تقدم دعماً بتأسيس الشركات والمحاسبة.", review_status: "approved" }];
  } };
  let modelEvidence;
  const result = await runAgentTurnForContact({
    currentMessage: "ممكم اعرف شو بتقدمو خدمات؟", locale: "arabic", recentConversation: [], store, user: {}, userId: "u1", embedText: async () => null
  }, { decideNextStep: async ({ observations, step }) => {
    if (step === 1) return { type: "tool", tool: "searchApprovedKnowledge", args: { query: "مجالات الخدمات التي تقدمها المجموعة" } };
    modelEvidence = observations[0].result.modelObservation.evidence;
    return { type: "respond", text: "المجموعة تقدم دعماً بتأسيس الشركات والمحاسبة." };
  } });
  assert.deepEqual(searches, ["مجالات الخدمات التي تقدمها المجموعة", "ممكم اعرف شو بتقدمو خدمات؟"]);
  assert.match(modelEvidence[0].content, /تأسيس الشركات والمحاسبة/u);
  assert.equal(result.outcome, "responded");
  assert.match(result.response, /تأسيس الشركات والمحاسبة/u);
});

test("conversation history is available for model-selected contextual searches", async () => {
  const queries = [];
  const result = await runAgentTurnForContact({
    currentMessage: "and what does that include?", locale: "english", recentConversation: [
      { role: "user", content: "I want to form a company in Cyprus" },
      { role: "assistant", content: "What structure are you considering?" }
    ], store: { searchKnowledge: async (value) => { queries.push(value); return []; } }, user: {}, userId: "u1", embedText: async () => null
  }, { decideNextStep: async ({ context, step }) => {
    if (step === 1) {
      assert.match(context.recentConversation.map((turn) => turn.content).join(" "), /form a company in Cyprus/u);
      return { type: "tool", tool: "searchApprovedKnowledge", args: { query: "company formation inclusions in Cyprus" } };
    }
    return { type: "respond", text: "I do not have approved details for that yet." };
  } });
  assert.deepEqual(queries, ["company formation inclusions in Cyprus", "and what does that include?"]);
  assert.equal(result.outcome, "responded");
});

test("the last bounded model call has no tools and is reserved for the final answer", async () => {
  const seenTools = [];
  const result = await runAgentTurnForContact({ currentMessage: "Tell me about your services", locale: "english", store: {}, user: {}, userId: "u1" }, {
    maxSteps: 2,
    decideNextStep: async ({ tools, step }) => {
      seenTools.push(Object.keys(tools || {}));
      return step === 1
        ? { type: "tool", tool: "searchApprovedKnowledge", args: { query: "approved service overview" } }
        : { type: "respond", text: "I can help with the areas supported by current approved information." };
    }
  });
  assert.ok(seenTools[0].includes("searchApprovedKnowledge"));
  assert.deepEqual(seenTools[1], []);
  assert.equal(result.outcome, "responded");
});

test("an identical search is skipped without another retrieval call", async () => {
  let searches = 0;
  const store = { searchKnowledge: async () => { searches += 1; return []; } };
  const result = await runAgentTurnForContact({ currentMessage: "What services are supported?", locale: "english", store, user: {}, userId: "u1", embedText: async () => null }, {
    decideNextStep: scriptedDecider([
      { type: "tool", tool: "searchApprovedKnowledge", args: { query: "supported services" } },
      { type: "tool", tool: "searchApprovedKnowledge", args: { query: " SUPPORTED   SERVICES! " } },
      { type: "respond", text: "I do not have an approved answer for that yet." }
    ])
  });
  assert.equal(searches, 2, "one logical search searches both the model's interpretation and the original turn");
  assert.equal(result.steps[1].result.reasonCode, "REPEATED_SEARCH_NO_ADDITIONAL_VALUE");
  assert.equal(result.outcome, "responded");
});

test("knowledge observations assemble ordered chunks into complete parent sections within a bounded budget", async () => {
  const result = await runAgentTurnForContact({ currentMessage: "What are the conditions?", locale: "english", user: {}, userId: "u1", embedText: async () => null,
    store: { searchKnowledge: async () => [
      { document_id: "doc-a", section_index: "2", chunk_index: 3, chunk_id: "chunk-a", document_title: "Approved source", heading: "Conditions", content: "The general rule applies first.", review_status: "approved" },
      { document_id: "doc-a", section_index: "2", chunk_index: 4, chunk_id: "chunk-b", document_title: "Approved source", heading: "Conditions", content: "The exception applies when the condition is met.", review_status: "approved" }
    ] } }, {
    decideNextStep: async ({ observations, step }) => {
      if (step === 1) return { type: "tool", tool: "searchApprovedKnowledge", args: { query: "approved conditions" } };
      const evidence = observations[0].result.modelObservation.evidence[0].content;
      assert.ok(evidence.indexOf("general rule") < evidence.indexOf("exception"));
      return { type: "respond", text: "The general rule applies first, with an exception when its condition is met." };
    }
  });
  assert.equal(result.outcome, "responded");
});

test("model-call telemetry includes timing and evidence passed to the decision", async (t) => {
  const originalApiKey = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  t.after(() => { if (originalApiKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = originalApiKey; });
  let metric;
  await runAgentTurnForContact({ currentMessage: "thank you", locale: "english", store: {}, user: {}, userId: "test-contact" }, {
    decideNextStep: defaultDecideNextStep, onModelCall: (value) => { metric = value; }
  });
  assert.ok(Number.isSafeInteger(metric.durationMs));
  assert.equal(metric.outcome, "provider_error");
  assert.equal(metric.errorCode, "MODEL_CALL_FAILED");
  assert.equal(metric.evidenceCount, 0);
});
