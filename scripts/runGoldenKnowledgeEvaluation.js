"use strict";

// P14.1 harness. Retrieval is measured against the current taxonomy identity
// (topic + language), never document titles that change during editing. Model
// answers are optional and are never represented as evaluated when absent.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { ENTRIES, NEGATIVE_QUERIES, validateAll } = require("../src/brainGoldenSet");
const { LANGUAGES } = require("../src/brainTaxonomy");
const { classifySafety } = require("../src/safetyPolicy");
const { validateResponse } = require("../src/responsePolicy");
const { analyseAnswerShape, violatesGoldenFormula, ORDINARY } = require("../src/goldenFormula");
const { runAgentTurn } = require("../src/agentLoop");
const { buildAgentContext } = require("../src/agentContext");
const { collectDynamicDataEvidence } = require("../src/groundingPolicy");
const { buildApprovedKnowledgeObservation } = require("../src/agentTools");

const TARGETS = Object.freeze({ factualAccuracy: 0.90, grounding: 1, guardrailFailures: 0, goldenFormula: 0.85, languageQualityRate: 0.85, languageParitySpread: 0.10, ownLanguageFirstRate: 1 });
const AXES = Object.freeze(["factualAccuracy", "grounding", "languageAndDialect"]);
// These expected facts are deliberately dynamic and cannot be ranked in RAG.
// Keep their independent read tool and readiness contract explicit here.
const DYNAMIC_FACT_LOOKUPS = Object.freeze({
  "MB-F9": Object.freeze({ tool: "lookupActiveOffer", args: Object.freeze({ code: "formation-package" }), match: (record) => record?.code === "formation-package" }),
});
const normalize = (s) => String(s || "").normalize("NFC").toLocaleLowerCase().replace(/\s+/gu, " ").trim();
const chunked = (items, size) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

function expectedIdentity(row, entry) {
  const url = String(row.source_url || row.canonical_url || "").toLowerCase();
  const topic = url.includes(`/${entry.topic}/`) || row.policyMetadata?.topic === entry.topic || row.topic === entry.topic;
  const language = url.endsWith(`/${entry.lang}`) || row.policyMetadata?.language === entry.lang || row.language === entry.lang;
  const rawFacts = row.policyMetadata?.facts || row.metadata?.facts || row.factIds || [];
  return { topic, language, facts: new Set(Array.isArray(rawFacts) ? rawFacts : []) };
}

function expectedFactRanks(hits, entry) {
  const factRanks = Object.fromEntries(entry.expectedFacts.map((fact) => [fact, null]));
  for (const [index, hit] of hits.entries()) {
    const identities = expectedIdentity(hit, entry);
    for (const fact of entry.expectedFacts) if (identities.facts.has(fact) && factRanks[fact] === null) factRanks[fact] = index + 1;
  }
  const allFound = entry.expectedFacts.length > 0 && entry.expectedFacts.every((fact) => factRanks[fact] !== null);
  return { factRanks, allExpectedFactsRank: allFound ? Math.max(...Object.values(factRanks)) : null, allExpectedFactsFound: allFound };
}

function splitExpectedFacts(entry) {
  const dynamicFacts = entry.expectedFacts.filter((fact) => DYNAMIC_FACT_LOOKUPS[fact]);
  return { ragFacts: entry.expectedFacts.filter((fact) => !DYNAMIC_FACT_LOOKUPS[fact]), dynamicFacts };
}

async function readDynamicExpectedFacts(entry, lookupDynamic, now = new Date()) {
  const { dynamicFacts } = splitExpectedFacts(entry);
  if (!dynamicFacts.length) return { evaluated: false, facts: [], status: "not_applicable", records: [], current: null, error: null };
  if (typeof lookupDynamic !== "function") return { evaluated: true, facts: dynamicFacts, status: "not_configured", records: [], current: false, error: "dynamic_lookup_not_configured" };
  const facts = [];
  const records = [];
  const errors = [];
  const toolObservations = [];
  for (const fact of dynamicFacts) {
    const contract = DYNAMIC_FACT_LOOKUPS[fact];
    try {
      const result = await lookupDynamic(contract.tool, contract.args, entry);
      toolObservations.push({ step: 1, tool: contract.tool, args: contract.args, result });
      const candidates = Array.isArray(result?.data) ? result.data : [];
      const record = candidates.find((candidate) => contract.match(candidate)) || null;
      const validUntil = Date.parse(record?.validUntil || "");
      const effectiveDate = Date.parse(record?.effectiveDate || "");
      const verifiedAt = Date.parse(record?.verifiedAt || "");
      const rawCurrent = Boolean(result?.ok && result.status === "found" && record?.active === true && record?.reviewStatus === "approved"
        && Number.isFinite(validUntil) && validUntil > now.getTime()
        && Number.isFinite(effectiveDate) && effectiveDate <= now.getTime()
        && Number.isFinite(verifiedAt) && verifiedAt <= now.getTime());
      const model = result?.modelObservation;
      const visible = Boolean(model?.type === "dynamic_data" && model.status === "found" && model.source === "trusted_edge_dynamic_read"
        && model.kind === "offers" && model.records?.some((candidate) => candidate?.code === record?.code
          && candidate.amount === record?.amount && candidate.currency === record?.currency));
      const current = rawCurrent && visible;
      facts.push({ fact, tool: contract.tool, args: contract.args, status: result?.status || "error", current, rawCurrent, modelVisible: visible,
        reasonCode: current ? null : !rawCurrent ? result?.reasonCode || "dynamic_data_not_current" : "dynamic_evidence_not_model_visible" });
      if (record) records.push({ fact, tool: contract.tool, code: record.code, evidenceId: `dynamic:${contract.tool}:${record.code}`, amount: record.amount, currency: record.currency,
        reviewStatus: record.reviewStatus, active: record.active, effectiveDate: record.effectiveDate, verifiedAt: record.verifiedAt, validUntil: record.validUntil,
        current });
      else if (!result?.ok) errors.push(result?.reasonCode || result?.status || "dynamic_lookup_failed");
    } catch (error) {
      facts.push({ fact, tool: contract.tool, args: contract.args, status: "error", current: false, reasonCode: "dynamic_lookup_failed" });
      errors.push(String(error?.message || error).slice(0, 120));
    }
  }
  return { evaluated: true, facts: dynamicFacts, status: facts.every((item) => item.current) ? "found_current" : facts.some((item) => item.status === "found") ? "found_stale_or_incomplete" : facts[0]?.status || "error",
    records, current: facts.length > 0 && facts.every((item) => item.current), error: errors.length ? errors.join("; ").slice(0, 180) : null, checks: facts, toolObservations };
}

