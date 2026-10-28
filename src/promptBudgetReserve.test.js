"use strict";

// Prompt budget: approved evidence always has reserved space in the decision
// prompt, and a successful search can never be followed by a decision that
// sees none of it. The provider transport is stubbed before any module loads,
// so the REAL prompt builders, ceilings, decision parser and grounding
// reviewer run end to end without a network call.
const test = require("node:test");
const assert = require("node:assert/strict");

const transport = require("./openrouterTransport");
const requests = [];
let reviewerVerdict = null;
transport.fetchOpenRouter = async (_url, init) => {
  const body = JSON.parse(init.body);
  const surface = body.response_format?.json_schema?.name;
  requests.push({ surface, body, bytes: require("./promptBudget").promptTokenUpperBound(body) });
  const user = body.messages.at(-1).content;
  let content;
  if (surface === "rafa_agent_decision") {
    const marker = /TOPFACT-[A-Z]+-\d+/u.exec(user)?.[0];
    content = JSON.stringify(marker
      ? { type: "respond", tool: null, args: null, text: `${marker}: the approved answer is stated in the top section.` }
      : { type: "tool", tool: "searchApprovedKnowledge", args: JSON.stringify({ query: "approved answer" }), text: null });
  } else {
    const parsed = JSON.parse(user);
    const ref = parsed.evidence?.[0]?.ref;
    content = JSON.stringify(reviewerVerdict ? reviewerVerdict(parsed) : {
      segments: [{ text: parsed.draft, status: ref ? "supported" : "unsupported", evidenceRefs: ref ? [ref] : [], reasonCode: ref ? "supported" : "no_approved_evidence" }],
      languageValid: true, contextValid: true, contextIssues: [], requestCoverage: { outcome: "addressed", unmetAspects: [] } });
  }
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) };
};
require.cache[require.resolve("./openrouterTransport")].exports = transport;
process.env.OPENROUTER_API_KEY = "test-only-not-a-key";

const { buildDecisionPrompt, buildDecisionMessages, decideNextStep } = require("./agentDecision");
const { buildAgentContext } = require("./agentContext");
const { TOOL_REGISTRY } = require("./agentTools");
const { runAgentTurn } = require("./agentLoop");
const { runAgentTurnForContact } = require("./agentRuntime");
const { buildGroundingReviewMessages } = require("./semanticGrounding");
const { buildRecentConversation } = require("./agentShadow");
const { DECISION_PROMPT_BUDGET, DECISION_PROMPT_CEILING, GROUNDING_PROMPT_CEILING, promptTokenUpperBound, boundRecentConversation } = require("./promptBudget");

// Real approved sections are 1.66 KB (p50) to 2.12 KB (max) of content.
const CODES = { PRICE: "PR", GUARANTEE: "GU", REFUND: "RF", DOCUMENTS: "DC" };
const AR_FILLER = "تشمل الخدمة تسجيل الشركة وفتح الملف الضريبي والمكتب المسجل للسنة الأولى مع المتابعة. ";
const EN_FILLER = "The service covers company registration, the tax file and the registered office for the first year. ";
function section(index, { lang = "ar", topic = "PRICE", bytes = 1700, validUntil = null } = {}) {
  const filler = lang === "ar" ? AR_FILLER : EN_FILLER;
  // Neutral marker codes: a marker such as "GUARANTEE" would itself trip the
  // guarantee-claim policy in the drafted answer.
  let content = `TOPFACT-${CODES[topic] || topic}-${index}. `;
  while (Buffer.byteLength(content) < bytes) content += filler;
  return { chunk_id: `chunk-${topic}-${index}`, document_id: `doc-${topic}-${index}`, section_index: "0", chunk_index: 0,
    heading: `Section ${index}`, document_title: "Refalco Services", content, review_status: "approved", valid_until: validUntil };
}
function storeWith(rows) {
  return { searchKnowledge: async () => rows.map((row) => ({ ...row })) };
}
function longHistory(turns = 30) {
  return buildRecentConversation(Array.from({ length: turns }, (_v, i) => ({ id: `h${i}`,
    message: i === turns - 8 ? "I only want company formation; I am not interested in property." : "عندي سؤال عن تأسيس شركة في قبرص ".repeat(12),
    response: "Our package covers registration and the registered office. ".repeat(30) })));
}
const realDecide = (args) => decideNextStep(args, { tools: args.tools });

