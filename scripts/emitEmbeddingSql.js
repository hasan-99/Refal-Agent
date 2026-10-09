#!/usr/bin/env node
"use strict";

// P3.10 / W3.10.3 — computes the corpus embeddings locally and emits them as
// SQL, one file per document.
//
// Same reason as scripts/emitCorpusSql.js: the PostgREST write path on this
// machine authenticates as `anon` plus `x-rafa-dashboard-secret`, and that
// secret does not match the deployed sha256, so every RLS policy denies it
// silently. The Supabase Management API query endpoint runs as the service and
// is the vetted path here.
//
// Two things this gets right that a careless version would not:
//
// 1. **The model string is PINNED to `DEFAULT_EMBEDDING_MODEL`.** It is NOT
//    read from `OPENROUTER_EMBEDDING_MODEL`. `scripts/backfillKnowledgeEmbeddings.js`
//    honours that variable while every reader, including both search RPCs,
//    compares `embedding_model` with a plain `=` against the hardcoded default.
//    A mismatch does not error; it silently kills the semantic branch forever.
//
// 2. **Chunks are embedded with `embedTexts`, never `embedText`.** This is an
//    E5 model and the two prefixes are not interchangeable: `embedTexts`
//    prefixes `passage: ` for stored content, `embedText` prefixes `query: `
//    for a search. Using the query prefix on stored passages degrades every
//    similarity score in a way no test would catch.
//
// `rafa_store_knowledge_embeddings` requires the array to cover EVERY chunk of
// the document, so each file emits the document's complete chunk set in
// chunk_index order. That is the same contract FIX-29 was about.
//
//   node scripts/emitEmbeddingSql.js            # artifacts/embedding-sql/

const fs = require("node:fs");
const path = require("node:path");
const { TOPICS, LANGUAGES, canonicalUrl } = require("../src/brainTaxonomy");
const { planFile } = require("../src/corpusIngest");
const { embedTexts, DEFAULT_EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } = require("../src/ai");
const { dollarQuote } = require("./emitCorpusSql");

const ROOT = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const args = { out: path.join(ROOT, "artifacts", "embedding-sql") };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out") args.out = path.resolve(argv[++i]);
    else { console.error(`unknown argument: ${argv[i]}`); process.exit(2); }
  }
  return args;
}

// A float array as compact JSON. The padded tail is zeros, which serialise to
// one character each, so a 2048 wide vector stays a few kilobytes.
function vectorJson(vector) {
  return `[${vector.map((value) => (value === 0 ? "0" : Number(value.toFixed(8)))).join(",")}]`;
}

async function run(argv) {
  const args = parseArgs(argv);
  fs.mkdirSync(args.out, { recursive: true });

  // Plan first, so a corpus problem surfaces before the slow part.
  const documents = [];
  for (const topic of TOPICS) {
    for (const lang of LANGUAGES) {
      const rel = `knowledge/${topic.slug}/${lang}.md`;
      const abs = path.join(ROOT, "knowledge", topic.slug, `${lang}.md`);
      if (!fs.existsSync(abs)) { console.log(`FAIL  ${rel}: missing`); return 1; }
      const plan = planFile({ text: fs.readFileSync(abs, "utf8"), topicSlug: topic.slug, lang, path: rel });
      if (!plan.ok || plan.suppressed) { console.log(`FAIL  ${rel}: ${plan.errors.join(" | ") || "suppressed"}`); return 1; }
      documents.push({ topic, lang, plan, url: canonicalUrl(topic.slug, lang) });
    }
  }

  const totalChunks = documents.reduce((sum, d) => sum + d.plan.chunks.length, 0);
  console.log(`embedding ${totalChunks} chunks across ${documents.length} documents with ${DEFAULT_EMBEDDING_MODEL}`);
  const started = Date.now();

  // ONE embedTexts call PER DOCUMENT, not one call for the whole corpus.
  // `embedWithPipeline` rejects a batch over 500 and the corpus is 573 chunks,
  // so the single-call version failed with "Embedding batch size is invalid".
  // Per document is the right unit anyway: it is exactly what
  // `rafa_store_knowledge_embeddings` demands, so the vectors are grouped the
  // way they are stored and a mis-slice cannot silently shift a document.
  let emitted = 0;
  let vectorCount = 0;
  for (const doc of documents) {
    const vectors = await embedTexts(doc.plan.chunks.map((c) => c.content));
    if (vectors.length !== doc.plan.chunks.length) {
      throw new Error(`${doc.plan.path}: expected ${doc.plan.chunks.length} vectors, got ${vectors.length}`);
    }
    for (const [i, vector] of vectors.entries()) {
      if (vector.length !== EMBEDDING_DIMENSIONS) throw new Error(`${doc.plan.path} chunk ${i}: ${vector.length} dimensions, expected ${EMBEDDING_DIMENSIONS}`);
      if (vector.some((v) => !Number.isFinite(v))) throw new Error(`${doc.plan.path} chunk ${i} carries a non-finite value`);
    }
    vectorCount += vectors.length;

    const payload = doc.plan.chunks.map((chunk, i) => ({
      chunk_index: chunk.chunk_index,
      embedding: vectors[i],
    }));

    const lines = [];
    lines.push(`-- embeddings for ${doc.plan.path} · ${payload.length} chunks · model pinned to DEFAULT_EMBEDDING_MODEL`);
    lines.push(`-- GENERATED by scripts/emitEmbeddingSql.js. Data, not a schema migration. Safe to re-apply.`);
    lines.push(`select public.rafa_store_knowledge_embeddings(`);
    lines.push(`  (select d.id from public.rafa_knowledge_documents d`);
    lines.push(`     join public.rafa_knowledge_sources s on s.id = d.source_id`);
    lines.push(`    where s.canonical_url = ${dollarQuote(doc.url)} and d.review_status = 'approved'),`);
    lines.push(`  ${dollarQuote(DEFAULT_EMBEDDING_MODEL)},`);
    lines.push(`  ${dollarQuote(`[${payload.map((p) => `{"chunk_index":${p.chunk_index},"embedding":${vectorJson(p.embedding)}}`).join(",")}]`)}::jsonb`);
    lines.push(`);`);

    const name = `${String(doc.topic.n).padStart(2, "0")}_${doc.topic.slug}_${doc.lang}.sql`;
    fs.writeFileSync(path.join(args.out, name), lines.join("\n"), "utf8");
    emitted += 1;
  }

  console.log(`\nembedded in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`emitted ${emitted} files to ${path.relative(ROOT, args.out)} · ${vectorCount} vectors`);
  return 0;
}

if (require.main === module) {
  run(process.argv.slice(2)).then((code) => { process.exitCode = code; })
    .catch((error) => { console.error(`embedding emit failed: ${error.message}`); process.exitCode = 1; });
}

module.exports = { run, vectorJson };
