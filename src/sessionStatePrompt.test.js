"use strict";

// Decision-prompt contract for the conversation-behaviour flags:
//   - flags off: the prompt is exactly what it was (no block, no rules, same report)
//   - flags on: one bounded customer-context block, measured, trimmed before
//     the evidence reserve, never shown to the grounding reviewer as evidence.
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildDecisionPrompt, buildDecisionMessages, SESSION_STATE_MAX_BYTES, ANSWER_FIRST_STYLE_RULE, SMART_FOLLOWUP_RULE } = require("./agentDecision");
const { buildAgentContext } = require("./agentContext");
const { TOOL_REGISTRY } = require("./agentTools");
const { buildGroundingReviewMessages } = require("./semanticGrounding");
const { buildSessionMemory } = require("./sessionMemory");
const { DECISION_PROMPT_BUDGET } = require("./promptBudget");

const HEADER = "Customer context for this conversation";
const NOW = Date.parse("2026-10-28T12:00:00Z");
const FEATURES = { structuredSessionMemory: true, answerFirstStyle: true, truthfulActionStates: true, smartFollowups: true };
const EVIDENCE = { step: 1, tool: "searchApprovedKnowledge", args: { query: "package" }, result: { ok: true, status: "found",
  modelObservation: { type: "approved_knowledge", status: "found", evidence: [{ sourceRef: "11111111-1111-4111-8111-111111111111:0", title: "Refalco Services", section: "Package",
    content: "The company formation package costs 1,950 EUR excluding VAT." }], policyEvidence: [], primarySearchRefs: [] } } };
const transcript = (n, size = 60) => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? "assistant" : "user",
  content: (i % 2 ? `Reply ${i}: we can help with company formation in Cyprus. ` : `سؤال ${i}: بدنا نأسس شركة في قبرص، شو المطلوب؟ `).repeat(Math.max(1, Math.round(size / 50))) }));
const history = (n) => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, at: new Date(NOW - (n - i) * 60_000).toISOString(),
  message: i === 0 ? "My name is Hassan. We are based in Cyprus and we need Arabic support" : i === 1 ? "We may need English too" : `Question ${i} about formation`,
  response: `Answer ${i}. Would you like the list of documents?`, metadata: { intent: { intents: ["company_formation"] } } }));

function contexts({ turns = 4, historySize = 60, message = "And what does it include?" } = {}) {
  const base = { currentMessage: message, locale: "english", contact: { id: "u1", name: "Hassan", nameSource: "customer_stated" },
    recentConversation: transcript(turns, historySize), intents: ["company_formation"] };
  const sessionState = buildSessionMemory({ history: history(Math.max(2, turns / 2)), currentMessage: message, currentTurn: { id: "cur", intents: ["company_formation"] }, now: NOW });
  return {
    off: buildAgentContext(base),
    offWithStrayState: buildAgentContext({ ...base, sessionState }),
    on: buildAgentContext({ ...base, sessionState, conversationFeatures: FEATURES })
  };
}

test("flags off: the decision prompt and its size report are unchanged (no block, no rules, no new report keys)", () => {
  for (const shape of [{ turns: 0 }, { turns: 4 }, { turns: 24, historySize: 400 }]) {
    const { off, offWithStrayState } = contexts(shape);
    assert.equal(Object.hasOwn(offWithStrayState, "sessionState"), false, "no session state reaches the context without a flag");
    assert.equal(Object.hasOwn(offWithStrayState, "conversationFeatures"), false);
    for (const observations of [[], [EVIDENCE]]) {
      const a = buildDecisionPrompt(off, observations, TOOL_REGISTRY);
      const b = buildDecisionPrompt(offWithStrayState, observations, TOOL_REGISTRY);
      assert.deepEqual(b.messages, a.messages);
      assert.deepEqual(b.report, a.report);
      assert.equal(a.messages[1].content.includes(HEADER), false);
      assert.equal(a.messages[0].content.includes(ANSWER_FIRST_STYLE_RULE), false);
      assert.equal(a.messages[0].content.includes(SMART_FOLLOWUP_RULE), false);
      assert.equal(Object.hasOwn(a.report, "sessionStateBytes"), false);
    }
  }
});

test("flags on: one labelled block before the transcript, measured and capped at 1500 bytes", () => {
  const { on, off } = contexts({ turns: 4 });
  const prompt = buildDecisionPrompt(on, [EVIDENCE], TOOL_REGISTRY);
  const user = prompt.messages[1].content;
  assert.equal(user.split(HEADER).length - 1, 1);
  assert.ok(user.indexOf(HEADER) < user.indexOf("\nRecent conversation:"));
  assert.match(user, /NOT company evidence/u);
  assert.ok(prompt.report.sessionStateBytes > 0 && prompt.report.sessionStateBytes <= SESSION_STATE_MAX_BYTES + 4);
  assert.equal(prompt.report.sessionStateCapBytes, SESSION_STATE_MAX_BYTES);
  assert.ok(prompt.report.evidenceReserveMet);
  const offPrompt = buildDecisionPrompt(off, [EVIDENCE], TOOL_REGISTRY);
  assert.equal(prompt.report.currentMessageBytes, offPrompt.report.currentMessageBytes, "the block is reported separately from the current message");
  assert.ok(prompt.messages[0].content.includes(ANSWER_FIRST_STYLE_RULE));
  assert.ok(prompt.messages[0].content.includes(SMART_FOLLOWUP_RULE));
});

test("existing rules are not duplicated by the new ones", () => {
  const { on } = contexts();
  const system = buildDecisionMessages(on, [], TOOL_REGISTRY)[0].content;
  assert.equal(system.split("Ask at most one question").length - 1, 1);
  assert.equal(system.split("Answer it before anything else").length - 1, 1);
});

test("the block is trimmed before the evidence reserve: a huge transcript shrinks it, the reserve stays met", () => {
  const { on } = contexts({ turns: 24, historySize: 2400 });
  const prompt = buildDecisionPrompt(on, [EVIDENCE], TOOL_REGISTRY);
  assert.ok(prompt.report.evidenceBudgetBytes >= DECISION_PROMPT_BUDGET.evidenceReserve, JSON.stringify(prompt.report));
  assert.ok(prompt.report.sessionStateBytes <= prompt.report.sessionStateCapBytes + 4);
  const leanBudget = { ...DECISION_PROMPT_BUDGET, ceiling: 42000 };
  const lean = buildDecisionPrompt(on, [EVIDENCE], TOOL_REGISTRY, { budget: leanBudget });
  assert.notEqual(lean.layout, "full");
  assert.ok(lean.report.sessionStateCapBytes < SESSION_STATE_MAX_BYTES, "leaner layouts carry a smaller block");
  if (lean.report.evidenceBudgetBytes < leanBudget.evidenceReserve) assert.equal(lean.layout, "minimal", "only the last layout may miss the reserve, exactly as before");
});

test("11/M: the grounding reviewer never receives the customer-context block", () => {
  const { on } = contexts();
  const review = buildGroundingReviewMessages({ text: "The package costs 900 EUR.", evidenceItems: [], context: on });
  const serialized = JSON.stringify(review);
  assert.equal(serialized.includes(HEADER), false);
  assert.equal(serialized.includes("[confirmed,user]"), false);
  assert.deepEqual(JSON.parse(review[1].content).evidence, []);
});
