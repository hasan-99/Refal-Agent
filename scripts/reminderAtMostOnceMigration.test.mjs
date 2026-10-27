import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

const migration = await readFile("supabase/migrations/20261011110000_rafa_reminder_at_most_once.sql", "utf8");
const db = new PGlite();
await db.exec(`
  create role anon;
  create role authenticated;
  create role service_role bypassrls;
  create table public.rafa_reminder_jobs (
    id uuid primary key default gen_random_uuid(),
    status text not null default 'queued' check (status in ('queued','processing','sent','failed','dead','cancelled')),
    attempts integer not null default 0,
    next_attempt_at timestamptz not null default now(),
    last_error text
  );
  create index rafa_reminder_jobs_due_idx on public.rafa_reminder_jobs(next_attempt_at,id)
    where status in ('queued','failed','processing');
  grant select, update on public.rafa_reminder_jobs to service_role;
`);
await db.query("insert into public.rafa_reminder_jobs(status) values ('processing'),('failed')");
await db.exec(migration);
await db.exec(migration); // The incremental migration is safe to rerun.
await db.query("insert into public.rafa_reminder_jobs(status) values ('sending'),('uncertain')");

const quarantined = await db.query("select status,last_error from public.rafa_reminder_jobs where status='uncertain'");
assert.equal(quarantined.rows.length, 3, "pre-upgrade processing and failed rows are quarantined together with uncertain sends");
assert.ok(quarantined.rows.some((row) => row.last_error?.includes("Pre-upgrade reminder state quarantined")));

await db.query("insert into public.rafa_reminder_jobs(status,next_attempt_at) values ('queued',now()-interval '1 minute'),('failed',now()-interval '1 minute')");
const claimed = await db.query("select status,attempts from public.rafa_claim_due_reminders(10)");
assert.deepEqual(claimed.rows, [{ status: "processing", attempts: 1 }, { status: "processing", attempts: 1 }]);
await db.query("update public.rafa_reminder_jobs set next_attempt_at=now()-interval '1 minute' where status='processing'");
const reclaimed = await db.query("select * from public.rafa_claim_due_reminders(10)");
assert.deepEqual(reclaimed.rows, [], "processing claims are never automatically reclaimed");

const { rows: [index] } = await db.query("select indexdef from pg_indexes where schemaname='public' and indexname='rafa_reminder_jobs_due_idx'");
assert.match(index.indexdef, /WHERE \(status = ANY \(ARRAY\['queued'::text, 'failed'::text\]\)\)/i);
for (const role of ["anon", "authenticated"]) {
  const { rows: [privileges] } = await db.query("select has_function_privilege($1,'public.rafa_claim_due_reminders(integer)','execute') as can_execute", [role]);
  assert.equal(privileges.can_execute, false);
}
const { rows: [servicePrivileges] } = await db.query("select has_function_privilege('service_role','public.rafa_claim_due_reminders(integer)','execute') as can_execute");
assert.equal(servicePrivileges.can_execute, true);
await db.close();
console.log("Reminder at-most-once migration passed: rerunnable schema, old processing quarantine, service-only claim, and no automatic reclaim of processing/sending/uncertain jobs.");
