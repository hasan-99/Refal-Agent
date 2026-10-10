import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

const migration = await readFile("supabase/migrations/20261010223651_refal_m9_consent_scopes.sql", "utf8");
const db = new PGlite();
await db.exec(`
  create role anon;
  create role authenticated;
  create role service_role bypassrls;
  create table public.rafa_contacts (id uuid primary key default gen_random_uuid());
  create table public.rafa_conversation_turns (id uuid primary key default gen_random_uuid(), contact_id uuid not null references public.rafa_contacts(id), at timestamptz not null default now());
  create table public.rafa_contact_consents (
    id uuid primary key default gen_random_uuid(),
    contact_id uuid not null references public.rafa_contacts(id) on delete cascade,
    consent_type text not null check (consent_type in ('follow_up')),
    state text not null check (state in ('unknown','granted','denied','revoked')),
    source_turn_id uuid references public.rafa_conversation_turns(id) on delete set null,
    observed_at timestamptz not null default now(),
    unique(contact_id, consent_type)
  );
  alter table public.rafa_contact_consents enable row level security;
  revoke all on public.rafa_contact_consents from public, anon, authenticated;
  grant select, insert, update, delete on public.rafa_contact_consents to service_role;
`);
const { rows: [contact] } = await db.query("insert into public.rafa_contacts default values returning id");
await db.query("insert into public.rafa_contact_consents(contact_id,consent_type,state) values ($1,'follow_up','granted')", [contact.id]);
await db.exec(migration);
await db.exec(migration);

const existing = await db.query("select consent_type,state,purpose,language,channel from public.rafa_contact_consents where contact_id=$1", [contact.id]);
assert.deepEqual(existing.rows, [{ consent_type: "follow_up", state: "granted", purpose: "specialist_contact", language: "unknown", channel: "whatsapp" }]);
const { rows: [initialOffer] } = await db.query("insert into public.rafa_conversation_turns(contact_id,at) values($1,now()-interval '30 seconds') returning id", [contact.id]);
const { rows: [initialConfirmation] } = await db.query("insert into public.rafa_conversation_turns(contact_id,at) values($1,now()) returning id", [contact.id]);
await db.query("insert into public.rafa_contact_consents(contact_id,consent_type,state,purpose,language,channel,source_turn_id,offer_source_turn_id) values ($1,'automated_reminder','granted','automated_reminder','ar','whatsapp',$2,$3)", [contact.id, initialConfirmation.id, initialOffer.id]);
await assert.rejects(db.query("insert into public.rafa_contact_consents(contact_id,consent_type,state,purpose,language,channel,source_turn_id,offer_source_turn_id) values ($1,'automated_reminder','granted','specialist_contact','en','whatsapp',$2,$3)", [contact.id, initialConfirmation.id, initialOffer.id]));
await assert.rejects(db.query("insert into public.rafa_contact_consents(contact_id,consent_type,state,purpose,language,channel,source_turn_id,offer_source_turn_id) values ($1,'automated_reminder','granted','automated_reminder','fr','whatsapp',$2,$3)", [contact.id, initialConfirmation.id, initialOffer.id]));
await assert.rejects(db.query("insert into public.rafa_contact_consents(contact_id,consent_type,state,purpose,language,channel) values ($1,'automated_reminder','granted','automated_reminder','en','whatsapp')", [contact.id]), /check constraint/i, "automated grants require confirmation and offer references");
const both = await db.query("select consent_type,state from public.rafa_contact_consents where contact_id=$1 order by consent_type", [contact.id]);
assert.deepEqual(both.rows, [{ consent_type: "automated_reminder", state: "granted" }, { consent_type: "follow_up", state: "granted" }], "scopes are separately persisted");
const { rows: [oldOffer] } = await db.query("insert into public.rafa_conversation_turns(contact_id,at) values($1,now()-interval '1 day') returning id", [contact.id]);
await db.query("update public.rafa_contact_consents set state='revoked',offer_source_turn_id=$2 where contact_id=$1 and consent_type='automated_reminder'", [contact.id, oldOffer.id]);
const { rows: [confirmation] } = await db.query("insert into public.rafa_conversation_turns(contact_id,at) values($1,now()) returning id", [contact.id]);
await assert.rejects(db.query(`
  insert into public.rafa_contact_consents(contact_id,consent_type,state,purpose,language,channel,source_turn_id,offer_source_turn_id)
  values($1,'automated_reminder','granted','automated_reminder','en','whatsapp',$2,$3)
  on conflict(contact_id,consent_type) do update set state=excluded.state,source_turn_id=excluded.source_turn_id,offer_source_turn_id=excluded.offer_source_turn_id
`, [contact.id, confirmation.id, oldOffer.id]), /fresh automated reminder offer/i, "stale consent cannot override a committed opt-out");
const { rows: [freshOffer] } = await db.query("insert into public.rafa_conversation_turns(contact_id,at) values($1,now()+interval '1 day') returning id", [contact.id]);
const { rows: [freshConfirmation] } = await db.query("insert into public.rafa_conversation_turns(contact_id,at) values($1,now()+interval '1 day 1 second') returning id", [contact.id]);
await db.query(`
  insert into public.rafa_contact_consents(contact_id,consent_type,state,purpose,language,channel,source_turn_id,offer_source_turn_id)
  values($1,'automated_reminder','granted','automated_reminder','en','whatsapp',$2,$3)
  on conflict(contact_id,consent_type) do update set state=excluded.state,source_turn_id=excluded.source_turn_id,offer_source_turn_id=excluded.offer_source_turn_id
`, [contact.id, freshConfirmation.id, freshOffer.id]);
const { rows: [renewed] } = await db.query("select state,offer_source_turn_id from public.rafa_contact_consents where contact_id=$1 and consent_type='automated_reminder'", [contact.id]);
assert.deepEqual(renewed, { state: "granted", offer_source_turn_id: freshOffer.id }, "renewed consent requires a later explicit offer");
const rls = await db.query("select rowsecurity from pg_tables where schemaname='public' and tablename='rafa_contact_consents'");
assert.deepEqual(rls.rows, [{ rowsecurity: true }]);
for (const role of ["anon", "authenticated", "service_role"]) {
  const { rows: [access] } = await db.query("select has_table_privilege($1,'public.rafa_contact_consents','select') as can_select", [role]);
  assert.equal(access.can_select, role === "service_role", `${role} access remains unchanged`);
}
await db.close();
console.log("MIG-09 PGlite validation passed: idempotent migration, legacy backfill, independent scopes, stale regrant rejection, fresh-offer reconsent, constrained provenance vocabulary, and RLS/privilege boundary.");