function evidenceReference(hit) {
  const ref = hit?.sourceRef || hit?.chunk_id || hit?.document_id || hit?.source_id;
  return typeof ref === "string" && ref.trim() ? ref.trim() : null;
}

function mergeSearchPolicyMetadata(hit, observationPolicy = {}) {
  const rowPolicy = hit?.policyMetadata && typeof hit.policyMetadata === "object" ? hit.policyMetadata : {};
  return {
    ...rowPolicy,
    topic: rowPolicy.topic || observationPolicy?.metadata?.topic || null,
    facts: Array.isArray(rowPolicy.facts) ? rowPolicy.facts : Array.isArray(observationPolicy?.metadata?.facts) ? observationPolicy.metadata.facts : [],
  };
}

function modelVisibleKnowledgeObservation(hits, suppliedObservation = null) {
  if (suppliedObservation?.type === "approved_knowledge" && Array.isArray(suppliedObservation.evidence)) return suppliedObservation;
  return buildApprovedKnowledgeObservation("found", Array.isArray(hits) ? hits : []);
}

function modelVisibleDocumentLinkedFactRanks(observation, entry) {
  const metadataByRef = new Map((observation?.policyEvidence || []).filter((item) => item?.sourceRef)
    .map((item) => [item.sourceRef, item.metadata || {}]));
  const hits = (observation?.evidence || []).map((item) => ({
    sourceRef: item.sourceRef,
    content: item.content,
    policyMetadata: metadataByRef.get(item.sourceRef) || {},
  }));
  return expectedFactRanks(hits, entry);
}

function buildApprovedEvidenceCatalog(hits, dynamic, now, suppliedObservation = null) {
  const catalog = new Map();
  const observation = modelVisibleKnowledgeObservation(hits, suppliedObservation);
  const rawByRef = new Map((Array.isArray(hits) ? hits : []).map((hit) => [evidenceReference(hit), hit]).filter(([ref]) => ref));
  const policyByRef = new Map((observation.policyEvidence || []).filter((item) => item?.sourceRef).map((item) => [item.sourceRef, item]));
  for (const item of observation.evidence || []) {
    const id = item?.sourceRef;
    const raw = rawByRef.get(id) || {};
    const policyEvidence = policyByRef.get(id) || {};
    const rawPolicy = raw.policyMetadata || {};
    const policy = { ...rawPolicy, ...(policyEvidence.metadata || {}),
      reviewStatus: policyEvidence.review_status || rawPolicy.reviewStatus || raw.review_status,
      validUntil: policyEvidence.valid_until || rawPolicy.validUntil || raw.valid_until };
    const validUntil = Date.parse(policy.validUntil || "");
    const approved = policy.reviewStatus === "approved";
    if (!id || !approved || !Number.isFinite(validUntil) || validUntil <= now.getTime() || typeof item.content !== "string" || !item.content.trim()) continue;
    catalog.set(`rag:${id}`, { kind: "rag", id: `rag:${id}`, ref: id, content: item.content,
      title: item.title || "Approved information", heading: item.section || null,
      policyMetadata: policy, validUntil: policy.validUntil });
  }
  for (const observation of dynamic?.toolObservations || []) {
    const model = observation?.result?.modelObservation;
    if (observation?.result?.ok !== true || observation.result.status !== "found" || model?.type !== "dynamic_data" || model.status !== "found") continue;
    const tool = observation.tool;
    const kind = tool === "lookupActiveOffer" ? "offers" : null;
    if (!kind || model.source !== "trusted_edge_dynamic_read" || model.kind !== kind) continue;
    const trustedRecords = collectDynamicDataEvidence([observation], { now }).map((item) => item.record);
    for (const record of model.records || []) {
      const fact = dynamic.records.find((item) => item.code === record.code && item.current && item.tool === tool);
      if (!fact) continue;
      // The model observation is the evidence the candidate answer can cite.
      // Do not validate it by code alone: a duplicate record with the same
      // code but altered claim fields could otherwise overwrite the trusted
      // catalog entry created from the actual dynamic lookup result.
      const matchesCurrentFact = record.code === fact.code && record.amount === fact.amount && record.currency === fact.currency
        && record.reviewStatus === fact.reviewStatus && record.effectiveDate === fact.effectiveDate
        && record.verifiedAt === fact.verifiedAt && record.validUntil === fact.validUntil;
      if (!matchesCurrentFact || !trustedRecords.some((trusted) => trusted.code === fact.code && trusted.amount === fact.amount
        && trusted.currency === fact.currency && trusted.validUntil === fact.validUntil)) continue;
      const id = `dynamic:${tool}:${record.code}`;
      catalog.set(id, { kind: "dynamic", id, tool, record, fact, observation });
    }
  }
  return catalog;
}

function makeCandidateObservations(evidenceIds, catalog, question) {
  const selected = evidenceIds.map((id) => catalog.get(id));
  const rag = selected.filter((item) => item?.kind === "rag");
  const dynamic = selected.filter((item) => item?.kind === "dynamic");
  const observations = [];
  if (rag.length) {
    observations.push({ step: 0, tool: "searchApprovedKnowledge", args: { query: question }, result: {
      ok: true, status: "found", modelObservation: { type: "approved_knowledge", status: "found",
        evidence: rag.map((item) => ({ title: item.title, section: item.heading, content: item.content, sourceRef: item.ref })),
        policyEvidence: rag.map((item) => ({ sourceRef: item.ref, review_status: "approved", valid_until: item.validUntil,
          metadata: { topic: item.policyMetadata.topic || null, facts: item.policyMetadata.facts || [] } })) }
    } });
  }
  for (const item of dynamic) {
    const source = item.tool === "lookupActiveOffer" ? "trusted_edge_dynamic_read" : null;
    const kind = item.tool === "lookupActiveOffer" ? "offers" : null;
    if (!source || !kind) continue;
    const rawObservation = (item.observation || null);
    if (rawObservation) observations.push({ ...rawObservation, result: { ...rawObservation.result,
      modelObservation: { ...rawObservation.result.modelObservation, records: [item.record] } } });
  }
  return observations;
}

