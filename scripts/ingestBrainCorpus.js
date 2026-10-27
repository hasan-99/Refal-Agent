#!/usr/bin/env node
"use strict";

// M3 / W3.10.1-W3.10.4 — push the authored knowledge corpus into Supabase.
//
// This is the thin I/O shell. Every decision, every payload and every database
// constraint lives in src/corpusIngest.js, which is pure and tested offline
// against all 87 real files. This file only reads the disk, prints the plan
// and, when explicitly told to, posts it.
//
//   node scripts/ingestBrainCorpus.js                  # DRY RUN, all 87
//   node scripts/ingestBrainCorpus.js --topic ip-box   # DRY RUN, one topic
//   node scripts/ingestBrainCorpus.js --phase P3.2
//   node scripts/ingestBrainCorpus.js --lang en
//   node scripts/ingestBrainCorpus.js --json
//   node scripts/ingestBrainCorpus.js --apply          # writes
//   node scripts/ingestBrainCorpus.js --apply --embed  # writes + indexes
//   node scripts/ingestBrainCorpus.js --check-live    # read-only hash/status comparison
//
// DRY RUN IS THE DEFAULT, AND IT IS NOT A COURTESY.
// It needs no credentials, no network and no database, it produces the whole
// per-topic plan, and it returns a real exit code. --apply is the only way to
// write anything, and it queues changed document revisions as pending. It
// never approves customer-facing content; a reviewer must approve separately.
//
// THE RLS TRAP, AND WHY THIS SCRIPT READS BACK WHAT IT WROTE
// ----------------------------------------------------------
// The knowledge tables grant to `anon` only behind a policy that calls
// public.rafa_dashboard_secret_matches(), which reads the
// x-rafa-dashboard-secret request header. Without that header a POST returns
// 2xx and inserts NOTHING, and a GET returns []. A naive script prints
// "ingested 87 documents" having written zero rows. So every apply run ends by
// reading the rows back and comparing hashes and chunk counts, and a zero
// readback is a loud, non-zero failure rather than a silent success.
//
// THE 30 DAY PRICE EXPIRY
// -----------------------
// A BEFORE trigger forces valid_until = now() + 30 days on any document whose
// canonical_content matches a currency regex. Several corpus documents state
// €300,000, so they stop being retrievable a month after ingestion. That is
// Rule 2 behaving correctly, and it makes re-ingestion a MONTHLY operation.
// The plan predicts it per document so the operator knows before running, and
// the apply run reports the valid_until the database actually assigned.

const fs = require("node:fs");
const path = require("node:path");

const { loadProjectEnv } = require("../src/env");
const { TOPICS, LANGUAGES } = require("../src/brainTaxonomy");
const { TOPIC_PHASE } = require("../src/brainFactMap");
const { seedRegister } = require("../src/factRegister");
const { planCorpus, PRICE_EXPIRY_DAYS, readbackReviewStatusMatches } = require("../src/corpusIngest");

const ROOT = path.resolve(__dirname, "..");
const EXPECTED_FILES = TOPICS.length * LANGUAGES.length;

// ------------------------------------------------------------------- args
function parseArgs(argv) {
  const args = { topic: null, phase: null, lang: null, json: false, apply: false, checkLive: false, allowPartial: false, embed: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--json") args.json = true;
    else if (a === "--apply") args.apply = true;
    else if (a === "--check-live") args.checkLive = true;
    else if (a === "--allow-partial") args.allowPartial = true;
    else if (a === "--embed") args.embed = true;
    else if (a === "--topic") args.topic = argv[++i];
    else if (a === "--phase") args.phase = argv[++i];
    else if (a === "--lang") args.lang = argv[++i];
    else { console.error(`unknown argument: ${a}`); process.exit(2); }
  }
  return args;
}

function selectTopics(args) {
  let topics = TOPICS;
  if (args.topic) topics = topics.filter((t) => t.slug === args.topic);
  if (args.phase) topics = topics.filter((t) => TOPIC_PHASE[t.n] === args.phase);
  if (!topics.length) { console.error("no topics matched the filter"); process.exit(2); }
  return topics;
}

