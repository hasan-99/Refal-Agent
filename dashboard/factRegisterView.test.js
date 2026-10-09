// W3.9.7 — the fact register admin surface.
//
// There is no Supabase connection in this environment and the register
// migration (supabase/migrations/20261009180000_refal_fact_register.sql) has
// NOT been applied, so the database layer is stubbed throughout. Where a stub
// stands in for one of the migration's RPCs it reproduces the SQL faithfully —
// refal_reapprove_fact() re-dates from `current_date`, not from the row's old
// expiry — the same convention knowledgeEndToEnd.test.js already uses for the
// knowledge RPCs.
//
// This file is ESM (dashboard/package.json: "type": "module"); src/ is
// CommonJS, hence createRequire.

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  DEFAULT_DUE_WINDOW_DAYS,
  MIGRATION_NOT_APPLIED_REASON,
  STATUS_EXPLANATIONS,
  dueFacts,
  factAudit,
  isMissingRegisterObject,
  listFacts,
  normalizeFactRow,
  reapproveFact,
  setFactStatus
} from "./factRegisterView.js";

const require = createRequire(import.meta.url);
const { addDays, reapprove, STATUS } = require("../src/factRegister.js");

// A fixed clock. Every expectation below is relative to it, so the suite does
// not change meaning overnight.
const NOW = "2026-10-09";

function registerRow(overrides = {}) {
  return {
    fact_id: "MB-F19",
    claim_text: "Cyprus corporate income tax is 15% for tax years starting 2026.",
    topics: ["corporate-tax"],
    source_type: "mb-manual",
    source_url_or_document: "newplan/Master Brain & Operating Rules Manual - REFAL AI.txt",
    source_ref: "",
    jurisdiction: "CY",
    numbers: [{ value: 15, unit: "percent" }],
    volatility: "VOLATILE",
    trust_tier: "regulated",
    high_risk: true,
    reviewer: "BOSS",
    verified_at: "2026-10-07",
    effective_from: null,
    expiry_or_review_at: addDays(NOW, 3),
    review_cadence_days: 90,
    approved_languages: ["ar", "en", "el"],
    status: "approved",
    notes: "",
    updated_at: "2026-10-07T00:00:00.000Z",
    ...overrides
  };
}

// Stands in for dashboard/server.js's supabaseRest(). Table reads are served
// from `rows`; the two RPCs mirror the migration's plpgsql.
function fakeRest(rows, { auditRows = [] } = {}) {
  const calls = [];
  const rest = async (pathname, options = {}) => {
    calls.push({ pathname, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null });

    if (pathname.startsWith("refal_fact_register_audit?")) {
      const id = /fact_id=eq\.([A-Za-z0-9-]+)/.exec(pathname)?.[1];
      return auditRows.filter((row) => row.fact_id === id)
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    }
    if (pathname.startsWith("refal_fact_register?")) {
      const id = /fact_id=eq\.([A-Za-z0-9-]+)/.exec(pathname)?.[1];
      return id ? rows.filter((row) => row.fact_id === id) : [...rows];
    }
    if (pathname === "rpc/refal_reapprove_fact") {
      const payload = JSON.parse(options.body);
      const row = rows.find((candidate) => candidate.fact_id === payload.p_fact_id);
      // Mirrors the SQL: coalesce(p_cadence_days, review_cadence_days), then
      // verified_at = current_date and expiry = current_date + cadence.
      const cadence = payload.p_cadence_days ?? row.review_cadence_days;
      row.reviewer = payload.p_reviewer;
      row.verified_at = NOW;
      row.status = "approved";
      row.review_cadence_days = cadence;
      row.expiry_or_review_at = addDays(NOW, cadence);
      return {
        fact_id: row.fact_id,
        status: row.status,
        verified_at: row.verified_at,
        expiry_or_review_at: row.expiry_or_review_at
      };
    }
    if (pathname === "rpc/refal_set_fact_status") {
      const payload = JSON.parse(options.body);
      const row = rows.find((candidate) => candidate.fact_id === payload.p_fact_id);
      const action = payload.p_status === "blocked" ? "block" : row.status === "blocked" ? "unblock" : payload.p_status === "expired" ? "expire" : "edit";
      row.status = payload.p_status;
      return { fact_id: row.fact_id, status: row.status, action };
    }
    throw new Error(`unexpected REST call: ${pathname}`);
  };
  rest.calls = calls;
  return rest;
}