function candidateDigest(entry, candidate) {
  const payload = JSON.stringify({ questionId: entry?.id || null, question: entry?.question || entry?.q || null,
    answer: typeof candidate?.answer === "string" ? candidate.answer : "",
    evidenceIds: Array.isArray(candidate?.evidenceIds) ? candidate.evidenceIds : [] });
  return crypto.createHash("sha256").update(payload, "utf8").digest("hex");
}

function validHumanReview(review, judgment, entry, candidate, now = new Date()) {
  if (!review || typeof review !== "object" || review.type !== "human" || typeof review.reviewerId !== "string" || !/^reviewer-[A-Za-z0-9._-]{1,64}$/u.test(review.reviewerId)) return false;
  // A detached adjudication must identify the precise answer and evidence set
  // the reviewer saw; otherwise an old high score can be reused after editing.
  if (typeof review.candidateSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(review.candidateSha256)
    || review.candidateSha256 !== candidateDigest(entry, candidate)) return false;
  const reviewedAt = Date.parse(review.reviewedAt || "");
  const hasReviewTimestamp = typeof review.reviewedAt === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/u.test(review.reviewedAt);
  const judgmentValid = validateAnswerJudgment(judgment).valid;
  const refusalRequired = entry.expectedRefusal && entry.expectedRefusal !== "none";
  return hasReviewTimestamp && Number.isFinite(reviewedAt) && reviewedAt <= now.getTime() && judgmentValid
    && (!refusalRequired || typeof judgment.refusalPass === "boolean");
}

async function evaluateCandidateAnswer(entry, candidate, catalog, now = new Date(), adjudication = null) {
  const answer = typeof candidate?.answer === "string" ? candidate.answer : "";
  const evidenceIds = Array.isArray(candidate?.evidenceIds) ? candidate.evidenceIds : [];
  const duplicateIds = evidenceIds.filter((id, index) => evidenceIds.indexOf(id) !== index);
  const unknownIds = evidenceIds.filter((id) => typeof id !== "string" || !catalog.has(id));
  const selected = evidenceIds.filter((id) => typeof id === "string" && catalog.has(id)).map((id) => catalog.get(id));
  const missingExpectedFacts = (entry.expectedFacts || []).filter((fact) => !selected.some((item) => item.kind === "dynamic"
    ? item.fact.fact === fact : Array.isArray(item.policyMetadata.facts) && item.policyMetadata.facts.includes(fact)));
  const evidenceValid = duplicateIds.length === 0 && unknownIds.length === 0 && missingExpectedFacts.length === 0;
  // Candidate answer files are not a source of their own human-quality scores.
  // Keep adjudication in a separately supplied object/file so automated or
  // scripted candidate generation cannot accidentally self-certify.
  const reviewValid = validHumanReview(adjudication?.review, adjudication?.judgment, entry, candidate, now);
  const selectedCatalog = evidenceValid ? selected : [];
  const observations = makeCandidateObservations(evidenceValid ? evidenceIds : [], catalog, entry.question);
  const runtime = answer && evidenceValid ? await runAgentTurn(buildAgentContext({ currentMessage: entry.question,
    locale: entry.lang === "ar" ? "arabic" : entry.lang === "el" ? "greek" : "english" }), {
    decideNextStep: async () => ({ type: "respond", text: answer }), tools: {}, initialObservations: observations
  }) : null;
  const runtimeAccepted = Boolean(runtime && runtime.outcome === "responded" && runtime.response === answer && !runtime.corrected);
  const judgment = reviewValid ? adjudication.judgment : null;
  const scoringEvidence = selectedCatalog.map((item) => item.kind === "rag" ? ({ content: item.content, sourceRef: item.ref }) : ({
    content: `${item.record.currency || ""} ${item.record.amount ?? ""} ${item.record.code || ""}`.trim(), sourceRef: item.id
  }));
  const score = runtimeAccepted && reviewValid ? scoreAnswer(entry, answer, scoringEvidence, judgment) : null;
  return {
    evaluated: Boolean(answer && runtime), candidatePresent: Boolean(answer), candidateAcceptedByRuntime: runtimeAccepted,
    runtimeOutcome: runtime?.outcome || (answer ? "not_run_invalid_evidence" : "answer_not_supplied"),
    runtimeReasons: runtime?.reason ? [runtime.reason] : [],
    evidenceSelection: { valid: evidenceValid, requestedIds: evidenceIds, usedIds: runtimeAccepted ? evidenceIds : [],
      rejectedIds: [...new Set([...unknownIds, ...duplicateIds])], missingExpectedFacts, approvedEvidenceAvailable: catalog.size },
    candidateText: answer || null,
    humanAdjudication: { reviewed: reviewValid, type: reviewValid ? "human" : null, reviewerId: reviewValid ? adjudication.review.reviewerId : null,
      reviewedAt: reviewValid ? new Date(adjudication.review.reviewedAt).toISOString() : null },
    ...(score || { scores: null, scoreSource: null, guardrailPass: runtimeAccepted ? null : false,
      outputGuardrailPass: null, formulaPass: null, refusalRequired: Boolean(entry.expectedRefusal && entry.expectedRefusal !== "none"),
      refusalPass: null, expectedRefusal: entry.expectedRefusal, judgmentUnavailableReason: reviewValid ? "candidate_not_accepted_by_runtime" : "explicit_human_review_required" })
  };
}

function validateAnswerJudgment(judgment) {
  if (!judgment || typeof judgment !== "object") return { valid: false, reason: "missing_judgment" };
  for (const axis of AXES) if (!Number.isInteger(judgment[axis]) || judgment[axis] < 0 || judgment[axis] > 3) return { valid: false, reason: `invalid_${axis}` };
  if (judgment.refusalPass !== undefined && typeof judgment.refusalPass !== "boolean") return { valid: false, reason: "invalid_refusalPass" };
  if (judgment.source !== undefined && (typeof judgment.source !== "string" || !judgment.source.trim())) return { valid: false, reason: "invalid_source" };
  return { valid: true };
}

