#!/usr/bin/env node
"use strict";

// Regenerates artifacts/refal-brain-golden-set.json from the source modules.
//
// artifacts/ is gitignored, so the JSON is NOT version controlled. The source
// of truth is src/brainGoldenSet*.js and src/brainTaxonomy.js; this file makes
// the artifact reproducible instead of a one-off.
//
// Usage: node scripts/buildGoldenSetArtifact.js

const fs = require("fs");
const path = require("path");
const golden = require("../src/brainGoldenSet");
const { TOPICS, LANGUAGES, canonicalUrl } = require("../src/brainTaxonomy");

const OUT_DIR = path.join(__dirname, "..", "artifacts");
const OUT_FILE = path.join(OUT_DIR, "refal-brain-golden-set.json");

function build() {
  return {
    generatedAt: new Date().toISOString().slice(0, 10),
    phase: "P0.4",
    note: "Generated from src/brainGoldenSet*.js. Do not hand edit; regenerate with scripts/buildGoldenSetArtifact.js",
    counts: {
      questions: golden.ENTRIES.length,
      negativeQueries: golden.NEGATIVE_QUERIES.length,
      topics: TOPICS.length,
      languages: LANGUAGES.length,
      sources: TOPICS.length * LANGUAGES.length,
    },
    rubric: golden.RUBRIC,
    thresholds: golden.THRESHOLDS,
    taxonomy: TOPICS.map((t) => ({
      ...t,
      canonicalUrls: LANGUAGES.reduce((acc, l) => { acc[l] = canonicalUrl(t.slug, l); return acc; }, {}),
    })),
    questions: golden.ENTRIES,
    negativeQueries: golden.NEGATIVE_QUERIES,
  };
}

function main() {
  const errors = golden.validateAll();
  if (errors.length) {
    process.stderr.write(`Refusing to write artifact: ${errors.length} validation error(s)\n`);
    for (const e of errors.slice(0, 10)) process.stderr.write(`  ${e}\n`);
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const payload = build();
  fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2));
  const { size } = fs.statSync(OUT_FILE);
  process.stdout.write(`wrote ${path.relative(path.join(__dirname, ".."), OUT_FILE)}  ${(size / 1024).toFixed(0)} KB\n`);
  process.stdout.write(`  questions=${payload.counts.questions} negatives=${payload.counts.negativeQueries} topics=${payload.counts.topics}\n`);
}

if (require.main === module) main();

module.exports = { build };
