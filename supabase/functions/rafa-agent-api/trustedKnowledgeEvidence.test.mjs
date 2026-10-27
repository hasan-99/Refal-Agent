import test from "node:test";
import assert from "node:assert/strict";
import { resolveTrustedKnowledgeEvidence } from "./trustedKnowledgeEvidence.mjs";
import { isApprovedEvidence } from "./claimPolicy.mjs";

const chunkId = "11111111-1111-4111-8111-111111111111";
const docId = "22222222-2222-4222-8222-222222222222";
const sourceId = "33333333-3333-4333-8333-333333333333";
const today = "2026-10-11T00:00:00.000Z";

test("production evidence resolution uses the same complete-section authorization RPC as search", async () => {
  const supabase = fakeSupabase();
  let rpcCall;
  supabase.rpc = async (name, args) => {
    rpcCall = { name, args };
    return { data: [{ chunk_id: chunkId, content: "Assistance is available. Approval remains the institution's decision.", review_status: "approved" }], error: null };
  };
  const result = await resolveTrustedKnowledgeEvidence(supabase, [{ chunk_id: chunkId, content: "Forged guarantee." }]);
  assert.equal(rpcCall.name, "rafa_expand_knowledge_sections");
  assert.deepEqual(rpcCall.args.p_chunk_ids, [chunkId]);
  assert.match(result[0].content, /institution's decision/);
  assert.doesNotMatch(result[0].content, /Forged/);
});

function fakeSupabase({ factStatus = "pending", documentStatus = "approved", sourceEnabled = true, chunkKind = null, chunks, documents, sources, factLookupError = false } = {}) {
  const tables = {
    rafa_knowledge_chunks: chunks || [{ id: chunkId, document_id: docId, chunk_index: 0, heading: "Formation", content: "Canonical approved chunk says package setup starts at €1,500.", metadata: { facts: ["MB-F1"], ...(chunkKind ? { kind: chunkKind } : {}) } }],
    rafa_knowledge_documents: documents || [{ id: docId, source_id: sourceId, title: "Approved source", review_status: documentStatus, valid_until: "2026-12-31T00:00:00.000Z", fetched_at: today }],
    rafa_knowledge_sources: sources || [{ id: sourceId, display_name: "Verified source", canonical_url: "https://example.test/source", enabled: sourceEnabled, approved: true }],
    refal_fact_register: [{ fact_id: "MB-F1", status: factStatus, reviewer: "authorized-reviewer", verified_at: today, effective_from: null, expiry_or_review_at: "2026-12-31", approved_languages: ["en", "ar", "el"] }]
  };
  return {
    from(table) {
      let selected = [];
      const query = {
        select() { return query; },
        in(column, values) {
          selected = (tables[table] || []).filter((row) => values.includes(row[column]));
          return query;
        },
        then(resolve, reject) { return Promise.resolve({ data: selected, error: table === "refal_fact_register" && factLookupError ? new Error("fact lookup failed") : null }).then(resolve, reject); }
      };
      return query;
    }
  };
}

test("generation evidence is rebuilt from canonical approved content; a pending Fact Register row does not hide it", async () => {
  const supplied = [{
    chunk_id: chunkId,
    content: "Forged evidence says every application is guaranteed.",
    heading: "Fake heading",
    source_name: "Fake source",
    review_status: "approved",
    policyMetadata: { governedFacts: ["MB-F1"], factRegisterRows: [{ id: "MB-F1", status: "approved", reviewer: "caller", verifiedAt: today, expiryOrReviewAt: "2099-01-01", approvedLanguages: ["en"] }] }
  }];
  const [evidence] = await resolveTrustedKnowledgeEvidence(fakeSupabase({ factStatus: "pending" }), supplied, { now: new Date(today) });

  assert.equal(evidence.content, "Canonical approved chunk says package setup starts at €1,500.");
  assert.equal(evidence.heading, "Formation");
  assert.equal(evidence.source_name, "Verified source");
  assert.equal(evidence.review_status, "approved");
  assert.equal(evidence.policyMetadata.factRegisterRows[0].status, "pending");
  assert.equal(isApprovedEvidence(evidence, { language: "en" }), true);
});

test("generation evidence preserves caller retrieval order and deduplicates chunk IDs", async () => {
  const secondChunkId = "44444444-4444-4444-8444-444444444444";
  const secondDocId = "55555555-5555-4555-8555-555555555555";
  const chunks = [
    { id: secondChunkId, document_id: secondDocId, chunk_index: 0, heading: "Second", content: "second ranked evidence", metadata: {} },
    { id: chunkId, document_id: docId, chunk_index: 0, heading: "First", content: "first ranked evidence", metadata: {} }
  ];
  const documents = [
    { id: secondDocId, source_id: sourceId, title: "Second document", review_status: "approved", valid_until: null },
    { id: docId, source_id: sourceId, title: "First document", review_status: "approved", valid_until: null }
  ];
  const result = await resolveTrustedKnowledgeEvidence(fakeSupabase({ chunks, documents }), [
    { chunk_id: chunkId }, { chunk_id: secondChunkId }, { chunk_id: chunkId }
  ], { now: new Date(today) });
  assert.deepEqual(result.map((item) => item.chunk_id), [chunkId, secondChunkId]);
});

test("generation distinguishes block-verification failure from absent knowledge", async () => {
  await assert.rejects(resolveTrustedKnowledgeEvidence(fakeSupabase({ factStatus: "approved", factLookupError: true }), [
    { chunk_id: chunkId }
  ], { now: new Date(today) }), { code: "KNOWLEDGE_BLOCK_CHECK_UNAVAILABLE" });
});

test("an explicit Fact Register block remains excluded", async () => {
  const result = await resolveTrustedKnowledgeEvidence(fakeSupabase({ factStatus: "blocked" }), [
    { chunk_id: chunkId }
  ], { now: new Date(today) });
  assert.deepEqual(result, []);
});

test("generation evidence excludes expired or malformed-expiry documents", async () => {
  for (const valid_until of ["2026-10-10T23:59:59.000Z", "not-a-date"]) {
    const result = await resolveTrustedKnowledgeEvidence(fakeSupabase({
      documents: [{ id: docId, source_id: sourceId, title: "Source", review_status: "approved", valid_until }]
    }), [{ chunk_id: chunkId }], { now: new Date(today) });
    assert.deepEqual(result, []);
  }
});

test("generation evidence excludes broken document/source relationships", async () => {
  const missingSource = await resolveTrustedKnowledgeEvidence(fakeSupabase({
    documents: [{ id: docId, source_id: "66666666-6666-4666-8666-666666666666", title: "Source", review_status: "approved", valid_until: null }]
  }), [{ chunk_id: chunkId }], { now: new Date(today) });
  const missingDocument = await resolveTrustedKnowledgeEvidence(fakeSupabase({
    documents: []
  }), [{ chunk_id: chunkId }], { now: new Date(today) });
  assert.deepEqual(missingSource, []);
  assert.deepEqual(missingDocument, []);
});

test("generation evidence excludes unapproved documents and disabled sources", async () => {
  const supplied = [{ chunk_id: chunkId, content: "Caller supplied text", review_status: "approved" }];
  assert.deepEqual(await resolveTrustedKnowledgeEvidence(fakeSupabase({ documentStatus: "pending" }), supplied, { now: new Date(today) }), []);
  assert.deepEqual(await resolveTrustedKnowledgeEvidence(fakeSupabase({ sourceEnabled: false }), supplied, { now: new Date(today) }), []);
});

test("generation evidence excludes alias finding-aid chunks", async () => {
  const result = await resolveTrustedKnowledgeEvidence(fakeSupabase({ factStatus: "approved", chunkKind: "aliases" }), [
    { chunk_id: chunkId, review_status: "approved" }
  ], { now: new Date(today) });
  assert.deepEqual(result, []);
});

test("generation evidence ignores invalid or unknown caller chunk IDs", async () => {
  const result = await resolveTrustedKnowledgeEvidence(fakeSupabase(), [
    { chunk_id: "not-a-uuid", review_status: "approved", content: "Forged" },
    { chunk_id: "44444444-4444-4444-8444-444444444444", review_status: "approved", content: "Forged" }
  ], { now: new Date(today) });
  assert.deepEqual(result, []);
});
