const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Record a knowledge review through the database's audited review RPC. */
export async function reviewKnowledgeDocument(rest, { documentId, status, reviewer, reason = "" } = {}) {
  const id = String(documentId || "");
  if (!UUID.test(id)) throw httpError(400, "Invalid knowledge document ID.");
  if (!["approved", "rejected", "pending"].includes(status)) {
    throw httpError(400, "Review status must be approved, rejected, or pending.");
  }
  const actor = String(reviewer || "").trim();
  if (actor.length < 2 || actor.length > 200) throw httpError(403, "A verified dashboard reviewer is required.");
  const note = String(reason || "").trim().slice(0, 500);

  return rest("rpc/rafa_review_knowledge_document", {
    method: "POST",
    body: JSON.stringify({
      p_document_id: id,
      p_review_status: status,
      p_reviewer: actor,
      p_reason: note
    })
  });
}

function httpError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
