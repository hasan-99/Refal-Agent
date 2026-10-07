const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { loadProjectEnv } = require("../src/env");
const { embedTexts, DEFAULT_EMBEDDING_MODEL } = require("../src/ai");

loadProjectEnv(path.resolve(__dirname, ".."));

const rootDir = path.resolve(__dirname, "..");
const catalogPath = path.join(rootDir, "data", "refalco-services-catalog.md");
const canonicalUrl = "manual://canonical/refalco-services-catalog";
const sourceName = "REFALCO Complete Services Catalog";
const documentTitle = "REFALCO Complete Services Catalog | دليل خدمات ريفالكو | Κατάλογος Υπηρεσιών REFALCO";
const baseUrl = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const apiKey = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;
const dashboardSecret = process.env.RAFA_DASHBOARD_SUPABASE_SECRET;

if (!baseUrl || !apiKey || !dashboardSecret) throw new Error("Missing Supabase dashboard REST configuration.");

async function rest(resource, options = {}) {
  const response = await fetch(`${baseUrl}/rest/v1/${resource}`, {
    ...options,
    headers: {
      apikey: apiKey,
      authorization: `Bearer ${apiKey}`,
      "x-rafa-dashboard-secret": dashboardSecret,
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });
  const body = response.status === 204 ? [] : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || body.error || `Supabase REST returned ${response.status}`);
  return body;
}

async function approvedDocumentForSource(source) {
  const sources = await rest(`rafa_knowledge_sources?canonical_url=eq.${encodeURIComponent(source)}&approved=eq.true&enabled=eq.true&select=id,display_name,canonical_url&limit=1`);
  if (!sources[0]) throw new Error(`Required approved source is unavailable: ${source}`);
  const documents = await rest(`rafa_knowledge_documents?source_id=eq.${sources[0].id}&review_status=eq.approved&select=id,title,canonical_content,valid_until&order=revision.desc&limit=1`);
  if (!documents[0]) throw new Error(`Required approved document is unavailable: ${source}`);
  return { source: sources[0], document: documents[0] };
}

async function approvedOperatorDocument(displayName) {
  const sources = await rest(`rafa_knowledge_sources?display_name=eq.${encodeURIComponent(displayName)}&approved=eq.true&enabled=eq.true&select=id,display_name,canonical_url&limit=1`);
  if (!sources[0]) throw new Error(`Required approved operator source is unavailable: ${displayName}`);
  const documents = await rest(`rafa_knowledge_documents?source_id=eq.${sources[0].id}&review_status=eq.approved&select=id,title,canonical_content,valid_until&order=revision.desc&limit=1`);
  if (!documents[0]) throw new Error(`Required approved operator document is unavailable: ${displayName}`);
  return { source: sources[0], document: documents[0] };
}

function validateCatalog(catalog, approvedCorpus) {
  const requiredCatalogFacts = [
    /Development[\s\S]*Infrastructure & Execution[\s\S]*Operations[\s\S]*Technology Systems[\s\S]*Strategic Assets/u,
    /التطوير[\s\S]*البنية التحتية والتنفيذ[\s\S]*العمليات والتشغيل[\s\S]*أنظمة التكنولوجيا[\s\S]*الأصول الاستراتيجية/u,
    /Ανάπτυξη[\s\S]*Υποδομές & Εκτέλεση[\s\S]*Λειτουργίες[\s\S]*Τεχνολογικά Συστήματα[\s\S]*Στρατηγικά Περιουσιακά Στοιχεία/u,
    /€999 \+ VAT/u,
    /999 يورو \+ ضريبة القيمة المضافة/u,
    /€999 \+ ΦΠΑ/u,
    /four months of company-secretary service/u,
    /أربعة أشهر من خدمة سكرتارية الشركة/u,
    /τέσσερις μήνες υπηρεσίας γραμματέα εταιρείας/u,
    /approximately two weeks after all required documents are complete/u
  ];
  for (const pattern of requiredCatalogFacts) {
    if (!pattern.test(catalog)) throw new Error(`Canonical catalog is missing required verified content: ${pattern}`);
  }
  if (/\[(?:required|todo|tbc|missing)\]|<placeholder>|insert price/iu.test(catalog)) {
    throw new Error("Canonical catalog contains an unresolved placeholder.");
  }

  const requiredEvidenceFacts = [
    /€999/u,
    /VAT/u,
    /4 أشهر Company Secretary|4 أشهر سكرتارية/u,
    /4 أشهر Registered Address|4 أشهر عنوان مسجل/u,
    /حوالي أسبوعين/u,
    /Development/u,
    /Infrastructure & Execution/u,
    /Technology Systems/u,
    /Strategic Assets/u
  ];
  for (const pattern of requiredEvidenceFacts) {
    if (!pattern.test(approvedCorpus)) throw new Error(`Approved source corpus no longer supports a catalog fact: ${pattern}`);
  }
}