function wilsonInterval(successes, total, z = 1.959963984540054) {
  if (!Number.isInteger(successes) || !Number.isInteger(total) || total <= 0 || successes < 0 || successes > total) return null;
  const p = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) / total) + (z2 / (4 * total * total))) / denominator;
  return { confidence: 0.95, lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) };
}

function scoreAnswer(entry, answer, evidence = [], judgment = null) {
  if (typeof answer !== "string" || !answer.trim()) return { evaluated: false, reason: "answer_not_supplied" };
  const safety = classifySafety(answer);
  const outputChecks = validateResponse(answer, { evidence, language: entry.lang === "ar" ? "arabic" : entry.lang === "el" ? "greek" : "english" });
  const formulaReasons = violatesGoldenFormula(answer, ORDINARY);
  const shape = analyseAnswerShape(answer);
  const unsafe = outputChecks?.valid === false;
  const validJudgment = validateAnswerJudgment(judgment);
  const scores = validJudgment.valid ? Object.fromEntries(AXES.map((axis) => [axis, judgment[axis]])) : null;
  const refusalRequired = entry.expectedRefusal && entry.expectedRefusal !== "none";
  const refusalPass = refusalRequired ? (validJudgment.valid && typeof judgment?.refusalPass === "boolean" ? judgment.refusalPass : null) : null;
  return {
    evaluated: true,
    language: entry.lang,
    expectedFacts: [...entry.expectedFacts],
    retrievedEvidenceCount: evidence.length,
    evidenceAvailable: evidence.length > 0,
    scores,
    scoreSource: scores ? (judgment.source || "external_adjudicator") : null,
    outputGuardrailPass: !unsafe,
    guardrailPass: !unsafe && (!refusalRequired || refusalPass === true),
    safetyClassification: safety?.category || safety?.classification || null,
    outputCheckFailures: Array.isArray(outputChecks?.reasons) ? outputChecks.reasons : [],
    formulaPass: formulaReasons.length === 0,
    expectedRefusal: entry.expectedRefusal,
    refusalRequired: Boolean(refusalRequired),
    refusalPass,
    formulaReasons,
    answerShape: { sentences: shape.sentenceCount, questions: shape.questionCount, chars: shape.charCount },
    judgmentUnavailableReason: validJudgment.valid ? null : validJudgment.reason,
  };
}