// ---------------------------------------------------------------- reporting
function reportPlan(plan, args) {
  for (const file of plan.files) for (const error of file.errors) console.log(`FAIL  ${error}`);
  for (const file of plan.files) for (const warning of file.warnings) console.log(`WARN  ${warning}`);

  console.log("");
  console.log("  topic                          lang  chunks  chars  expiry");
  for (const file of plan.files) {
    if (file.missing) { console.log(`  ${file.topic.padEnd(30)} ${file.lang}     MISSING`); continue; }
    if (file.suppressed) { console.log(`  ${file.topic.padEnd(30)} ${file.lang}     SUPPRESSED  ${file.skipReason}`); continue; }
    if (file.skipped) { console.log(`  ${file.topic.padEnd(30)} ${file.lang}     SKIPPED  ${file.skipReason}`); continue; }
    if (!file.ok) { console.log(`  ${file.topic.padEnd(30)} ${file.lang}     BROKEN`); continue; }
    const expiry = file.willAutoExpire ? `${PRICE_EXPIRY_DAYS}d price` : "none";
    console.log(`  ${file.topic.padEnd(30)} ${file.lang}    ${String(file.chunks.length).padStart(5)}  ${String(file.contentChars).padStart(5)}  ${expiry}`);
  }

  const byPhase = new Map();
  for (const file of plan.files) {
    const row = byPhase.get(file.phase) || { total: 0, planned: 0, chunks: 0, expiring: 0 };
    row.total += 1;
    if (file.ok && !file.missing && !file.skipped) { row.planned += 1; row.chunks += file.chunks.length; }
    if (file.willAutoExpire) row.expiring += 1;
    byPhase.set(file.phase, row);
  }
  console.log("");
  for (const phase of [...byPhase.keys()].sort()) {
    const r = byPhase.get(phase);
    console.log(`  ${phase}  planned ${r.planned}/${r.total}  chunks ${r.chunks}  expiring ${r.expiring}`);
  }

  const s = plan.summary;
  console.log("");
  console.log(`plan: ${s.sources} sources · ${s.documents} documents · ${s.chunks} chunks (${s.aliasChunks} alias + ${s.sectionChunks} section) · ${s.contentChars} content chars`);
  console.log(`      ${s.present}/${s.expected} present · ${s.broken} broken (${s.errors} errors) · ${s.skipped} skipped · ${s.skippedSections} blocked sections dropped`);
  if (s.suppressed) {
    // Not a failure: a blocked fact taking its whole document dark is Rule 2
    // working. It still has to be said out loud, because the topic silently
    // stops being answerable at all.
    console.log(`      ${s.suppressed} documents FULLY SUPPRESSED by a blocked fact (nothing ingested): ${s.suppressedTopics.join(", ")}`);
  }
  console.log(`      ${s.willAutoExpire} documents will auto expire after ${PRICE_EXPIRY_DAYS} days (price-bearing): ${s.autoExpireTopics.join(", ") || "none"}`);
  if (s.willAutoExpire) console.log(`      re-ingestion is therefore a MONTHLY operation for those topics`);
  if (!args.apply) {
    console.log("");
    console.log("DRY RUN — nothing was written. Re-run with --apply to queue changed revisions as pending.");
  }
}

// -------------------------------------------------------------- the writes
function supabaseClient() {
  // Copied verbatim in shape from scripts/backfillKnowledgeEmbeddings.js so
  // there is exactly one way this project talks to PostgREST. The dashboard
  // secret header is NOT optional: without it every write silently no-ops.
  const baseUrl = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const key = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;
  const secret = process.env.RAFA_DASHBOARD_SUPABASE_SECRET;
  if (!baseUrl || !key || !secret) {
    throw new Error("Supabase dashboard REST configuration is incomplete (SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY/SUPABASE_ANON_KEY, RAFA_DASHBOARD_SUPABASE_SECRET).");
  }
  return async function rest(pathname, options = {}) {
    const response = await fetch(`${baseUrl}/rest/v1/${pathname}`, {
      ...options,
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        "x-rafa-dashboard-secret": secret,
        "content-type": "application/json",
        ...(options.headers || {}),
      },
    });
    const body = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) throw new Error(body?.message || body?.error || `Supabase request failed (${response.status}).`);
    return body;
  };
}