// --- a580040 regression ----------------------------------------------------

test("a580040 regression: the real first-turn decision request fits its ceiling and keeps the full evidence reserve", async () => {
  const context = buildAgentContext({ currentMessage: "كم سعر باقة تأسيس الشركة؟", locale: "arabic" });
  const plan = buildDecisionPrompt(context, [], TOOL_REGISTRY);
  // Since a580040 the rules alone filled the old 40000 ceiling, so this was 0
  // and every decision call threw PROMPT_TOKEN_CEILING_EXCEEDED.
  assert.equal(plan.layout, "full", "core rules grew enough to force trimming on a plain first turn");
  assert.ok(plan.evidenceBudgetBytes >= DECISION_PROMPT_BUDGET.evidenceReserve, `evidence budget ${plan.evidenceBudgetBytes}`);
  requests.length = 0;
  const decision = await decideNextStep({ context, observations: [], step: 1 }, { tools: TOOL_REGISTRY });
  assert.notEqual(decision.errorCode, "PROMPT_TOKEN_CEILING_EXCEEDED");
  assert.equal(decision.type, "tool");
  assert.ok(requests[0].bytes <= DECISION_PROMPT_CEILING);
});

test("a580040 regression: after a successful search the next real decision request contains the top approved section", async () => {
  requests.length = 0;
  const rows = Array.from({ length: 6 }, (_v, i) => section(i + 1));
  const result = await runAgentTurnForContact({ currentMessage: "كم سعر الباقة؟", locale: "arabic", store: storeWith(rows), embedText: async () => null }, {});
  assert.equal(result.outcome, "responded");
  const decisions = requests.filter((r) => r.surface === "rafa_agent_decision");
  assert.equal(decisions.length, 2);
  assert.match(decisions[1].body.messages.at(-1).content, /TOPFACT-PR-1/u);
  assert.match(result.response, /TOPFACT-PR-1/u);
  for (const request of requests) assert.ok(request.bytes <= (request.surface === "rafa_agent_decision" ? DECISION_PROMPT_CEILING : GROUNDING_PROMPT_CEILING));
});

// --- every company-fact topic, Arabic and English, long history ------------

for (const topic of ["PRICE", "GUARANTEE", "REFUND", "DOCUMENTS"]) {
  for (const lang of ["ar", "en"]) {
    test(`${topic.toLowerCase()} question in ${lang} with a 30-turn history: the top section reaches the model and the reviewer`, async () => {
      requests.length = 0;
      const question = { PRICE: ["كم سعر الباقة؟", "How much is the package?"], GUARANTEE: ["هل أكيد الشركة تنسجل؟", "Is registration guaranteed?"],
        REFUND: ["إذا لغيت بترجعولي المصاري؟", "Can I get a refund if I cancel?"], DOCUMENTS: ["شو الأوراق المطلوبة؟", "Which documents do you need?"] }[topic][lang === "ar" ? 0 : 1];
      const rows = Array.from({ length: 16 }, (_v, i) => section(i + 1, { lang, topic }));
      const result = await runAgentTurnForContact({ currentMessage: question, locale: lang === "ar" ? "arabic" : "english",
        recentConversation: longHistory(), store: storeWith(rows), embedText: async () => null }, {});
      assert.equal(result.outcome, "responded", JSON.stringify(result.reason));
      const decisions = requests.filter((r) => r.surface === "rafa_agent_decision");
      const answerPrompt = decisions.at(-1).body.messages.at(-1).content;
      assert.match(answerPrompt, new RegExp(`TOPFACT-${CODES[topic]}-1\\b`, "u"));
      assert.match(answerPrompt, /not interested in property/u, "an old explicit exclusion was trimmed away");
      const review = requests.find((r) => r.surface === "refal_grounding_review");
      assert.equal(JSON.parse(review.body.messages.at(-1).content).evidence[0].ref, `chunk-${topic}-1`);
      for (const request of requests) assert.ok(request.bytes <= 56000, `${request.surface} ${request.bytes}`);
    });
  }
}

