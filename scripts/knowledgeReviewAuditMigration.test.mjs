import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const migration = await readFile("supabase/migrations/20261011080309_20261011073359_rafa_knowledge_review_audit.sql", "utf8");

async function setup() {
  const db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create table public.rafa_knowledge_documents (
      id uuid primary key default gen_random_uuid(),
      source_id uuid not null,
      review_status text not null check (review_status in ('approved','rejected','pending')) default 'pending',
      approved_at timestamptz,
      approved_by text
    );
    grant select, update on public.rafa_knowledge_documents to anon;
    create function public.rafa_dashboard_secret_matches() returns boolean
      language sql stable set search_path = ''
      as $$ select coalesce(current_setting('request.headers', true)::jsonb ->> 'x-rafa-dashboard-secret' = 'test-secret', false) $$;
    grant execute on function public.rafa_dashboard_secret_matches() to anon;
  `);
  return db;
}

test("review decisions append atomic reviewer/reason audit rows under dashboard-secret RLS", async () => {
  const db = await setup();
  try {
    await db.exec(migration);
    await db.exec(migration);
    const { rows: [doc] } = await db.query("insert into public.rafa_knowledge_documents(source_id) values (gen_random_uuid()) returning id");

    const { rows: [privileges] } = await db.query(`
      select has_table_privilege('anon','public.rafa_knowledge_review_audit','select') as anon_select,
             has_table_privilege('anon','public.rafa_knowledge_review_audit','insert') as anon_insert,
             has_table_privilege('anon','public.rafa_knowledge_review_audit','update') as anon_update,
             has_table_privilege('anon','public.rafa_knowledge_review_audit','delete') as anon_delete,
             has_table_privilege('authenticated','public.rafa_knowledge_review_audit','select') as auth_select,
             has_table_privilege('service_role','public.rafa_knowledge_review_audit','select') as service_select,
             has_table_privilege('service_role','public.rafa_knowledge_review_audit','insert') as service_insert
    `);
    assert.deepEqual(privileges, {
      anon_select: true, anon_insert: true, anon_update: false, anon_delete: false,
      auth_select: false, service_select: true, service_insert: false
    });

    await db.exec("set role anon");
    await db.query("select set_config('request.headers', '{}', false)");
    await assert.rejects(db.query(
      "select public.rafa_review_knowledge_document($1,'approved','reviewer@example.com','Checked source')",
      [doc.id]
    ), /row-level security/u);
    await db.exec("reset role");
    const { rows: [stillPending] } = await db.query("select review_status from public.rafa_knowledge_documents where id=$1", [doc.id]);
    assert.equal(stillPending.review_status, "pending", "failed audit insert must roll back the status update");
    assert.equal((await db.query("select count(*)::int as count from public.rafa_knowledge_review_audit")).rows[0].count, 0);

    await db.exec("set role anon");
    await db.query("select set_config('request.headers', '{\"x-rafa-dashboard-secret\":\"test-secret\"}', false)");
    const approved = await db.query(
      "select public.rafa_review_knowledge_document($1,'approved','reviewer@example.com','Verified against source') as result",
      [doc.id]
    );
    assert.equal(approved.rows[0].result.reviewer, "reviewer@example.com");
    assert.equal(approved.rows[0].result.reason, "Verified against source");
    await db.query("select public.rafa_review_knowledge_document($1,'rejected','reviewer@example.com','Evidence did not support claim')", [doc.id]);
    await db.query("select public.rafa_review_knowledge_document($1,'pending','second@example.com','Needs expert follow-up')", [doc.id]);
    await assert.rejects(db.query("select public.rafa_review_knowledge_document($1,'approved','reviewer@example.com','')", [doc.id]), /reason/u);
    await assert.rejects(db.query("select public.rafa_review_knowledge_document($1,null,'reviewer@example.com','Reason')", [doc.id]), /Unknown review status/u);

    const { rows: history } = await db.query(`
      select previous_status,new_status,reviewer,reason
      from public.rafa_knowledge_review_audit where document_id=$1 order by created_at,id
    `, [doc.id]);
    assert.deepEqual(history, [
      { previous_status: "pending", new_status: "approved", reviewer: "reviewer@example.com", reason: "Verified against source" },
      { previous_status: "approved", new_status: "rejected", reviewer: "reviewer@example.com", reason: "Evidence did not support claim" },
      { previous_status: "rejected", new_status: "pending", reviewer: "second@example.com", reason: "Needs expert follow-up" }
    ]);
    await assert.rejects(db.query("update public.rafa_knowledge_review_audit set reason='changed' where document_id=$1", [doc.id]), /permission denied/u);
    await assert.rejects(db.query("delete from public.rafa_knowledge_review_audit where document_id=$1", [doc.id]), /permission denied/u);
    await db.query("select set_config('request.headers', '{}', false)");
    assert.equal((await db.query("select count(*)::int as count from public.rafa_knowledge_review_audit")).rows[0].count, 0, "review history is hidden without the dashboard secret");
  } finally {
    await db.close();
  }
});
