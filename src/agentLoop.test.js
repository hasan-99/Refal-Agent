const test = require("node:test");
const assert = require("node:assert/strict");
const { runAgentTurn, validateDecision, DEFAULT_MAX_STEPS } = require("./agentLoop");
const { buildAgentContext } = require("./agentContext");

const BASE_CONTEXT = buildAgentContext({ currentMessage: "What is the price to create a Cyprus company?", locale: "english" });

function scriptedDecider(decisions) {
  let index = 0;
  return async () => decisions[Math.min(index++, decisions.length - 1)];
}

test("DEFAULT_MAX_STEPS is a small bounded number, never unlimited", () => {
  assert.equal(DEFAULT_MAX_STEPS, 4);
});

test("validateDecision rejects an invented tool name", () => {
  const result = validateDecision({ type: "tool", tool: "deleteDatabase", args: {} }, { searchApprovedKnowledge: {} });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unknown_tool_requested");
});

test("validateDecision rejects non-object args", () => {
  const result = validateDecision({ type: "tool", tool: "x", args: "DROP TABLE users" }, { x: {} });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_tool_args");
});

test("a zero-question respond decision is valid: the customer's request is already answered", async () => {
  const decide = scriptedDecider([{ type: "respond", text: "The current published price for company formation is listed on our services page." }]);
  const result = await runAgentTurn(BASE_CONTEXT, { decideNextStep: decide, tools: {} });
  assert.equal(result.finished, true);
  assert.equal(result.outcome, "responded");
  assert.match(result.response, /published price/);
  assert.equal(result.stepCount, 1);
});

test("a tool call is executed, observed, and the loop continues for a second decision", async () => {
  let searchArgs = null;
  const tools = {
    searchApprovedKnowledge: {
      run: async (args) => { searchArgs = args; return { ok: true, status: "found", data: [{ heading: "Company formation price", content: "EUR 1500" }] }; }
    }
  };
  const decide = scriptedDecider([
    { type: "tool", tool: "searchApprovedKnowledge", args: { query: "company formation price" } },
    { type: "respond", text: "Company formation is published at EUR 1500." }
  ]);
  const result = await runAgentTurn(BASE_CONTEXT, { decideNextStep: decide, tools });
  assert.equal(result.outcome, "responded");
  assert.equal(result.toolsUsed.length, 1);
  assert.equal(result.toolsUsed[0], "searchApprovedKnowledge");
  assert.deepEqual(searchArgs, { query: "company formation price" });
  assert.equal(result.stepCount, 2);
});

test("a tool that throws produces a structured failed observation, not an uncaught exception", async () => {
  const tools = { searchApprovedKnowledge: { run: async () => { throw new Error("edge function unreachable"); } } };
  const decide = scriptedDecider([
    { type: "tool", tool: "searchApprovedKnowledge", args: { query: "x" } },
    { type: "respond", text: "I can't confirm that right now, but I can help with what I do know." }
  ]);
  const result = await runAgentTurn(BASE_CONTEXT, { decideNextStep: decide, tools });
  assert.equal(result.steps[0].result.ok, false);
  assert.equal(result.steps[0].result.reasonCode, "TOOL_THREW");
  assert.equal(result.outcome, "responded");
});

test("the loop stops at the step budget instead of looping forever", async () => {
  const tools = { searchApprovedKnowledge: { run: async () => ({ ok: true, status: "no_evidence", data: [] }) } };
  const decide = async () => ({ type: "tool", tool: "searchApprovedKnowledge", args: { query: "x" } });
  const result = await runAgentTurn(BASE_CONTEXT, { decideNextStep: decide, tools, maxSteps: 3 });
  assert.equal(result.outcome, "max_steps_reached");
  assert.equal(result.stepCount, 3);
  assert.equal(typeof result.response, "string");
  assert.notEqual(result.response, "");
});

