import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const migration = await readFile("supabase/migrations/20261014082345_mark_deduplicated_knowledge_fetch_ready.sql", "utf8");
const hash = "a".repeat(64);
const otherHash = "b".repeat(64);
const chunks = JSON.stringify([{ chunk_index: 0, heading: "", content: "Same body", metadata: {} }]);

async function setup() {
  const db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create table public.rafa_knowledge_sources (
      id uuid primary key, display_name text, last_content_hash text, last_success_at timestamptz,
      last_fetched_at timestamptz, last_status text, last_error text, enabled boolean default true,
      approved boolean default true, updated_at timestamptz
    );
    create table public.rafa_knowledge_documents (
      id uuid primary key default gen_random_uuid(), source_id uuid not null,
      revision integer not null, title text not null, canonical_content text not null,
      content_sha256 text not null, language_code text not null,
      review_status text not null check (review_status in ('pending','approved','rejected')),
      approved_at timestamptz, approved_by text, metadata jsonb not null default '{}'::jsonb,
      unique(source_id, content_sha256), unique(source_id, revision)
    );
    create table public.rafa_knowledge_chunks (
      document_id uuid not null references public.rafa_knowledge_documents(id),
      chunk_index integer not null, heading text not null, content text not null,
      metadata jsonb not null default '{}'::jsonb
    );
    insert into public.rafa_knowledge_sources(id, display_name) values ('00000000-0000-0000-0000-000000000001','Initial title');
  `);
  await db.exec(migration);
  return db;
}

async function save(db, title, contentHash, status = "pending") {
  const { rows: [result] } = await db.query(`
    select public.rafa_store_knowledge_revision(
      '00000000-0000-0000-0000-000000000001', $1, 'Same body', $2, 'en', $3::jsonb,
      '{}'::jsonb, $4, null
    ) as result
  `, [title, contentHash, chunks, status]);
  return result.result;
}

test("same-source identical text deduplicates across title changes and preserves review status", async () => {
  const db = await setup();
  try {
    const first = await save(db, "Original page title", hash);
    assert.equal(first.revision, 1);
    assert.equal(first.deduplicated, false);

    await db.exec("update public.rafa_knowledge_sources set enabled=false,last_status='fetching' where id='00000000-0000-0000-0000-000000000001'");
    const second = await save(db, "Updated page title", hash);
    assert.deepEqual(second, {
      document_id: first.document_id, revision: 1,
      deduplicated: true, unchanged: true, review_status: "pending"
    });
    const { rows: [sourceAfterDuplicate] } = await db.query("select enabled,last_status from public.rafa_knowledge_sources");
    assert.deepEqual(sourceAfterDuplicate, { enabled: false, last_status: "ready" }, "successful duplicate fetch clears fetching but preserves archived state");
    assert.equal((await db.query("select count(*)::int as n from public.rafa_knowledge_documents")).rows[0].n, 1);

    const distinct = await save(db, "New content title", otherHash);
    assert.equal(distinct.revision, 2, "different content from one source creates a new revision");
    assert.equal(distinct.deduplicated, false);

    await db.query("update public.rafa_knowledge_documents set review_status='approved' where id=$1", [first.document_id]);
    const approvedDuplicate = await save(db, "Another title", hash);
    assert.equal(approvedDuplicate.document_id, first.document_id);
    assert.equal(approvedDuplicate.review_status, "approved", "fetch does not downgrade an approved revision");
    assert.equal((await db.query("select count(*)::int as n from public.rafa_knowledge_documents")).rows[0].n, 2);
  } finally {
    await db.close();
  }
});
