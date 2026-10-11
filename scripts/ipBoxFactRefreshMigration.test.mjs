import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

const migration = await readFile("supabase/migrations/20261011120000_refal_ip_box_fact_refresh.sql", "utf8");
const db = new PGlite();
await db.exec(`
  create table public.refal_fact_register (
    fact_id text primary key,
    claim_text text not null,
    source_type text not null,
    source_url_or_document text not null,
    source_ref text not null default '',
    numbers jsonb not null,
    verified_at date not null,
    expiry_or_review_at date not null,
    review_cadence_days integer not null,
    status text not null,
    reviewer text not null,
    notes text not null default '',
    updated_at timestamptz not null default now()
  );
  create table public.refal_fact_register_audit (
    fact_id text not null,
    action text not null,
    actor text not null,
    previous jsonb not null,
    next jsonb not null,
    reason text not null
  );
  insert into public.refal_fact_register (
    fact_id, claim_text, source_type, source_url_or_document, numbers,
    verified_at, expiry_or_review_at, review_cadence_days, status, reviewer
  ) values (
    'MB-F20',
    'Cyprus operates an IP Box regime that can bring effective rates to about 2.5% to 3% on qualifying profits.',
    'cy-authority', 'newplan/Master Brain & Operating Rules Manual - REFAL AI.txt',
    '[{"value":"2.5% to 3%","kind":"rate"}]',
    '2026-10-07', '2026-11-06', 30, 'approved', 'BOSS'
  );
`);
await db.exec(migration);
const { rows: [updated] } = await db.query("select * from public.refal_fact_register where fact_id='MB-F20'");
assert.match(updated.claim_text, /80% of net qualifying profit/u);
assert.doesNotMatch(updated.claim_text, /2\.5%/u);
assert.equal(updated.source_url_or_document, "https://www.gov.cy/mof/en/documents/tax-incentives/");
assert.equal(updated.verified_at.toISOString().slice(0, 10), "2026-10-11");
assert.equal(updated.expiry_or_review_at.toISOString().slice(0, 10), "2027-01-09");
assert.deepEqual(updated.numbers.map((number) => number.value), ["80%", "20%", "3%"]);
assert.deepEqual((await db.query("select count(*)::int as count from public.refal_fact_register_audit")).rows[0].count, 1);
await db.exec(migration);
assert.deepEqual((await db.query("select count(*)::int as count from public.refal_fact_register_audit")).rows[0].count, 1, "rerun must not duplicate the audit event");
await db.close();
console.log("MIG-17 PGlite test passed: stale rate corrected, official provenance and review window recorded, rerun idempotent.");
