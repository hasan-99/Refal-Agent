import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const server = readFileSync(new URL("./server.js", import.meta.url), "utf8");
const ui = readFileSync(new URL("./src/main.jsx", import.meta.url), "utf8");

function route(method, path) {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = server.match(new RegExp(`app\\.${method}\\([\\"']${escaped}[\\"'],([\\s\\S]*?)\\n\\}\\);`));
  assert.ok(match, `${method.toUpperCase()} ${path} route exists`);
  return match[1];
}

test("knowledge saves queue revisions without embedding them", () => {
  const store = server.slice(server.indexOf("async function storeKnowledgeRevision("), server.indexOf("async function indexKnowledgeDocument("));
  assert.match(store, /p_review_status:\s*"pending"/);
  assert.match(store, /p_approved_by:\s*null/);
  for (const [method, path] of [
    ["post", "/api/knowledge/:id/import"],
    ["patch", "/api/knowledge/documents/:id"],
    ["post", "/api/knowledge/:id/upload"],
    ["post", "/api/knowledge/:id/fetch"]
  ]) {
    const body = route(method, path);
    assert.doesNotMatch(body, /indexKnowledgeDocument\(/, `${method.toUpperCase()} ${path} must not index pending saves`);
    assert.match(body, /embeddedChunks:\s*0/, `${method.toUpperCase()} ${path} reports no indexed chunks`);
  }
});

test("admin review queue sees all statuses while non-admin API reads stay approved-only", () => {
  const list = route("get", "/api/knowledge");
  assert.match(list, /isAdmin\s*\?\s*""\s*:\s*"&review_status=eq\.approved"/);
  const detail = route("get", "/api/knowledge/:id");
  assert.match(detail, /isAdmin\s*\?\s*""\s*:\s*"&review_status=eq\.approved"/);
  assert.match(detail, /isAdmin\s*\?\s*"20"\s*:\s*"1"/);
});

test("only an approved decision indexes chunks, and the UI offers all review states", () => {
  const review = route("patch", "/api/knowledge/documents/:id/review");
  assert.match(review, /\["approved",\s*"rejected",\s*"pending"\]/);
  assert.match(review, /if\s*\(status\s*===\s*"approved"\)\s*\{[\s\S]*?rafa_store_knowledge_embeddings/);
  assert.match(ui, /reviewDocument\(doc, "approved"\)/);
  assert.match(ui, /reviewDocument\(doc, "rejected"\)/);
  assert.match(ui, /reviewDocument\(doc, "pending"\)/);
  assert.match(ui, /Revision v\{doc\.revision\}[^<]*\{doc\.language_code/);
  assert.match(ui, /Source: \{selected\.display_name\}/);
});

test("archive and restore are admin-only, reversible source disable actions with actor/reason audit events", () => {
  const archive = route("patch", "/api/knowledge/:id/archive");
  assert.match(archive, /requireAdmin/);
  assert.match(archive, /setKnowledgeSourceArchived/);
  assert.match(archive, /knowledge_source_archived/);
  assert.match(archive, /knowledge_source_restored/);
  assert.match(archive, /actor:\s*result\.actor/);
  assert.match(archive, /reason:\s*result\.reason/);
  const helper = readFileSync(new URL("./knowledgeReview.js", import.meta.url), "utf8");
  assert.match(helper, /enabled:\s*!archived/);
  assert.match(helper, /Provide a short reason/);
  assert.match(ui, /Undo/);
  assert.match(ui, /Archive this source\?/);
  assert.match(ui, /Restore source/);
  assert.doesNotMatch(ui, /Delete knowledge/);
  assert.doesNotMatch(server, /app\.delete\("\/api\/knowledge\/:id"/);
});

test("side-by-side EN/AR/EL preview uses retrieval RPCs and exposes only the existing approved-search path", () => {
  const preview = route("post", "/api/knowledge/search/preview");
  assert.match(preview, /requireAdmin/);
  assert.match(preview, /previewKnowledgeAcrossLanguages/);
  assert.match(preview, /rafa_hybrid_search_knowledge/);
  assert.match(preview, /rafa_search_knowledge/);
  assert.match(ui, /Preview approved retrieval in all customer languages/);
  assert.match(ui, /English retrieval preview query/);
  assert.match(ui, /Arabic retrieval preview query/);
  assert.match(ui, /Greek retrieval preview query/);
  assert.match(ui, /Trilingual approved retrieval preview/);
  const helper = readFileSync(new URL("./knowledgeReview.js", import.meta.url), "utf8");
  assert.match(helper, /\["en", "ar", "el"\]/);
});