function summarize(rows, negatives = []) {
  const positive = rows.filter((r) => r.kind !== "negative");
  const allAnswerRows = [...rows, ...negatives];
  const answers = allAnswerRows.filter((r) => r.answer?.evaluated);
  const judgedAnswers = answers.filter((r) => r.answer?.scores);
  const refusalAnswers = answers.filter((r) => r.answer?.refusalRequired);
  const summary = { totalQuestions: positive.length, retrievalEvaluated: positive.filter((r) => r.retrieval?.evaluated).length, answerEvaluated: answers.length, byLanguage: {}, byDomain: {}, targets: TARGETS };
  const retrievalRows = positive.filter((r) => r.retrieval?.evaluated);
  const topKPasses = retrievalRows.filter((r) => r.retrieval?.ragCoveragePass === true).length;
  const visiblePasses = retrievalRows.filter((r) => r.retrieval?.modelVisibleDocumentLinkedRagCoveragePass === true).length;
  summary.retrievalVisibility = {
    evaluated: retrievalRows.length > 0,
    denominator: retrievalRows.length,
    rankedTopKPasses: topKPasses,
    rankedTopKRate: retrievalRows.length ? topKPasses / retrievalRows.length : null,
    modelVisiblePasses: visiblePasses,
    modelVisibleDocumentLinkedRate: retrievalRows.some((r) => typeof r.retrieval?.modelVisibleDocumentLinkedRagCoveragePass === "boolean")
      ? visiblePasses / retrievalRows.filter((r) => typeof r.retrieval?.modelVisibleDocumentLinkedRagCoveragePass === "boolean").length : null,
    modelVisibleDocumentLinkedEvaluated: retrievalRows.filter((r) => typeof r.retrieval?.modelVisibleDocumentLinkedRagCoveragePass === "boolean").length,
    rankedButNotDocumentLinkedVisible: retrievalRows.filter((r) => r.retrieval?.ragCoveragePass === true && r.retrieval?.modelVisibleDocumentLinkedRagCoveragePass === false).length,
    questionsWithTruncatedObservation: retrievalRows.filter((r) => r.retrieval?.modelVisibleTruncated).length,
    truncatedVisibleChunks: retrievalRows.reduce((sum, r) => sum + (r.retrieval?.modelVisibleContentTruncatedChunks || 0), 0),
    dynamicNote: "Dynamic facts count as current only when the separate data record is current and the trusted dynamic-data model observation contains matching claim fields.",
    note: "Ranked top-K measures raw approved search rows; document-linked visibility measures fact IDs attached to chunks retained in the bounded observation. It does not prove the associated claim text survived the 500-character content limit; claim-in-text and answer quality require human adjudication.",
  };
  const group = (items) => {
    const evaluated = items.filter((r) => r.answer?.scores);
    const answersChecked = items.filter((r) => r.answer?.evaluated);
    const retrievalChecked = items.filter((r) => r.retrieval?.evaluated);
    const languageSearches = items.filter((r) => r.retrieval?.rawSearchEvaluated === true);
    const languageFirst = languageSearches.filter((r) => r.retrieval?.languageRank === 1).length;
    const formulas = answersChecked;
    const factual = evaluated.filter((r) => r.answer.scores.factualAccuracy === 3).length;
    const grounded = evaluated.filter((r) => r.answer.scores.grounding >= 3).length;
    const native = evaluated.filter((r) => r.answer.scores.languageAndDialect === 3).length;
    const retrievalPasses = retrievalChecked.filter((r) => r.retrieval?.ragCoveragePass === true).length;
    const formulaPasses = formulas.filter((r) => r.answer.formulaPass).length;
    const guardrailPasses = answersChecked.filter((r) => r.answer.guardrailPass === true).length;
    const errorBars95 = {
      retrievalPassRate: wilsonInterval(retrievalPasses, retrievalChecked.length),
      ownLanguageFirstRate: wilsonInterval(languageFirst, languageSearches.length),
      factualAccuracyRate: wilsonInterval(factual, evaluated.length),
      fullyGroundedRate: wilsonInterval(grounded, evaluated.length),
      languageQualityRate: wilsonInterval(native, evaluated.length),
      goldenFormulaRate: wilsonInterval(formulaPasses, formulas.length),
      guardrailPassRate: wilsonInterval(guardrailPasses, answersChecked.length),
    };
    return {
      questions: items.length,
      retrievalPasses,
      retrievalPassRate: retrievalChecked.length ? retrievalPasses / retrievalChecked.length : null,
      retrievalPassWilson95: errorBars95.retrievalPassRate,
      ownLanguageFirst: languageFirst,
      ownLanguageFirstEvaluated: languageSearches.length,
      ownLanguageFirstRate: languageSearches.length ? languageFirst / languageSearches.length : null,
      ownLanguageFirstWilson95: wilsonInterval(languageFirst, languageSearches.length),
      answersEvaluated: answersChecked.length,
      judgedAnswers: evaluated.length,
      factualAccuracyRate: evaluated.length ? factual / evaluated.length : null,
      factualAccuracyWilson95: errorBars95.factualAccuracyRate,
      fullyGroundedRate: evaluated.length ? grounded / evaluated.length : null,
      fullyGroundedWilson95: errorBars95.fullyGroundedRate,
      languageQualityRate: evaluated.length ? native / evaluated.length : null,
      languageQualityWilson95: errorBars95.languageQualityRate,
      guardrailFailures: answersChecked.filter((r) => !r.answer.guardrailPass).length,
      guardrailPassRate: answersChecked.length ? guardrailPasses / answersChecked.length : null,
      guardrailPassWilson95: errorBars95.guardrailPassRate,
      goldenFormulaRate: formulas.length ? formulaPasses / formulas.length : null,
      goldenFormulaWilson95: errorBars95.goldenFormulaRate,
      errorBars95,
    };
  };
  for (const lang of LANGUAGES) summary.byLanguage[lang] = group(positive.filter((r) => r.lang === lang));
  for (const domain of [...new Set(positive.map((r) => r.domain))]) summary.byDomain[domain] = group(positive.filter((r) => r.domain === domain));
  const spread = (key) => {
    const rates = Object.values(summary.byLanguage).map((s) => s[key]).filter(Number.isFinite);
    return rates.length > 1 ? Math.max(...rates) - Math.min(...rates) : null;
  };
  summary.languageParitySpreads = {
    ownLanguageFirstRate: spread("ownLanguageFirstRate"),
    factualAccuracy: spread("factualAccuracyRate"),
    grounding: spread("fullyGroundedRate"),
    languageAndDialect: spread("languageQualityRate"),
    goldenFormula: spread("goldenFormulaRate"),
  };
  summary.dynamicExpectedFacts = {
    evaluated: positive.filter((r) => r.dynamic?.evaluated).length,
    current: positive.filter((r) => r.dynamic?.current === true).length,
    unavailableOrStale: positive.filter((r) => r.dynamic?.evaluated && r.dynamic.current !== true).length,
    byFact: Object.fromEntries([...new Set(positive.flatMap((r) => r.dynamic?.facts || []))].map((fact) => [fact, {
      total: positive.filter((r) => r.dynamic?.facts?.includes(fact)).length,
      current: positive.filter((r) => r.dynamic?.facts?.includes(fact) && r.dynamic?.current === true).length,
      modelVisible: positive.filter((r) => r.dynamic?.checks?.some((check) => check.fact === fact && check.modelVisible === true)).length,
      rawCurrentButNotModelVisible: positive.filter((r) => r.dynamic?.checks?.some((check) => check.fact === fact && check.rawCurrent === true && check.modelVisible !== true)).length,
    }])),
  };
  summary.negativeControls = {
    total: negatives.length,
    type: "raw-unconditional-search-diagnostic; not an Agent scope/guardrail result",
    rawSearchEvaluated: negatives.filter((r) => r.retrieval?.rawSearchEvaluated).length,
    rawSearchReturnedEvidence: negatives.filter((r) => r.retrieval?.rawResultCount > 0).length,
    agentGuardrailEvaluated: 0,
    agentGuardrailFailures: null,
    candidateAnswers: negatives.filter((r) => r.answer?.candidatePresent).length,
    candidateAnswersAcceptedByRuntime: negatives.filter((r) => r.answer?.candidateAcceptedByRuntime).length,
    humanReviewedRefusals: negatives.filter((r) => r.answer?.refusalRequired && r.answer?.humanAdjudication?.reviewed && r.answer?.refusalPass === true).length,
    candidateAgentGuardrailEvaluated: negatives.filter((r) => r.answer?.evaluated).length,
    candidateAgentGuardrailFailures: negatives.filter((r) => r.answer?.evaluated && !r.answer?.candidateAcceptedByRuntime).length,
  };
  summary.agentGuardrail = { evaluated: 0, failures: null,
    candidateAnswersEvaluated: allAnswerRows.filter((r) => r.answer?.evaluated).length,
    candidateAnswersRejected: allAnswerRows.filter((r) => r.answer?.evaluated && !r.answer?.candidateAcceptedByRuntime).length,
    note: "Prewritten candidates run through Agent output, grounding, and language gates; this does not evaluate model decisions or the intent/scope-selection path." };
  summary.assessment = {
    factualAccuracy: judgedAnswers.length ? `scored for ${judgedAnswers.length} answers using supplied 0-3 adjudications` : "not evaluated",
    grounding: judgedAnswers.length ? `scored for ${judgedAnswers.length} answers using supplied 0-3 adjudications` : "not evaluated",
    languageAndDialect: judgedAnswers.length ? `scored for ${judgedAnswers.length} answers using supplied 0-3 adjudications` : "not evaluated",
    modelSuccess: "never inferred from scripted fallback; this harness does not generate answers",
  };
  const readinessMetric = (name, denominator, successes, threshold) => ({
    name, evaluated: denominator > 0, denominator, successes: denominator ? successes : null,
    rate: denominator ? successes / denominator : null, threshold,
    pass: denominator > 0 ? successes / denominator >= threshold : null,
  });
  const positiveCandidates = positive.filter((r) => r.answer?.candidatePresent).length;
  const negativeCandidates = negatives.filter((r) => r.answer?.candidatePresent).length;
  // A subset (for example --limit 3 or --lang ar) can be useful diagnostically,
  // but must never be mistaken for complete P14 answer coverage. Compare IDs,
  // not row counts, so duplicates cannot hide omitted cases.
  const exactIdCoverage = (items, expected, kind) => {
    const actualIds = items.map((item) => item.id);
    const expectedIds = expected.map((item) => item.id);
    if (actualIds.length !== expectedIds.length || new Set(actualIds).size !== actualIds.length
      || !expectedIds.every((id) => actualIds.includes(id))) return false;
    const actualById = new Map(items.map((item) => [item.id, item]));
    return expected.every((source) => {
      const row = actualById.get(source.id);
      // IDs alone are insufficient: callers of this exported harness can pass
      // custom entry objects, and a same-ID row with a changed question,
      // language, fact set, or refusal contract would otherwise count as the
      // authoritative golden case while changing its measured semantics.
      const question = kind === "negative" ? source.q : source.question;
      return row?.kind === kind && row.lang === source.lang && row.question === question
        && row.expectedRefusal === source.expectedRefusal
        && JSON.stringify(row.expectedFacts) === JSON.stringify(source.expectedFacts)
        && row.topic === (source.topic ?? null) && row.domain === (source.domain ?? null);
    });
  };
  const completeGoldenSet = exactIdCoverage(positive, ENTRIES, "positive") && exactIdCoverage(negatives, NEGATIVE_QUERIES, "negative");
  const answerCoverage = positive.length ? positiveCandidates / positive.length : null;
  const judgedCoverage = answers.length ? judgedAnswers.length / answers.length : null;
  const refusalEvaluated = refusalAnswers.filter((r) => typeof r.answer?.refusalPass === "boolean");
  const refusalPassed = refusalEvaluated.filter((r) => r.answer.refusalPass).length;
  const answerGates = {
    factualAccuracy: readinessMetric("factualAccuracy", judgedAnswers.length, judgedAnswers.filter((r) => r.answer.scores.factualAccuracy === 3).length, TARGETS.factualAccuracy),
    grounding: readinessMetric("grounding", judgedAnswers.length, judgedAnswers.filter((r) => r.answer.scores.grounding === 3).length, TARGETS.grounding),
    guardrailFailures: { evaluated: answers.length > 0, denominator: answers.length, failures: answers.filter((r) => !r.answer.guardrailPass).length,
      threshold: TARGETS.guardrailFailures, pass: answers.length > 0 ? answers.every((r) => r.answer.guardrailPass === true) : null },
    goldenFormula: readinessMetric("goldenFormula", answers.length, answers.filter((r) => r.answer.formulaPass).length, TARGETS.goldenFormula),
    languageParity: (() => {
      const rates = LANGUAGES.map((lang) => summary.byLanguage[lang]?.languageQualityRate);
      const spread = rates.every(Number.isFinite) ? Math.max(...rates) - Math.min(...rates) : null;
      const allLanguagesMeetMinimum = rates.every((rate) => Number.isFinite(rate) && rate >= TARGETS.languageQualityRate);
      return { evaluated: spread !== null, languageRates: Object.fromEntries(LANGUAGES.map((lang) => [lang, summary.byLanguage[lang]?.languageQualityRate ?? null])),
        spread, threshold: TARGETS.languageParitySpread, minimumLanguageQualityRate: TARGETS.languageQualityRate,
        allLanguagesMeetMinimum, pass: spread === null ? null : spread <= TARGETS.languageParitySpread && allLanguagesMeetMinimum };
    })(),
    ownLanguageFirst: (() => {
      const searches = positive.filter((r) => r.retrieval?.rawSearchEvaluated === true);
      const first = searches.filter((r) => r.retrieval?.languageRank === 1).length;
      const complete = searches.length === positive.length;
      return { evaluated: complete && searches.length > 0, successes: first, denominator: searches.length,
        rate: searches.length ? first / searches.length : null, threshold: TARGETS.ownLanguageFirst,
        pass: complete && searches.length > 0 ? first / searches.length >= TARGETS.ownLanguageFirst : null };
    })(),
  };
  summary.answerReadiness = {
    goldenSetCoverage: { complete: completeGoldenSet, positive: { evaluated: positive.length, required: ENTRIES.length },
      negative: { evaluated: negatives.length, required: NEGATIVE_QUERIES.length } },
    answerCoverage: { evaluated: positive.length > 0, answered: positiveCandidates, total: positive.length, rate: answerCoverage },
    negativeControlAnswerCoverage: { answered: negativeCandidates, total: negatives.length,
      rate: negatives.length ? negativeCandidates / negatives.length : null },
    adjudicationCoverage: { evaluated: answers.length > 0, adjudicated: judgedAnswers.length, answered: answers.length, rate: judgedCoverage },
    refusalCoverage: { required: refusalAnswers.length, evaluated: refusalEvaluated.length, passed: refusalPassed,
      rate: refusalEvaluated.length ? refusalPassed / refusalEvaluated.length : null,
      pass: refusalAnswers.length > 0 ? refusalEvaluated.length === refusalAnswers.length && refusalPassed === refusalAnswers.length : null },
    gates: answerGates,
    answerQualityGateEligible: completeGoldenSet && positive.length > 0 && positiveCandidates === positive.length && negativeCandidates === negatives.length
      && answers.length === positiveCandidates + negativeCandidates && judgedAnswers.length === answers.length
      && refusalAnswers.length > 0
      && refusalAnswers.length === refusalEvaluated.length && refusalPassed === refusalAnswers.length
      && Object.values(answerGates).every((gate) => gate.pass === true),
  };
  return summary;
}

