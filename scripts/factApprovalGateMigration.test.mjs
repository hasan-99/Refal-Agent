import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

const migration = await readFile("supabase/migrations/20261011022104_refal_fact_approval_gate.sql", "utf8");
const db = new PGlite();
await db.exec(`
  create table public.refal_fact_register (
    fact_id text primary key, status text not null, reviewer text not null,
    verified_at date not null, expiry_or_review_at date not null,
    source_url_or_document text not null
  );
  create table public.refal_fact_register_audit (
    fact_id text not null references public.refal_fact_register(fact_id),
    action text not null, actor text not null, previous jsonb not null,
    next jsonb not null, reason text not null
  );
  insert into public.refal_fact_register values
    ('MB-F1','approved','BOSS','2026-10-07','2027-10-07','newplan/Master Brain & Operating Rules Manual - REFAL AI.txt'),
    ('MB-F2','approved','BOSS','2026-10-07','2027-10-07','https://www.gov.cy/verified-source');
`);
await db.exec(migration);
const { rows } = await db.query("select fact_id,status from public.refal_fact_register order by fact_id");
assert.deepEqual(rows, [{ fact_id: "MB-F1", status: "pending" }, { fact_id: "MB-F2", status: "approved" }]);
assert.equal((await db.query("select count(*)::int as count from public.refal_fact_register_audit")).rows[0].count, 1);
await db.exec(migration);
assert.equal((await db.query("select count(*)::int as count from public.refal_fact_register_audit")).rows[0].count, 1, "rerun must not duplicate governance audit");
await db.close();
console.log("Fact approval gate migration test passed: manual-only claims become pending, sourced claim is retained, audit is idempotent.");
