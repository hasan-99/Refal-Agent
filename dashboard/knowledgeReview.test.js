import test from "node:test";
import assert from "node:assert/strict";
import { approveKnowledgeDocumentAfterIndex, deleteKnowledgeSource, previewKnowledgeAcrossLanguages, reviewKnowledgeDocument, setKnowledgeSourceArchived } from "./knowledgeReview.js";

const id = "123e4567-e89b-42d3-a456-426614174000";

test("knowledge review is recorded through the audited RPC with the authenticated reviewer", async () => {
  let call;
  const result = await reviewKnowledgeDocument(async (...args) => {
    call = args;
    return { review_status: "approved" };
  }, { documentId: id, status: "approved", reviewer: "reviewer@refalco.com", reason: "Checked against source" });

  assert.deepEqual(call, ["rpc/rafa_review_knowledge_document", {
    method: "POST",
    body: JSON.stringify({
      p_document_id: id,
      p_review_status: "approved",
      p_reviewer: "reviewer@refalco.com",
      p_reason: "Checked against source"
    })
  }]);
  assert.deepEqual(result, { review_status: "approved" });
});

test("knowledge review rejects missing reviewer, malformed ID, and unsupported status before database access", async () => {
  let calls = 0;
  const rest = async () => { calls += 1; };
  await assert.rejects(reviewKnowledgeDocument(rest, { documentId: id, status: "approved", reviewer: "" }), /verified dashboard reviewer/);
  await assert.rejects(reviewKnowledgeDocument(rest, { documentId: "bad", status: "approved", reviewer: "Reviewer" }), /Invalid knowledge document ID/);
  await assert.rejects(reviewKnowledgeDocument(rest, { documentId: id, status: "active", reviewer: "Reviewer" }), /Review status must be/);
  assert.equal(calls, 0);
});

test("review reason is required and bounded before any database write", async () => {
  let calls = 0;
  const rest = async () => { calls += 1; };
  await assert.rejects(reviewKnowledgeDocument(rest, { documentId: id, status: "rejected", reviewer: "reviewer@example.com" }), /review reason is required/u);
  await assert.rejects(reviewKnowledgeDocument(rest, { documentId: id, status: "rejected", reviewer: "reviewer@example.com", reason: "x".repeat(501) }), /500 characters/u);
  assert.equal(calls, 0);
});

test("approval stages the complete embedding batch before the audited decision publishes the revision", async () => {
  const calls = [];
  const rest = async (...args) => {
    calls.push(args);
    return args[0] === "rpc/rafa_store_knowledge_embeddings" ? 2 : { review_status: "approved" };
  };
  const result = await approveKnowledgeDocumentAfterIndex(rest, {
    documentId: id,
    reviewer: "reviewer@refalco.com",
    reason: "Verified against source",
    embeddingModel: "test-model",
    loadChunks: async (documentId) => {
      assert.equal(documentId, id);
      calls.push(["load-chunks"]);
      return [{ chunk_index: 0, content: "English" }, { chunk_index: 1, content: "Arabic" }];
    },
    embedTexts: async (texts) => {
      calls.push(["embed", texts]);
      return [[0.1, 0.2], [0.3, 0.4]];
    }
  });

  assert.deepEqual(calls.map(([name]) => name), ["load-chunks", "embed", "rpc/rafa_store_knowledge_embeddings", "rpc/rafa_review_knowledge_document"]);
  assert.equal(JSON.parse(calls[2][1].body).p_model, "test-model");
  assert.equal(JSON.parse(calls[3][1].body).p_review_status, "approved");
  assert.deepEqual(result, { document: { review_status: "approved" }, embeddedChunks: 2 });
});

test("incomplete embedding or reindex failure leaves the revision unapproved", async () => {
  let approvalCalls = 0;
  const rest = async (route) => {
    if (route === "rpc/rafa_review_knowledge_document") approvalCalls += 1;
    if (route === "rpc/rafa_store_knowledge_embeddings") throw new Error("index unavailable");
    return 1;
  };
  const options = {
    documentId: id,
    reviewer: "reviewer@refalco.com",
    reason: "Reviewed against authoritative source",
    embeddingModel: "test-model",
    loadChunks: async () => [{ chunk_index: 0, content: "English" }],
    embedTexts: async () => [[0.1, 0.2]]
  };
  await assert.rejects(approveKnowledgeDocumentAfterIndex(rest, options), /index unavailable/u);
  assert.equal(approvalCalls, 0);
  await assert.rejects(approveKnowledgeDocumentAfterIndex(rest, { ...options, embedTexts: async () => [] }), /incomplete revision batch/u);
  assert.equal(approvalCalls, 0);
});

test("approval validates reviewer and reason before loading or embedding chunks", async () => {
  let loads = 0;
  const options = {
    documentId: id,
    reviewer: "reviewer@refalco.com",
    embeddingModel: "test-model",
    loadChunks: async () => { loads += 1; return [{ chunk_index: 0, content: "English" }]; },
    embedTexts: async () => [[0.1, 0.2]]
  };
  await assert.rejects(approveKnowledgeDocumentAfterIndex(async () => 1, { ...options, reason: "" }), /review reason is required/u);
  assert.equal(loads, 0);
});

