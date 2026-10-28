import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { anonymousConversationLabel, gapDiagnostics, knowledgeGapsDashboardEnabled, registerKnowledgeGapAdminRoutes } from "./knowledgeGapsAdmin.js";

const NOW = new Date("2026-10-28T12:00:00.000Z");
const GROUP_ID = "11111111-1111-4111-8111-111111111111";
const CHUNK_ID = "22222222-2222-4222-8222-222222222222";
const DOC_ID = "33333333-3333-4333-8333-333333333333";
const SOURCE_ID = "44444444-4444-4444-8444-444444444444";
const CONTACT = "55555555-5555-4555-8555-555555555555";

function group(overrides = {}) {
  return { id: GROUP_ID, title: "Can I change my company address?", summary: "", category: "corporate", intent: "company_formation", reason: "missing_knowledge",
    status: "open", priority_override: null, owner: null, occurrence_count: 6, suppressed_count: 1, no_safe_answer_count: 6, languages: ["ar", "en"],
    example_questions: [{ question: "Can I change my company address?", language: "en" }, { question: "هل أقدر أغير عنوان الشركة؟", language: "ar" }],
    sensitive_topics: [], blocking: true, analytics_only: false, resolution: {}, resolved_at: null, first_seen_at: "2026-10-20T10:00:00.000Z",
    last_seen_at: "2026-10-28T09:00:00.000Z", ...overrides };
}

function fakeRest({ groupRow = group(), tests = [], chunks = null } = {}) {
  const calls = [];
  const rest = async (path, options = {}) => {
    calls.push([path, options.body ? JSON.parse(options.body) : null]);
    if (path.startsWith("rafa_knowledge_gap_groups?id=eq.")) return [groupRow];
    if (path.startsWith("rafa_knowledge_gap_groups?")) return [groupRow, group({ id: "66666666-6666-4666-8666-666666666666", title: "Do you accept bitcoin?", category: "pricing", status: "ignored", reason: "unsupported_request", analytics_only: true, occurrence_count: 2, blocking: false, example_questions: [{ question: "Do you accept bitcoin?", language: "en" }] })];
    if (path.startsWith("rafa_knowledge_gap_group_stats")) return [{ group_id: GROUP_ID, last_7_days: 6, previous_7_days: 0, distinct_contacts: 4, no_safe_answer_events: 6 }];
    if (path.startsWith("rafa_knowledge_gap_links")) return [];
    if (path.startsWith("rafa_knowledge_gap_events")) return [{ id: "e1", occurred_at: "2026-10-28T09:00:00.000Z", contact_id: CONTACT, question_redacted: "Can I change my company address?", search_ran: true, top_chunks: [], candidate_ids: [], rejection_reasons: ["no_approved_evidence"], reason: "missing_knowledge", search_queries: ["company address change"], rerank: {}, response_type: "safe_fallback", model: "m", outcome: "response_rejected", prompt_version: "1.15.0" }];
    if (path.startsWith("rafa_knowledge_gap_regression_tests")) return tests;
    if (path.startsWith("rafa_knowledge_gap_audit")) return [];
    if (path.startsWith("rafa_knowledge_chunks")) return chunks ?? [{ id: CHUNK_ID, document_id: DOC_ID, heading: "Registered office", rafa_knowledge_documents: { source_id: SOURCE_ID, title: "Company changes", review_status: "approved" } }];
    if (path === "rpc/rafa_record_knowledge_gap_verification") { const body = JSON.parse(options.body); return { status: body.p_new_status || groupRow.status }; }
    if (path.startsWith("rpc/")) return { status: "ok", linksAdded: 1, testsUpserted: 2 };
    throw new Error(`unexpected ${path}`);
  };
  return { rest, calls };
}

async function withApp({ env = { RAFA_KNOWLEDGE_GAPS: "on" }, rest, createVerifier = null } = {}, run) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.dashboardUser = req.get("x-test-user") === "user" ? { id: "u", email: "user@refalco.com", role: "user" } : { id: "a", email: "admin@refalco.com", role: "admin" };
    next();
  });
  const requireAdmin = (req, res, next) => req.dashboardUser.role === "admin" ? next() : res.status(403).json({ error: "Administrator access is required." });
  registerKnowledgeGapAdminRoutes(app, { requireAdmin, supabaseRest: rest, env, now: () => new Date(NOW), createVerifier });
  const server = await new Promise((resolve) => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run((path, options = {}) => fetch(`${base}${path}`, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } })); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test("feature flag hides every route except config", async () => {
  assert.equal(knowledgeGapsDashboardEnabled({}), false);
  assert.equal(knowledgeGapsDashboardEnabled({ RAFA_KNOWLEDGE_GAPS: "on" }), true);
  assert.equal(knowledgeGapsDashboardEnabled({ RAFA_KNOWLEDGE_GAPS: "on", RAFA_KNOWLEDGE_GAPS_DASHBOARD: "off" }), false);
  const { rest, calls } = fakeRest();
  await withApp({ env: {}, rest }, async (request) => {
    assert.equal((await request("/api/knowledge-gaps")).status, 404);
    assert.equal((await (await request("/api/knowledge-gaps/config")).json()).enabled, false);
  });
  assert.equal(calls.length, 0);
});

