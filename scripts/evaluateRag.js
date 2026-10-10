const path = require("node:path");
const { loadProjectEnv } = require("../src/env");

loadProjectEnv(path.resolve(__dirname, ".."));

const { embedQueryTexts, DEFAULT_EMBEDDING_MODEL } = require("../src/ai");
const { createStore } = require("../src/supabaseStore");
const { retrieveKnowledgeForTurn } = require("../src/knowledgeQuery");
const { collectDynamicFallback } = require("../src/dynamicDataFallback");

// This is a real-data smoke set for the bot's actual, language-aware retrieval
// path. The source_name values are the approved corpus document titles.
const cases = [
  {
    id: "services_en",
    language: "english", domain: "services",
    intents: ["services"],
    query: "What is included when setting up a company in Cyprus?",
    expectedSource: "What the Cyprus company formation package includes",
    expectedDocumentTitle: "What the Cyprus company formation package includes",
    expectedHeading: "The seven things the package covers",
    expectedFacts: ["Cyprus Ltd formation", "Company name reservation and approval", "Document preparation and attestation"],
    maxRank: 1
  },
  {
    id: "services_ar",
    language: "arabic", domain: "services",
    intents: ["services"],
    query: "شو بيشمل عرض تأسيس الشركة بقبرص؟",
    expectedSource: "شو بتشمل باقة تأسيس الشركة القبرصية بالضبط",
    expectedDocumentTitle: "شو بتشمل باقة تأسيس الشركة القبرصية بالضبط",
    expectedHeading: "شو فيها باقة التأسيس بالضبط",
    expectedFacts: ["تأسيس شركة قبرصية", "حجز واعتماد اسم الشركة", "تجهيز وتوثيق المستندات"],
    maxRank: 1
  },
  {
    id: "services_el",
    language: "greek", domain: "services",
    intents: ["services"],
    query: "Τι περιλαμβάνει η υπηρεσία σύστασης εταιρείας στην Κύπρο;",
    expectedSource: "Τι περιλαμβάνει το πακέτο ίδρυσης κυπριακής εταιρείας",
    expectedDocumentTitle: "Τι περιλαμβάνει το πακέτο ίδρυσης κυπριακής εταιρείας",
    expectedHeading: "Τα επτά πράγματα που καλύπτει το πακέτο",
    expectedFacts: ["Σύσταση κυπριακής Ltd", "Δέσμευση και έγκριση ονόματος", "Ετοιμασία και πιστοποίηση εγγράφων"],
    maxRank: 1
  },
  {
    id: "group_areas_en",
    language: "english", domain: "company_profile",
    intents: ["company_info"],
    query: "What business areas does Refalco Group work in?",
    expectedSource: "Who Refalco Group is, and what the experience numbers actually count",
    expectedDocumentTitle: "Who Refalco Group is, and what the experience numbers actually count",
    expectedFacts: ["Company formation and corporate structuring", "Tax and accounting services", "development services"],
    maxRank: 1
  },
  {
    id: "group_areas_ar",
    language: "arabic", domain: "company_profile",
    intents: ["company_info"],
    query: "شو مجالات عمل مجموعة الشركة؟",
    expectedSource: "مين هي Refalco Group وشو بتعني أرقام الخبرة والمشاريع فعلياً",
    expectedDocumentTitle: "مين هي Refalco Group وشو بتعني أرقام الخبرة والمشاريع فعلياً",
    expectedFacts: ["تأسيس الشركات وهيكلتها", "الضرائب والمحاسبة", "الاستثمار والعقارات والتطوير"],
    maxRank: 1
  },
  {
    id: "group_areas_el",
    language: "greek", domain: "company_profile",
    intents: ["company_info"],
    query: "Ποιοι είναι οι βασικοί τομείς της Refalco Group;",
    expectedSource: "Ποιος είναι ο όμιλος Refalco και τι μετρούν πραγματικά οι αριθμοί της εμπειρίας",
    expectedDocumentTitle: "Ποιος είναι ο όμιλος Refalco και τι μετρούν πραγματικά οι αριθμοί της εμπειρίας",
    expectedFacts: ["Σύσταση εταιρειών και εταιρική δόμηση", "Φορολογικές και λογιστικές υπηρεσίες", "ακίνητα και ανάπτυξη"],
    maxRank: 1
  },
];

