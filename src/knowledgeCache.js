"use strict";

// Short-lived caches for approved-knowledge retrieval. Every cache here is an
// optimisation only: a miss, an error, or a missing version stamp always falls
// through to the normal search, so caching can never become the reason a reply
// fails or the reason stale knowledge is served.
//
// Correctness rests on the knowledge version stamp, not on TTLs alone. The
// stamp is a fingerprint of every knowledge source, document revision, chunk
// and fact-register row that the search RPC reads (approval, enabled flag,
// review status, valid_until, content hashes). Any approval, import,
// supersede, disable or edit changes it, and every cached entry is keyed by
// the stamp it was read under, so old entries simply stop matching.
//
//   RAFA_SEARCH_CACHE=on                       cache search rows per query
//   RAFA_SEARCH_CACHE_TTL_MS=600000            general knowledge (10 min)
//   RAFA_SEARCH_CACHE_DATED_TTL_MS=120000      rows carrying valid_until, e.g. prices (2 min)
//   RAFA_KNOWLEDGE_VERSION_MAX_AGE_MS=5000     how long one version read is trusted
//   RAFA_SESSION_EVIDENCE_CACHE=on             reuse the previous turn's approved evidence
//   RAFA_SESSION_EVIDENCE_TTL_MS=600000        (10 min from the original retrieval)
//   RAFA_RERANK_CACHE=on                       cache cross-encoder orderings
//   RAFA_RERANK_CACHE_TTL_MS=600000
//   RAFA_FAST_SOCIAL_PATH=on                   deterministic preflight for obvious greetings/thanks/bye
//   RAFA_FACTUAL_SEARCH_FIRST=on               search before the first draft on company-fact turns

const { createHash } = require("node:crypto");

function flagOn(value) {
  return String(value || "").trim().toLowerCase() === "on";
}

function boundedInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function latencyFlags(env = process.env) {
  return {
    searchCache: flagOn(env.RAFA_SEARCH_CACHE),
    sessionEvidenceCache: flagOn(env.RAFA_SESSION_EVIDENCE_CACHE),
    fastSocialPath: flagOn(env.RAFA_FAST_SOCIAL_PATH),
    factualSearchFirst: flagOn(env.RAFA_FACTUAL_SEARCH_FIRST),
    rerankCache: flagOn(env.RAFA_RERANK_CACHE),
    searchCacheTtlMs: boundedInt(env.RAFA_SEARCH_CACHE_TTL_MS, 600_000, 10_000, 900_000),
    searchCacheDatedTtlMs: boundedInt(env.RAFA_SEARCH_CACHE_DATED_TTL_MS, 120_000, 0, 300_000),
    versionMaxAgeMs: boundedInt(env.RAFA_KNOWLEDGE_VERSION_MAX_AGE_MS, 5_000, 0, 30_000),
    sessionEvidenceTtlMs: boundedInt(env.RAFA_SESSION_EVIDENCE_TTL_MS, 600_000, 30_000, 900_000),
    rerankCacheTtlMs: boundedInt(env.RAFA_RERANK_CACHE_TTL_MS, 600_000, 10_000, 900_000)
  };
}

/**
 * Cache-key form of a search query. Only changes that cannot alter meaning:
 * Unicode compatibility forms (NFKC), Arabic tatweel (a purely visual
 * elongation), whitespace runs, and letter case (Latin/Greek only; Arabic has
 * none). Hamza, alef, ya and ta-marbuta forms are deliberately NOT folded.
 */
function normalizeCacheQuery(text) {
  return String(text || "").normalize("NFKC").replace(/ـ/gu, "")
    .replace(/\s+/gu, " ").trim().toLocaleLowerCase();
}

function hashKey(parts) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/** Bounded LRU map with a per-entry absolute expiry. */
function createTtlCache({ maxEntries = 300, now = Date.now } = {}) {
  const entries = new Map();
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) { entries.delete(key); return undefined; }
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },
    set(key, value, ttlMs) {
      if (!(ttlMs > 0)) return;
      entries.delete(key);
      entries.set(key, { value, expiresAt: now() + ttlMs });
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    },
    delete(key) { entries.delete(key); },
    clear() { entries.clear(); },
    get size() { return entries.size; }
  };
}

function rowValidUntil(row) {
  const value = row?.valid_until ?? row?.validUntil ?? row?.policyMetadata?.validUntil;
  if (value == null || !String(value).trim()) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : -Infinity;
}

/**
 * Reads the knowledge version stamp through the store. Trusts one read for
 * `maxAgeMs` (default 5 s, the same window as the company-identity setting
 * cache), so a knowledge change is visible to the cache within that bound.
 * Returns null whenever the stamp is unavailable; callers then skip caching.
 */
