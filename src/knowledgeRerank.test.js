const test = require("node:test");
const assert = require("node:assert/strict");
const { rerankConfig, rerankQuestion, orderByScores, rerankSections, createKnowledgeReranker } = require("./knowledgeRerank");
const { searchApprovedKnowledge } = require("./agentTools");
const { SUPPORT_INTENTS, detectSupportIntent } = require("./knowledgeIntents");
const { RETRIEVAL_REGRESSION_SET } = require("./retrievalRegressionSet");

test("reranking is off unless explicitly enabled, and its knobs are bounded", () => {
  assert.equal(rerankConfig({}).enabled, false);
  assert.equal(createKnowledgeReranker({}), null);
  assert.equal(rerankConfig({ RAFA_KNOWLEDGE_RERANK: "ON" }).enabled, true);
  assert.equal(rerankConfig({ RAFA_KNOWLEDGE_RERANK: "true" }).enabled, false);
  const c = rerankConfig({ RAFA_KNOWLEDGE_RERANK_POOL: "500", RAFA_KNOWLEDGE_RERANK_TIMEOUT_MS: "1", RAFA_KNOWLEDGE_RERANK_THREADS: "x", RAFA_KNOWLEDGE_RERANK_CANDIDATES: "999" });
  assert.deepEqual([c.poolSize, c.timeoutMs, c.threads, c.candidateCount], [50, 500, 4, 50]);
  assert.deepEqual([rerankConfig({}).poolSize, rerankConfig({}).candidateCount], [30, 40]);
});

test("the store asks for the wider v2 window only when a candidate count is given", async () => {
  const { EdgeApiStore } = require("./supabaseStore");
  const bodies = [];
  const store = Object.create(EdgeApiStore.prototype);
  store.request = async (_path, init) => { bodies.push(JSON.parse(init.body)); return { results: [] }; };
  await store.searchKnowledge("q", null, null, 6);
  await store.searchKnowledge("q", null, null, 6, { candidateCount: 40 });
  assert.equal(Object.hasOwn(bodies[0], "candidateCount"), false);
  assert.equal(bodies[1].candidateCount, 40);
});

test("with a reranker the agent search requests the reranker's candidate window", async () => {
  const seen = [];
  const store = { searchKnowledge: async (...args) => { seen.push(args[4]); return []; } };
  await searchApprovedKnowledge({ query: "q" }, { store, embedText: async () => null, matchCount: 8, currentMessage: "q",
    knowledgeReranker: { config: { candidateCount: 40 }, rerank: async (_q, sections) => ({ sections, status: "skipped" }) } });
  await searchApprovedKnowledge({ query: "q" }, { store, embedText: async () => null, matchCount: 8, currentMessage: "q" });
  assert.deepEqual(seen, [{ candidateCount: 40 }, undefined]);
});

test("the rerank question keeps the customer's words and adds the resolved query only when it adds context", () => {
  assert.equal(rerankQuestion("هل تضمنون تسجيل الشركة؟", "هل تضمنون تسجيل الشركة؟"), "هل تضمنون تسجيل الشركة؟");
  assert.equal(rerankQuestion("and how long?", "company registration timeline"), "and how long?\ncompany registration timeline");
  assert.equal(rerankQuestion("", "resolved"), "resolved");
});

test("only the pool is re-ordered by score; ties keep first-stage order; the tail is untouched", () => {
  const { items, scores } = orderByScores(["a", "b", "c", "d", "e"], [0.1, 0.9, 0.9, -1], 4);
  assert.deepEqual(items, ["b", "c", "a", "d", "e"]);
  assert.deepEqual(scores, [0.9, 0.9, 0.1, -1, null]);
  assert.throws(() => orderByScores(["a", "b"], [1, Number.NaN], 2));
});

test("rerankSections fails open: timeouts, errors and bad scorer output keep the first-stage order", async () => {
  const sections = [{ title: "x", content: "1" }, { title: "y", content: "2" }, { title: "z", content: "3" }];
  const ok = await rerankSections("q", sections, { poolSize: 3, scorer: async () => [0, 2, 1] });
  assert.equal(ok.status, "reranked");
  assert.deepEqual(ok.sections.map((s) => s.title), ["y", "z", "x"]);

  const timeout = await rerankSections("q", sections, { poolSize: 3, scorer: async () => { throw Object.assign(new Error("slow"), { code: "RERANK_TIMEOUT" }); } });
  assert.equal(timeout.status, "timeout");
  assert.equal(timeout.sections, sections);

  const broken = await rerankSections("q", sections, { poolSize: 3, scorer: async () => [1] });
  assert.equal(broken.status, "error");
  assert.equal(broken.sections, sections);

  const skipped = await rerankSections("", sections, { scorer: async () => assert.fail("must not score without a question") });
  assert.equal(skipped.status, "skipped");
});

test("the scorer sees the full section text, title first", async () => {
  let seen;
  await rerankSections("q", [{ title: "T1", section: "T1", content: "body one" }, { title: "T2", section: "S2", content: "body two" }],
    { scorer: async (_q, passages) => { seen = passages; return [0, 0]; } });
  assert.deepEqual(seen, ["T1\nbody one", "T2\nS2\nbody two"]);
});

// --- integration with the agent search tool ---------------------------------

