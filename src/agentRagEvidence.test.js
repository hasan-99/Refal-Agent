// REFAL-AGENT-027 — end-to-end proof that approved RAG evidence content
// actually reaches the real decision model, not a scripted decider standing
// in for it. Every other Agent test in this repo (agentRuntime.test.js,
// agentScenarios.js, benchmarkScenarios.js) drives runAgentTurn with a
// scripted `decideNextStep`, which proves the deterministic loop/tool wiring
// but can never prove what text a real model call actually receives. This
// file wires the REAL `decideNextStep` (src/agentDecision.js) — including its
// real `buildDecisionMessages`/observation formatting — through to a stubbed
// `callModel`, so the assertions below are against the literal prompt text
// the model would see.

const test = require("node:test");
const assert = require("node:assert/strict");
const { runAgentTurn } = require("./agentLoop");
const { decideNextStep } = require("./agentDecision");
const { TOOL_REGISTRY } = require("./agentTools");
const { buildAgentContext } = require("./agentContext");
const { evaluateAnswerClaims } = require("./claimPolicy");

test("IMPORTANT: after a RAG tool call, the real decision model's next prompt contains the actual approved chunk content, not just the document heading", async () => {
  const store = {
    searchKnowledge: async () => [{
      document_title: "Refalco Group Services",
      heading: "Overview",
      content: "Refalco Group provides Company Formation, Accounting, VAT Registration and Payroll services.",
      chunk_id: "chunk-services-1"
    }]
  };

  const callModelCalls = [];
  const callModel = async (messages) => {
    callModelCalls.push(messages);
    if (callModelCalls.length === 1) {
      return JSON.stringify({ type: "tool", tool: "searchApprovedKnowledge", args: { query: "Refalco Group services" } });
    }
    return JSON.stringify({ type: "respond", text: "Refalco Group provides company formation, accounting, VAT registration, and payroll services." });
  };

  const context = buildAgentContext({ currentMessage: "What services does Refalco Group provide?", locale: "english" });
  const toolContext = { store, embedText: async () => null, embeddingModel: "test-model", matchCount: 6 };

  const result = await runAgentTurn(context, {
    decideNextStep: (args) => decideNextStep(args, { callModel, tools: TOOL_REGISTRY }),
    tools: TOOL_REGISTRY,
    toolContext
  });

  assert.equal(result.outcome, "responded");
  assert.equal(callModelCalls.length, 2, "expected one tool decision call and one follow-up decision call");

  // The SECOND call is the one made after the tool observation exists — this
  // is the literal text the real decision model would have read.
  const secondDecisionUserMessage = callModelCalls[1][1].content;
  for (const expectedFact of ["Company Formation", "Accounting", "VAT Registration", "Payroll"]) {
    assert.ok(
      secondDecisionUserMessage.includes(expectedFact),
      `expected the second decision prompt to include "${expectedFact}"\n\ngot:\n${secondDecisionUserMessage}`
    );
  }
  // Not just the heading: the pre-fix behavior only ever surfaced
  // result.userSafeSummary (here, "Overview"/"Refalco Group Services"), never the
  // chunk content itself.
  assert.ok(secondDecisionUserMessage.length > 0);
});

test("empty or general Evidence references do not block approved content from retrieval or grounded answers", async () => {
  const referenceCases = [
    { label: "empty references", references: [] },
    { label: "general references", references: [{ type: "general_reference", label: "General REFALCO website reference", url: "https://refalco.com/" }] }
  ];

  for (let index = 0; index < 87; index += 1) {
    const { label, references } = referenceCases[index % referenceCases.length];
    const content = `Approved revision ${index + 1} states that company setup includes registration support.`;
    const answer = `Company setup includes registration support.`;
    const store = {
      searchKnowledge: async () => [{
        document_title: `Approved revision ${index + 1}`,
        heading: "Company setup",
        content,
        chunk_id: `approved-revision-${index + 1}`,
        review_status: "approved",
        valid_until: null,
        // This mirrors document Evidence references. These may be empty or
        // general context, and do not determine whether indexed text is usable.
        documentMetadata: { supporting: references },
        policyMetadata: {
          facts: ["MB-F19"],
          supporting: [],
          governedFacts: ["MB-F19"],
          factRegisterRows: [{ id: "MB-F19", status: "pending", approvedLanguages: [] }]
        }
      }]
    };
    const modelCalls = [];
    const callModel = async (messages) => {
      modelCalls.push(messages);
      if (modelCalls.length === 1) {
        return JSON.stringify({ type: "tool", tool: "searchApprovedKnowledge", args: { query: "company setup registration support" } });
      }
      return JSON.stringify({ type: "respond", text: answer });
    };
    const result = await runAgentTurn(buildAgentContext({
      currentMessage: "What does company setup include?",
      locale: "english"
    }), {
      decideNextStep: (args) => decideNextStep(args, { callModel, tools: TOOL_REGISTRY }),
      tools: TOOL_REGISTRY,
      toolContext: { store, embedText: async () => null, language: "english" }
    });

    assert.equal(result.outcome, "responded", `${label}, revision ${index + 1}`);
    assert.equal(modelCalls.length, 2, `${label}, revision ${index + 1}`);
    assert.ok(modelCalls[1][1].content.includes(content), `${label}, revision ${index + 1} content reaches the answer model`);
    const evidence = {
      content,
      review_status: "approved",
      valid_until: null,
      metadata: { evidenceReferences: references, supporting: references }
    };
    assert.equal(evaluateAnswerClaims(answer, { evidence: [evidence], language: "english" }).allowed, true,
      `${label}, revision ${index + 1} should support a factual answer`);
  }
});

test("after a real no_evidence result, the decision model's next prompt contains no fabricated company facts", async () => {
  const store = { searchKnowledge: async () => [] };

  const callModelCalls = [];
  const callModel = async (messages) => {
    callModelCalls.push(messages);
    if (callModelCalls.length === 1) {
      return JSON.stringify({ type: "tool", tool: "searchApprovedKnowledge", args: { query: "cryptocurrency custody" } });
    }
    return JSON.stringify({ type: "respond", text: "I don't have confirmed information about that service. I can check with the team if you'd like." });
  };

  const context = buildAgentContext({ currentMessage: "Do you offer cryptocurrency custody services?", locale: "english" });
  const toolContext = { store, embedText: async () => null, embeddingModel: "test-model", matchCount: 6 };

  const result = await runAgentTurn(context, {
    decideNextStep: (args) => decideNextStep(args, { callModel, tools: TOOL_REGISTRY }),
    tools: TOOL_REGISTRY,
    toolContext
  });

  assert.equal(result.outcome, "responded");
  const secondDecisionUserMessage = callModelCalls[1][1].content;
  assert.equal(secondDecisionUserMessage.includes("Approved knowledge evidence"), false);
  assert.match(secondDecisionUserMessage, /No approved information matched this question/);
});
