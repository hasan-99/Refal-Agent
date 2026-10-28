#!/usr/bin/env node
"use strict";

// Reranker latency/quality benchmark over the 87-case regression set.
//
// For every case:
//   1. production   the current production path, live (reranker off, v1 window)
//   2. window       one live search with the v2 candidate window, reranker
//                   scoring skipped; every store call and its rows are recorded
//   3. each config  the REAL search tool and the REAL cross-encoder, fed the
//                   recorded rows (identical candidates for every config).
//                   End-to-end latency = replayed local work + the live DB
//                   time recorded in step 2.
//   4. cache        (optional, --cache) the chosen config twice with the search
//                   and rerank caches on: first call cold, second warm.
// Configs run interleaved per case so CPU drift hits all of them equally.
// Read-only: search is a POST that only reads approved knowledge.
//
//   node --env-file=.env scripts/benchmarkRetrievalLatency.js --out <dir>
//     [--local-models <dir>] [--configs 20:8000,24:8000,30:8000,24:12000,30:12000]
//     [--window 40] [--cache 24:8000] [--limit N]

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { RETRIEVAL_REGRESSION_SET } = require("../src/retrievalRegressionSet");
const { evidenceOrder, bestRank } = require("./evaluateSemanticRetrieval");

function parseArgs(argv) {
  const args = { out: null, localModels: null, configs: "20:8000,24:8000,30:8000,24:12000,30:12000", window: 40, cache: null, limit: Infinity };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out") args.out = path.resolve(argv[++i]);
    else if (argv[i] === "--local-models") args.localModels = argv[++i];
    else if (argv[i] === "--configs") args.configs = argv[++i];
    else if (argv[i] === "--window") args.window = Number(argv[++i]);
    else if (argv[i] === "--cache") args.cache = argv[++i];
    else if (argv[i] === "--limit") args.limit = Number(argv[++i]);
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!args.out) throw new Error("--out is required");
  return args;
}

const parseConfig = (text) => { const [pool, timeout] = text.split(":").map(Number); return { name: `P${pool}/T${timeout}`, pool, timeout }; };

function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

function stats(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return { avg: Math.round(sorted.reduce((s, v) => s + v, 0) / sorted.length), p50: percentile(sorted, 0.5), p90: percentile(sorted, 0.9), p95: percentile(sorted, 0.95), max: sorted.at(-1) };
}

function quality(rows, key) {
  const ranks = rows.map((r) => r[key]?.rank ?? null);
  const within = (n) => ranks.filter((k) => k !== null && k <= n).length;
  return { top1: within(1), top3: within(3), top5: within(5), top16: within(16), missing: ranks.filter((k) => k === null).length,
    mrr: Number((ranks.reduce((s, k) => s + (k ? 1 / k : 0), 0) / rows.length).toFixed(3)) };
}

function callKey(query, embedding, matchCount, options) {
  const fingerprint = Array.isArray(embedding) ? embedding.slice(0, 8).map((v) => Number(v).toFixed(5)).join(",") : null;
  return JSON.stringify([query, fingerprint, matchCount, options?.candidateCount ?? null]);
}

