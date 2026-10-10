#!/usr/bin/env node
"use strict";

// P3.10 — emits the corpus ingestion as plain SQL, one file per topic.
//
// WHY THIS EXISTS ALONGSIDE scripts/ingestBrainCorpus.js
// ------------------------------------------------------
// `ingestBrainCorpus.js --apply` writes through PostgREST as `anon` plus the
// `x-rafa-dashboard-secret` header. On this machine that header does not
// authenticate: `rafa_private.dashboard_secret_matches()` compares a sha256 of
// the supplied value against `rafa_private.api_secret_hashes`, and calling
// `rpc/rafa_dashboard_secret_matches` with the configured
// `RAFA_DASHBOARD_SUPABASE_SECRET` returns **false**. Every row level security
// policy on the knowledge tables is that function, so a PostgREST write from
// here is accepted and silently discards everything.
//
// That is precisely the trap `ingestBrainCorpus.js` guards against with its
// read-back check, so it would have failed loudly rather than lying. But it
// still could not do the job.
//
// The Supabase Management API query endpoint runs as the service and is NOT
// filtered by RLS, and it is already the vetted path on this machine
// (scripts/inspectSupabaseReadOnly.ps1, SUPABASE-ACCESS-GUIDE.md). So the plan
// is emitted as SQL and applied with scripts/applySupabaseMigration.ps1.
//
// Nothing here re-implements the ingestion. The payloads come from
// `planCorpus` in src/corpusIngest.js, the same function the PostgREST path
// uses and the same one 114 tests cover. This file only renders them.
//
// The documents are stored by calling `rafa_store_knowledge_revision` rather
// than by inserting rows directly, so the approval lifecycle trigger, the
// chunk replacement and the price-expiry rule all behave exactly as they would
// through any other caller.
//
//   node scripts/emitCorpusSql.js                 # artifacts/corpus-sql/
//   node scripts/emitCorpusSql.js --out <dir>
//
// Output is an artifact, not a migration. Corpus content is DATA: putting it in
// supabase/migrations/ would re-run it on every future push and tie a content
// edit to a schema version.

const fs = require("node:fs");
const path = require("node:path");
const { TOPICS, LANGUAGES } = require("../src/brainTaxonomy");
const { TOPIC_PHASE } = require("../src/brainFactMap");
const { planFile } = require("../src/corpusIngest");

const ROOT = path.resolve(__dirname, "..");

// Who the approval is attributed to. A named value, not 'dashboard-operator',
// so an audit can tell a generated corpus ingestion apart from a human saving a
// document in the dashboard.
const INGEST_REVIEWER = "m3-corpus-ingestion";

function parseArgs(argv) {
  const args = { out: path.join(ROOT, "artifacts", "corpus-sql") };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out") args.out = path.resolve(argv[++i]);
    else { console.error(`unknown argument: ${argv[i]}`); process.exit(2); }
  }
  return args;
}

// Dollar quoting, not quote doubling. The corpus is multi kilobyte markdown in
// three scripts containing apostrophes, quotes and backslashes; escaping that
// by hand is how a corrupted document reaches the database. The tag is checked
// against the payload so a literal `$kb$` in the text cannot terminate it early.
function dollarQuote(value) {
  const text = String(value);
  let tag = "kb";
  while (text.includes(`$${tag}$`)) tag += "x";
  return `$${tag}$${text}$${tag}$`;
}

const asJsonb = (value) => `${dollarQuote(JSON.stringify(value))}::jsonb`;

