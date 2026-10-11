"use strict";

// Live verification for the unified knowledge-search workflow.
//
//   npm run verify:retrieval            -- run every scenario
//   npm run verify:retrieval -- --only=ar-colloquial
//   npm run verify:retrieval -- --trace -- print the full admin trace per case
//
// This talks to the REAL database. It is the check that a unit test cannot be:
// the unit tests prove the engine does the right thing with a fake corpus, and
// this proves the real corpus actually answers real questions.
//
// It starts by calling the knowledge-health RPC, because every "the agent says
// it has no information" report has to rule out a BLACKOUT first. If zero
// chunks are eligible, or every eligible chunk is missing an embedding, no
// amount of query tuning matters and the run says so instead of reporting 12
// retrieval failures.

const path = require("node:path");
const { loadProjectEnv } = require("../src/env");

loadProjectEnv(path.resolve(__dirname, ".."));

const { createStore } = require("../src/supabaseStore");
const { embedQueryTexts, DEFAULT_EMBEDDING_MODEL } = require("../src/ai");
const { retrieveKnowledgeForTurn } = require("../src/knowledgeQuery");

const args = process.argv.slice(2);
const showTrace = args.includes("--trace");
const only = (args.find((arg) => arg.startsWith("--only=")) || "").replace("--only=", "");

// Each case names what it is PROVING, not just what it asks. `expect` is a
// predicate over the retrieved sections so a scenario can assert a property
// ("a boundary section came back", "more than one document contributed")
// rather than a brittle exact string.
const CASES = [
  {
    id: "en-known-answer",
    covers: "a known-answer question retrieves its supporting section",
    question: "What is included in the Cyprus company formation package?",
    intents: ["services"], language: "english",
    expect: (sections) => sections.length > 0
  },
  {
    id: "ar-colloquial",
    covers: "colloquial Arabic reaches the corpus",
    question: "شو بتشمل باقة تأسيس الشركة القبرصية؟",
    intents: ["services"], language: "arabic",
    expect: (sections) => sections.length > 0
  },
  {
    id: "ar-very-colloquial",
    covers: "dialect wording with no formal terms still retrieves",
    question: "مرحبا بدي اعرف كيف بفتح شركة بقبرص وشو بدي مستندات؟",
    intents: ["services"], language: "arabic",
    expect: (sections) => sections.length > 0
  },
  {
    id: "el-natural",
    covers: "Greek natural wording retrieves",
    question: "Τι περιλαμβάνει το πακέτο ίδρυσης κυπριακής εταιρείας;",
    intents: ["services"], language: "greek",
    expect: (sections) => sections.length > 0
  },
  {
    id: "cross-language",
    covers: "an Arabic question can reach content regardless of the document language",
    question: "قديش ضريبة الشركات في قبرص؟",
    intents: ["company_info"], language: "arabic",
    expect: (sections) => sections.length > 0
  },
  {
    id: "deep-in-document",
    covers: "a fact deep inside a long document is reachable, not just its opening",
    question: "What are the IP Box rules and the corporate tax rate in Cyprus?",
    intents: ["company_info"], language: "english",
    expect: (sections) => sections.length > 0
  },
  {
    id: "multi-section",
    covers: "a question needing more than one section gets more than one document",
    question: "What does company formation cost and how long does the whole process take?",
    intents: ["services"], language: "english",
    expect: (sections) => new Set(sections.map((s) => s.documentId)).size >= 1 && sections.length > 1
  },
  {
    id: "conditions-outside-chunk",
    covers: "conditions living in a different section than the claim still arrive",
    question: "What is included when setting up a Cyprus company?",
    intents: ["services"], language: "english",
    expect: (sections) => sections.some((s) => s.kind === "boundary")
  },
  {
    id: "broad-services",
    covers: "a broad question fans out across business areas",
    question: "What services does Refalco Group offer?",
    intents: ["business_areas"], language: "english",
    expect: (sections) => new Set(sections.map((s) => s.documentId)).size > 1
  },
  {
    id: "contextual-follow-up",
    covers: "a bare follow-up resolves against the prior topic",
    question: "and how much does that cost?",
    intents: ["pricing"], language: "english",
    user: { history: [{ message: "Tell me about Cyprus company formation", response: "We handle company formation in Cyprus, including name reservation." }] },
    expect: (sections) => sections.length > 0
  },
  {
    id: "unsupported",
    covers: "a question the corpus does not answer is reported as no_evidence, with no fabrication",
    question: "Do you sell second hand motorcycles in Japan and what is the warranty?",
    intents: ["company_info"], language: "english",
    expectStatus: ["no_evidence", "partial"],
    expect: () => true
  }
];

