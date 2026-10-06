// One-off ingestion of the curated factual content from
// artifacts/refal-sales-knowledge-curated.txt into the real knowledge base,
// via the exact same RPC the dashboard's upload/import routes use. Creates
// one new "manual" source and leaves its revision at review_status=pending —
// it is deliberately NOT auto-approved here; an admin must review and
// approve it in the dashboard before it is ever served to the Agent.
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { loadProjectEnv } = require("../src/env");

loadProjectEnv(path.resolve(__dirname, ".."));

async function main() {
  const { chunkKnowledge, normalizeKnowledgeContent } = await import("../dashboard/knowledge.js");

  const baseUrl = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const key = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;
  const secret = process.env.RAFA_DASHBOARD_SUPABASE_SECRET;
  if (!baseUrl || !key || !secret) throw new Error("Supabase dashboard REST configuration is incomplete.");

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

  const rawText = fs.readFileSync(path.resolve(__dirname, "..", "artifacts", "refal-sales-knowledge-curated.txt"), "utf8");
  const content = normalizeKnowledgeContent(rawText);
  const chunks = chunkKnowledge(content);

  const sourceRows = await rest("rafa_knowledge_sources?select=id,canonical_url,display_name", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      canonical_url: `manual:${crypto.randomUUID()}`,
      display_name: "Refalco — company, tax concepts, and property journey reference",
      source_kind: "manual",
      trust_tier: "operator_supplied"
    })
  });
  const source = sourceRows[0];

  const contentSha256 = crypto.createHash("sha256").update(content).digest("hex");
  const saved = await rest("rpc/rafa_store_knowledge_revision", {
    method: "POST",
    body: JSON.stringify({
      p_source_id: source.id,
      p_title: "Refalco — company, tax concepts, and property journey reference",
      p_content: content,
      p_content_sha256: contentSha256,
      p_language_code: "en",
      p_chunks: chunks,
      p_metadata: { sourceFileType: "txt", sourceFileName: "refal-sales-knowledge-curated.txt" }
    })
  });

  console.log(`Created source ${source.id} ("${source.display_name}").`);
  console.log(`Stored revision: ${JSON.stringify(saved)} with ${chunks.length} chunks.`);
  console.log("review_status is 'pending' by default — approve it in the dashboard's Knowledge tab before it reaches the Agent.");
}

main().catch((error) => {
  console.error(`Sales knowledge ingestion failed: ${String(error.message).slice(0, 300)}`);
  process.exitCode = 1;
});