const row = (id, rank) => ({ source_id: id, document_id: id, chunk_id: `${id}-chunk`, chunk_index: 0,
  document_title: id, heading: id, content: `${id} approved section`, review_status: "approved", rank });

test("with a reranker, the agent receives sections in cross-encoder order", async () => {
  const store = { searchKnowledge: async () => [row("near-words", 3), row("generic", 2), row("guarantee-answer", 1)] };
  const reranker = { rerank: (question, sections) => rerankSections(question, sections, {
    scorer: async (_q, passages) => passages.map((p) => (p.startsWith("guarantee-answer") ? 5 : 0)) }) };
  const result = await searchApprovedKnowledge({ query: "هل تضمنون تسجيل الشركة؟" }, {
    store, embedText: async () => null, matchCount: 8, currentMessage: "هل تضمنون تسجيل الشركة؟", knowledgeReranker: reranker });
  assert.equal(result.modelObservation.evidence[0].title, "guarantee-answer");
  assert.equal(result.trace.selectionStatus, "cross_encoder_reranked_bounded");
  assert.equal(result.trace.rerank.status, "reranked");
});

test("without a reranker the existing retrieval path and trace are unchanged", async () => {
  const store = { searchKnowledge: async () => [row("first", 3), row("second", 2)] };
  const result = await searchApprovedKnowledge({ query: "q" }, { store, embedText: async () => null, matchCount: 8, currentMessage: "q" });
  assert.equal(result.modelObservation.evidence[0].title, "first");
  assert.equal(result.trace.selectionStatus, "retrieval_ranked_bounded");
  assert.equal(Object.hasOwn(result.trace, "rerank"), false);
});

test("a failing reranker leaves the first-stage order in place", async () => {
  const store = { searchKnowledge: async () => [row("first", 3), row("second", 2)] };
  const reranker = { rerank: (question, sections) => rerankSections(question, sections, { scorer: async () => { throw new Error("model missing"); } }) };
  const result = await searchApprovedKnowledge({ query: "q" }, { store, embedText: async () => null, matchCount: 8, currentMessage: "q", knowledgeReranker: reranker });
  assert.equal(result.modelObservation.evidence[0].title, "first");
  assert.equal(result.trace.rerank.status, "error");
  assert.equal(result.trace.selectionStatus, "retrieval_ranked_bounded");
});

test("a detected support intent adds exactly one extra semantic probe with the intent embedding", async () => {
  const unit = (i) => { const v = new Array(8).fill(0); v[i] = 1; return v; };
  const guaranteeIndex = SUPPORT_INTENTS.findIndex((p) => p.id === "guarantee");
  const embedText = async (text) => {
    const profile = SUPPORT_INTENTS.findIndex((p) => p.text === text);
    return profile >= 0 ? unit(profile) : unit(guaranteeIndex); // the question sits on the guarantee profile
  };
  const calls = [];
  const store = { searchKnowledge: async (query, embedding) => { calls.push({ query, embedding }); return [row("a", 1)]; } };
  const reranker = { rerank: (question, sections) => rerankSections(question, sections, { scorer: async (_q, p) => p.map(() => 0) }) };
  const result = await searchApprovedKnowledge({ query: "q" }, { store, embedText, matchCount: 8, currentMessage: "q", knowledgeReranker: reranker });
  assert.equal(result.trace.supportIntent, "guarantee");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].embedding, unit(guaranteeIndex));
});

test("intent detection needs both similarity and a margin over the runner-up", () => {
  const profiles = [{ id: "a", embedding: [1, 0, 0] }, { id: "b", embedding: [0, 1, 0] }];
  assert.equal(detectSupportIntent([0.95, 0.1, 0.1], profiles)?.id, "a");
  assert.equal(detectSupportIntent([0.7, 0.7, 0.1], profiles), null);   // ambiguous
  assert.equal(detectSupportIntent([0.5, 0.1, 0.8], profiles), null);   // not close to any
});

test("intent descriptions never contain regression-set wording, so the set measures meaning", () => {
  const normalize = (s) => s.replace(/[؟?.,،!]/gu, "").trim();
  for (const c of RETRIEVAL_REGRESSION_SET) {
    for (const intent of SUPPORT_INTENTS) assert.equal(intent.text.includes(normalize(c.query)), false, `${intent.id} contains ${c.id}`);
  }
});

test("the regression set carries the required guarantee paraphrases in Arabic and English", () => {
  const required = ["هل تضمنون تسجيل الشركة؟", "هل تسجيل الشركة مضمون؟", "هل أكيد الشركة تنسجل؟", "شو بصير إذا رفضوا تسجيل الشركة؟",
    "هل ممكن طلب تأسيس الشركة ينرفض؟", "في ضمان إن الشركة تنفتح؟", "بتضمنولي الموافقة على الشركة؟", "Is company registration guaranteed?",
    "Do you guarantee the company will be approved?", "Can my company registration be rejected?", "What happens if incorporation is not approved?", "Is approval guaranteed?"];
  const guarantee = RETRIEVAL_REGRESSION_SET.filter((c) => c.group === "guarantee");
  for (const q of required) assert.ok(guarantee.some((c) => c.query === q && c.primary === "RF-KB-045"), q);
  assert.equal(new Set(RETRIEVAL_REGRESSION_SET.map((c) => c.id)).size, RETRIEVAL_REGRESSION_SET.length);
});