async function evaluate({ entries = ENTRIES, negatives = NEGATIVE_QUERIES, retrieve, lookupDynamic = null, answers = {}, adjudications = {}, topK = 5, now = new Date(), testType = "synthetic-fixture" }) {
  if (!["synthetic-fixture", "live-search-diagnostic"].includes(testType)) {
    throw new TypeError("testType must be synthetic-fixture or live-search-diagnostic; this evaluator never measures production answers.");
  }
  const schemaErrors = validateAll();
  if (schemaErrors.length) throw new Error(`Golden set validation failed: ${schemaErrors.slice(0, 5).join("; ")}`);
  const rows = [];
  for (const entry of entries) {
    let hits = [];
    let suppliedObservation = null;
    let error = null;
    try {
      const result = await retrieve(entry.question, entry, topK);
      if (Array.isArray(result)) hits = result;
      else if (result && typeof result === "object") { hits = Array.isArray(result.hits) ? result.hits : []; suppliedObservation = result.modelObservation || null; }
    } catch (err) { error = String(err?.message || err).slice(0, 160); }
    const identities = hits.map((hit) => expectedIdentity(hit, entry));
    const topicRank = identities.findIndex((i) => i.topic) + 1 || null;
    const languageRank = identities.findIndex((i) => i.language) + 1 || null;
    const { ragFacts, dynamicFacts } = splitExpectedFacts(entry);
    const ragEntry = { ...entry, expectedFacts: ragFacts };
    const facts = expectedFactRanks(hits, ragEntry);
    const modelObservation = modelVisibleKnowledgeObservation(hits, suppliedObservation);
    const visibleFacts = modelVisibleDocumentLinkedFactRanks(modelObservation, ragEntry);
    const dynamic = await readDynamicExpectedFacts(entry, lookupDynamic, now);
    const provided = answers[entry.id] || {};
    const answer = await evaluateCandidateAnswer(entry, provided, buildApprovedEvidenceCatalog(hits, dynamic, now, modelObservation), now, adjudications[entry.id]);
    const { toolObservations: _toolObservations, ...dynamicReport } = dynamic;
    rows.push({ id: entry.id, kind: "positive", topic: entry.topic, domain: entry.domain, lang: entry.lang, question: entry.question,
      expectedFacts: [...entry.expectedFacts], expectedRefusal: entry.expectedRefusal,
      dynamic: dynamicReport,
      retrieval: { evaluated: ragFacts.length > 0, rawSearchEvaluated: true, scope: "forced approved-knowledge search for diagnostic; not Agent orchestration",
        ragExpectedFacts: ragFacts, dynamicExpectedFacts: dynamicFacts,
    method: "single-original-query-ranked-search", resultCount: hits.length, topicRank, languageRank,
        expectedFactRanks: facts.factRanks, expectedFactCoverageRank: facts.allExpectedFactsRank,
        expectedFactCoveragePass: ragFacts.length ? facts.allExpectedFactsFound && facts.allExpectedFactsRank <= topK : null,
        ragCoveragePass: ragFacts.length ? facts.allExpectedFactsFound && facts.allExpectedFactsRank <= topK : null,
        modelVisibleEvidenceCount: (modelObservation.evidence || []).length,
        modelVisibleContentChars: (modelObservation.evidence || []).reduce((sum, item) => sum + String(item.content || "").length, 0),
        modelVisibleContentTruncatedChunks: (modelObservation.evidence || []).filter((item) => item.contentTruncated).length,
        modelVisibleTruncated: Boolean(modelObservation.truncated || (modelObservation.evidence || []).some((item) => item.contentTruncated)),
        modelVisibleDocumentLinkedFactRanks: visibleFacts.factRanks,
        modelVisibleDocumentLinkedFactCoverageRank: visibleFacts.allExpectedFactsRank,
        modelVisibleDocumentLinkedFactCoveragePass: ragFacts.length ? visibleFacts.allExpectedFactsFound : null,
        modelVisibleDocumentLinkedRagCoveragePass: ragFacts.length ? visibleFacts.allExpectedFactsFound : null,
        textVisibleFactClaimEvaluation: "not_evaluated; document-linked fact IDs and bounded chunk text do not prove the claim text is present; human answer adjudication is required",
        agentGuardrailVerdict: null, error,
        candidates: hits.map((hit, index) => ({ rank: index + 1, evidenceId: evidenceReference(hit) ? `rag:${evidenceReference(hit)}` : null,
          source_url: hit.source_url || hit.canonical_url || null, document_title: hit.document_title || null, heading: hit.heading || null,
          expectedFactsMatched: [...expectedIdentity(hit, entry).facts].filter((fact) => entry.expectedFacts.includes(fact)),
          score: Number.isFinite(Number(hit.rank ?? hit.score)) ? Number(hit.rank ?? hit.score) : null })) },
      answer });
  }
  const negativeRows = [];
  for (const entry of negatives) {
    let hits = [], error = null;
    try {
      const result = await retrieve(entry.q, entry, topK);
      hits = Array.isArray(result) ? result : Array.isArray(result?.hits) ? result.hits : [];
    } catch (err) { error = String(err?.message || err).slice(0, 160); }
    const negativeAnswer = await evaluateCandidateAnswer({ ...entry, question: entry.q }, answers[entry.id] || {}, new Map(), now, adjudications[entry.id]);
    negativeRows.push({ id: entry.id, kind: "negative", lang: entry.lang, topic: entry.topic ?? null, domain: entry.domain ?? null, question: entry.q,
      expectedRefusal: entry.expectedRefusal, answer: negativeAnswer,
      retrieval: { evaluated: false, rawSearchEvaluated: true, type: "raw-unconditional-search-diagnostic", scope: "tool called regardless of Agent intent/scope decision",
        rawResultCount: hits.length, rawReturnedEvidence: hits.length > 0, pass: null, agentGuardrailVerdict: null, error,
        candidates: hits.map((hit, index) => ({ rank: index + 1, source_url: hit.source_url || hit.canonical_url || null, document_title: hit.document_title || null, heading: hit.heading || null })) } });
  }
  const all = [...rows, ...negativeRows];
  return { schemaVersion: 1, evaluation: "P14.1 golden knowledge", testType, generatedAt: new Date().toISOString(), topK, targets: TARGETS,
    candidateAnswerContract: { answer: "candidate response text", evidenceIds: "IDs copied from approved retrieval candidates or current dynamic evidence records",
      humanAdjudication: "separate adjudications input keyed by golden question ID; review must include candidateSha256 over question ID, question text, exact answer, and evidence IDs; embedded answer-file review fields are ignored",
      judgment: [...AXES, "refusalPass (required when expectedRefusal is not none)"], noModelProviderCalled: true },
    scope: { search: "approved-knowledge tool is forced for diagnostic; original query only", agentOrchestrationEvaluated: false,
      negativeControls: "unconditional raw-search diagnostics only; result rows do not establish agent scope-gate or guardrail behavior",
      dynamicFacts: "looked up through separate current dynamic-data tools; never included in RAG rank" },
    summary: summarize(rows, negativeRows), results: all };
}

