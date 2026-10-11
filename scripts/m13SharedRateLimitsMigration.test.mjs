import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";

const migration = await readFile("supabase/migrations/20261011001430_rafa_shared_rate_limits.sql", "utf8");

test("MIG-13 creates an atomic shared limiter with bounded limits and a UTC daily window", async () => {
  const db = new PGlite();
  try {
    await db.exec("create role anon; create role authenticated; create role service_role bypassrls;");
    await db.exec(migration);
    await db.exec(migration);
    const hash = "a".repeat(64);
    const consume = async (scope, limit) => {
      const { rows: [row] } = await db.query("select * from public.rafa_consume_rate_limit($1,$2,$3)", [scope, hash, limit]);
      return row;
    };

    assert.deepEqual(await consume("incoming_minute", 2), { allowed: true, remaining: 1, retry_after_seconds: 60 });
    assert.deepEqual(await consume("incoming_minute", 2), { allowed: true, remaining: 0, retry_after_seconds: 60 });
    assert.deepEqual(await consume("incoming_minute", 2), { allowed: false, remaining: 0, retry_after_seconds: 60 });
    const dailyFirst = await consume("ai_daily", 2);
    assert.equal(dailyFirst.allowed, true);
    assert.equal(dailyFirst.remaining, 1);
    assert.ok(dailyFirst.retry_after_seconds > 0 && dailyFirst.retry_after_seconds <= 86400);
    assert.deepEqual(await consume("ai_daily", 2), { allowed: true, remaining: 0, retry_after_seconds: dailyFirst.retry_after_seconds });
    assert.deepEqual(await consume("ai_daily", 2), { allowed: false, remaining: 0, retry_after_seconds: dailyFirst.retry_after_seconds });
    assert.equal((await db.query("select count(*)::integer as count from public.refal_rate_limits")).rows[0].count, 2);
    await assert.rejects(db.query("select * from public.rafa_consume_rate_limit('not_allowed',$1,1)", [hash]), /invalid rate limit request/u);
    await assert.rejects(db.query("select * from public.rafa_consume_rate_limit('ai_daily','raw-phone-number',1)"), /invalid rate limit request/u);
    await assert.rejects(db.query("select * from public.rafa_consume_rate_limit('ai_daily',$1,1001)", [hash]), /invalid rate limit request/u);

    const { rows: [rls] } = await db.query("select rowsecurity from pg_tables where schemaname='public' and tablename='refal_rate_limits'");
    assert.deepEqual(rls, { rowsecurity: true });
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      const { rows: [grant] } = await db.query(`select has_table_privilege($1,'public.refal_rate_limits','select') as can_select,
        has_table_privilege($1,'public.refal_rate_limits','insert') as can_insert`, [role]);
      assert.deepEqual(grant, role === "service_role" ? { can_select: true, can_insert: true } : { can_select: false, can_insert: false });
    }
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      const { rows: [grant] } = await db.query("select has_function_privilege($1,'public.rafa_consume_rate_limit(text,text,integer)','execute') as can_call", [role]);
      assert.deepEqual(grant, { can_call: role === "service_role" });
    }
  } finally {
    await db.close();
  }
});
