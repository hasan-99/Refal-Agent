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
  assert.match(server, /app\.get\("\/api\/knowledge\/fetch-policy",\s*requireAdmin/);
  const policy = route("get", "/api/knowledge/fetch-policy");
  assert.match(policy, /allowedKnowledgeHosts/);
  const fetch = route("post", "/api/knowledge/:id/fetch");
  assert.match(fetch, /req\.body\?\.language/);
  assert.match(fetch, /Choose English, Arabic, or Greek/);
  const edit = route("patch", "/api/knowledge/documents/:id");
  assert.match(edit, /content_sha256/);
  assert.match(edit, /review_status !== "pending"/);
  assert.match(edit, /duplicate copies of the same knowledge are not saved/);
  assert.match(edit, /knowledge_pending_title_updated/);
  assert.match(ui, /Fetch a web page/);
  assert.match(ui, /allowedHosts/);
});

test("admin review queue sees all statuses while non-admin API reads stay approved-only", () => {
  const list = route("get", "/api/knowledge");
  assert.match(list, /isAdmin\s*\?\s*readAllSupabaseRows\(withStableIdOrder\(documentQuery,\s*"fetched_at"\)\)\s*:\s*supabaseRest\(`\$\{documentQuery\}&limit=200`\)/);
  assert.match(list, /order=fetched_at\.desc,id\.desc/);
  assert.match(list, /isAdmin\s*\?\s*""\s*:\s*"&review_status=eq\.approved"/);
  const detail = route("get", "/api/knowledge/:id");
  assert.match(detail, /isAdmin\s*\?\s*readAllSupabaseRows\(withStableIdOrder\(documentQuery,\s*"revision"\)\)\s*:\s*supabaseRest\(`\$\{documentQuery\}&limit=1`\)/);
  assert.match(detail, /order=revision\.desc,id\.desc/);
  assert.match(detail, /for\s*\(let index = 0; index < documents\.length; index \+= 50\)/);
  assert.match(detail, /mapWithConcurrency\(documentIdBatches,[\s\S]*?readAllSupabaseRows\(/);
  assert.match(detail, /order=chunk_index\.asc,id\.asc/);
  assert.match(detail, /isAdmin\s*\?\s*""\s*:\s*"&review_status=eq\.approved"/);
  assert.match(detail, /isAdmin \? \(await mapWithConcurrency\(reviewAuditBatches[\s\S]*?rafa_knowledge_review_audit/);
  assert.match(detail, /isAdmin \? \{ reviewHistory: reviewAuditByDocument\.get\(doc\.id\) \|\| \[\] \} : \{\}/);
  assert.match(detail, /rafa_knowledge_review_audit\?document_id=in\.\(\$\{batch\.join\(","\)\}\).*previous_status,new_status,reviewer,reason,created_at/);
  assert.match(detail, /isAdmin \? \(await mapWithConcurrency\(reviewAuditBatches/);
});

test("approval reindexes the pending revision before the audited decision publishes it", () => {
  const review = route("patch", "/api/knowledge/documents/:id/review");
  assert.match(review, /\["approved",\s*"rejected",\s*"pending"\]/);
  assert.match(review, /if\s*\(status\s*===\s*"approved"\)\s*\{[\s\S]*?approveKnowledgeDocumentAfterIndex/);
  assert.doesNotMatch(review, /embeddingWarning/u);
  assert.match(review, /reason:\s*req\.body\?\.reason/);
  assert.match(review, /review:\s*\{ previous:\s*decision\.previous,\s*status:\s*decision\.review_status,\s*reviewer:\s*decision\.reviewer,\s*reason:\s*decision\.reason \}/);
  const helper = readFileSync(new URL("./knowledgeReview.js", import.meta.url), "utf8");
  assert.match(helper, /rafa_store_knowledge_embeddings[\s\S]*?reviewKnowledgeDocument\(rest, \{ documentId: id, status: "approved"/);
  assert.match(ui, /reviewDocument\(doc, "approved"\)/);
  assert.match(ui, /reviewDocument\(doc, "rejected"\)/);
  assert.match(ui, /reviewDocument\(doc, "pending"\)/);
  assert.match(ui, /docs\.find\(\(item\) => item\.review_status === "pending"\) \|\| docs\[0\]/);
  assert.match(ui, /knowledge-content-meta/);
  assert.match(ui, /Source: \{sourceLabel\}/);
  assert.ok(ui.includes('const canFetchSelectedSource = /^https:\\/\\//i.test('));
  assert.match(ui, /knowledgeView === "content" && isAdmin && canFetchSelectedSource && <button className="ghost" onClick=\{fetchSource\}/);
  assert.ok(ui.includes('knowledgeView === "edit" ? " knowledge-layout-editing" : ""'));
  assert.ok(ui.includes('knowledgeView === "edit" ? " is-editing" : ""'));
  assert.ok(ui.includes("onClick={cancelKnowledgeEditor}>Cancel</button>"));
  assert.doesNotMatch(ui, /Start a new entry|Back to content/);
  assert.doesNotMatch(ui, /Revision \{doc\.revision|Source and approval details|Review decision history/);
  assert.match(ui, /Decision reason/);
  assert.match(ui, /doc\.review_status === "pending" && <details className="knowledge-review-panel"/);
  assert.match(ui, /JSON\.stringify\(\{ status, reason \}\)/);
  assert.doesNotMatch(ui, /doc\.approved_by|doc\.approved_at|doc\.valid_until|doc\.chunks\?\.length/);
  assert.doesNotMatch(ui, /Effective \{formatDate\(doc\.approved_at\)\}/);
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
  assert.match(ui, /Restore \$\{doc\.title\} to agent knowledge/);
  assert.doesNotMatch(ui, /Delete knowledge/);
});

test("permanent knowledge delete is admin-only, refuses audited sources, and records an actor/reason event", () => {
  const remove = route("delete", "/api/knowledge/:id");
  assert.match(remove, /requireAdmin/);
  assert.match(remove, /deleteKnowledgeSource/);
  assert.match(remove, /knowledge_source_deleted/);
  assert.match(remove, /actor:\s*result\.actor/);
  assert.match(remove, /reason:\s*result\.reason/);
  const helper = readFileSync(new URL("./knowledgeReview.js", import.meta.url), "utf8");
  assert.match(helper, /review history, which is kept permanently/);
  assert.match(helper, /Provide a short reason for deleting/);
  assert.match(ui, /Delete this source permanently\?/);
  assert.match(ui, /cannot be undone/);
});

test("approved retrieval admin preview remains available while Knowledge shows the Add knowledge action", () => {
  const preview = route("post", "/api/knowledge/search/preview");
  assert.match(preview, /requireAdmin/);
  assert.match(preview, /previewKnowledgeAcrossLanguages/);
  assert.match(preview, /rafa_hybrid_search_knowledge/);
  assert.match(preview, /rafa_search_knowledge/);
  assert.match(ui, /knowledge-filter-add/);
  assert.doesNotMatch(ui, /ACTIVE SOURCES|APPROVED REVISIONS|AWAITING REVIEW|ALL REVISIONS/);
  assert.match(ui, /knowledge-result-count/);
  assert.match(ui, /knowledge-library-search/);
  assert.match(ui, /placeholder="Search knowledge"/);
  assert.match(ui, /label="Filter by category"/);
  assert.match(ui, /label="Filter by language"/);
  assert.match(ui, /label="Filter by review status"/);
  assert.match(ui, /role="listbox"/);
  assert.match(ui, /has-selection/);
  assert.match(ui, /Add knowledge/);
  assert.doesNotMatch(ui, /Search approved knowledge in any language/);
  assert.doesNotMatch(ui, /Preview approved retrieval in all customer languages/);
  const helper = readFileSync(new URL("./knowledgeReview.js", import.meta.url), "utf8");
  assert.match(helper, /\["en", "ar", "el"\]/);
});
