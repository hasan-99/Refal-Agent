"use strict";

// RAG package import PLAN — turns a finalized knowledge package (JSONL, one
// chunk per line) into the rows the existing knowledge store expects.
//
// Pure, like src/corpusIngest.js: no file, network or clock access. The thin
// I/O shell is scripts/importRagPackage.js.
//
// MAPPING ONTO THE EXISTING SCHEMA (no schema change)
// --------------------------------------------------
// One package chunk = one `rafa_knowledge_sources` row keyed on
// canonical_url `manual:refal-rag-package:<chunk_id>`, with ONE approved
// `rafa_knowledge_documents` revision holding ONE `rafa_knowledge_chunks` row.
// That is the dashboard's own "one entry per source" model, so every imported
// chunk is listed, editable and disableable in the Knowledge library.
//
// Uniqueness is enforced by the database, not by this file:
//   - canonical_url is UNIQUE, so a chunk_id can only ever have one source;
//   - rafa_knowledge_documents_one_approved_per_source_idx allows at most one
//     approved (= retrievable) revision per source.
//
// Idempotency comes from `rafa_store_knowledge_revision`, which already
// deduplicates on (source_id, content_sha256): the package's content_hash is
// passed as p_content_sha256, so same chunk_id + same hash is a no-op and a
// changed hash becomes a new revision that supersedes the old one through the
// approval lifecycle trigger. The planner additionally skips unchanged chunks
// that are already embedded with the pinned model, so no embedding is
// regenerated without a reason.
//
// The package title starts with "<chunk_id> — ". The model sees
// document_title and heading (src/agentTools.js), and internal retrieval ids
// must never reach a customer, so the prefix is stripped from both. The id
// stays in canonical_url and metadata for traceability.

const crypto = require("node:crypto");

const CANONICAL_URL_PREFIX = "manual:refal-rag-package:";
const IMPORTER = "rag-package";
const CHUNK_ID_PATTERN = /^[A-Z]{2,8}(?:-[A-Z0-9]{1,8})*-\d{3}$/u;
const REQUIRED_FIELDS = Object.freeze([
  "chunk_id", "agent_id", "knowledge_scope", "category", "title", "content", "embedding_text",
  "language", "source_file", "source_family", "version", "reviewed_at", "is_active", "content_hash"
]);
const LANGUAGES = Object.freeze(["ar", "en", "el"]);
const MAX_CHUNK_CHARS = 12000;          // rafa_knowledge_chunks.content check
const MAX_TITLE_CHARS = 160;            // display_name = left(trim(p_title), 160)
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
// Same expression as rafa_apply_knowledge_approval_lifecycle(): a matching
// revision gets valid_until = approval + 30 days and is hidden after that.
const PRICE_PATTERN = /(?:[$€£]\s*[0-9٠-٩]|(?:EUR|USD|GBP)\s*[0-9٠-٩]|[0-9٠-٩][0-9٠-٩.,\s]*(?:EUR|USD|GBP|euros?|dollars?|pounds?|يورو|دولار|جنيه|ευρώ))/iu;

const sha256 = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

function canonicalUrlFor(chunkId) {
  return `${CANONICAL_URL_PREFIX}${chunkId}`;
}

function stripIdPrefix(title, chunkId) {
  return title.replace(new RegExp(`^${escapeRegExp(chunkId)}\\s*[—–-]\\s*`, "u"), "").trim();
}

/**
 * @param {{ packageId: string, agentId: string, approver: string, retired?: string[], remap?: Record<string,string> }} manifest
 */
function validateManifest(manifest) {
  const problems = [];
  if (!manifest || typeof manifest !== "object") return ["manifest must be an object"];
  for (const field of ["packageId", "agentId", "approver"]) {
    if (typeof manifest[field] !== "string" || !manifest[field].trim()) problems.push(`manifest.${field} is required`);
  }
  for (const id of manifest.retired || []) if (!CHUNK_ID_PATTERN.test(id)) problems.push(`retired id ${id} is malformed`);
  for (const [from, to] of Object.entries(manifest.remap || {})) {
    if (!CHUNK_ID_PATTERN.test(from) || !CHUNK_ID_PATTERN.test(to)) problems.push(`remap ${from} -> ${to} is malformed`);
    if (!(manifest.retired || []).includes(from)) problems.push(`remap source ${from} is not in retired`);
  }
  return problems;
}

/**
 * Applies manifest remaps (retired id -> canonical id) to text that cites
 * other units. A remap changes the content, so the hash is recomputed and the
 * original package hash is kept for traceability.
 */
