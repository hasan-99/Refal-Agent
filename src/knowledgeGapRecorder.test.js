"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { recordKnowledgeGap, scheduleKnowledgeGapRecording, extractGapSignals, knowledgeGapsEnabled, createLocalRateLimiter } = require("./knowledgeGapRecorder");
const { runAgentLiveAnswerTurn: realRun } = require("./agentLiveAnswerTurn");

const searchStep = (overrides = {}) => ({ step: 1, tool: "searchApprovedKnowledge", args: { query: "change registered office address" },
  result: { ok: true, status: "no_evidence", modelObservation: { status: "no_evidence", evidence: [], policyEvidence: [] }, trace: { searchQueries: ["change registered office address"] }, ...overrides } });

function stubStore(impl) {
  const calls = [];
  return { calls, recordKnowledgeGapEvent: async (payload) => { calls.push(payload); return impl ? impl(payload) : { recorded: true, created: true, grouping: "new_group" }; } };
}

const deps = (store, extra = {}) => ({ store, embedText: async () => Array.from({ length: 2048 }, (_v, i) => (i < 384 ? Math.cos(i) : 0)), rateLimiter: () => true, ...extra });

test("missing knowledge creates a gap event with retrieval and agent diagnostics", async () => {
  const store = stubStore();
  const agentResult = { outcome: "response_rejected", reason: "no_approved_evidence", stepCount: 4,
    steps: [searchStep(), { step: 2, tool: "responsePolicyCheck", result: { ok: false, status: "policy_rejected", reasonCode: "no_approved_evidence" } }] };
  const result = await recordKnowledgeGap({ agentResult, message: "Can I change my company address?", classification: { intents: ["company_formation"], language: "english" },
    userId: "35799123456@s.whatsapp.net", sourceTurnId: "9f0d6a2e-4b1c-4c2d-9e3f-0a1b2c3d4e5f", traceId: "trace-1", delivered: true }, deps(store));
  assert.equal(result.recorded, true);
  const payload = store.calls[0];
  assert.equal(payload.reason, "missing_knowledge");
  assert.equal(payload.confidence, "high");
  assert.equal(payload.category, "corporate");
  assert.equal(payload.language, "en");
  assert.equal(payload.searchRan, true);
  assert.deepEqual(payload.searchQueries, ["change registered office address"]);
  assert.equal(payload.groundingRejected, true);
  assert.deepEqual(payload.rejectionReasons, ["no_approved_evidence"]);
  assert.equal(payload.responseType, "safe_fallback");
  assert.equal(payload.noSafeAnswer, true);
  assert.match(payload.promptVersion, /^\d+\.\d+\.\d+$/u);
  assert.ok(payload.model);
  assert.equal(payload.embedding.length, 384);
});

test("weak retrieval: candidates returned but no primary match and the claim was unsupported", async () => {
  const store = stubStore();
  const evidence = [{ sourceRef: "11111111-1111-4111-8111-111111111111", relevance: 0.5, retrievalRank: 3 }, { sourceRef: "22222222-2222-4222-8222-222222222222", relevance: 0.33 }];
  const agentResult = { outcome: "response_rejected", reason: "entities_not_in_evidence", steps: [
    searchStep({ status: "found", modelObservation: { status: "found", evidence, policyEvidence: [], primarySearchRefs: [] },
      trace: { searchQueries: ["registered office"], candidateCount: 14, candidateIds: evidence.map((item) => item.sourceRef), rerank: { status: "reranked" } } }),
    { step: 2, tool: "responsePolicyCheck", result: { ok: false, reasonCode: "entities_not_in_evidence" } }] };
  await recordKnowledgeGap({ agentResult, message: "Can registered office be changed later?", classification: { intents: ["company_formation"] }, userId: "u" }, deps(store));
  const payload = store.calls[0];
  assert.equal(payload.reason, "weak_retrieval");
  assert.equal(payload.topChunks[0].id, evidence[0].sourceRef);
  assert.equal(payload.candidateCount, 14);
  assert.deepEqual(payload.rerank, { ran: true, status: "reranked" });
});

test("prompt ceiling, provider and retrieval failures are system failures, never missing knowledge", async () => {
  for (const agentResult of [
    { outcome: "decision_failed", reason: "PROMPT_TOKEN_CEILING_EXCEEDED", steps: [] },
    { outcome: "knowledge_unavailable", reason: "RETRIEVAL_FAILED", steps: [searchStep({ ok: false, status: "error", reasonCode: "RETRIEVAL_FAILED" })] },
    { outcome: "validation_failed", reason: "grounding_review_failed", steps: [searchStep()] }
  ]) {
    const store = stubStore();
    await recordKnowledgeGap({ agentResult, message: "How much does company registration cost?", classification: { intents: ["pricing", "company_formation"] }, userId: "u" }, deps(store));
    assert.equal(store.calls[0].reason, "system_failure", agentResult.reason);
  }
});

