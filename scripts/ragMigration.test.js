const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const migration = fs.readFileSync(path.join(__dirname, "..", "supabase", "migrations", "20261003224701_rafa_rag_freshness_and_revision_lifecycle.sql"), "utf8");

test("lexical and hybrid search return chunk and review freshness metadata", () => {
  assert.equal((migration.match(/fetched_at timestamptz, valid_until timestamptz, review_status text, approved_at timestamptz/gu) || []).length, 2);
  assert.match(migration, /source_id uuid, document_id uuid, chunk_id uuid, source_name text/u);
  assert.match(migration, /d\.fetched_at,d\.valid_until,d\.review_status,d\.approved_at/gu);
  assert.doesNotMatch(migration, /approved_by\s+text/u);
});

test("mutable price documents expire and only one approved revision per source survives", () => {
  assert.match(migration, /unique index if not exists rafa_knowledge_documents_one_approved_per_source_idx[\s\S]*?where review_status = 'approved'/u);
  assert.match(migration, /new\.valid_until := now\(\) \+ interval '30 days'/u);
  assert.match(migration, /d\.canonical_content !~\* '[\s\S]*?d\.valid_until is not null and d\.valid_until>now\(\)/u);
  assert.match(migration, /set review_status = 'superseded'/u);
  assert.doesNotMatch(migration, /set review_status = 'superseded', approved_at = null/u);
  assert.equal((migration.match(/cardinality\(q\.terms\)[^\n]*>=0\.6/gu) || []).length, 2);
});

test("replacement search RPCs retain invoker security and pinned search paths", () => {
  assert.equal((migration.match(/language sql stable security invoker set search_path = ''/gu) || []).length, 2);
  assert.match(migration, /drop function if exists public\.rafa_search_knowledge/u);
  assert.match(migration, /drop function if exists public\.rafa_hybrid_search_knowledge/u);
  assert.match(migration, /grant execute on function public\.rafa_search_knowledge\(text,integer\) to anon/u);
  assert.match(migration, /grant execute on function public\.rafa_hybrid_search_knowledge\(text,extensions\.halfvec,text,integer\) to anon/u);
});