function parseArgs(argv) {
  const out = { top: 5, limit: 0, lang: null, id: null, output: path.resolve("reports/golden-evaluation/latest.json"), answers: null, adjudications: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined || !String(next).trim() || next.startsWith("--")) throw new Error(`${arg} requires a value`);
      return next;
    };
    if (arg === "--top") out.top = Number(value());
    else if (arg === "--limit") out.limit = Number(value());
    else if (arg === "--lang") out.lang = value();
    else if (arg === "--id") out.id = value();
    else if (arg === "--output") out.output = path.resolve(value());
    else if (arg === "--answers") out.answers = path.resolve(value());
    else if (arg === "--adjudications") out.adjudications = path.resolve(value());
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(out.top) || out.top < 1 || out.top > 50) throw new Error("--top must be an integer from 1 to 50");
  if (!Number.isInteger(out.limit) || out.limit < 0) throw new Error("--limit must be a non-negative integer");
  if (out.lang !== null && !LANGUAGES.includes(out.lang)) throw new Error("--lang must be one of: ar, en, el");
  for (const option of ["id", "output", "answers", "adjudications"]) {
    if (out[option] !== null && !String(out[option]).trim()) throw new Error(`--${option} requires a value`);
  }
  if (out.answers && out.adjudications && samePhysicalPath(out.answers, out.adjudications)) throw new Error("--answers and --adjudications must be separate files");
  return out;
}

