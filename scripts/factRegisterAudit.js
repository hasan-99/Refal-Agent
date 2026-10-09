#!/usr/bin/env node
"use strict";

// P3.9 — the standing audit for the fact register. Named in section 17 of the
// plan as one of three scripts that did not exist yet; this is one of them.
//
// It answers four questions an operator actually has:
//
//   1. Is every number REFAL may state backed by a register row? (W3.9.2)
//   2. Is any row about to stop being stated, or has one already? (W3.9.5)
//   3. Does the corpus on disk agree with the register about which facts exist?
//   4. Does the generated seed migration still match the catalogue?
//
// Offline by default and by design. The register's offline source of truth is
// `seedRegister()`, which is the same data the seed migration carries, so the
// audit is meaningful before the migration is ever applied.
//
//   node scripts/factRegisterAudit.js
//   node scripts/factRegisterAudit.js --days 30     # widen the review horizon
//   node scripts/factRegisterAudit.js --json
//   node scripts/factRegisterAudit.js --now 2027-01-01   # what breaks, and when

const fs = require("node:fs");
const path = require("node:path");
const { TOPICS, LANGUAGES } = require("../src/brainTaxonomy");
const { FACT_IDS, requiredFactsForTopic, supportingFactsForTopic, normalizeFactId } = require("../src/brainFactMap");
const {
  seedRegister, auditRegister, factsExpiringWithin, expiredFacts,
  effectiveStatus, factBehaviour, STATUS, HIGH_RISK_FACTS,
} = require("../src/factRegister");
const { validateCorpusFile } = require("../src/corpusFile");
const { render: renderSeed, OUT: SEED_PATH } = require("./generateFactRegisterSeed");

const ROOT = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const args = { days: 7, json: false, now: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--json") args.json = true;
    else if (a === "--days") args.days = Number(argv[++i]);
    else if (a === "--now") args.now = argv[++i];
    else { console.error(`unknown argument: ${a}`); process.exit(2); }
  }
  if (!Number.isFinite(args.days) || args.days < 0) { console.error("--days must be a non-negative number"); process.exit(2); }
  if (args.now && !/^\d{4}-\d{2}-\d{2}$/u.test(args.now)) { console.error("--now must be YYYY-MM-DD"); process.exit(2); }
  return args;
}

// What the corpus on disk actually claims, read through the same validator the
// phase gate uses so the two can never disagree about what a file declares.
function readCorpusFacts() {
  const declared = new Map();   // factId -> [ "topic/lang", ... ]
  const unreadable = [];
  for (const topic of TOPICS) {
    for (const lang of LANGUAGES) {
      const rel = `knowledge/${topic.slug}/${lang}.md`;
      const abs = path.join(ROOT, "knowledge", topic.slug, `${lang}.md`);
      if (!fs.existsSync(abs)) { unreadable.push(`${rel}: missing`); continue; }
      const result = validateCorpusFile(fs.readFileSync(abs, "utf8"), { topicSlug: topic.slug, lang, path: rel });
      if (!result.parsed) { unreadable.push(`${rel}: unparseable`); continue; }
      const ids = [...result.parsed.meta.facts, ...(result.parsed.meta.supporting || [])];
      for (const id of ids.map(normalizeFactId)) {
        if (!declared.has(id)) declared.set(id, []);
        declared.get(id).push(`${topic.slug}/${lang}`);
      }
    }
  }
  return { declared, unreadable };
}

