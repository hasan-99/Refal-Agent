#!/usr/bin/env node
"use strict";

// Live semantic-retrieval regression check for the approved RAG package.
//
// Runs the REAL agent search tool (src/agentTools.js searchApprovedKnowledge)
// against the deployed /knowledge/search endpoint for every case in
// src/retrievalRegressionSet.js, twice: with the cross-encoder reranker off
// (the current production path) and on. Read-only: search is a POST that only
// reads approved knowledge.
//
// The agent normally passes a model-resolved query; here the customer's raw
// message is both the query and the current message, which is the hardest
// case for retrieval (no model normalisation of dialect or spelling).
//
//   node --env-file=.env scripts/evaluateSemanticRetrieval.js --out <dir>
//     [--local-models <dir>]   load e5 + reranker from a local folder (no hub access)
//     [--only reranked|baseline]
//     [--gate guarantee:5,refund:16]   fail when a group's case ranks worse than N (reranked run)

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { RETRIEVAL_REGRESSION_SET } = require("../src/retrievalRegressionSet");

function parseArgs(argv) {
  const args = { out: null, localModels: null, only: null, gate: "guarantee:5" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out") args.out = path.resolve(argv[++i]);
    else if (argv[i] === "--local-models") args.localModels = argv[++i];
    else if (argv[i] === "--only") args.only = argv[++i];
    else if (argv[i] === "--gate") args.gate = argv[++i];
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!args.out) throw new Error("--out is required");
  return args;
}

const PACKAGE_PREFIX = "manual:refal-rag-package:";
function chunkTag(row) {
  const url = String(row?.source_url || row?.canonical_url || "");
  return url.startsWith(PACKAGE_PREFIX) ? url.slice(PACKAGE_PREFIX.length) : null;
}

/** Ordered distinct chunk ids exactly as handed to the model. */
function evidenceOrder(result) {
  const tags = [];
  for (const row of Array.isArray(result?.data) ? result.data : []) {
    const tag = chunkTag(row);
    if (tag && !tags.includes(tag)) tags.push(tag);
  }
  return tags;
}

function bestRank(order, wanted) {
  let best = null;
  for (const id of wanted || []) {
    const i = order.indexOf(id);
    if (i >= 0 && (best === null || i + 1 < best)) best = i + 1;
  }
  return best;
}

function summarise(rows, key) {
  const ranks = rows.map((r) => r[key]?.rank ?? null);
  const within = (n) => ranks.filter((k) => k !== null && k <= n).length;
  return { cases: rows.length, top3: within(3), top5: within(5), top16: within(16), missing: ranks.filter((k) => k === null).length,
    mrr: Number((ranks.reduce((s, k) => s + (k ? 1 / k : 0), 0) / rows.length).toFixed(3)) };
}

