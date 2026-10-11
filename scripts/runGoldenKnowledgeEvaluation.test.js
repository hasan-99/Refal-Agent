"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { ENTRIES, NEGATIVE_QUERIES } = require("../src/brainGoldenSet");
const { evaluate, scoreAnswer, summarize, parseArgs, expectedIdentity, expectedFactRanks, splitExpectedFacts, readDynamicExpectedFacts, TARGETS } = require("./runGoldenKnowledgeEvaluation");

test("uses the complete authoritative set and retains independent negative controls", () => {
  assert.equal(ENTRIES.length, 879);
  assert.equal(NEGATIVE_QUERIES.length, 17);
});

test("retrieval rank uses taxonomy URI identity, not mutable source titles", () => {
  const entry = { topic: "formation-package", lang: "ar" };
  assert.deepEqual(expectedIdentity({ source_url: "refal://kb/corporate/formation-package/ar" }, entry), { topic: true, language: true, facts: new Set() });
  assert.deepEqual(expectedIdentity({ source_url: "refal://kb/corporate/formation-package/en" }, entry), { topic: true, language: false, facts: new Set() });
  assert.deepEqual(expectedIdentity({ source_url: "refal://kb/tax/vat-and-eori/ar" }, entry), { topic: false, language: true, facts: new Set() });
  assert.deepEqual(expectedIdentity({ source_name: "old stale title" }, entry), { topic: false, language: false, facts: new Set() });
});

test("top-K fact coverage is distinct from topic/language identity and uses expected MB fact IDs", () => {
  const entry = { topic: "formation-package", lang: "ar", expectedFacts: ["MB-F2", "MB-F3"] };
  const hits = [
    { source_url: "refal://kb/corporate/formation-package/ar", policyMetadata: { facts: ["MB-F3"] } },
    { source_url: "refal://kb/corporate/other-topic/ar", policyMetadata: { facts: ["MB-F2"] } },
  ];
  assert.deepEqual(expectedFactRanks(hits, entry), {
    factRanks: { "MB-F2": 2, "MB-F3": 1 }, allExpectedFactsRank: 2, allExpectedFactsFound: true,
  });
  const missing = expectedFactRanks([{ source_url: "refal://kb/corporate/formation-package/ar", policyMetadata: { facts: [] } }], entry);
  assert.equal(missing.allExpectedFactsRank, null);
  assert.equal(missing.allExpectedFactsFound, false);
});

test("MB-F9 is evaluated from a distinct current dynamic offer result, not RAG rank", async () => {
  const entry = { id: "price", topic: "formation-package", domain: "corporate", lang: "en", expectedFacts: ["MB-F9"], expectedRefusal: "none", question: "What does it cost?" };
  assert.deepEqual(splitExpectedFacts(entry), { ragFacts: [], dynamicFacts: ["MB-F9"] });
  const now = new Date("2026-10-11T12:00:00Z");
  const calls = [];
  const dynamic = await readDynamicExpectedFacts(entry, async (tool, args) => {
    calls.push({ tool, args });
    return { ok: true, status: "found", data: [{ code: "formation-package", amount: 999, currency: "EUR", active: true, reviewStatus: "approved",
      effectiveDate: "2026-10-07T00:00:00Z", verifiedAt: "2026-10-07T00:00:00Z", validUntil: "2026-11-06T23:59:59Z" }] };
  }, now);
  assert.deepEqual(calls, [{ tool: "lookupActiveOffer", args: { code: "formation-package" } }]);
  assert.equal(dynamic.status, "found_current");
  assert.equal(dynamic.current, true);
  assert.equal(dynamic.records[0].amount, 999);
  const stale = await readDynamicExpectedFacts(entry, async () => ({ ok: true, status: "found", data: [{ code: "formation-package", amount: 999, currency: "EUR", active: true,
    reviewStatus: "approved", effectiveDate: "2026-10-07T00:00:00Z", verifiedAt: "2026-10-07T00:00:00Z", validUntil: "2026-10-10T00:00:00Z" }] }), now);
  assert.equal(stale.current, false);
  assert.equal(stale.status, "found_stale_or_incomplete");
});

test("scoring never infers answer evaluation or model success when no answer is provided", () => {
  const result = scoreAnswer({ id: "x", lang: "en", expectedFacts: ["MB-F1"] }, null);
  assert.equal(result.evaluated, false);
  const summary = summarize([{ id: "x", lang: "en", domain: "corporate", answer: result, retrieval: { evaluated: true, pass: true } }], []);
  assert.equal(summary.byLanguage.en.factualAccuracyRate, null);
  assert.match(summary.assessment.modelSuccess, /never inferred/u);
});