test("expired knowledge is classified from evidence past valid_until", async () => {
  const store = stubStore();
  const agentResult = { outcome: "response_rejected", reason: "no_approved_evidence", steps: [searchStep({ modelObservation: { status: "no_evidence", evidence: [],
    candidatePolicyEvidence: [{ sourceRef: "33333333-3333-4333-8333-333333333333", valid_until: "2026-09-01T00:00:00.000Z" }] } })] };
  await recordKnowledgeGap({ agentResult, message: "What is the price of the formation package?", classification: { intents: ["pricing"] }, userId: "u" },
    deps(store, { now: Date.parse("2026-10-28T00:00:00.000Z") }));
  assert.equal(store.calls[0].reason, "expired_knowledge");
});

test("greetings, small talk and grounded answers create no gap; unsupported requests are analytics only", async () => {
  const store = stubStore();
  assert.equal((await recordKnowledgeGap({ agentResult: { outcome: "responded", steps: [] }, message: "Hello!", socialOnlyTurn: true, classification: { intents: ["greeting"] } }, deps(store))).recorded, false);
  assert.equal((await recordKnowledgeGap({ agentResult: { outcome: "responded", steps: [searchStep({ status: "found", modelObservation: { status: "found", evidence: [{ sourceRef: "x" }] } })] },
    message: "What services do you offer?", classification: { intents: ["services"] } }, deps(store))).recorded, false);
  assert.equal(store.calls.length, 0);
  await recordKnowledgeGap({ agentResult: { outcome: "clarify_rejected", steps: [] }, message: "Give me another customer's phone number", classification: { intents: ["privacy"] }, userId: "u" }, deps(store));
  assert.equal(store.calls[0].reason, "unsupported_request");
  assert.equal(store.calls[0].analyticsOnly, true);
});

test("personal data is redacted from every stored text field", async () => {
  const store = stubStore();
  const message = "Hi, my name is Jane Smith, email jane@example.com, phone +357 99 123456, passport K1234567. Can I change my company address to 12 Makarios Avenue?";
  await recordKnowledgeGap({ agentResult: { outcome: "response_rejected", reason: "no_approved_evidence", steps: [searchStep({ }), { tool: "responsePolicyCheck", result: { reasonCode: "no_approved_evidence" } }].map((step, index) =>
    index === 0 ? { ...step, args: { query: "address change for jane@example.com +357 99 123456" }, result: { ...step.result, trace: { searchQueries: ["jane@example.com address change"] } } } : step) },
  message, classification: { intents: ["company_formation"] }, userId: "35799123456@s.whatsapp.net" }, deps(store));
  const payload = store.calls[0];
  const stored = JSON.stringify({ q: payload.question, s: payload.searchQuery, qs: payload.searchQueries });
  for (const leak of ["Jane Smith", "jane@example.com", "99 123456", "K1234567", "Makarios"]) assert.equal(stored.includes(leak), false, leak);
  assert.match(payload.question, /change my company address/u);
});

test("identical failures from one conversation are rate limited", async () => {
  const store = stubStore();
  const limiter = createLocalRateLimiter({ windowMs: 60000, clock: () => 1000 });
  const input = { agentResult: { outcome: "response_rejected", reason: "no_approved_evidence", steps: [searchStep()] }, message: "Can I pay in installments?", classification: { intents: ["pricing"] }, userId: "same" };
  await recordKnowledgeGap(input, deps(store, { rateLimiter: limiter }));
  const second = await recordKnowledgeGap(input, deps(store, { rateLimiter: limiter }));
  assert.equal(second.skip, "rate_limited");
  await recordKnowledgeGap({ ...input, userId: "other" }, deps(store, { rateLimiter: limiter }));
  assert.equal(store.calls.length, 2);
});

