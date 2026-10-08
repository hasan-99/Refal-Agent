#!/usr/bin/env node
"use strict";

// G2 gate for P0.4.
//
// Checks, exactly as the plan specifies:
//   - slugs unique
//   - every topic has ar / en / el
//   - every VOLATILE topic has a matching M4 table or an expiry policy
//   - >= 10 golden questions per topic per language
//   - every question has an expected class
//
// Plus two the plan implies but does not spell out:
//   - canonical URIs are unique and well formed (canonical_url is UNIQUE NOT NULL)
//   - the negative query set is non empty (CX 4C)
//
// Exit 0 = all checks pass. Exit 1 = at least one failed.

const {
  TOPICS, LANGUAGES, VOLATILE_BACKING, VOLATILITY,
  canonicalUrl, CANONICAL_URL_PATTERN, expectedSourceCount,
} = require("../src/brainTaxonomy");
const golden = require("../src/brainGoldenSet");

const MIN_PER_CELL = 10;
const checks = [];

function check(name, ok, detail) {
  checks.push({ name, ok, detail });
}

// 1. slugs unique
const slugs = TOPICS.map((t) => t.slug);
const dupSlugs = slugs.filter((s, i) => slugs.indexOf(s) !== i);
check("slugs unique", dupSlugs.length === 0, dupSlugs.length ? `duplicates: ${dupSlugs.join(", ")}` : `${slugs.length} unique slugs`);

// 2. topic count frozen at 29
check("29 topics frozen", TOPICS.length === 29, `found ${TOPICS.length}`);

// 3. every topic has all three languages (via canonical URI generation)
const uriErrors = [];
const uris = [];
for (const t of TOPICS) {
  for (const lang of LANGUAGES) {
    try {
      const u = canonicalUrl(t.slug, lang);
      if (!CANONICAL_URL_PATTERN.test(u)) uriErrors.push(`malformed: ${u}`);
      uris.push(u);
    } catch (e) {
      uriErrors.push(`${t.slug}/${lang}: ${e.message}`);
    }
  }
}
check("every topic has ar/en/el", uriErrors.length === 0, uriErrors.length ? uriErrors.slice(0, 5).join(" | ") : `${uris.length} topic-language pairs`);

// 4. canonical URIs unique (canonical_url is UNIQUE NOT NULL in the schema)
const dupUris = uris.filter((u, i) => uris.indexOf(u) !== i);
check("canonical URIs unique", dupUris.length === 0, dupUris.length ? dupUris.slice(0, 3).join(", ") : `${uris.length} unique, expected ${expectedSourceCount()}`);

// 5. every VOLATILE topic has an M4 table or an expiry policy
const volatile = TOPICS.filter((t) => t.volatility === VOLATILITY.VOLATILE);
const unbacked = volatile.filter((t) => !VOLATILE_BACKING[t.slug]);
check("volatile topics backed", unbacked.length === 0,
  unbacked.length ? `unbacked: ${unbacked.map((t) => t.slug).join(", ")}` : `${volatile.length} volatile topics, all backed`);

// 6. review cadence derived, never zero
const badCadence = TOPICS.filter((t) => !Number.isInteger(t.reviewCadenceDays) || t.reviewCadenceDays <= 0);
check("review cadence set", badCadence.length === 0, badCadence.length ? badCadence.map((t) => t.slug).join(", ") : "30 / 180 / 365 day cadences assigned");

// 7. >= 10 golden questions per topic per language
const summary = golden.coverageSummary(MIN_PER_CELL);
check(`>= ${MIN_PER_CELL} golden questions per topic per language`, summary.cellsShort === 0,
  summary.cellsShort
    ? `${summary.cellsShort}/${summary.cells} cells short, e.g. ${summary.short.slice(0, 4).map((r) => `${r.topic}/${r.lang}=${r.count}`).join(", ")}`
    : `${summary.total}/${summary.required} questions across ${summary.cells} cells`);

// 8. balanced across languages
const langCounts = Object.values(summary.byLang);
check("languages balanced", new Set(langCounts).size === 1, `ar=${summary.byLang.ar} en=${summary.byLang.en} el=${summary.byLang.el}`);

// 9. every question has a valid expected class
const entryErrors = golden.validateAll();
check("every question has an expected class", entryErrors.length === 0,
  entryErrors.length ? `${entryErrors.length} error(s), e.g. ${entryErrors.slice(0, 3).join(" | ")}` : `${golden.ENTRIES.length} entries valid`);

// 10. negative query set present (CX 4C)
check("negative queries present", golden.NEGATIVE_QUERIES.length > 0, `${golden.NEGATIVE_QUERIES.length} negative queries`);

// 11. thresholds frozen before evaluation
const t = golden.THRESHOLDS;
check("thresholds frozen", Number.isFinite(t.answerPass) && Number.isFinite(t.perLanguagePass) && Number.isFinite(t.maxLanguageSpread),
  `answerPass=${t.answerPass}/12 perLanguage=${t.perLanguagePass} spread<=${t.maxLanguageSpread}`);

// ------------------------------------------------------------------- reporting
const failed = checks.filter((c) => !c.ok);
process.stdout.write("P0.4 taxonomy + golden set validation\n");
process.stdout.write(`${"=".repeat(68)}\n`);
for (const c of checks) {
  process.stdout.write(`${c.ok ? "PASS" : "FAIL"}  ${c.name}\n        ${c.detail}\n`);
}
process.stdout.write(`${"=".repeat(68)}\n`);
process.stdout.write(`${checks.length - failed.length}/${checks.length} checks passed\n`);
process.stdout.write(`RESULT: ${failed.length ? "FAIL" : "PASS"}\n`);
process.exit(failed.length ? 1 : 0);