function applyRemap(row, remap) {
  let content = row.content;
  let embeddingText = row.embedding_text;
  const amendments = [];
  for (const [from, to] of Object.entries(remap || {})) {
    const source = `(?<![A-Z0-9-])${escapeRegExp(from)}(?![0-9])`;
    const probe = new RegExp(source, "u");
    const pattern = new RegExp(source, "gu");
    if (probe.test(content) || probe.test(embeddingText)) {
      content = content.replace(pattern, to);
      embeddingText = embeddingText.replace(pattern, to);
      amendments.push({ type: "remap-retired-reference", from, to });
    }
  }
  return { content, embeddingText, amendments };
}

/**
 * Validates every package line and builds the per-chunk write plan.
 * @returns {{ ok: boolean, errors: string[], warnings: string[], chunks: object[], inactive: string[] }}
 */
function planPackage(rows, manifest) {
  const errors = validateManifest(manifest);
  const warnings = [];
  const chunks = [];
  const inactive = [];
  const seen = new Set();
  const retired = new Set(manifest?.retired || []);

  rows.forEach((row, index) => {
    const where = `line ${index + 1}${row?.chunk_id ? ` (${row.chunk_id})` : ""}`;
    const missing = REQUIRED_FIELDS.filter((field) => row?.[field] === undefined || row?.[field] === null || row?.[field] === "");
    if (missing.length) { errors.push(`${where}: missing ${missing.join(", ")}`); return; }
    if (!CHUNK_ID_PATTERN.test(row.chunk_id)) errors.push(`${where}: malformed chunk_id`);
    if (seen.has(row.chunk_id)) errors.push(`${where}: duplicate chunk_id`);
    seen.add(row.chunk_id);
    if (row.agent_id !== manifest?.agentId) errors.push(`${where}: agent_id ${row.agent_id} is not ${manifest?.agentId}`);
    if (!LANGUAGES.includes(row.language)) errors.push(`${where}: unsupported language ${row.language}`);
    if (!SHA256_PATTERN.test(row.content_hash)) errors.push(`${where}: content_hash is not sha256 hex`);
    else if (sha256(row.embedding_text) !== row.content_hash) errors.push(`${where}: content_hash does not match sha256(embedding_text)`);
    if (retired.has(row.chunk_id)) errors.push(`${where}: chunk_id is listed as retired but present in the package`);
    if (row.is_active !== true) { inactive.push(row.chunk_id); return; }

    const { content, embeddingText, amendments } = applyRemap(row, manifest?.remap);
    const title = stripIdPrefix(row.title, row.chunk_id);
    if (!title) errors.push(`${where}: title is empty after removing the id prefix`);
    if (title.length > MAX_TITLE_CHARS) warnings.push(`${where}: title longer than ${MAX_TITLE_CHARS}, display name will be cut`);
    if (content.length < 1 || content.length > MAX_CHUNK_CHARS) errors.push(`${where}: content length ${content.length} outside 1..${MAX_CHUNK_CHARS}`);
    for (const id of retired) {
      if (new RegExp(`(?<![A-Z0-9-])${escapeRegExp(id)}(?![0-9])`, "u").test(content)) errors.push(`${where}: content still cites retired ${id}`);
    }
    const contentHash = sha256(embeddingText);
    const common = {
      importer: IMPORTER,
      packageId: manifest?.packageId,
      agentId: row.agent_id,
      chunkId: row.chunk_id,
      knowledgeScope: row.knowledge_scope,
      category: row.category,
      sourceFamily: row.source_family
    };
    chunks.push({
      chunkId: row.chunk_id,
      canonicalUrl: canonicalUrlFor(row.chunk_id),
      title,
      content,
      embeddingText,
      contentHash,
      language: row.language,
      willAutoExpire: PRICE_PATTERN.test(content),
      source: {
        canonical_url: canonicalUrlFor(row.chunk_id),
        display_name: title.slice(0, MAX_TITLE_CHARS),
        source_kind: "manual",
        trust_tier: "operator_supplied",
        approval_note: `Imported from finalized RAG package ${manifest?.packageId}.`,
        metadata: common
      },
      documentMetadata: {
        ...common,
        ...(row.topic ? { topic: row.topic } : {}),
        keywords: Array.isArray(row.keywords) ? row.keywords.slice(0, 40) : [],
        language: row.language,
        sourceFile: row.source_file,
        packageVersion: String(row.version),
        reviewedAt: row.reviewed_at,
        contentHash,
        packageContentHash: row.content_hash,
        amendments
      },
      chunk: {
        chunk_index: 0,
        heading: title,
        content,
        metadata: { ...common, kind: "knowledge" }
      }
    });
  });

  return { ok: errors.length === 0, errors, warnings, chunks, inactive };
}

