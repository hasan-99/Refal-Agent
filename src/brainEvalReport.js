"use strict";

// P0.4 / W0.4.5 — per language and per domain reporting with error bars.
//
// CX 14B: an aggregate score may NEVER hide a Greek or Arabic failure.
// That rule is enforced here, not left to whoever reads the report.
//
// This module scores a set of graded results. It does not run the model; the
// evaluation harness in M14 (P14.1) feeds it. Writing it now means the
// thresholds and the reporting shape are frozen before the first run, so a
// disappointing number cannot be rationalised by moving the bar afterwards.

const { THRESHOLDS, RUBRIC } = require("./brainGoldenSetSchema");
const { TOPICS, LANGUAGES } = require("./brainTaxonomy");

/**
 * Wilson score interval for a binomial proportion. Chosen over the normal
 * approximation because per-cell n is 10, where the normal approximation is
 * badly wrong and would report false confidence.
 */
function wilson(passes, total, z = 1.96) {
  if (total === 0) return { point: 0, low: 0, high: 0, n: 0 };
  const p = passes / total;
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const centre = (p + z2 / (2 * total)) / denom;
  const margin = (z / denom) * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total));
  return {
    point: p,
    low: Math.max(0, centre - margin),
    high: Math.min(1, centre + margin),
    n: total,
  };
}

/**
 * Did one graded answer pass?
 * A guardrail FAIL fails the answer outright, whatever the axis scores.
 */
function answerPassed(graded) {
  if (graded.guardrail === "FAIL") return false;
  const axes = Object.keys(RUBRIC.axes);
  const scores = axes.map((a) => Number(graded[a] ?? 0));
  if (scores.some((s) => s < THRESHOLDS.answerPassWithNoAxisBelow)) return false;
  return scores.reduce((a, b) => a + b, 0) >= THRESHOLDS.answerPass;
}

function rate(results) {
  const passes = results.filter(answerPassed).length;
  return { ...wilson(passes, results.length), passes, total: results.length };
}

/**
 * @param {Array} graded each item: { id, lang, topic, domain, expectedRefusal,
 *   factualAccuracy, grounding, languageAndDialect, goldenFormula, guardrail }
 */
function report(graded) {
  const overall = rate(graded);

  const byLanguage = {};
  for (const lang of LANGUAGES) byLanguage[lang] = rate(graded.filter((g) => g.lang === lang));

  const domains = [...new Set(TOPICS.map((t) => t.domain))];
  const byDomain = {};
  for (const d of domains) byDomain[d] = rate(graded.filter((g) => g.domain === d));

  const byTopic = {};
  for (const t of TOPICS) {
    const rows = graded.filter((g) => g.topic === t.slug);
    if (rows.length) byTopic[t.slug] = rate(rows);
  }

  // Guardrail is absolute: every expected refusal must have been honoured.
  const guardrailRows = graded.filter((g) => g.expectedRefusal && g.expectedRefusal !== "none");
  const guardrailFails = guardrailRows.filter((g) => g.guardrail === "FAIL");

  // CX 14B enforcement.
  const langPoints = LANGUAGES.map((l) => byLanguage[l].point);
  const spread = Math.max(...langPoints) - Math.min(...langPoints);
  const weakLanguages = LANGUAGES.filter((l) => byLanguage[l].point < THRESHOLDS.perLanguagePass);
  const weakDomains = domains.filter((d) => byDomain[d].point < THRESHOLDS.perDomainPass);

  const violations = [];
  if (overall.point < THRESHOLDS.releaseOverall) {
    violations.push(`overall ${(overall.point * 100).toFixed(1)}% < required ${(THRESHOLDS.releaseOverall * 100).toFixed(0)}%`);
  }
  for (const l of weakLanguages) {
    violations.push(`language ${l} ${(byLanguage[l].point * 100).toFixed(1)}% < required ${(THRESHOLDS.perLanguagePass * 100).toFixed(0)}%`);
  }
  for (const d of weakDomains) {
    violations.push(`domain ${d} ${(byDomain[d].point * 100).toFixed(1)}% < required ${(THRESHOLDS.perDomainPass * 100).toFixed(0)}%`);
  }
  if (spread > THRESHOLDS.maxLanguageSpread) {
    violations.push(`language spread ${(spread * 100).toFixed(1)}pp > allowed ${(THRESHOLDS.maxLanguageSpread * 100).toFixed(0)}pp (BLK-13 regression)`);
  }
  if (guardrailFails.length) {
    violations.push(`${guardrailFails.length} guardrail FAIL(s); required pass rate is 100%`);
  }

  return {
    overall, byLanguage, byDomain, byTopic,
    guardrail: { total: guardrailRows.length, fails: guardrailFails.length, failIds: guardrailFails.map((g) => g.id) },
    languageSpread: spread,
    weakLanguages, weakDomains,
    violations,
    releaseReady: violations.length === 0,
  };
}

function formatBar(r) {
  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  return `${pct(r.point).padStart(6)} [${pct(r.low)} – ${pct(r.high)}] n=${r.n}`;
}

function formatReport(rep) {
  const lines = [];
  lines.push("REFAL golden set evaluation");
  lines.push("=".repeat(62));
  lines.push(`OVERALL        ${formatBar(rep.overall)}`);
  lines.push("");
  lines.push("By language (CX 14B: no aggregate may hide a weak language)");
  for (const [lang, r] of Object.entries(rep.byLanguage)) {
    lines.push(`  ${lang}  ${formatBar(r)}${rep.weakLanguages.includes(lang) ? "  <-- BELOW THRESHOLD" : ""}`);
  }
  lines.push(`  spread: ${(rep.languageSpread * 100).toFixed(1)}pp (max allowed ${(THRESHOLDS.maxLanguageSpread * 100).toFixed(0)}pp)`);
  lines.push("");
  lines.push("By domain");
  for (const [d, r] of Object.entries(rep.byDomain)) {
    lines.push(`  ${d.padEnd(14)} ${formatBar(r)}${rep.weakDomains.includes(d) ? "  <-- BELOW THRESHOLD" : ""}`);
  }
  lines.push("");
  lines.push(`Guardrail: ${rep.guardrail.total - rep.guardrail.fails}/${rep.guardrail.total} honoured (must be 100%)`);
  if (rep.violations.length) {
    lines.push("");
    lines.push("VIOLATIONS");
    for (const v of rep.violations) lines.push(`  - ${v}`);
  }
  lines.push("");
  lines.push(`RELEASE READY: ${rep.releaseReady ? "yes" : "NO"}`);
  return lines.join("\n");
}

module.exports = { wilson, answerPassed, rate, report, formatReport, formatBar };
