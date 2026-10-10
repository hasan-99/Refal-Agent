import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

const db = new PGlite();
const setup = `
create role anon;
create role authenticated;
create role service_role bypassrls;
create table public.rafa_contacts (id uuid primary key default gen_random_uuid(), whatsapp_jid text not null unique);
create table public.rafa_conversation_turns (id uuid primary key default gen_random_uuid(), contact_id uuid references public.rafa_contacts(id) on delete cascade);
create table public.rafa_audit_events (
 id uuid primary key default gen_random_uuid(), contact_id uuid references public.rafa_contacts(id) on delete set null,
 event text not null check(length(btrim(event)) between 1 and 120), actor_type text not null check(actor_type in ('system','customer','operator','admin')),
 source text not null default 'rafa-agent-api' check(length(btrim(source)) between 1 and 120), details jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now(), check(jsonb_typeof(details)='object'), check(pg_column_size(details)<=6000)
);
create table public.rafa_priority_alerts (
 id uuid primary key default gen_random_uuid(), contact_id uuid not null references public.rafa_contacts(id),
 level text not null check(level in ('high','urgent')), trigger text not null,
 status text not null default 'open' check(status in ('open','acknowledged','resolved','dismissed')), details jsonb not null default '{}'::jsonb,
 source_turn_id uuid references public.rafa_conversation_turns(id), created_at timestamptz not null default now(), resolved_at timestamptz,
 constraint rafa_priority_alerts_trigger_check check(trigger in ('major_development','institutional_investment','strategic_partnership','complaint','severe_complaint','existing_client','safety_or_threat','material_business_opportunity'))
);
create unique index rafa_priority_alerts_open_unique_idx on public.rafa_priority_alerts(contact_id,trigger) where status in ('open','acknowledged');
create or replace function public.set_rafa_updated_at() returns trigger language plpgsql set search_path='' as $$ begin new.updated_at=now(); return new; end $$;
`;
const migration = await readFile("supabase/migrations/20261010080201_refal_dynamic_commercial_data.sql", "utf8");
await db.exec(setup);
await db.exec(migration);
await db.exec(migration);
const tables = await db.query(`select tablename, rowsecurity from pg_tables where schemaname='public' and tablename in ('refal_offers_and_pricing','refal_annual_renewal_fees','refal_property_inventory','refal_reservation_rules','refal_government_fees','refal_lead_profile') order by tablename`);
assert.equal(tables.rows.length, 6);
assert.ok(tables.rows.every((r) => r.rowsecurity));
const tableGrants = [];
for (const { tablename } of tables.rows) {
  const privileges = {};
  for (const privilege of ["select", "insert", "update", "delete"]) {
    const result = await db.query(`select has_table_privilege('service_role',$1,$2) as service, has_table_privilege('anon',$1,$2) as anon, has_table_privilege('authenticated',$1,$2) as authenticated`, [`public.${tablename}`, privilege]);
    assert.deepEqual(result.rows[0], { service: true, anon: false, authenticated: false }, `${tablename} ${privilege} privileges`);
    privileges[privilege] = result.rows[0];
  }
  tableGrants.push({ table: tablename, privileges });
}
const rpcSecurity = await db.query(`
  select p.proname, p.prosecdef, p.proconfig,
         has_function_privilege('service_role',p.oid,'execute') as service_execute,
         has_function_privilege('anon',p.oid,'execute') as anon_execute,
         has_function_privilege('authenticated',p.oid,'execute') as auth_execute
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in ('refal_mutate_dynamic_data','refal_claim_dynamic_action','refal_finish_dynamic_action','refal_upsert_dynamic_action_alert')
  order by p.proname`);