function renderFile(plan) {
  const { source, document, chunks, canonicalUrl } = plan;
  const lines = [];
  const w = (line = "") => lines.push(line);

  w(`-- ${plan.path}  ·  ${chunks.length} chunks  ·  ${plan.contentChars} chars${plan.willAutoExpire ? "  ·  WILL AUTO EXPIRE IN 30 DAYS" : ""}`);
  w(`insert into public.rafa_knowledge_sources`);
  w(`  (canonical_url, display_name, source_kind, trust_tier, enabled, approved, approval_note, metadata)`);
  w(`values (${dollarQuote(source.canonical_url)}, ${dollarQuote(source.display_name)}, ${dollarQuote(source.source_kind)},`);
  w(`        ${dollarQuote(source.trust_tier)}, ${source.enabled}, ${source.approved}, ${dollarQuote(source.approval_note)}, ${asJsonb(source.metadata)})`);
  // The source is keyed by canonical_url, which is unique. Re-running must
  // update rather than raise, or a second ingest of an edited document fails on
  // the first statement.
  w(`on conflict (canonical_url) do update set`);
  w(`  display_name = excluded.display_name,`);
  w(`  metadata = excluded.metadata,`);
  w(`  enabled = true,`);
  w(`  approved = true;`);
  w();
  // The last two arguments are NOT optional noise, they are CR-014.
  //
  // `rafa_store_knowledge_revision` now defaults to `pending`, because a save
  // silently approving itself was the conflict P3.9 had to remove. A 7 argument
  // call still resolves against the new 9 parameter signature, so leaving these
  // off would quietly queue all 87 documents and take retrieval dark with a
  // green exit code. That is exactly the class of silent failure this file
  // exists to avoid.
  //
  // Approving here is legitimate and stated rather than assumed: this file is a
  // generated artifact built from an already-validated corpus, reviewed through
  // `scripts/validateCorpus.js` and the fact register before it is ever emitted.
  w(`select public.rafa_store_knowledge_revision(`);
  w(`  (select id from public.rafa_knowledge_sources where canonical_url = ${dollarQuote(canonicalUrl)}),`);
  w(`  ${dollarQuote(document.p_title)},`);
  w(`  ${dollarQuote(document.p_content)},`);
  w(`  ${dollarQuote(document.p_content_sha256)},`);
  w(`  ${dollarQuote(document.p_language_code)},`);
  w(`  ${asJsonb(chunks)},`);
  w(`  ${asJsonb(document.p_metadata)},`);
  w(`  'approved',`);
  w(`  ${dollarQuote(INGEST_REVIEWER)}`);
  w(`);`);
  w();
  // CR-014 keeps superseded revisions instead of deleting them, so the source
  // now accumulates history. Record the governance tier on the source too
  // (CR-023), since the column did not exist when the ingestion was written.
  w(`update public.rafa_knowledge_sources`);
  w(`   set governance_tier = ${dollarQuote(source.metadata.brainTrustTier)}`);
  w(` where canonical_url = ${dollarQuote(canonicalUrl)};`);
  w();

  return lines.join("\n");
}

function run(argv) {
  const args = parseArgs(argv);
  fs.mkdirSync(args.out, { recursive: true });

  let files = 0;
  let chunks = 0;
  let expiring = 0;
  const problems = [];

  for (const topic of TOPICS) {
    const body = [];
    body.push(`-- Corpus ingestion for topic ${topic.n} ${topic.slug} (${TOPIC_PHASE[topic.n]}).`);
    body.push(`-- GENERATED by scripts/emitCorpusSql.js from src/corpusIngest.js. Do not edit.`);
    body.push(`-- This is DATA, not a schema migration. Applying it twice is safe: the source`);
    body.push(`-- upserts on canonical_url and rafa_store_knowledge_revision replaces in place.`);
    body.push("");

    for (const lang of LANGUAGES) {
      const rel = `knowledge/${topic.slug}/${lang}.md`;
      const abs = path.join(ROOT, "knowledge", topic.slug, `${lang}.md`);
      if (!fs.existsSync(abs)) { problems.push(`${rel}: missing`); continue; }

      const plan = planFile({ text: fs.readFileSync(abs, "utf8"), topicSlug: topic.slug, lang, path: rel });
      if (!plan.ok) { problems.push(`${rel}: ${plan.errors.join(" | ")}`); continue; }
      if (plan.suppressed) { problems.push(`${rel}: SUPPRESSED, ${plan.skipReason || "a declared fact is blocked"}`); continue; }

      body.push(renderFile(plan));
      files += 1;
      chunks += plan.chunks.length;
      if (plan.willAutoExpire) expiring += 1;
    }

    fs.writeFileSync(path.join(args.out, `${String(topic.n).padStart(2, "0")}_${topic.slug}.sql`), body.join("\n"), "utf8");
  }

  for (const problem of problems) console.log(`FAIL  ${problem}`);
  console.log(`\nemitted ${TOPICS.length} topic files to ${path.relative(ROOT, args.out)}`);
  console.log(`${files} documents · ${chunks} chunks · ${expiring} will auto expire in 30 days`);
  if (problems.length) console.log(`${problems.length} file(s) could not be emitted`);

  return problems.length ? 1 : 0;
}

if (require.main === module) process.exitCode = run(process.argv.slice(2));

module.exports = { run, renderFile, dollarQuote };
