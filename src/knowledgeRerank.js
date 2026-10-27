"use strict";

// Cross-encoder reranking for approved-knowledge retrieval.
//
// First-stage search (rafa_hybrid_search_knowledge: lexical + e5-small
// semantic, RRF) is good at recall but ranks by compressed cosine scores and
// exact tokens, so a question phrased in another dialect can leave the right
// section at rank 20+. A cross-encoder reads the customer's question and each
// candidate section TOGETHER and scores how well the section answers it, which
// is what decides the final order here.
//
// Model: BAAI bge-reranker-v2-m3 (Apache-2.0, multilingual incl. Arabic and
// cross-lingual pairs), ONNX int8 export, pinned revision. It runs locally in
// the worker process like the e5 embedding model; no customer text leaves the
// machine for reranking.
//
// Off unless RAFA_KNOWLEDGE_RERANK=on. When it is off, fails to load, errors or
// runs past its deadline, retrieval keeps the existing first-stage order, so
// enabling it can only change ordering, never availability.
//
//   RAFA_KNOWLEDGE_RERANK=on                 enable
//   RAFA_KNOWLEDGE_RERANK_POOL=24            sections scored per search (4..50)
//   RAFA_KNOWLEDGE_RERANK_TIMEOUT_MS=8000    scoring deadline per search
//   RAFA_KNOWLEDGE_RERANK_THREADS=4          onnxruntime intra-op threads

const RERANK_MODEL_ID = "onnx-community/bge-reranker-v2-m3-ONNX";
const RERANK_MODEL_REVISION = "6f5ff65298512715a1e669753bc754d2bc8f367b";
const BATCH_SIZE = 8;
const MAX_PASSAGE_CHARS = 2000;
const MAX_QUESTION_CHARS = 1000;