// What PostgREST returns when the migration has never been applied: the table
// is simply not in its schema cache. supabaseRest() attaches `pgCode`.
function missingTableRest({ pgCode = "PGRST205", message = "Could not find the table 'public.refal_fact_register' in the schema cache" } = {}) {
  return async () => {
    const error = new Error(message);
    if (pgCode) error.pgCode = pgCode;
    throw error;
  };
}

async function rejection(promise) {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}

// --------------------------------------------------------------- the due list

test("the due list includes a fact inside the horizon and excludes one outside it", async () => {
  const rest = fakeRest([
    registerRow({ fact_id: "MB-F19", expiry_or_review_at: addDays(NOW, 3) }),
    registerRow({ fact_id: "MB-F30", expiry_or_review_at: addDays(NOW, 40) })
  ]);

  const soon = await dueFacts(rest, { days: DEFAULT_DUE_WINDOW_DAYS, now: NOW });
  assert.equal(soon.days, 7);
  assert.deepEqual(soon.facts.map((fact) => fact.id), ["MB-F19"]);
  assert.equal(soon.facts[0].daysLeft, 3);
  assert.equal(soon.counts.overdue, 0);
  assert.equal(soon.counts.dueSoon, 1);

  // The horizon is a real parameter, not decoration: widen it and the second
  // fact appears.
  const wide = await dueFacts(rest, { days: 60, now: NOW });
  assert.deepEqual(wide.facts.map((fact) => fact.id), ["MB-F19", "MB-F30"]);

  // No `days` at all means W3.9.7's seven.
  const fallback = await dueFacts(rest, { now: NOW });
  assert.equal(fallback.days, DEFAULT_DUE_WINDOW_DAYS);
});

test("a fact already past its date sorts first and reports a negative daysLeft", async () => {
  const rest = fakeRest([
    registerRow({ fact_id: "MB-F19", expiry_or_review_at: addDays(NOW, 5) }),
    registerRow({ fact_id: "MB-F30", expiry_or_review_at: addDays(NOW, -12) }),
    registerRow({ fact_id: "MB-F31", expiry_or_review_at: NOW })
  ]);

  const soon = await dueFacts(rest, { days: DEFAULT_DUE_WINDOW_DAYS, now: NOW });
  assert.deepEqual(soon.facts.map((fact) => fact.id), ["MB-F30", "MB-F31", "MB-F19"]);
  assert.equal(soon.facts[0].daysLeft, -12);
  assert.equal(soon.facts[0].effectiveStatus, STATUS.EXPIRED);
  assert.equal(soon.counts.overdue, 1);

  // The full register view agrees: the overdue row leads, and it is reported as
  // expired even though the stored status still says approved.
  const all = await listFacts(rest, { now: NOW });
  assert.equal(all.facts[0].id, "MB-F30");
  assert.equal(all.facts[0].status, STATUS.APPROVED);
  assert.equal(all.facts[0].effectiveStatus, STATUS.EXPIRED);
  assert.equal(all.facts[0].statusExplanation, STATUS_EXPLANATIONS.expired);
  assert.equal(all.counts.expired, 1);
  // Already expired is not "due soon" — MB-F31 (today) and MB-F19 (+5) are.
  assert.equal(all.counts.dueWithin7, 2);
});

// -------------------------------------------------------------- re-approval

test("re-approval re-dates from today, not from the stale expiry", async () => {
  const stale = registerRow({ fact_id: "MB-F19", verified_at: "2026-01-01", expiry_or_review_at: "2026-04-01", review_cadence_days: 90 });
  const rest = fakeRest([stale]);

  // The authority. src/factRegister.js#reapprove re-dates from today so a row
  // that sat expired for months does not come back already half spent.
  //
  // The cadence is passed explicitly because the two layers disagree about the
  // DEFAULT: reapprove() with no cadenceDays falls back to cadenceForFact(),
  // the taxonomy derived number (30 days for a volatile regulated fact), while
  // refal_reapprove_fact() falls back to the row's stored review_cadence_days
  // (90 here). reapproveFact() below hands the stored value to the dry run for
  // exactly that reason, so the local guard rail checks the number the database
  // will actually use.
  const rolled = reapprove(normalizeFactRow(stale), { reviewer: "Hasan", cadenceDays: 90, now: NOW });
  assert.equal(rolled.verifiedAt, NOW);
  assert.equal(rolled.expiryOrReviewAt, addDays(NOW, 90));
  assert.notEqual(rolled.expiryOrReviewAt, addDays("2026-04-01", 90));

  const result = await reapproveFact(rest, { factId: "MB-F19", reviewer: "Hasan", reason: "Checked against the 2026 tax circular.", now: NOW });
  assert.equal(result.reapproved, true);
  assert.equal(result.result.verified_at, NOW);
  assert.equal(result.result.expiry_or_review_at, addDays(NOW, 90));

  // The RPC is called with exactly the signature the migration declares, and a
  // null cadence so the database keeps the row's own review_cadence_days.
  const rpc = rest.calls.find((call) => call.pathname === "rpc/refal_reapprove_fact");
  assert.deepEqual(Object.keys(rpc.body).sort(), ["p_cadence_days", "p_fact_id", "p_reason", "p_reviewer"]);
  assert.deepEqual(rpc.body, { p_fact_id: "MB-F19", p_reviewer: "Hasan", p_cadence_days: null, p_reason: "Checked against the 2026 tax circular." });
});