/**
 * Decides what each chunk needs, given the current database state for the
 * package's canonical urls.
 *
 * dbState rows: { canonical_url, enabled, approved, approved_sha, approved_by,
 *                 approved_importer, chunks, embedded, embedding_model }
 *
 * Actions:
 *   insert           no source yet
 *   update           hash changed: new revision + embeddings
 *   embed            same hash, but vectors missing or from another model
 *   unchanged        same hash, embedded with the pinned model: nothing written
 *   operator-edited  the live revision was not written by this importer
 *                    (someone edited it in the dashboard); skipped unless forced,
 *                    because re-approving the package text would silently undo it
 *   deactivate       source carries the package prefix but the chunk is retired,
 *                    inactive or gone from the package
 */
function classify(plan, dbState, { embeddingModel, force = false } = {}) {
  const byUrl = new Map((dbState || []).map((row) => [row.canonical_url, row]));
  const actions = [];
  for (const chunk of plan.chunks) {
    const db = byUrl.get(chunk.canonicalUrl);
    let action;
    if (!db) action = "insert";
    else if (db.approved_sha && db.approved_importer !== IMPORTER && !force) action = "operator-edited";
    else if (db.approved_sha !== chunk.contentHash || !db.enabled || !db.approved) action = "update";
    else if (Number(db.embedded) !== Number(db.chunks) || db.embedding_model !== embeddingModel) action = "embed";
    else action = "unchanged";
    actions.push({ chunkId: chunk.chunkId, canonicalUrl: chunk.canonicalUrl, action, chunk });
  }
  const planned = new Set(plan.chunks.map((chunk) => chunk.canonicalUrl));
  for (const db of dbState || []) {
    if (!db.canonical_url.startsWith(CANONICAL_URL_PREFIX) || planned.has(db.canonical_url)) continue;
    if (db.enabled || db.approved) {
      actions.push({ chunkId: db.canonical_url.slice(CANONICAL_URL_PREFIX.length), canonicalUrl: db.canonical_url, action: "deactivate" });
    }
  }
  return actions;
}

// Dollar quoting, same as scripts/emitCorpusSql.js: the tag is checked against
// the payload so a literal tag inside Arabic text cannot terminate it early.
function dollarQuote(value) {
  const text = String(value);
  let tag = "kb";
  while (text.includes(`$${tag}$`)) tag += "x";
  return `$${tag}$${text}$${tag}$`;
}
const asJsonb = (value) => `${dollarQuote(JSON.stringify(value))}::jsonb`;
const vectorJson = (vector) => `[${vector.map((value) => (value === 0 ? "0" : Number(value.toFixed(8)))).join(",")}]`;

/**
 * Renders one transactional SQL batch. Every statement goes through the
 * existing RPCs so the approval lifecycle trigger, chunk insertion and price
 * expiry behave exactly as they do for any other caller. A closing assertion
 * rolls the whole batch back if the result is not what was planned.
 */
function renderBatch(actions, vectorsByChunkId, { approver, embeddingModel, label }) {
  const lines = [`-- ${label} · generated by scripts/importRagPackage.js · data, not a schema migration`];
  lines.push("-- ROLLBACK: disable the listed sources (update rafa_knowledge_sources set enabled=false, approved=false where canonical_url in (...)) or restore from the pre-import backup.");
  lines.push("begin;");
  const writtenUrls = [];
  for (const item of actions) {
    const url = dollarQuote(item.canonicalUrl);
    if (item.action === "deactivate") {
      lines.push(`update public.rafa_knowledge_sources set enabled = false, approved = false, last_status = 'disabled', updated_at = now() where canonical_url = ${url};`);
      continue;
    }
    const { chunk } = item;
    if (item.action === "insert" || item.action === "update") {
      const s = chunk.source;
      lines.push(`insert into public.rafa_knowledge_sources (canonical_url, display_name, source_kind, trust_tier, enabled, approved, approval_note, metadata)`);
      lines.push(`values (${url}, ${dollarQuote(s.display_name)}, ${dollarQuote(s.source_kind)}, ${dollarQuote(s.trust_tier)}, true, true, ${dollarQuote(s.approval_note)}, ${asJsonb(s.metadata)})`);
      lines.push(`on conflict (canonical_url) do update set display_name = excluded.display_name, metadata = excluded.metadata, approval_note = excluded.approval_note, enabled = true, approved = true;`);
      lines.push(`select public.rafa_store_knowledge_revision(`);
      lines.push(`  (select id from public.rafa_knowledge_sources where canonical_url = ${url}),`);
      lines.push(`  ${dollarQuote(chunk.title)}, ${dollarQuote(chunk.content)}, ${dollarQuote(chunk.contentHash)}, ${dollarQuote(chunk.language)},`);
      lines.push(`  ${asJsonb([chunk.chunk])}, ${asJsonb(chunk.documentMetadata)}, 'approved', ${dollarQuote(approver)});`);
    }
    const vector = vectorsByChunkId.get(chunk.chunkId);
    if (!vector) throw new Error(`${chunk.chunkId}: no vector computed for a ${item.action} action`);
    lines.push(`select public.rafa_store_knowledge_embeddings(`);
    lines.push(`  (select d.id from public.rafa_knowledge_documents d join public.rafa_knowledge_sources s on s.id = d.source_id`);
    lines.push(`    where s.canonical_url = ${url} and d.review_status = 'approved' and d.content_sha256 = ${dollarQuote(chunk.contentHash)}),`);
    lines.push(`  ${dollarQuote(embeddingModel)}, ${dollarQuote(`[{"chunk_index":0,"embedding":${vectorJson(vector)}}]`)}::jsonb);`);
    writtenUrls.push({ url: item.canonicalUrl, hash: chunk.contentHash });
  }
  if (writtenUrls.length) {
    const values = writtenUrls.map((w) => `(${dollarQuote(w.url)}, ${dollarQuote(w.hash)})`).join(", ");
    lines.push(`do $assert$ declare v_ok integer; begin`);
    lines.push(`  select count(*) into v_ok from (values ${values}) as e(url, sha)`);
    lines.push(`  join public.rafa_knowledge_sources s on s.canonical_url = e.url and s.enabled and s.approved`);
    lines.push(`  join public.rafa_knowledge_documents d on d.source_id = s.id and d.review_status = 'approved' and d.content_sha256 = e.sha`);
    lines.push(`  where (select count(*) from public.rafa_knowledge_chunks c where c.document_id = d.id) = 1`);
    lines.push(`    and (select count(*) from public.rafa_knowledge_chunks c where c.document_id = d.id and c.embedding is not null and c.embedding_model = ${dollarQuote(embeddingModel)}) = 1;`);
    lines.push(`  if v_ok <> ${writtenUrls.length} then raise exception 'import batch check failed: % of ${writtenUrls.length} chunks verified', v_ok; end if;`);
    lines.push(`end $assert$;`);
  }
  lines.push("commit;");
  return lines.join("\n");
}