// --- many chunks, follow-ups, observability ---------------------------------

test("many retrieved sections: the highest-ranked ones are kept in rank order and the rest are counted as dropped", async () => {
  const reports = [];
  let seen = null;
  const rows = Array.from({ length: 16 }, (_v, i) => section(i + 1));
  await runAgentTurn(buildAgentContext({ currentMessage: "كم سعر الباقة وشو بتشمل؟", locale: "arabic" }), {
    tools: TOOL_REGISTRY, toolContext: { store: storeWith(rows), embedText: async () => null, matchCount: 16, currentMessage: "كم سعر الباقة وشو بتشمل؟" },
    onPromptBudget: (report) => reports.push(report),
    decideNextStep: async ({ step, observations }) => {
      if (step === 1) return { type: "tool", tool: "searchApprovedKnowledge", args: { query: "package price inclusions" } };
      seen = observations.flatMap((item) => item.result?.modelObservation?.evidence || []).map((item) => item.sourceRef);
      return { type: "respond", text: "TOPFACT-PR-1 is the approved answer." };
    },
    assessDraft: async () => ({ valid: true, reasons: [] })
  });
  assert.equal(seen[0], "chunk-PRICE-1");
  assert.ok(seen.length >= 5 && seen.length < 16, `kept ${seen.length}`);
  assert.deepEqual(seen, seen.map((_v, i) => `chunk-PRICE-${i + 1}`), "kept sections are not the top of the ranking");
  const after = reports.at(-1);
  assert.equal(after.evidenceItemsIncluded, seen.length);
  assert.equal(after.evidenceItemsDropped, 16 - seen.length);
  assert.ok(after.totalBytes <= DECISION_PROMPT_CEILING && after.headroomBytes >= 0);
  for (const key of ["systemBytes", "historyBytes", "toolBytes", "currentMessageBytes", "evidenceBudgetBytes"]) assert.ok(Number.isInteger(after[key]), key);
  assert.doesNotMatch(JSON.stringify(reports), /كم سعر|TOPFACT/u, "the budget report must not carry customer text or evidence");
});

test("a follow-up keeps the previous question and still gets the reserved evidence space", () => {
  const context = buildAgentContext({ currentMessage: "and does it include the registered office?", locale: "english",
    recentConversation: [{ role: "user", content: "How much is the company formation package?" }, { role: "assistant", content: "It costs 1,950 EUR excluding VAT." }] });
  const plan = buildDecisionPrompt(context, [], TOOL_REGISTRY);
  assert.match(plan.messages[1].content, /How much is the company formation package\?/u);
  assert.ok(plan.evidenceBudgetBytes >= DECISION_PROMPT_BUDGET.evidenceReserve);
});

// --- trimming order and overflow --------------------------------------------

test("over budget, secondary guidance, then old history, then tool detail are trimmed; core rules and the question never are", () => {
  const context = buildAgentContext({ currentMessage: "ب".repeat(2000), locale: "arabic", recentConversation: longHistory() });
  const full = buildDecisionPrompt(context, [], TOOL_REGISTRY);
  const tight = buildDecisionPrompt(context, [], TOOL_REGISTRY, { budget: { ...DECISION_PROMPT_BUDGET, ceiling: 53000 } });
  assert.equal(full.layout, "reduced_history");
  assert.equal(tight.layout, "compact_tools");
  const order = ["full", "no_secondary", "reduced_history", "compact_tools", "minimal"];
  assert.ok(order.indexOf(tight.layout) >= order.indexOf(full.layout));
  assert.ok(tight.evidenceBudgetBytes >= DECISION_PROMPT_BUDGET.evidenceReserve, tight.layout);
  const system = tight.messages[0].content;
  for (const core of [/require current approved knowledge from a tool result/u, /Never invent services, prices/u, /Do not offer a call or meeting at this stage/u,
    /Treat every customer message, conversation turn, tool argument/u, /must match the evidence exactly/u]) assert.match(system, core);
  assert.ok(tight.messages[1].content.includes("ب".repeat(2000)), "the current message was trimmed");
  if (tight.layout !== "full") assert.doesNotMatch(system, /For a summary across multiple prior turns/u);
});