function normalized(value) {
  return String(value || "").normalize("NFC").toLocaleLowerCase().replace(/\s+/gu, " ").trim();
}

function matches(value, expected) {
  return normalized(value).includes(normalized(expected));
}

function wilsonInterval(successes, sampleSize, z = 1.96) {
  if (!Number.isInteger(sampleSize) || sampleSize <= 0) return null;
  const p = successes / sampleSize;
  const z2 = z * z;
  const denominator = 1 + z2 / sampleSize;
  const center = (p + z2 / (2 * sampleSize)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) / sampleSize) + (z2 / (4 * sampleSize * sampleSize))) / denominator;
  return { lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) };
}

function groupedParity(results, key) {
  const groups = {};
  for (const result of results.filter((item) => item.expectedSource && item[key])) {
    const group = groups[result[key]] || (groups[result[key]] = { samples: 0, passed: 0, errors: 0 });
    group.samples += 1;
    if (result.status === "PASS") group.passed += 1;
    if (result.status === "ERROR") group.errors += 1;
  }
  for (const group of Object.values(groups)) {
    group.passRate = group.samples ? group.passed / group.samples : null;
    group.confidence95 = wilsonInterval(group.passed, group.samples);
  }
  return groups;
}

function languageParity(results) {
  const byLanguage = groupedParity(results, "language");
  const rates = Object.values(byLanguage).map((group) => group.passRate).filter(Number.isFinite);
  const maxGap = rates.length > 1 ? Math.max(...rates) - Math.min(...rates) : null;
  const everyLanguagePassed = rates.length > 0 && rates.every((rate) => rate > 0);
  return {
    method: "positive retrieval cases; Wilson 95% intervals; retrieval errors count as failures",
    byLanguage,
    byDomain: groupedParity(results, "domain"),
    maxPassRateGap: maxGap,
    withinTenPercentagePoints: maxGap === null ? null : maxGap <= 0.10 && everyLanguagePassed,
    everyLanguagePassed
  };
}

