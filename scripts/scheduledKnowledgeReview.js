"use strict";

// P15.3 local review status. This reads only the checked-in catalogue/register
// seed and corpus files; it must never be mistaken for live DB freshness.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { TOPICS, LANGUAGES } = require("../src/brainTaxonomy");
const { seedRegister, effectiveStatus, STATUS } = require("../src/factRegister");
const { validateCorpusFile } = require("../src/corpusFile");

const ROOT = path.resolve(__dirname, "..");
function parseArgs(argv) {
  const out = { now: new Date().toISOString().slice(0, 10), owner: "", reviewer: "", sourceChanged: [], json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") out.json = true;
    else if (["--now", "--owner", "--reviewer", "--source-changed"].includes(arg)) {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      if (arg === "--source-changed") out.sourceChanged.push(...value.split(",").map((v) => v.trim()).filter(Boolean));
      else out[{ "--now": "now", "--owner": "owner", "--reviewer": "reviewer" }[arg]] = value;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  const parsedDate = /^\d{4}-\d{2}-\d{2}$/u.test(out.now) ? new Date(`${out.now}T00:00:00Z`) : null;
  if (!parsedDate || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== out.now) throw new Error("--now must be YYYY-MM-DD");
  return out;
}

function collectCorpus() {
  const cells = [];
  for (const topic of TOPICS) for (const lang of LANGUAGES) {
    const rel = `knowledge/${topic.slug}/${lang}.md`;
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) { cells.push({ path: rel, missing: true }); continue; }
    const source = fs.readFileSync(file, "utf8");
    const parsed = validateCorpusFile(source, { topicSlug: topic.slug, lang, path: rel });
    const body = parsed.parsed?.body || source;
    const fingerprint = crypto.createHash("sha256").update(body.normalize("NFKC").toLocaleLowerCase("und").replace(/\s+/gu, " ").trim()).digest("hex");
    cells.push({ path: rel, missing: false, valid: parsed.errors.length === 0, fingerprint });
  }
  const fingerprints = new Map();
  for (const cell of cells.filter((c) => !c.missing)) fingerprints.set(cell.fingerprint, [...(fingerprints.get(cell.fingerprint) || []), cell.path]);
  const duplicates = [...fingerprints.values()].filter((files) => files.length > 1);
  return { total: cells.length, missing: cells.filter((c) => c.missing).map((c) => c.path), invalid: cells.filter((c) => !c.missing && !c.valid).map((c) => c.path), duplicates };
}

function normalizeReviewer(value) {
  return String(value || "").normalize("NFKD").toLocaleLowerCase("und")
    .replace(/\p{M}/gu, "").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function namesMayReferToSamePerson(left, right) {
  const leftTokens = normalizeReviewer(left);
  const rightTokens = normalizeReviewer(right);
  if (!leftTokens.length || !rightTokens.length) return false;
  const covers = (shorter, longer) => shorter.every((token) => longer.some((candidate) =>
    token === candidate || (token.length === 1 && candidate.startsWith(token))
  ));
  return covers(leftTokens, rightTokens) || covers(rightTokens, leftTokens);
}

function buildReport(options = {}) {
  const args = { ...parseArgs([]), ...options };
  // A caller may supply a read-only register snapshot for offline review and
  // deterministic tests. The CLI never accepts register data from arguments.
  const register = args.register instanceof Map ? args.register : seedRegister();
  const groups = { current: [], due: [], expired: [], pending: [], blocked: [] };
  for (const row of register.values()) {
    const status = effectiveStatus(row, args.now);
    if (status === STATUS.BLOCKED) groups.blocked.push(row.id);
    else if (status === STATUS.PENDING) groups.pending.push(row.id);
    else if (status === STATUS.EXPIRED) groups.expired.push(row.id);
    else if (row.expiryOrReviewAt && row.expiryOrReviewAt <= args.now) groups.due.push(row.id);
    else groups.current.push(row.id);
  }
  const corpus = collectCorpus();
  const changedUnknown = (args.sourceChanged || []).filter((id) => !register.has(id));
  const sourceChanged = [...new Set(args.sourceChanged || [])].filter((id) => register.has(id));
  const ownerPresent = Boolean(String(args.owner || "").trim());
  const reviewerPresent = Boolean(String(args.reviewer || "").trim());
  const reviewerIndependenceConflict = ownerPresent && reviewerPresent
    && namesMayReferToSamePerson(args.owner, args.reviewer);
  const currentCount = groups.current.length;
  const total = register.size;
  const blocking = groups.pending.length + groups.due.length + groups.expired.length + groups.blocked.length + sourceChanged.length + corpus.missing.length + corpus.invalid.length + corpus.duplicates.length + changedUnknown.length + Number(!ownerPresent) + Number(!reviewerPresent) + Number(reviewerIndependenceConflict);
  return {
    generatedAt: `${args.now}T00:00:00.000Z`, source: "checked-in seed and corpus only; live database not inspected",
    accountableOwner: ownerPresent ? String(args.owner).trim() : null,
    independentReviewer: reviewerPresent ? String(args.reviewer).trim() : null,
    reviewerIndependenceConflict,
    freshness: { current: currentCount, total, percent: total ? Math.round(currentCount * 10000 / total) / 100 : 0 },
    facts: Object.fromEntries(Object.entries(groups).map(([key, ids]) => [key, { count: ids.length, ids }])),
    sourceChanges: { dueNow: sourceChanged, unknownIds: changedUnknown }, corpus,
    cadenceReview: { dueNow: true, checklist: ["legal, tax, immigration, and dynamic facts", "dormant or duplicate knowledge", "EN/AR/EL language quality", "model/provider changes", "cost and usage"] },
    rollback: { available: false, note: "This report is read-only. A content rollback must use a separately reviewed dashboard revision and be verified against live retrieval." },
    status: blocking ? "REVIEW_REQUIRED" : "CURRENT",
    blockingFindings: blocking,
  };
}

function run(argv = process.argv.slice(2)) {
  let args;
  try { args = parseArgs(argv); } catch (error) { process.stderr.write(`${error.message}\nUsage: node scripts/scheduledKnowledgeReview.js --owner <name> --reviewer <name> [--source-changed ID,ID] [--now YYYY-MM-DD] [--json]\n`); return 2; }
  const report = buildReport(args);
  if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else {
    process.stdout.write(`Scheduled review: ${report.status} · freshness ${report.freshness.percent}% (${report.freshness.current}/${report.freshness.total})\n`);
    process.stdout.write(`Owner: ${report.accountableOwner || "MISSING"} · independent reviewer: ${report.independentReviewer || "MISSING"}\n`);
    for (const [name, item] of Object.entries(report.facts)) process.stdout.write(`${name}: ${item.count}\n`);
    process.stdout.write(`Source changes due: ${report.sourceChanges.dueNow.length}; corpus missing/invalid/duplicate: ${report.corpus.missing.length}/${report.corpus.invalid.length}/${report.corpus.duplicates.length}\n`);
    process.stdout.write(`${report.rollback.note}\n`);
  }
  return report.blockingFindings ? 1 : 0;
}

if (require.main === module) process.exitCode = run();
module.exports = { parseArgs, collectCorpus, buildReport, run, namesMayReferToSamePerson };
