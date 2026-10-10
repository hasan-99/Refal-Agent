import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

const migration = await readFile("supabase/migrations/20261010150000_refal_lead_score.sql", "utf8");
const db = new PGlite();
await db.exec(`
  create role anon;
  create role authenticated;
  create role service_role bypassrls;
  create table public.rafa_contacts (id uuid primary key default gen_random_uuid());
  create table public.rafa_conversation_turns (id uuid primary key default gen_random_uuid());
`);
await db.exec(migration);
await db.exec(migration);

const table = await db.query("select rowsecurity from pg_tables where schemaname='public' and tablename='refal_lead_score'");
assert.deepEqual(table.rows, [{ rowsecurity: true }]);
const privileges = await db.query(`
  select role_name, privilege, has_table_privilege(role_name, 'public.refal_lead_score', privilege) as allowed
  from (values ('service_role'), ('anon'), ('authenticated'), ('public')) roles(role_name)
  cross join (values ('select'), ('insert'), ('update'), ('delete')) privileges(privilege)
  order by role_name, privilege
`);
for (const row of privileges.rows) {
  assert.equal(row.allowed, row.role_name === "service_role" && ["select", "insert"].includes(row.privilege), `${row.role_name} ${row.privilege}`);
}
const contact = await db.query("insert into public.rafa_contacts default values returning id");
const fingerprint = "a".repeat(64);
const input = {
  contact_id: contact.rows[0].id,
  need: 1,
  value: 2,
  timing: 3,
  authority: 0,
  readiness: 4,
  fit: 5,
  tier: "hot",
  evidence_refs: JSON.stringify({ need: [{ sourceTurnId: "turn-a", excerptHash: fingerprint }] }),
  scorer_version: "qualification-v1",
  evidence_fingerprint: fingerprint,
  score_floor: 20
};
const inserted = await db.query(`
  insert into public.refal_lead_score (contact_id,need,value,timing,authority,readiness,fit,tier,evidence_refs,scorer_version,evidence_fingerprint,score_floor)
  values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12) returning total,effective_total
`, Object.values(input));
assert.deepEqual(inserted.rows[0], { total: 15, effective_total: 20 });
await assert.rejects(db.query(`
  insert into public.refal_lead_score (contact_id,need,value,timing,authority,readiness,fit,tier,scorer_version,evidence_fingerprint)
  values ($1,6,0,0,0,0,0,'informational','qualification-v1',$2)
`, [contact.rows[0].id, "b".repeat(64)]));
await assert.rejects(db.query(`
  insert into public.refal_lead_score (contact_id,need,value,timing,authority,readiness,fit,tier,scorer_version,evidence_fingerprint)
  values ($1,1,0,0,0,0,0,'informational','qualification-v1',$2)
`, [contact.rows[0].id, fingerprint]));
console.log("MIG-08 PGlite validation passed: idempotent DDL, RLS, least privilege, bounded scores, generated total and evidence-fingerprint dedupe.");
await db.close();