test("flag off (default) schedules nothing; flag on schedules without awaiting or throwing", async () => {
  const store = stubStore();
  assert.equal(knowledgeGapsEnabled({}), false);
  assert.equal(scheduleKnowledgeGapRecording({ agentResult: { outcome: "decision_failed" } }, { store, env: {} }), false);
  const throwing = { recordKnowledgeGapEvent: () => { throw new Error("boom"); } };
  let settled;
  const done = new Promise((resolve) => { settled = resolve; });
  const scheduled = scheduleKnowledgeGapRecording({ agentResult: { outcome: "decision_failed", reason: "PROMPT_TOKEN_CEILING_EXCEEDED", steps: [] }, message: "Price?", userId: "u" },
    { store: throwing, env: { RAFA_KNOWLEDGE_GAPS: "on" }, logEvent: async () => { throw new Error("log down"); }, onSettled: settled });
  assert.equal(scheduled, true);
  const outcome = await done;
  assert.equal(outcome.recorded, false);
  assert.equal(store.calls.length, 0);
});

test("signal extraction ignores skipped repeat searches and reads policy rejections", () => {
  const signals = extractGapSignals({ outcome: "responded", corrected: true, steps: [searchStep(), { tool: "searchApprovedKnowledge", result: { ok: false, status: "skipped" } },
    { tool: "responsePolicyCheck", result: { reasonCode: "no_approved_evidence,question_not_answered" } }] });
  assert.equal(signals.searches.length, 1);
  assert.deepEqual(signals.rejectionCodes, ["no_approved_evidence", "question_not_answered"]);
  assert.equal(signals.corrected, true);
});

// --- through the real live turn composition --------------------------------

function liveStore({ recordImpl } = {}) {
  const user = { id: "synthetic-gap-user", profile: {}, history: [] };
  let serial = 0;
  const recordCalls = [];
  const store = {
    ensureUser: async () => user, getUser: async () => user, updateUser: async (_id, update) => update(user),
    addHistory: async (_id, message, response, extra) => { const turn = { id: `turn-${++serial}`, message, response, metadata: extra?.metadata || {} }; user.history.push(turn); return turn; },
    updateHistoryTurn: async (_id, turnId, patch) => Object.assign(user.history.find((item) => item.id === turnId), patch),
    saveQualification: async () => {}, saveIntents: async () => {}, searchKnowledge: async () => [],
    recordKnowledgeGapEvent: async (payload) => { recordCalls.push(payload); return recordImpl(payload); }
  };
  return { store, recordCalls };
}

async function liveTurn(store, logs, sent) {
  return realRun({ socket: {}, chatId: "synthetic-chat", userId: "synthetic-gap-user", text: "Can I change my company address?" }, {
    store,
    logEvent: async (event, fields) => { logs.push([event, fields]); if (event.startsWith("knowledge_gap")) throw new Error("telemetry down"); },
    setTyping: async () => {},
    sendStoredTextReply: async (_socket, _chat, response) => { sent.push(response); },
    embedText: async () => [0.1],
    preflightOptions: { classifyMessage: async () => ({ source: "contextual_model", intents: ["company_formation"], language: "english", operation: "none", offerSourceTurnId: null, noProactiveBookingOrContact: false }) },
    agentOptions: { assessDraft: require("../scripts/helpers/scriptedGrounding").scriptedGrounding,
      decideNextStep: async () => { throw Object.assign(new Error("ceiling"), { code: "PROMPT_TOKEN_CEILING_EXCEEDED" }); } }
  });
}

test("a failing gap store and failing gap telemetry never change or delay the customer response", async () => {
  const previous = process.env.RAFA_KNOWLEDGE_GAPS;
  try {
    process.env.RAFA_KNOWLEDGE_GAPS = "off";
    const baseline = liveStore({ recordImpl: () => ({}) });
    const baselineSent = [];
    const baselineResult = await liveTurn(baseline.store, [], baselineSent);

    process.env.RAFA_KNOWLEDGE_GAPS = "on";
    const failing = liveStore({ recordImpl: () => { throw Object.assign(new Error("gap store down"), { code: "GAP_STORE_DOWN" }); } });
    const sent = [];
    const logs = [];
    const result = await liveTurn(failing.store, logs, sent);
    assert.deepEqual(result, baselineResult, "same turn result with recording on and failing");
    assert.deepEqual(sent, baselineSent, "same customer text");
    assert.equal(failing.recordCalls.length, 0, "recording has not run yet when the turn returns: it is never awaited");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(baseline.recordCalls.length, 0, "flag off records nothing");
    assert.equal(failing.recordCalls.length, 1, "flag on attempted one background record after delivery");
    assert.equal(failing.recordCalls[0].reason, "system_failure");
    assert.ok(logs.some(([event]) => event === "agent_turn_completed"));
  } finally {
    if (previous === undefined) delete process.env.RAFA_KNOWLEDGE_GAPS; else process.env.RAFA_KNOWLEDGE_GAPS = previous;
  }
});