async function run(argv) {
  const args = parseArgs(argv);
  fs.mkdirSync(args.out, { recursive: true });
  if (args.localModels) {
    // Same module instance src/ai.js and src/knowledgeRerank.js import.
    const { env } = await import(pathToFileURL(require.resolve("@huggingface/transformers")).href.replace(/transformers\.node\.cjs$/u, "transformers.node.mjs"));
    env.allowRemoteModels = false;
    env.localModelPath = args.localModels;
  }
  const { createStore } = require("../src/supabaseStore");
  const { embedText, DEFAULT_EMBEDDING_MODEL } = require("../src/ai");
  const { searchApprovedKnowledge } = require("../src/agentTools");
  const { createKnowledgeReranker } = require("../src/knowledgeRerank");
  const store = createStore();
  const reranker = createKnowledgeReranker({ ...process.env, RAFA_KNOWLEDGE_RERANK: "on" });
  const runs = args.only ? [args.only] : ["baseline", "reranked"];
  if (runs.includes("reranked")) {
    const started = Date.now();
    await reranker.warm();
    console.log(`reranker loaded in ${Date.now() - started} ms (pool ${reranker.config.poolSize}, threads ${reranker.config.threads})`);
  }

  const results = [];
  for (const c of RETRIEVAL_REGRESSION_SET) {
    const row = { id: c.id, group: c.group, lang: c.lang, query: c.query, expected: c.expected, primary: c.primary };
    for (const mode of runs) {
      const started = Date.now();
      const result = await searchApprovedKnowledge({ query: c.query }, {
        store, embedText, embeddingModel: DEFAULT_EMBEDDING_MODEL, matchCount: 16, language: c.lang === "ar" ? "arabic" : "english",
        currentMessage: c.query, user: { history: [] }, intents: [], knowledgeReranker: mode === "reranked" ? reranker : null
      });
      const order = evidenceOrder(result);
      row[mode] = { rank: bestRank(order, c.expected), primaryRank: c.primary ? bestRank(order, [c.primary]) : null,
        top3: order.slice(0, 3), returned: order.length, status: result?.status, ms: Date.now() - started,
        intent: result?.trace?.supportIntent ?? null, rerank: result?.trace?.rerank ?? null };
    }
    results.push(row);
    const fmt = (m) => (row[m] ? String(row[m].rank ?? "-").padStart(3) : "  .");
    console.log(`${c.id.padEnd(5)} ${fmt("baseline")} -> ${fmt("reranked")}  ${row.reranked?.intent ? `[${row.reranked.intent}] ` : ""}${c.query}`);
  }

  const summary = Object.fromEntries(runs.map((m) => [m, summarise(results, m)]));
  const groups = [...new Set(results.map((r) => r.group))];
  const byGroup = Object.fromEntries(groups.map((g) => [g, Object.fromEntries(runs.map((m) => [m, summarise(results.filter((r) => r.group === g), m)]))]));
  const regressions = runs.length === 2 ? results.filter((r) => (r.baseline.rank ?? 99) <= 5 && (r.reranked.rank ?? 99) > 5)
    .map((r) => ({ id: r.id, query: r.query, before: r.baseline.rank, after: r.reranked.rank })) : [];
  const rerankTimes = results.map((r) => r.reranked?.rerank?.durationMs).filter(Number.isFinite).sort((a, b) => a - b);
  const latency = rerankTimes.length ? { p50: rerankTimes[Math.floor(rerankTimes.length / 2)], p90: rerankTimes[Math.floor(rerankTimes.length * 0.9)], max: rerankTimes.at(-1),
    statuses: results.reduce((acc, r) => { const s = r.reranked?.rerank?.status || "none"; acc[s] = (acc[s] || 0) + 1; return acc; }, {}) } : null;
  const gateFailures = [];
  if (runs.includes("reranked")) {
    for (const rule of String(args.gate || "").split(",").filter(Boolean)) {
      const [group, limit] = rule.split(":");
      for (const r of results.filter((x) => x.group === group)) {
        if ((r.reranked.rank ?? 99) > Number(limit)) gateFailures.push({ id: r.id, group, rank: r.reranked.rank, limit: Number(limit), query: r.query });
      }
    }
  }
  const report = { generatedAt: new Date().toISOString(), cases: results.length, summary, byGroup, regressions, latency, gate: args.gate, gateFailures, results };
  fs.writeFileSync(path.join(args.out, "semantic_retrieval_report.json"), JSON.stringify(report, null, 2), "utf8");
  console.log(`\nsummary ${JSON.stringify(summary)}`);
  console.log(`rerank latency ${JSON.stringify(latency)}`);
  console.log(`regressions (top5 -> worse) ${regressions.length}: ${regressions.map((r) => `${r.id} ${r.before}->${r.after ?? "-"}`).join(", ") || "none"}`);
  console.log(`gate ${args.gate}: ${gateFailures.length ? `FAIL ${gateFailures.map((g) => `${g.id}=${g.rank ?? "-"}`).join(", ")}` : "PASS"}`);
  return gateFailures.length ? 1 : 0;
}

if (require.main === module) {
  run(process.argv.slice(2)).then((code) => { process.exitCode = code; })
    .catch((error) => { console.error(`evaluation failed: ${error.message}`); process.exitCode = 1; });
}

module.exports = { run, evidenceOrder, bestRank, summarise };
