import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const migration = fs.readFileSync(path.join(here, "..", "supabase", "migrations", "20261011130000_expand_approved_knowledge_sections_and_relax_lexical_coverage.sql"), "utf8");

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