test("list returns computed priority, metrics and filters without raw contact ids", async () => {
  const { rest } = fakeRest();
  await withApp({ rest }, async (request) => {
    const body = await (await request("/api/knowledge-gaps?status=active", { headers: { "x-test-user": "user" } })).json();
    assert.equal(body.groups.length, 1, "ignored analytics-only gap filtered out of active");
    assert.equal(body.groups[0].priority, "high");
    assert.equal(body.metrics.openGaps, 1);
    assert.equal(body.metrics.questionsAffected, 6);
    assert.equal(body.metrics.trend.length, 14);
    const searched = await (await request("/api/knowledge-gaps?status=all&q=%D8%B9%D9%86%D9%88%D8%A7%D9%86")).json();
    assert.equal(searched.groups.length, 1, "search covers example questions in Arabic");
    const detail = await (await request(`/api/knowledge-gaps/${GROUP_ID}`)).json();
    assert.equal(JSON.stringify(detail).includes(CONTACT), false);
    assert.equal(detail.examples[0].conversation, anonymousConversationLabel(CONTACT));
    assert.equal(detail.diagnostics.hint.code, "missing_knowledge");
  });
});

test("actions need an administrator and an audit reason where required", async () => {
  const { rest, calls } = fakeRest();
  await withApp({ rest }, async (request) => {
    const denied = await request(`/api/knowledge-gaps/${GROUP_ID}/actions`, { method: "POST", headers: { "x-test-user": "user" }, body: JSON.stringify({ action: "ignore", reason: "noise" }) });
    assert.equal(denied.status, 403);
    const noReason = await request(`/api/knowledge-gaps/${GROUP_ID}/actions`, { method: "POST", body: JSON.stringify({ action: "ignore" }) });
    assert.equal(noReason.status, 400);
    const ok = await request(`/api/knowledge-gaps/${GROUP_ID}/actions`, { method: "POST", body: JSON.stringify({ action: "mark_agent_issue", reason: "Evidence was there" }) });
    assert.equal(ok.status, 200);
  });
  const rpc = calls.find(([path]) => path === "rpc/rafa_apply_knowledge_gap_action")[1];
  assert.deepEqual(rpc.p_patch, { status: "needs_agent_fix", reason: "agent_failure" });
  assert.equal(rpc.p_actor, "admin@refalco.com");
  assert.equal(rpc.p_expected_status, "open");
});

test("Create Knowledge returns a draft prefill only; nothing is written to the knowledge tables", async () => {
  const { rest, calls } = fakeRest();
  await withApp({ rest }, async (request) => {
    const body = await (await request(`/api/knowledge-gaps/${GROUP_ID}/actions`, { method: "POST", body: JSON.stringify({ action: "create_knowledge" }) })).json();
    assert.equal(body.prefill.gapId, GROUP_ID);
    assert.equal(body.prefill.title, "Can I change my company address?");
    assert.ok(body.prefill.content.includes(body.prefill.answerMarker));
    assert.deepEqual(body.prefill.questions, ["Can I change my company address?", "هل أقدر أغير عنوان الشركة؟"]);
  });
  assert.equal(calls.some(([path, payload]) => /rafa_knowledge_(sources|documents|chunks)|store_knowledge_revision/u.test(path) && payload), false);
});