assert.equal(rpcSecurity.rows.length, 4);
assert.ok(rpcSecurity.rows.every((r) => !r.prosecdef && r.proconfig?.includes('search_path=""') && r.service_execute && !r.anon_execute && !r.auth_execute));
const seed = await db.query(`select amount,currency,valid_until,review_status from public.refal_offers_and_pricing where code='formation-package'`);
assert.equal(seed.rows.length, 1);
assert.equal(Number(seed.rows[0].amount), 999);
assert.equal(seed.rows[0].currency, "EUR");
const contact = await db.query(`insert into public.rafa_contacts(whatsapp_jid) values ('test@s.whatsapp.net') returning id`);
const contactId = contact.rows[0].id;
const turn = await db.query(`insert into public.rafa_conversation_turns(contact_id) values ($1) returning id`, [contactId]);
const created = await db.query(`select public.refal_mutate_dynamic_data('offers','create',null,'{"code":"test","title_en":"Test","amount":10,"valid_from":"2026-10-01T00:00:00Z","effective_from":"2026-10-01T00:00:00Z","valid_until":"2026-11-01T00:00:00Z","source_note":"fixture","active":false}'::jsonb,'operator@example.test','test create') as row`);
const createdId = created.rows[0].row.id;
const audit = await db.query(`select actor_type,details->>'reason' as reason from public.rafa_audit_events where source='refal-dynamic-admin' order by created_at desc limit 1`);
assert.equal(audit.rows[0].actor_type, 'operator');
assert.equal(audit.rows[0].reason, 'test create');
await db.query(`update public.refal_offers_and_pricing set updated_at='2000-01-01' where id=$1`, [createdId]);
await db.query(`update public.refal_offers_and_pricing set amount=11 where id=$1`, [createdId]);
const trigger = await db.query(`select updated_at > '2000-01-01'::timestamptz as trigger_ok from public.refal_offers_and_pricing where id=$1`, [createdId]);
assert.equal(trigger.rows[0].trigger_ok, true);
await assert.rejects(db.query(`insert into public.refal_reservation_rules(project_or_property_id,effective_from,valid_until,source_note) values ('bad',now(),now()+interval '1 day','fixture')`));
await assert.rejects(db.query(`insert into public.refal_offers_and_pricing(code,title_en,amount,valid_from,effective_from,valid_until,review_status,source_note) values ('bad-approval','Bad',1,now(),now(),now()+interval '1 day','approved','fixture')`));
const sourceTurnId = turn.rows[0].id;
const otherContact = await db.query(`insert into public.rafa_contacts(whatsapp_jid) values ('other@s.whatsapp.net') returning id`);
const otherTurn = await db.query(`insert into public.rafa_conversation_turns(contact_id) values ($1) returning id`, [otherContact.rows[0].id]);
await assert.rejects(db.query(`select public.refal_claim_dynamic_action($1,'upsertLead','cross-contact',repeat('d',64),$2)`, [contactId, otherTurn.rows[0].id]), /Verified source turn/i);
const claims = await db.query(`select public.refal_claim_dynamic_action($1,'upsertLead','key-1',repeat('a',64),$2) as first`, [contactId, sourceTurnId]);
assert.equal(claims.rows[0].first.claimed, true);
const duplicate = await db.query(`select public.refal_claim_dynamic_action($1,'upsertLead','key-1',repeat('a',64),$2) as second`, [contactId, sourceTurnId]);
assert.equal(duplicate.rows[0].second.claimed, false);
await assert.rejects(db.query(`select public.refal_claim_dynamic_action($1,'upsertLead','key-1',repeat('b',64),$2)`, [contactId, sourceTurnId]));
const claimedAlert = await db.query(`select details->>'receipt_id' as receipt_id,status from public.rafa_priority_alerts where contact_id=$1 and trigger='action_reconciliation'`, [contactId]);
assert.equal(claimedAlert.rows[0].status, 'open');
const secondClaim = await db.query(`select public.refal_claim_dynamic_action($1,'createHandover','key-2',repeat('c',64),$2) as result`, [contactId, sourceTurnId]);
const multipleReceipts = await db.query(`select details->'pending_receipts' as receipts from public.rafa_priority_alerts where contact_id=$1 and trigger='action_reconciliation'`, [contactId]);
assert.equal(multipleReceipts.rows[0].receipts.length, 2);
const acknowledge = await db.query(`update public.rafa_priority_alerts set status='acknowledged' where contact_id=$1 and trigger='action_reconciliation'`, [contactId]);
await db.query(`select public.refal_claim_dynamic_action($1,'upsertLead','key-1',repeat('a',64),$2)`, [contactId, sourceTurnId]);
const reopened = await db.query(`select status from public.rafa_priority_alerts where contact_id=$1 and trigger='action_reconciliation'`, [contactId]);
assert.equal(reopened.rows[0].status, 'open');
await db.query(`select public.refal_finish_dynamic_action($1,$2,repeat('a',64),'confirmed','{"id":"saved"}'::jsonb)`, [claims.rows[0].first.receipt_id, contactId]);
const oneStillPending = await db.query(`select status,jsonb_array_length(details->'pending_receipts') as remaining from public.rafa_priority_alerts where contact_id=$1 and trigger='action_reconciliation'`, [contactId]);
assert.equal(oneStillPending.rows[0].status, 'open');
assert.equal(oneStillPending.rows[0].remaining, 1);
await db.query(`select public.refal_finish_dynamic_action($1,$2,repeat('c',64),'confirmed','{"id":"saved-2"}'::jsonb)`, [secondClaim.rows[0].result.receipt_id, contactId]);
const resolvedAlert = await db.query(`select status from public.rafa_priority_alerts where contact_id=$1 and trigger='action_reconciliation'`, [contactId]);
assert.equal(resolvedAlert.rows[0].status, 'resolved');
const rateContact = await db.query(`insert into public.rafa_contacts(whatsapp_jid) values ('rate@s.whatsapp.net') returning id`);
const rateTurn = await db.query(`insert into public.rafa_conversation_turns(contact_id) values ($1) returning id`, [rateContact.rows[0].id]);
for (let i = 0; i < 12; i += 1) {
  const rate = await db.query(`select public.refal_claim_dynamic_action($1,'createHandover',$2,repeat('c',64),$3) as result`, [rateContact.rows[0].id, `rate-${i}`, rateTurn.rows[0].id]);
  assert.equal(rate.rows[0].result.claimed, true);
}
await assert.rejects(db.query(`select public.refal_claim_dynamic_action($1,'createHandover','rate-over',repeat('c',64),$2) as result`, [rateContact.rows[0].id, rateTurn.rows[0].id]), /rate limit/i);
const alertCount = await db.query(`select count(*)::int as count from public.rafa_priority_alerts where contact_id=$1 and trigger='action_reconciliation'`, [contactId]);
await assert.rejects(db.exec(`begin; alter table public.rafa_priority_alerts drop constraint rafa_priority_alerts_trigger_check; alter table public.rafa_priority_alerts add constraint rafa_priority_alerts_trigger_check check(trigger in ('major_development','institutional_investment','strategic_partnership','complaint','severe_complaint','existing_client','safety_or_threat','material_business_opportunity'));`), /check constraint|violates check/i);
await db.exec(`rollback;`);
await db.exec(`begin; delete from public.rafa_priority_alerts where trigger='action_reconciliation'; alter table public.rafa_priority_alerts drop constraint rafa_priority_alerts_trigger_check; alter table public.rafa_priority_alerts add constraint rafa_priority_alerts_trigger_check check(trigger in ('major_development','institutional_investment','strategic_partnership','complaint','severe_complaint','existing_client','safety_or_threat','material_business_opportunity')); rollback;`);
console.log(JSON.stringify({ pglite: "PostgreSQL WASM", tables: tables.rows, tableGrants, rpcSecurity: rpcSecurity.rows, seed: seed.rows[0], reconciliationAlert: { id: claimedAlert.rows[0].receipt_id, count: alertCount.rows[0].count, dedup: "per-contact alert retains all unresolved receipt IDs and resolves only when all finish" }, auditedMutation: audit.rows[0], updatedAtTrigger: trigger.rows[0].trigger_ok, constraintProbes: "rejected invalid deposit and approval", migrationRerun: "passed", rpcIdempotency: "passed", rateLimit: "12 allowed, 13th rejected" }, null, 2));
await db.close();
