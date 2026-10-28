"use strict";

// Knowledge Gaps: regression tests built from resolved/linked gaps, and the
// automatic resolution verification that runs them through the REAL agent
// search tool (src/agentTools.js searchApprovedKnowledge).
//
// Used by dashboard/knowledgeGapsAdmin.js (verify before Resolved/Verified) and
// by scripts/evaluateSemanticRetrieval.js --gap-tests <file> (the exported
// tests run alongside the static retrieval regression set).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function uuids(value) {
  return [...new Set((Array.isArray(value) ? value : []).filter((id) => typeof id === "string" && UUID.test(id)).map((id) => id.toLowerCase()))];
}

// Rank (1-based) of the first evidence SECTION that matches an expected chunk,
// document or source, in the order the agent hands evidence to the model.
// Matching by document/source as well as chunk keeps a test valid after the
// knowledge entry is revised (a new revision gets new chunk ids).
function gapEvidenceRank(result, { chunkIds = [], documentIds = [], sourceIds = [] } = {}) {
  const chunks = new Set(uuids(chunkIds));
  const documents = new Set(uuids(documentIds));
  const sources = new Set(uuids(sourceIds));
  const rows = Array.isArray(result?.data) ? result.data : [];
  const sectionOrder = [];
  for (const row of rows) {
    const key = row?.document_id && row?.section_index !== undefined && row?.section_index !== null
      ? `${row.document_id}:${row.section_index}` : `chunk:${row?.chunk_id || sectionOrder.length}`;
    let section = sectionOrder.find((item) => item.key === key);
    if (!section) { section = { key, rows: [] }; sectionOrder.push(section); }
    section.rows.push(row);
  }
  const index = sectionOrder.findIndex((section) => section.rows.some((row) =>
    chunks.has(String(row?.chunk_id || "").toLowerCase()) || documents.has(String(row?.document_id || "").toLowerCase())
    || sources.has(String(row?.source_id || "").toLowerCase())));
  return index >= 0 ? index + 1 : null;
}

function normalizeRegressionTest(raw = {}) {
  const query = typeof raw.query === "string" ? raw.query.trim().slice(0, 500) : "";
  const expected = {
    chunkIds: uuids(raw.expected_chunk_ids ?? raw.expectedChunkIds),
    documentIds: uuids(raw.expected_document_ids ?? raw.expectedDocumentIds),
    sourceIds: uuids(raw.expected_source_ids ?? raw.expectedSourceIds)
  };
  const minRank = Number.isInteger(raw.expected_min_rank ?? raw.expectedMinRank) ? Math.min(16, Math.max(1, raw.expected_min_rank ?? raw.expectedMinRank)) : 5;
  if (!query || expected.chunkIds.length + expected.documentIds.length + expected.sourceIds.length === 0) return null;
  return {
    id: String(raw.id || ""), groupId: String(raw.group_id || raw.groupId || ""), query,
    language: ["en", "ar", "el"].includes(raw.language) ? raw.language : "und",
    expected, minRank, expectedBehavior: raw.expected_behavior || raw.expectedBehavior || "grounded_answer",
    active: raw.active !== false
  };
}

// Validates an exported JSON array (dashboard GET /api/knowledge-gaps/regression-tests/export).
function loadGapRegressionCases(json) {
  const list = Array.isArray(json) ? json : Array.isArray(json?.tests) ? json.tests : [];
  return list.map(normalizeRegressionTest).filter((test) => test && test.active);
}

function languageName(code) {
  return code === "ar" ? "arabic" : code === "el" ? "greek" : "english";
}

// search(test) must call the real searchApprovedKnowledge and return its result.
async function runGapRegressionTest(test, { search }) {
  const normalized = test?.expected ? test : normalizeRegressionTest(test);
  if (!normalized) return { id: String(test?.id || ""), result: "error", rank: null, details: { error: "invalid_test" } };
  try {
    const result = await search(normalized);
    if (result?.status === "error") {
      return { id: normalized.id, result: "error", rank: null, details: { status: "error", reasonCode: String(result.reasonCode || "").slice(0, 60) } };
    }
    const rank = gapEvidenceRank(result, normalized.expected);
    const pass = normalized.expectedBehavior === "grounded_answer" ? rank !== null && rank <= normalized.minRank : rank === null;
    return { id: normalized.id, result: pass ? "pass" : "fail", rank,
      details: { minRank: normalized.minRank, returnedSections: Array.isArray(result?.data) ? new Set(result.data.map((row) => `${row?.document_id}:${row?.section_index}`)).size : 0,
        status: String(result?.status || ""), rerank: result?.trace?.rerank?.status || null } };
  } catch (error) {
    return { id: normalized.id, result: "error", rank: null, details: { error: String(error?.code || error?.name || "search_failed").slice(0, 60) } };
  }
}

// Retrieval verification is mandatory before Resolved/Verified. The agent /
// grounding verification hook is optional: without a configured verifier it
// reports not_run (it needs a live model key, which this runtime may not have).
async function verifyGapResolution(tests, { search, agentVerifier = null } = {}) {
  const normalized = (Array.isArray(tests) ? tests : []).map((test) => test?.expected ? test : normalizeRegressionTest(test)).filter((test) => test && test.active);
  const results = [];
  for (const test of normalized) results.push(await runGapRegressionTest(test, { search }));
  const retrievalPassed = results.length > 0 && results.every((item) => item.result === "pass");
  let agent = { status: "not_run", reason: "no_agent_verifier_configured" };
  if (typeof agentVerifier === "function" && retrievalPassed) {
    try {
      const verdict = await agentVerifier(normalized);
      agent = { status: verdict?.passed === true ? "pass" : "fail", details: verdict?.details || null };
    } catch (error) {
      agent = { status: "error", reason: String(error?.code || error?.name || "agent_verifier_failed").slice(0, 60) };
    }
  }
  return { ran: results.length, passed: retrievalPassed && agent.status !== "fail" && agent.status !== "error", retrievalPassed, results, agent };
}

// Adapter: a search function bound to the real tool with production-like
// arguments (the customer's own words as both query and current message, the
// hardest retrieval case, same as scripts/evaluateSemanticRetrieval.js).
function createGapSearch({ searchApprovedKnowledge, store, embedText, embeddingModel, knowledgeReranker = null, matchCount = 16 }) {
  return (test) => searchApprovedKnowledge({ query: test.query }, {
    store, embedText, embeddingModel, matchCount, language: languageName(test.language), currentMessage: test.query,
    user: { history: [] }, intents: [], knowledgeReranker
  });
}

module.exports = {
  gapEvidenceRank,
  normalizeRegressionTest,
  loadGapRegressionCases,
  runGapRegressionTest,
  verifyGapResolution,
  createGapSearch
};