function annotateChunks(chunks) {
  return chunks.map((chunk) => {
    const content = String(chunk.content || "");
    const language = /[\u0600-\u06ff]/u.test(content) ? "ar" : /[\u0370-\u03ff]/u.test(content) ? "el" : "en";
    const topic = /€999|999 يورو|ΦΠΑ|VAT/u.test(content)
      ? "company_formation_pricing"
      : /company formation|تأسيس شركة|σύσταση εταιρείας/iu.test(content)
        ? "company_formation"
        : /business areas|مجالات عمل|επιχειρηματικοί τομείς/iu.test(content)
          ? "group_business_areas"
          : "service_boundaries";
    return { ...chunk, metadata: { language, topic, canonical: true } };
  });
}

function catalogSections(content) {
  const headings = [...String(content).matchAll(/^##\s+(.+)$/gmu)];
  if (headings.length < 12) throw new Error("Canonical catalog must contain all English, Arabic, and Greek service sections.");
  return headings.map((match, index) => {
    const start = match.index + match[0].length;
    const end = headings[index + 1]?.index ?? content.length;
    return { heading: match[1].trim(), content: content.slice(start, end).trim() };
  }).filter((section) => section.content);
}

async function indexApprovedDocument(documentId) {
  const chunks = await rest(`rafa_knowledge_chunks?document_id=eq.${encodeURIComponent(documentId)}&select=chunk_index,content&order=chunk_index.asc`);
  if (!chunks.length) return 0;
  const vectors = await embedTexts(chunks.map((chunk) => chunk.content));
  return rest("rpc/rafa_store_knowledge_embeddings", {
    method: "POST",
    body: JSON.stringify({
      p_document_id: documentId,
      p_model: process.env.OPENROUTER_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL,
      p_embeddings: chunks.map((chunk, index) => ({ chunk_index: chunk.chunk_index, embedding: vectors[index] }))
    })
  });
}

async function main() {
  const { chunkKnowledge, normalizeKnowledgeContent } = await import("../dashboard/knowledge.js");
  const [servicesPage, groupPage, operatorGuide] = await Promise.all([
    approvedDocumentForSource("https://refalco.com/services/"),
    approvedDocumentForSource("https://refalco.com/"),
    approvedOperatorDocument("refal")
  ]);
  const approvedInputs = [servicesPage, groupPage, operatorGuide];
  const approvedCorpus = approvedInputs.map((item) => item.document.canonical_content).join("\n\n");
  const content = normalizeKnowledgeContent(fs.readFileSync(catalogPath, "utf8"));
  validateCatalog(content, approvedCorpus);
  // Keep language and service topics in separate retrieval units. The generic
  // paragraph chunker may otherwise join the end of one language to the next,
  // causing an Arabic or Greek query to retrieve a mixed-language boundary.
  const chunks = annotateChunks(chunkKnowledge(content, catalogSections(content)));
  const contentHash = crypto.createHash("sha256").update(content).digest("hex");
  const priceValidity = approvedInputs
    .filter((item) => /€999/u.test(item.document.canonical_content) && item.document.valid_until)
    .map((item) => item.document.valid_until)
    .sort()[0];
  if (!priceValidity || Date.parse(priceValidity) <= Date.now()) throw new Error("The approved €999 price evidence is missing or expired.");

  const existingSources = await rest(`rafa_knowledge_sources?canonical_url=eq.${encodeURIComponent(canonicalUrl)}&select=id&limit=1`);
  let source = existingSources[0];
  if (!source) {
    const created = await rest("rafa_knowledge_sources?select=id", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        canonical_url: canonicalUrl,
        display_name: sourceName,
        source_kind: "manual",
        trust_tier: "operator_supplied",
        enabled: false,
        approved: false,
        approval_note: "Canonical multilingual service catalog assembled only from active approved REFALCO knowledge."
      })
    });
    source = created[0];
  }
  if (!source?.id) throw new Error("Could not create or locate the canonical services source.");

  const stored = await rest("rpc/rafa_store_knowledge_revision", {
    method: "POST",
    body: JSON.stringify({
      p_source_id: source.id,
      p_title: documentTitle,
      p_content: content,
      p_content_sha256: contentHash,
      p_language_code: "mul",
      p_chunks: chunks,
      p_metadata: {
        catalogKind: "canonical_services",
        sourceFileName: path.basename(catalogPath),
        sourceFileType: "md",
        assembledFromDocumentIds: approvedInputs.map((item) => item.document.id),
        priceEvidenceValidUntil: priceValidity
      }
    })
  });

  const documentId = stored.document_id;
  const previouslyApproved = await rest(`rafa_knowledge_documents?source_id=eq.${source.id}&review_status=eq.approved&select=id&limit=100`);
  for (const document of previouslyApproved) {
    if (document.id === documentId) continue;
    await rest(`rafa_knowledge_documents?id=eq.${document.id}`, {
      method: "PATCH",
      body: JSON.stringify({ review_status: "superseded", approved_at: null, approved_by: null })
    });
  }
  await rest(`rafa_knowledge_documents?id=eq.${documentId}`, {
    method: "PATCH",
    body: JSON.stringify({
      title: documentTitle,
      valid_until: priceValidity,
      review_status: "approved",
      approved_at: new Date().toISOString(),
      approved_by: "group-owner"
    })
  });
  await rest(`rafa_knowledge_sources?id=eq.${source.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      display_name: sourceName,
      enabled: true,
      approved: true,
      approval_note: "Authoritative multilingual service catalog assembled from active approved REFALCO sources; price-bearing revision expires with its source evidence.",
      metadata: { catalogKind: "canonical_services", sourceFileName: path.basename(catalogPath) }
    })
  });
  const embeddingsStored = await indexApprovedDocument(documentId);

  const verification = await rest(`rafa_knowledge_documents?id=eq.${documentId}&select=id,source_id,revision,title,language_code,review_status,valid_until,metadata&limit=1`);
  const verifiedChunks = await rest(`rafa_knowledge_chunks?document_id=eq.${documentId}&select=id,chunk_index,heading,metadata,embedding_model,embedded_at&order=chunk_index.asc`);
  console.log(JSON.stringify({
    sourceId: source.id,
    document: verification[0] || null,
    chunkCount: verifiedChunks.length,
    embeddedChunkCount: verifiedChunks.filter((chunk) => chunk.embedded_at).length,
    embeddingsStored,
    inputDocumentIds: approvedInputs.map((item) => item.document.id)
  }, null, 2));
}

main().catch((error) => {
  console.error(`REFALCO service-catalog sync failed: ${String(error.message || error).slice(0, 500)}`);
  process.exitCode = 1;
});
