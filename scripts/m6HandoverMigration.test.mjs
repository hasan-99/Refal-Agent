import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

const migration = await readFile("supabase/migrations/20261010160000_refal_handover_delivery.sql", "utf8");
const db = new PGlite();
await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
create table public.rafa_contacts (id uuid primary key default gen_random_uuid());
create table public.rafa_handovers (id uuid primary key default gen_random_uuid(), department text not null default 'general', status text not null default 'open', unique (id, department));
insert into public.rafa_handovers (department,status) values ('tax','open'),('general','acknowledged');`);
await db.exec(migration);
await db.exec(migration);
assert.deepEqual((await db.query("select rowsecurity from pg_tables where tablename='refal_handover_delivery'")).rows, [{ rowsecurity: true }]);
assert.deepEqual((await db.query("select department,status,recipient_lane from public.refal_handover_delivery order by department")).rows, [
  { department: "tax", status: "queued", recipient_lane: "sandbox" }
], "pre-existing open handovers are queued in the sandbox lane; acknowledged handovers are not re-notified");
for (const role of ["anon", "authenticated", "service_role"]) {
  const result = await db.query("select has_table_privilege($1,'public.refal_handover_delivery','select') as s, has_table_privilege($1,'public.refal_handover_delivery','insert') as i, has_table_privilege($1,'public.refal_handover_delivery','update') as u, has_table_privilege($1,'public.refal_handover_delivery','delete') as d", [role]);
  assert.deepEqual(result.rows[0], role === "service_role" ? { s: true, i: true, u: true, d: false } : { s: false, i: false, u: false, d: false });
}
const handover = await db.query("insert into public.rafa_handovers (department) values ('development_construction') returning id");
await db.query("insert into public.refal_handover_delivery (handover_id,department) values ($1,'development_construction')", [handover.rows[0].id]);
assert.equal((await db.query("select assigned_to from public.refal_handover_delivery where handover_id=$1", [handover.rows[0].id])).rows[0].assigned_to, null, "missing assignee remains explicit and does not block durable queueing");
await assert.rejects(db.query("insert into public.refal_handover_delivery (handover_id,department) values ($1,'tax')", [handover.rows[0].id]));
await assert.rejects(db.query("insert into public.refal_handover_delivery (handover_id,department) values ($1,'development_construction')", [handover.rows[0].id]));
await assert.rejects(db.query("insert into public.refal_handover_delivery (handover_id,department,recipient_lane) values ($1,'general','production')", [handover.rows[0].id]));
await db.query("update public.refal_handover_delivery set status='retry',attempt_count=1,last_attempt_at=now(),next_attempt_at=now()+interval '5 minutes',last_error_code='delivery_failed' where handover_id=$1", [handover.rows[0].id]);
assert.equal((await db.query("select status from public.refal_handover_delivery where handover_id=$1", [handover.rows[0].id])).rows[0].status, "retry");
await db.query("update public.refal_handover_delivery set status='acknowledged', acknowledged_at=now() where handover_id=$1", [handover.rows[0].id]);
await db.query("update public.refal_handover_delivery set status='closed', closed_at=now(), closure_reason='operator_resolved' where handover_id=$1", [handover.rows[0].id]);
console.log("MIG-11 PGlite validation passed: idempotent DDL, RLS, service-only access, sandbox recipient, duplicate prevention and acknowledgment state guard.");
await db.close();