// The sources table is small (87 corpus rows plus whatever the dashboard
// holds), so it is read whole rather than filtered with an `in.()` list of
// URLs containing `://`, which has to be quoted and escaped to be correct.
async function readSources(rest) {
  const rows = await rest("rafa_knowledge_sources?select=id,canonical_url,display_name&limit=2000");
  return new Map((rows || []).map((row) => [row.canonical_url, row]));
}

function checkLiveOptionError(args) {
  if (args.apply && args.checkLive) return "--check-live is read-only and cannot be combined with --apply";
  if (args.checkLive && (args.topic || args.phase || args.lang || args.allowPartial)) return "--check-live requires the complete corpus; filters and --allow-partial are not supported";
  return null;
}

// Read-only operational parity check. It compares only hashes and review
// metadata; corpus text and customer data are never printed.
async function checkLive(plan) {
  const rest = supabaseClient();
  const sources = await readSources(rest);
  // Include suppressed files in the readback set. Omitting a locally
  // suppressed topic used to let --check-live report success for a partial
  // corpus, even though an older approved live revision could still answer.
  const files = plan.files.filter((f) => f.ok && !f.missing);
  const matched = files.map((file) => ({
    file,
    source: sources.get(file.source?.canonical_url || file.canonicalUrl),
  }));
  const sourceIds = matched.filter((x) => x.source).map((x) => x.source.id);
  const documents = [];
  for (const batch of batched(sourceIds, 40)) {
    const got = await rest(`rafa_knowledge_documents?source_id=in.(${batch.join(",")})&select=source_id,revision,content_sha256,review_status,valid_until,language_code&order=revision.desc&limit=2000`);
    documents.push(...(got || []));
  }
  const bySource = new Map();
  for (const document of documents) {
    const rows = bySource.get(document.source_id) || [];
    rows.push(document);
    bySource.set(document.source_id, rows);
  }
  const rows = matched.map(({ file, source }) => {
    const revisions = source ? (bySource.get(source.id) || []) : [];
    const approved = revisions.filter((d) => d.review_status === "approved");
    const pending = revisions.filter((d) => d.review_status === "pending");
    const active = approved[0] || null;
    const hasExpiry = active?.valid_until !== null && active?.valid_until !== undefined;
    const expiryTime = hasExpiry ? Date.parse(active.valid_until) : null;
    const locallySuppressed = Boolean(file.skipped || file.suppressed);
    return {
      topic: file.topic, lang: file.lang,
      state: locallySuppressed ? "local_suppressed" : !source ? "missing_source" : !active ? "missing_approved" : active.content_sha256 === file.document.p_content_sha256 ? "match" : "hash_mismatch",
      localHash: file.document?.p_content_sha256 || null,
      liveHash: active?.content_sha256 || null,
      approvedRevision: active?.revision ?? null,
      approvedRevisions: approved.length,
      locallySuppressed,
      pendingRevisions: pending.length,
      pendingMatchesLocal: pending.some((d) => d.content_sha256 === file.document.p_content_sha256),
      validUntil: active?.valid_until || null,
      expired: hasExpiry && (!Number.isFinite(expiryTime) || expiryTime <= Date.now()),
    };
  });
  const counts = Object.fromEntries(["match", "hash_mismatch", "missing_source", "missing_approved", "local_suppressed"].map((key) => [key, rows.filter((r) => r.state === key).length]));
  counts.expired = rows.filter((r) => r.expired).length;
  counts.multipleApproved = rows.filter((r) => r.approvedRevisions > 1).length;
  counts.pendingRevisions = rows.reduce((sum, row) => sum + row.pendingRevisions, 0);
  counts.pendingNotLocal = rows.filter((row) => row.pendingRevisions > 0 && !row.pendingMatchesLocal).length;
  return { rows, counts, documentsRead: documents.length };
}

function liveParityNeedsReview(result) {
  const counts = result?.counts || {};
  return Boolean(counts.hash_mismatch || counts.missing_source || counts.missing_approved || counts.local_suppressed || counts.multipleApproved || counts.expired || counts.pendingRevisions);
}

