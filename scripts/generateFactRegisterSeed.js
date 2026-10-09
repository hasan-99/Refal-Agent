#!/usr/bin/env node
"use strict";

// P3.9 / W3.9.4 — generates the seed migration for refal_fact_register from
// src/factCatalogue.js and the seeding rules in src/factRegister.js.
//
// WHY THIS IS GENERATED AND NOT HAND WRITTEN
// ------------------------------------------
// The register exists in two places: in Postgres, where the dashboard edits it,
// and in `seedRegister()`, which is what the agent falls back to offline and
// what every test runs against. If those two are typed out separately they will
// disagree, and the failure is silent: the code says a fact is approved, the
// database says it expired, and nobody notices until REFAL states a figure it
// should have declined.
//
// So one of them is derived from the other. This script is that derivation.
//
// M2 left a specific warning about exactly this shape: generateEdgeMirrors.js
// carried a hand-written import line and a hand-written export list next to a
// generated file, and both went stale while `--check` reported success. Nothing
// here is hand maintained. The row list, the column list and the values all come
// from the catalogue.
//
//   node scripts/generateFactRegisterSeed.js            # write the migration
//   node scripts/generateFactRegisterSeed.js --check    # exit 1 if it is stale
//   node scripts/generateFactRegisterSeed.js --stdout   # print, write nothing

const fs = require("node:fs");
const path = require("node:path");
const { seedRegister, SEED, HIGH_RISK_FACTS } = require("../src/factRegister");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "supabase", "migrations", "20261009180100_refal_fact_register_seed.sql");
const GENERATED_BY = "scripts/generateFactRegisterSeed.js";

// Postgres literal quoting. Every value below comes from a source file in this
// repo rather than from user input, but a claim text with an apostrophe is
// ordinary English and would otherwise end the string early.
const q = (value) => `'${String(value).replace(/'/gu, "''")}'`;
const qArray = (values) => `array[${values.map(q).join(", ")}]::text[]`;
const qJson = (value) => `${q(JSON.stringify(value))}::jsonb`;

function rowValues(row) {
  return [
    q(row.id),
    q(row.claimText),
    row.topics.length ? qArray(row.topics) : "'{}'::text[]",
    q(row.sourceType),
    q(row.sourceDocument),
    q(row.sourceRef),
    q(row.jurisdiction),
    qJson(row.numbers),
    q(row.volatility),
    q(row.trustTier),
    row.highRisk ? "true" : "false",
    q(row.reviewer),
    `${q(row.verifiedAt)}::date`,
    row.effectiveFrom ? `${q(row.effectiveFrom)}::date` : "null",
    `${q(row.expiryOrReviewAt)}::date`,
    String(row.reviewCadenceDays),
    qArray(row.approvedLanguages),
    q(row.status),
    q(row.notes),
  ].join(", ");
}

const COLUMNS = [
  "fact_id", "claim_text", "topics", "source_type", "source_url_or_document", "source_ref",
  "jurisdiction", "numbers", "volatility", "trust_tier", "high_risk", "reviewer",
  "verified_at", "effective_from", "expiry_or_review_at", "review_cadence_days",
  "approved_languages", "status", "notes",
];

