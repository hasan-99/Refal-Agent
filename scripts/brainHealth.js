#!/usr/bin/env node
"use strict";

// M3 / W3.10.6 — the standing health check for the knowledge brain, and the
// gate for milestone M3's G3.
//
//   node scripts/brainHealth.js                   # all 87 cells, offline
//   node scripts/brainHealth.js --topic ip-box
//   node scripts/brainHealth.js --lang ar
//   node scripts/brainHealth.js --phase P3.2
//   node scripts/brainHealth.js --json
//   node scripts/brainHealth.js --db              # also check Supabase
//
// This is scripts/validateCorpus.js's database aware big brother. It REUSES
// validateCorpusFile rather than reimplementing any of it: the file-shape rules
// live in one place and this script adds the four things the validator cannot
// see — whether the register still approves the facts a document stands on,
// whether the golden questions can reach the document at all, whether a
// negative query can reach it, and what the database actually holds.
//
// All the judgement lives in src/brainHealth.js so it can be tested without a
// corpus and without a database. This file is the I/O shell: it gathers, it
// prints, it sets the exit code.
//
// EXIT CODES
//   0  no gap
//   1  at least one gap, or a --db run that could not reach the database
//   2  bad arguments
//
// PENDING DB is NOT a gap. An offline run can be green while nothing in the
// database has been looked at, which is why every pending check is printed and
// counted in the summary rather than omitted.

const fs = require("node:fs");
const path = require("node:path");

const { TOPICS, LANGUAGES, canonicalUrl } = require("../src/brainTaxonomy");
const { TOPIC_PHASE, requiredFactsForTopic } = require("../src/brainFactMap");
const { validateCorpusFile } = require("../src/corpusFile");
const { seedRegister, factsExpiringWithin } = require("../src/factRegister");
const { ENTRIES, NEGATIVE_QUERIES } = require("../src/brainGoldenSet");
const health = require("../src/brainHealth");

const ROOT = path.resolve(__dirname, "..");
const CORPUS_DIR = path.join(ROOT, "knowledge");

