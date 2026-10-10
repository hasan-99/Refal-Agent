import test from "node:test";
import assert from "node:assert/strict";
import { reviewKnowledgeDocument } from "./knowledgeReview.js";

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