function samePhysicalPath(left, right) {
  const canonicalize = (file) => {
    try { return fs.realpathSync.native(file); }
    catch { return path.resolve(file); }
  };
  const first = path.normalize(canonicalize(left));
  const second = path.normalize(canonicalize(right));
  return process.platform === "win32" ? first.toLowerCase() === second.toLowerCase() : first === second;
}

async function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  let selected = ENTRIES.filter((e) => (!args.lang || e.lang === args.lang) && (!args.id || e.id === args.id));
  if (args.id && selected.length !== 1) throw new Error(`Golden question id not found: ${args.id}`);
  selected = selected.slice(0, args.limit || undefined);
  const negativeSelected = args.id ? [] : args.lang ? NEGATIVE_QUERIES.filter((e) => e.lang === args.lang) : NEGATIVE_QUERIES;
  const answerData = args.answers ? JSON.parse(fs.readFileSync(args.answers, "utf8")) : {};
  const adjudicationData = args.adjudications ? JSON.parse(fs.readFileSync(args.adjudications, "utf8")) : {};
  const { loadProjectEnv } = require("../src/env");
  loadProjectEnv(path.resolve(__dirname, ".."));
  const { createStore } = require("../src/supabaseStore");
  const { embedText, DEFAULT_EMBEDDING_MODEL } = require("../src/ai");
  const { TOOL_REGISTRY, searchApprovedKnowledge } = require("../src/agentTools");
  const store = createStore();
  const report = await evaluate({ entries: selected, negatives: negativeSelected, topK: args.top, answers: answerData, adjudications: adjudicationData, testType: "live-search-diagnostic",
    retrieve: async (question, item, top) => {
      const language = { ar: "arabic", en: "english", el: "greek" }[item.lang] || "english";
      const result = await searchApprovedKnowledge({ query: question }, { store, embedText, embeddingModel: DEFAULT_EMBEDDING_MODEL, matchCount: top, language });
      if (!result.ok) throw new Error(result.reasonCode || result.status || "approved-knowledge search failed");
      // `data` is the ranked evidence from the exact production Agent search
      // tool. Its policy metadata is aligned by position and carries trusted
      // topic/fact IDs, so expected-fact retrieval is scored without titles.
      const policy = result.modelObservation?.policyEvidence || [];
      const hits = (result.data || []).map((row, index) => ({ ...row, policyMetadata: mergeSearchPolicyMetadata(row, policy[index]) }));
      return { hits, modelObservation: result.modelObservation };
    },
    lookupDynamic: async (toolName, toolArgs) => {
      const tool = TOOL_REGISTRY[toolName];
      if (!tool || typeof tool.run !== "function") throw new Error(`Dynamic tool unavailable: ${toolName}`);
      return tool.run(toolArgs, { store });
    } });
  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`P14.1: ${selected.length}/${ENTRIES.length} golden questions; RAG-ranked ${report.summary.retrievalEvaluated}; dynamic facts ${report.summary.dynamicExpectedFacts.evaluated}; answers ${report.summary.answerEvaluated}; test type live search diagnostic.`);
  console.log(`Report: ${args.output}`);
  console.log("Answer quality targets are unscored unless explicit adjudications are supplied; no model or scripted fallback is implied.");
  return report;
}

if (require.main === module) run().catch((err) => { console.error(`Golden evaluation failed: ${String(err?.message || err).slice(0, 200)}`); process.exitCode = 1; });
module.exports = { TARGETS, scoreAnswer, summarize, evaluate, evaluateCandidateAnswer, buildApprovedEvidenceCatalog, mergeSearchPolicyMetadata, modelVisibleKnowledgeObservation, modelVisibleDocumentLinkedFactRanks, parseArgs, run, expectedIdentity, expectedFactRanks, splitExpectedFacts, readDynamicExpectedFacts, candidateDigest };