test("a re-approval without a named reviewer is rejected before it reaches the database", async () => {
  const rest = fakeRest([registerRow()]);

  for (const reviewer of ["", "   ", undefined, "anonymous", "ANON", "n/a", "-", "unknown"]) {
    const error = await rejection(reapproveFact(rest, { factId: "MB-F19", reviewer, now: NOW }));
    assert.ok(error, `expected ${JSON.stringify(reviewer)} to be rejected`);
    assert.equal(error.code, 400);
    assert.match(error.message, /named reviewer/i);
  }
  assert.equal(rest.calls.filter((call) => call.pathname.startsWith("rpc/")).length, 0);

  // A status change is held to the same standard, and additionally needs a
  // reason, because blocking a fact removes it from retrieval entirely.
  const anonymous = await rejection(setFactStatus(rest, { factId: "MB-F19", status: "blocked", actor: " ", reason: "wrong" }));
  assert.equal(anonymous.code, 400);
  assert.match(anonymous.message, /named actor/i);
  const reasonless = await rejection(setFactStatus(rest, { factId: "MB-F19", status: "blocked", actor: "Hasan", reason: "" }));
  assert.equal(reasonless.code, 400);
  assert.match(reasonless.message, /reason/i);
});

test("a 365 day cadence on a high risk fact is rejected, mirroring the database constraint", async () => {
  const rest = fakeRest([
    registerRow({ fact_id: "MB-F19", high_risk: true }),
    // MB-J1 is not in W3.9.2's high risk set, so a long cadence is its own call.
    registerRow({ fact_id: "MB-J1", high_risk: false, review_cadence_days: 180, expiry_or_review_at: addDays(NOW, 120) })
  ]);

  const error = await rejection(reapproveFact(rest, { factId: "MB-F19", reviewer: "Hasan", cadenceDays: 365, now: NOW }));
  assert.equal(error.code, 400);
  assert.match(error.message, /high risk/i);
  assert.equal(rest.calls.filter((call) => call.pathname.startsWith("rpc/")).length, 0);

  // The catalogue, not the row, decides what is high risk: a database row that
  // lost its high_risk flag still cannot buy itself a lazy cadence.
  const flagless = fakeRest([registerRow({ fact_id: "MB-F19", high_risk: false })]);
  const stillRejected = await rejection(reapproveFact(flagless, { factId: "MB-F19", reviewer: "Hasan", cadenceDays: 365, now: NOW }));
  assert.equal(stillRejected.code, 400);
  assert.match(stillRejected.message, /high risk/i);

  // 90 days is the cap, and it is allowed.
  const capped = await reapproveFact(rest, { factId: "MB-F19", reviewer: "Hasan", cadenceDays: 90, now: NOW });
  assert.equal(capped.result.expiry_or_review_at, addDays(NOW, 90));

  // A fact outside the high risk set may take the long cadence.
  const long = await reapproveFact(rest, { factId: "MB-J1", reviewer: "Hasan", cadenceDays: 365, now: NOW });
  assert.equal(long.result.expiry_or_review_at, addDays(NOW, 365));
});

// ------------------------------------------------------- the unapplied schema

test("a missing register table says the migration is not applied, never an empty list", async () => {
  const rest = missingTableRest();

  const listed = await rejection(listFacts(rest, { now: NOW }));
  assert.equal(listed.code, 503);
  assert.match(listed.message, /migration has not been applied yet/i);
  assert.equal(listed.details.migrationApplied, false);
  assert.equal(listed.details.reason, MIGRATION_NOT_APPLIED_REASON);
  assert.match(listed.details.migration, /20261009180000_refal_fact_register\.sql$/);
  // The failure mode this guards against: an empty, cheerful "nothing to review".
  assert.equal(listed.facts, undefined);

  for (const call of [
    dueFacts(rest, { now: NOW }),
    factAudit(rest, "MB-F19"),
    reapproveFact(rest, { factId: "MB-F19", reviewer: "Hasan", now: NOW }),
    setFactStatus(rest, { factId: "MB-F19", status: "blocked", actor: "Hasan", reason: "Superseded." })
  ]) {
    const error = await rejection(call);
    assert.equal(error.code, 503);
    assert.equal(error.details.migrationApplied, false);
  }
});

