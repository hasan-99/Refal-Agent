"use strict";

// P14.1 harness. Retrieval is measured against the current taxonomy identity
// (topic + language), never document titles that change during editing. Model
// answers are optional and are never represented as evaluated when absent.
const fs = require("node:fs");
const path = require("node:path");
const { ENTRIES, NEGATIVE_QUERIES, validateAll } = require("../src/brainGoldenSet");
const { LANGUAGES } = require("../src/brainTaxonomy");
const { classifySafety } = require("../src/safetyPolicy");
const { validateResponse } = require("../src/responsePolicy");
const { analyseAnswerShape, violatesGoldenFormula, ORDINARY } = require("../src/goldenFormula");

const TARGETS = Object.freeze({ factualAccuracy: 0.90, grounding: 1, guardrailFailures: 0, goldenFormula: 0.85, languageParitySpread: 0.10, ownLanguageFirstRate: 1 });
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
  for (const fact of dynamicFacts) {
    const contract = DYNAMIC_FACT_LOOKUPS[fact];
    try {
      const result = await lookupDynamic(contract.tool, contract.args, entry);
      const candidates = Array.isArray(result?.data) ? result.data : [];
      const record = candidates.find((candidate) => contract.match(candidate)) || null;
      const validUntil = Date.parse(record?.validUntil || "");
      const effectiveDate = Date.parse(record?.effectiveDate || "");
      const verifiedAt = Date.parse(record?.verifiedAt || "");
      const current = Boolean(result?.ok && result.status === "found" && record?.active === true && record?.reviewStatus === "approved"
        && Number.isFinite(validUntil) && validUntil > now.getTime()
        && Number.isFinite(effectiveDate) && effectiveDate <= now.getTime()
        && Number.isFinite(verifiedAt) && verifiedAt <= now.getTime());
      facts.push({ fact, tool: contract.tool, args: contract.args, status: result?.status || "error", current, reasonCode: result?.reasonCode || null });
      if (record) records.push({ fact, tool: contract.tool, code: record.code, amount: record.amount, currency: record.currency,
        reviewStatus: record.reviewStatus, active: record.active, effectiveDate: record.effectiveDate, verifiedAt: record.verifiedAt, validUntil: record.validUntil,
        current });
      else if (!result?.ok) errors.push(result?.reasonCode || result?.status || "dynamic_lookup_failed");
    } catch (error) {
      facts.push({ fact, tool: contract.tool, args: contract.args, status: "error", current: false, reasonCode: "dynamic_lookup_failed" });
      errors.push(String(error?.message || error).slice(0, 120));
    }
  }
  return { evaluated: true, facts: dynamicFacts, status: facts.every((item) => item.current) ? "found_current" : facts.some((item) => item.status === "found") ? "found_stale_or_incomplete" : facts[0]?.status || "error",
    records, current: facts.length > 0 && facts.every((item) => item.current), error: errors.length ? errors.join("; ").slice(0, 180) : null, checks: facts };
}

function validateAnswerJudgment(judgment) {
  if (!judgment || typeof judgment !== "object") return { valid: false, reason: "missing_judgment" };
  for (const axis of AXES) if (!Number.isInteger(judgment[axis]) || judgment[axis] < 0 || judgment[axis] > 3) return { valid: false, reason: `invalid_${axis}` };
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
  const scores = validJudgment.valid ? judgment : null;
  return {
    evaluated: true,
    language: entry.lang,
    expectedFacts: [...entry.expectedFacts],
    retrievedEvidenceCount: evidence.length,
    evidenceAvailable: evidence.length > 0,
    scores,
    scoreSource: scores ? (judgment.source || "external_adjudicator") : null,
    guardrailPass: !unsafe,
    safetyClassification: safety?.category || safety?.classification || null,
    outputCheckFailures: Array.isArray(outputChecks?.reasons) ? outputChecks.reasons : [],
    formulaPass: formulaReasons.length === 0,
    expectedRefusal: entry.expectedRefusal,
    refusalPass: entry.expectedRefusal === "none" ? null : typeof judgment?.refusalPass === "boolean" ? judgment.refusalPass : null,
    formulaReasons,
    answerShape: { sentences: shape.sentenceCount, questions: shape.questionCount, chars: shape.charCount },
    judgmentUnavailableReason: validJudgment.valid ? null : validJudgment.reason,
  };
}