function applyExitCode(outcome) {
  // `--embed` is an explicit request to finish indexing as part of the apply.
  // A document may already have been stored when its embedding call fails, so
  // reporting that run as successful would leave a partially indexed corpus
  // while the CLI exits 0. Make warnings from that required step actionable to
  // automation and operators; rerunning is safe because the revision RPC is
  // content-idempotent.
  // A full apply that silently omits locally suppressed/blocked topics is a
  // partial synchronization. Existing live approved revisions for those
  // topics may remain answerable, so automation must not treat it as green.
  return outcome?.mismatches?.length || outcome?.embedWarnings?.length || outcome?.skippedFiles?.length ? 1 : 0;
}

function reportLiveParity(result, json) {
  if (json) { console.log(JSON.stringify(result, null, 2)); return; }
  console.log("\nLive approved corpus parity (read-only; hashes and metadata only)");
  console.log(`  matching: ${result.counts.match} · hash mismatch: ${result.counts.hash_mismatch} · missing source: ${result.counts.missing_source} · missing approved: ${result.counts.missing_approved} · locally suppressed: ${result.counts.local_suppressed} · multiple approved: ${result.counts.multipleApproved} · expired: ${result.counts.expired} · pending revisions: ${result.counts.pendingRevisions} (${result.counts.pendingNotLocal} differ from local)`);
  console.log("  topic                          lang  state             approved rev  pending  pending=local  expiry");
  for (const row of result.rows) {
    console.log(`  ${row.topic.padEnd(30)} ${row.lang}    ${row.state.padEnd(16)} ${String(row.approvedRevision ?? "-").padStart(11)}  ${String(row.pendingRevisions).padStart(7)}  ${String(row.pendingMatchesLocal).padStart(13)}  ${row.validUntil || "-"}`);
  }
}

