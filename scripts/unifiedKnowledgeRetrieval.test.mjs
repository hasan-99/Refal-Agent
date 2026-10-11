// Real Postgres (PGlite) coverage for 20261011120000_refal_unified_knowledge_retrieval.sql.
//
// The claims this file has to prove are the three SQL-side causes of the agent
// saying "I have no confirmed information" about something the corpus answers:
//
//   1. the v1 lexical gate rejects a natural sentence that v2 admits
//   2. a `boundary` section (the conditions) is reachable from a chunk match
//      that only hit the claim
//   3. the eligibility filters are UNCHANGED -- recall widened, approval did not
//
// The hybrid v2 function is not exercised here: it needs the pgvector/halfvec
// extension, which PGlite does not carry. Its lexical arm is textually the same
// admission rule proven below; its semantic arm is a parameterised cutoff.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const V2_PATH = path.join(ROOT, "supabase/migrations/20261011120000_refal_unified_knowledge_retrieval.sql");
const V1_PATH = path.join(ROOT, "supabase/migrations/20261010223908_cf08_lexical_rank_consistency.sql");
const v2 = fs.readFileSync(V2_PATH, "utf8");
const v1 = fs.readFileSync(V1_PATH, "utf8");

function fn(source, name) {
  const match = source.match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`, "iu"));
  assert.ok(match, `migration contains the complete ${name} definition`);
  return match[0];
}

const SOURCE = "00000000-0000-4000-8000-000000000001";
const DOC = "00000000-0000-4000-8000-000000000011";
const DOC_UNAPPROVED = "00000000-0000-4000-8000-000000000012";
const DOC_EXPIRED = "00000000-0000-4000-8000-000000000013";
const C_CLAIM = "00000000-0000-4000-8000-000000000101";
const C_BOUNDARY = "00000000-0000-4000-8000-000000000102";
const C_ALIAS = "00000000-0000-4000-8000-000000000100";
const C_HIDDEN = "00000000-0000-4000-8000-000000000103";

async function freshDb() {
  const db = new PGlite();
  await db.exec(`
    create table public.rafa_knowledge_sources (
      id uuid primary key, enabled boolean not null, approved boolean not null,
      display_name text not null, canonical_url text
    );
    create table public.rafa_knowledge_documents (
      id uuid primary key, source_id uuid not null, fetched_at timestamptz not null,
      valid_until timestamptz, review_status text not null, approved_at timestamptz,
      canonical_content text not null, title text not null
    );
    create table public.rafa_knowledge_chunks (
      id uuid primary key, document_id uuid not null, chunk_index integer not null,
      heading text, content text not null, search_vector tsvector not null,
      metadata jsonb not null default '{}'::jsonb,
      embedding text, embedding_model text
    );
  `);

  await db.exec(`
    insert into public.rafa_knowledge_sources values
      ('${SOURCE}', true, true, 'Refalco Group', 'refal://kb/company/formation/en');

    insert into public.rafa_knowledge_documents values
      ('${DOC}','${SOURCE}',now(),null,'approved',now(),'Cyprus company formation package contents','What the Cyprus company formation package includes'),
      ('${DOC_UNAPPROVED}','${SOURCE}',now(),null,'pending',null,'Draft company formation notes','Draft'),
      ('${DOC_EXPIRED}','${SOURCE}',now(),now() - interval '1 day','approved',now(),'Expired company formation package','Expired');
  `);

  const chunk = (id, doc, index, kind, heading, content) => `
    insert into public.rafa_knowledge_chunks (id, document_id, chunk_index, heading, content, search_vector, metadata)
    values ('${id}','${doc}',${index},$h$${heading}$h$,$c$${content}$c$,
      to_tsvector('simple', $h$${heading}$h$ || ' ' || $c$${content}$c$), '{"kind":"${kind}"}'::jsonb);`;

  await db.exec(chunk(C_ALIAS, DOC, 0, "aliases", "What the Cyprus company formation package includes", "golden visa\ncompany setup"));
  await db.exec(chunk(C_CLAIM, DOC, 1, "fact", "What the package covers",
    "The package covers Cyprus Ltd formation, company name reservation and approval, and document preparation."));
  await db.exec(chunk(C_BOUNDARY, DOC, 2, "boundary", "Limits and conditions",
    "This excludes opening a corporate bank account, which is quoted separately and depends on the bank."));
  await db.exec(chunk(C_HIDDEN, DOC_UNAPPROVED, 1, "fact", "Draft section", "Cyprus company formation package draft text."));

  await db.exec(fn(v1, "rafa_search_knowledge"));
  await db.exec(fn(v2, "rafa_search_knowledge_v2"));
  await db.exec(fn(v2, "rafa_fetch_knowledge_sections"));
  await db.exec(fn(v2, "rafa_knowledge_health"));
  return db;
}

// The customer's actual sentence, stopwords and all. `simple` strips none of
// them, which is what made the v1 0.6-coverage gate unreachable.
const NATURAL_QUESTION = "What is included in the Cyprus company formation package that you offer?";

test("the v1 lexical gate finds NOTHING for a natural sentence the corpus answers", async () => {
  const db = await freshDb();
  const { rows } = await db.query("select chunk_id from public.rafa_search_knowledge($1, 10)", [NATURAL_QUESTION]);
  assert.equal(rows.length, 0, "this is the live behaviour that produced 'I have no confirmed information'");
  await db.close();
});

test("v2 retrieves the answering section for that same sentence", async () => {
  const db = await freshDb();
  const { rows } = await db.query("select chunk_id, chunk_kind from public.rafa_search_knowledge_v2($1, 10, 0.2, 1)", [NATURAL_QUESTION]);
  const ids = rows.map((row) => row.chunk_id);
  assert.ok(ids.includes(C_CLAIM), "the section that answers the question is retrieved");
  await db.close();
});

test("v2 still answers a keyword query, so the behaviour that already worked is not traded away", async () => {
  const db = await freshDb();
  const { rows } = await db.query("select chunk_id from public.rafa_search_knowledge_v2($1, 10, 0.2, 1)", ["Cyprus company formation package"]);
  assert.ok(rows.map((row) => row.chunk_id).includes(C_CLAIM));
  await db.close();
});

test("the admission floor is a real parameter: raising it back to v1 strictness restores the miss", async () => {
  const db = await freshDb();
  const { rows } = await db.query("select chunk_id from public.rafa_search_knowledge_v2($1, 10, 0.95, 8)", [NATURAL_QUESTION]);
  assert.equal(rows.length, 0, "coverage 0.95 / 8 terms is unreachable for a sentence, exactly as v1 was");
  await db.close();
});

test("v2 reports the diagnostics an administrator trace needs", async () => {
  const db = await freshDb();
  const { rows } = await db.query("select chunk_id, lexical_rank, matched_terms, term_coverage from public.rafa_search_knowledge_v2($1, 10, 0.2, 1)", [NATURAL_QUESTION]);
  const claim = rows.find((row) => row.chunk_id === C_CLAIM);
  assert.ok(Number(claim.lexical_rank) >= 1, "the lexical position is reported");
  assert.ok(Number(claim.matched_terms) >= 1, "the matched term count is reported");
  assert.ok(Number(claim.term_coverage) > 0, "the term coverage is reported");
  await db.close();
});

test("the conditions section is returned for a match that only hit the claim", async () => {
  const db = await freshDb();
  const { rows } = await db.query(
    "select chunk_id, chunk_kind, chunk_index, is_match from public.rafa_fetch_knowledge_sections($1::uuid[], 24, true)",
    [`{${C_CLAIM}}`]
  );
  const ids = rows.map((row) => row.chunk_id);
  assert.ok(ids.includes(C_CLAIM), "the matched claim");
  assert.ok(ids.includes(C_BOUNDARY), "its boundary section, which never matched the query");
  assert.equal(rows.find((row) => row.chunk_id === C_CLAIM).is_match, true);
  assert.equal(rows.find((row) => row.chunk_id === C_BOUNDARY).is_match, false);
  // Original document order, not relevance order.
  const indexes = rows.map((row) => Number(row.chunk_index));
  assert.deepEqual(indexes, [...indexes].sort((a, b) => a - b));
  await db.close();
});

test("sections carry their own metadata so the blocked-fact gate can still see their facts", async () => {
  const db = await freshDb();
  const { rows } = await db.query(
    "select chunk_id, metadata from public.rafa_fetch_knowledge_sections($1::uuid[], 24, true)",
    [`{${C_CLAIM}}`]
  );
  for (const row of rows) {
    assert.ok(row.metadata && typeof row.metadata === "object", `${row.chunk_id} carries metadata`);
    assert.ok("kind" in row.metadata, "the fact-register gate reads metadata, not just the kind column");
  }
  await db.close();
});

test("finding aids are never returned as sections", async () => {
  const db = await freshDb();
  const { rows } = await db.query(
    "select chunk_id from public.rafa_fetch_knowledge_sections($1::uuid[], 24, true)",
    [`{${C_CLAIM}}`]
  );
  assert.ok(!rows.map((row) => row.chunk_id).includes(C_ALIAS));
  await db.close();
});

test("when the section budget is tight the conditions outrank the background", async () => {
  const db = await freshDb();
  const { rows } = await db.query(
    "select chunk_id, priority from public.rafa_fetch_knowledge_sections($1::uuid[], 2, true)",
    [`{${C_CLAIM}}`]
  );
  const ids = rows.map((row) => row.chunk_id);
  assert.equal(rows.length, 2);
  assert.ok(ids.includes(C_CLAIM) && ids.includes(C_BOUNDARY));
  await db.close();
});

test("sibling expansion can be switched off", async () => {
  const db = await freshDb();
  const { rows } = await db.query(
    "select chunk_id from public.rafa_fetch_knowledge_sections($1::uuid[], 24, false)",
    [`{${C_CLAIM}}`]
  );
  assert.deepEqual(rows.map((row) => row.chunk_id), [C_CLAIM]);
  await db.close();
});

test("ACCESS CONTROL: an unapproved document is unreachable through every new function", async () => {
  const db = await freshDb();
  const search = await db.query("select chunk_id from public.rafa_search_knowledge_v2($1, 20, 0.0, 1)", ["Cyprus company formation package draft text"]);
  assert.ok(!search.rows.map((row) => row.chunk_id).includes(C_HIDDEN), "v2 search cannot see a pending document");

  // Even asked for BY ID, the section fetch re-applies the approval filter.
  const sections = await db.query("select chunk_id from public.rafa_fetch_knowledge_sections($1::uuid[], 24, true)", [`{${C_HIDDEN}}`]);
  assert.equal(sections.rows.length, 0, "a chunk id from a pending document returns nothing");
  await db.close();
});

test("ACCESS CONTROL: an expired document stays excluded", async () => {
  const db = await freshDb();
  const { rows } = await db.query("select document_id from public.rafa_search_knowledge_v2($1, 20, 0.0, 1)", ["Expired company formation package"]);
  assert.ok(!rows.map((row) => row.document_id).includes(DOC_EXPIRED));
  await db.close();
});

test("the health function separates a blackout from a retrieval-quality problem", async () => {
  const db = await freshDb();
  const { rows } = await db.query("select * from public.rafa_knowledge_health()");
  const health = rows[0];
  assert.equal(Number(health.sources_enabled_approved), 1);
  assert.equal(Number(health.documents_total), 3);
  assert.equal(Number(health.documents_approved), 2);
  assert.equal(Number(health.documents_expired), 1);
  // Only the one approved, unexpired document's chunks are eligible.
  assert.equal(Number(health.chunks_eligible), 3);
  // Nothing in this fixture is embedded, which is exactly the condition that
  // silently disables the semantic arm in production.
  assert.equal(Number(health.chunks_embedded), 0);
  assert.equal(Number(health.chunks_missing_embedding), 3);
  await db.close();
});