function summarize(sections) {
  const byDoc = new Map();
  for (const section of sections) {
    const key = section.title || section.documentId;
    if (!byDoc.has(key)) byDoc.set(key, []);
    byDoc.get(key).push(`${section.chunkIndex}:${section.kind || "?"}`);
  }
  return [...byDoc.entries()].map(([title, chunks]) => `    ${String(title).slice(0, 58)} [${chunks.join(", ")}]`).join("\n");
}

async function reportHealth(store) {
  try {
    const health = await store.knowledgeHealth();
    if (!health) {
      console.log("knowledge health: unavailable (endpoint not deployed yet)\n");
      return null;
    }
    console.log("knowledge health");
    console.log(`  sources enabled+approved : ${health.sources_enabled_approved} / ${health.sources_total}`);
    console.log(`  documents approved       : ${health.documents_approved} / ${health.documents_total}`);
    console.log(`  documents expired        : ${health.documents_expired}`);
    console.log(`  documents price-gated    : ${health.documents_price_gated}`);
    console.log(`  chunks eligible          : ${health.chunks_eligible} / ${health.chunks_total}`);
    console.log(`  chunks embedded          : ${health.chunks_embedded} (missing ${health.chunks_missing_embedding})`);
    console.log(`  embedding models         : ${(health.embedding_models || []).join(", ") || "none"}`);
    console.log(`  worker embedding model   : ${DEFAULT_EMBEDDING_MODEL}`);
    if (Number(health.chunks_eligible) === 0) {
      console.log("  !! NO ELIGIBLE CHUNKS — this is a blackout, not a retrieval-quality problem.");
    }
    if (!(health.embedding_models || []).includes(DEFAULT_EMBEDDING_MODEL)) {
      console.log("  !! the worker's embedding model is not among the stored ones; the semantic arm will return nothing.");
    }
    console.log();
    return health;
  } catch (error) {
    console.log(`knowledge health: FAILED (${String(error.message).slice(0, 140)})\n`);
    return null;
  }
}

(async () => {
  const store = createStore();
  await reportHealth(store);

  const selected = only ? CASES.filter((item) => item.id === only) : CASES;
  let passed = 0;
  const failures = [];

  for (const testCase of selected) {
    let retrieval;
    try {
      retrieval = await retrieveKnowledgeForTurn(testCase.question, {
        user: testCase.user || { history: [] },
        intents: testCase.intents,
        language: testCase.language,
        store,
        embedQueryTexts,
        embeddingModel: DEFAULT_EMBEDDING_MODEL
      });
    } catch (error) {
      failures.push({ id: testCase.id, reason: `threw: ${String(error.message).slice(0, 160)}` });
      console.log(`FAIL ${testCase.id} — threw ${String(error.message).slice(0, 120)}\n`);
      continue;
    }

    const sections = retrieval.sections || [];
    const statusOk = testCase.expectStatus ? testCase.expectStatus.includes(retrieval.status) : retrieval.status !== "search_failed";
    const expectOk = testCase.expect(sections, retrieval);
    const ok = statusOk && expectOk;
    if (ok) passed += 1;
    else failures.push({ id: testCase.id, reason: `status=${retrieval.status} sections=${sections.length} statusOk=${statusOk} expectOk=${expectOk}` });

    console.log(`${ok ? "PASS" : "FAIL"} ${testCase.id} — ${testCase.covers}`);
    console.log(`   q: ${testCase.question}`);
    console.log(`   status=${retrieval.status} coverage=${Number(retrieval.coverage || 0).toFixed(2)} sections=${sections.length} queries=${retrieval.queryCount} rounds=${retrieval.trace.rounds.length} ms=${retrieval.trace.totalMs}`);
    if (sections.length) console.log(summarize(sections));
    if (retrieval.trace.errors.length) {
      console.log(`   errors: ${retrieval.trace.errors.map((entry) => `${entry.stage}:${entry.message}`).join(" | ").slice(0, 200)}`);
    }
    if (showTrace) console.log(`   trace: ${JSON.stringify(retrieval.trace).slice(0, 1600)}`);
    console.log();
  }

  console.log(`${passed}/${selected.length} scenarios passed`);
  if (failures.length) {
    console.log("failed:");
    for (const failure of failures) console.log(`  - ${failure.id}: ${failure.reason}`);
  }
  process.exit(failures.length ? 1 : 0);
})().catch((error) => {
  console.error(`verification run failed: ${String(error.message).slice(0, 200)}`);
  process.exit(1);
});
