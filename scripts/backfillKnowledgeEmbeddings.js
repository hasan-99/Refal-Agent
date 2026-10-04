const path = require("node:path");
const { loadProjectEnv } = require("../src/env");
const { embedTexts, DEFAULT_EMBEDDING_MODEL } = require("../src/ai");

loadProjectEnv(path.resolve(__dirname, ".."));

async function main() {
  const baseUrl = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const key = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;
  const secret = process.env.RAFA_DASHBOARD_SUPABASE_SECRET;
  if (!baseUrl || !key || !secret) throw new Error("Supabase dashboard REST configuration is incomplete.");

  const model = process.env.OPENROUTER_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL;
  const rest = async (pathname, options = {}) => {
    const response = await fetch(`${baseUrl}/rest/v1/${pathname}`, {
      ...options,
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        "x-rafa-dashboard-secret": secret,
        "content-type": "application/json",
        ...(options.headers || {})
      }
    });
    const body = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) throw new Error(body?.message || body?.error || `Supabase request failed (${response.status}).`);
    return body;
  };

  const sources = await rest("rafa_knowledge_sources?select=id&approved=eq.true&enabled=eq.true&limit=200");
  const sourceIds = (sources || []).map((source) => source.id);
  if (!sourceIds.length) {
    console.log("No approved, enabled sources need semantic indexing.");
    return;
  }

  const documents = await rest(`rafa_knowledge_documents?select=id,source_id,review_status&source_id=in.(${sourceIds.join(",")})&review_status=eq.approved&limit=500`);
  const chunks = [];
  for (const document of documents || []) {
    const rows = await rest(`rafa_knowledge_chunks?select=chunk_index,content,embedding_model,embedded_at&document_id=eq.${document.id}&order=chunk_index.asc&limit=500`);
    for (const chunk of rows || []) {
      if (chunk.embedding_model === model && chunk.embedded_at) continue;
      chunks.push({ documentId: document.id, chunkIndex: chunk.chunk_index, content: chunk.content });
    }
  }

  if (!chunks.length) {
    console.log(`Semantic index is current for ${documents?.length || 0} approved documents.`);
    return;
  }

  const vectors = await embedTexts(chunks.map((chunk) => chunk.content));
  const byDocument = new Map();
  chunks.forEach((chunk, index) => {
    if (!byDocument.has(chunk.documentId)) byDocument.set(chunk.documentId, []);
    byDocument.get(chunk.documentId).push({ chunk_index: chunk.chunkIndex, embedding: vectors[index] });
  });

  let stored = 0;
  for (const [documentId, embeddings] of byDocument) {
    stored += await rest("rpc/rafa_store_knowledge_embeddings", {
      method: "POST",
      body: JSON.stringify({ p_document_id: documentId, p_model: model, p_embeddings: embeddings })
    });
  }
  console.log(`Stored ${stored} semantic embeddings across ${byDocument.size} approved documents (${documents?.length || 0} checked).`);
}

main().catch((error) => {
  console.error(`Knowledge embedding backfill failed: ${String(error.message).slice(0, 180)}`);
  process.exitCode = 1;
});
