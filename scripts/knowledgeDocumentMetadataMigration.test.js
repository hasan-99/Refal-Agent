const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const migration = fs.readFileSync(path.join(__dirname, "..", "supabase", "migrations", "20261006120000_rafa_knowledge_document_metadata.sql"), "utf8");

test("the old 6-argument rafa_store_knowledge_revision signature is dropped before the new one is created, avoiding a PostgREST overload ambiguity", () => {
  const dropIndex = migration.indexOf("drop function if exists public.rafa_store_knowledge_revision(uuid, text, text, text, text, jsonb);");
  const createIndex = migration.indexOf("create function public.rafa_store_knowledge_revision(");
  assert.ok(dropIndex >= 0, "must drop the old 6-argument signature");
  assert.ok(createIndex > dropIndex, "the drop must happen before the new function is created");
});

test("the new function accepts an optional p_metadata parameter defaulting to an empty object", () => {
  assert.match(migration, /p_metadata jsonb default '\{\}'::jsonb/u);
});

test("p_metadata is sanitized to an object before being stored, never trusted raw", () => {
  assert.match(migration, /v_metadata jsonb := case when jsonb_typeof\(p_metadata\) = 'object' then p_metadata else '\{\}'::jsonb end/u);
  assert.match(migration, /insert into public\.rafa_knowledge_documents \(\s*source_id, revision, title, canonical_content, content_sha256, language_code, review_status, metadata/u);
  assert.match(migration, /p_content_sha256, coalesce\(nullif\(p_language_code, ''\), 'en'\), 'pending', v_metadata/u);
});

test("the grant/revoke lines target the new 7-argument signature", () => {
  assert.match(migration, /revoke all on function public\.rafa_store_knowledge_revision\(uuid, text, text, text, text, jsonb, jsonb\) from public, authenticated;/u);
  assert.match(migration, /grant execute on function public\.rafa_store_knowledge_revision\(uuid, text, text, text, text, jsonb, jsonb\) to anon;/u);
});
