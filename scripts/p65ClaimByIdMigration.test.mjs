import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

const outboxMigration = await readFile("supabase/migrations/20261001170000_rafa_notification_outbox.sql", "utf8");
const migration = await readFile("supabase/migrations/20261010170000_rafa_notification_claim_by_id.sql", "utf8");
const db = new PGlite();
await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
create function public.set_rafa_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
create table public.rafa_appointments (id uuid primary key default gen_random_uuid());`);
await db.exec(outboxMigration);
await db.exec("alter table public.rafa_notification_jobs drop constraint rafa_notification_jobs_kind_check, add constraint rafa_notification_jobs_kind_check check (kind in ('owner_review','customer_message','handover_review','admin_followup'))");
await db.exec(migration);
await db.exec(migration); // migration remains safely repeatable

assert.deepEqual((await db.query("select has_function_privilege('anon','public.rafa_claim_notification_by_id(uuid,uuid,text)','execute') as anon, has_function_privilege('authenticated','public.rafa_claim_notification_by_id(uuid,uuid,text)','execute') as authenticated, has_function_privilege('service_role','public.rafa_claim_notification_by_id(uuid,uuid,text)','execute') as service")).rows, [
  { anon: false, authenticated: false, service: true }
], "claim-by-ID is callable only by service_role");
assert.equal((await db.query("select has_function_privilege('service_role','public.rafa_claim_due_notifications(integer)','execute') as batch_rpc_unchanged")).rows[0].batch_rpc_unchanged, true);

const testRunId = "11111111-1111-4111-8111-111111111111";
const controlledRecipient = "controlled-admin@example.test";
const insert = async (key, status, { due = true, lockedMinutesAgo = null, attempts = 0, kind = "owner_review", recipient = `admin+${key}@example.test`, marker = null } = {}) => {
  const { rows } = await db.query(`insert into public.rafa_notification_jobs
    (channel,kind,recipient,payload,status,attempts,next_attempt_at,locked_at,idempotency_key)
    values ('email',$1,$2,$3::jsonb,$4,$5,
      case when $6 then now() - interval '1 minute' else now() + interval '1 hour' end,
      case when $7::integer is null then null else now() - ($7::integer * interval '1 minute') end,$8)
    returning id`, [kind, recipient, JSON.stringify(marker ? { p65TestRunId: marker } : {}), status, attempts, due, lockedMinutesAgo, `p65-${key}`]);
  return rows[0].id;
};

const requested = await insert("requested", "queued", { kind: "handover_review", recipient: controlledRecipient, marker: testRunId });
const dueFailure = await insert("due-failure", "failed", { attempts: 2, kind: "handover_review", recipient: controlledRecipient, marker: testRunId });
const unrelatedQueued = await insert("unrelated-queued", "queued", { kind: "handover_review", recipient: controlledRecipient, marker: testRunId });
const unrelatedFuture = await insert("unrelated-future", "queued", { due: false });
const unrelatedRecentLease = await insert("unrelated-recent", "processing", { lockedMinutesAgo: 1, attempts: 1 });
const unrelatedSent = await insert("unrelated-sent", "sent", { attempts: 1 });
const wrongMarker = await insert("wrong-marker", "queued", { kind: "handover_review", recipient: controlledRecipient, marker: "22222222-2222-4222-8222-222222222222" });
const wrongRecipient = await insert("wrong-recipient", "queued", { kind: "handover_review", recipient: "other-admin@example.test", marker: testRunId });
const customerKind = await insert("customer-kind", "queued", { due: false, kind: "customer_message", recipient: controlledRecipient, marker: testRunId });
const normalDue = await insert("normal-due", "queued");

const claim = (id, runId = testRunId, recipient = controlledRecipient) => db.query(
  "select id,status,attempts,idempotency_key from public.rafa_claim_notification_by_id($1,$2,$3)", [id, runId, recipient]
);
const firstClaim = await claim(requested);
assert.deepEqual(firstClaim.rows, [{ id: requested, status: "processing", attempts: 1, idempotency_key: "p65-requested" }], "returns and claims only the requested eligible P6.5 notification");
const untouchedIds = [unrelatedQueued, unrelatedFuture, unrelatedRecentLease, unrelatedSent, wrongMarker, wrongRecipient, customerKind];
const before = (await db.query("select id,status,attempts from public.rafa_notification_jobs where id = any($1::uuid[])", [untouchedIds])).rows;
assert.deepEqual(before.map(({id,status,attempts}) => ({id,status,attempts})).sort((a,b) => a.id.localeCompare(b.id)), [
  { id: unrelatedFuture, status: "queued", attempts: 0 },
  { id: unrelatedQueued, status: "queued", attempts: 0 },
  { id: unrelatedRecentLease, status: "processing", attempts: 1 },
  { id: unrelatedSent, status: "sent", attempts: 1 },
  { id: wrongMarker, status: "queued", attempts: 0 },
  { id: wrongRecipient, status: "queued", attempts: 0 },
  { id: customerKind, status: "queued", attempts: 0 },
].sort((a,b) => a.id.localeCompare(b.id)), "claim changes only the requested row; all other due and ineligible rows remain untouched");

assert.deepEqual((await claim(requested)).rows, [], "retrying an active claim is idempotent and cannot duplicate delivery");
assert.deepEqual((await claim(requested, "33333333-3333-4333-8333-333333333333")).rows, [], "a different test run cannot claim the notification");
assert.deepEqual((await claim(requested, testRunId, "somebody-else@example.test")).rows, [], "a different expected recipient cannot claim the notification");
for (const id of [unrelatedFuture, unrelatedRecentLease, unrelatedSent, wrongMarker, wrongRecipient, customerKind]) {
  assert.deepEqual((await claim(id)).rows, [], `ineligible, wrong-marker, wrong-recipient, or customer notification ${id} cannot be claimed`);
}
assert.deepEqual((await claim(dueFailure)).rows, [], "failed P6.5 notifications cannot be retried because an SMTP error may be ambiguous");
const missingId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
assert.deepEqual((await claim(missingId)).rows, [], "unknown ID does not fall through to another due job");

await db.exec("set role anon");
await assert.rejects(claim(unrelatedQueued), /permission denied/i, "anonymous caller cannot claim by ID");
await db.exec("reset role");

await db.query("update public.rafa_notification_jobs set locked_at=now()-interval '3 minutes' where id=$1", [requested]);
const leaseRetry = await claim(requested);
assert.deepEqual(leaseRetry.rows, [], "expired P6.5 processing lease is not reclaimed, preventing a duplicate after an ambiguous SMTP result");
assert.equal((await db.query("select count(*)::int as n from public.rafa_notification_jobs where id=$1", [requested])).rows[0].n, 1, "retry does not create a duplicate notification row");
assert.equal((await db.query("select count(*)::int as n from public.rafa_notification_jobs where idempotency_key='p65-requested'")).rows[0].n, 1, "retry retains unique idempotency protection");

const batchClaims = await db.query("select id,status,attempts from public.rafa_claim_due_notifications($1)", [100]);
assert.deepEqual(batchClaims.rows, [{ id: normalDue, status: "processing", attempts: 1 }], "normal due production rows still flow through the unchanged batch eligibility/order/lease path");
const taggedAfterBatch = (await db.query("select id,status,attempts from public.rafa_notification_jobs where id = any($1::uuid[])", [[requested, unrelatedQueued, dueFailure, wrongMarker, wrongRecipient]])).rows;
assert.deepEqual(taggedAfterBatch.map(({id,status,attempts}) => ({id,status,attempts})).sort((a,b) => a.id.localeCompare(b.id)), [
  { id: requested, status: "processing", attempts: 1 },
  { id: unrelatedQueued, status: "queued", attempts: 0 },
  { id: dueFailure, status: "failed", attempts: 2 },
  { id: wrongMarker, status: "queued", attempts: 0 },
  { id: wrongRecipient, status: "queued", attempts: 0 },
].sort((a,b) => a.id.localeCompare(b.id)), "batch leaves both the explicitly claimed target and all other tagged P6.5 notifications untouched");

console.log("P6.5 claim-by-ID PGlite validation passed: exact ID isolation, service-only authorization, test-run marker/recipient/kind binding, queued-only state guard, ambiguity-safe no-reclaim retries, stable unique key, tagged-row batch isolation, and normal batch processing.");
await db.close();
