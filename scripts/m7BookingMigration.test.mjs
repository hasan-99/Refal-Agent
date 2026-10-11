import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

const migration = await readFile("supabase/migrations/20261010210717_refal_booking_state_machine_m7.sql", "utf8");
const expectedPolicy = {
  timezone: "Europe/Nicosia",
  calendarId: "primary",
  weekdays: [1, 2, 3, 4, 5],
  startTime: "10:00",
  endTime: "15:00",
  durationMinutes: 60,
  durationOwnerConfirmed: true,
  minimumNoticeHours: 24,
  reminderHours: [24, 1],
  createMeetLink: true
};

async function fixture(existingPolicy = null) {
  const db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create table public.rafa_appointments (
      id uuid primary key default gen_random_uuid(),
      status text not null default 'pending_calendar'
        check (status in ('pending_calendar','confirmed','cancelled','completed','failed')),
      starts_at timestamptz not null
    );
    create index rafa_appointments_status_start_idx
      on public.rafa_appointments(status, starts_at)
      where status in ('pending_calendar','confirmed');
    create table public.rafa_settings (
      key text primary key,
      value jsonb not null default '{}'::jsonb,
      updated_at timestamptz not null default now()
    );
    alter table public.rafa_settings enable row level security;
    revoke all on table public.rafa_settings from anon, authenticated;
    grant all on table public.rafa_settings to service_role;
  `);
  if (existingPolicy) {
    await db.query("insert into public.rafa_settings(key,value) values('booking_policy',$1::jsonb)", [JSON.stringify(existingPolicy)]);
  }
  return db;
}

const fresh = await fixture();
await fresh.exec(migration);
await fresh.exec(migration); // DDL and default seed must both be rerunnable.

const seeded = await fresh.query("select value from public.rafa_settings where key='booking_policy'");
assert.deepEqual(seeded.rows, [{ value: expectedPolicy }], "fresh installs receive the exact durable booking policy defaults");

const statuses = ["draft", "awaiting_customer_confirmation", "creating", "confirmed", "pending_calendar", "failed", "cancelled"];
for (const status of statuses) {
  await fresh.query("insert into public.rafa_appointments(status,starts_at) values($1,now())", [status]);
}
await assert.rejects(
  fresh.query("insert into public.rafa_appointments(status,starts_at) values('unknown_state',now())"),
  /check constraint/i,
  "unknown appointment states must remain rejected"
);

const settingsRls = await fresh.query("select rowsecurity from pg_tables where schemaname='public' and tablename='rafa_settings'");
assert.deepEqual(settingsRls.rows, [{ rowsecurity: true }], "MIG-10 does not disable settings RLS");
for (const role of ["anon", "authenticated", "service_role"]) {
  const { rows } = await fresh.query(`
    select has_table_privilege($1,'public.rafa_settings','select') as s,
           has_table_privilege($1,'public.rafa_settings','insert') as i,
           has_table_privilege($1,'public.rafa_settings','update') as u,
           has_table_privilege($1,'public.rafa_settings','delete') as d
  `, [role]);
  assert.deepEqual(rows[0], role === "service_role"
    ? { s: true, i: true, u: true, d: true }
    : { s: false, i: false, u: false, d: false }, `${role} settings access`);
}
await fresh.close();

const existingOwnerPolicy = {
  timezone: "Europe/Nicosia",
  calendarId: "primary",
  weekdays: [1, 2, 3, 4, 5],
  startTime: "10:00",
  endTime: "15:00",
  durationMinutes: 30,
  durationOwnerConfirmed: true,
  minimumNoticeHours: 24,
  reminderHours: [24, 1],
  createMeetLink: true
};
const configured = await fixture(existingOwnerPolicy);
await configured.exec(migration);
await configured.exec(migration);
const preserved = await configured.query("select value from public.rafa_settings where key='booking_policy'");
assert.deepEqual(preserved.rows, [{ value: existingOwnerPolicy }], "the live 30-minute owner policy survives the ON CONFLICT DO NOTHING seed unchanged");
await configured.close();

console.log("MIG-10 PGlite validation passed: rerunnable DDL, seven appointment states, unknown-state rejection, durable defaults, owner-policy preservation, and settings RLS/service-role boundary.");
