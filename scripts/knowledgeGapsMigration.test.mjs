import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { updateCentroid, cosine } from "../supabase/functions/rafa-agent-api/knowledgeGapPolicy.mjs";

// Executes the Knowledge Gaps migration against an in-memory PGlite database
// (never a real environment): grants, RLS, atomic audit, rate limiting,
// centroid math parity with the JS policy, links without duplicate content.
const migration = await readFile("supabase/migrations/20261028130000_rafa_knowledge_gaps.sql", "utf8");
const SECRET_HEADERS = JSON.stringify({ "x-rafa-dashboard-secret": "test-secret" });
const unit = (values) => { const n = Math.hypot(...values); return values.map((v) => v / n); };
const vec = (seed) => unit(Array.from({ length: 384 }, (_v, i) => Math.sin(i * 0.11 * seed) + 0.3));
const pg = (values) => `{${values.join(",")}}`;

async function setup() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create function public.rafa_dashboard_secret_matches() returns boolean language sql stable set search_path = ''
      as $$ select coalesce(current_setting('request.headers', true)::jsonb ->> 'x-rafa-dashboard-secret' = 'test-secret', false) $$;
    grant execute on function public.rafa_dashboard_secret_matches() to anon;
    create table public.rafa_knowledge_documents (id uuid primary key default gen_random_uuid(), source_id uuid not null, title text not null default 'Doc',
      review_status text not null default 'approved', valid_until timestamptz);
    create table public.rafa_knowledge_chunks (id uuid primary key default gen_random_uuid(), document_id uuid not null references public.rafa_knowledge_documents(id),
      heading text not null default '', content text not null,
      search_vector tsvector generated always as (to_tsvector('simple', coalesce(heading, '') || ' ' || content)) stored);
    grant usage on schema public to anon, service_role;
    grant select, insert, update, delete on public.rafa_knowledge_documents, public.rafa_knowledge_chunks to service_role;
  `);
  await db.exec(migration);
  await db.exec(migration); // idempotent re-apply
  return db;
}

function event(overrides = {}) {
  return { contact_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", question_redacted: "Can I change my company address?", question_fingerprint: "0123456789abcdef",
    language: "en", reason: "missing_knowledge", category: "corporate", outcome: "response_rejected", search_ran: true, no_safe_answer: true, ...overrides };
}

async function record(db, { groupId = null, evt = event(), embedding = vec(1), newGroup = { title: "Can I change my company address?", category: "corporate", facets: ["change"], objects: ["company_address"] } } = {}) {
  const { rows: [row] } = await db.query("select public.rafa_record_knowledge_gap_event($1, $2, $3, $4::real[], 600) as r",
    [groupId, JSON.stringify(newGroup), JSON.stringify(evt), embedding ? pg(embedding) : null]);
  return row.r;
}

test("records, groups, rate-limits and keeps the centroid in step with the JS policy", async () => {
  const db = await setup();
  try {
    await db.exec("set role service_role");
    const first = await record(db);
    assert.equal(first.created, true);
    const again = await record(db, { groupId: null });
    assert.equal(again.suppressed, true, "same contact + same question inside the window is suppressed");
    const second = await record(db, { groupId: first.groupId, embedding: vec(2), evt: event({ contact_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", question_redacted: "هل أقدر أغير عنوان الشركة؟", question_fingerprint: "fedcba9876543210", language: "ar", reason: "weak_retrieval" }) });
    assert.equal(second.created, false);
    const third = await record(db, { groupId: first.groupId, embedding: vec(3), evt: event({ contact_id: null, question_fingerprint: "1111111111111111", reason: "weak_retrieval" }) });
    assert.equal(third.groupId, first.groupId);
    const { rows: [group] } = await db.query("select occurrence_count, suppressed_count, languages, reason, centroid, centroid_count, jsonb_array_length(example_questions) as examples from public.rafa_knowledge_gap_groups where id = $1", [first.groupId]);
    assert.equal(group.occurrence_count, 3);
    assert.equal(group.suppressed_count, 1);
    assert.deepEqual(group.languages, ["ar", "en"]);
    assert.equal(group.reason, "weak_retrieval", "reason follows the majority while not locked");
    assert.equal(group.centroid_count, 3);
    assert.equal(group.examples, 3);
    const expected = updateCentroid(updateCentroid(vec(1), 1, vec(2)), 2, vec(3));
    assert.ok(cosine(group.centroid, expected) > 0.99999, "SQL running mean matches updateCentroid");
    const { rows: matches } = await db.query("select id, similarity from public.rafa_match_knowledge_gap_groups($1::real[], 5)", [pg(vec(3))]);
    assert.equal(matches[0].id, first.groupId);
    assert.ok(Math.abs(matches[0].similarity - cosine(expected, vec(3))) < 1e-5, "match score is the centroid cosine");
    const { rows: [{ count }] } = await db.query("select count(*)::int as count from public.rafa_knowledge_gap_events where contact_id is null or contact_id is not null");
    assert.equal(count, 3);
  } finally { await db.close(); }
});

test("dashboard access needs the secret, actions are audited atomically, links copy no content and create regression tests", async () => {
  const db = await setup();
  try {
    await db.exec("set role service_role");
    const { groupId } = await record(db);
    const { rows: [doc] } = await db.query("insert into public.rafa_knowledge_documents(source_id) values (gen_random_uuid()) returning id, source_id");
    const { rows: [chunk] } = await db.query("insert into public.rafa_knowledge_chunks(document_id, content) values ($1, 'Registered office changes are filed with the registrar.') returning id", [doc.id]);
    await db.exec("reset role");
    const { rows: [privileges] } = await db.query(`select has_table_privilege('anon','public.rafa_knowledge_gap_events','insert') as anon_event_insert,
      has_table_privilege('anon','public.rafa_knowledge_gap_audit','update') as anon_audit_update,
      has_table_privilege('anon','public.rafa_knowledge_gap_groups','delete') as anon_group_delete,
      has_function_privilege('anon','public.rafa_record_knowledge_gap_event(uuid, jsonb, jsonb, real[], integer)','execute') as anon_record,
      has_table_privilege('authenticated','public.rafa_knowledge_gap_groups','select') as auth_select`);
    assert.deepEqual(privileges, { anon_event_insert: false, anon_audit_update: false, anon_group_delete: false, anon_record: false, auth_select: false });

    await db.exec("set role anon");
    await db.query("select set_config('request.headers', '{}', false)");
    assert.equal((await db.query("select count(*)::int as c from public.rafa_knowledge_gap_groups")).rows[0].c, 0, "no secret, no rows");
    await assert.rejects(db.query("select public.rafa_apply_knowledge_gap_action($1, 'open', 'start_review', 'admin@example.com', '', '{\"status\":\"reviewing\"}'::jsonb, '{}'::jsonb)", [groupId]));

    await db.query("select set_config('request.headers', $1, false)", [SECRET_HEADERS]);
    await assert.rejects(db.query("select public.rafa_apply_knowledge_gap_action($1, 'needs_knowledge', 'start_review', 'admin@example.com', '', '{}'::jsonb, '{}'::jsonb)", [groupId]), /status changed/u);
    await db.query("select public.rafa_apply_knowledge_gap_action($1, 'open', 'start_review', 'admin@example.com', 'Looking', '{\"status\":\"reviewing\"}'::jsonb, '{}'::jsonb)", [groupId]);

    const tests = [{ query: "Can I change my company address?", query_fingerprint: "0123456789abcdef", language: "en", expected_chunk_ids: [chunk.id], expected_min_rank: 5 }];
    const links = [{ chunk_id: chunk.id, document_id: doc.id, source_id: doc.source_id, link_type: "existing", weak_retrieval: true, label: "Doc" }];
    const linkSql = "select public.rafa_link_knowledge_gap($1, $2, $3::jsonb, $4::jsonb, 'link_existing', 'admin@example.com', 'Knowledge existed', $5::jsonb) as r";
    const { rows: [{ r: linked }] } = await db.query(linkSql, [groupId, "reviewing", JSON.stringify(links), JSON.stringify(tests), JSON.stringify({ status: "needs_retrieval_fix", reason: "weak_retrieval" })]);
    assert.equal(linked.linksAdded, 1);
    const { rows: [{ r: relinked }] } = await db.query(linkSql, [groupId, "needs_retrieval_fix", JSON.stringify([...links, ...links]), JSON.stringify(tests), "{}"]);
    assert.equal(relinked.linksAdded, 0);
    assert.equal(relinked.linksAlreadyPresent, 2, "the same chunk is never linked twice");
    await db.exec("reset role");
    const counts = (await db.query(`select (select count(*)::int from public.rafa_knowledge_documents) as docs, (select count(*)::int from public.rafa_knowledge_chunks) as chunks,
      (select count(*)::int from public.rafa_knowledge_gap_links) as links, (select count(*)::int from public.rafa_knowledge_gap_regression_tests) as tests,
      (select reason || ':' || reason_locked::text from public.rafa_knowledge_gap_groups) as reason`)).rows[0];
    assert.deepEqual(counts, { docs: 1, chunks: 1, links: 1, tests: 1, reason: "weak_retrieval:true" }, "linking adds references and tests only, never knowledge content");

    await db.exec("set role anon");
    await db.query("select set_config('request.headers', $1, false)", [SECRET_HEADERS]);
    const { rows: [{ id: testId }] } = await db.query("select id from public.rafa_knowledge_gap_regression_tests");
    const failing = await db.query("select public.rafa_record_knowledge_gap_verification($1, 'needs_retrieval_fix', $2::jsonb, 'admin@example.com', 'run', null) as r",
      [groupId, JSON.stringify([{ id: testId, result: "fail", rank: 9 }])]);
    assert.equal(failing.rows[0].r.status, "needs_retrieval_fix", "a failed verification keeps the gap open");
    const passing = await db.query("select public.rafa_record_knowledge_gap_verification($1, 'needs_retrieval_fix', $2::jsonb, 'admin@example.com', 'run', 'verified') as r",
      [groupId, JSON.stringify([{ id: testId, result: "pass", rank: 2 }])]);
    assert.equal(passing.rows[0].r.status, "verified");
    await db.exec("reset role");
    const { rows: [after] } = await db.query("select status, verified_at is not null as verified, resolved_by from public.rafa_knowledge_gap_groups");
    assert.deepEqual(after, { status: "verified", verified: true, resolved_by: "admin@example.com" });
    const { rows: [testRow] } = await db.query("select last_result, last_rank from public.rafa_knowledge_gap_regression_tests");
    assert.deepEqual(testRow, { last_result: "pass", last_rank: 2 });

    await db.exec("set role service_role");
    const reopened = await record(db, { groupId, evt: event({ contact_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }) });
    assert.equal(reopened.reopened, true, "a resolved gap reopens when the same question fails again");
    await db.exec("reset role");
    const actions = (await db.query("select action from public.rafa_knowledge_gap_audit order by created_at, action")).rows.map((row) => row.action);
    assert.ok(actions.includes("start_review") && actions.includes("link_existing") && actions.includes("verify") && actions.includes("auto_reopened"));
  } finally { await db.close(); }
});

test("expired-knowledge probe finds an expired approved revision only when no current revision exists", async () => {
  const db = await setup();
  try {
    const { rows: [expired] } = await db.query("insert into public.rafa_knowledge_documents(source_id, valid_until) values (gen_random_uuid(), now() - interval '2 days') returning id, source_id");
    await db.query("insert into public.rafa_knowledge_chunks(document_id, content) values ($1, 'Company registration package price and government fees')", [expired.id]);
    await db.exec("set role service_role");
    const hits = await db.query("select * from public.rafa_knowledge_gap_expired_matches('What is the company registration package price?', 5)");
    assert.equal(hits.rows.length, 1);
    await db.exec("reset role");
    await db.query("insert into public.rafa_knowledge_documents(source_id, valid_until) values ($1, now() + interval '10 days')", [expired.source_id]);
    await db.exec("set role service_role");
    const none = await db.query("select * from public.rafa_knowledge_gap_expired_matches('What is the company registration package price?', 5)");
    assert.equal(none.rows.length, 0);
  } finally { await db.close(); }
});
