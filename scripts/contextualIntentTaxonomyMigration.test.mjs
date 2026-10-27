import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { PGlite } from "@electric-sql/pglite";
const require = createRequire(import.meta.url);
const { INTENTS } = require("../src/intent.js");
const migrationName = fs.readdirSync(new URL("../supabase/migrations/", import.meta.url)).find((name) => name.endsWith("_align_contextual_intent_taxonomy.sql"));
const sql = fs.readFileSync(new URL(`../supabase/migrations/${migrationName}`, import.meta.url), "utf8");
test("every contextual classification persists without dropping unknown-value restrictions or legacy rows", async () => {
  const db = new PGlite();
  try {
    await db.exec("create table rafa_contact_intents(intent text constraint rafa_contact_intents_intent_check check(intent in ('greeting','land'))); insert into rafa_contact_intents values ('land');");
    await db.exec(sql);
    for (const intent of Object.values(INTENTS)) await db.query("insert into rafa_contact_intents values ($1)", [intent]);
    await assert.rejects(db.query("insert into rafa_contact_intents values ($1)", ["unauthorized_new_intent"]), { code: "23514" });
    assert.equal((await db.query("select count(*)::integer count from rafa_contact_intents where intent='land'")).rows[0].count, 1);
    const edge = fs.readFileSync(new URL("../supabase/functions/rafa-agent-api/index.ts", import.meta.url), "utf8");
    const declaration = edge.match(/const WORKFLOW_INTENTS = new Set\(\[([^\]]+)\]\)/)[1];
    for (const intent of Object.values(INTENTS)) assert.ok(declaration.includes(JSON.stringify(intent)), intent);
  } finally { await db.close(); }
});