function createKnowledgeVersionReader(store, { maxAgeMs = 5_000, failureBackoffMs = 30_000, now = Date.now } = {}) {
  // A failed read (route not deployed, timeout) is remembered as "no stamp"
  // for failureBackoffMs, so a missing route costs one request per window
  // instead of one per search. Without a stamp nothing is cached.
  let state = null;
  let pending = null;
  return {
    async read() {
      if (typeof store?.getKnowledgeVersion !== "function") return null;
      if (state && now() - state.at < (state.value ? maxAgeMs : failureBackoffMs)) return state.value;
      if (!pending) {
        const startedAt = now();
        pending = Promise.resolve().then(() => store.getKnowledgeVersion()).then((version) => {
          const valid = typeof version === "string" && /^[A-Za-z0-9:_-]{8,128}$/u.test(version) ? version : null;
          state = { value: valid, at: startedAt };
          return valid;
        }).catch(() => { state = { value: null, at: startedAt }; return null; })
          .finally(() => { pending = null; });
      }
      return pending;
    },
    invalidate() { state = null; }
  };
}

/**
 * Search-row cache, one entry per (version, normalized query, retrieval
 * options). Stores the rows exactly as the store returned them; every
 * approval/expiry/finding-aid filter downstream still runs on a hit.
 * An entry never outlives the earliest valid_until among its rows, and rows
 * that carry a valid_until (price text, dated facts) use the shorter dated TTL.
 */
function createKnowledgeSearchCache({ ttlMs = 600_000, datedTtlMs = 120_000, maxEntries = 300, now = Date.now } = {}) {
  const cache = createTtlCache({ maxEntries, now });
  const keyFor = ({ version, query, embeddingModel, hasEmbedding, matchCount, candidateCount }) => hashKey([
    "search:v1", version, normalizeCacheQuery(query), embeddingModel || null, hasEmbedding === true,
    Number.isInteger(matchCount) ? matchCount : null, Number.isInteger(candidateCount) ? candidateCount : null
  ]);
  return {
    keyFor,
    get(params) {
      if (!params?.version) return undefined;
      const entry = cache.get(keyFor(params));
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) { cache.delete(keyFor(params)); return undefined; }
      return structuredClone(entry.rows);
    },
    set(params, rows) {
      if (!params?.version || !Array.isArray(rows)) return;
      const expiries = rows.map(rowValidUntil).filter((at) => at !== null);
      if (expiries.some((at) => at <= now())) return;
      const ttl = Math.min(expiries.length ? datedTtlMs : ttlMs, ...expiries.map((at) => at - now()));
      if (!(ttl > 0)) return;
      cache.set(keyFor(params), { rows: structuredClone(rows), expiresAt: now() + ttl }, ttl);
    },
    clear() { cache.clear(); },
    get size() { return cache.size; }
  };
}

/**
 * Exact-text embedding memo. Embeddings depend only on the text and the
 * pinned local model, never on knowledge state, so no version is needed.
 */
function createEmbeddingMemo(embedText, { ttlMs = 1_800_000, maxEntries = 500, now = Date.now } = {}) {
  const cache = createTtlCache({ maxEntries, now });
  const stats = { hits: 0, misses: 0 };
  const memo = async (text) => {
    const key = hashKey(["embed:v1", String(text)]);
    const hit = cache.get(key);
    if (hit) { stats.hits += 1; return hit; }
    stats.misses += 1;
    const value = await embedText(text);
    if (Array.isArray(value) && value.length) cache.set(key, value, ttlMs);
    return value;
  };
  memo.stats = stats;
  return memo;
}

/** Search cache + version reader + embedding memo bound to one store. */
function createRetrievalCache(store, flags = latencyFlags(), { now = Date.now } = {}) {
  const embedMemos = new WeakMap();
  return {
    search: createKnowledgeSearchCache({ ttlMs: flags.searchCacheTtlMs, datedTtlMs: flags.searchCacheDatedTtlMs, now }),
    version: now === Date.now ? getKnowledgeVersionReader(store, flags) : createKnowledgeVersionReader(store, { maxAgeMs: flags.versionMaxAgeMs, now }),
    embedFor(embedText) {
      if (!embedMemos.has(embedText)) embedMemos.set(embedText, createEmbeddingMemo(embedText, { now }));
      return embedMemos.get(embedText);
    }
  };
}

const processVersionReaders = new WeakMap();
/** One version reader per store, shared by the search and session caches. */
function getKnowledgeVersionReader(store, flags = latencyFlags()) {
  if (!store || typeof store !== "object") return null;
  if (!processVersionReaders.has(store)) processVersionReaders.set(store, createKnowledgeVersionReader(store, { maxAgeMs: flags.versionMaxAgeMs }));
  return processVersionReaders.get(store);
}

const processRetrievalCaches = new WeakMap();
/** Process-wide cache per store; null unless RAFA_SEARCH_CACHE=on. */
function getRetrievalCache(store, env = process.env) {
  const flags = latencyFlags(env);
  if (!flags.searchCache || !store || typeof store !== "object") return null;
  if (!processRetrievalCaches.has(store)) processRetrievalCaches.set(store, createRetrievalCache(store, flags));
  return processRetrievalCaches.get(store);
}

module.exports = {
  createRetrievalCache,
  getKnowledgeVersionReader,
  getRetrievalCache,
  createEmbeddingMemo,
  createKnowledgeSearchCache,
  createKnowledgeVersionReader,
  createTtlCache,
  hashKey,
  latencyFlags,
  normalizeCacheQuery,
  rowValidUntil
};