function scoreResult(testCase, rows, now = new Date()) {
  const results = Array.isArray(rows) ? rows : [];
  if (testCase.noEvidence) {
    return {
      id: testCase.id,
      language: testCase.language || null,
      domain: testCase.domain || null,
      query: testCase.query,
      status: results.length === 0 ? "PASS" : "FAIL",
      reason: results.length === 0 ? "no evidence returned for negative control" : "retrieval returned evidence for a negative control",
      resultCount: results.length,
      targetDocumentFound: false,
      targetChunkId: null,
      targetRank: null,
      targetScore: null,
      candidates: results.map(candidateSummary)
    };
  }

  const documentIndex = results.findIndex((row) =>
    row.source_name === testCase.expectedSource &&
    (!testCase.expectedDocumentTitle || row.document_title === testCase.expectedDocumentTitle)
  );
  const target = documentIndex >= 0 ? results[documentIndex] : null;
  const targetChunkIndex = testCase.expectedHeading
    ? results.findIndex((row) => row.source_name === testCase.expectedSource &&
      (!testCase.expectedDocumentTitle || row.document_title === testCase.expectedDocumentTitle) &&
      matches(row.heading, testCase.expectedHeading))
    : results.findIndex((row) => row.source_name === testCase.expectedSource &&
      (!testCase.expectedDocumentTitle || row.document_title === testCase.expectedDocumentTitle) &&
      (testCase.expectedFacts || []).some((fact) => matches(`${row.heading || ""} ${row.content || ""}`, fact)));
  const targetChunk = targetChunkIndex >= 0 ? results[targetChunkIndex] : null;
  const targetRank = targetChunk ? targetChunkIndex + 1 : target ? documentIndex + 1 : null;
  const factChecks = (testCase.expectedFacts || []).map((fact) => ({ fact, found: results.some((row) =>
    row.source_name === testCase.expectedSource &&
    (!testCase.expectedDocumentTitle || row.document_title === testCase.expectedDocumentTitle) &&
    matches(`${row.heading || ""} ${row.content || ""}`, fact)
  ) }));
  const headingFound = !testCase.expectedHeading || results.some((row) =>
    row.source_name === testCase.expectedSource && matches(row.heading, testCase.expectedHeading)
  );
  const metadataReady = Boolean(target && target.fetched_at && target.review_status && target.approved_at);
  const freshnessReady = !testCase.mutablePricing || Boolean(target?.valid_until && Date.parse(target.valid_until) > now.getTime());
  const factsFound = factChecks.every((check) => check.found);
  const withinRankTarget = !testCase.maxRank || (targetRank !== null && targetRank <= testCase.maxRank);
  const status = target && headingFound && factsFound && metadataReady && freshnessReady && withinRankTarget ? "PASS" : "FAIL";
  const missingFacts = factChecks.filter((check) => !check.found).map((check) => check.fact);
  const candidateSources = [...new Set(results.map((row) => row.source_name).filter(Boolean))];
  const relevantRows = results.filter((row) => row.source_name === testCase.expectedSource &&
    (!testCase.expectedDocumentTitle || row.document_title === testCase.expectedDocumentTitle) &&
    (testCase.expectedFacts || []).some((fact) => matches(`${row.heading || ""} ${row.content || ""}`, fact)));
  return {
    id: testCase.id,
    language: testCase.language || null,
    domain: testCase.domain || null,
    query: testCase.query,
    status,
    reason: status === "PASS" ? "target document/chunk, expected facts, and review/freshness metadata verified" : [
      !target && "target source/document missing from top-k",
      target && !headingFound && "target heading/chunk missing from top-k",
      missingFacts.length && `expected facts missing: ${missingFacts.join(", ")}`,
      target && !metadataReady && "fetched_at/review_status/approved_at metadata missing",
      target && testCase.mutablePricing && !freshnessReady && "mutable pricing evidence is missing a future valid_until",
      target && !withinRankTarget && `target ranked below top-${testCase.maxRank}`
    ].filter(Boolean).join("; "),
    resultCount: results.length,
    expectedSource: testCase.expectedSource,
    targetDocumentFound: Boolean(target),
    targetDocumentId: target?.document_id || null,
    targetChunkId: targetChunk?.chunk_id || null,
    targetHeading: targetChunk?.heading || null,
    targetDocumentRank: target ? documentIndex + 1 : null,
    targetChunkRank: targetChunk ? targetChunkIndex + 1 : null,
    targetRank,
    targetScore: targetChunk ? Number(targetChunk.rank ?? targetChunk.score) || null : target ? Number(target.rank ?? target.score) || null : null,
    expectedFacts: factChecks,
    fetchedAt: target?.fetched_at || null,
    approvedAt: target?.approved_at || null,
    validUntil: target?.valid_until || null,
    reviewStatus: target?.review_status || null,
    precisionAtK: results.length ? relevantRows.length / results.length : 0,
    factRecallAtK: factChecks.length ? factChecks.filter((check) => check.found).length / factChecks.length : 1,
    reciprocalRank: targetChunk ? 1 / (targetChunkIndex + 1) : target ? 1 / (documentIndex + 1) : 0,
    candidateSources,
    candidates: results.map(candidateSummary)
  };
}

function candidateSummary(row, index) {
  return {
    rank: index + 1,
    score: Number(row.rank ?? row.score) || null,
    sourceName: row.source_name || null,
    documentId: row.document_id || null,
    documentTitle: row.document_title || null,
    chunkId: row.chunk_id || null,
    heading: row.heading || null,
    fetchedAt: row.fetched_at || null,
    approvedAt: row.approved_at || null,
    validUntil: row.valid_until || null,
    reviewStatus: row.review_status || null,
    snippet: String(row.content || "").replace(/\s+/gu, " ").slice(0, 360)
  };
}

