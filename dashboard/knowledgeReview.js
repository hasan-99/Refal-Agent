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

/** Build a side-by-side retrieval preview from approved, enabled knowledge only. */
export async function previewKnowledgeAcrossLanguages(search, queries) {
  if (typeof search !== "function") throw new TypeError("An approved-knowledge search function is required.");
  const entries = ["en", "ar", "el"].map((language) => [language, String(queries?.[language] || "").trim().slice(0, 1000)]);
  if (entries.some(([, query]) => !query)) throw httpError(400, "Enter a preview query in English, Arabic, and Greek.");
  const results = await Promise.all(entries.map(async ([language, query]) => ({ language, query, results: await search(query) })));
  return { results };
}

/** Archive is a reversible source disable; it never deletes approved evidence. */
export async function setKnowledgeSourceArchived(rest, { sourceId, archived, actor, reason = "" } = {}) {
  const id = String(sourceId || "");
  if (!UUID.test(id)) throw httpError(400, "Invalid knowledge source ID.");
  if (typeof archived !== "boolean") throw httpError(400, "Archive state must be true or false.");
  const reviewer = String(actor || "").trim();
  if (reviewer.length < 2 || reviewer.length > 200) throw httpError(403, "A verified dashboard reviewer is required.");
  const note = String(reason || "").trim().slice(0, 500);
  if (!note) throw httpError(400, "Provide a short reason for archiving or restoring this source.");
  const rows = await rest(`rafa_knowledge_sources?id=eq.${id}&select=id,display_name,enabled,approved`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ enabled: !archived, updated_at: new Date().toISOString() })
  });
  if (!rows?.[0]) throw httpError(404, "Knowledge source not found.");
  return { source: rows[0], archived, reason: note, actor: reviewer };
}
