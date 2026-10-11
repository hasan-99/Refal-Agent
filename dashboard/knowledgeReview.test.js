import test from "node:test";
import assert from "node:assert/strict";
import { previewKnowledgeAcrossLanguages, reviewKnowledgeDocument, setKnowledgeSourceArchived } from "./knowledgeReview.js";

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