test("the missing-object check covers Postgres codes, PostgREST codes, and a bare message", () => {
  assert.equal(isMissingRegisterObject({ pgCode: "42P01", message: 'relation "public.refal_fact_register" does not exist' }), true);
  assert.equal(isMissingRegisterObject({ pgCode: "42883", message: "function public.refal_reapprove_fact(...) does not exist" }), true);
  assert.equal(isMissingRegisterObject({ pgCode: "PGRST202", message: "Could not find the function public.refal_reapprove_fact" }), true);
  // No code at all: the message still names one of this migration's objects.
  assert.equal(isMissingRegisterObject({ message: 'relation "public.refal_fact_register_audit" does not exist' }), true);
  // A real failure must NOT be dressed up as an unapplied migration.
  assert.equal(isMissingRegisterObject({ pgCode: "23514", message: "new row violates check constraint" }), false);
  assert.equal(isMissingRegisterObject({ message: "fetch failed" }), false);
  assert.equal(isMissingRegisterObject(null), false);
  // Specifically: the migration grants the register to service_role only, while
  // dashboard/server.js's supabaseRest() authenticates as anon. If that is not
  // reconciled the applied migration answers 42501, and "permission denied" must
  // surface as the real error rather than as "the migration is not applied".
  assert.equal(isMissingRegisterObject({ pgCode: "42501", message: "permission denied for table refal_fact_register" }), false);
});

// ------------------------------------------------------- filters and the audit

test("the register can be filtered by effective status and by topic", async () => {
  const rest = fakeRest([
    registerRow({ fact_id: "MB-F19", topics: ["corporate-tax"], expiry_or_review_at: addDays(NOW, -1) }),
    registerRow({ fact_id: "MB-F30", topics: ["residency"], expiry_or_review_at: addDays(NOW, 30) }),
    registerRow({ fact_id: "MB-F31", topics: ["residency", "corporate-tax"], status: "blocked" })
  ]);

  const expired = await listFacts(rest, { status: "expired", now: NOW });
  assert.deepEqual(expired.facts.map((fact) => fact.id), ["MB-F19"]);

  const residency = await listFacts(rest, { topic: "residency", now: NOW });
  assert.deepEqual(residency.facts.map((fact) => fact.id).sort(), ["MB-F30", "MB-F31"]);

  const all = await listFacts(rest, { now: NOW });
  assert.deepEqual(all.topics, ["corporate-tax", "residency"]);
  assert.deepEqual(all.counts, { total: 3, approved: 1, expired: 1, blocked: 1, pending: 0, highRisk: 3, dueWithin7: 0 });
  assert.equal(all.statusExplanations.blocked, STATUS_EXPLANATIONS.blocked);

  const unknown = await rejection(listFacts(rest, { status: "retired", now: NOW }));
  assert.equal(unknown.code, 400);
});

test("the audit trail comes back newest first", async () => {
  const rest = fakeRest([registerRow()], {
    auditRows: [
      { id: "a1", fact_id: "MB-F19", action: "seed", actor: "BOSS", previous: {}, next: { status: "approved" }, reason: "", created_at: "2026-10-07T08:00:00.000Z" },
      { id: "a2", fact_id: "MB-F19", action: "reapprove", actor: "Hasan", previous: { status: "expired" }, next: { status: "approved" }, reason: "Checked.", created_at: "2026-10-09T09:30:00.000Z" },
      { id: "a3", fact_id: "MB-F30", action: "block", actor: "Hasan", previous: {}, next: {}, reason: "Other fact.", created_at: "2026-10-08T00:00:00.000Z" }
    ]
  });

  const audit = await factAudit(rest, "MB-F19");
  assert.deepEqual(audit.entries.map((entry) => entry.id), ["a2", "a1"]);
  assert.equal(audit.entries[0].actor, "Hasan");
  assert.equal(audit.entries[0].action, "reapprove");
  assert.deepEqual(audit.entries[0].previous, { status: "expired" });

  const unknownFact = await rejection(factAudit(rest, "not-a-fact"));
  assert.equal(unknownFact.code, 400);
});
