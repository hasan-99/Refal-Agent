const test = require("node:test");
const assert = require("node:assert/strict");
const { scoreResult } = require("./evaluateRag");

const validEvidence = {
  source_name: "the business Services",
  document_id: "doc-1",
  document_title: "Company setup in Cyprus",
  chunk_id: "chunk-1",
  heading: "Company setup in Cyprus",
  content: "Preparing and submitting incorporation documents, reserving a company name, and following the application.",
  rank: 0.031,
  fetched_at: "2026-10-03T10:00:00.000Z",
  approved_at: "2026-10-03T10:15:00.000Z",
  valid_until: null,
  review_status: "approved"
};

test("RAG scoring records source, document, chunk rank, score, and expected facts", () => {
  const result = scoreResult({
    id: "services-en",
    query: "How do you help?",
    expectedSource: "the business Services",
    expectedDocumentTitle: "Company setup in Cyprus",
    expectedHeading: "Company setup in Cyprus",
    expectedFacts: ["incorporation documents", "company name"]
  }, [validEvidence]);

  assert.equal(result.status, "PASS");
  assert.equal(result.targetDocumentId, "doc-1");
  assert.equal(result.targetChunkId, "chunk-1");
  assert.equal(result.targetDocumentRank, 1);
  assert.equal(result.targetChunkRank, 1);
  assert.equal(result.targetScore, 0.031);
  assert.deepEqual(result.expectedFacts.map((item) => item.found), [true, true]);
});

test("mutable pricing is not considered grounded without a future validity date", () => {
  const result = scoreResult({
    id: "price-en",
    query: "Price?",
    expectedSource: "the business Services",
    expectedDocumentTitle: "Company setup in Cyprus",
    expectedFacts: ["company name"],
    mutablePricing: true
  }, [validEvidence], new Date("2026-10-04T00:00:00.000Z"));

  assert.equal(result.status, "FAIL");
  assert.match(result.reason, /future valid_until/);
});

test("negative control fails when search returns any evidence", () => {
  const result = scoreResult({ id: "weather", query: "weather", noEvidence: true }, [validEvidence]);
  assert.equal(result.status, "FAIL");
  assert.equal(result.resultCount, 1);
});

test("Arabic expected facts are compared without corrupting Unicode", () => {
  const result = scoreResult({
    id: "services-ar",
    query: "شو الخدمة؟",
    expectedSource: "the business Services",
    expectedDocumentTitle: "Company setup in Cyprus",
    expectedHeading: "تأسيس شركة في قبرص",
    expectedFacts: ["تجهيز وتقديم أوراق التأسيس"]
  }, [{ ...validEvidence, heading: "تأسيس شركة في قبرص", content: "تشمل تجهيز وتقديم أوراق التأسيس وحجز الاسم." }]);

  assert.equal(result.status, "PASS");
  assert.equal(result.targetChunkId, "chunk-1");
});