function summarize(rows, negatives = []) {
  const positive = rows.filter((r) => r.kind !== "negative");
  const answers = positive.filter((r) => r.answer?.evaluated);
  const judgedAnswers = answers.filter((r) => r.answer?.scores);
  const summary = { totalQuestions: positive.length, retrievalEvaluated: positive.filter((r) => r.retrieval?.evaluated).length, answerEvaluated: answers.length, byLanguage: {}, byDomain: {}, targets: TARGETS };
  const group = (items) => {
    const evaluated = items.filter((r) => r.answer?.scores);
    const answersChecked = items.filter((r) => r.answer?.evaluated);
    const languageSearches = items.filter((r) => r.retrieval?.rawSearchEvaluated === true);
    const languageFirst = languageSearches.filter((r) => r.retrieval?.languageRank === 1).length;
    const formulas = answersChecked;
    const factual = evaluated.filter((r) => r.answer.scores.factualAccuracy === 3).length;
    const grounded = evaluated.filter((r) => r.answer.scores.grounding >= 3).length;
    const native = evaluated.filter((r) => r.answer.scores.languageAndDialect === 3).length;
    return {
      questions: items.length,
      retrievalPasses: items.filter((r) => r.retrieval?.ragCoveragePass === true).length,
      retrievalPassRate: items.some((r) => r.retrieval?.evaluated) ? items.filter((r) => r.retrieval?.ragCoveragePass === true).length / items.filter((r) => r.retrieval?.evaluated).length : null,
      ownLanguageFirst: languageFirst,
      ownLanguageFirstEvaluated: languageSearches.length,
      ownLanguageFirstRate: languageSearches.length ? languageFirst / languageSearches.length : null,
      ownLanguageFirstWilson95: wilsonInterval(languageFirst, languageSearches.length),
      answersEvaluated: answersChecked.length,
      judgedAnswers: evaluated.length,
      factualAccuracyRate: evaluated.length ? factual / evaluated.length : null,
      fullyGroundedRate: evaluated.length ? grounded / evaluated.length : null,
      languageQualityRate: evaluated.length ? native / evaluated.length : null,
      guardrailFailures: answersChecked.filter((r) => !r.answer.guardrailPass).length,
      goldenFormulaRate: formulas.length ? formulas.filter((r) => r.answer.formulaPass).length / formulas.length : null,
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
    }])),
  };
  summary.negativeControls = {
    total: negatives.length,
    type: "raw-unconditional-search-diagnostic; not an Agent scope/guardrail result",
    rawSearchEvaluated: negatives.filter((r) => r.retrieval?.rawSearchEvaluated).length,
    rawSearchReturnedEvidence: negatives.filter((r) => r.retrieval?.rawResultCount > 0).length,
    agentGuardrailEvaluated: 0,
    agentGuardrailFailures: null,
  };
  summary.agentGuardrail = { evaluated: 0, failures: null, note: "No orchestration or scope gate is run by this retrieval diagnostic." };
  summary.assessment = {
    factualAccuracy: judgedAnswers.length ? `scored for ${judgedAnswers.length} answers using supplied 0-3 adjudications` : "not evaluated",
    grounding: judgedAnswers.length ? `scored for ${judgedAnswers.length} answers using supplied 0-3 adjudications` : "not evaluated",
    languageAndDialect: judgedAnswers.length ? `scored for ${judgedAnswers.length} answers using supplied 0-3 adjudications` : "not evaluated",
    modelSuccess: "never inferred from scripted fallback; this harness does not generate answers",
  };
  return summary;
}

async function evaluate({ entries = ENTRIES, negatives = NEGATIVE_QUERIES, retrieve, lookupDynamic = null, answers = {}, topK = 5, now = new Date(), testType = "synthetic-fixture" }) {
  const schemaErrors = validateAll();
  if (schemaErrors.length) throw new Error(`Golden set validation failed: ${schemaErrors.slice(0, 5).join("; ")}`);
  const rows = [];
  for (const entry of entries) {
    let hits = [];
    let error = null;
    try { hits = await retrieve(entry.question, entry, topK); } catch (err) { error = String(err?.message || err).slice(0, 160); }
    const identities = hits.map((hit) => expectedIdentity(hit, entry));
    const topicRank = identities.findIndex((i) => i.topic) + 1 || null;
    const languageRank = identities.findIndex((i) => i.language) + 1 || null;
    const { ragFacts, dynamicFacts } = splitExpectedFacts(entry);
    const ragEntry = { ...entry, expectedFacts: ragFacts };
    const facts = expectedFactRanks(hits, ragEntry);
    const dynamic = await readDynamicExpectedFacts(entry, lookupDynamic, now);
    const provided = answers[entry.id] || {};
    rows.push({ id: entry.id, kind: "positive", topic: entry.topic, domain: entry.domain, lang: entry.lang, question: entry.question,
      expectedFacts: [...entry.expectedFacts], expectedRefusal: entry.expectedRefusal,
      dynamic,
      retrieval: { evaluated: ragFacts.length > 0, rawSearchEvaluated: true, scope: "forced approved-knowledge search for diagnostic; not Agent orchestration",
        ragExpectedFacts: ragFacts, dynamicExpectedFacts: dynamicFacts,
    method: "single-original-query-ranked-search", resultCount: hits.length, topicRank, languageRank,
        expectedFactRanks: facts.factRanks, expectedFactCoverageRank: facts.allExpectedFactsRank,
        expectedFactCoveragePass: ragFacts.length ? facts.allExpectedFactsFound && facts.allExpectedFactsRank <= topK : null,
        ragCoveragePass: ragFacts.length ? facts.allExpectedFactsFound && facts.allExpectedFactsRank <= topK : null,
        agentGuardrailVerdict: null, error,
        candidates: hits.map((hit, index) => ({ rank: index + 1, source_url: hit.source_url || hit.canonical_url || null, document_title: hit.document_title || null, heading: hit.heading || null,
          expectedFactsMatched: [...expectedIdentity(hit, entry).facts].filter((fact) => entry.expectedFacts.includes(fact)),
          score: Number.isFinite(Number(hit.rank ?? hit.score)) ? Number(hit.rank ?? hit.score) : null })) },
      answer: scoreAnswer(entry, provided.answer, provided.evidence || hits, provided.judgment || null) });
  }
  const negativeRows = [];
  for (const entry of negatives) {
    let hits = [], error = null;
    try { hits = await retrieve(entry.q, entry, topK); } catch (err) { error = String(err?.message || err).slice(0, 160); }
    negativeRows.push({ id: entry.id, kind: "negative", lang: entry.lang, topic: null, domain: null, question: entry.q,
      retrieval: { evaluated: false, rawSearchEvaluated: true, type: "raw-unconditional-search-diagnostic", scope: "tool called regardless of Agent intent/scope decision",
        rawResultCount: hits.length, rawReturnedEvidence: hits.length > 0, pass: null, agentGuardrailVerdict: null, error,
        candidates: hits.map((hit, index) => ({ rank: index + 1, source_url: hit.source_url || hit.canonical_url || null, document_title: hit.document_title || null, heading: hit.heading || null })) } });
  }
  const all = [...rows, ...negativeRows];
  return { schemaVersion: 1, evaluation: "P14.1 golden knowledge", testType, generatedAt: new Date().toISOString(), topK, targets: TARGETS,
    scope: { search: "approved-knowledge tool is forced for diagnostic; original query only", agentOrchestrationEvaluated: false,
      negativeControls: "unconditional raw-search diagnostics only; result rows do not establish agent scope-gate or guardrail behavior",
      dynamicFacts: "looked up through separate current dynamic-data tools; never included in RAG rank" },
    summary: summarize(rows, negativeRows), results: all };
}

