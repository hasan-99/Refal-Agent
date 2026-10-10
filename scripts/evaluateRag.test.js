const test = require("node:test");
const assert = require("node:assert/strict");
const { cases, scoreResult, wilsonInterval, languageParity } = require("./evaluateRag");

const validEvidence = {
  source_name: "Refalco Group Services",
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
    expectedSource: "Refalco Group Services",
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
    expectedSource: "Refalco Group Services",
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
    expectedSource: "Refalco Group Services",
    expectedDocumentTitle: "Company setup in Cyprus",
    expectedHeading: "تأسيس شركة في قبرص",
    expectedFacts: ["تجهيز وتقديم أوراق التأسيس"]
  }, [{ ...validEvidence, heading: "تأسيس شركة في قبرص", content: "تشمل تجهيز وتقديم أوراق التأسيس وحجز الاسم." }]);

  assert.equal(result.status, "PASS");
  assert.equal(result.targetChunkId, "chunk-1");
});

test("retrieval reports multilingual pass rates per language and domain with Wilson intervals", () => {
  const result = languageParity([
    { expectedSource: "source", language: "english", domain: "services", status: "PASS" },
    { expectedSource: "source", language: "english", domain: "services", status: "FAIL" },
    { expectedSource: "source", language: "arabic", domain: "services", status: "PASS" },
    { expectedSource: "source", language: "greek", domain: "pricing", status: "ERROR" },
    { language: "english", domain: "negative_controls", status: "PASS" }
  ]);

  assert.deepEqual(result.byLanguage.english, {
    samples: 2, passed: 1, errors: 0, passRate: 0.5,
    confidence95: wilsonInterval(1, 2)
  });
  assert.equal(result.byLanguage.greek.samples, 1);
  assert.equal(result.byLanguage.greek.errors, 1);
  assert.equal(result.byLanguage.greek.passRate, 0);
  assert.equal(result.byDomain.services.samples, 3);
  assert.equal(result.byDomain.negative_controls, undefined);
  assert.equal(result.maxPassRateGap, 1);
  assert.equal(result.withinTenPercentagePoints, false);
  const equalZero = languageParity([
    { expectedSource: "s", language: "english", domain: "x", status: "FAIL" },
    { expectedSource: "s", language: "arabic", domain: "x", status: "FAIL" },
    { expectedSource: "s", language: "greek", domain: "x", status: "FAIL" }
  ]);
  assert.equal(equalZero.withinTenPercentagePoints, false, "equal zero pass rates are not successful language parity");
});

test("real-data smoke cases use current corpus titles and never expect live prices from RAG", () => {
  assert.ok(cases.some((item) => item.id === "services_en" && item.expectedDocumentTitle === "What the Cyprus company formation package includes"));
  assert.ok(cases.some((item) => item.id === "services_ar" && item.language === "arabic"));
  assert.ok(cases.some((item) => item.id === "services_el" && item.language === "greek"));
  assert.equal(cases.some((item) => (item.expectedFacts || []).some((fact) => /€\s?\d|\d+\s*يورو/u.test(fact))), false);
  assert.equal(cases.some((item) => item.id.startsWith("former_services_")), false, "missing approved transition evidence is tracked as a knowledge gap, not asserted as present");
});

test("Wilson intervals are unavailable for an empty sample and bounded for finite samples", () => {
  assert.equal(wilsonInterval(0, 0), null);
  const interval = wilsonInterval(10, 10);
  assert.ok(interval.lower >= 0);
  assert.ok(interval.upper <= 1);
  assert.ok(interval.lower < 1);
  assert.equal(interval.upper, 1);
});