/**
 * SQL to refresh the 30 day validity of price-bearing package revisions that
 * expire within `withinDays`, through the existing review RPC so the refresh is
 * audited with a named reviewer and reason. Clearing valid_until first is what
 * lets the approval trigger grant a fresh window; on an unexpired revision the
 * trigger otherwise keeps least(valid_until, now() + 30 days).
 */
function renderValidityRefresh({ reviewer, reason, withinDays }) {
  if (!reviewer?.trim() || !reason?.trim()) throw new Error("A validity refresh needs a named reviewer and a reason.");
  const days = Math.max(0, Math.min(30, Number(withinDays) || 0));
  return [
    "-- price validity refresh · generated by scripts/importRagPackage.js",
    "begin;",
    "do $refresh$ declare r record; v_count integer := 0; begin",
    "  for r in select d.id from public.rafa_knowledge_documents d join public.rafa_knowledge_sources s on s.id = d.source_id",
    `    where s.canonical_url like ${dollarQuote(`${CANONICAL_URL_PREFIX}%`)} and s.enabled and s.approved and d.review_status = 'approved'`,
    `      and d.valid_until is not null and d.valid_until <= now() + interval '${days} days'`,
    "  loop",
    "    update public.rafa_knowledge_documents set valid_until = null where id = r.id;",
    `    perform public.rafa_review_knowledge_document(r.id, 'approved', ${dollarQuote(reviewer.trim())}, ${dollarQuote(reason.trim())});`,
    "    v_count := v_count + 1;",
    "  end loop;",
    "  raise notice 'refreshed % revisions', v_count;",
    "end $refresh$;",
    "commit;"
  ].join("\n");
}

const STATE_QUERY = `select coalesce(json_agg(row_to_json(x)), '[]'::json) state from (
  select s.canonical_url, s.enabled, s.approved,
         d.content_sha256 approved_sha, d.approved_by, d.metadata->>'importer' approved_importer, d.valid_until,
         (select count(*) from public.rafa_knowledge_chunks c where c.document_id = d.id) chunks,
         (select count(*) from public.rafa_knowledge_chunks c where c.document_id = d.id and c.embedding is not null) embedded,
         (select min(c.embedding_model) from public.rafa_knowledge_chunks c where c.document_id = d.id) embedding_model
  from public.rafa_knowledge_sources s
  left join public.rafa_knowledge_documents d on d.source_id = s.id and d.review_status = 'approved'
  where s.canonical_url like '${CANONICAL_URL_PREFIX}%'
) x;`;

module.exports = {
  CANONICAL_URL_PREFIX,
  IMPORTER,
  PRICE_PATTERN,
  STATE_QUERY,
  canonicalUrlFor,
  stripIdPrefix,
  validateManifest,
  applyRemap,
  planPackage,
  classify,
  renderBatch,
  renderValidityRefresh,
  dollarQuote,
  sha256
};