test("linking existing knowledge stores references and turns the gap's questions into regression tests", async () => {
  const { rest, calls } = fakeRest();
  await withApp({ rest }, async (request) => {
    const response = await request(`/api/knowledge-gaps/${GROUP_ID}/actions`, { method: "POST", body: JSON.stringify({ action: "link_existing", chunkIds: [CHUNK_ID, CHUNK_ID], markWeakRetrieval: true, reason: "It existed" }) });
    assert.equal(response.status, 200);
  });
  const link = calls.find(([path]) => path === "rpc/rafa_link_knowledge_gap")[1];
  assert.equal(link.p_links.length, 1, "duplicate chunk ids collapse to one reference");
  assert.deepEqual(Object.keys(link.p_links[0]).sort(), ["chunk_id", "document_id", "label", "link_type", "source_id", "weak_retrieval"], "no content field is ever sent");
  assert.equal(link.p_tests.length, 2);
  assert.deepEqual(link.p_tests[0].expected_chunk_ids, [CHUNK_ID]);
  assert.equal(link.p_tests[1].language, "ar");
  assert.deepEqual(link.p_patch, { status: "needs_retrieval_fix", reason: "weak_retrieval" });

  const pending = fakeRest({ chunks: [{ id: CHUNK_ID, document_id: DOC_ID, rafa_knowledge_documents: { source_id: SOURCE_ID, review_status: "pending" } }] });
  await withApp({ rest: pending.rest }, async (request) => {
    const response = await request(`/api/knowledge-gaps/${GROUP_ID}/actions`, { method: "POST", body: JSON.stringify({ action: "link_existing", chunkIds: [CHUNK_ID] }) });
    assert.equal(response.status, 409, "only approved knowledge links as existing");
  });
});

test("Resolve requires passing retrieval verification when knowledge is linked", async () => {
  const tests = [{ id: "77777777-7777-4777-8777-777777777777", query: "Can I change my company address?", language: "en", expected_chunk_ids: [CHUNK_ID], expected_min_rank: 3, active: true }];
  const verifierWith = (rank) => async () => ({ search: async () => ({ status: "found", data: rank ? Array.from({ length: rank }, (_v, i) => ({ document_id: `d${i}`, section_index: 0, chunk_id: i === rank - 1 ? CHUNK_ID : `c${i}` })) : [] }), agentVerifier: null });
  const failing = fakeRest({ groupRow: group({ status: "needs_retrieval_fix" }), tests });
  await withApp({ rest: failing.rest, createVerifier: verifierWith(5) }, async (request) => {
    const response = await request(`/api/knowledge-gaps/${GROUP_ID}/actions`, { method: "POST", body: JSON.stringify({ action: "resolve", reason: "Re-indexed" }) });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.verification.results[0].rank, 5);
  });
  const failRecord = failing.calls.find(([path]) => path === "rpc/rafa_record_knowledge_gap_verification")[1];
  assert.equal(failRecord.p_new_status, null, "a failed verification never changes the status");

  const passing = fakeRest({ groupRow: group({ status: "needs_retrieval_fix" }), tests });
  await withApp({ rest: passing.rest, createVerifier: verifierWith(2) }, async (request) => {
    const response = await request(`/api/knowledge-gaps/${GROUP_ID}/actions`, { method: "POST", body: JSON.stringify({ action: "resolve", reason: "Re-indexed" }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).verification.agent.status, "not_run");
  });
  assert.equal(passing.calls.find(([path]) => path === "rpc/rafa_record_knowledge_gap_verification")[1].p_new_status, "verified");
});

test("diagnostics separate weak retrieval, chunk needing improvement and agent logic", () => {
  const link = [{ chunk_id: CHUNK_ID, label: "Company changes", link_type: "existing" }];
  const base = { search_ran: true, reason: "weak_retrieval", rejection_reasons: ["entities_not_in_evidence"] };
  assert.equal(gapDiagnostics([{ ...base, top_chunks: [{ id: "other" }], candidate_ids: [] }], link).hint.code, "weak_retrieval");
  assert.equal(gapDiagnostics([{ ...base, top_chunks: [{ id: "other" }], candidate_ids: [CHUNK_ID] }], link).hint.label, "Weak retrieval (ranked too low)");
  assert.equal(gapDiagnostics([{ ...base, top_chunks: [{ id: CHUNK_ID, rank: 1 }], candidate_ids: [CHUNK_ID] }], link).hint.code, "chunk_needs_improvement");
  assert.equal(gapDiagnostics([{ ...base, rejection_reasons: ["context_mismatch", "language_mismatch"], top_chunks: [{ id: CHUNK_ID }] }], link).hint.code, "agent_logic");
  assert.equal(gapDiagnostics([{ search_ran: false, reason: "agent_failure", top_chunks: [] }], []).hint.code, "agent_logic");
  assert.equal(gapDiagnostics([{ search_ran: false, reason: "system_failure", top_chunks: [] }], []).hint.code, "system");
});