async function run(argv) {
  const args = parseArgs(argv);
  fs.mkdirSync(args.out, { recursive: true });
  if (args.localModels) {
    const { env } = await import(pathToFileURL(require.resolve("@huggingface/transformers")).href.replace(/transformers\.node\.cjs$/u, "transformers.node.mjs"));
    env.allowRemoteModels = false;
    env.localModelPath = args.localModels;
  }
  const { createStore } = require("../src/supabaseStore");
  const { embedText, DEFAULT_EMBEDDING_MODEL } = require("../src/ai");
  const { searchApprovedKnowledge } = require("../src/agentTools");
  const { createKnowledgeReranker } = require("../src/knowledgeRerank");
  const { createRetrievalCache, latencyFlags } = require("../src/knowledgeCache");
  const store = createStore();
  const configs = args.configs.split(",").filter(Boolean).map(parseConfig);
  const baseEnv = { ...process.env, RAFA_KNOWLEDGE_RERANK: "on", RAFA_KNOWLEDGE_RERANK_CANDIDATES: String(args.window), RAFA_RERANK_CACHE: "off" };
  const rerankers = Object.fromEntries(configs.map((c) => [c.name, createKnowledgeReranker({ ...baseEnv,
    RAFA_KNOWLEDGE_RERANK_POOL: String(c.pool), RAFA_KNOWLEDGE_RERANK_TIMEOUT_MS: String(c.timeout) })]));
  const windowOnly = { config: { candidateCount: args.window }, rerank: async (_q, sections) => ({ sections, status: "skipped", durationMs: 0, poolSize: 0 }) };

  const loadStarted = Date.now();
  const first = Object.values(rerankers)[0];
  await first.warm();
  await first.rerank("warm up question", [{ title: "a", content: "warm up passage one" }, { title: "b", content: "warm up passage two" }]);
  console.log(`reranker loaded+warmed in ${Date.now() - loadStarted} ms; threads ${first.config.threads}; configs ${configs.map((c) => c.name).join(", ")}`);

  const baseContext = (c) => ({ embedText, embeddingModel: DEFAULT_EMBEDDING_MODEL, matchCount: 16, language: c.lang === "ar" ? "arabic" : "english",
    currentMessage: c.query, user: { history: [] }, intents: [] });
  const cases = RETRIEVAL_REGRESSION_SET.slice(0, args.limit);
  const results = [];
  for (const c of cases) {
    const row = { id: c.id, group: c.group, lang: c.lang, expected: c.expected };
    let started = performance.now();
    const production = await searchApprovedKnowledge({ query: c.query }, { ...baseContext(c), store, knowledgeReranker: null });
    row.production = { rank: bestRank(evidenceOrder(production), c.expected), ms: Math.round(performance.now() - started), status: production.status };

    const recorded = new Map();
    const recordingStore = { searchKnowledge: async (query, embedding, model, matchCount, options) => {
      const callStarted = performance.now();
      const rows = await store.searchKnowledge(query, embedding, model, matchCount, options);
      recorded.set(callKey(query, embedding, matchCount, options), { rows, ms: performance.now() - callStarted });
      return rows;
    } };
    started = performance.now();
    const windowResult = await searchApprovedKnowledge({ query: c.query }, { ...baseContext(c), store: recordingStore, knowledgeReranker: windowOnly });
    const liveDbMs = Number(windowResult.trace?.timing?.searchMs) || 0;
    row.window = { rank: bestRank(evidenceOrder(windowResult), c.expected), ms: Math.round(performance.now() - started), dbMs: liveDbMs, calls: recorded.size };

    let replayMisses = 0;
    const replayStore = { searchKnowledge: async (query, embedding, model, matchCount, options) => {
      const hit = recorded.get(callKey(query, embedding, matchCount, options));
      if (hit) return structuredClone(hit.rows);
      replayMisses += 1;
      return store.searchKnowledge(query, embedding, model, matchCount, options);
    } };
    for (const config of configs) {
      started = performance.now();
      const result = await searchApprovedKnowledge({ query: c.query }, { ...baseContext(c), store: replayStore, knowledgeReranker: rerankers[config.name] });
      const localMs = performance.now() - started - (Number(result.trace?.timing?.searchMs) || 0);
      row[config.name] = { rank: bestRank(evidenceOrder(result), c.expected), ms: Math.round(localMs + liveDbMs),
        rerankMs: result.trace?.rerank?.durationMs ?? null, rerankStatus: result.trace?.rerank?.status || "none", poolSize: result.trace?.rerank?.poolSize ?? null };
    }
    row.replayMisses = replayMisses;

    if (args.cache) {
      const config = parseConfig(args.cache);
      const flags = latencyFlags({ RAFA_SEARCH_CACHE: "on" });
      const versionStore = Object.assign(Object.create(store), { getKnowledgeVersion: async () => "benchmark-fixed-version" });
      const cache = createRetrievalCache(versionStore, flags);
      const reranker = createKnowledgeReranker({ ...baseEnv, RAFA_RERANK_CACHE: "on", RAFA_KNOWLEDGE_RERANK_POOL: String(config.pool), RAFA_KNOWLEDGE_RERANK_TIMEOUT_MS: String(config.timeout) });
      for (const pass of ["cold", "warm"]) {
        started = performance.now();
        const result = await searchApprovedKnowledge({ query: c.query }, { ...baseContext(c), store: versionStore, knowledgeReranker: reranker, retrievalCache: cache });
        row[`cache_${pass}`] = { rank: bestRank(evidenceOrder(result), c.expected), ms: Math.round(performance.now() - started),
          searchHits: result.trace?.cache?.search?.hits ?? null, searchMisses: result.trace?.cache?.search?.misses ?? null,
          rerankCache: result.trace?.rerank?.cache || null, rerankStatus: result.trace?.rerank?.status || null };
      }
    }
    results.push(row);
    const cell = (k) => `${String(row[k]?.rank ?? "-").padStart(2)}${row[k]?.rerankStatus && row[k].rerankStatus !== "reranked" ? "!" : " "}`;
    console.log(`${c.id.padEnd(5)} prod ${cell("production")} win ${cell("window")} | ${configs.map((cfg) => `${cfg.name} ${cell(cfg.name)} ${String(row[cfg.name].ms).padStart(5)}ms`).join(" | ")}${args.cache ? ` | cache ${row.cache_cold.ms}->${row.cache_warm.ms}ms` : ""}`);
  }

  const keys = ["production", "window", ...configs.map((c) => c.name), ...(args.cache ? ["cache_cold", "cache_warm"] : [])];
  const summary = {};
  for (const key of keys) {
    const statuses = results.reduce((acc, r) => { const s = r[key]?.rerankStatus; if (s) acc[s] = (acc[s] || 0) + 1; return acc; }, {});
    const guarantee = results.filter((r) => r.group === "guarantee").map((r) => ({ id: r.id, rank: r[key]?.rank ?? null }));
    const regressions = key === "production" ? [] : results.filter((r) => (r.production.rank ?? 99) <= 5 && (r[key]?.rank ?? 99) > 5)
      .map((r) => `${r.id} ${r.production.rank}->${r[key]?.rank ?? "-"}`);
    const worse = key === "production" ? 0 : results.filter((r) => (r[key]?.rank ?? 99) > (r.production.rank ?? 99)).length;
    summary[key] = { ...quality(results, key), latencyMs: stats(results.map((r) => r[key]?.ms)), rerankMs: stats(results.map((r) => r[key]?.rerankMs)),
      timeouts: statuses.timeout || 0, fallbacks: (statuses.timeout || 0) + (statuses.error || 0), statuses,
      guaranteeWithin5: guarantee.filter((g) => g.rank !== null && g.rank <= 5).length, guaranteeCases: guarantee.length,
      guaranteeFailures: guarantee.filter((g) => g.rank === null || g.rank > 5).map((g) => `${g.id}=${g.rank ?? "-"}`),
      regressionsVsProduction: regressions, rankWorseThanProduction: worse };
  }
  const report = { generatedAt: new Date().toISOString(), cases: results.length, window: args.window, configs, cache: args.cache,
    replayMisses: results.reduce((s, r) => s + r.replayMisses, 0), summary, results };
  fs.writeFileSync(path.join(args.out, "retrieval_latency_report.json"), JSON.stringify(report, null, 2), "utf8");
  console.log("\nconfig        top1 top3 top5 top16  MRR   avg   p50   p90   p95  timeouts fallbacks guarantee<=5 regressions");
  for (const key of keys) {
    const s = summary[key];
    console.log(`${key.padEnd(12)} ${[s.top1, s.top3, s.top5, s.top16].map((v) => String(v).padStart(4)).join(" ")} ${s.mrr.toFixed(3)} ${["avg", "p50", "p90", "p95"].map((p) => String(s.latencyMs?.[p] ?? "-").padStart(5)).join(" ")} ${String(s.timeouts).padStart(8)} ${String(s.fallbacks).padStart(9)} ${String(`${s.guaranteeWithin5}/${s.guaranteeCases}`).padStart(12)} ${s.regressionsVsProduction.length}`);
  }
  return 0;
}

if (require.main === module) {
  run(process.argv.slice(2)).then((code) => { process.exitCode = code; })
    .catch((error) => { console.error(`benchmark failed: ${error.stack || error.message}`); process.exitCode = 1; });
}

module.exports = { run, stats, quality };
