"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { gapEvidenceRank, loadGapRegressionCases, verifyGapResolution, createGapSearch, runGapRegressionTest } = require("./knowledgeGapRegression");
const { searchApprovedKnowledge } = require("./agentTools");

const DOC_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DOC_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CHUNK_B1 = "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1";
const SOURCE_B = "5b5b5b5b-5b5b-45b5-85b5-5b5b5b5b5b5b";

function row(document, section, chunk, source = null, content = "Approved company information about registered office changes and filings.") {
  return { document_id: document, section_index: section, chunk_id: chunk, source_id: source || document, document_title: "Doc", heading: "Section", content,
    review_status: "approved", enabled: true, rank: 1 };
}

test("evidence rank counts sections in agent order and matches chunk, document or source ids", () => {
  const result = { data: [row(DOC_A, 0, "a0000000-0000-4000-8000-000000000001"), row(DOC_A, 0, "a0000000-0000-4000-8000-000000000002"), row(DOC_B, 1, CHUNK_B1, SOURCE_B)] };
  assert.equal(gapEvidenceRank(result, { chunkIds: [CHUNK_B1] }), 2);
  assert.equal(gapEvidenceRank(result, { documentIds: [DOC_A] }), 1);
  assert.equal(gapEvidenceRank(result, { sourceIds: [SOURCE_B] }), 2, "a revised entry still matches by source");
  assert.equal(gapEvidenceRank(result, { chunkIds: ["cccccccc-cccc-4ccc-8ccc-cccccccccccc"] }), null);
});

test("exported regression tests load for the retrieval evaluation and skip invalid or inactive ones", () => {
  const cases = loadGapRegressionCases({ tests: [
    { id: "t1", group_id: "g", query: "Can I change my company address?", language: "en", expected_chunk_ids: [CHUNK_B1], expected_min_rank: 3, active: true },
    { id: "t2", query: "", expected_chunk_ids: [CHUNK_B1] },
    { id: "t3", query: "x", expected_chunk_ids: [] },
    { id: "t4", query: "y", expected_document_ids: [DOC_A], active: false }
  ] });
  assert.equal(cases.length, 1);
  assert.equal(cases[0].minRank, 3);
});

test("resolution verification runs through the REAL searchApprovedKnowledge and requires the expected chunk within rank", async () => {
  const tests = [{ id: "t1", query: "Can I change my company address?", language: "en", expected_chunk_ids: [CHUNK_B1], expected_min_rank: 1 }];
  const storeWith = (rows) => ({ searchKnowledge: async () => rows });
  const passSearch = createGapSearch({ searchApprovedKnowledge, store: storeWith([row(DOC_B, 1, CHUNK_B1, SOURCE_B), row(DOC_A, 0, "a0000000-0000-4000-8000-000000000001")]), embedText: null, embeddingModel: "test" });
  const pass = await verifyGapResolution(tests, { search: passSearch });
  assert.equal(pass.retrievalPassed, true);
  assert.equal(pass.results[0].rank, 1);
  assert.equal(pass.agent.status, "not_run", "agent verification needs a live key and is reported as not run");
  assert.equal(pass.passed, true);

  const failSearch = createGapSearch({ searchApprovedKnowledge, store: storeWith([row(DOC_A, 0, "a0000000-0000-4000-8000-000000000001"), row(DOC_B, 1, CHUNK_B1, SOURCE_B)]), embedText: null, embeddingModel: "test" });
  const fail = await verifyGapResolution(tests, { search: failSearch });
  assert.equal(fail.passed, false, "ranked 2 against a minimum of 1 keeps the gap open");
  assert.equal(fail.results[0].rank, 2);

  const missing = await verifyGapResolution(tests, { search: createGapSearch({ searchApprovedKnowledge, store: storeWith([]), embedText: null, embeddingModel: "test" }) });
  assert.equal(missing.passed, false);
  assert.equal(missing.results[0].result, "fail");

  const broken = await runGapRegressionTest(tests[0], { search: createGapSearch({ searchApprovedKnowledge, store: { searchKnowledge: async () => { throw new Error("down"); } }, embedText: null }) });
  assert.equal(broken.result, "error");
});

test("the agent verification hook runs only after retrieval passes and can veto", async () => {
  const tests = [{ id: "t1", query: "q", expected_document_ids: [DOC_B], expected_min_rank: 5 }];
  const search = async () => ({ status: "found", data: [row(DOC_B, 0, CHUNK_B1)] });
  const vetoed = await verifyGapResolution(tests, { search, agentVerifier: async () => ({ passed: false, details: { reason: "stub" } }) });
  assert.equal(vetoed.retrievalPassed, true);
  assert.equal(vetoed.agent.status, "fail");
  assert.equal(vetoed.passed, false);
  const approved = await verifyGapResolution(tests, { search, agentVerifier: async () => ({ passed: true }) });
  assert.equal(approved.passed, true);
  assert.equal((await verifyGapResolution([], { search })).passed, false, "no tests never counts as verified");
});
