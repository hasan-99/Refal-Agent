#!/usr/bin/env node
"use strict";

// M3 — offline gate for the knowledge corpus.
//
// Walks knowledge/<topic-slug>/<lang>.md for all 29 x 3 = 87 expected files and
// runs validateCorpusFile over each. Needs no database and no network, so it is
// the check that runs on every edit; brainHealth.js (W3.10.6) is its database
// aware big brother and reuses the same rules.
//
//   node scripts/validateCorpus.js                 # all 87
//   node scripts/validateCorpus.js --topic ip-box  # one topic
//   node scripts/validateCorpus.js --phase P3.2    # one plan phase
//   node scripts/validateCorpus.js --json
//
// Exit 0 only when every expected file exists and every file is clean.

const fs = require("node:fs");
const path = require("node:path");
const { TOPICS, LANGUAGES } = require("../src/brainTaxonomy");
const { TOPIC_PHASE, requiredFactsForTopic } = require("../src/brainFactMap");
const { validateCorpusFile } = require("../src/corpusFile");

const ROOT = path.resolve(__dirname, "..");
const CORPUS_DIR = path.join(ROOT, "knowledge");

function parseArgs(argv) {
  const args = { topic: null, phase: null, json: false, lang: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--json") args.json = true;
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

function run(argv) {
  const args = parseArgs(argv);
  const topics = selectTopics(args);
  const langs = args.lang ? [args.lang] : LANGUAGES;

  const files = [];
  for (const topic of topics) {
    for (const lang of langs) {
      const rel = path.join("knowledge", topic.slug, `${lang}.md`);
      const abs = path.join(CORPUS_DIR, topic.slug, `${lang}.md`);
      const row = {
        topic: topic.slug, topicNumber: topic.n, phase: TOPIC_PHASE[topic.n], lang, path: rel,
        exists: fs.existsSync(abs), errors: [], warnings: [], sections: 0, facts: [], chars: 0,
      };
      if (!row.exists) {
        row.errors.push(`${rel}: MISSING — required facts ${requiredFactsForTopic(topic.slug).join(", ")}`);
        files.push(row);
        continue;
      }
      const text = fs.readFileSync(abs, "utf8");
      const result = validateCorpusFile(text, { topicSlug: topic.slug, lang, path: rel });
      row.errors = result.errors;
      row.warnings = result.warnings;
      if (result.parsed) {
        row.sections = result.parsed.sections.length;
        row.facts = result.parsed.meta.facts;
        row.aliases = result.parsed.meta.aliases.length;
        row.chars = (result.body || "").length;
      }
      files.push(row);
    }
  }

  const broken = files.filter((f) => f.errors.length);
  const missing = files.filter((f) => !f.exists);
  const summary = {
    expected: files.length,
    present: files.length - missing.length,
    missing: missing.length,
    clean: files.length - broken.length,
    broken: broken.length,
    errors: broken.reduce((a, f) => a + f.errors.length, 0),
    chars: files.reduce((a, f) => a + f.chars, 0),
  };

  if (args.json) {
    console.log(JSON.stringify({ summary, files }, null, 2));
  } else {
    for (const f of broken) for (const e of f.errors) console.log(`FAIL  ${e}`);
    const byPhase = new Map();
    for (const f of files) {
      const row = byPhase.get(f.phase) || { present: 0, clean: 0, total: 0 };
      row.total += 1;
      if (f.exists) row.present += 1;
      if (f.exists && !f.errors.length) row.clean += 1;
      byPhase.set(f.phase, row);
    }
    console.log("");
    for (const phase of [...byPhase.keys()].sort()) {
      const r = byPhase.get(phase);
      console.log(`  ${phase}  present ${r.present}/${r.total}  clean ${r.clean}/${r.total}`);
    }
    console.log("");
    console.log(`corpus: ${summary.present}/${summary.expected} present · ${summary.clean} clean · ${summary.broken} with errors (${summary.errors} total) · ${summary.chars} body chars`);
  }

  return broken.length ? 1 : 0;
}

if (require.main === module) process.exitCode = run(process.argv.slice(2));

module.exports = { run };
