"use strict";

// Narrow server-side enrichment for deterministic policy checks. This is not
// included in the model evidence formatter or returned as customer content.
const FACT_ID = /^MB-(?:F(?:[1-9]|[1-5][0-9]|6[0-6])|C[1-5]|J[0-4]|DYN[1-6])$/u;
const TOPIC = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function cleanIds(values, pattern) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || "").trim()).filter((value) => pattern.test(value)))];
}

function policyMetadataForRow(row, chunkMetadata, factRows) {
  const facts = cleanIds(chunkMetadata?.facts, FACT_ID);
  const factById = new Map((Array.isArray(factRows) ? factRows : []).map((item) => [item.fact_id, item]));
  const factRegisterRows = facts.map((id) => factById.get(id)).filter(Boolean).map((item) => ({
    id: item.fact_id,
    status: item.status,
    reviewer: typeof item.reviewer === "string" ? item.reviewer.slice(0, 120) : "",
    verifiedAt: typeof item.verified_at === "string" ? item.verified_at.slice(0, 40) : null,
    effectiveFrom: typeof item.effective_from === "string" ? item.effective_from.slice(0, 10) : null,
    expiryOrReviewAt: typeof item.expiry_or_review_at === "string" ? item.expiry_or_review_at.slice(0, 10) : null,
    approvedLanguages: cleanIds(item.approved_languages, /^(?:ar|en|el)$/u).sort()
  }));
  const rawTopic = String(chunkMetadata?.topic || "");
  const topic = TOPIC.test(rawTopic) ? rawTopic : null;
  const topicNumber = Number(chunkMetadata?.topicNumber);
  return {
    topic,
    topicNumber: Number.isInteger(topicNumber) && topicNumber >= 1 && topicNumber <= 100 ? topicNumber : null,
    facts,
    factRegisterRows,
    // Search RPC status and expiry remain authoritative for the document.
    reviewStatus: row?.review_status === "approved" ? "approved" : null,
    validUntil: typeof row?.valid_until === "string" ? row.valid_until.slice(0, 40) : null
  };
}

async function attachKnowledgePolicyMetadata(supabase, rows) {
  const results = Array.isArray(rows) ? rows : [];
  const chunkIds = cleanIds(results.map((row) => row?.chunk_id), UUID);
  if (!chunkIds.length || !supabase?.from) return results.map((row) => ({ ...row, policyMetadata: null }));

  const chunksResult = await supabase.from("rafa_knowledge_chunks").select("id,metadata").in("id", chunkIds);
  if (chunksResult?.error || !Array.isArray(chunksResult?.data)) return results.map((row) => ({ ...row, policyMetadata: null }));
  const chunkById = new Map(chunksResult.data.map((chunk) => [chunk.id, chunk.metadata || {}]));
  const factIds = cleanIds(chunksResult.data.flatMap((chunk) => Array.isArray(chunk?.metadata?.facts) ? chunk.metadata.facts : []), FACT_ID);

  let factRows = [];
  if (factIds.length) {
    const factsResult = await supabase.from("refal_fact_register")
      .select("fact_id,status,reviewer,verified_at,effective_from,expiry_or_review_at,approved_languages")
      .in("fact_id", factIds);
    if (!factsResult?.error && Array.isArray(factsResult?.data)) factRows = factsResult.data;
  }

  return results.map((row) => ({
    ...row,
    policyMetadata: policyMetadataForRow(row, chunkById.get(row?.chunk_id), factRows)
  }));
}

export { attachKnowledgePolicyMetadata, policyMetadataForRow };
