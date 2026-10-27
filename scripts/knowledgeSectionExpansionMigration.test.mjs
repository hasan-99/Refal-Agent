import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const here = path.dirname(fileURLToPath(import.meta.url));
const migration = fs.readFileSync(path.join(here, "..", "supabase", "migrations", "20261011120422_expand_approved_knowledge_sections_and_relax_lexical_coverage.sql"), "utf8");
const currentKnowledgeMigration = fs.readFileSync(path.join(here, "..", "supabase", "migrations", "20261011191744_enforce_current_knowledge_and_rank_finding_aids.sql"), "utf8");

test("current knowledge authorization rejects superseded revisions and whole blocked sections while preserving unrelated sections", async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create schema extensions; create domain extensions.halfvec as text;
      create table public.rafa_knowledge_sources(id uuid primary key,enabled boolean,approved boolean);
      create table public.rafa_knowledge_documents(id uuid primary key,source_id uuid,review_status text,revision integer,valid_until timestamptz,canonical_content text);
      create table public.rafa_knowledge_chunks(id uuid primary key,document_id uuid,metadata jsonb);
      create table public.refal_fact_register(fact_id text primary key,status text);
      insert into public.rafa_knowledge_sources values ('00000000-0000-4000-8000-000000000001',true,true);
      insert into public.rafa_knowledge_documents values
        ('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000001','approved',1,null,'Old approved text'),
        ('00000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-000000000001','approved',2,null,'Current approved text');
      insert into public.rafa_knowledge_chunks values
        ('00000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-000000000012','{"sectionIndex":0,"facts":["MB-F1"]}'),
        ('00000000-0000-4000-8000-000000000022','00000000-0000-4000-8000-000000000012','{"sectionIndex":0}'),
        ('00000000-0000-4000-8000-000000000023','00000000-0000-4000-8000-000000000012','{"sectionIndex":1}');
      insert into public.refal_fact_register values ('MB-F1','blocked');`);
    // Exercise the complete migration, including its catalog transformations.
    await db.exec(`create function public.rafa_search_knowledge(text,integer) returns setof uuid language sql as $$
      select c.id from public.rafa_knowledge_chunks c join public.rafa_knowledge_documents d on d.id=c.document_id
      join public.rafa_knowledge_sources s on s.id=d.source_id
      where s.enabled and s.approved and d.review_status='approved' $$;
      create function public.rafa_hybrid_search_knowledge(text,extensions.halfvec,text,integer) returns setof uuid language sql as $$
      select c.id from public.rafa_knowledge_chunks c join public.rafa_knowledge_documents d on d.id=c.document_id
      join public.rafa_knowledge_sources s on s.id=d.source_id
      where s.enabled and s.approved and d.review_status='approved' $$;
      create function public.rafa_expand_knowledge_sections(uuid[],integer) returns setof uuid language sql as $$
      select c.id from public.rafa_knowledge_chunks c join public.rafa_knowledge_documents d on d.id=c.document_id
      join public.rafa_knowledge_sources s on s.id=d.source_id
      where s.enabled and s.approved and d.review_status='approved' $$;`);
    await db.exec(currentKnowledgeMigration);
    for (const call of ["rafa_search_knowledge('topic',20)", "rafa_hybrid_search_knowledge('topic',null,null,20)", "rafa_expand_knowledge_sections(null,20)"]) {
      assert.deepEqual((await db.query(`select * from public.${call}`)).rows.map((row) => Object.values(row)[0]), ["00000000-0000-4000-8000-000000000023"]);
    }
    const result = await db.query(`select
      public.rafa_knowledge_revision_is_current('00000000-0000-4000-8000-000000000011') old,
      public.rafa_knowledge_revision_is_current('00000000-0000-4000-8000-000000000012') current,
      public.rafa_knowledge_chunk_is_allowed('00000000-0000-4000-8000-000000000021') blocked,
      public.rafa_knowledge_chunk_is_allowed('00000000-0000-4000-8000-000000000022') blocked_sibling,
      public.rafa_knowledge_chunk_is_allowed('00000000-0000-4000-8000-000000000023') independent`);
    assert.deepEqual(result.rows[0], { old: false, current: true, blocked: false, blocked_sibling: false, independent: true });
    await db.exec(`update public.rafa_knowledge_documents set canonical_content='Current price €500' where revision=2`);
    assert.equal((await db.query(`select public.rafa_knowledge_revision_is_current('00000000-0000-4000-8000-000000000012') allowed`)).rows[0].allowed, false);
    await db.exec(`update public.rafa_knowledge_documents set valid_until=now()+interval '1 day' where revision=2`);
    assert.equal((await db.query(`select public.rafa_knowledge_revision_is_current('00000000-0000-4000-8000-000000000012') allowed`)).rows[0].allowed, true);
    await db.exec(`update public.rafa_knowledge_documents set valid_until=now()-interval '1 day' where revision=2`);
    assert.equal((await db.query(`select public.rafa_knowledge_revision_is_current('00000000-0000-4000-8000-000000000012') allowed`)).rows[0].allowed, false);
  } finally { await db.close(); }
});

test("the retrieval migration relaxes Arabic lexical coverage without removing the query-term match requirement", () => {
  assert.ok(migration.includes("updated := replace(definition, ')>=0.6 and', ')>=0.15 and');"));
  assert.ok(migration.includes("updated := replace(updated, ')>=2)', ')>=1)');"));
  assert.match(migration, /if updated = definition then\s+raise exception/u);
});

test("the section expansion index and RPC use stable document/section identity and preserve chunk order", () => {
  assert.match(migration, /rafa_knowledge_chunks_document_section_order_idx\s+on public\.rafa_knowledge_chunks \(document_id, \(metadata->>'sectionIndex'\), chunk_index\)/u);
  assert.match(migration, /c\.metadata->>'sectionIndex' = a\.section_index/u);
  assert.match(migration, /coalesce\(c\.metadata->>'topicNumber',''\) = coalesce\(a\.topic_number,''\)/u);
  assert.match(migration, /order by e\.anchor_order, e\.chunk_index, e\.id/u);
  assert.match(migration, /least\(greatest\(coalesce\(p_max_chunks,80\),1\),200\)/u);
});

test("expanded rows retain source approval, document currentness, and mutable-price gates", () => {
  assert.match(migration, /s\.enabled and s\.approved and d\.review_status='approved'/u);
  assert.match(migration, /d\.valid_until is null or d\.valid_until>now\(\)/u);
  assert.match(migration, /or \(d\.valid_until is not null and d\.valid_until>now\(\)\)/u);
  assert.match(migration, /revoke all on function public\.rafa_expand_knowledge_sections\(uuid\[\],integer\) from public/u);
  assert.match(migration, /grant execute on function public\.rafa_expand_knowledge_sections\(uuid\[\],integer\) to anon, authenticated, service_role/u);
});
