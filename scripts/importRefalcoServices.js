const path = require("node:path");
const crypto = require("node:crypto");
const { loadProjectEnv } = require("../src/env");
const { embedTexts, DEFAULT_EMBEDDING_MODEL } = require("../src/ai");

loadProjectEnv(path.resolve(__dirname, ".."));

const sourceUrl = "https://refalco.com/services/";
const sourceName = "REFALCO GROUP Services";
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
  const { fetchKnowledgePage, extractKnowledgeText } = await import("../dashboard/knowledge.js");
  const page = await fetchKnowledgePage(sourceUrl);
  const extracted = extractKnowledgeText(page.html, page.url);
  const htmlLanguage = page.html.match(/<html\b[^>]*\blang=["']([^"']+)/i)?.[1];
  const language = String(htmlLanguage || "ar").slice(0, 8);

  const sources = await rest(`rafa_knowledge_sources?canonical_url=eq.${encodeURIComponent(sourceUrl)}&select=id&limit=1`);
  let source = sources[0];
  if (!source) {
    const created = await rest("rafa_knowledge_sources?select=id", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ canonical_url: sourceUrl, display_name: sourceName, source_kind: "first_party_website", trust_tier: "first_party", enabled: false, approved: false, approval_note: "Fetched content requires operator review before approval and retrieval." })
    });
    source = created[0];
  }
  if (!source?.id) throw new Error("Could not create or locate the REFALCO services source.");

  const content = extracted.content.slice(0, 250_000);
  const contentHash = crypto.createHash("sha256").update(content).digest("hex");
  const stored = await rest("rpc/rafa_store_knowledge_revision", {
    method: "POST",
    body: JSON.stringify({
      p_source_id: source.id,
      p_title: extracted.title,
      p_content: content,
      p_content_sha256: contentHash,
      p_language_code: language,
      p_chunks: extracted.chunks
    })
  });

  // Keep the raw page pending review. Approve only these narrowly scoped facts,
  // which are sufficient to answer basic company-formation questions safely.
  const serviceEnglish = "REFALCO's services page describes remote assistance with setting up a company in Cyprus. Listed support includes preparing and submitting incorporation documents, reserving a company name, and following up on the application. The page lists a €999 package that includes four months of company secretary and registered address services.";
  const serviceArabic = "صفحة خدمات ريفالكو بتشرح خدمة تأسيس شركة بقبرص عن بُعد. وبتشمل المساعدة بتجهيز وتقديم أوراق التأسيس، حجز اسم للشركة، ومتابعة الطلب. الصفحة بتذكر باقة بسعر 999 يورو، تشمل أربعة أشهر من خدمات سكرتارية الشركة والعنوان المسجّل.";
  const serviceContent = `${serviceEnglish}\n${serviceArabic}`;
  const serviceHash = crypto.createHash("sha256").update(serviceContent).digest("hex");
  const serviceRevision = await rest("rpc/rafa_store_knowledge_revision", {
    method: "POST",
    body: JSON.stringify({
      p_source_id: source.id,
      p_title: "Company setup in Cyprus",
      p_content: serviceContent,
      p_content_sha256: serviceHash,
      p_language_code: "mul",
      p_chunks: [
        { chunk_index: 0, heading: "Company setup in Cyprus", content: serviceEnglish, metadata: { language: "en" } },
        { chunk_index: 1, heading: "تأسيس شركة في قبرص", content: serviceArabic, metadata: { language: "ar" } }
      ]
    })
  });
  const previouslyApprovedServiceDocs = await rest(`rafa_knowledge_documents?source_id=eq.${encodeURIComponent(source.id)}&review_status=eq.approved&select=id&limit=100`);
  for (const document of previouslyApprovedServiceDocs) {
    if (document.id !== serviceRevision.document_id) {
      await rest(`rafa_knowledge_documents?id=eq.${encodeURIComponent(document.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ review_status: "superseded", approved_at: null, approved_by: null })
      });
    }
  }
  await rest(`rafa_knowledge_documents?id=eq.${encodeURIComponent(serviceRevision.document_id)}`, {
    method: "PATCH",
    body: JSON.stringify({ title: "Company setup in Cyprus", review_status: "approved", approved_at: new Date().toISOString(), approved_by: "group-owner" })
  });
  const serviceEmbeddingsStored = await indexApprovedDocument(serviceRevision.document_id);
  await rest(`rafa_knowledge_sources?id=eq.${encodeURIComponent(source.id)}`, {
    method: "PATCH",
    body: JSON.stringify({ enabled: true, approved: true, approval_note: "Only the approved bilingual company-formation summary is retrievable; the fetched page revision remains pending review." })
  });

  const oldSources = await rest("rafa_knowledge_sources?select=id,canonical_url,display_name&limit=500");
  const lamarSources = oldSources.filter((row) => /lamar/i.test(`${row.canonical_url} ${row.display_name}`));
  for (const oldSource of lamarSources) {
    await rest(`rafa_knowledge_sources?id=eq.${encodeURIComponent(oldSource.id)}`, { method: "DELETE" });
  }

  const internalSourceUrl = "manual://owner-confirmed/refalco-group-structure";
  const internalSourceRows = await rest(`rafa_knowledge_sources?canonical_url=eq.${encodeURIComponent(internalSourceUrl)}&select=id&limit=1`);
  let internalSource = internalSourceRows[0];
  if (!internalSource) {
    const created = await rest("rafa_knowledge_sources?select=id", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ canonical_url: internalSourceUrl, display_name: "Owner-confirmed REFALCO services transition", source_kind: "manual", trust_tier: "operator_supplied", enabled: false, approved: false, approval_note: "Owner-confirmed service transition; keep verification provenance internal." })
    });
    internalSource = created[0];
  }
  const internalEnglish = "LAMAR's former Cyprus company-formation services are now provided under REFALCO services.";
  const internalArabic = "خدمات لامار السابقة لتأسيس الشركات في قبرص أصبحت تُقدَّم الآن ضمن خدمات ريفالكو.";
  const internalContent = `${internalEnglish}\n${internalArabic}`;
  const internalHash = crypto.createHash("sha256").update(internalContent).digest("hex");
  const existingInternalDocs = await rest(`rafa_knowledge_documents?source_id=eq.${encodeURIComponent(internalSource.id)}&select=id,content_sha256,review_status,approved_at&limit=100`);
  for (const document of existingInternalDocs) {
    if (document.content_sha256 !== internalHash && document.review_status === "approved") {
      await rest(`rafa_knowledge_documents?id=eq.${encodeURIComponent(document.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ review_status: "superseded", approved_at: null, approved_by: null })
      });
    }
  }
  const internalRevision = await rest("rpc/rafa_store_knowledge_revision", {
    method: "POST",
    body: JSON.stringify({
      p_source_id: internalSource.id,
      p_title: "Former LAMAR services now under REFALCO",
      p_content: internalContent,
      p_content_sha256: internalHash,
      p_language_code: "mul",
      p_chunks: [
        { chunk_index: 0, heading: "Former services now under REFALCO", content: internalEnglish, metadata: { language: "en" } },
        { chunk_index: 1, heading: "الخدمات السابقة أصبحت ضمن خدمات ريفالكو", content: internalArabic, metadata: { language: "ar" } }
      ]
    })
  });
  await rest(`rafa_knowledge_documents?id=eq.${encodeURIComponent(internalRevision.document_id)}`, {
    method: "PATCH",
    body: JSON.stringify({ title: "Former LAMAR services now under REFALCO", review_status: "approved", approved_at: new Date().toISOString(), approved_by: "group-owner" })
  });
  const transitionEmbeddingsStored = await indexApprovedDocument(internalRevision.document_id);
  await rest(`rafa_knowledge_sources?id=eq.${encodeURIComponent(internalSource.id)}`, {
    method: "PATCH",
    body: JSON.stringify({ display_name: "Owner-confirmed REFALCO services transition", enabled: true, approved: true, approval_note: "Owner-confirmed service transition; keep verification provenance internal." })
  });

  const remaining = await rest("rafa_knowledge_sources?select=id,canonical_url,display_name,enabled,approved&canonical_url=eq." + encodeURIComponent(sourceUrl));
  const verification = await rest(`rafa_knowledge_documents?id=eq.${encodeURIComponent(stored.document_id)}&select=id,source_id,revision,title,language_code,review_status&limit=1`);
  const serviceVerification = await rest(`rafa_knowledge_documents?id=eq.${encodeURIComponent(serviceRevision.document_id)}&select=id,source_id,revision,title,language_code,review_status&limit=1`);
  const affiliation = await rest(`rafa_knowledge_documents?id=eq.${encodeURIComponent(internalRevision.document_id)}&select=id,title,review_status,language_code&limit=1`);
  const affiliationHistory = await rest(`rafa_knowledge_documents?source_id=eq.${encodeURIComponent(internalSource.id)}&select=title,review_status,language_code&order=revision.asc&limit=20`);
  const stillLamar = (await rest("rafa_knowledge_sources?select=id,canonical_url,display_name&limit=500")).some((row) => /lamar/i.test(`${row.canonical_url} ${row.display_name}`));
  console.log(JSON.stringify({ source: sourceName, url: page.url, title: extracted.title, language, characters: content.length, chunks: extracted.chunks.length, fetchedDocument: verification[0] || null, approvedServiceDocument: serviceVerification[0] || null, approvedServiceEmbeddingsStored: serviceEmbeddingsStored, source: remaining[0] || null, affiliationFact: affiliation[0] || null, affiliationEmbeddingsStored: transitionEmbeddingsStored, affiliationHistory, lamarSourceRowsRemaining: stillLamar, lamarSourcesRemoved: lamarSources.length }));
}

main().catch((error) => {
  console.error(`REFALCO services import failed: ${String(error.message || error).slice(0, 300)}`);
  process.exitCode = 1;
});