function rerankConfig(env = process.env) {
  const enabled = String(env.RAFA_KNOWLEDGE_RERANK || "").trim().toLowerCase() === "on";
  const bounded = (value, fallback, min, max) => {
    const n = Number.parseInt(value, 10);
    return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  return {
    enabled,
    poolSize: bounded(env.RAFA_KNOWLEDGE_RERANK_POOL, 24, 4, 50),
    timeoutMs: bounded(env.RAFA_KNOWLEDGE_RERANK_TIMEOUT_MS, 8000, 500, 30000),
    threads: bounded(env.RAFA_KNOWLEDGE_RERANK_THREADS, 4, 1, 32)
  };
}

let rerankerPromise;

async function loadReranker({ threads = rerankConfig().threads } = {}) {
  if (!rerankerPromise) {
    rerankerPromise = (async () => {
      const path = require("node:path");
      const os = require("node:os");
      const { env, AutoTokenizer, AutoModelForSequenceClassification } = await import("@huggingface/transformers");
      env.cacheDir = path.join(os.homedir(), ".cache", "rafa", "transformers");
      const options = { revision: RERANK_MODEL_REVISION };
      const tokenizer = await AutoTokenizer.from_pretrained(RERANK_MODEL_ID, options);
      const model = await AutoModelForSequenceClassification.from_pretrained(RERANK_MODEL_ID, {
        ...options, dtype: "q8", session_options: { intraOpNumThreads: threads, interOpNumThreads: 1 }
      });
      return { tokenizer, model };
    })().catch((error) => {
      rerankerPromise = undefined;
      throw error;
    });
  }
  return rerankerPromise;
}

/**
 * Scores (question, passage) pairs with the cross-encoder. Higher = more
 * relevant. Stops between batches once `deadline` (epoch ms) has passed and
 * throws, so a slow machine degrades to the first-stage order instead of
 * holding the customer's reply.
 */
async function scorePassages(question, passages, { deadline = Infinity, loader = loadReranker } = {}) {
  const { tokenizer, model } = await loader();
  const scores = [];
  for (let i = 0; i < passages.length; i += BATCH_SIZE) {
    if (Date.now() > deadline) throw Object.assign(new Error("rerank deadline exceeded"), { code: "RERANK_TIMEOUT" });
    const batch = passages.slice(i, i + BATCH_SIZE);
    const inputs = tokenizer(new Array(batch.length).fill(question), { text_pair: batch, padding: true, truncation: true, max_length: 512 });
    const { logits } = await model(inputs);
    scores.push(...Array.from(logits.data, Number));
  }
  return scores;
}

/**
 * The text the cross-encoder compares every candidate with: the customer's own
 * message, plus the model-resolved standalone query when it adds context (a
 * follow-up like "and how long?" only makes sense with the resolved topic).
 */
function rerankQuestion(currentMessage, resolvedQuery) {
  const current = String(currentMessage || "").trim();
  const resolved = String(resolvedQuery || "").trim();
  const parts = [current];
  if (resolved && !current.includes(resolved)) parts.push(resolved);
  return parts.filter(Boolean).join("\n").slice(0, MAX_QUESTION_CHARS);
}

/**
 * Pure ordering step: the first `poolSize` items are re-ordered by score
 * (stable for ties), the rest keep their first-stage order after them.
 * @returns {{ items: any[], scores: (number|null)[] }}
 */
function orderByScores(items, scores, poolSize) {
  const pool = items.slice(0, poolSize).map((item, index) => ({ item, index, score: scores[index] }));
  if (pool.some((entry) => !Number.isFinite(entry.score))) throw new Error("reranker returned a non-numeric score");
  pool.sort((a, b) => b.score - a.score || a.index - b.index);
  return {
    items: [...pool.map((entry) => entry.item), ...items.slice(poolSize)],
    scores: [...pool.map((entry) => entry.score), ...items.slice(poolSize).map(() => null)]
  };
}

/**
 * Reranks catalogue sections against the customer's question.
 * Never throws: any failure returns the input order with a status.
 * @param {{ title?: string, section?: string, content: string }[]} sections first-stage order
 * @returns {Promise<{ sections: any[], status: "reranked"|"timeout"|"error"|"skipped", durationMs: number, poolSize: number, scores: (number|null)[] }>}
 */
async function rerankSections(question, sections, { poolSize = 24, timeoutMs = 8000, scorer = scorePassages, now = Date.now } = {}) {
  const started = now();
  const list = Array.isArray(sections) ? sections : [];
  const size = Math.min(poolSize, list.length);
  if (!String(question || "").trim() || size < 2) {
    return { sections: list, status: "skipped", durationMs: 0, poolSize: size, scores: [] };
  }
  const passages = list.slice(0, size).map((s) => [s.title, s.section && s.section !== s.title ? s.section : null, s.content]
    .filter(Boolean).join("\n").slice(0, MAX_PASSAGE_CHARS));
  try {
    const scores = await scorer(String(question), passages, { deadline: started + timeoutMs });
    if (!Array.isArray(scores) || scores.length !== size) throw new Error("reranker returned the wrong number of scores");
    const ordered = orderByScores(list, scores, size);
    return { sections: ordered.items, status: "reranked", durationMs: now() - started, poolSize: size, scores: ordered.scores };
  } catch (error) {
    return { sections: list, status: error?.code === "RERANK_TIMEOUT" ? "timeout" : "error", durationMs: now() - started, poolSize: size, scores: [],
      error: String(error?.message || error).slice(0, 200) };
  }
}

/**
 * Tool-context dependency. Returns null when reranking is disabled, so callers
 * can keep the existing path with a single truthiness check.
 */
function createKnowledgeReranker(env = process.env) {
  const config = rerankConfig(env);
  if (!config.enabled) return null;
  const loader = () => loadReranker({ threads: config.threads });
  return {
    config,
    warm: () => loader(),
    rerank: (question, sections) => rerankSections(question, sections, {
      poolSize: config.poolSize, timeoutMs: config.timeoutMs,
      scorer: (q, passages, options) => scorePassages(q, passages, { ...options, loader })
    })
  };
}

let processReranker;
/** One reranker per process, configured from the environment at first use. */
function getKnowledgeReranker() {
  if (processReranker === undefined) processReranker = createKnowledgeReranker(process.env);
  return processReranker;
}

module.exports = {
  getKnowledgeReranker,
  RERANK_MODEL_ID,
  RERANK_MODEL_REVISION,
  rerankConfig,
  rerankQuestion,
  orderByScores,
  rerankSections,
  scorePassages,
  createKnowledgeReranker
};
