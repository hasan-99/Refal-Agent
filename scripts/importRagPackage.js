#!/usr/bin/env node
"use strict";

// Imports a finalized RAG knowledge package (JSONL) into the existing knowledge
// store. The plan, mapping and SQL live in src/ragPackageImport.js; this file
// only reads files, queries state, embeds and applies.
//
// Writes go through the Supabase Management API with
// scripts/applySupabaseMigration.ps1, the vetted write path on this machine
// (see scripts/emitCorpusSql.js for why PostgREST cannot write from here).
// State is read with scripts/querySupabaseReadOnly.ps1.
//
//   # dry run: validate, compare with the database, embed what changed, write SQL
//   node scripts/importRagPackage.js --package <file.jsonl> --manifest <manifest.json> --out <dir>
//
//   # same, then apply each batch and read the result back
//   node scripts/importRagPackage.js --package ... --manifest ... --out ... --apply
//
//   # refresh price-bearing revisions expiring within N days (audited re-approval)
//   node scripts/importRagPackage.js --manifest ... --out ... --refresh-validity \
//        --reviewer "<name>" --reason "<why>" [--within-days 7] [--apply]
//
// Manifest: { "packageId": "...", "agentId": "refal", "approver": "...",
//             "retired": ["RF-KB-004", ...], "remap": { "RF-KB-012": "CY-REG-026" } }
//
// Re-running with the same package is safe: unchanged chunks are skipped and
// write nothing; a changed content_hash produces a new revision and new vector.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
  STATE_QUERY, planPackage, classify, renderBatch, renderValidityRefresh
} = require("../src/ragPackageImport");

const ROOT = path.resolve(__dirname, "..");
const BATCH_SIZE = 10;

