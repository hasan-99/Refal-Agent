#!/usr/bin/env node
"use strict";

// G2 gate for P0.2 / W0.2.1 — guardrail conflict sweep.
//
// Runs every MB candidate sentence (AR/EN/EL) through the two live claim gates
// and reports BLOCK/PASS per language.
//
// TWO PASSES (second pass added by P2.6, 2026-10-09)
//
//   pass 1  no evidence at all. This is the original sweep and it is unchanged:
//           it measures the pre-M2 blanket behaviour, because with no approved
//           evidence `containsProhibitedClaim` routes to the legacy gate.
//   pass 2  the SAME sentences with synthetic approved, unexpired evidence that
//           contains the candidate sentence verbatim. Pass 1 alone cannot see
//           whether M2 worked: a blocked MB fact looks identical before and
//           after the repair, because the repair only takes effect once there is
//           evidence to ground the fact in.
//
// Both passes use the SAME evaluator (`containsProhibitedClaim` OR
// `restrictedRefalcoReply`), so the two columns are comparable. Production runs
// both gates on every turn, so measuring only one would overstate the result.
//
// Exit codes are deliberately split, because "a conflict is recorded",
// "a conflict is fixed" and "a leak is open" are different questions owned by
// different milestones.
//
//   0  clean: no unregistered conflict, no safety leak, and no MB fact still
//      blocked once approved evidence is supplied.
//   1  P0.2 FAILS: an MB-required sentence is blocked and is NOT recorded in
//      docs/brain/CONFLICT-REGISTER.md. Registering it is P0.2's own job.
//   2  P0.2 PASSES, M2 owes a fix: every conflict is registered, but a control
//      sentence that must stay blocked is leaking (a fail-open). Registration
//      must never wave a safety leak through, so this is not exit 0, but it
//      also must not block P0.2 forever on a repair that belongs to M2 (P2.3).
//      A control sentence that leaks in pass 2 ONLY, i.e. approved evidence
//      rescued a guarantee, is the same class of failure and keeps this code.
//   3  P2.6 FINDS AN M2 GAP: nothing is leaking, but an `expect: "pass"` MB fact
//      is STILL blocked even with approved evidence containing it verbatim.
//      M2 has not finished removing BLK-1 / BLK-2 for that fact.
//
// The meaning of 0, 1 and 2 is unchanged. Code 3 is strictly additive and sits
// below 2 in precedence, so a leak is never masked by an M2 gap.
//
// P0.2's phase gate condition is `exit != 1`. M2's exit gate is `exit == 0`.
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

function evaluate(sentence, evidence) {
  const options = evidence ? { evidence } : {};
  const prohibited = containsProhibitedClaim(sentence, options);
  const restricted = restrictedRefalcoReply(sentence, options);
  return {
    prohibited,
    restricted: restricted !== null,
    blocked: prohibited || restricted !== null,
    restrictedReply: restricted,
  };
}

// P2.6 — synthetic approved evidence. A chunk that repeats the candidate
// sentence verbatim is the strongest evidence that can exist for it: every
// entity and every number is present by construction. If an `expect: "pass"`
// fact is still blocked here, no retrieval result will ever unblock it.
//
// `valid_until` is set in the future on purpose: `isApprovedEvidence` treats an
// expired or unparseable expiry as not-evidence, which would silently route the
// sentence back to the legacy gate and make pass 2 a copy of pass 1.
function syntheticApprovedEvidence(sentence) {
  return [{
    content: sentence,
    review_status: "approved",
    valid_until: new Date(Date.now() + 86400000).toISOString(),
    source_name: "P2.6 synthetic approved chunk",
    source_url: null,
    document_id: "synthetic-doc",
    chunk_id: "synthetic-chunk",
  }];
}

function gateLabel(result) {
  return result.prohibited && result.restricted ? "both"
    : result.prohibited ? "containsProhibitedClaim"
      : result.restricted ? "restrictedRefalcoReply" : "none";
}

function run() {
  const registered = registeredMbRefs();
  const rows = [];
  const evidenceRows = [];

  for (const candidate of MB_CANDIDATES) {
    for (const lang of LANGUAGES) {
      const sentence = candidate[lang];
      if (!sentence) continue;
      const wanted = candidate.expect === "pass" ? "PASS" : "BLOCK";

      const result = evaluate(sentence);
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
        gate: gateLabel(result),
        registered: registered.has(candidate.id),
      });

      // ---- pass 2, with synthetic approved evidence (P2.6) ----
      const withEvidence = evaluate(sentence, syntheticApprovedEvidence(sentence));
      const evidenceActual = withEvidence.blocked ? "BLOCK" : "PASS";
      evidenceRows.push({
        id: candidate.id,
        mbRef: candidate.mbRef,
        topic: candidate.topic,
        lang,
        sentence,
        wanted,
        actual: evidenceActual,
        conflict: wanted !== evidenceActual,
        gate: gateLabel(withEvidence),
        registered: registered.has(candidate.id),
      });
    }
  }

  const conflicts = rows.filter((r) => r.conflict);
  const unregistered = conflicts.filter((r) => !r.registered);
  const leaks = conflicts.filter((r) => r.wanted === "BLOCK");

  // An expect:"pass" MB fact still blocked once approved evidence carries it is
  // the question M2 exists to answer. Pass 1 cannot see it.
  const m2Failures = evidenceRows.filter((r) => r.conflict && r.wanted === "PASS");
  // An expect:"block" control that PASSES once evidence is supplied is a
  // fail-open rescued BY the evidence path. Same severity as a pass 1 leak.
  const evidenceLeaks = evidenceRows.filter((r) => r.conflict && r.wanted === "BLOCK");
  // Rows the evidence path repaired: blocked without evidence, allowed with it.
  const repairedByEvidence = rows.filter((r, index) =>
    r.wanted === "PASS" && r.actual === "BLOCK" && evidenceRows[index].actual === "PASS");

  return {
    rows,
    conflicts,
    unregistered,
    leaks,
    registeredCount: registered.size,
    evidenceRows,
    m2Failures,
    evidenceLeaks,
    repairedByEvidence,
  };
}

