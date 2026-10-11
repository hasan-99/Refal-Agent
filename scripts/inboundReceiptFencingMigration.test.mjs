import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const migration = await readFile("supabase/migrations/20261011100100_inbound_receipt_fencing.sql", "utf8");
const unfencedMigration = migration.replace("    and lease_token = p_lease_token\n    and lease_expires_at > clock_timestamp()", "    and lease_token = p_lease_token");
const tokenA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const tokenB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const tokenC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

async function setup() {
  const db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create table public.rafa_inbound_message_receipts (
      whatsapp_jid text not null,
      message_id text not null check (length(btrim(message_id)) between 1 and 200),
      status text not null default 'processing' check (status in ('processing', 'processed')),
      first_seen_at timestamptz not null default now(),
      last_attempt_at timestamptz not null default now(),
      processed_at timestamptz,
      primary key (whatsapp_jid, message_id),
      constraint rafa_inbound_message_jid_valid check (whatsapp_jid ~ '^(?:[0-9]+|[A-Za-z0-9._-]+)@(s\\.whatsapp\\.net|c\\.us|lid)$')
    );
    alter table public.rafa_inbound_message_receipts enable row level security;
    revoke all on table public.rafa_inbound_message_receipts from anon, authenticated;
    grant select, insert, update, delete on table public.rafa_inbound_message_receipts to service_role;
    insert into public.rafa_inbound_message_receipts(whatsapp_jid,message_id,status,last_attempt_at,processed_at)
      values ('15551234567@s.whatsapp.net','old-processing','processing',clock_timestamp() - interval '11 minutes',null),
             ('15551234567@s.whatsapp.net','old-processed','processed',clock_timestamp() - interval '20 minutes',clock_timestamp() - interval '20 minutes');
  `);
  return db;
}

async function claim(db, messageId, leaseToken) {
  const { rows: [row] } = await db.query("select public.refal_claim_inbound_message($1,$2,$3) as result", ["15551234567@s.whatsapp.net", messageId, leaseToken]);
  return row.result;
}

async function complete(db, messageId, leaseToken) {
  const { rows: [row] } = await db.query("select public.refal_complete_inbound_message($1,$2,$3) as result", ["15551234567@s.whatsapp.net", messageId, leaseToken]);
  return row.result;
}

test("M13 receipt fencing migration backfills safely and is rerunnable", async () => {
  const db = await setup();
  try {
    await db.exec(migration);
    await db.exec(migration);
    const { rows } = await db.query("select message_id,status,lease_token is not null as has_token,lease_expires_at is not null as has_expiry from public.rafa_inbound_message_receipts order by message_id");
    assert.deepEqual(rows, [
      { message_id: "old-processed", status: "processed", has_token: false, has_expiry: false },
      { message_id: "old-processing", status: "processing", has_token: true, has_expiry: true }
    ]);
    const { rows: [privileges] } = await db.query(`
      select has_function_privilege('anon','public.refal_claim_inbound_message(text,text,uuid)','execute') as anon_claim,
             has_function_privilege('authenticated','public.refal_complete_inbound_message(text,text,uuid)','execute') as auth_complete,
             has_function_privilege('service_role','public.refal_claim_inbound_message(text,text,uuid)','execute') as service_claim
    `);
    assert.deepEqual(privileges, { anon_claim: false, auth_complete: false, service_claim: true });
  } finally {
    await db.close();
  }
});

test("atomic claims admit one active owner, reclaim only after expiry, and fence stale completion", async () => {
  const db = await setup();
  try {
    await db.exec(migration);
    const competingClaims = await Promise.all([claim(db, "race-1", tokenA), claim(db, "race-1", tokenB)]);
    assert.equal(competingClaims.filter((result) => result.claimed === true).length, 1);
    assert.equal(competingClaims.filter((result) => result.claimed === false).length, 1);

    const first = await claim(db, "lease-1", tokenA);
    assert.deepEqual(first, { claimed: true, duplicate: false, lease_token: tokenA });
    assert.deepEqual(await claim(db, "lease-1", tokenB), { claimed: false, duplicate: true });
    await db.query("update public.rafa_inbound_message_receipts set lease_expires_at = clock_timestamp() - interval '1 second' where message_id='lease-1'");
    assert.deepEqual(await claim(db, "lease-1", tokenB), { claimed: true, duplicate: false, lease_token: tokenB });

    assert.deepEqual(await complete(db, "lease-1", tokenA), { processed: false });
    const { rows: [owned] } = await db.query("select status,lease_token from public.rafa_inbound_message_receipts where message_id='lease-1'");
    assert.deepEqual(owned, { status: "processing", lease_token: tokenB });
    assert.deepEqual(await complete(db, "lease-1", tokenB), { processed: true });
    assert.deepEqual(await complete(db, "lease-1", tokenB), { processed: false });
    assert.deepEqual(await claim(db, "lease-1", tokenC), { claimed: false, duplicate: true });

    assert.deepEqual(await claim(db, "lease-expiry", tokenA), { claimed: true, duplicate: false, lease_token: tokenA });
    await db.query("update public.rafa_inbound_message_receipts set lease_expires_at = clock_timestamp() - interval '1 second' where message_id='lease-expiry'");
    assert.deepEqual(await complete(db, "lease-expiry", tokenA), { processed: false }, "a worker cannot complete after its lease expires, even before a replacement claim");
    assert.deepEqual(await claim(db, "lease-expiry", tokenB), { claimed: true, duplicate: false, lease_token: tokenB });
  } finally {
    await db.close();
  }
});

test("expired receipt completion regression reproduces before proving the fence", async () => {
  assert.notEqual(unfencedMigration, migration, "test must remove the expiry guard to reproduce the prior behavior");
  const oldDb = await setup();
  try {
    await oldDb.exec(unfencedMigration);
    await claim(oldDb, "repro-expired", tokenA);
    await oldDb.query("update public.rafa_inbound_message_receipts set lease_expires_at = clock_timestamp() - interval '1 second' where message_id='repro-expired'");
    assert.deepEqual(await complete(oldDb, "repro-expired", tokenA), { processed: true }, "old RPC incorrectly accepts an expired lease");
  } finally {
    await oldDb.close();
  }

  const fixedDb = await setup();
  try {
    await fixedDb.exec(migration);
    await claim(fixedDb, "repro-expired", tokenA);
    await fixedDb.query("update public.rafa_inbound_message_receipts set lease_expires_at = clock_timestamp() - interval '1 second' where message_id='repro-expired'");
    assert.deepEqual(await complete(fixedDb, "repro-expired", tokenA), { processed: false }, "fixed RPC rejects the expired lease");
  } finally {
    await fixedDb.close();
  }
});

test("service RPC rejects malformed identities", async () => {
  const db = await setup();
  try {
    await db.exec(migration);
    await assert.rejects(db.query("select public.refal_claim_inbound_message($1,$2,$3)", ["not-a-jid", "msg", tokenA]), /invalid inbound receipt claim/);
  } finally {
    await db.close();
  }
});