test("trilingual preview runs the three supplied language queries independently and returns language-labelled results", async () => {
  const calls = [];
  const result = await previewKnowledgeAcrossLanguages(async (query) => { calls.push(query); return [{ query, review_status: "approved" }]; }, {
    en: "company services", ar: "خدمات الشركة", el: "υπηρεσίες εταιρείας"
  });
  assert.deepEqual(calls, ["company services", "خدمات الشركة", "υπηρεσίες εταιρείας"]);
  assert.deepEqual(result.results.map(({ language }) => language), ["en", "ar", "el"]);
  assert.ok(result.results.every(({ results }) => results[0].review_status === "approved"));
});

test("trilingual preview rejects missing language queries before retrieval", async () => {
  let calls = 0;
  await assert.rejects(previewKnowledgeAcrossLanguages(async () => { calls += 1; }, { en: "services", ar: "خدمات", el: "" }), /English, Arabic, and Greek/);
  assert.equal(calls, 0);
});

test("archive and restore use reversible enabled state and require an audited reviewer and reason", async () => {
  const calls = [];
  const rest = async (...args) => { calls.push(args); return [{ id, display_name: "Services", enabled: calls.length > 1, approved: true }]; };
  const archived = await setKnowledgeSourceArchived(rest, { sourceId: id, archived: true, actor: "admin@refalco.com", reason: "Outdated content" });
  assert.equal(archived.archived, true);
  assert.match(calls[0][0], /^rafa_knowledge_sources\?id=eq\./);
  assert.deepEqual(JSON.parse(calls[0][1].body), { enabled: false, updated_at: JSON.parse(calls[0][1].body).updated_at });
  const restored = await setKnowledgeSourceArchived(rest, { sourceId: id, archived: false, actor: "admin@refalco.com", reason: "Undo archive" });
  assert.equal(restored.archived, false);
  assert.equal(JSON.parse(calls[1][1].body).enabled, true);
  let deniedCalls = 0;
  const noWrite = async () => { deniedCalls += 1; };
  await assert.rejects(setKnowledgeSourceArchived(noWrite, { sourceId: id, archived: true, actor: "", reason: "reason" }), /verified dashboard reviewer/);
  await assert.rejects(setKnowledgeSourceArchived(noWrite, { sourceId: id, archived: true, actor: "admin", reason: " " }), /short reason/);
  assert.equal(deniedCalls, 0);
});

const documentId = "223e4567-e89b-42d3-a456-426614174001";

function deleteRest({ found = true, documents = [{ id: documentId }], audits = [], deleted = [{ id, display_name: "Services" }] } = {}) {
  const calls = [];
  const rest = async (route, options = {}) => {
    calls.push([route, options]);
    if (options.method === "DELETE") return deleted;
    if (route.startsWith("rafa_knowledge_sources")) return found ? [{ id, display_name: "Services" }] : [];
    if (route.startsWith("rafa_knowledge_documents")) return documents;
    if (route.startsWith("rafa_knowledge_review_audit")) return audits;
    throw new Error(`unexpected route ${route}`);
  };
  return { rest, calls };
}

test("permanent delete removes the source and reports how many revisions cascade with it", async () => {
  const { rest, calls } = deleteRest();
  const result = await deleteKnowledgeSource(rest, { sourceId: id, actor: "admin@refalco.com", reason: "Obsolete test data" });
  assert.deepEqual(result, { source: { id, display_name: "Services" }, deletedRevisions: 1, reason: "Obsolete test data", actor: "admin@refalco.com" });
  const [route, options] = calls.at(-1);
  assert.equal(options.method, "DELETE");
  assert.equal(route, `rafa_knowledge_sources?id=eq.${id}&select=id,display_name`);
  assert.equal(calls[2][0], `rafa_knowledge_review_audit?document_id=in.(${documentId})&select=id&limit=1`);
});

test("permanent delete refuses audited and missing sources without deleting", async () => {
  for (const [setup, pattern] of [
    [{ audits: [{ id: "audit" }] }, /review history/],
    [{ found: false }, /not found/],
    [{ deleted: [] }, /not found/]
  ]) {
    const { rest, calls } = deleteRest(setup);
    await assert.rejects(deleteKnowledgeSource(rest, { sourceId: id, actor: "admin@refalco.com", reason: "Cleanup" }), pattern);
    if (!setup.deleted) assert.ok(calls.every(([, options]) => options.method !== "DELETE"));
  }
});

test("permanent delete skips the audit lookup for a source with no revisions", async () => {
  const { rest, calls } = deleteRest({ documents: [] });
  const result = await deleteKnowledgeSource(rest, { sourceId: id, actor: "admin@refalco.com", reason: "Empty source" });
  assert.equal(result.deletedRevisions, 0);
  assert.ok(calls.every(([route]) => !route.startsWith("rafa_knowledge_review_audit")));
});

test("permanent delete validates ID, reviewer, and reason before database access", async () => {
  let calls = 0;
  const rest = async () => { calls += 1; };
  await assert.rejects(deleteKnowledgeSource(rest, { sourceId: "bad", actor: "admin", reason: "x" }), /Invalid knowledge source ID/);
  await assert.rejects(deleteKnowledgeSource(rest, { sourceId: id, actor: "", reason: "x" }), /verified dashboard reviewer/);
  await assert.rejects(deleteKnowledgeSource(rest, { sourceId: id, actor: "admin", reason: " " }), /short reason/);
  assert.equal(calls, 0);
});
