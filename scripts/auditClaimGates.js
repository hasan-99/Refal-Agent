#!/usr/bin/env node
"use strict";

// G2 gate for P0.2 / W0.2.1 — guardrail conflict sweep.
//
// Runs every MB candidate sentence (AR/EN/EL) through the two live claim gates
// and reports BLOCK/PASS per language.
//
// Exit codes are deliberately split, because "a conflict is recorded" and "a
// conflict is fixed" are different questions and different milestones own them.
//
//   0  clean: no unregistered conflict and no safety leak.
//   1  P0.2 FAILS: an MB-required sentence is blocked and is NOT recorded in
//      docs/brain/CONFLICT-REGISTER.md. Registering it is P0.2's own job.
//   2  P0.2 PASSES, M2 owes a fix: every conflict is registered, but a control
//      sentence that must stay blocked is leaking (a fail-open). Registration
//      must never wave a safety leak through, so this is not exit 0, but it
//      also must not block P0.2 forever on a repair that belongs to M2 (P2.3).
//
// So the P0.2 phase gate condition is `exit != 1`; the M2 exit gate is `exit == 0`.
//
// Usage:
//   node scripts/auditClaimGates.js            # gate mode
//   node scripts/auditClaimGates.js --json     # machine readable
//   node scripts/auditClaimGates.js --markdown # register-ready rows

const fs = require("fs");
const path = require("path");
const { containsProhibitedClaim, restrictedRefalcoReply } = require("../src/refalcoAnswer");
const { MB_CANDIDATES, LANGUAGES } = require("../src/brainMbCandidates");

const REGISTER_PATH = path.join(__dirname, "..", "docs", "brain", "CONFLICT-REGISTER.md");

function registeredMbRefs() {
  if (!fs.existsSync(REGISTER_PATH)) return new Set();
  const text = fs.readFileSync(REGISTER_PATH, "utf8");
  return new Set(text.match(/MBC-\d{3}/gu) || []);
}

function evaluate(sentence) {
  const prohibited = containsProhibitedClaim(sentence);
  const restricted = restrictedRefalcoReply(sentence);
  return {
    prohibited,
    restricted: restricted !== null,
    blocked: prohibited || restricted !== null,
    restrictedReply: restricted,
  };
}

function run() {
  const registered = registeredMbRefs();
  const rows = [];

  for (const candidate of MB_CANDIDATES) {
    for (const lang of LANGUAGES) {
      const sentence = candidate[lang];
      if (!sentence) continue;
      const result = evaluate(sentence);
      const wanted = candidate.expect === "pass" ? "PASS" : "BLOCK";
      const actual = result.blocked ? "BLOCK" : "PASS";
      rows.push({
        id: candidate.id,
        mbRef: candidate.mbRef,
        topic: candidate.topic,
        lang,
        sentence,
        wanted,
        actual,
        conflict: wanted !== actual,
        gate: result.prohibited && result.restricted ? "both"
          : result.prohibited ? "containsProhibitedClaim"
            : result.restricted ? "restrictedRefalcoReply" : "none",
        registered: registered.has(candidate.id),
      });
    }
  }

  const conflicts = rows.filter((r) => r.conflict);
  const unregistered = conflicts.filter((r) => !r.registered);
  const leaks = conflicts.filter((r) => r.wanted === "BLOCK");

  return { rows, conflicts, unregistered, leaks, registeredCount: registered.size };
}

function pct(n, d) {
  return d === 0 ? "0.0" : ((n / d) * 100).toFixed(1);
}

function main() {
  const mode = process.argv[2] || "";
  const { rows, conflicts, unregistered, leaks, registeredCount } = run();

  if (mode === "--json") {
    process.stdout.write(`${JSON.stringify({ rows, summary: { total: rows.length, conflicts: conflicts.length, unregistered: unregistered.length, leaks: leaks.length } }, null, 2)}\n`);
  } else if (mode === "--markdown") {
    process.stdout.write("| ID | MB ref | Topic | Lang | Wanted | Actual | Gate |\n| --- | --- | --- | --- | --- | --- | --- |\n");
    for (const r of conflicts) {
      process.stdout.write(`| ${r.id} | ${r.mbRef} | ${r.topic} | ${r.lang} | ${r.wanted} | ${r.actual} | \`${r.gate}\` |\n`);
    }
  } else {
    const byLang = {};
    for (const lang of LANGUAGES) {
      const langRows = rows.filter((r) => r.lang === lang);
      byLang[lang] = { total: langRows.length, conflicts: langRows.filter((r) => r.conflict).length };
    }
    process.stdout.write("REFAL claim gate audit (P0.2 / W0.2.1)\n");
    process.stdout.write(`${"=".repeat(60)}\n`);
    process.stdout.write(`Sentences tested : ${rows.length} (${MB_CANDIDATES.length} candidates x ${LANGUAGES.length} languages)\n`);
    process.stdout.write(`Conflicts        : ${conflicts.length}  (${pct(conflicts.length, rows.length)}%)\n`);
    for (const lang of LANGUAGES) {
      process.stdout.write(`  ${lang}: ${byLang[lang].conflicts}/${byLang[lang].total} conflicting\n`);
    }
    process.stdout.write(`Registered IDs   : ${registeredCount}\n`);
    process.stdout.write(`Unregistered     : ${unregistered.length}\n`);
    process.stdout.write(`Control leaks    : ${leaks.length}\n`);
    if (conflicts.length) {
      process.stdout.write(`\n${"-".repeat(60)}\nConflicting sentences:\n`);
      for (const r of conflicts) {
        const flag = r.registered ? "registered" : "UNREGISTERED";
        process.stdout.write(`  [${flag}] ${r.id} ${r.lang} ${r.wanted}->${r.actual} via ${r.gate}\n`);
      }
    }
  }

  const code = unregistered.length > 0 ? 1 : leaks.length > 0 ? 2 : 0;
  if (mode !== "--json" && mode !== "--markdown") {
    const verdict = code === 1
      ? "FAIL (P0.2) — unregistered conflicts, record them in CONFLICT-REGISTER.md"
      : code === 2
        ? "PASS (P0.2) / FAIL (M2) — all conflicts registered, safety leak still open, owned by P2.3"
        : "PASS — no unregistered conflict, no safety leak";
    process.stdout.write(`\nRESULT: ${verdict}\nexit=${code}\n`);
  }
  process.exit(code);
}

if (require.main === module) main();

module.exports = { run, evaluate };