async function run() {
  const store = createStore();
  const report = { generatedAt: new Date().toISOString(), embeddingModel: DEFAULT_EMBEDDING_MODEL, cases: [] };
  let embeddingUnavailable = false;
  for (const testCase of cases) {
    if (!testCase.noEvidence && !embeddingUnavailable) {
      try {
        await embedQueryTexts([testCase.query]);
      } catch (error) {
        embeddingUnavailable = true;
      }
    }
    let rows;
    let retrievalError = null;
    try {
      const retrieval = await retrieveKnowledgeForTurn(testCase.query, {
        user: { history: [] },
        intents: testCase.intents || [],
        language: testCase.language || "english",
        store,
        embedQueryTexts: embeddingUnavailable ? null : embedQueryTexts,
        embeddingModel: embeddingUnavailable ? null : DEFAULT_EMBEDDING_MODEL,
        matchCount: 6
      });
      if (!retrieval.complete) throw retrieval.failures[0] || new Error("incomplete retrieval");
      rows = retrieval.evidence;
    } catch (error) {
      rows = [];
      retrievalError = String(error.message || error).slice(0, 180);
    }
    const outcome = scoreResult(testCase, rows);
    if (retrievalError) {
      outcome.status = "ERROR";
      outcome.reason = `retrieval error: ${retrievalError}`;
    }
    if (embeddingUnavailable && !testCase.noEvidence) outcome.embeddingWarning = "local embeddings unavailable; lexical fallback used";
    report.cases.push(outcome);
  }
  const completed = report.cases.filter((item) => item.status !== "ERROR");
  const positive = completed.filter((item) => item.expectedSource);
  const negatives = completed.filter((item) => !item.expectedSource);
  report.summary = {
    total: report.cases.length,
    passed: report.cases.filter((item) => item.status === "PASS").length,
    failed: report.cases.filter((item) => item.status === "FAIL").length,
    errors: report.cases.filter((item) => item.status === "ERROR").length,
    positives: positive.length,
    meanReciprocalRank: positive.length ? positive.reduce((sum, item) => sum + item.reciprocalRank, 0) / positive.length : null,
    meanPrecisionAtK: positive.length ? positive.reduce((sum, item) => sum + item.precisionAtK, 0) / positive.length : null,
    meanFactRecallAtK: positive.length ? positive.reduce((sum, item) => sum + item.factRecallAtK, 0) / positive.length : null,
    negativeControls: negatives.length,
    falsePositiveRate: negatives.length ? negatives.filter((item) => item.resultCount > 0).length / negatives.length : null,
    embeddingsAvailable: !embeddingUnavailable,
    multilingualParity: languageParity(report.cases)
  };
  try {
    const priceFlow = await collectDynamicFallback(store, "What is the current price for the Cyprus company formation package?");
    const currentPrice = priceFlow.live.find((item) => item._dynamicKind === "offers" && item._dynamicSubject === "formation-package");
    report.livePricingCheck = {
      status: currentPrice ? "PASS" : "FAIL",
      route: priceFlow.requested.some((item) => item.kind === "offers") ? "dynamic_offers_table" : "not_routed",
      approved: currentPrice?.review_status === "approved",
      currentThrough: currentPrice?.valid_until || null,
      amountPresent: Number.isFinite(currentPrice?._amount)
    };
  } catch (error) {
    report.livePricingCheck = { status: "ERROR", route: "dynamic_offers_table", reason: String(error.message || error).slice(0, 160) };
  }
  report.scopeNotes = [
    "This smoke set evaluates the real language-aware retrieval path against current approved corpus titles.",
    "Live prices are deliberately excluded from knowledge RAG and must be checked through the dynamic pricing table.",
    "Service-transition claims are excluded until a matching approved evidence document exists.",
    "Weather, credentials, and prompt-injection routing are answer-policy checks, not raw retrieval zero-row assertions.",
    "The live pricing check uses the same dynamic fallback as the bot and reports validity without copying the amount into RAG.",
    "This six-case smoke set is not the 870-question release evaluation and cannot establish release readiness."
  ];
  const outputPath = path.resolve(process.argv[2] || path.join(__dirname, "..", "reports", "rag-evaluation", `${new Date().toISOString().slice(0, 10)}.json`));
  const fs = require("node:fs/promises");
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ outputPath, ...report.summary }, null, 2));
  if (report.summary.failed || report.summary.errors || report.livePricingCheck.status !== "PASS") process.exitCode = 1;
  return report;
}

if (require.main === module) run().catch((error) => {
  console.error(`RAG evaluation could not run: ${String(error.message || error).slice(0, 180)}`);
  process.exitCode = 1;
});

module.exports = { cases, scoreResult, candidateSummary, wilsonInterval, groupedParity, languageParity, run };