test("a decision naming an unknown tool stops safely with a deterministic fallback, not a thrown error", async () => {
  const decide = scriptedDecider([{ type: "tool", tool: "sendWireTransfer", args: {} }]);
  const result = await runAgentTurn(BASE_CONTEXT, { decideNextStep: decide, tools: {} });
  assert.equal(result.outcome, "invalid_decision");
  assert.equal(result.reason, "unknown_tool_requested");
  assert.equal(typeof result.response, "string");
});

test("a respond draft with too many questions is mechanically corrected to the first question, not discarded", async () => {
  const decide = scriptedDecider([{ type: "respond", text: "What is your budget? And when do you want to start?" }]);
  const result = await runAgentTurn(BASE_CONTEXT, { decideNextStep: decide, tools: {} });
  assert.equal(result.outcome, "responded");
  assert.equal(result.corrected, true);
  assert.equal(result.response, "What is your budget?");
  assert.equal(result.stepCount, 1);
});

test("a rejection that can't be mechanically corrected (e.g. too long) gets one retried decision instead of an immediate generic fallback", async () => {
  const overlong = `This is a single overlong sentence without any question mark that just keeps going on and on ${"and on ".repeat(70)}until it exceeds the character limit the deterministic response policy enforces.`;
  const decide = scriptedDecider([
    { type: "respond", text: overlong },
    { type: "respond", text: "Company formation is published at EUR 1500." }
  ]);
  const result = await runAgentTurn(BASE_CONTEXT, { decideNextStep: decide, tools: {} });
  assert.equal(result.outcome, "responded");
  assert.equal(result.corrected, undefined);
  assert.equal(result.response, "Company formation is published at EUR 1500.");
  assert.equal(result.stepCount, 2);
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].tool, "responsePolicyCheck");
  assert.match(result.steps[0].result.reasonCode, /too_long/);
});

test("a rejection that never becomes compliant exhausts the step budget and falls back to the generic safe reply, not silence", async () => {
  const overlong = `This is a single overlong sentence without any question mark that just keeps going on and on ${"and on ".repeat(70)}until it exceeds the character limit the deterministic response policy enforces.`;
  const decide = async () => ({ type: "respond", text: overlong });
  const result = await runAgentTurn(BASE_CONTEXT, { decideNextStep: decide, tools: {}, maxSteps: 2 });
  assert.equal(result.outcome, "response_rejected");
  assert.match(result.reason, /too_long/);
  assert.equal(result.stepCount, 2);
  assert.equal(typeof result.response, "string");
  assert.notEqual(result.response, "");
});

test("a clarify draft with too many questions is also mechanically corrected, not discarded", async () => {
  const decide = scriptedDecider([{ type: "clarify", text: "What activity will the company do? And where will it operate?" }]);
  const result = await runAgentTurn(BASE_CONTEXT, { decideNextStep: decide, tools: {} });
  assert.equal(result.outcome, "clarified");
  assert.equal(result.corrected, true);
  assert.equal(result.response, "What activity will the company do?");
});

test("a clarify decision allows a single short question with no minimum length", async () => {
  const decide = scriptedDecider([{ type: "clarify", text: "What will the company's main activity be?" }]);
  const result = await runAgentTurn(BASE_CONTEXT, { decideNextStep: decide, tools: {} });
  assert.equal(result.outcome, "clarified");
  assert.equal(result.response, "What will the company's main activity be?");
});

test("the fallback response is localized to the conversation's locale", async () => {
  const arabicContext = buildAgentContext({ currentMessage: "ما سعر تأسيس شركة؟", locale: "arabic" });
  const decide = scriptedDecider([{ type: "tool", tool: "nope", args: {} }]);
  const result = await runAgentTurn(arabicContext, { decideNextStep: decide, tools: {} });
  assert.match(result.response, /[؀-ۿ]/);
});

test("a decision call that throws (e.g. provider outage) ends the turn safely instead of crashing it", async () => {
  const decide = async () => { throw new Error("OpenRouter HTTP 500"); };
  const result = await runAgentTurn(BASE_CONTEXT, { decideNextStep: decide, tools: {} });
  assert.equal(result.outcome, "decision_failed");
  assert.equal(typeof result.response, "string");
});