// ------------------------------------------------------------------- args
// Same shape and the same exit-2 discipline as validateCorpus.js, plus --db.
function parseArgs(argv) {
  const args = { topic: null, phase: null, lang: null, json: false, db: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--json") args.json = true;
    else if (a === "--db") args.db = true;
    else if (a === "--topic") args.topic = argv[++i];
    else if (a === "--phase") args.phase = argv[++i];
    else if (a === "--lang") args.lang = argv[++i];
    else { console.error(`unknown argument: ${a}`); process.exit(2); }
  }
  if (args.lang && !LANGUAGES.includes(args.lang)) {
    console.error(`unknown language: ${args.lang} (known: ${LANGUAGES.join(", ")})`);
    process.exit(2);
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

// ------------------------------------------------------------- gathering
// One cell per topic x language, carrying everything the pure rules need and
// nothing they do not.
//
// `chunkCount` is the number of `## ` sections. The authoring contract makes
// one section one chunk (section 3: "the 1800 ceiling is the chunk limit"), so
// the file's section count is what ingestion should store. It is derived here
// rather than imported from the ingestion module on purpose: if the ingester
// ever chunks differently, the --db comparison reports the divergence instead
// of agreeing with it by construction.
function gatherCells(topics, langs) {
  const cells = [];
  for (const topic of topics) {
    for (const lang of langs) {
      const rel = path.join("knowledge", topic.slug, `${lang}.md`).replace(/\\/g, "/");
      const abs = path.join(CORPUS_DIR, topic.slug, `${lang}.md`);
      const cell = {
        topic: topic.slug, topicNumber: topic.n, phase: TOPIC_PHASE[topic.n], lang, path: rel,
        canonicalUrl: canonicalUrl(topic.slug, lang),
        exists: fs.existsSync(abs),
        errors: [], warnings: [],
        title: "", aliases: [], facts: [], supporting: [], sections: [], chunkCount: 0, chars: 0,
      };
      if (!cell.exists) {
        cell.errors.push(`${rel}: MISSING — required facts ${requiredFactsForTopic(topic.slug).join(", ")}`);
        cells.push(cell);
        continue;
      }
      const text = fs.readFileSync(abs, "utf8");
      const result = validateCorpusFile(text, { topicSlug: topic.slug, lang, path: rel });
      cell.errors = result.errors;
      cell.warnings = result.warnings;
      if (result.parsed && result.parsed.meta) {
        const { meta, sections } = result.parsed;
        cell.title = meta.title || "";
        cell.aliases = meta.aliases || [];
        cell.facts = meta.facts || [];
        cell.supporting = meta.supporting || [];
        cell.sections = (sections || []).map((s) => ({ heading: s.heading, body: s.body }));
        cell.chunkCount = cell.sections.length;
        cell.chars = (result.body || "").length;
      }
      cells.push(cell);
    }
  }
  return cells;
}

// ---------------------------------------------------------------- database
// The same REST plumbing as scripts/backfillKnowledgeEmbeddings.js: the
// publishable key plus the dashboard secret header. Note that this credential
// deliberately does NOT reach refal_fact_register, which is service_role only —
// see REGISTER_BLOCKER in src/brainHealth.js.
function restClient() {
  const baseUrl = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const key = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;
  const secret = process.env.RAFA_DASHBOARD_SUPABASE_SECRET;
  if (!baseUrl || !key || !secret) throw new Error("Supabase REST configuration is incomplete (SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, RAFA_DASHBOARD_SUPABASE_SECRET).");
  return async (pathname, options = {}) => {
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

// Map<canonical_url, { source, document, chunkCount, embeddedCount, embeddingModels }>
async function gatherDatabase(cells) {
  const rest = restClient();
  const index = new Map();
  const urls = cells.filter((c) => c.exists).map((c) => c.canonicalUrl);
  if (!urls.length) return index;

  const inList = (values) => `(${values.map((v) => `"${String(v).replace(/"/gu, '\\"')}"`).join(",")})`;

  const sources = await rest(
    `rafa_knowledge_sources?select=id,canonical_url,enabled,approved&canonical_url=in.${encodeURIComponent(inList(urls))}&limit=500`,
  ) || [];

  for (const source of sources) {
    index.set(source.canonical_url, {
      sourceId: source.id,
      source: { enabled: source.enabled, approved: source.approved },
      document: null, chunkCount: 0, embeddedCount: 0, embeddingModels: [],
    });
  }
  if (!sources.length) return index;

  const documents = await rest(
    `rafa_knowledge_documents?select=id,source_id,review_status,valid_until,revision`
    + `&source_id=in.(${sources.map((s) => s.id).join(",")})&review_status=eq.approved&order=revision.desc&limit=2000`,
  ) || [];

  const bySource = new Map();
  for (const document of documents) {
    if (!bySource.has(document.source_id)) bySource.set(document.source_id, document);
  }
  for (const row of index.values()) {
    row.document = bySource.get(row.sourceId) || null;
  }

  const documentIds = [...bySource.values()].map((d) => d.id);
  if (documentIds.length) {
    const chunks = await rest(
      `rafa_knowledge_chunks?select=document_id,embedding_model,embedded_at&document_id=in.(${documentIds.join(",")})&limit=20000`,
    ) || [];
    const byDocument = new Map();
    for (const chunk of chunks) {
      const bucket = byDocument.get(chunk.document_id) || { count: 0, embedded: 0, models: new Set() };
      bucket.count += 1;
      if (chunk.embedded_at) bucket.embedded += 1;
      if (chunk.embedding_model) bucket.models.add(chunk.embedding_model);
      byDocument.set(chunk.document_id, bucket);
    }
    for (const row of index.values()) {
      const bucket = row.document ? byDocument.get(row.document.id) : null;
      if (!bucket) continue;
      row.chunkCount = bucket.count;
      row.embeddedCount = bucket.embedded;
      row.embeddingModels = [...bucket.models];
    }
  }
  return index;
}

// ------------------------------------------------------------------ report
const SEVERITY_LABEL = {
  [health.SEVERITY.GAP]: "GAP    ",
  [health.SEVERITY.WARNING]: "WARN   ",
  [health.SEVERITY.PENDING]: "PENDING",
  [health.SEVERITY.BLOCKER]: "BLOCKED",
};

function printReport(result, cells, args) {
  const { findings, summary } = result;
  const order = [health.SEVERITY.GAP, health.SEVERITY.BLOCKER, health.SEVERITY.PENDING, health.SEVERITY.WARNING];
  for (const severity of order) {
    const rows = findings.filter((f) => f.severity === severity);
    if (!rows.length) continue;
    console.log("");
    for (const row of rows) console.log(`${SEVERITY_LABEL[severity]} ${row.code}  ${row.message}`);
  }

  // Per-phase summary, same shape as validateCorpus.js.
  const byPhase = new Map();
  const lexByKey = new Map(result.lexical.map((r) => [`${r.topic}|${r.lang}`, r]));
  for (const cell of cells) {
    const row = byPhase.get(cell.phase) || { total: 0, present: 0, clean: 0, lexical: 0, questions: 0, reachable: 0 };
    row.total += 1;
    if (cell.exists) row.present += 1;
    if (cell.exists && !cell.errors.length) row.clean += 1;
    const lex = lexByKey.get(`${cell.topic}|${cell.lang}`);
    if (lex) {
      if (lex.passes) row.lexical += 1;
      row.questions += lex.questions;
      row.reachable += lex.covered;
    }
    byPhase.set(cell.phase, row);
  }

  console.log("");
  console.log("  phase   present   clean   lexical   golden reachable");
  for (const phase of [...byPhase.keys()].sort()) {
    const r = byPhase.get(phase);
    console.log(
      `  ${phase.padEnd(6)}  ${String(r.present).padStart(3)}/${String(r.total).padEnd(3)}  `
      + `${String(r.clean).padStart(3)}/${String(r.total).padEnd(3)}  `
      + `${String(r.lexical).padStart(4)}/${String(r.total).padEnd(4)}  `
      + `${String(r.reachable).padStart(5)}/${String(r.questions).padEnd(5)}`,
    );
  }

  console.log("");
  console.log("  language parity (FIX-7 is ar, FIX-8 is el)");
  for (const lang of LANGUAGES) {
    const p = summary.perLang[lang];
    if (!p) continue;
    console.log(
      `  ${lang}   files ${String(p.present).padStart(2)}/${String(p.cells).padEnd(2)}  `
      + `lexically healthy ${String(p.passing).padStart(2)}/${String(p.cells).padEnd(2)}  `
      + `mean token coverage ${(p.meanCoverage * 100).toFixed(1)}%  `
      + `(body+headings only ${(p.meanBodyCoverage * 100).toFixed(1)}%)`,
    );
  }
  console.log(
    "  body+headings is the stricter number: the live chunk search_vector is to_tsvector('simple', heading || content),\n"
    + "  so the title and the aliases reach the index only if ingestion writes them into a chunk.",
  );

  console.log("");
  console.log(
    `  lexical reachability is a PROXY for retrieval, not retrieval itself: it is token overlap at the `
    + `${Math.round(health.COVERAGE_THRESHOLD * 100)}% bar, while real retrieval is websearch_to_tsquery plus a vector search.`,
  );
  console.log(
    `  negative queries: ${summary.negatives - summary.negativesOverCeiling}/${summary.negatives} below the `
    + `${Math.round(health.NEGATIVE_MAX_COVERAGE * 100)}% over-retrieval ceiling.`,
  );
  console.log(
    `  database: ${summary.databaseChecked ? "checked" : `NOT CHECKED — ${summary.pending} checks PENDING DB over ${cells.length} cells`}`
    + `${args.db ? "" : " (pass --db)"}.`,
  );

  console.log("");
  console.log(
    `brain health: ${summary.present}/${summary.selectedCells} present · ${summary.clean} clean · `
    + `${summary.lexicalPassing}/${summary.selectedCells} lexically healthy · `
    + `${summary.goldenReachable}/${summary.goldenQuestions} golden questions reachable · `
    + `${summary.gaps} gaps · ${summary.warnings} warnings · ${summary.pending} pending db · ${summary.blockers} blockers`,
  );
}

// -------------------------------------------------------------------- main
async function run(argv) {
  const args = parseArgs(argv);
  const topics = selectTopics(args);
  const langs = args.lang ? [args.lang] : LANGUAGES;
  const selected = new Set(topics.map((t) => t.slug));

  const cells = gatherCells(topics, langs);
  const entries = ENTRIES.filter((e) => selected.has(e.topic) && langs.includes(e.lang));
  const negatives = args.lang ? NEGATIVE_QUERIES.filter((n) => langs.includes(n.lang)) : NEGATIVE_QUERIES;

  const register = seedRegister();
  const expiring = factsExpiringWithin(health.EXPIRY_WARNING_DAYS, { register });

  let db = null;
  let expectedEmbeddingModel = null;
  let databaseError = null;
  if (args.db) {
    try {
      // Both required only on the --db path so an offline run never pays for
      // loading the AI stack or reading .env.
      const { loadProjectEnv } = require("../src/env");
      loadProjectEnv(ROOT);
      ({ DEFAULT_EMBEDDING_MODEL: expectedEmbeddingModel } = require("../src/ai"));
      db = await gatherDatabase(cells);
    } catch (error) {
      // Match evaluateKnowledge.js / evaluateRag.js: never crash, report and fail.
      databaseError = String(error.message || error).slice(0, 200);
      db = null;
    }
  }

  const result = health.assessCorpus({
    cells, entries, negatives, register, expiring, db, expectedEmbeddingModel,
  });

  if (args.json) {
    console.log(JSON.stringify({
      summary: result.summary,
      databaseError,
      findings: result.findings,
      lexical: result.lexical,
      negativeQueries: result.negatives,
      cells: cells.map((c) => ({
        topic: c.topic, lang: c.lang, phase: c.phase, path: c.path, canonicalUrl: c.canonicalUrl,
        exists: c.exists, errors: c.errors.length, chunkCount: c.chunkCount, chars: c.chars,
        facts: c.facts, supporting: c.supporting,
      })),
    }, null, 2));
  } else {
    if (databaseError) console.log(`GAP     BH-DB-UNREACHABLE  --db was requested but the database could not be read: ${databaseError}`);
    printReport(result, cells, args);
  }

  const code = health.exitCodeFor(result.findings);
  return databaseError ? 1 : code;
}

if (require.main === module) {
  run(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      console.error(`brain health could not run: ${String(error.message || error).slice(0, 300)}`);
      process.exitCode = 1;
    });
}

module.exports = { run, gatherCells, gatherDatabase };