function run(argv) {
  const args = parseArgs(argv);
  const now = args.now;
  const register = seedRegister();
  const findings = [];
  const add = (severity, id, message) => findings.push({ severity, id, message });

  // ---- 1. the register's own invariants
  for (const problem of auditRegister({ register, now })) {
    add(problem.severity, problem.id, problem.message);
  }

  // ---- 2. the corpus and the register must name the same facts
  const { declared, unreadable } = readCorpusFacts();
  for (const note of unreadable) add("blocker", "-", `corpus is not readable: ${note}`);

  for (const [id, where] of declared) {
    const behaviour = factBehaviour(id, { register, now });
    if (!behaviour.row) {
      add("blocker", id, `declared by ${where.length} corpus file(s) but has no register row, so nothing governs it`);
      continue;
    }
    if (behaviour.status === STATUS.BLOCKED) {
      add("high", id, `is blocked but still declared by ${where.join(", ")}; those sections are dropped at ingest and the documents lose content silently`);
    } else if (!behaviour.statable) {
      add("high", id, `is ${behaviour.status} and still declared by ${where.length} corpus file(s); REFAL will deflect instead of stating it`);
    }
  }

  // A fact a topic is required to state, that no file declares, means the
  // corpus does not actually cover what the map says it covers.
  for (const topic of TOPICS) {
    for (const id of requiredFactsForTopic(topic.slug)) {
      const sites = declared.get(id) || [];
      const mine = sites.filter((s) => s.startsWith(`${topic.slug}/`));
      if (mine.length !== LANGUAGES.length) {
        add("high", id, `${topic.slug} must state it in all ${LANGUAGES.length} languages but only ${mine.length} file(s) declare it`);
      }
    }
    // A citable fact nobody cites is dead configuration, worth knowing but not
    // worth failing over.
    for (const id of supportingFactsForTopic(topic.slug)) {
      const cited = (declared.get(id) || []).some((s) => s.startsWith(`${topic.slug}/`));
      if (!cited) add("low", id, `${topic.slug} lists it as supporting but no file cites it`);
    }
  }

  // ---- 3. every registered number has somewhere to be said
  for (const id of FACT_IDS) {
    const row = register.get(id);
    if (!row || !row.numbers.length || id.startsWith("MB-DYN")) continue;
    if (!declared.has(id)) {
      add("medium", id, `carries ${row.numbers.length} registered number(s) that no corpus file declares, so the row governs nothing`);
    }
  }

  // ---- 4. the generated seed must not have gone stale
  if (!fs.existsSync(SEED_PATH)) {
    add("blocker", "-", `the seed migration is missing. Run: node scripts/generateFactRegisterSeed.js`);
  } else if (fs.readFileSync(SEED_PATH, "utf8") !== renderSeed()) {
    add("blocker", "-", `the seed migration is stale against src/factCatalogue.js. Run: node scripts/generateFactRegisterSeed.js`);
  }

  // ---- the review horizon
  const due = factsExpiringWithin(args.days, { register, now });
  const expired = expiredFacts({ register, now });

  const severities = ["blocker", "high", "medium", "low"];
  const counts = Object.fromEntries(severities.map((s) => [s, findings.filter((f) => f.severity === s).length]));
  const failing = counts.blocker + counts.high;

  if (args.json) {
    console.log(JSON.stringify({ counts, failing, findings, due, expired: expired.map((r) => r.id) }, null, 2));
  } else {
    for (const severity of severities) {
      const rows = findings.filter((f) => f.severity === severity);
      if (!rows.length) continue;
      console.log(`\n${severity.toUpperCase()}`);
      for (const row of rows) console.log(`  ${row.id.padEnd(10)} ${row.message}`);
    }
    console.log(`\nreview horizon: ${args.days} days from ${now || "today"}`);
    if (!due.length) console.log("  nothing is due for review");
    for (const row of due) {
      const label = row.daysLeft < 0 ? `${-row.daysLeft} days OVERDUE` : `${row.daysLeft} days left`;
      console.log(`  ${row.id.padEnd(10)} ${row.expiryOrReviewAt}  ${label}${row.highRisk ? "  [high risk]" : ""}  ${row.claimText.slice(0, 70)}`);
    }
    console.log(`\nregister: ${register.size} rows · ${HIGH_RISK_FACTS.length} high risk · ${expired.length} expired · ${due.length} due within ${args.days} days`);
    console.log(`findings: ${counts.blocker} blocker · ${counts.high} high · ${counts.medium} medium · ${counts.low} low`);
    console.log(failing ? `\nFAIL  ${failing} blocking finding(s)` : "\nok    no blocking findings");
  }

  return failing ? 1 : 0;
}

if (require.main === module) process.exitCode = run(process.argv.slice(2));

module.exports = { run, readCorpusFacts };