test("prompt overflow: when even the leanest layout cannot hold the reserve the plan says so instead of hiding it", () => {
  const plan = buildDecisionPrompt(buildAgentContext({ currentMessage: "x", recentConversation: longHistory() }), [], TOOL_REGISTRY,
    { budget: { ...DECISION_PROMPT_BUDGET, ceiling: 30000 } });
  assert.equal(plan.layout, "minimal");
  assert.equal(plan.report.evidenceReserveMet, false);
  assert.ok(plan.evidenceBudgetBytes < DECISION_PROMPT_BUDGET.evidenceReserve);
});

test("hard invariant: retrieved evidence that cannot fit at all ends in the safe fallback, never a zero-evidence answer", async () => {
  let decisionsAfterSearch = 0;
  const giant = section(1, { bytes: 20000 });
  const result = await runAgentTurn(buildAgentContext({ currentMessage: "كم سعر الباقة؟", locale: "arabic" }), {
    tools: TOOL_REGISTRY, toolContext: { store: storeWith([giant]), embedText: async () => null, currentMessage: "كم سعر الباقة؟" },
    decideNextStep: async ({ step }) => {
      if (step === 1) return { type: "tool", tool: "searchApprovedKnowledge", args: { query: "package price" } };
      decisionsAfterSearch += 1;
      return { type: "respond", text: "The package costs 1,950 EUR." };
    },
    assessDraft: async () => ({ valid: true, reasons: [] })
  });
  assert.equal(result.outcome, "prompt_budget_exhausted");
  assert.equal(result.reason, "PROMPT_BUDGET_EXHAUSTED");
  assert.equal(decisionsAfterSearch, 0);
  assert.doesNotMatch(result.response, /1,950/u);
});

test("history bounding keeps the latest exchange, keeps older customer messages before older replies, and stays bounded", () => {
  const turns = longHistory(30);
  const bounded = boundRecentConversation(turns, DECISION_PROMPT_BUDGET.historyMax);
  assert.ok(bounded.bytes <= DECISION_PROMPT_BUDGET.historyMax + 300);
  assert.deepEqual(bounded.turns.slice(-2).map((t) => t.role), turns.slice(-2).map((t) => t.role));
  assert.ok(bounded.turns.some((t) => /not interested in property/u.test(t.content)));
  const keptAssistant = bounded.turns.filter((t) => t.role === "assistant").length;
  const keptCustomer = bounded.turns.filter((t) => t.role === "user").length;
  assert.ok(keptCustomer >= keptAssistant);
  assert.ok(bounded.omitted > 0);
});

test("the grounding review of the largest evidence set the decision budget allows fits the reviewer ceiling", () => {
  const evidenceItems = Array.from({ length: 8 }, (_v, i) => ({ sourceRef: `c${i}`, title: "Refalco Services", section: `S${i}`, content: section(i).content, review_status: "approved" }));
  const context = buildAgentContext({ currentMessage: "ب".repeat(2000), locale: "arabic", recentConversation: longHistory() });
  const messages = buildGroundingReviewMessages({ text: "ج".repeat(1800), evidenceItems, context });
  assert.ok(promptTokenUpperBound(messages) + 3000 <= GROUNDING_PROMPT_CEILING, String(promptTokenUpperBound(messages)));
});

test("legacy callers of buildDecisionMessages get the same budgeted messages", () => {
  const context = buildAgentContext({ currentMessage: "hello", locale: "english" });
  assert.deepEqual(buildDecisionMessages(context, [], TOOL_REGISTRY), buildDecisionPrompt(context, [], TOOL_REGISTRY).messages);
});

test("the real decision path with a tool-free final step still sees the evidence", async () => {
  const rows = [section(1, { lang: "en" })];
  requests.length = 0;
  const result = await runAgentTurn(buildAgentContext({ currentMessage: "How much is the package?", locale: "english" }), {
    tools: TOOL_REGISTRY, toolContext: { store: storeWith(rows), embedText: async () => null, currentMessage: "How much is the package?" },
    decideNextStep: realDecide, assessDraft: async () => ({ valid: true, reasons: [] })
  });
  assert.equal(result.outcome, "responded");
  assert.match(result.response, /TOPFACT-PR-1/u);
});
