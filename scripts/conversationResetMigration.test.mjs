import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const migration = await readFile("supabase/migrations/20261013133938_reset_conversation_context.sql", "utf8");
const contactId = "10000000-0000-4000-8000-000000000001";
const otherId = "20000000-0000-4000-8000-000000000002";
const jid = "15551234567@s.whatsapp.net";
const otherJid = "15557654321@s.whatsapp.net";
const token = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

async function setup() {
  const db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create table public.rafa_contacts (
      id uuid primary key, whatsapp_jid text not null unique, phone text not null,
      profile jsonb not null default '{}'::jsonb, step text, whatsapp jsonb not null default '{}'::jsonb,
      booking jsonb, last_follow_up_sent timestamptz, updated_at timestamptz default now()
    );
    create table public.rafa_conversation_turns (
      id uuid primary key, contact_id uuid references public.rafa_contacts(id),
      user_id text not null, message text not null default '', response text not null default ''
    );
    create table public.rafa_inbound_message_receipts (
      whatsapp_jid text not null, message_id text not null, status text not null,
      first_seen_at timestamptz not null default now(), last_attempt_at timestamptz not null default now(),
      processed_at timestamptz, lease_token uuid, lease_expires_at timestamptz,
      primary key (whatsapp_jid, message_id)
    );
    create table public.rafa_contact_consents (
      contact_id uuid not null references public.rafa_contacts(id), consent_type text not null,
      state text not null, observed_at timestamptz not null default now(),
      source_turn_id uuid references public.rafa_conversation_turns(id) on delete set null,
      primary key (contact_id, consent_type)
    );
    create table public.rafa_follow_up_states (
      contact_id uuid primary key references public.rafa_contacts(id),
      consent_state text not null, status text not null, next_due_at timestamptz,
      delivery_state text not null default 'idle', updated_at timestamptz not null default now()
    );
    create table public.refal_lead_profile (contact_id uuid primary key references public.rafa_contacts(id), identity_fields jsonb not null default '{}'::jsonb);
    create table public.refal_lead_score (contact_id uuid primary key references public.rafa_contacts(id));
    create table public.rafa_lead_qualifications (contact_id uuid primary key references public.rafa_contacts(id));
    create table public.rafa_contact_intents (contact_id uuid primary key references public.rafa_contacts(id));
    create table public.rafa_opportunity_intakes (contact_id uuid primary key references public.rafa_contacts(id));
    create table public.rafa_existing_client_verifications (contact_id uuid primary key references public.rafa_contacts(id));
    create table public.rafa_appointments (contact_id uuid primary key references public.rafa_contacts(id));
    create table public.rafa_handovers (contact_id uuid primary key references public.rafa_contacts(id));
    create table public.rafa_complaints (contact_id uuid primary key references public.rafa_contacts(id));
    create table public.rafa_contact_blocks (whatsapp_jid text primary key, status text not null);
    create table public.rafa_audit_events (
      id uuid primary key default gen_random_uuid(), contact_id uuid references public.rafa_contacts(id),
      event text not null, actor_type text not null, source text not null, details jsonb not null default '{}'::jsonb
    );
    insert into public.rafa_contacts(id,whatsapp_jid,phone,profile,step,whatsapp,booking) values
      ('${contactId}','${jid}','15551234567',
       '{"name":"كريم","nameSource":"customer_stated","nameOverride":"كريم","conversationSummary":"Old interest","agentFacts":{"businessactivity":{"value":"Consulting"}},"followUpBlocked":true,"qaControlledDiagnostics":true,"qaSessionStartedAt":"2026-10-12T12:00:00Z","conversationPreferences":{"noProactiveBookingOrContact":true,"oldPreference":"discard"}}',
       'qualification','{"pushName":"External label"}','{"status":"awaiting_details"}'),
      ('${otherId}','${otherJid}','15557654321','{"name":"Other customer"}','name','{}',null);
    insert into public.rafa_conversation_turns(id,contact_id,user_id,message,response) values
      ('30000000-0000-4000-8000-000000000001','${contactId}','${jid}','مرحبا انا كريم','أهلا كريم'),
      ('30000000-0000-4000-8000-000000000002','${contactId}','${jid}','خدمات الشركة؟','جواب'),
      ('30000000-0000-4000-8000-000000000003','${otherId}','${otherJid}','hello','hi');
    insert into public.rafa_contact_consents(contact_id,consent_type,state,source_turn_id) values
      ('${contactId}','follow_up','granted','30000000-0000-4000-8000-000000000001'),
      ('${contactId}','automated_reminder','denied',null);
    insert into public.rafa_follow_up_states(contact_id,consent_state,status,next_due_at) values
      ('${contactId}','granted','scheduled',now() + interval '1 day');
    insert into public.refal_lead_profile(contact_id,identity_fields) values ('${contactId}','{"name":"كريم"}');
    insert into public.refal_lead_score(contact_id) values ('${contactId}');
    insert into public.rafa_lead_qualifications(contact_id) values ('${contactId}');
    insert into public.rafa_contact_intents(contact_id) values ('${contactId}');
    insert into public.rafa_opportunity_intakes(contact_id) values ('${contactId}');
    insert into public.rafa_existing_client_verifications(contact_id) values ('${contactId}');
    insert into public.rafa_appointments(contact_id) values ('${contactId}');
    insert into public.rafa_handovers(contact_id) values ('${contactId}');
    insert into public.rafa_complaints(contact_id) values ('${contactId}');
    insert into public.rafa_contact_blocks(whatsapp_jid,status) values ('${jid}','active');
    insert into public.rafa_audit_events(contact_id,event,actor_type,source) values ('${contactId}','prior_audit','admin','test');
  `);
  await db.exec(migration);
  return db;
}

async function reset(db, userId = jid) {
  const { rows: [row] } = await db.query("select public.refal_reset_conversation_context($1) as result", [userId]);
  return row.result;
}

test("conversation reset clears personal context atomically and retains operational safeguards", async () => {
  const db = await setup();
  try {
    assert.deepEqual(await reset(db), { deleted: true, deletedTurns: 2 });
    const { rows: [contact] } = await db.query("select profile,step,whatsapp,booking from public.rafa_contacts where id=$1", [contactId]);
    assert.deepEqual(contact.profile, {
      followUpBlocked: true,
      qaControlledDiagnostics: true,
      qaSessionStartedAt: "2026-10-12T12:00:00Z",
      conversationPreferences: { noProactiveBookingOrContact: true }
    });
    assert.equal(contact.step, "name");
    assert.equal(contact.booking, null);
    assert.deepEqual(contact.whatsapp, { pushName: "External label" });

    const { rows: [counts] } = await db.query(`
      select
        (select count(*)::int from public.rafa_conversation_turns where contact_id=$1) as turns,
        (select count(*)::int from public.refal_lead_profile where contact_id=$1) as crm,
        (select count(*)::int from public.refal_lead_score where contact_id=$1) as score,
        (select count(*)::int from public.rafa_lead_qualifications where contact_id=$1) as qualification,
        (select count(*)::int from public.rafa_contact_intents where contact_id=$1) as intents,
        (select count(*)::int from public.rafa_opportunity_intakes where contact_id=$1) as opportunities,
        (select count(*)::int from public.rafa_existing_client_verifications where contact_id=$1) as verification,
        (select count(*)::int from public.rafa_appointments where contact_id=$1) as appointments,
        (select count(*)::int from public.rafa_handovers where contact_id=$1) as handovers,
        (select count(*)::int from public.rafa_complaints where contact_id=$1) as complaints,
        (select count(*)::int from public.rafa_audit_events where contact_id=$1 and event='prior_audit') as prior_audit,
        (select count(*)::int from public.rafa_contact_blocks where whatsapp_jid=$2 and status='active') as blocks
    `, [contactId, jid]);
    assert.deepEqual(counts, {
      turns: 0, crm: 0, score: 0, qualification: 0, intents: 0, opportunities: 0, verification: 0,
      appointments: 1, handovers: 1, complaints: 1, prior_audit: 1, blocks: 1
    });
    const { rows: consents } = await db.query("select consent_type,state,source_turn_id from public.rafa_contact_consents where contact_id=$1 order by consent_type", [contactId]);
    assert.deepEqual(consents, [
      { consent_type: "automated_reminder", state: "denied", source_turn_id: null },
      { consent_type: "follow_up", state: "revoked", source_turn_id: null }
    ]);
    const { rows: [followUp] } = await db.query("select consent_state,status,next_due_at from public.rafa_follow_up_states where contact_id=$1", [contactId]);
    assert.deepEqual(followUp, { consent_state: "revoked", status: "suppressed", next_due_at: null });
    const { rows: [other] } = await db.query("select profile from public.rafa_contacts where id=$1", [otherId]);
    assert.deepEqual(other.profile, { name: "Other customer" });
    const { rows: [otherTurns] } = await db.query("select count(*)::int as count from public.rafa_conversation_turns where contact_id=$1", [otherId]);
    assert.equal(otherTurns.count, 1);
    const { rows: [audit] } = await db.query("select details from public.rafa_audit_events where contact_id=$1 and event='conversation_context_reset'", [contactId]);
    assert.deepEqual(audit.details, { deleted_turns: 2 });
    assert.deepEqual(await reset(db), { deleted: true, deletedTurns: 0 }, "a previously emptied contact can still be reset");
  } finally {
    await db.close();
  }
});

test("processing inbound receipt prevents a reset and leaves all data intact", async () => {
  const db = await setup();
  try {
    const { rows: [claim] } = await db.query("select public.refal_claim_inbound_message($1,$2,$3) as result", [jid, "in-flight", token]);
    assert.equal(claim.result.claimed, true);
    await assert.rejects(reset(db), /Conversation has a message in progress/);
    const { rows: [before] } = await db.query("select profile from public.rafa_contacts where id=$1", [contactId]);
    assert.equal(before.profile.name, "كريم");
    const { rows: [turns] } = await db.query("select count(*)::int as count from public.rafa_conversation_turns where contact_id=$1", [contactId]);
    assert.equal(turns.count, 2);
    await db.query("update public.rafa_inbound_message_receipts set lease_expires_at=clock_timestamp()-interval '1 second' where whatsapp_jid=$1", [jid]);
    await assert.rejects(reset(db), /Conversation has a message in progress/, "expired lease may still have a live worker");
    await db.query("update public.rafa_inbound_message_receipts set status='processed',lease_token=null,lease_expires_at=null where whatsapp_jid=$1", [jid]);
    assert.deepEqual(await reset(db), { deleted: true, deletedTurns: 2 });
  } finally {
    await db.close();
  }
});
