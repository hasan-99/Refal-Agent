#!/usr/bin/env node
"use strict";

// Builds a reviewer-facing worklist from the canonical fact register and the
// validated multilingual corpus. It does not approve facts or write to Supabase.
const fs = require("node:fs");
const path = require("node:path");
const { ROWS } = require("../src/factCatalogue");
const { seedRegister, factBehaviour, STATUS } = require("../src/factRegister");
const { TOPICS, LANGUAGES } = require("../src/brainTaxonomy");
const { normalizeFactId } = require("../src/brainFactMap");
const { validateCorpusFile } = require("../src/corpusFile");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "docs", "brain", "FACT-APPROVAL-REVIEW-PACKET.md");
const corpusByFact = new Map();
for (const topic of TOPICS) for (const lang of LANGUAGES) {
  const rel = path.join("knowledge", topic.slug, `${lang}.md`);
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) continue;
  const result = validateCorpusFile(fs.readFileSync(file, "utf8"), { topicSlug: topic.slug, lang, path: rel });
  if (!result.parsed || result.errors.length) throw new Error(`Invalid corpus file: ${rel}: ${result.errors.join("; ")}`);
  for (const section of result.parsed.sections) for (const rawId of section.facts) {
    const id = normalizeFactId(rawId);
    if (!corpusByFact.has(id)) corpusByFact.set(id, []);
    corpusByFact.get(id).push({ topic: topic.slug, lang, heading: section.heading, body: section.body });
  }
}

const register = seedRegister();
const byId = new Map(ROWS.map((row) => [normalizeFactId(row.id), row]));
const allPending = [...register.values()]
  .filter((item) => item.status === STATUS.PENDING)
  .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
const pending = allPending.filter((item) => corpusByFact.has(normalizeFactId(item.id)));
const pendingWithoutCorpus = allPending.filter((item) => !corpusByFact.has(normalizeFactId(item.id)));
const esc = (s) => String(s).replace(/\|/gu, "\\|").replace(/\r?\n/gu, " ").trim();
const lines = [
  "# REFAL fact approval review packet",
  "",
  `Generated from \`src/factCatalogue.js\` and validated corpus files on ${new Date().toISOString().slice(0, 10)}.`,
  "",
  `The register currently contains ${allPending.length} pending facts: ${pending.length} referenced by static customer-answer corpus and ${pendingWithoutCorpus.length} not used in that corpus. **This packet is a review aid, not an approval record.** No row is approved by generating or reading this document. Do not paste owner-manual claims into the approved register without the evidence and review below.`,
  "",
  "## How to review",
  "",
  "For commercial claims, attach current Refalco-owned evidence (approved service schedule, offer record, delivery/portfolio evidence, or written owner confirmation) and name the authorized reviewer. For legal, tax, residency, and regulatory claims, verify the narrow claim against the cited primary authority in force on the review date; record jurisdiction, exact URL, page title, access date, applicable date, and any limits. For each row, record approve / narrow / reject, reviewer, evidence, approved languages, verified date, and next review or expiry. Keep unresolved rows pending.",
  "",
  "## Pending claims",
  "",
];
for (const item of pending) {
  const id = normalizeFactId(item.id);
  const row = byId.get(id);
  const parts = corpusByFact.get(id);
  const grouped = new Map();
  for (const p of parts) {
    const key = `${p.topic}/${p.lang}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(p);
  }
  lines.push(`### ${id}`, "", `- **Canonical claim:** ${esc(row.claim)}`, `- **Source class / reference:** ${esc(row.sourceType)} / ${esc(row.sourceRef)}`, `- **Jurisdiction / volatility / trust:** ${esc(row.jurisdiction)} / ${esc(row.volatility)} / ${esc(row.trustTier)}`, `- **Registered numbers:** ${row.numbers.length ? row.numbers.map((n) => `${esc(n.value)} (${esc(n.kind)})`).join("; ") : "None"}`, `- **Catalogue notes:** ${esc(row.notes || "None")}`, `- **Current runtime status:** ${esc(factBehaviour(id, { register }).status)}; remains non-statable until valid approval`, "- **Corpus wording by language:**");
  for (const [where, snippets] of grouped) {
    lines.push(`  - \`${where}\`: ${snippets.map((s) => `**${esc(s.heading)}** — ${esc(s.body)}`).join(" | ")}`);
  }
  lines.push("- **Reviewer decision:** Pending", "- **Evidence / primary URL and access date:**", "- **Approved languages:**", "- **Reviewer / verified date / next review or expiry:**", "");
}
lines.push(
  "## Pending facts not used in static corpus",
  "",
  "These rows describe dynamic-source contracts. Verify that the named runtime source is implemented, current, scoped to the requested record, and fails closed when unavailable. This check does **not** approve any value returned by that source; value approval remains in the relevant live data workflow. Do not copy these claims into static corpus prose.",
  ""
);
for (const item of pendingWithoutCorpus) {
  const id = normalizeFactId(item.id);
  const row = byId.get(id);
  lines.push(
    `### ${id}`,
    "",
    `- **Runtime contract:** ${esc(row.claim)}`,
    `- **Source class / reference:** ${esc(row.sourceType)} / ${esc(row.sourceRef)}`,
    `- **Catalogue notes:** ${esc(row.notes || "None")}`,
    `- **Current register status:** ${esc(factBehaviour(id, { register }).status)}`,
    "- **Runtime source / fail-closed evidence:**",
    "- **Reviewer / verified date:**",
    ""
  );
}
lines.push("## Generation", "", "Run `node scripts/generateFactReviewPacket.js` to refresh this worklist after catalogue or corpus changes. This generator is offline and never changes fact approval state.", "");
fs.writeFileSync(OUT, lines.join("\n"), "utf8");
console.log(`Wrote ${path.relative(ROOT, OUT)} with ${allPending.length} pending facts (${pending.length} corpus claims, ${pendingWithoutCorpus.length} dynamic-source contracts).`);
