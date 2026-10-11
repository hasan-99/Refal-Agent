import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const migration = await readFile("supabase/migrations/20261011100000_refal_atomic_contact_corrections.sql", "utf8");

async function setup() {
  const db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create table public.rafa_contacts (
      id uuid primary key default gen_random_uuid(),
      whatsapp_jid text unique not null,
      profile jsonb not null default '{}'::jsonb
    );
    create table public.rafa_audit_events (
      id uuid primary key default gen_random_uuid(),
      contact_id uuid references public.rafa_contacts(id) on delete set null,
      event text not null,
      actor_type text not null,
      source text not null,
      details jsonb not null default '{}'::jsonb
    );
  `);
  return db;
}

test("MIG-14 contact correction compares, merges and audits atomically with service-only access", async () => {
  const db = await setup();
  try {
    await db.exec(migration);
    await db.exec(migration);
    const { rows: [contact] } = await db.query(
      "insert into public.rafa_contacts(whatsapp_jid,profile) values ('35799123456@s.whatsapp.net',$1) returning id",
      [{ nameOverride: "Mira", needOverride: "accounting", conversationSummary: "Existing summary" }]
    );
    const baseline = { nameOverride: "Mira", phoneOverride: "", needOverride: "accounting", conversationSummary: "Existing summary" };
    const { rows: [saved] } = await db.query(
      "select public.refal_correct_contact_profile($1,$2,$3,$4) as result",
      ["35799123456@s.whatsapp.net", baseline, { needOverride: "tax" }, "admin@refalco.com"]
    );
    assert.equal(saved.result.status, "saved");
    assert.equal(saved.result.profile.nameOverride, "Mira");
    assert.equal(saved.result.profile.needOverride, "tax");

    const { rows: [audit] } = await db.query("select * from public.rafa_audit_events");
    assert.equal(audit.contact_id, contact.id);
    assert.equal(audit.event, "contact_memory_admin_updated");
    assert.deepEqual(audit.details.fields, ["needOverride"]);
    assert.equal("previous" in audit.details, false);
    assert.equal("next" in audit.details, false);

    const { rows: [stale] } = await db.query(
      "select public.refal_correct_contact_profile($1,$2,$3,$4) as result",
      ["35799123456@s.whatsapp.net", baseline, { nameOverride: "Mira H" }, "admin@refalco.com"]
    );
    assert.equal(stale.result.status, "stale");
    const { rows: [count] } = await db.query("select count(*)::int as count from public.rafa_audit_events");
    assert.equal(count.count, 1, "a stale change must not write or audit");

    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      const { rows: [privilege] } = await db.query(
        "select has_function_privilege($1,'public.refal_correct_contact_profile(text,jsonb,jsonb,text)','execute') as can_correct",
        [role]
      );
      assert.equal(privilege.can_correct, role === "service_role");
    }
  } finally {
    await db.close();
  }
});
