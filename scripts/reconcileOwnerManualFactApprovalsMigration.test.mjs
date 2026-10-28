import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

const migration = await readFile("supabase/migrations/20261013210419_reconcile_owner_manual_fact_approvals.sql", "utf8");
const db = new PGlite();
await db.exec(`
  create table public.refal_fact_register (
    fact_id text primary key, status text not null, reviewer text not null,
    verified_at date not null, expiry_or_review_at date not null,
    source_url_or_document text not null, updated_at timestamptz not null default now()
  );
  create table public.refal_fact_register_audit (
    fact_id text not null references public.refal_fact_register(fact_id),
    action text not null, actor text not null, previous jsonb not null,
    next jsonb not null, reason text not null
  );
  insert into public.refal_fact_register values
    ('MB-MANUAL-1','approved','BOSS','2026-10-07','2027-10-07','newplan/Master Brain & Operating Rules Manual - REFAL AI.txt'),
    ('MB-MANUAL-2','approved','BOSS','2026-10-07','2027-10-07','newplan/Master Brain & Operating Rules Manual - REFAL AI.txt'),
    ('MB-MANUAL-PENDING','pending','BOSS','2026-10-07','2027-10-07','newplan/Master Brain & Operating Rules Manual - REFAL AI.txt'),
    ('MB-SOURCED','approved','BOSS','2026-10-07','2027-10-07','https://www.gov.cy/verified-source');
`);

await db.exec(migration);
let { rows } = await db.query("select fact_id,status from public.refal_fact_register order by fact_id");
assert.deepEqual(rows, [
  { fact_id: "MB-MANUAL-1", status: "pending" },
  { fact_id: "MB-MANUAL-2", status: "pending" },
  { fact_id: "MB-MANUAL-PENDING", status: "pending" },
  { fact_id: "MB-SOURCED", status: "approved" },
]);
assert.equal((await db.query("select count(*)::int as count from public.refal_fact_register_audit")).rows[0].count, 2);
const audit = (await db.query("select previous->>'status' as previous_status,next->>'status' as next_status,reason from public.refal_fact_register_audit order by fact_id")).rows;
assert.deepEqual(audit.map(({ previous_status, next_status }) => [previous_status, next_status]), [["approved", "pending"], ["approved", "pending"]]);
assert.ok(audit.every(({ reason }) => reason.includes("reference material")));

await db.exec(migration);
assert.equal((await db.query("select count(*)::int as count from public.refal_fact_register_audit")).rows[0].count, 2, "rerun must not duplicate governance audit");
await db.close();
console.log("Owner-manual reconciliation migration passed: manual-only approvals become pending, sourced approvals stay approved, audit is retained, rerun is idempotent.");
