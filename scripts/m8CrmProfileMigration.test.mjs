import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const migration = await readFile("supabase/migrations/20261011090000_refal_crm_lead_profile.sql", "utf8");

async function setup() {
  const db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create table public.rafa_contacts (id uuid primary key default gen_random_uuid());
    create table public.rafa_conversation_turns (id uuid primary key default gen_random_uuid(), contact_id uuid references public.rafa_contacts(id));
    create table public.refal_lead_profile (
      contact_id uuid primary key references public.rafa_contacts(id) on delete cascade,
      profile jsonb not null default '{}'::jsonb check (jsonb_typeof(profile) = 'object' and pg_column_size(profile) <= 12000),
      field_provenance jsonb not null default '{}'::jsonb check (jsonb_typeof(field_provenance) = 'object' and pg_column_size(field_provenance) <= 12000),
      source_turn_id uuid references public.rafa_conversation_turns(id) on delete set null,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now()
    );
    create index refal_lead_profile_source_turn_idx on public.refal_lead_profile(source_turn_id);
    alter table public.refal_lead_profile enable row level security;
    revoke all on table public.refal_lead_profile from public, anon, authenticated;
    grant select, insert, update, delete on table public.refal_lead_profile to service_role;
  `);
  return db;
}

test("MIG-07: adds the four MB 5.1 groups idempotently without losing existing CRM data", async () => {
  const db = await setup();
  try {
    const { rows: [contact] } = await db.query("insert into public.rafa_contacts default values returning id");
    await db.query("insert into public.refal_lead_profile(contact_id,profile,field_provenance) values ($1,$2,$3)", [
      contact.id,
      { name: "Maya", legacyNote: "preserved during schema transition" },
      { name: { source: "customer_message", source_turn_id: "turn-1" } }
    ]);
    await db.exec(migration);
    await db.exec(migration);

    const { rows: [row] } = await db.query("select * from public.refal_lead_profile where contact_id=$1", [contact.id]);
    assert.deepEqual(row.identity_fields, {});
    assert.deepEqual(row.opportunity_fields, {});
    assert.deepEqual(row.property_residency_fields, {});
    assert.deepEqual(row.qualification_fields, {});
    assert.deepEqual(row.profile, { name: "Maya", legacyNote: "preserved during schema transition" });
    assert.deepEqual(row.field_provenance, { name: { source: "customer_message", source_turn_id: "turn-1" } });

    await db.query(`update public.refal_lead_profile set
      identity_fields=$2, opportunity_fields=$3, property_residency_fields=$4, qualification_fields=$5
      where contact_id=$1`, [contact.id,
      { name: "Maya", preferredLanguage: "ar", countryOfResidence: "Cyprus" },
      { primaryIntent: "company formation", businessStatus: "new" },
      { residencyInterest: "information only", familyMembers: 3, sourceOfFundsStatus: "documents available" },
      { timeline: "this year", leadTier: "warm", appointmentStatus: "not booked" }
    ]);

    const duplicate = await db.query("select contact_id from public.refal_lead_profile where contact_id=$1", [contact.id]);
    assert.equal(duplicate.rows.length, 1, "contact_id primary key preserves one row per contact");
  } finally {
    await db.close();
  }
});

test("MIG-07: group constraints reject unknown fields, arrays, and oversized payloads", async () => {
  const db = await setup();
  try {
    const { rows: [contact] } = await db.query("insert into public.rafa_contacts default values returning id");
    await db.exec(migration);
    await db.query("insert into public.refal_lead_profile(contact_id) values ($1)", [contact.id]);
    await assert.rejects(db.query("update public.refal_lead_profile set identity_fields='[]'::jsonb where contact_id=$1", [contact.id]), /check constraint/i);
    await assert.rejects(db.query("update public.refal_lead_profile set identity_fields='{" + '"passportNumber":"12345"' + "}'::jsonb where contact_id=$1", [contact.id]), /check constraint/i);
    await assert.rejects(db.query("update public.refal_lead_profile set property_residency_fields=jsonb_build_object('sourceOfWealthOverview', repeat('x',4000)) where contact_id=$1", [contact.id]), /check constraint/i);
    await assert.rejects(db.query("update public.refal_lead_profile set crm_correction_needed='{" + '"field":"privateSecret","source_turn_id":"turn-a","recorded_at":"now"' + "}'::jsonb where contact_id=$1", [contact.id]), /check constraint/i);
    const { rows: [unchanged] } = await db.query("select identity_fields,property_residency_fields from public.refal_lead_profile where contact_id=$1", [contact.id]);
    assert.deepEqual(unchanged, { identity_fields: {}, property_residency_fields: {} }, "failed updates do not partially mutate the row");
  } finally {
    await db.close();
  }
});

test("MIG-07: enforces RLS and service-role-only table privileges", async () => {
  const db = await setup();
  try {
    await db.exec(migration);
    const rls = await db.query("select rowsecurity from pg_tables where schemaname='public' and tablename='refal_lead_profile'");
    assert.deepEqual(rls.rows, [{ rowsecurity: true }]);
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      const { rows: [privileges] } = await db.query(`select
        has_table_privilege($1,'public.refal_lead_profile','select') as can_select,
        has_table_privilege($1,'public.refal_lead_profile','insert') as can_insert,
        has_table_privilege($1,'public.refal_lead_profile','update') as can_update,
        has_table_privilege($1,'public.refal_lead_profile','delete') as can_delete,
        has_function_privilege($1,'public.refal_save_lead_profile_field(uuid,text,text,uuid,timestamp with time zone,boolean)','execute') as can_save_crm`, [role]);
      assert.deepEqual(privileges, role === "service_role"
        ? { can_select: true, can_insert: true, can_update: true, can_delete: true, can_save_crm: true }
        : { can_select: false, can_insert: false, can_update: false, can_delete: false, can_save_crm: false });
    }
  } finally {
    await db.close();
  }
});

test("MIG-07: atomic CRM RPC preserves parallel fields and requires contact-owned turns", async () => {
  const db = await setup();
  try {
    await db.exec(migration);
    const { rows: [contactA] } = await db.query("insert into public.rafa_contacts default values returning id");
    const { rows: [contactB] } = await db.query("insert into public.rafa_contacts default values returning id");
    const { rows: [turnA] } = await db.query("insert into public.rafa_conversation_turns(contact_id) values ($1) returning id", [contactA.id]);
    const { rows: [turnB] } = await db.query("insert into public.rafa_conversation_turns(contact_id) values ($1) returning id", [contactB.id]);
    const call = (field, value, turnId, correction = false) => db.query(
      "select public.refal_save_lead_profile_field($1,$2,$3,$4,now(),$5) as result",
      [contactA.id, field, value, turnId, correction]
    );
    assert.deepEqual((await call("businessActivity", "accounting", turnA.id)).rows[0].result, { status: "saved", field: "businessactivity", correction_field: null });
    await call("targetService", "company formation", turnA.id);
    let { rows: [row] } = await db.query("select opportunity_fields,field_provenance from public.refal_lead_profile where contact_id=$1", [contactA.id]);
    assert.deepEqual(row.opportunity_fields, { businessActivity: "accounting", targetService: "company formation" });
    assert.equal(row.field_provenance.businessActivity.source_turn_id, turnA.id);

    assert.deepEqual((await call("businessActivity", "construction", turnA.id)).rows[0].result, { status: "correction_needed", field: "businessactivity", correction_field: "businessactivity" });
    ({ rows: [row] } = await db.query("select opportunity_fields,crm_correction_needed from public.refal_lead_profile where contact_id=$1", [contactA.id]));
    assert.equal(row.opportunity_fields.businessActivity, "accounting", "conflict does not overwrite the prior fact");
    assert.equal(row.crm_correction_needed.field, "businessActivity");
    await call("mainMotivation", "new market", turnA.id, true);
    ({ rows: [row] } = await db.query("select qualification_fields,crm_correction_needed from public.refal_lead_profile where contact_id=$1", [contactA.id]));
    assert.equal(row.qualification_fields.mainMotivation, "new market");
    assert.equal(row.crm_correction_needed.field, "businessActivity", "an unrelated explicit correction cannot clear the outstanding field");
    await call("businessActivity", "construction", turnA.id, true);
    ({ rows: [row] } = await db.query("select opportunity_fields,crm_correction_needed from public.refal_lead_profile where contact_id=$1", [contactA.id]));
    assert.equal(row.opportunity_fields.businessActivity, "construction");
    assert.deepEqual(row.crm_correction_needed, {});
    await assert.rejects(call("targetService", "company formation", turnB.id), /does not belong to contact/i);
    await assert.rejects(call("privateSecret", "hidden", turnA.id), /Invalid CRM field update/i);
  } finally {
    await db.close();
  }
});