function parseArgs(argv) {
  const args = { apply: false, refreshValidity: false, force: false, withinDays: 7 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--package") args.package = path.resolve(argv[++i]);
    else if (flag === "--manifest") args.manifest = path.resolve(argv[++i]);
    else if (flag === "--out") args.out = path.resolve(argv[++i]);
    else if (flag === "--apply") args.apply = true;
    else if (flag === "--force") args.force = true;
    else if (flag === "--refresh-validity") args.refreshValidity = true;
    else if (flag === "--reviewer") args.reviewer = argv[++i];
    else if (flag === "--reason") args.reason = argv[++i];
    else if (flag === "--within-days") args.withinDays = Number(argv[++i]);
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (!args.manifest || !args.out) throw new Error("--manifest and --out are required");
  if (!args.refreshValidity && !args.package) throw new Error("--package is required");
  return args;
}

function runPowerShell(script, params) {
  const quoted = params.map((p) => (p.startsWith("-") ? p : `'${p.replace(/'/gu, "''")}'`)).join(" ");
  return execFileSync("pwsh", ["-NoProfile", "-Command",
    `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; & '${path.join(ROOT, "scripts", script)}' ${quoted}`],
  { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function readState() {
  const file = path.join(os.tmpdir(), `rag-package-state-${process.pid}.sql`);
  fs.writeFileSync(file, STATE_QUERY, "utf8");
  try {
    const parsed = JSON.parse(runPowerShell("querySupabaseReadOnly.ps1", ["-QueryFile", file]));
    const row = Array.isArray(parsed) ? parsed[0] : parsed;
    return Array.isArray(row?.state) ? row.state : [];
  } finally {
    fs.rmSync(file, { force: true });
  }
}

function applyFile(file) {
  const output = runPowerShell("applySupabaseMigration.ps1", ["-MigrationPath", file]);
  if (!/^APPLIED/mu.test(output)) throw new Error(`apply failed for ${path.basename(file)}:\n${output}`);
  return output;
}

function summarize(actions) {
  const counts = {};
  for (const a of actions) counts[a.action] = (counts[a.action] || 0) + 1;
  return counts;
}

async function run(argv) {
  const args = parseArgs(argv);
  const manifest = JSON.parse(fs.readFileSync(args.manifest, "utf8"));
  fs.mkdirSync(args.out, { recursive: true });

  if (args.refreshValidity) {
    const file = path.join(args.out, "refresh_price_validity.sql");
    fs.writeFileSync(file, renderValidityRefresh({ reviewer: args.reviewer, reason: args.reason, withinDays: args.withinDays }), "utf8");
    console.log(`wrote ${file}`);
    if (args.apply) console.log(applyFile(file));
    return 0;
  }

  const rows = fs.readFileSync(args.package, "utf8").split(/\r?\n/u).filter((line) => line.trim()).map((line, i) => {
    try { return JSON.parse(line); } catch { throw new Error(`line ${i + 1}: invalid JSON`); }
  });
  const plan = planPackage(rows, manifest);
  for (const warning of plan.warnings) console.log(`WARN  ${warning}`);
  if (!plan.ok) {
    for (const error of plan.errors) console.log(`FAIL  ${error}`);
    return 1;
  }
  console.log(`package ${manifest.packageId}: ${rows.length} lines, ${plan.chunks.length} active, ${plan.inactive.length} inactive`);
  console.log(`auto-expire in 30 days (price pattern): ${plan.chunks.filter((c) => c.willAutoExpire).map((c) => c.chunkId).join(", ") || "none"}`);

  const { embedTexts, DEFAULT_EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } = require("../src/ai");
  const before = readState();
  const actions = classify(plan, before, { embeddingModel: DEFAULT_EMBEDDING_MODEL, force: args.force });
  console.log(`database before: ${before.length} package sources · actions ${JSON.stringify(summarize(actions))}`);
  for (const a of actions.filter((x) => x.action === "operator-edited")) {
    console.log(`SKIP  ${a.chunkId}: live revision was edited outside this importer; re-run with --force to overwrite`);
  }

  const writes = actions.filter((a) => ["insert", "update", "embed", "deactivate"].includes(a.action));
  const toEmbed = writes.filter((a) => a.chunk);
  const vectors = new Map();
  if (toEmbed.length) {
    // embedTexts = "passage:" prefix, the stored-content side of E5. The model
    // string is pinned to DEFAULT_EMBEDDING_MODEL, which every search RPC
    // compares with "=".
    const computed = await embedTexts(toEmbed.map((a) => a.chunk.embeddingText));
    if (computed.length !== toEmbed.length) throw new Error(`expected ${toEmbed.length} vectors, got ${computed.length}`);
    computed.forEach((vector, i) => {
      if (vector.length !== EMBEDDING_DIMENSIONS || vector.some((v) => !Number.isFinite(v))) throw new Error(`${toEmbed[i].chunkId}: invalid vector`);
      vectors.set(toEmbed[i].chunkId, vector);
    });
  }
  console.log(`embeddings computed: ${vectors.size} with ${DEFAULT_EMBEDDING_MODEL}`);

  const files = [];
  for (let i = 0; i < writes.length; i += BATCH_SIZE) {
    const batch = writes.slice(i, i + BATCH_SIZE);
    const label = `batch ${files.length + 1} · ${batch.map((a) => `${a.chunkId}:${a.action}`).join(", ")}`;
    const file = path.join(args.out, `import_batch_${String(files.length + 1).padStart(2, "0")}.sql`);
    fs.writeFileSync(file, renderBatch(batch, vectors, { approver: manifest.approver, embeddingModel: DEFAULT_EMBEDDING_MODEL, label }), "utf8");
    files.push(file);
  }
  fs.writeFileSync(path.join(args.out, "plan.json"), JSON.stringify(actions.map(({ chunkId, canonicalUrl, action, chunk }) => ({
    chunkId, canonicalUrl, action, contentHash: chunk?.contentHash, willAutoExpire: chunk?.willAutoExpire, amendments: chunk?.documentMetadata.amendments
  })), null, 2), "utf8");
  console.log(`wrote ${files.length} SQL batch file(s) + plan.json to ${args.out}`);

  if (!args.apply) {
    console.log("DRY RUN - nothing was written to the database. Re-run with --apply.");
    return 0;
  }
  let failed = 0;
  for (const file of files) {
    try { applyFile(file); console.log(`APPLIED ${path.basename(file)}`); }
    catch (error) { failed += 1; console.log(`FAILED ${path.basename(file)}: ${error.message.split("\n").slice(0, 3).join(" | ")}`); }
  }
  const after = readState();
  const recheck = classify(plan, after, { embeddingModel: DEFAULT_EMBEDDING_MODEL, force: args.force });
  console.log(`database after: ${after.length} package sources · re-plan ${JSON.stringify(summarize(recheck))} · failed batches ${failed}`);
  return failed ? 1 : 0;
}

if (require.main === module) {
  run(process.argv.slice(2)).then((code) => { process.exitCode = code; })
    .catch((error) => { console.error(`import failed: ${error.message}`); process.exitCode = 1; });
}

module.exports = { run };