function parseArgs(argv) {
  const out = { top: 5, limit: 0, lang: null, id: null, output: path.resolve("reports/golden-evaluation/latest.json"), answers: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--top") out.top = Number(argv[++i]);
    else if (arg === "--limit") out.limit = Number(argv[++i]);
    else if (arg === "--lang") out.lang = argv[++i];
    else if (arg === "--id") out.id = argv[++i];
    else if (arg === "--output") out.output = path.resolve(argv[++i]);
    else if (arg === "--answers") out.answers = path.resolve(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(out.top) || out.top < 1 || out.top > 50) throw new Error("--top must be an integer from 1 to 50");
  if (!Number.isInteger(out.limit) || out.limit < 0) throw new Error("--limit must be a non-negative integer");
  return out;
}

async function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  let selected = ENTRIES.filter((e) => (!args.lang || e.lang === args.lang) && (!args.id || e.id === args.id));
  if (args.id && selected.length !== 1) throw new Error(`Golden question id not found: ${args.id}`);
  selected = selected.slice(0, args.limit || undefined);
  const negativeSelected = args.id ? [] : args.lang ? NEGATIVE_QUERIES.filter((e) => e.lang === args.lang) : NEGATIVE_QUERIES;
  const answerData = args.answers ? JSON.parse(fs.readFileSync(args.answers, "utf8")) : {};
  const { loadProjectEnv } = require("../src/env");
  loadProjectEnv(path.resolve(__dirname, ".."));
  const { createStore } = require("../src/supabaseStore");
  const { embedText, DEFAULT_EMBEDDING_MODEL } = require("../src/ai");
  const { TOOL_REGISTRY, searchApprovedKnowledge } = require("../src/agentTools");
  const store = createStore();
  const report = await evaluate({ entries: selected, negatives: negativeSelected, topK: args.top, answers: answerData, testType: "live-search-diagnostic",
    retrieve: async (question, item, top) => {
      const language = { ar: "arabic", en: "english", el: "greek" }[item.lang] || "english";
      const result = await searchApprovedKnowledge({ query: question }, { store, embedText, embeddingModel: DEFAULT_EMBEDDING_MODEL, matchCount: top, language });
      if (!result.ok) throw new Error(result.reasonCode || result.status || "approved-knowledge search failed");
      // `data` is the ranked evidence from the exact production Agent search
      // tool. Its policy metadata is aligned by position and carries trusted
      // topic/fact IDs, so expected-fact retrieval is scored without titles.
      const policy = result.modelObservation?.policyEvidence || [];
      return (result.data || []).map((row, index) => ({ ...row, policyMetadata: {
        topic: policy[index]?.metadata?.topic || null,
        facts: policy[index]?.metadata?.facts || [],
      } }));
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
module.exports = { TARGETS, scoreAnswer, summarize, evaluate, parseArgs, run, expectedIdentity, expectedFactRanks, splitExpectedFacts, readDynamicExpectedFacts };