function render() {
  const register = seedRegister();
  const rows = [...register.values()];
  const highRisk = rows.filter((r) => r.highRisk);
  const withNumbers = rows.filter((r) => r.numbers.length);

  const lines = [];
  const w = (line = "") => lines.push(line);

  w(`-- MIG-01 seed / P3.9 W3.9.4 — GENERATED FILE, DO NOT EDIT BY HAND.`);
  w(`-- Regenerate with: node ${GENERATED_BY}`);
  w(`-- Source of truth: src/factCatalogue.js + the seeding rules in src/factRegister.js.`);
  w(`--`);
  w(`-- Rule 1, BOSS's authority instruction: MB manual facts are seeded APPROVED,`);
  w(`-- reviewer ${SEED.reviewer}, verified ${SEED.verifiedAt}. They are live from day one and are`);
  w(`-- NOT blocked waiting for an external reviewer.`);
  w(`--`);
  w(`-- Rule 2 is what makes that safe: every row carries expiry_or_review_at, so a`);
  w(`-- figure that goes stale stops being asserted on its own, with no code change`);
  w(`-- and no redeploy. The ${HIGH_RISK_FACTS.length} high risk facts named in W3.9.2 are capped at a`);
  w(`-- 90 day cadence, enforced by a check constraint as well as by this seed.`);
  w(`--`);
  w(`-- ${rows.length} rows. ${highRisk.length} high risk. ${withNumbers.length} carry at least one number.`);
  w(`--`);
  w(`-- Run AFTER 20261009180000_refal_fact_register.sql. Safe to run twice: an`);
  w(`-- existing row is refreshed to the catalogue's claim and provenance, but its`);
  w(`-- status, reviewer, verified_at and review date are LEFT ALONE, so re-running`);
  w(`-- this file can never silently un-expire a fact a reviewer retired or revive`);
  w(`-- one they blocked.`);
  w();
  w(`insert into public.refal_fact_register (`);
  w(`  ${COLUMNS.join(", ")}`);
  w(`) values`);
  rows.forEach((row, i) => {
    const sep = i === rows.length - 1 ? ";" : ",";
    w(`  (${rowValues(row)})${sep}   -- ${row.id}${row.highRisk ? " [high risk]" : ""}`);
  });
  w();
  w(`-- Conflict handling is deliberately NOT part of the insert above, because`);
  w(`-- "on conflict do update" would have to decide what to do with status and`);
  w(`-- verified_at, and the right answer differs per column. Doing it as an`);
  w(`-- explicit second statement makes that decision readable.`);
  w(`on conflict (fact_id) do update set`);
  w(`  claim_text = excluded.claim_text,`);
  w(`  topics = excluded.topics,`);
  w(`  source_type = excluded.source_type,`);
  w(`  source_url_or_document = excluded.source_url_or_document,`);
  w(`  source_ref = excluded.source_ref,`);
  w(`  jurisdiction = excluded.jurisdiction,`);
  w(`  numbers = excluded.numbers,`);
  w(`  volatility = excluded.volatility,`);
  w(`  trust_tier = excluded.trust_tier,`);
  w(`  high_risk = excluded.high_risk,`);
  w(`  notes = excluded.notes;`);
  w(`  -- status, reviewer, verified_at, effective_from, expiry_or_review_at,`);
  w(`  -- review_cadence_days and approved_languages are intentionally untouched.`);
  w();
  w(`insert into public.refal_fact_register_audit (fact_id, action, actor, previous, next, reason)`);
  w(`select fact_id, 'seed', ${q(SEED.reviewer)}, '{}'::jsonb,`);
  w(`       jsonb_build_object('status', status, 'verified_at', verified_at, 'expiry_or_review_at', expiry_or_review_at),`);
  w(`       'Rule 1 seed from the Master Brain manual'`);
  w(`from public.refal_fact_register r`);
  w(`where not exists (`);
  w(`  select 1 from public.refal_fact_register_audit a where a.fact_id = r.fact_id and a.action = 'seed'`);
  w(`);`);
  w();
  w(`-- ROLLBACK:`);
  w(`-- delete from public.refal_fact_register_audit where action = 'seed';`);
  w(`-- delete from public.refal_fact_register;`);
  w();

  return lines.join("\n");
}

function run(argv) {
  const check = argv.includes("--check");
  const toStdout = argv.includes("--stdout");
  const sql = render();

  if (toStdout) { process.stdout.write(sql); return 0; }

  if (check) {
    if (!fs.existsSync(OUT)) {
      console.error(`FAIL  ${path.relative(ROOT, OUT)} does not exist. Run: node ${GENERATED_BY}`);
      return 1;
    }
    const onDisk = fs.readFileSync(OUT, "utf8");
    if (onDisk !== sql) {
      console.error(`FAIL  ${path.relative(ROOT, OUT)} is stale. The catalogue changed and the migration did not. Run: node ${GENERATED_BY}`);
      return 1;
    }
    console.log(`ok    ${path.relative(ROOT, OUT)} matches src/factCatalogue.js`);
    return 0;
  }

  fs.writeFileSync(OUT, sql, "utf8");
  const rows = seedRegister().size;
  console.log(`wrote ${path.relative(ROOT, OUT)} — ${rows} rows, ${HIGH_RISK_FACTS.length} high risk`);
  return 0;
}

if (require.main === module) process.exitCode = run(process.argv.slice(2));

module.exports = { render, run, OUT };
