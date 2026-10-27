"use strict";

import { attachKnowledgePolicyMetadata } from "./knowledgePolicyMetadata.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

// The request body is controlled by the API caller. Accept only chunk IDs from
// it, then rebuild all evidence fields from the database before giving evidence
// to either the model or the deterministic claim gate.
async function resolveTrustedKnowledgeEvidence(supabase, suppliedEvidence, { now = new Date() } = {}) {
  const supplied = Array.isArray(suppliedEvidence) ? suppliedEvidence.slice(0, 40) : [];
  const chunkIds = [...new Set(supplied.map((item) => String(item?.chunk_id || "").trim()).filter((id) => UUID.test(id)))];
  if (!chunkIds.length) return [];

  // Use precisely the same authorized, complete section resolver as search.
  if (typeof supabase?.rpc === "function") {
    const { data, error } = await supabase.rpc("rafa_expand_knowledge_sections", { p_chunk_ids: chunkIds, p_max_chunks: 200 });
    if (error) throw error;
    const enriched = await attachKnowledgePolicyMetadata(supabase, data || []);
    return enriched.filter((row) => !(row.policyMetadata?.factRegisterRows || []).some((fact) => fact.status === "blocked"));
  }

  const chunksResult = await supabase.from("rafa_knowledge_chunks")
    .select("id,document_id,chunk_index,heading,content,metadata")
    .in("id", chunkIds);
  if (chunksResult?.error) throw chunksResult.error;
  const chunks = Array.isArray(chunksResult?.data) ? chunksResult.data : [];
  const documentIds = [...new Set(chunks.map((chunk) => chunk.document_id).filter((id) => typeof id === "string" && UUID.test(id)))];
  if (!documentIds.length) return [];

  const documentsResult = await supabase.from("rafa_knowledge_documents")
    .select("id,source_id,title,review_status,valid_until,fetched_at,canonical_content,revision")
    .in("id", documentIds);
  if (documentsResult?.error) throw documentsResult.error;
  const documents = Array.isArray(documentsResult?.data) ? documentsResult.data : [];
  const sourceIds = [...new Set(documents.map((document) => document.source_id).filter((id) => typeof id === "string" && UUID.test(id)))];
  if (!sourceIds.length) return [];

  const sourcesResult = await supabase.from("rafa_knowledge_sources")
    .select("id,display_name,canonical_url,enabled,approved")
    .in("id", sourceIds);
  if (sourcesResult?.error) throw sourcesResult.error;
  const sources = Array.isArray(sourcesResult?.data) ? sourcesResult.data : [];
  const documentById = new Map(documents.map((document) => [document.id, document]));
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const nowTime = now instanceof Date ? now.getTime() : Date.parse(now);

  // PostgREST does not promise that an `in` query preserves caller ranking.
  // Rebuild in the requested order so retrieval relevance remains stable, and
  // ignore any duplicate/unrequested rows defensively.
  const chunkById = new Map(chunks.filter((chunk) => chunkIds.includes(chunk?.id)).map((chunk) => [chunk.id, chunk]));
  const canonicalRows = chunkIds.flatMap((chunkId) => {
    const chunk = chunkById.get(chunkId);
    if (!chunk) return [];
    const document = documentById.get(chunk.document_id);
    const source = document && sourceById.get(document.source_id);
    // Alias finding-aid chunks are for search only. They can contain query
    // terms without customer-facing claims and must never become model evidence.
    // Empty or general document Evidence references do not affect admission:
    // the indexed chunk text is grounded by its approved revision and active,
    // approved source, with expiry checked below.
    if (String(chunk.metadata?.kind || "") === "aliases") return [];
    if (!document || document.review_status !== "approved" || !source?.enabled || !source?.approved) return [];
    if (/(?:[$€£]\s*[0-9٠-٩]|(?:EUR|USD|GBP)\s*[0-9٠-٩]|[0-9٠-٩][0-9٠-٩.,\s]*(?:EUR|USD|GBP|euros?|dollars?|pounds?|يورو|دولار|جنيه|ευρώ))/iu.test(String(document.canonical_content || "")) && !document.valid_until) return [];
    if (document.valid_until !== null && document.valid_until !== undefined) {
      const expiry = Date.parse(document.valid_until);
      if (!Number.isFinite(expiry) || !Number.isFinite(nowTime) || expiry <= nowTime) return [];
    }
    return [{
      chunk_id: chunk.id,
      document_id: document.id,
      chunk_index: chunk.chunk_index,
      source_name: source.display_name,
      source_url: source.canonical_url,
      document_title: document.title,
      heading: chunk.heading,
      content: chunk.content,
      fetched_at: document.fetched_at,
      valid_until: document.valid_until,
      review_status: document.review_status,
      metadata: chunk.metadata || {}
    }];
  });
  if (!canonicalRows.length) return [];

  // Fact-register rows are fetched only to honor an explicit owner block.
  // Missing or incomplete rows do not add an approval requirement to content
  // already verified through its approved revision and active source.
  return (await attachKnowledgePolicyMetadata(supabase, canonicalRows)).filter((row) => !(row.policyMetadata?.factRegisterRows || []).some((fact) => fact.status === "blocked"));
}

export { resolveTrustedKnowledgeEvidence };
