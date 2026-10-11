"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ENTRIES, NEGATIVE_QUERIES } = require("../src/brainGoldenSet");
const { evaluate, scoreAnswer, summarize, parseArgs, expectedIdentity, expectedFactRanks, splitExpectedFacts, readDynamicExpectedFacts, buildApprovedEvidenceCatalog, mergeSearchPolicyMetadata, modelVisibleKnowledgeObservation, modelVisibleDocumentLinkedFactRanks, evaluateCandidateAnswer, candidateDigest, TARGETS } = require("./runGoldenKnowledgeEvaluation");

const reviewed = (entry, candidate, reviewerId = "reviewer-test") => ({ type: "human", reviewerId,
  reviewedAt: "2026-10-11T12:00:00.000Z", candidateSha256: candidateDigest(entry, candidate) });

test("uses the complete authoritative set and retains independent negative controls", () => {
  assert.equal(ENTRIES.length, 879);
  assert.equal(NEGATIVE_QUERIES.length, 17);
});

test("answer readiness cannot treat a same-sized subset or duplicate IDs as full golden coverage", () => {
  const partialPositive = ENTRIES.map((entry) => ({ id: entry.id, kind: "positive", lang: entry.lang, domain: entry.domain,
    topic: entry.topic, question: entry.question, expectedFacts: [...entry.expectedFacts], expectedRefusal: entry.expectedRefusal }));
  const negatives = NEGATIVE_QUERIES.map((entry) => ({ id: entry.id, kind: "negative", lang: entry.lang, question: entry.q,
    topic: entry.topic ?? null, domain: entry.domain ?? null, expectedFacts: [...entry.expectedFacts], expectedRefusal: entry.expectedRefusal }));
  const full = summarize(partialPositive, negatives);
  assert.equal(full.answerReadiness.goldenSetCoverage.complete, true);
  assert.equal(full.answerReadiness.goldenSetCoverage.positive.required, ENTRIES.length);

  partialPositive[0] = { ...partialPositive[0], id: partialPositive[1].id };
  const duplicate = summarize(partialPositive, negatives);
  assert.equal(duplicate.answerReadiness.goldenSetCoverage.complete, false);
  assert.equal(duplicate.answerReadiness.answerQualityGateEligible, false);

  const changedGoldenLanguage = partialPositive.map((row) => ({ ...row }));
  changedGoldenLanguage[0].lang = changedGoldenLanguage[0].lang === "ar" ? "en" : "ar";
  const forged = summarize(changedGoldenLanguage, negatives);
  assert.equal(forged.answerReadiness.goldenSetCoverage.complete, false,
    "a full ID set with a changed authoritative language must not qualify as complete coverage");
  assert.equal(forged.answerReadiness.answerQualityGateEligible, false);

  for (const [field, value] of [["question", "mutated question"], ["expectedFacts", ["FORGED-FACT"]], ["expectedRefusal", "negative"],
    ["topic", "different-topic"], ["domain", "different-domain"]]) {
    const altered = partialPositive.map((row) => ({ ...row, expectedFacts: [...row.expectedFacts] }));
    altered[0][field] = value;
    assert.equal(summarize(altered, negatives).answerReadiness.goldenSetCoverage.complete, false,
      `a canonical positive row with altered ${field} must not count as full coverage`);
  }
  for (const [field, value] of [["question", "mutated negative query"], ["expectedFacts", ["FORGED-FACT"]], ["expectedRefusal", "none"],
    ["topic", "different-topic"], ["domain", "different-domain"]]) {
    const altered = negatives.map((row) => ({ ...row, expectedFacts: [...row.expectedFacts] }));
    altered[0][field] = value;
    assert.equal(summarize(partialPositive, altered).answerReadiness.goldenSetCoverage.complete, false,
      `a canonical negative row with altered ${field} must not count as full coverage`);
  }

  const subset = summarize(partialPositive.slice(0, 3), negatives.slice(0, 2));
  assert.equal(subset.answerReadiness.goldenSetCoverage.complete, false);
  assert.equal(subset.answerReadiness.goldenSetCoverage.negative.required, NEGATIVE_QUERIES.length);
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

test("evaluation preserves row-level trusted policy metadata beyond the four-item model prompt cap", () => {
  const row = { policyMetadata: { topic: "corporate-tax", facts: ["MB-F19"], reviewStatus: "approved", validUntil: "2027-01-01" } };
  const metadata = mergeSearchPolicyMetadata(row, undefined);
  assert.equal(metadata.topic, "corporate-tax");
  assert.deepEqual(metadata.facts, ["MB-F19"]);
  assert.equal(metadata.reviewStatus, "approved");
  const fallback = mergeSearchPolicyMetadata({}, { metadata: { topic: "corporate-tax", facts: ["MB-F19"] } });
  assert.deepEqual(fallback.facts, ["MB-F19"]);
});

test("model-visible retrieval honors production eight-item and content truncation caps", async () => {
  const now = new Date("2026-10-11T12:00:00.000Z");
  const entry = { topic: "formation-package", lang: "en", expectedFacts: ["MB-F1"] };
  const hits = Array.from({ length: 9 }, (_, index) => ({
    chunk_id: `chunk-${index + 1}`, content: index === 0 ? `${"x".repeat(2500)} distinct fact beyond the model-visible prefix` : `evidence ${index + 1}`,
    review_status: "approved", valid_until: "2027-01-01T00:00:00.000Z",
    policyMetadata: { reviewStatus: "approved", validUntil: "2027-01-01T00:00:00.000Z", facts: index === 8 ? ["MB-F1"] : [] },
  }));
  const observation = modelVisibleKnowledgeObservation(hits);
  assert.equal(observation.evidence.length, 8);
  assert.equal(observation.evidence[0].content.length, 2000);
  assert.equal(observation.evidence[0].contentTruncated, true);
  assert.equal(observation.truncated, true);
  assert.equal(expectedFactRanks(hits, entry).allExpectedFactsFound, true, "raw retrieval sees the ninth-row fact");
  assert.equal(modelVisibleDocumentLinkedFactRanks(observation, entry).allExpectedFactsFound, false, "the model observation does not contain ninth-row metadata");
  const catalog = buildApprovedEvidenceCatalog(hits, { toolObservations: [], records: [] }, now, observation);
  assert.equal(catalog.has("rag:chunk-9"), false, "candidate answers cannot cite a raw hit omitted from the model observation");
  const candidate = await evaluateCandidateAnswer({ ...entry, question: "What is included?", expectedRefusal: "none" },
    { answer: "The approved package includes the stated item.", evidenceIds: ["rag:chunk-9"] }, catalog, now);
  assert.equal(candidate.candidateAcceptedByRuntime, false, "ranked-but-hidden evidence must not make a candidate appear grounded");
});

test("candidate evidence catalog uses the exact supplied bounded model observation", () => {
  const now = new Date("2026-10-11T12:00:00.000Z");
  const hit = { chunk_id: "chunk-visible", content: "raw text that must not replace the runtime observation", review_status: "approved",
    valid_until: "2027-01-01T00:00:00.000Z", policyMetadata: { reviewStatus: "approved", validUntil: "2027-01-01T00:00:00.000Z", facts: ["MB-F1"] } };
  const observation = { type: "approved_knowledge", status: "found", truncated: false,
    evidence: [{ sourceRef: "chunk-visible", title: "Visible", section: "Heading", content: "bounded exact text", contentTruncated: true }],
    policyEvidence: [{ sourceRef: "chunk-visible", review_status: "approved", valid_until: "2027-01-01T00:00:00.000Z", metadata: { facts: ["MB-F1"] } }] };
  const catalog = buildApprovedEvidenceCatalog([hit], { toolObservations: [], records: [] }, now, observation);
  assert.equal(catalog.get("rag:chunk-visible").content, "bounded exact text");
  assert.equal(catalog.get("rag:chunk-visible").policyMetadata.facts.includes("MB-F1"), true);
});

test("MB-F9 is evaluated from a distinct current dynamic offer result, not RAG rank", async () => {
  const entry = { id: "price", topic: "formation-package", domain: "corporate", lang: "en", expectedFacts: ["MB-F9"], expectedRefusal: "none", question: "What does it cost?" };
  assert.deepEqual(splitExpectedFacts(entry), { ragFacts: [], dynamicFacts: ["MB-F9"] });
  const now = new Date("2026-10-11T12:00:00Z");
  const calls = [];
  const currentRecord = { code: "formation-package", amount: 999, currency: "EUR", active: true, reviewStatus: "approved",
    effectiveDate: "2026-10-07T00:00:00Z", verifiedAt: "2026-10-07T00:00:00Z", validUntil: "2026-11-06T23:59:59Z" };
  const dynamic = await readDynamicExpectedFacts(entry, async (tool, args) => {
    calls.push({ tool, args });
    return { ok: true, status: "found", data: [currentRecord], modelObservation: { type: "dynamic_data", status: "found", source: "trusted_edge_dynamic_read",
      kind: "offers", records: [currentRecord] } };
  }, now);
  assert.deepEqual(calls, [{ tool: "lookupActiveOffer", args: { code: "formation-package" } }]);
  assert.equal(dynamic.status, "found_current");
  assert.equal(dynamic.current, true);
  assert.equal(dynamic.records[0].amount, 999);
  const staleRecord = { code: "formation-package", amount: 999, currency: "EUR", active: true, reviewStatus: "approved",
    effectiveDate: "2026-10-07T00:00:00Z", verifiedAt: "2026-10-07T00:00:00Z", validUntil: "2026-10-10T00:00:00Z" };
  const stale = await readDynamicExpectedFacts(entry, async () => ({ ok: true, status: "found", data: [staleRecord], modelObservation: { type: "dynamic_data", status: "found",
    source: "trusted_edge_dynamic_read", kind: "offers", records: [staleRecord] } }), now);
  assert.equal(stale.current, false);
  assert.equal(stale.status, "found_stale_or_incomplete");
  const hidden = await readDynamicExpectedFacts(entry, async () => ({ ok: true, status: "found", data: [currentRecord] }), now);
  assert.equal(hidden.current, false, "raw current data is not model-available without trusted dynamic evidence");
  assert.equal(hidden.checks[0].rawCurrent, true);
  assert.equal(hidden.checks[0].modelVisible, false);
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

test("expected refusals require explicit adjudication and block a false green answer gate", () => {
  const entry = { id: "nq", lang: "en", expectedFacts: [], expectedRefusal: "negative" };
  const draft = "I can help with Refalco's Cyprus business services. What are you looking for?";
  const unreviewed = scoreAnswer(entry, draft, [], { factualAccuracy: 3, grounding: 3, languageAndDialect: 3 });
  assert.equal(unreviewed.outputGuardrailPass, true);
  assert.equal(unreviewed.refusalPass, null);
  assert.equal(unreviewed.guardrailPass, false);
  const reviewed = scoreAnswer(entry, draft, [], { factualAccuracy: 0, grounding: 0, languageAndDialect: 3, refusalPass: false, source: "reviewer-1" });
  assert.equal(reviewed.refusalPass, false);
  assert.equal(reviewed.guardrailPass, false);
  const summary = summarize([{ id: "nq", kind: "positive", lang: "en", domain: "other", answer: reviewed }]);
  assert.equal(summary.answerReadiness.refusalCoverage.pass, false);
  assert.equal(summary.answerReadiness.answerQualityGateEligible, false);
});

test("candidate answer metadata cannot self-certify human quality scores", async () => {
  const now = new Date("2026-10-11T12:00:00.000Z");
  const entry = { id: "self-score", lang: "en", domain: "corporate", topic: "formation-package", expectedFacts: ["MB-F1"], expectedRefusal: "none",
    question: "What does the company formation package include?" };
  const hit = { chunk_id: "self-score-evidence", content: "The package includes incorporation support.", source_name: "Formation",
    review_status: "approved", valid_until: "2027-01-01T00:00:00.000Z", policyMetadata: { topic: entry.topic, facts: ["MB-F1"], reviewStatus: "approved", validUntil: "2027-01-01T00:00:00.000Z" } };
  const catalog = buildApprovedEvidenceCatalog([hit], { toolObservations: [], records: [] }, now);
  const candidate = { answer: "The package includes incorporation support. Which structure are you considering?", evidenceIds: ["rag:self-score-evidence"],
    review: { type: "human", reviewerId: "reviewer-self", reviewedAt: "2026-10-11T12:00:00.000Z" },
    judgment: { factualAccuracy: 3, grounding: 3, languageAndDialect: 3 } };
  const result = await evaluateCandidateAnswer(entry, candidate, catalog, now);
  assert.equal(result.candidateAcceptedByRuntime, true);
  assert.equal(result.humanAdjudication.reviewed, false);
  assert.equal(result.scores, null, "review claims embedded in a candidate answer are ignored");
});

test("answer readiness stays explicitly unevaluated when no answer samples exist", () => {
  const summary = summarize([{ id: "x", lang: "en", domain: "corporate", answer: scoreAnswer({ id: "x", lang: "en" }, null) }]);
  assert.equal(summary.answerReadiness.gates.factualAccuracy.pass, null);
  assert.equal(summary.answerReadiness.gates.grounding.pass, null);
  assert.equal(summary.answerReadiness.gates.goldenFormula.pass, null);
  assert.equal(summary.answerReadiness.gates.guardrailFailures.pass, null);
  assert.equal(summary.answerReadiness.answerQualityGateEligible, false);
});

test("candidate answers run through Agent output gates using only selected current approved evidence and explicit human review", async () => {
  const now = new Date("2026-10-11T12:00:00.000Z");
  const entry = { id: "cand-1", lang: "en", domain: "corporate", topic: "formation-package", expectedFacts: ["MB-F1"], expectedRefusal: "none",
    question: "What does the company formation package include?" };
  const approvedHit = { chunk_id: "kb-chunk-1", content: "The Cyprus company formation package includes incorporation support.",
    source_name: "Formation", heading: "Incorporation", document_title: "Formation", review_status: "approved",
    valid_until: "2027-01-01T00:00:00.000Z", policyMetadata: { reviewStatus: "approved", validUntil: "2027-01-01T00:00:00.000Z", topic: entry.topic, facts: ["MB-F1"] } };
  const catalog = buildApprovedEvidenceCatalog([approvedHit], { toolObservations: [], records: [] }, now);
  const answer = "The Cyprus company formation package includes incorporation support. This gives you a clear starting point. Which structure are you considering?";
  const human = { type: "human", reviewerId: "reviewer-01", reviewedAt: "2026-10-11T12:00:00.000Z" };
  const unreviewed = await evaluateCandidateAnswer(entry, { answer, evidenceIds: ["rag:kb-chunk-1"] }, catalog, now);
  assert.equal(unreviewed.candidateAcceptedByRuntime, true);
  assert.equal(unreviewed.evaluated, true, "runtime checking is distinct from human quality adjudication");
  assert.equal(unreviewed.scores, null);
  assert.equal(unreviewed.humanAdjudication.reviewed, false);
  const reviewed = await evaluateCandidateAnswer(entry, { answer, evidenceIds: ["rag:kb-chunk-1"] }, catalog, now,
    { review: { ...human, candidateSha256: candidateDigest(entry, { answer, evidenceIds: ["rag:kb-chunk-1"] }) }, judgment: { factualAccuracy: 3, grounding: 3, languageAndDialect: 3, source: "human" } });
  assert.equal(reviewed.evaluated, true);
  assert.deepEqual(reviewed.evidenceSelection.usedIds, ["rag:kb-chunk-1"]);
  assert.equal(reviewed.humanAdjudication.reviewerId, "reviewer-01");
  assert.equal(reviewed.guardrailPass, true);

  const editedCandidate = { answer: "The package includes incorporation support. I can explain the next steps. Which structure are you considering?",
    evidenceIds: ["rag:kb-chunk-1"] };
  const staleReview = await evaluateCandidateAnswer(entry, editedCandidate, catalog, now,
    { review: { ...human, candidateSha256: candidateDigest(entry, { answer, evidenceIds: ["rag:kb-chunk-1"] }) },
      judgment: { factualAccuracy: 3, grounding: 3, languageAndDialect: 3 } });
  assert.equal(staleReview.candidateAcceptedByRuntime, true);
  assert.equal(staleReview.humanAdjudication.reviewed, false, "a review cannot be carried over to an edited answer");
  assert.equal(staleReview.scores, null);

  const fabricatedEvidence = await evaluateCandidateAnswer(entry, { answer, evidenceIds: ["rag:unknown"] }, catalog, now,
    { review: { ...human, candidateSha256: candidateDigest(entry, { answer, evidenceIds: ["rag:unknown"] }) }, judgment: { factualAccuracy: 3, grounding: 3, languageAndDialect: 3 } });
  assert.equal(fabricatedEvidence.candidateAcceptedByRuntime, false);
  assert.equal(fabricatedEvidence.evaluated, false);
  assert.deepEqual(fabricatedEvidence.evidenceSelection.usedIds, []);
});

test("negative control candidates need a runtime-safe refusal and explicit refusal adjudication", async () => {
  const now = new Date("2026-10-11T12:00:00.000Z");
  const entry = { id: "NQ-test", lang: "en", expectedFacts: [], expectedRefusal: "negative", question: "What is the best treatment for high blood pressure?" };
  const candidate = { answer: "I cannot advise on medical treatment. Please ask a qualified health professional.", evidenceIds: [] };
  const adjudication = { review: reviewed(entry, candidate, "reviewer-02"),
    judgment: { factualAccuracy: 3, grounding: 3, languageAndDialect: 3, refusalPass: true } };
  const result = await evaluateCandidateAnswer(entry, candidate, new Map(), now, adjudication);
  assert.equal(result.candidateAcceptedByRuntime, true);
  assert.equal(result.humanAdjudication.reviewed, true);
  assert.equal(result.refusalPass, true);
  assert.equal(result.guardrailPass, true);
  const missingReview = await evaluateCandidateAnswer(entry, candidate, new Map(), now,
    { ...adjudication, judgment: { factualAccuracy: 3, grounding: 3, languageAndDialect: 3 } });
  assert.equal(missingReview.humanAdjudication.reviewed, false);
  assert.equal(missingReview.scores, null);
});

test("dynamic price candidates can cite only current tool evidence carrying the Agent trust markers", async () => {
  const now = new Date("2026-10-11T12:00:00.000Z");
  const entry = { id: "offer-candidate", lang: "en", expectedFacts: ["MB-F9"], expectedRefusal: "none", question: "What does the company formation offer cost?" };
  const record = { kind: "offers", code: "formation-package", amount: 999, currency: "EUR", active: true, inclusions: ["incorporation support"],
    reviewStatus: "approved", provenance: "approved_live_edge_data", effectiveDate: "2026-10-01T00:00:00.000Z", verifiedAt: "2026-10-10T00:00:00.000Z",
    validUntil: "2026-11-01T00:00:00.000Z", lastUpdated: "2026-10-10T00:00:00.000Z", eligibility: null };
  const toolObservation = { step: 1, tool: "lookupActiveOffer", args: { code: "formation-package" }, result: { ok: true, status: "found", data: [record],
    modelObservation: { type: "dynamic_data", status: "found", source: "trusted_edge_dynamic_read", kind: "offers", records: [record] } } };
  const dynamic = await readDynamicExpectedFacts(entry, async () => toolObservation.result, now);
  const catalog = buildApprovedEvidenceCatalog([], dynamic, now);
  const answer = "The listed fee is EUR 999. This gives you a clear starting cost. Which structure are you considering?";
  const candidate = { answer, evidenceIds: ["dynamic:lookupActiveOffer:formation-package"] };
  const result = await evaluateCandidateAnswer(entry, candidate, catalog, now, {
    review: reviewed(entry, candidate, "reviewer-04"),
    judgment: { factualAccuracy: 3, grounding: 3, languageAndDialect: 3 }
  });
  assert.equal(dynamic.current, true);
  assert.equal(dynamic.checks[0].modelVisible, true);
  assert.equal(result.candidateAcceptedByRuntime, true);
  assert.deepEqual(result.evidenceSelection.usedIds, candidate.evidenceIds);

  const untrustedDynamic = await readDynamicExpectedFacts(entry, async () => ({ ...toolObservation.result,
    modelObservation: { ...toolObservation.result.modelObservation, source: "untrusted" } }), now);
  assert.equal(buildApprovedEvidenceCatalog([], untrustedDynamic, now).size, 0);

  const mismatchedDuplicate = await readDynamicExpectedFacts(entry, async () => ({ ...toolObservation.result,
    modelObservation: { ...toolObservation.result.modelObservation,
      records: [record, { ...record, amount: 123456 }] } }), now);
  const duplicateCatalog = buildApprovedEvidenceCatalog([], mismatchedDuplicate, now);
  assert.equal(duplicateCatalog.size, 1);
  assert.equal(duplicateCatalog.get("dynamic:lookupActiveOffer:formation-package").record.amount, 999,
    "a same-code model record with a different price cannot overwrite the current source record");
});

test("evaluation report ties candidate scores to ranked approved evidence and records negative-control review", async () => {
  const now = new Date("2026-10-11T12:00:00.000Z");
  const entry = { id: "candidate-e2e", lang: "en", domain: "corporate", topic: "formation-package", expectedFacts: ["MB-F1"], expectedRefusal: "none",
    question: "What does the company formation package include?" };
  const negative = { id: "NQ-candidate", lang: "en", q: "What is the best treatment for high blood pressure?", expectedRefusal: "negative", expectedFacts: [] };
  const hit = { chunk_id: "approved-1", content: "The Cyprus company formation package includes incorporation support.", source_name: "Formation",
    document_title: "Formation", heading: "Incorporation", review_status: "approved", valid_until: "2027-01-01T00:00:00.000Z",
    source_url: `refal://kb/corporate/${entry.topic}/en`, policyMetadata: { reviewStatus: "approved", validUntil: "2027-01-01T00:00:00.000Z", topic: entry.topic, facts: ["MB-F1"] } };
  const positiveCandidate = { answer: "The Cyprus company formation package includes incorporation support. This gives you a clear starting point. Which structure are you considering?", evidenceIds: ["rag:approved-1"] };
  const negativeCandidate = { answer: "I cannot advise on medical treatment. Please ask a qualified health professional.", evidenceIds: [] };
  const review = reviewed(entry, positiveCandidate, "reviewer-03");
  const negativeReview = reviewed(negative, negativeCandidate, "reviewer-03");
  const report = await evaluate({ entries: [entry], negatives: [negative], now, retrieve: async (_question, item) => item.topic ? [hit] : [],
    answers: {
      [entry.id]: { ...positiveCandidate,
        evidenceIds: ["rag:approved-1"], review, judgment: { factualAccuracy: 3, grounding: 3, languageAndDialect: 3 } },
      [negative.id]: { ...negativeCandidate, review: negativeReview,
        judgment: { factualAccuracy: 3, grounding: 3, languageAndDialect: 3, refusalPass: true } }
    }, adjudications: {
      [entry.id]: { review, judgment: { factualAccuracy: 3, grounding: 3, languageAndDialect: 3 } },
      [negative.id]: { review: negativeReview, judgment: { factualAccuracy: 3, grounding: 3, languageAndDialect: 3, refusalPass: true } }
    } });
  assert.deepEqual(report.results[0].answer.evidenceSelection.usedIds, ["rag:approved-1"]);
  assert.equal(report.results[0].answer.humanAdjudication.reviewed, true);
  assert.equal(report.results[1].answer.refusalPass, true);
  assert.equal(report.results[0].retrieval.candidates[0].evidenceId, "rag:approved-1");
  assert.equal(report.summary.answerReadiness.answerQualityGateEligible, false, "a partial language sample must not claim full set readiness");
  assert.equal(Object.hasOwn(report.results[0].dynamic, "toolObservations"), false);
});

test("answer quality cannot be eligible until at least one refusal scenario is explicitly reviewed", () => {
  const entry = { id: "positive", lang: "en", domain: "corporate", expectedFacts: ["MB-F1"], expectedRefusal: "none" };
  const answer = scoreAnswer(entry, "A grounded, helpful response.", [{ source_url: "refal://kb/corporate/example/en" }], {
    factualAccuracy: 3, grounding: 3, languageAndDialect: 3, source: "human-review"
  });
  const summary = summarize([{ id: "positive", kind: "positive", lang: "en", domain: "corporate", answer }], []);
  assert.equal(summary.answerReadiness.refusalCoverage.pass, null);
  assert.equal(summary.answerReadiness.answerQualityGateEligible, false);
});

test("full evaluation calls injected retriever for all positive and negative rows and reports per-language ranks", async () => {
  const subset = ENTRIES.slice(0, 6);
  const neg = NEGATIVE_QUERIES.slice(0, 2);
  let calls = 0;
  const report = await evaluate({ entries: subset, negatives: neg, topK: 2, retrieve: async (_q, item) => {
    calls += 1;
    return item.topic ? [{ chunk_id: `fixture-${item.id}`, source_url: `refal://kb/${item.domain}/${item.topic}/${item.lang}`, rank: 0.9,
      policyMetadata: { facts: [...item.expectedFacts] } }] : [];
  } });
  assert.equal(calls, subset.length + neg.length);
  assert.equal(report.summary.retrievalEvaluated, subset.length);
  assert.equal(report.summary.negativeControls.rawSearchReturnedEvidence, 0);
  assert.equal(report.summary.negativeControls.agentGuardrailEvaluated, 0);
  assert.equal(report.summary.negativeControls.agentGuardrailFailures, null);
  assert.ok(report.results.slice(0, subset.length).every((row) => row.retrieval.languageRank === 1));
  assert.ok(report.summary.byLanguage.ar.ownLanguageFirstRate > 0.99);
  assert.equal(report.summary.byLanguage.ar.ownLanguageFirstEvaluated, subset.filter((row) => row.lang === "ar").length);
  assert.equal(report.summary.retrievalVisibility.rankedTopKPasses, subset.length);
  assert.equal(report.summary.retrievalVisibility.modelVisibleDocumentLinkedEvaluated, subset.filter((row) => row.expectedFacts.some((fact) => fact !== "MB-F9")).length);
  assert.equal(report.results[0].retrieval.textVisibleFactClaimEvaluation.startsWith("not_evaluated"), true);
  assert.deepEqual(report.summary.byLanguage.ar.ownLanguageFirstWilson95.confidence, 0.95);
  assert.equal(report.testType, "synthetic-fixture");
  assert.equal(report.summary.answerEvaluated, 0);
});

test("golden evaluator refuses unsupported production labels for a diagnostic-only retrieval run", async () => {
  await assert.rejects(evaluate({ entries: [], negatives: [], retrieve: async () => [], testType: "production" }),
    /this evaluator never measures production answers/u);
});

test("M10 parity summary counts missing results as failures and reports per-language confidence intervals", () => {
  const rows = [
    { lang: "en", retrieval: { rawSearchEvaluated: true, languageRank: 1 } },
    { lang: "en", retrieval: { rawSearchEvaluated: true, languageRank: 2 } },
    { lang: "ar", retrieval: { rawSearchEvaluated: true, languageRank: 1 } },
    { lang: "el", retrieval: { rawSearchEvaluated: true, languageRank: null } },
  ];
  const summary = summarize(rows, []);
  assert.equal(summary.byLanguage.en.ownLanguageFirstRate, 0.5);
  assert.equal(summary.byLanguage.ar.ownLanguageFirstRate, 1);
  assert.equal(summary.byLanguage.el.ownLanguageFirstRate, 0);
  assert.equal(summary.byLanguage.el.ownLanguageFirstEvaluated, 1, "a zero-result retrieval must not disappear from its language denominator");
  assert.equal(summary.languageParitySpreads.ownLanguageFirstRate, 1);
  assert.ok(summary.byLanguage.en.ownLanguageFirstWilson95.lower < 0.5);
  assert.ok(summary.byLanguage.en.ownLanguageFirstWilson95.upper > 0.5);
  assert.deepEqual(summary.byLanguage.ar.factualAccuracyWilson95, null,
    "answer-quality uncertainty stays unevaluated until human-adjudicated answer samples exist");
  assert.deepEqual(summary.byLanguage.en.errorBars95.factualAccuracyRate, null);
  assert.ok(summary.byLanguage.en.ownLanguageFirstWilson95.upper > summary.byLanguage.en.ownLanguageFirstRate,
    "small per-language retrieval samples expose uncertainty instead of reporting only a point estimate");
});

test("M10 parity reports Wilson 95% intervals for each measured rate by language and domain", () => {
  const rows = [
    { id: "en-1", lang: "en", domain: "corporate", retrieval: { evaluated: true, ragCoveragePass: true,
      rawSearchEvaluated: true, languageRank: 1 }, answer: { evaluated: true, guardrailPass: true, formulaPass: true,
      scores: { factualAccuracy: 3, grounding: 3, languageAndDialect: 3 } } },
    { id: "en-2", lang: "en", domain: "corporate", retrieval: { evaluated: true, ragCoveragePass: false,
      rawSearchEvaluated: true, languageRank: 2 }, answer: { evaluated: true, guardrailPass: false, formulaPass: false,
      scores: { factualAccuracy: 2, grounding: 3, languageAndDialect: 2 } } },
    { id: "ar-1", lang: "ar", domain: "corporate", retrieval: { evaluated: true, ragCoveragePass: true,
      rawSearchEvaluated: true, languageRank: 1 }, answer: { evaluated: true, guardrailPass: true, formulaPass: true,
      scores: { factualAccuracy: 3, grounding: 3, languageAndDialect: 3 } } },
  ];
  const summary = summarize(rows, []);
  for (const group of [summary.byLanguage.en, summary.byLanguage.ar, summary.byDomain.corporate]) {
    for (const interval of Object.values(group.errorBars95)) {
      assert.ok(interval && interval.confidence === 0.95);
      assert.ok(interval.lower <= interval.upper);
    }
  }
  assert.equal(summary.byLanguage.en.factualAccuracyRate, 0.5);
  assert.equal(summary.byLanguage.en.factualAccuracyWilson95, summary.byLanguage.en.errorBars95.factualAccuracyRate);
  assert.equal(summary.byDomain.corporate.guardrailPassRate, 2 / 3);
});

test("language parity cannot pass when every language is equally weak", () => {
  const makeRows = (language, score) => Array.from({ length: 20 }, (_, index) => ({
    id: `${language}-${index}`, lang: language, domain: "corporate",
    answer: { evaluated: true, guardrailPass: true, formulaPass: true,
      scores: { factualAccuracy: 3, grounding: 3, languageAndDialect: score } },
  }));
  const weak = summarize([...makeRows("en", 2), ...makeRows("ar", 2), ...makeRows("el", 2)], []);
  assert.equal(weak.answerReadiness.gates.languageParity.spread, 0);
  assert.equal(weak.answerReadiness.gates.languageParity.allLanguagesMeetMinimum, false);
  assert.equal(weak.answerReadiness.gates.languageParity.pass, false,
    "a zero parity spread is not enough when every language misses the minimum quality rate");

  const strong = summarize([...makeRows("en", 3), ...makeRows("ar", 3), ...makeRows("el", 3)], []);
  assert.equal(strong.answerReadiness.gates.languageParity.allLanguagesMeetMinimum, true);
  assert.equal(strong.answerReadiness.gates.languageParity.pass, true);
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

test("negative live-search diagnostics accept the bounded retriever result shape", async () => {
  const neg = NEGATIVE_QUERIES.slice(0, 1);
  const report = await evaluate({ entries: [], negatives: neg, retrieve: async () => ({
    hits: [{ source_url: "refal://kb/tax/corporate-tax/en" }],
    modelObservation: { type: "approved_knowledge", status: "not_found", evidence: [] },
  }) });
  assert.equal(report.results[0].retrieval.rawResultCount, 1);
  assert.equal(report.results[0].retrieval.rawReturnedEvidence, true);
});

test("thresholds are frozen to P14.1 plan and CLI rejects malformed bounds", () => {
  assert.deepEqual(TARGETS, { factualAccuracy: 0.9, grounding: 1, guardrailFailures: 0, goldenFormula: 0.85, languageQualityRate: 0.85, languageParitySpread: 0.1, ownLanguageFirstRate: 1 });
  assert.equal(parseArgs(["--top", "7", "--lang", "el"]).top, 7);
  assert.equal(parseArgs(["--answers", "candidate.json", "--adjudications", "review.json"]).adjudications.endsWith("review.json"), true);
  assert.throws(() => parseArgs(["--adjudications"]), /--adjudications requires a value/u);
  assert.throws(() => parseArgs(["--answers", "same.json", "--adjudications", "same.json"]), /must be separate files/u);
  if (process.platform === "win32") {
    assert.throws(() => parseArgs(["--answers", "answers.json", "--adjudications", "ANSWERS.JSON"]), /must be separate files/u,
      "Windows path identity is case-insensitive");
  }
  assert.throws(() => parseArgs(["--lang", "gr"]), /--lang must be one of: ar, en, el/u);
  assert.throws(() => parseArgs(["--lang"]), /--lang requires a value/u);
  assert.throws(() => parseArgs(["--top", "0"]), /--top/u);
  assert.throws(() => parseArgs(["--wat"]), /Unknown argument/u);
});

test("answer and adjudication paths that resolve through a symlink are rejected", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "refal-adjudication-path-"));
  const target = path.join(directory, "answers.json");
  const aliasDirectory = path.join(directory, "alias");
  try {
    fs.writeFileSync(target, "{}\n", "utf8");
    try {
      fs.symlinkSync(directory, aliasDirectory, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      t.skip(`directory symlinks unavailable in this environment: ${error.code || error.message}`);
      return;
    }
    assert.throws(() => parseArgs(["--answers", target, "--adjudications", path.join(aliasDirectory, "answers.json")]), /must be separate files/u);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
