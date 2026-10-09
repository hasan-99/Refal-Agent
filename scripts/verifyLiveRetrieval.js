#!/usr/bin/env node
"use strict";

// P3.10 G3 — the live retrieval check, against the real search RPC.
//
// Everything before this was a PROXY. `scripts/brainHealth.js` measures token
// overlap against the corpus FILES and says so in its own output. This runs the
// actual question through `public.rafa_search_knowledge` in Postgres, which is
// `websearch_to_tsquery` plus the term-coverage fallback, over the real stored
// chunks and their real `search_vector`. The two can disagree, and where they
// do, this one is right.
//
// The criterion, from the M3 exit gate: a golden question must retrieve **its
// own topic in the customer's own language, inside the top 5**, and a negative
// query must retrieve **nothing at all**.
//
// `canonical_url` is `refal://kb/<domain>/<slug>/<lang>`, so a hit is checked by
// suffix rather than by joining back through the source table, which keeps the
// whole evaluation to one SQL round trip per batch.
//
// It goes through the Management API because the PostgREST path on this machine
// cannot authenticate (FIX-34 / CF-07). The RPC is `stable`, so this is a
// read_only query and nothing is written.
//
//   node scripts/verifyLiveRetrieval.js                 # all languages
//   node scripts/verifyLiveRetrieval.js --lang ar
//   node scripts/verifyLiveRetrieval.js --limit 30      # a quick smoke
//   node scripts/verifyLiveRetrieval.js --top 5

const { execFileSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { ENTRIES, NEGATIVE_QUERIES } = require("../src/brainGoldenSet");
const { LANGUAGES } = require("../src/brainTaxonomy");

const ROOT = path.resolve(__dirname, "..");
const QUERY_SCRIPT = path.join(ROOT, "scripts", "querySupabaseReadOnly.ps1");
const BATCH = 40;

function parseArgs(argv) {
  const args = { lang: null, limit: 0, top: 5, hybrid: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--lang") args.lang = argv[++i];
    else if (a === "--limit") args.limit = Number(argv[++i]);
    else if (a === "--top") args.top = Number(argv[++i]);
    else if (a === "--hybrid") args.hybrid = true;
    else if (a === "--json") args.json = argv[++i];
    else { console.error(`unknown argument: ${a}`); process.exit(2); }
  }
  return args;
}

const quote = (value) => `'${String(value).replace(/'/gu, "''")}'`;

// The SQL goes through a temp FILE, not an argument. A hybrid batch carries a
// 2048 wide vector per row, and Windows caps a command line near 32k, so the
// argument form dies with ENAMETOOLONG.
function runQuery(sql) {
  const file = path.join(os.tmpdir(), `refal-retrieval-${process.pid}.sql`);
  fs.writeFileSync(file, sql, "utf8");
  let out;
  try {
    out = execFileSync("pwsh", ["-NoProfile", "-File", QUERY_SCRIPT, "-QueryFile", file, "-AsService"], {
      encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } finally {
    fs.rmSync(file, { force: true });
  }
  if (out.startsWith("QUERY FAILED")) throw new Error(out);
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) ? parsed : [parsed];
}

// One round trip per batch. The lateral subquery asks only whether the right
// document appears, so the vectors never cross the wire.
function positiveSql(rows, top) {
  const values = rows.map((r) => `(${quote(r.id)}, ${quote(r.topic)}, ${quote(r.lang)}, ${quote(r.question)})`).join(",\n    ");
  return `
  with q(id, topic, lang, question) as (values
    ${values}
  )
  select q.id, q.topic, q.lang,
    coalesce((select bool_or(s.source_url like '%/' || q.topic || '/' || q.lang)
              from public.rafa_search_knowledge(q.question, ${top}) s), false) as own_topic,
    coalesce((select bool_or(s.source_url like '%/' || q.topic || '/%')
              from public.rafa_search_knowledge(q.question, ${top}) s), false) as any_language,
    coalesce((select count(*) from public.rafa_search_knowledge(q.question, ${top}) s), 0) as results
  from q;`;
}

// The HYBRID path, which is what production actually runs. `src/bot.js` and
// `src/agentTools.js` embed the question with `embedText` and hand the vector to
// `searchKnowledge`, and the edge function then picks
// `rafa_hybrid_search_knowledge` whenever the embedding is 2048 finite numbers.
// Measuring only the lexical RPC understates the live system, because the
// semantic branch is exactly what carries a question whose wording does not
// match the document's wording.
//
// `embedText` is used here, NOT `embedTexts`: this is an E5 model and a query
// takes the `query: ` prefix while stored passages took `passage: `. Swapping
// them silently degrades every score.
function hybridSql(rows, top, model) {
  const values = rows.map((r) =>
    `(${quote(r.id)}, ${quote(r.topic)}, ${quote(r.lang)}, ${quote(r.question)}, ${quote(`[${r.embedding.join(",")}]`)})`).join(",\n    ");
  return `
  with q(id, topic, lang, question, embedding) as (values
    ${values}
  )
  select q.id, q.topic, q.lang,
    coalesce((select bool_or(s.source_url like '%/' || q.topic || '/' || q.lang)
              from public.rafa_hybrid_search_knowledge(q.question, q.embedding::extensions.halfvec, ${quote(model)}, ${top}) s), false) as own_topic,
    coalesce((select bool_or(s.source_url like '%/' || q.topic || '/%')
              from public.rafa_hybrid_search_knowledge(q.question, q.embedding::extensions.halfvec, ${quote(model)}, ${top}) s), false) as any_language,
    coalesce((select count(*) from public.rafa_hybrid_search_knowledge(q.question, q.embedding::extensions.halfvec, ${quote(model)}, ${top}) s), 0) as results
  from q;`;
}

function negativeHybridSql(rows, top, model) {
  const values = rows.map((r) =>
    `(${quote(r.id)}, ${quote(r.q)}, ${quote(r.why)}, ${quote(`[${r.embedding.join(",")}]`)})`).join(",\n    ");
  return `
  with q(id, question, why, embedding) as (values
    ${values}
  )
  select q.id, q.why,
    coalesce((select count(*) from public.rafa_hybrid_search_knowledge(q.question, q.embedding::extensions.halfvec, ${quote(model)}, ${top}) s), 0) as results
  from q;`;
}

function negativeSql(rows, top) {
  const values = rows.map((r) => `(${quote(r.id)}, ${quote(r.q)}, ${quote(r.why)})`).join(",\n    ");
  return `
  with q(id, question, why) as (values
    ${values}
  )
  select q.id, q.why,
    coalesce((select count(*) from public.rafa_search_knowledge(q.question, ${top}) s), 0) as results
  from q;`;
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

async function run(argv) {
  const args = parseArgs(argv);
  let positives = ENTRIES.filter((e) => e.topic);
  if (args.lang) positives = positives.filter((e) => e.lang === args.lang);
  if (args.limit) positives = positives.slice(0, args.limit);
  let negativeRows = NEGATIVE_QUERIES;

  const rpc = args.hybrid ? "rafa_hybrid_search_knowledge" : "rafa_search_knowledge";
  console.log(`live retrieval against ${rpc}, top ${args.top}`);
  console.log(`${positives.length} golden questions · ${NEGATIVE_QUERIES.length} negative queries\n`);

  let model = "";
  // A vector per row makes each statement large, so the hybrid batches are much
  // smaller than the lexical ones.
  let batchSize = BATCH;
  if (args.hybrid) {
    const { embedText, DEFAULT_EMBEDDING_MODEL } = require("../src/ai");
    model = DEFAULT_EMBEDDING_MODEL;
    batchSize = 8;
    process.stdout.write("  embedding questions ");
    const withVectors = [];
    for (const entry of positives) {
      withVectors.push({ ...entry, embedding: await embedText(entry.question) });
      if (withVectors.length % 50 === 0) process.stdout.write(".");
    }
    positives = withVectors;
    negativeRows = [];
    for (const entry of NEGATIVE_QUERIES) {
      negativeRows.push({ ...entry, embedding: await embedText(entry.q) });
    }
    console.log(` done, ${positives.length} query vectors`);
  }

  const results = [];
  const batches = chunk(positives, batchSize);
  for (const [i, batch] of batches.entries()) {
    process.stdout.write(`\r  batch ${i + 1}/${batches.length}   `);
    results.push(...runQuery(args.hybrid ? hybridSql(batch, args.top, model) : positiveSql(batch, args.top)));
  }
  process.stdout.write("\r");

  const byLang = {};
  for (const lang of LANGUAGES) {
    const rows = results.filter((r) => r.lang === lang);
    if (!rows.length) continue;
    byLang[lang] = {
      total: rows.length,
      ownTopic: rows.filter((r) => r.own_topic).length,
      anyLanguage: rows.filter((r) => r.any_language).length,
      nothing: rows.filter((r) => Number(r.results) === 0).length,
    };
  }

  const negatives = args.hybrid
    ? chunk(negativeRows, batchSize).flatMap((b) => runQuery(negativeHybridSql(b, args.top, model)))
    : runQuery(negativeSql(negativeRows, args.top));
  const leaking = negatives.filter((r) => Number(r.results) > 0);

  const ownTotal = results.filter((r) => r.own_topic).length;
  const anyTotal = results.filter((r) => r.any_language).length;
  const nothing = results.filter((r) => Number(r.results) === 0);

  console.log("  lang   own topic in top N      right topic, any language   retrieved nothing");
  for (const lang of Object.keys(byLang)) {
    const s = byLang[lang];
    const pct = (n) => `${((n / s.total) * 100).toFixed(1)}%`;
    console.log(`  ${lang}     ${String(s.ownTopic).padStart(3)}/${s.total}  ${pct(s.ownTopic).padStart(6)}        ${String(s.anyLanguage).padStart(3)}/${s.total}  ${pct(s.anyLanguage).padStart(6)}            ${s.nothing}`);
  }
  console.log(`\n  overall own topic : ${ownTotal}/${results.length}  ${((ownTotal / results.length) * 100).toFixed(1)}%   (M3 gate is 95%)`);
  console.log(`  overall any lang  : ${anyTotal}/${results.length}  ${((anyTotal / results.length) * 100).toFixed(1)}%`);
  console.log(`  retrieved nothing : ${nothing.length}`);
  console.log(`  negative queries  : ${NEGATIVE_QUERIES.length - leaking.length}/${NEGATIVE_QUERIES.length} correctly returned nothing`);

  for (const row of leaking) console.log(`  LEAK  ${row.id} (${row.why}) returned ${row.results} result(s)`);
  if (nothing.length) {
    console.log(`\n  questions that retrieved NOTHING at all (first 15):`);
    for (const row of nothing.slice(0, 15)) console.log(`    ${row.id}  ${row.topic}/${row.lang}`);
  }

  // Keep the per question verdicts. A 15 minute run that prints only a
  // percentage makes the next question ("which ones?") cost another 15 minutes.
  if (args.json) {
    const misses = results.filter((r) => !r.own_topic).map((r) => ({
      id: r.id, topic: r.topic, lang: r.lang, results: Number(r.results),
      question: (positives.find((p) => p.id === r.id) || {}).question,
    }));
    fs.writeFileSync(args.json, JSON.stringify({ rpc, top: args.top, byLang, misses, leaking }, null, 2), "utf8");
    console.log(`\n  wrote ${misses.length} misses to ${args.json}`);
  }

  const passes = ownTotal / results.length >= 0.95 && leaking.length === 0;
  console.log(passes ? "\nok    M3 live retrieval gate met" : "\nFAIL  M3 live retrieval gate NOT met");
  return passes ? 0 : 1;
}

if (require.main === module) {
  run(process.argv.slice(2)).then((code) => { process.exitCode = code; })
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { run, positiveSql, negativeSql, hybridSql };