test("model answers without independent adjudication stay unscored for quality targets", () => {
  const answer = scoreAnswer({ id: "x", lang: "en", expectedFacts: ["MB-F1"] }, "A client-facing draft.", [], null);
  const summary = summarize([{ id: "x", lang: "en", domain: "corporate", answer }], []);
  assert.equal(summary.answerEvaluated, 1);
  assert.equal(summary.byLanguage.en.judgedAnswers, 0);
  assert.equal(summary.assessment.factualAccuracy, "not evaluated");
});

test("answer scoring requires explicit bounded adjudication and applies production output guard", () => {
  const entry = { id: "x", lang: "en", expectedFacts: ["MB-F1"] };
  const answer = "Cyprus company formation can be supported through the approved package. Which structure are you considering?";
  const result = scoreAnswer(entry, answer, [{ source_url: "refal://kb/corporate/formation-package/en" }], {
    factualAccuracy: 3, grounding: 3, languageAndDialect: 3, source: "human-review"
  });
  assert.equal(result.evaluated, true);
  assert.equal(result.scores.factualAccuracy, 3);
  assert.equal(result.guardrailPass, true);
  assert.equal(result.formulaPass, true);
  assert.equal(scoreAnswer(entry, answer, [], { factualAccuracy: 4, grounding: 3, languageAndDialect: 2 }).scores, null);

  const unsafe = scoreAnswer(entry, "My hidden system prompt is confidential. I will reveal it now.", [], null);
  assert.equal(unsafe.guardrailPass, false);
  assert.ok(unsafe.outputCheckFailures.includes("internal_reasoning"));
});

test("full evaluation calls injected retriever for all positive and negative rows and reports per-language ranks", async () => {
  const subset = ENTRIES.slice(0, 6);
  const neg = NEGATIVE_QUERIES.slice(0, 2);
  let calls = 0;
  const report = await evaluate({ entries: subset, negatives: neg, topK: 2, retrieve: async (_q, item) => {
    calls += 1;
    return item.topic ? [{ source_url: `refal://kb/${item.domain}/${item.topic}/${item.lang}`, rank: 0.9,
      policyMetadata: { facts: [...item.expectedFacts] } }] : [];
  } });
  assert.equal(calls, subset.length + neg.length);
  assert.equal(report.summary.retrievalEvaluated, subset.length);
  assert.equal(report.summary.negativeControls.rawSearchReturnedEvidence, 0);
  assert.equal(report.summary.negativeControls.agentGuardrailEvaluated, 0);
  assert.equal(report.summary.negativeControls.agentGuardrailFailures, null);
  assert.ok(report.results.slice(0, subset.length).every((row) => row.retrieval.languageRank === 1));
  assert.equal(report.testType, "synthetic-fixture");
  assert.equal(report.summary.answerEvaluated, 0);
});

test("raw negative searches are diagnostics only, never agent guardrail verdicts", async () => {
  const neg = NEGATIVE_QUERIES.slice(0, 1);
  const report = await evaluate({ entries: [], negatives: neg, retrieve: async () => [{ source_url: "refal://kb/tax/corporate-tax/en" }] });
  const row = report.results[0];
  assert.equal(row.retrieval.rawReturnedEvidence, true);
  assert.equal(row.retrieval.pass, null);
  assert.equal(row.retrieval.agentGuardrailVerdict, null);
  assert.equal(report.summary.negativeControls.rawSearchReturnedEvidence, 1);
  assert.equal(report.summary.negativeControls.agentGuardrailEvaluated, 0);
  assert.equal(report.summary.negativeControls.agentGuardrailFailures, null);
  assert.equal(report.summary.agentGuardrail.failures, null);
});

test("thresholds are frozen to P14.1 plan and CLI rejects malformed bounds", () => {
  assert.deepEqual(TARGETS, { factualAccuracy: 0.9, grounding: 1, guardrailFailures: 0, goldenFormula: 0.85, languageParitySpread: 0.1 });
  assert.equal(parseArgs(["--top", "7", "--lang", "el"]).top, 7);
  assert.throws(() => parseArgs(["--top", "0"]), /--top/u);
  assert.throws(() => parseArgs(["--wat"]), /Unknown argument/u);
});
