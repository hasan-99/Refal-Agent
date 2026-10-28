"use strict";

// End-to-end call counts for the latency features, through the real live
// WhatsApp turn composition (preflight, router, agent loop, policy, grounding
// gate, persistence), with scripted models and an in-memory store. Every
// scenario runs with all flags off (today's flow) and on, and asserts how
// many model calls and knowledge-database calls each turn makes.

const test = require("node:test");
const assert = require("node:assert/strict");
const { runAgentLiveAnswerTurn } = require("./agentLiveAnswerTurn");
const { classifyContextualMessage } = require("./contextualPreflight");
const { scriptedGrounding } = require("../scripts/helpers/scriptedGrounding");
const { getSessionEvidenceCache } = require("./sessionEvidenceCache");

const FLAGS = ["RAFA_SEARCH_CACHE", "RAFA_SESSION_EVIDENCE_CACHE", "RAFA_FAST_SOCIAL_PATH", "RAFA_FACTUAL_SEARCH_FIRST", "RAFA_RERANK_CACHE"];
const PACKAGE_TEXT = "The company formation package costs 1,950 EUR excluding VAT. It includes company registration, the registered office for the first year and opening the tax file.";

async function withFlags(on, action) {
  const saved = Object.fromEntries(FLAGS.map((name) => [name, process.env[name]]));
  for (const name of FLAGS) { if (on) process.env[name] = "on"; else delete process.env[name]; }
  try { return await action(); }
  finally { for (const name of FLAGS) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; } }
}

// One store for every contact, as in production (the caches are per store).
function makeStore() {
  const users = new Map();
  const userFor = (id) => { if (!users.has(id)) users.set(id, { id, profile: {}, history: [] }); return users.get(id); };
  let serial = 0;
  const counts = { searchCalls: 0, versionCalls: 0 };
  return {
    counts,
    ensureUser: async (id) => userFor(id),
    getUser: async (id) => userFor(id),
    updateUser: async (id, update) => update(userFor(id)),
    addHistory: async (id, message, response, extra) => {
      const turn = { id: `${id}-turn-${++serial}`, at: new Date().toISOString(), message, response, metadata: extra?.metadata || {} };
      userFor(id).history.push(turn);
      return turn;
    },
    updateHistoryTurn: async (id, turnId, patch) => Object.assign(userFor(id).history.find((item) => item.id === turnId), patch),
    saveQualification: async () => {},
    saveIntents: async () => {},
    getKnowledgeVersion: async () => { counts.versionCalls += 1; return "knowledge-version-1"; },
    searchKnowledge: async () => {
      counts.searchCalls += 1;
      return [{ chunk_id: "pkg-1", document_id: "doc-pkg", section_index: "0", chunk_index: 0, heading: "Company formation package",
        document_title: "Refalco Services", content: PACKAGE_TEXT, review_status: "approved", valid_until: null }];
    }
  };
}

const PREFLIGHT = {
  "hi": ["greeting"],
  "thanks": ["small_talk"],
  "How much is the company formation package?": ["pricing", "company_formation"],
  "And what does it include?": ["company_formation"]
};

// A production-like decision model. "tool_first" searches whenever it has no
// approved evidence; "draft_first" sometimes answers from memory first, which
// the grounding gate rejects (the round trip RAFA_FACTUAL_SEARCH_FIRST removes).
function scriptedModels(behaviour) {
  const calls = { preflight: 0, decision: 0, grounding: 0 };
  const classifyMessage = (input, options) => classifyContextualMessage(input, { ...options, callModel: async () => {
    calls.preflight += 1;
    return JSON.stringify({ intents: PREFLIGHT[input.message] || ["general_information"], language: "english", operation: "none",
      offerSourceTurnId: null, noProactiveBookingOrContact: false });
  } });
  const decideNextStep = async ({ context, observations, tools }) => {
    calls.decision += 1;
    const evidence = observations.flatMap((item) => item?.result?.modelObservation?.evidence || []);
    const social = context.socialOnlyTurn === true;
    if (social) return { type: "respond", text: context.currentMessage === "hi" ? "Hello, I am REFAL. How can I help you today?" : "You are welcome. Happy to help any time." };
    if (evidence.length) {
      return { type: "respond", text: /include/iu.test(context.currentMessage)
        ? "It includes company registration, the registered office for the first year and opening the tax file."
        : "The company formation package costs 1,950 EUR excluding VAT." };
    }
    const rejected = observations.some((item) => item?.result?.status === "policy_rejected");
    if (behaviour === "draft_first" && !rejected) return { type: "respond", text: "The company formation package costs 1,500 EUR." };
    if (tools.searchApprovedKnowledge) return { type: "tool", tool: "searchApprovedKnowledge", args: { query: "company formation package price and inclusions" } };
    return { type: "respond", text: "I could not confirm that detail right now." };
  };
  const assessDraft = async (args) => { calls.grounding += 1; return scriptedGrounding(args); };
  return { calls, classifyMessage, decideNextStep, assessDraft };
}