function batched(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function apply(plan, args) {
  const rest = supabaseClient();
  const files = plan.files.filter((f) => f.ok && !f.missing && !f.skipped);

  // ---- 1. who already exists, so created vs updated is a real answer
  const before = await readSources(rest);

  // ---- 2. upsert the source rows on canonical_url, the only unique key
  const rows = files.map((f) => f.source);
  let represented = 0;
  for (const batch of batched(rows, 40)) {
    const result = await rest("rafa_knowledge_sources?on_conflict=canonical_url&select=id,canonical_url", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify(batch),
    });
    represented += (result || []).length;
  }
  if (represented !== rows.length) {
    throw new Error(
      `source upsert returned ${represented} of ${rows.length} rows. A 2xx with nothing returned is the RLS signature: ` +
      "x-rafa-dashboard-secret is missing or wrong, so the write was discarded.",
    );
  }

  const after = await readSources(rest);
  if (!after.size) {
    throw new Error("reading the sources back returned nothing. The dashboard secret is not being accepted, so nothing was written.");
  }

  // ---- 3. one revision per document, through the replace-in-place RPC
  const results = [];
  for (const file of files) {
    const source = after.get(file.source.canonical_url);
    if (!source) throw new Error(`${file.path}: the source row for ${file.source.canonical_url} is not readable after the upsert`);
    const existed = before.has(file.source.canonical_url);
    // p_chunks is passed EXPLICITLY and does not live on file.document.
    //
    // buildDocumentPayload deliberately returns only the document arguments,
    // because the chunks are also needed on their own for the embedding step.
    // Spreading file.document alone therefore omitted p_chunks entirely, and
    // p_chunks has no DEFAULT in the 9-argument signature, so PostgREST could
    // not resolve the function and --apply would have failed outright.
    //
    // Dry run is the default and never reaches this line, so the failure was
    // invisible behind a green exit code. Found by the P3.10 audit.
    const saved = await rest("rpc/rafa_store_knowledge_revision", {
      method: "POST",
      body: JSON.stringify({ p_source_id: source.id, ...file.document, p_chunks: file.chunks }),
    });
    if (!saved || !saved.document_id) throw new Error(`${file.path}: rafa_store_knowledge_revision returned no document_id`);
    results.push({
      file, sourceId: source.id, documentId: saved.document_id,
      unchanged: Boolean(saved.unchanged), created: !existed,
    });
  }

  // ---- 4. read back what was written. A zero readback is the RLS trap.
  const documentIds = results.map((r) => r.documentId);
  const documents = [];
  for (const batch of batched(documentIds, 40)) {
    const got = await rest(`rafa_knowledge_documents?id=in.(${batch.join(",")})&select=id,source_id,revision,content_sha256,review_status,valid_until,language_code&limit=2000`);
    documents.push(...(got || []));
  }
  if (!documents.length) {
    throw new Error("read-back found zero documents after writing. Nothing was persisted; check RAFA_DASHBOARD_SUPABASE_SECRET.");
  }

  const chunkCounts = new Map();
  for (const batch of batched(documentIds, 40)) {
    const got = await rest(`rafa_knowledge_chunks?document_id=in.(${batch.join(",")})&select=document_id,chunk_index&limit=20000`);
    for (const row of got || []) chunkCounts.set(row.document_id, (chunkCounts.get(row.document_id) || 0) + 1);
  }

  const byId = new Map(documents.map((d) => [d.id, d]));
  const mismatches = [];
  for (const result of results) {
    const document = byId.get(result.documentId);
    if (!document) { mismatches.push(`${result.file.path}: document ${result.documentId} is not readable after the write`); continue; }
    if (document.content_sha256 !== result.file.document.p_content_sha256) {
      mismatches.push(`${result.file.path}: stored hash does not match the content that was sent`);
    }
    if (!readbackReviewStatusMatches(document.review_status, result.file.document.p_review_status, result.unchanged)) {
      mismatches.push(`${result.file.path}: review_status is ${document.review_status}, expected ${result.file.document.p_review_status}`);
    }
    const stored = chunkCounts.get(result.documentId) || 0;
    if (stored !== result.file.chunks.length) {
      mismatches.push(`${result.file.path}: ${stored} chunks stored, ${result.file.chunks.length} planned`);
    }
    result.validUntil = document.valid_until;
  }

  // ---- 5. embeddings, all or nothing per document.
  // The RPC raises unless the array length equals the document's TOTAL chunk
  // count, so the full set is always read back and sent. Never filter to the
  // chunks that look unembedded: that posts a short array and the RPC rejects
  // it (scripts/backfillKnowledgeEmbeddings.js does exactly that today).
  let embedded = 0;
  const embedWarnings = [];
  if (args.embed) {
    const { embedTexts, DEFAULT_EMBEDDING_MODEL } = require("../src/ai");
    const model = process.env.OPENROUTER_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL;
    for (const result of results) {
      try {
        const chunks = await rest(`rafa_knowledge_chunks?document_id=eq.${result.documentId}&select=chunk_index,content&order=chunk_index.asc&limit=500`);
        if (!chunks || !chunks.length) { embedWarnings.push(`${result.file.path}: no chunks readable to embed`); continue; }
        const vectors = await embedTexts(chunks.map((c) => c.content));
        embedded += await rest("rpc/rafa_store_knowledge_embeddings", {
          method: "POST",
          body: JSON.stringify({
            p_document_id: result.documentId,
            p_model: model,
            p_embeddings: chunks.map((c, i) => ({ chunk_index: c.chunk_index, embedding: vectors[i] })),
          }),
        });
      } catch (error) {
        embedWarnings.push(`${result.file.path}: ${String(error.message).slice(0, 160)}`);
      }
    }
  }

  return { results, mismatches, embedded, embedWarnings, documents };
}

