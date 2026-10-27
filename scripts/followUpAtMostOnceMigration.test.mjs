import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

const migration = await readFile("supabase/migrations/20261011130100_rafa_follow_up_at_most_once.sql", "utf8");
const db = new PGlite();
const timestamp = (hoursAgo) => new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
await db.exec(`
  create role anon;
  create role authenticated;
  create role service_role bypassrls;
  create table public.rafa_contacts (
    id uuid primary key,
    whatsapp_jid text not null unique,
    last_follow_up_sent timestamptz
  );
  create table public.rafa_conversation_turns (
    id uuid primary key,
    contact_id uuid not null references public.rafa_contacts(id),
    response text not null default '',
    at timestamptz not null default now()
  );
  create table public.rafa_contact_consents (
    contact_id uuid not null references public.rafa_contacts(id),
    consent_type text not null,
    state text not null,
    purpose text not null,
    channel text not null,
    language text not null,
    source_turn_id uuid,
    primary key (contact_id, consent_type)
  );
  create table public.rafa_contact_blocks (
    whatsapp_jid text not null,
    status text not null
  );
  create table public.rafa_follow_up_states (
    contact_id uuid primary key references public.rafa_contacts(id),
    consent_state text not null default 'unknown' check (consent_state in ('unknown','granted','denied','revoked')),
    status text not null default 'idle' check (status in ('idle','eligible','scheduled','sent','suppressed')),
    next_due_at timestamptz,
    last_sent_at timestamptz,
    updated_at timestamptz not null default now(),
    constraint rafa_follow_up_state_dates check (last_sent_at is null or next_due_at is null or next_due_at >= last_sent_at)
  );
  grant select, insert, update on public.rafa_contacts, public.rafa_conversation_turns,
    public.rafa_contact_consents, public.rafa_contact_blocks, public.rafa_follow_up_states to service_role;
  insert into public.rafa_contacts(id,whatsapp_jid) values
    ('00000000-0000-4000-8000-000000000001','100@s.whatsapp.net'),
    ('00000000-0000-4000-8000-000000000002','200@s.whatsapp.net'),
    ('00000000-0000-4000-8000-000000000003','300@s.whatsapp.net'),
    ('00000000-0000-4000-8000-000000000004','400@s.whatsapp.net'),
    ('00000000-0000-4000-8000-000000000005','500@s.whatsapp.net');
  insert into public.rafa_follow_up_states(contact_id,consent_state,status,last_sent_at)
    values ('00000000-0000-4000-8000-000000000004','granted','sent','${timestamp(12)}');
  update public.rafa_contacts set last_follow_up_sent='${timestamp(12)}' where id='00000000-0000-4000-8000-000000000005';
`);
await db.exec(migration);
await db.exec(migration); // Safe to re-run before rollout.

const { rows: [legacy] } = await db.query("select status,delivery_state,delivery_claim_id,delivery_error from public.rafa_follow_up_states where contact_id='00000000-0000-4000-8000-000000000004'");
assert.equal(legacy.status, "uncertain");
assert.equal(legacy.delivery_state, "uncertain");
assert.ok(legacy.delivery_claim_id);
assert.match(legacy.delivery_error, /Pre-upgrade/);

await db.query(`insert into public.rafa_conversation_turns(id,contact_id,response,at) values
  ('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','Consent recorded','${timestamp(30)}'),
  ('10000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','A helpful answer','${timestamp(26)}'),
  ('20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','Consent recorded','${timestamp(54)}'),
  ('20000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000002','A helpful answer','${timestamp(50)}'),
  ('30000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000003','Consent recorded','${timestamp(30)}'),
  ('30000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003','A helpful answer','${timestamp(26)}'),
  ('50000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000005','Consent recorded','${timestamp(30)}'),
  ('50000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000005','A helpful answer','${timestamp(26)}')`);
await db.query(`insert into public.rafa_contact_consents(contact_id,consent_type,state,purpose,channel,language,source_turn_id) values
  ('00000000-0000-4000-8000-000000000001','automated_reminder','granted','automated_reminder','whatsapp','en','10000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000002','automated_reminder','granted','automated_reminder','whatsapp','el','20000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000003','automated_reminder','granted','automated_reminder','whatsapp','ar','30000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000005','automated_reminder','granted','automated_reminder','whatsapp','en','50000000-0000-4000-8000-000000000001')`);

const claim = (contactId, claimId, consentTurnId, triggerTurnId) => db.query(
  "select public.rafa_claim_follow_up_send($1::uuid,$2::uuid,$3::uuid,$4::uuid) as claimed",
  [contactId, claimId, consentTurnId, triggerTurnId]
);
const finish = (contactId, claimId, outcome, providerMessageId = null) => db.query(
  "select public.rafa_finish_follow_up_send($1::uuid,$2::uuid,$3::text,$4::text,$5::text,$6::timestamptz) as finished",
  [contactId, claimId, outcome, outcome === "uncertain" ? "provider_outcome_ambiguous" : outcome === "retryable" ? "provider_confirmed_not_sent" : null, providerMessageId, outcome === "sent" && contactId.endsWith("0002") ? timestamp(48) : new Date().toISOString()]
);