// Compact two-column summary, one line per candidate: the per-language verdict
// without evidence against the same verdict with approved evidence.
function twoColumnSummary(rows, evidenceRows, write) {
  const order = [];
  const byId = new Map();
  rows.forEach((row, index) => {
    if (!byId.has(row.id)) {
      order.push(row.id);
      byId.set(row.id, { id: row.id, mbRef: row.mbRef, wanted: row.wanted, without: {}, with: {} });
    }
    const entry = byId.get(row.id);
    entry.without[row.lang] = row.actual === "PASS" ? "P" : "B";
    entry.with[row.lang] = evidenceRows[index].actual === "PASS" ? "P" : "B";
  });
  const cells = (map) => LANGUAGES.map((lang) => `${lang}:${map[lang] || "-"}`).join(" ");
  write(`\n${"-".repeat(72)}\nPer candidate: without evidence  ->  with approved evidence   (P=pass, B=block)\n`);
  write(`${"ID".padEnd(9)}${"MB ref".padEnd(9)}${"want".padEnd(6)}${"without evidence".padEnd(22)}with evidence\n`);
  for (const id of order) {
    const entry = byId.get(id);
    const changed = cells(entry.without) === cells(entry.with) ? "" : "   <- changed";
    write(`${entry.id.padEnd(9)}${entry.mbRef.padEnd(9)}${entry.wanted.padEnd(6)}${cells(entry.without).padEnd(22)}${cells(entry.with)}${changed}\n`);
  }
}

function pct(n, d) {
  return d === 0 ? "0.0" : ((n / d) * 100).toFixed(1);
}

function main() {
  const mode = process.argv[2] || "";
  const { rows, conflicts, unregistered, leaks, registeredCount, evidenceRows, m2Failures, evidenceLeaks, repairedByEvidence } = run();

  if (mode === "--json") {
    process.stdout.write(`${JSON.stringify({
      rows,
      evidenceRows,
      summary: {
        total: rows.length,
        conflicts: conflicts.length,
        unregistered: unregistered.length,
        leaks: leaks.length,
        m2Failures: m2Failures.length,
        evidenceLeaks: evidenceLeaks.length,
        repairedByEvidence: repairedByEvidence.length,
      },
    }, null, 2)}\n`);
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

    // ---------------- pass 2, added by P2.6 ----------------
    process.stdout.write(`\n${"=".repeat(60)}\nPass 2 — with synthetic approved evidence (P2.6)\n${"=".repeat(60)}\n`);
    process.stdout.write(`Repaired by evidence : ${repairedByEvidence.length}  (blocked without, allowed with)\n`);
    process.stdout.write(`M2 gaps remaining    : ${m2Failures.length}  (MB fact STILL blocked with evidence)\n`);
    process.stdout.write(`Evidence-path leaks  : ${evidenceLeaks.length}  (control rescued BY the evidence path)\n`);
    if (m2Failures.length) {
      process.stdout.write(`\n${"-".repeat(60)}\nM2 FAILURES — an approved MB fact cannot be stated even with evidence:\n`);
      for (const r of m2Failures) {
        process.stdout.write(`  [M2 GAP] ${r.id} ${r.mbRef} ${r.lang} PASS->BLOCK via ${r.gate}\n`);
        process.stdout.write(`           ${r.sentence}\n`);
      }
    }
    if (evidenceLeaks.length) {
      process.stdout.write(`\n${"-".repeat(60)}\nEVIDENCE-PATH LEAKS — approved evidence rescued a prohibited claim:\n`);
      for (const r of evidenceLeaks) {
        process.stdout.write(`  [LEAK] ${r.id} ${r.mbRef} ${r.lang} BLOCK->PASS\n`);
        process.stdout.write(`         ${r.sentence}\n`);
      }
    }
    twoColumnSummary(rows, evidenceRows, (text) => process.stdout.write(text));
  }

  const code = unregistered.length > 0
    ? 1
    : (leaks.length + evidenceLeaks.length) > 0
      ? 2
      : m2Failures.length > 0
        ? 3
        : 0;
  if (mode !== "--json" && mode !== "--markdown") {
    const verdict = code === 1
      ? "FAIL (P0.2) — unregistered conflicts, record them in CONFLICT-REGISTER.md"
      : code === 2
        ? "PASS (P0.2) / FAIL (M2) — all conflicts registered, safety leak still open, owned by P2.3"
        : code === 3
          ? `PASS (P0.2) / FAIL (M2 exit) — no leak, but ${m2Failures.length} MB fact(s) stay blocked even with approved evidence`
          : "PASS — no unregistered conflict, no safety leak, no MB fact blocked with evidence";
    process.stdout.write(`\nRESULT: ${verdict}\nexit=${code}\n`);
  }
  process.exit(code);
}

if (require.main === module) main();

module.exports = { run, evaluate };