async function runConversation({ flagsOn, behaviour, messages, userId, store = makeStore() }) {
  return withFlags(flagsOn, async () => {
    const models = scriptedModels(behaviour);
    const turns = [];
    for (const text of messages) {
      const before = { ...models.calls, ...store.counts };
      const logs = [];
      const sent = [];
      await runAgentLiveAnswerTurn({ socket: {}, chatId: "chat", userId, text }, {
        store, embedText: async () => [0.25, 0.5, 0.75],
        logEvent: async (event, fields) => logs.push([event, fields]),
        sendStoredTextReply: async (_s, _c, response) => sent.push(response),
        preflightOptions: { classifyMessage: models.classifyMessage },
        agentOptions: { decideNextStep: models.decideNextStep, assessDraft: models.assessDraft }
      });
      const completed = logs.find(([event]) => event === "agent_turn_completed")?.[1] || {};
      turns.push({ text, reply: sent[0],
        llmCalls: models.calls.preflight + models.calls.decision + models.calls.grounding - before.preflight - before.decision - before.grounding,
        preflightCalls: models.calls.preflight - before.preflight,
        knowledgeToolCalls: logs.filter(([event, f]) => event === "agent_tool_call" && f.tool === "searchApprovedKnowledge" && f.outcome !== "skipped").length,
        dbSearchCalls: store.counts.searchCalls - before.searchCalls,
        evidenceReuse: completed.evidenceReuse, searchFirst: completed.searchFirst, fastSocialPath: completed.fastSocialPath,
        outcome: completed.outcome });
    }
    return turns;
  });
}

const CONVERSATION = ["hi", "How much is the company formation package?", "And what does it include?", "thanks"];

test("flags off: the existing flow is unchanged (preflight model call on every turn, every fact turn searches)", async () => {
  const turns = await runConversation({ flagsOn: false, behaviour: "tool_first", messages: CONVERSATION, userId: "latency-off" });
  assert.deepEqual(turns.map((t) => t.preflightCalls), [1, 1, 1, 1]);
  assert.deepEqual(turns.map((t) => t.llmCalls), [3, 4, 4, 3]);
  assert.deepEqual(turns.map((t) => t.knowledgeToolCalls), [0, 1, 1, 0]);
  assert.ok(turns[1].dbSearchCalls > 0 && turns[2].dbSearchCalls > 0);
  assert.deepEqual(turns.map((t) => t.outcome), ["responded", "responded", "responded", "responded"]);
});

test("flags on: social turns skip the preflight and tools, fact turns search first, follow-ups reuse approved evidence", async () => {
  const turns = await runConversation({ flagsOn: true, behaviour: "tool_first", messages: CONVERSATION, userId: "latency-on" });
  assert.deepEqual(turns.map((t) => t.preflightCalls), [0, 1, 1, 0]);
  assert.deepEqual(turns.map((t) => t.llmCalls), [2, 3, 3, 2]);
  assert.deepEqual(turns.map((t) => t.fastSocialPath), [true, false, false, true]);
  assert.equal(turns[1].searchFirst, "preflight_intent");
  assert.equal(turns[1].knowledgeToolCalls, 1);
  assert.equal(turns[2].evidenceReuse, "hit");
  assert.equal(turns[2].knowledgeToolCalls, 0);
  assert.equal(turns[2].dbSearchCalls, 0);
  assert.match(turns[2].reply, /registered office/u);
  assert.deepEqual(turns.map((t) => t.outcome), ["responded", "responded", "responded", "responded"]);
});

test("a draft-first model loses its rejected-draft round trip when search-first is on, and grounding still decides", async () => {
  const off = await runConversation({ flagsOn: false, behaviour: "draft_first", messages: ["How much is the company formation package?"], userId: "draft-off" });
  const on = await runConversation({ flagsOn: true, behaviour: "draft_first", messages: ["How much is the company formation package?"], userId: "draft-on" });
  // Off: preflight, unsupported draft (rejected by the deterministic gate, no
  // reviewer call), search decision, answer, grounding review = 5. On: 3.
  assert.equal(off[0].llmCalls, 5);
  assert.equal(on[0].llmCalls, 3);
  assert.match(off[0].reply, /1,950 EUR/u);
  assert.match(on[0].reply, /1,950 EUR/u);
  assert.doesNotMatch(on[0].reply, /1,500/u);
});

test("the same question from a second customer is answered from the search cache without a database search", async () => {
  const store = makeStore();
  const first = await runConversation({ flagsOn: true, behaviour: "tool_first", messages: ["How much is the company formation package?"], userId: "cache-a", store });
  const second = await runConversation({ flagsOn: true, behaviour: "tool_first", messages: ["How much is the company formation package?"], userId: "cache-b", store });
  assert.ok(first[0].dbSearchCalls > 0);
  assert.equal(second[0].knowledgeToolCalls, 1);
  assert.equal(second[0].dbSearchCalls, 0);
  assert.equal(second[0].evidenceReuse, "none");
  assert.match(second[0].reply, /1,950 EUR/u);
});

test("evidence never crosses customers: another contact's turn gets no reused evidence", async () => {
  await runConversation({ flagsOn: true, behaviour: "tool_first", messages: ["How much is the company formation package?"], userId: "leak-a" });
  const other = await runConversation({ flagsOn: true, behaviour: "tool_first", messages: ["And what does it include?"], userId: "leak-b" });
  assert.notEqual(other[0].evidenceReuse, "hit");
  assert.notEqual(getSessionEvidenceCache().lookup({ sessionKey: "leak-b", previousTurnId: "leak-a-turn-1", knowledgeVersion: "knowledge-version-1" }).status, "hit");
});
