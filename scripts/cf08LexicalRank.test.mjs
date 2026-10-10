import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATION_PATH = path.join(ROOT, "supabase/migrations/20261010223908_cf08_lexical_rank_consistency.sql");
const migration = fs.readFileSync(MIGRATION_PATH, "utf8");

function lexicalFunction() {
  const match = migration.match(/create or replace function public\.rafa_search_knowledge\([\s\S]*?\n\$\$;/iu);
  assert.ok(match, "migration contains the complete lexical RPC definition");
  return match[0];
}

async function seed(db) {
  await db.exec(`
    create table public.rafa_knowledge_sources (
      id uuid primary key, enabled boolean not null, approved boolean not null,
      display_name text not null, canonical_url text
    );
    create table public.rafa_knowledge_documents (
      id uuid primary key, source_id uuid not null, fetched_at timestamptz not null,
      valid_until timestamptz, review_status text not null, approved_at timestamptz not null,
      canonical_content text not null, title text not null
    );
    create table public.rafa_knowledge_chunks (
      id uuid primary key, document_id uuid not null, chunk_index integer not null,
      heading text, content text not null, search_vector tsvector not null,
      metadata jsonb not null default '{}'::jsonb
    );
  `);
  await db.exec(lexicalFunction());
  await db.exec(`
    insert into public.rafa_knowledge_sources values
      ('00000000-0000-4000-8000-000000000001', true, true, 'Approved facts', null);
    insert into public.rafa_knowledge_documents values
      ('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000001',now(),null,'approved',now(),'company formation Cyprus corporate tax','Exact match'),
      ('00000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-000000000001',now(),null,'approved',now(),'company formation repeated Cyprus unrelated','Repeated partial match'),
      ('00000000-0000-4000-8000-000000000013','00000000-0000-4000-8000-000000000001',now(),now()-interval '1 day','approved',now(),'company formation Cyprus corporate tax','Expired exact match'),
      ('00000000-0000-4000-8000-000000000014','00000000-0000-4000-8000-000000000001',now(),null,'draft',now(),'company formation Cyprus corporate tax','Unapproved exact match'),
      ('00000000-0000-4000-8000-000000000015','00000000-0000-4000-8000-000000000001',now(),null,'approved',now(),'company tax','Tax exclusion trap'),
      ('00000000-0000-4000-8000-000000000016','00000000-0000-4000-8000-000000000001',now(),null,'approved',now(),'company x formation','Phrase trap'),
      ('00000000-0000-4000-8000-000000000017','00000000-0000-4000-8000-000000000001',now(),null,'approved',now(),'ίδρυση εταιρείας κύπρος','Greek query'),
      ('00000000-0000-4000-8000-000000000018','00000000-0000-4000-8000-000000000001',now(),null,'approved',now(),'تأسيس شركة قبرص','Arabic query');
    insert into public.rafa_knowledge_chunks values
      ('00000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-000000000011',1,'Exact','company formation Cyprus corporate tax',to_tsvector('simple','company formation Cyprus corporate tax'),'{}'),
      ('00000000-0000-4000-8000-000000000022','00000000-0000-4000-8000-000000000012',1,'Partial','company formation company formation company formation company formation Cyprus unrelated words',to_tsvector('simple','company formation company formation company formation company formation Cyprus unrelated words'),'{}'),
      ('00000000-0000-4000-8000-000000000023','00000000-0000-4000-8000-000000000013',1,'Expired','company formation Cyprus corporate tax',to_tsvector('simple','company formation Cyprus corporate tax'),'{}'),
      ('00000000-0000-4000-8000-000000000024','00000000-0000-4000-8000-000000000014',1,'Draft','company formation Cyprus corporate tax',to_tsvector('simple','company formation Cyprus corporate tax'),'{}'),
      ('00000000-0000-4000-8000-000000000025','00000000-0000-4000-8000-000000000015',1,'Tax','company tax',to_tsvector('simple','company tax'),'{}'),
      ('00000000-0000-4000-8000-000000000026','00000000-0000-4000-8000-000000000016',1,'Phrase','company x formation',to_tsvector('simple','company x formation'),'{}'),
      ('00000000-0000-4000-8000-000000000027','00000000-0000-4000-8000-000000000017',1,'Greek','ίδρυση εταιρείας κύπρος',to_tsvector('simple','ίδρυση εταιρείας κύπρος'),'{}'),
      ('00000000-0000-4000-8000-000000000028','00000000-0000-4000-8000-000000000018',1,'Arabic','تأسيس شركة قبرص',to_tsvector('simple','تأسيس شركة قبرص'),'{}');
  `);
}

test("CF-08: lexical RPC ranks full query coverage ahead of a repeated partial match", async () => {
  const db = new PGlite();
  try {
    await seed(db);
    const result = await db.query("select document_title, content, rank from public.rafa_search_knowledge($1, 6)", [
      "company formation Cyprus corporate tax"
    ]);
    assert.deepEqual(result.rows.map((row) => row.document_title), ["Exact match", "Repeated partial match"]);
    assert.ok(result.rows[0].rank > result.rows[1].rank);
    assert.equal(result.rows.some((row) => /Expired|Unapproved/u.test(row.document_title)), false);
  } finally {
    await db.close();
  }
});

test("CF-08: hybrid lexical candidates use the same coverage, rank, and tie-break order", () => {
  const hybrid = migration.match(/create or replace function public\.rafa_hybrid_search_knowledge\([\s\S]*?\n\$\$;/iu)?.[0];
  assert.ok(hybrid, "migration contains the complete hybrid RPC definition");
  assert.match(hybrid, /ts_rank_cd\(e\.search_vector,q\.broad\)::real broad_rank/u);
  assert.match(hybrid, /row_number\(\) over\(order by coverage desc,broad_rank desc,required_match desc,chunk_index,id\) position/u);
  assert.match(hybrid, /1\.0\/\(60\+l\.position\)/u);
  assert.doesNotMatch(hybrid, /case when e\.search_vector\s*@@\s*q\.required\s+then\s+ts_rank_cd\(e\.search_vector,q\.required\)/iu);
});

test("CF-08: explicit negation and quoted phrases cannot be bypassed by partial matching", async () => {
  const db = new PGlite();
  try {
    await seed(db);
    const negated = await db.query("select document_title from public.rafa_search_knowledge($1, 6)", ["company -tax"]);
    const phrase = await db.query("select document_title from public.rafa_search_knowledge($1, 6)", ['"company formation"']);
    assert.equal(negated.rows.some((row) => row.document_title === "Tax exclusion trap"), false);
    assert.equal(phrase.rows.some((row) => row.document_title === "Phrase trap"), false);
    const greek = await db.query("select document_title from public.rafa_search_knowledge($1, 6)", ["ίδρυση εταιρείας κύπρος"]);
    const arabic = await db.query("select document_title from public.rafa_search_knowledge($1, 6)", ["تأسيس شركة قبرص"]);
    assert.equal(greek.rows[0]?.document_title, "Greek query");
    assert.equal(arabic.rows[0]?.document_title, "Arabic query");
    const punctuation = await db.query("select document_title from public.rafa_search_knowledge($1, 6)", ["!!!"]);
    assert.deepEqual(punctuation.rows, []);
    const duplicate = await db.query("select document_title from public.rafa_search_knowledge($1, 6)", ["company company formation"]);
    assert.ok(duplicate.rows.some((row) => row.document_title === "Exact match"));
  } finally {
    await db.close();
  }
});

test("CF-08 migration preserves anonymous RPC execution and approved-evidence eligibility gates", () => {
  assert.match(migration, /revoke all on function public\.rafa_search_knowledge\(text,integer\) from public,authenticated/u);
  assert.match(migration, /grant execute on function public\.rafa_search_knowledge\(text,integer\) to anon/u);
  assert.match(migration, /grant execute on function public\.rafa_hybrid_search_knowledge\(text,extensions\.halfvec,text,integer\) to anon/u);
  assert.equal((migration.match(/s\.enabled and s\.approved and d\.review_status='approved'/gu) || []).length, 2);
  assert.equal((migration.match(/d\.valid_until is null or d\.valid_until>now\(\)/gu) || []).length, 2);
});