const contact1 = "00000000-0000-4000-8000-000000000001";
const claims = await Promise.all([
  claim(contact1,"90000000-0000-4000-8000-000000000001","10000000-0000-4000-8000-000000000001","10000000-0000-4000-8000-000000000002"),
  claim(contact1,"90000000-0000-4000-8000-000000000002","10000000-0000-4000-8000-000000000001","10000000-0000-4000-8000-000000000002")
]);
assert.equal(claims.filter(({ rows }) => rows[0].claimed).length, 1, "only one concurrent worker can claim a contact");
const winner = claims.find(({ rows }) => rows[0].claimed);
const winningClaim = winner === claims[0] ? "90000000-0000-4000-8000-000000000001" : "90000000-0000-4000-8000-000000000002";
assert.equal((await finish(contact1, winningClaim, "uncertain")).rows[0].finished, true);
assert.equal((await claim(contact1,"90000000-0000-4000-8000-000000000003","10000000-0000-4000-8000-000000000001","10000000-0000-4000-8000-000000000002")).rows[0].claimed, false, "uncertain outcomes are never auto-reclaimed");
assert.equal((await finish(contact1, winningClaim, "sent")).rows[0].finished, false, "stale claim tokens cannot overwrite a terminal result");

const contact2 = "00000000-0000-4000-8000-000000000002";
const consent1 = "20000000-0000-4000-8000-000000000001";
const trigger1 = "20000000-0000-4000-8000-000000000002";
const retryClaim = "90000000-0000-4000-8000-000000000004";
assert.equal((await claim(contact2,retryClaim,consent1,trigger1)).rows[0].claimed, true);
assert.equal((await finish(contact2,retryClaim,"retryable")).rows[0].finished, true);
const retryClaim2 = "90000000-0000-4000-8000-000000000005";
assert.equal((await claim(contact2,retryClaim2,consent1,trigger1)).rows[0].claimed, true, "explicitly confirmed not-sent outcomes may retry");
assert.equal((await finish(contact2,retryClaim2,"sent","provider-message-1")).rows[0].finished, true);
assert.equal((await claim(contact2,"90000000-0000-4000-8000-000000000006",consent1,trigger1)).rows[0].claimed, false);
const { rows: [sentState] } = await db.query("select status,delivery_state,last_sent_at,provider_message_id from public.rafa_follow_up_states where contact_id=$1",[contact2]);
assert.equal(sentState.status,"sent");
assert.equal(sentState.delivery_state,"sent");
assert.ok(sentState.last_sent_at);
assert.equal(sentState.provider_message_id,"provider-message-1");
const { rows: [contact] } = await db.query("select last_follow_up_sent from public.rafa_contacts where id=$1",[contact2]);
assert.ok(contact.last_follow_up_sent);

// A later purpose-bound grant permits a new claim after a prior confirmed send.
await db.query(`insert into public.rafa_conversation_turns(id,contact_id,response,at) values
  ('20000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000002','Fresh consent','${timestamp(27)}'),
  ('20000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000002','A later helpful answer','${timestamp(25)}')`);
await db.query("update public.rafa_contact_consents set source_turn_id='20000000-0000-4000-8000-000000000003' where contact_id=$1",[contact2]);
assert.equal((await claim(contact2,"90000000-0000-4000-8000-000000000007","20000000-0000-4000-8000-000000000003","20000000-0000-4000-8000-000000000004")).rows[0].claimed,true);

const contact3 = "00000000-0000-4000-8000-000000000003";
await db.query("insert into public.rafa_contact_blocks(whatsapp_jid,status) values('300@s.whatsapp.net','active')");
assert.equal((await claim(contact3,"90000000-0000-4000-8000-000000000008","30000000-0000-4000-8000-000000000001","30000000-0000-4000-8000-000000000002")).rows[0].claimed,false,"blocked contacts cannot be claimed");
assert.equal((await claim(contact3,"90000000-0000-4000-8000-000000000009","30000000-0000-4000-8000-000000000001","10000000-0000-4000-8000-000000000002")).rows[0].claimed,false,"trigger turns from another contact are rejected");
assert.equal((await claim("00000000-0000-4000-8000-000000000005","90000000-0000-4000-8000-000000000010","50000000-0000-4000-8000-000000000001","50000000-0000-4000-8000-000000000002")).rows[0].claimed,false,"legacy contact send timestamps prevent a duplicate when no workflow row exists");

for (const role of ["anon", "authenticated"]) {
  for (const signature of [
    "public.rafa_claim_follow_up_send(uuid,uuid,uuid,uuid)",
    "public.rafa_finish_follow_up_send(uuid,uuid,text,text,text,timestamptz)"
  ]) {
    const { rows: [privileges] } = await db.query("select has_function_privilege($1,$2,'execute') as can_execute", [role, signature]);
    assert.equal(privileges.can_execute, false);
  }
}
for (const signature of [
  "public.rafa_claim_follow_up_send(uuid,uuid,uuid,uuid)",
  "public.rafa_finish_follow_up_send(uuid,uuid,text,text,text,timestamptz)"
]) {
  const { rows: [privileges] } = await db.query("select has_function_privilege('service_role',$1,'execute') as can_execute", [signature]);
  assert.equal(privileges.can_execute, true);
}

await db.close();
console.log("Follow-up at-most-once migration passed: one concurrent claim, terminal ambiguity, retryable definite failure, fresh-grant renewal, live suppression, provenance checks, and service-only RPC permissions.");