function reportApply(outcome, args) {
  const { results, mismatches, embedded, embedWarnings } = outcome;

  const byTopic = new Map();
  for (const result of results) {
    const row = byTopic.get(result.file.topic) || { created: 0, updated: 0, unchanged: 0, skipped: 0 };
    if (result.unchanged) row.unchanged += 1;
    else if (result.created) row.created += 1;
    else row.updated += 1;
    byTopic.set(result.file.topic, row);
  }
  for (const file of outcome.skippedFiles || []) {
    const row = byTopic.get(file.topic) || { created: 0, updated: 0, unchanged: 0, skipped: 0 };
    row.skipped += 1;
    byTopic.set(file.topic, row);
  }

  console.log("");
  console.log("  topic                          created  updated  unchanged  skipped");
  for (const topic of [...byTopic.keys()].sort()) {
    const r = byTopic.get(topic);
    console.log(`  ${topic.padEnd(30)} ${String(r.created).padStart(7)}  ${String(r.updated).padStart(7)}  ${String(r.unchanged).padStart(9)}  ${String(r.skipped).padStart(7)}`);
  }

  const expiring = results.filter((r) => r.validUntil);
  console.log("");
  console.log(`queued: ${results.length} documents · ${results.filter((r) => r.created).length} created · ${results.filter((r) => !r.created && !r.unchanged).length} updated · ${results.filter((r) => r.unchanged).length} unchanged`);
  console.log("         changed revisions remain pending until an independent dashboard review approves them; the prior approved revision remains active meanwhile");
  console.log(`         ${expiring.length} documents came back with a valid_until (the ${PRICE_EXPIRY_DAYS} day price expiry)`);
  if (args.embed) console.log(`         ${embedded} chunk embeddings stored`);
  for (const warning of embedWarnings) console.log(`WARN  ${warning}`);
  for (const mismatch of mismatches) console.log(`FAIL  ${mismatch}`);
  if (mismatches.length) console.log("");
  if (mismatches.length) console.log("read-back did not match what was sent; treat this run as NOT applied.");
}

// -------------------------------------------------------------------- main
async function run(argv) {
  const args = parseArgs(argv);
  const optionError = checkLiveOptionError(args);
  if (optionError) { console.error(optionError); return 2; }
  const topics = selectTopics(args);
  const langs = args.lang ? [args.lang] : LANGUAGES;

  const plan = planCorpus({
    root: "knowledge",
    topics,
    langs,
    register: seedRegister(),
    now: new Date(),
    readFile: (relative) => {
      const abs = path.join(ROOT, relative);
      return fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
    },
    join: (...parts) => parts.join("/"),
  });

  if (!args.checkLive) {
    if (args.json) console.log(JSON.stringify({ summary: plan.summary, files: plan.files.map((f) => ({ ...f, warnings: f.warnings })) }, null, 2));
    else reportPlan(plan, args);
  }

  // A file that fails the authoring gate must never reach the database, and
  // there is no flag that overrides this.
  const brokenFiles = plan.files.filter((f) => !f.ok && !f.missing);
  if (brokenFiles.length) {
    console.error(`refusing to continue: ${brokenFiles.length} file(s) failed validateCorpusFile. A broken file must never reach the database.`);
    return 1;
  }
  if (plan.summary.missing && !args.allowPartial) {
    console.error(`refusing to continue: ${plan.summary.missing} expected corpus file(s) are missing. Pass --allow-partial to ingest anyway.`);
    return 2;
  }
  if (args.apply && plan.summary.expected !== EXPECTED_FILES && !args.allowPartial) {
    console.error(`refusing to apply a filtered selection (${plan.summary.expected} of ${EXPECTED_FILES} files). Pass --allow-partial to ingest a subset.`);
    return 2;
  }

  if (args.checkLive) {
    if (plan.summary.expected !== EXPECTED_FILES || plan.summary.missing || plan.summary.broken) { console.error("--check-live requires a complete, valid local corpus"); return 2; }
    const parity = await checkLive(plan);
    reportLiveParity(parity, args.json);
    return liveParityNeedsReview(parity) ? 1 : 0;
  }
  if (!args.apply) return 0;

  const outcome = await apply(plan, args);
  outcome.skippedFiles = plan.files.filter((f) => f.skipped);
  reportApply(outcome, args);
  return applyExitCode(outcome);
}

if (require.main === module) {
  loadProjectEnv(ROOT);
  run(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      console.error(`Corpus ingestion failed: ${String(error.message).slice(0, 400)}`);
      process.exitCode = 1;
    });
}

module.exports = { run, parseArgs, selectTopics, checkLive, checkLiveOptionError, liveParityNeedsReview, applyExitCode };
