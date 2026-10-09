// W3.9.7 — the fact register admin surface, server side.
//
// This is the operator-facing half of Rule 2. src/factRegister.js already owns
// every decision (what counts as expired, which facts are high risk, what a
// re-approval does to the dates). Nothing here re-decides any of that: this
// module only
//
//   * reads the register out of Supabase through the dashboard's REST helper,
//   * translates the snake_case database row into the camelCase shape
//     src/factRegister.js works in,
//   * delegates to that module for effective status, the "due for review" list
//     and the re-approval guard rails, and
//   * calls the two audited RPCs the migration defines.
//
// THE UNAPPLIED MIGRATION
// -----------------------
// supabase/migrations/20261009180000_refal_fact_register.sql has been written
// but NOT applied, and this environment has no Supabase access at all. The one
// outcome that must never happen is an empty table that reads as "no facts need
// review" when the truth is "the register does not exist yet". So every call
// here classifies a missing relation/function (Postgres 42P01 / 42883, or
// PostgREST's PGRST205 / PGRST202 schema-cache equivalents) and turns it into an
// explicit 503 that says so.
//
// This file is ESM (dashboard/package.json: "type": "module") and src/ is
// CommonJS, so the behaviour layer is pulled in via `createRequire` — the exact
// pattern dashboard/server.js already uses for ../src/ai.js.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  STATUS,
  STATUSES,
  HIGH_RISK_FACTS,
  HIGH_RISK_MAX_CADENCE_DAYS,
  daysBetween,
  nowIsoDay,
  effectiveStatus,
  factsExpiringWithin,
  reapprove
} = require("../src/factRegister.js");
const { isFactId, normalizeFactId } = require("../src/brainFactMap.js");

const HIGH_RISK_SET = new Set(HIGH_RISK_FACTS);

export const FACT_REGISTER_MIGRATION = "supabase/migrations/20261009180000_refal_fact_register.sql";

// W3.9.7 defaults to a seven day horizon. Exported so the route, the page and
// the tests cannot drift into three different "soon"s.
export const DEFAULT_DUE_WINDOW_DAYS = 7;
export const MAX_DUE_WINDOW_DAYS = 365;

// The whole point of the register is that an operator can see WHY REFAL will or
// will not state a number. One short line each, shared by the API and the page
// so the explanation cannot drift between them.
export const STATUS_EXPLANATIONS = Object.freeze({
  [STATUS.APPROVED]: "REFAL states it with its evidence.",
  [STATUS.EXPIRED]: "REFAL says the figure is not currently confirmed and offers a specialist.",
  [STATUS.BLOCKED]: "REFAL cannot retrieve it at all.",
  [STATUS.PENDING]: "Authored but not in force, so REFAL does not state it yet."
});

export const MIGRATION_NOT_APPLIED_MESSAGE =
  `The fact register migration has not been applied yet, so there is no register to review. Apply ${FACT_REGISTER_MIGRATION} and its generated seed companion, then reload this page. This is not the same as "no facts need review".`;

export const MIGRATION_NOT_APPLIED_REASON = "fact_register_migration_not_applied";

// A re-approval is an accountability record, not a checkbox. These are the
// values people type when they are trying to avoid putting a name to it.
const ANONYMOUS_NAMES = new Set([
  "anonymous", "anon", "unknown", "n/a", "na", "none", "null", "undefined",
  "-", "--", "?", "system", "someone", "admin", "operator", "dashboard", "test"
]);

// 42P01 undefined_table, 42883 undefined_function — raised when PostgREST
// reaches Postgres. PGRST205 / PGRST202 — raised when PostgREST's own schema
// cache has never heard of the table / function, which is what an unapplied
// migration actually looks like through the REST API.
const MISSING_OBJECT_CODES = new Set(["42P01", "42883", "PGRST202", "PGRST205"]);
const REGISTER_OBJECTS = /refal_fact_register|refal_facts_due_for_review|refal_reapprove_fact|refal_set_fact_status|refal_fact_effective_status/i;
const MISSING_OBJECT_WORDS = /(does not exist|could not find|not found in the schema cache|schema cache|no function matches)/i;

const REGISTER_SELECT = [
  "fact_id", "claim_text", "topics", "source_type", "source_ref", "source_url_or_document",
  "jurisdiction", "numbers", "volatility", "trust_tier", "high_risk", "reviewer",
  "verified_at", "effective_from", "expiry_or_review_at", "review_cadence_days",
  "approved_languages", "status", "notes", "updated_at"
].join(",");

const AUDIT_SELECT = "id,fact_id,action,actor,previous,next,reason,created_at";

// Most urgent first. A fact that has already stopped being stated outranks one
// that is merely approaching its date, and a blocked fact is deliberate rather
// than urgent, so it sits last.
const URGENCY_RANK = Object.freeze({
  [STATUS.EXPIRED]: 0,
  [STATUS.PENDING]: 1,
  [STATUS.APPROVED]: 2,
  [STATUS.BLOCKED]: 3
});

// --------------------------------------------------------------------- errors
// `code` is the HTTP status, matching the httpError convention the rest of
// dashboard/server.js already uses (`res.status(error.code || 500)`). `details`
// is merged into the JSON body so the page can tell the migration case apart
// from a genuine failure without string-matching the message.
export function factError(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  return error;
}

export function migrationNotApplied() {
  return factError(503, MIGRATION_NOT_APPLIED_MESSAGE, {
    migrationApplied: false,
    migration: FACT_REGISTER_MIGRATION,
    reason: MIGRATION_NOT_APPLIED_REASON
  });
}

// supabaseRest() attaches pgCode/pgHint from the PostgREST error body. The
// message check is a belt-and-braces fallback for the case where the code is
// absent (an older proxy, or a non-JSON error body), and it only fires when the
// text actually names one of this migration's objects.
export function isMissingRegisterObject(error) {
  if (!error) return false;
  if (MISSING_OBJECT_CODES.has(String(error.pgCode || ""))) return true;
  const text = `${error.message || ""} ${error.pgHint || ""} ${error.pgDetails || ""}`;
  return REGISTER_OBJECTS.test(text) && MISSING_OBJECT_WORDS.test(text);
}

// ---------------------------------------------------------------- normalising
function isoDay(value) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, 10) : null;
}

export function normalizeFactRow(row = {}) {
  const id = normalizeFactId(row.fact_id ?? row.id ?? "");
  return {
    id,
    claimText: String(row.claim_text ?? ""),
    topics: Array.isArray(row.topics) ? row.topics.map(String) : [],
    sourceType: String(row.source_type ?? ""),
    sourceRef: String(row.source_ref ?? ""),
    sourceDocument: String(row.source_url_or_document ?? ""),
    jurisdiction: String(row.jurisdiction ?? ""),
    numbers: Array.isArray(row.numbers) ? row.numbers : [],
    volatility: String(row.volatility ?? ""),
    trustTier: String(row.trust_tier ?? ""),
    // W3.9.2 fixed the high risk set. A row that lost its high_risk flag in the
    // database still cannot be handed a lazy cadence, so the catalogue wins.
    highRisk: row.high_risk === true || HIGH_RISK_SET.has(id),
    reviewer: String(row.reviewer ?? ""),
    verifiedAt: isoDay(row.verified_at),
    effectiveFrom: isoDay(row.effective_from),
    expiryOrReviewAt: isoDay(row.expiry_or_review_at),
    reviewCadenceDays: Number(row.review_cadence_days) || 0,
    approvedLanguages: Array.isArray(row.approved_languages) ? row.approved_languages.map(String) : [],
    status: String(row.status ?? STATUS.PENDING),
    notes: String(row.notes ?? ""),
    updatedAt: row.updated_at ?? null
  };
}

export function normalizeAuditRow(row = {}) {
  return {
    id: row.id ?? null,
    factId: normalizeFactId(row.fact_id ?? ""),
    action: String(row.action ?? ""),
    actor: String(row.actor ?? ""),
    previous: row.previous && typeof row.previous === "object" ? row.previous : {},
    next: row.next && typeof row.next === "object" ? row.next : {},
    reason: String(row.reason ?? ""),
    createdAt: row.created_at ?? null
  };
}

// The stored status is an intent; effectiveStatus() also accounts for the clock
// and the effective date. The page shows the effective one, because that is what
// REFAL will actually do.
export function decorateFact(row, now) {
  const status = effectiveStatus(row, now);
  return {
    ...row,
    effectiveStatus: status,
    statusExplanation: STATUS_EXPLANATIONS[status] || "",
    daysLeft: row.expiryOrReviewAt ? daysBetween(nowIsoDay(now), row.expiryOrReviewAt) : null
  };
}

export function compareUrgency(a, b) {
  const rank = (URGENCY_RANK[a.effectiveStatus] ?? 9) - (URGENCY_RANK[b.effectiveStatus] ?? 9);
  if (rank !== 0) return rank;
  const left = Number.isFinite(a.daysLeft) ? a.daysLeft : Number.MAX_SAFE_INTEGER;
  const right = Number.isFinite(b.daysLeft) ? b.daysLeft : Number.MAX_SAFE_INTEGER;
  if (left !== right) return left - right;
  return String(a.id).localeCompare(String(b.id));
}

// ---------------------------------------------------------------- validation
function requireFactId(value) {
  const id = normalizeFactId(value ?? "");
  if (!isFactId(id)) throw factError(400, "That is not a known fact id.");
  return id;
}

function requireNamedPerson(value, message) {
  const name = String(value ?? "").trim().replace(/\s+/g, " ");
  if (name.length < 2 || ANONYMOUS_NAMES.has(name.toLowerCase())) throw factError(400, message);
  return name.slice(0, 120);
}

// Mirrors the column constraint: review_cadence_days between 1 and 365.
function requireCadence(value) {
  const cadence = Number(value);
  if (!Number.isInteger(cadence) || cadence < 1 || cadence > MAX_DUE_WINDOW_DAYS) {
    throw factError(400, `A review cadence must be a whole number of days between 1 and ${MAX_DUE_WINDOW_DAYS}.`);
  }
  return cadence;
}

export function normalizeDueWindow(value) {
  if (value === undefined || value === null || String(value).trim() === "") return DEFAULT_DUE_WINDOW_DAYS;
  const days = Number(value);
  if (!Number.isInteger(days) || days < 0 || days > MAX_DUE_WINDOW_DAYS) {
    throw factError(400, `The review horizon must be a whole number of days between 0 and ${MAX_DUE_WINDOW_DAYS}.`);
  }
  return days;
}

// ---------------------------------------------------------------- data access
// Every read and write funnels through here so there is exactly one place that
// can decide "the migration is not applied".
async function callRest(rest, pathname, options) {
  try {
    return await rest(pathname, options);
  } catch (error) {
    if (isMissingRegisterObject(error)) throw migrationNotApplied();
    throw error;
  }
}

async function readRegisterRows(rest) {
  const rows = await callRest(rest, `refal_fact_register?select=${REGISTER_SELECT}&order=expiry_or_review_at.asc,fact_id.asc&limit=500`);
  return (Array.isArray(rows) ? rows : []).map(normalizeFactRow);
}

async function readFactRow(rest, id) {
  const rows = await callRest(rest, `refal_fact_register?fact_id=eq.${id}&select=${REGISTER_SELECT}&limit=1`);
  const row = (Array.isArray(rows) ? rows : [])[0];
  if (!row) throw factError(404, `${id} is not in the fact register.`);
  return normalizeFactRow(row);
}

function toRegister(rows) {
  return new Map(rows.map((row) => [row.id, row]));
}

function summarize(rows, decorated, now) {
  const counts = { total: rows.length, approved: 0, expired: 0, blocked: 0, pending: 0, highRisk: 0, dueWithin7: 0 };
  for (const row of decorated) {
    counts[row.effectiveStatus] = (counts[row.effectiveStatus] || 0) + 1;
    if (row.highRisk) counts.highRisk += 1;
  }
  // The banner's "due in 7 days" number comes from the same function the due
  // list uses, so the headline and the list can never disagree. Rows already
  // past their date are counted as expired, not as "due soon".
  counts.dueWithin7 = factsExpiringWithin(DEFAULT_DUE_WINDOW_DAYS, { register: toRegister(rows), now })
    .filter((row) => Number(row.daysLeft) >= 0).length;
  return counts;
}

// ---------------------------------------------------------------- the surface
// GET /api/facts — the whole register, each row carrying its EFFECTIVE status.
//
// The status and topic filters are applied here rather than in PostgREST on
// purpose: the effective status is computed from the clock, so the database
// cannot filter on it, and the register is bounded at 82 rows by the fact id
// check constraint. Filtering in one place keeps the two filters consistent and
// leaves no query-string injection surface.
export async function listFacts(rest, { status = "", topic = "", now } = {}) {
  const wantedStatus = String(status ?? "").trim().toLowerCase();
  if (wantedStatus && wantedStatus !== "all" && !STATUSES.includes(wantedStatus)) {
    throw factError(400, `Status must be one of ${STATUSES.join(", ")}.`);
  }
  const wantedTopic = String(topic ?? "").trim().toLowerCase();

  const rows = await readRegisterRows(rest);
  const decorated = rows.map((row) => decorateFact(row, now));
  const facts = decorated
    .filter((row) => !wantedStatus || wantedStatus === "all" || row.effectiveStatus === wantedStatus)
    .filter((row) => !wantedTopic || row.topics.some((value) => value.toLowerCase() === wantedTopic))
    .sort(compareUrgency);

  return {
    migrationApplied: true,
    generatedAt: nowIsoDay(now),
    filters: { status: wantedStatus || "all", topic: wantedTopic },
    topics: [...new Set(rows.flatMap((row) => row.topics))].sort((a, b) => a.localeCompare(b)),
    statusExplanations: STATUS_EXPLANATIONS,
    highRiskMaxCadenceDays: HIGH_RISK_MAX_CADENCE_DAYS,
    counts: summarize(rows, decorated, now),
    facts
  };
}

// GET /api/facts/due?days=7 — the review soon list. Rows already past their date
// are included with a negative daysLeft, because those are the urgent ones.
//
// This reads the base table and delegates to factsExpiringWithin() rather than
// selecting from refal_facts_due_for_review, because that view hard-codes
// `current_date + 7` and therefore cannot answer ?days=N. See the note in the
// report: the view is correct for the default horizon only.
export async function dueFacts(rest, { days, now } = {}) {
  const horizon = normalizeDueWindow(days);
  const rows = await readRegisterRows(rest);
  const facts = factsExpiringWithin(horizon, { register: toRegister(rows), now })
    .map((row) => ({ ...row, statusExplanation: STATUS_EXPLANATIONS[row.effectiveStatus] || "" }));

  return {
    migrationApplied: true,
    generatedAt: nowIsoDay(now),
    days: horizon,
    counts: {
      total: facts.length,
      overdue: facts.filter((row) => Number(row.daysLeft) < 0).length,
      dueSoon: facts.filter((row) => Number(row.daysLeft) >= 0).length
    },
    facts
  };
}

// POST /api/facts/:factId/reapprove — one click, re-dated from TODAY.
//
// The guard rails are checked here against the live row BEFORE the RPC runs, so
// the operator gets a 400 with a readable message instead of a raw Postgres
// exception. src/factRegister.js#reapprove is the thing doing the checking; this
// function only feeds it the row and converts its error into an HTTP one.
export async function reapproveFact(rest, { factId, reviewer, cadenceDays, reason = "", now } = {}) {
  const id = requireFactId(factId);
  const namedReviewer = requireNamedPerson(
    reviewer,
    "A re-approval needs a named reviewer. The name is written to the audit trail, so it cannot be blank or anonymous."
  );
  const cadence = cadenceDays === undefined || cadenceDays === null || String(cadenceDays).trim() === ""
    ? null
    : requireCadence(cadenceDays);
  const trimmedReason = String(reason ?? "").trim().slice(0, 500);

  const current = await readFactRow(rest, id);
  try {
    // refal_reapprove_fact() defaults a null cadence to the row's stored
    // review_cadence_days, so the dry run is given the same number the database
    // will use. Without this the local check would fall back to the taxonomy
    // derived cadence and could disagree with the constraint.
    reapprove(current, { reviewer: namedReviewer, cadenceDays: cadence ?? current.reviewCadenceDays, now });
  } catch (error) {
    throw factError(400, error.message);
  }

  const result = await callRest(rest, "rpc/refal_reapprove_fact", {
    method: "POST",
    body: JSON.stringify({
      p_fact_id: id,
      p_reviewer: namedReviewer,
      p_cadence_days: cadence,
      p_reason: trimmedReason
    })
  });

  return { migrationApplied: true, reapproved: true, factId: id, reviewer: namedReviewer, result: result ?? null };
}

// POST /api/facts/:factId/status — the audited status change. Blocking a fact
// removes it from retrieval entirely, so it never happens without a named actor
// and a reason.
export async function setFactStatus(rest, { factId, status, actor, reason = "" } = {}) {
  const id = requireFactId(factId);
  const wanted = String(status ?? "").trim().toLowerCase();
  if (!STATUSES.includes(wanted)) throw factError(400, `Status must be one of ${STATUSES.join(", ")}.`);
  const namedActor = requireNamedPerson(
    actor,
    "A status change needs a named actor. The name is written to the audit trail, so it cannot be blank or anonymous."
  );
  const trimmedReason = String(reason ?? "").trim().slice(0, 500);
  if (!trimmedReason) throw factError(400, "A status change needs a reason, because it changes what REFAL is allowed to say.");

  await readFactRow(rest, id);
  const result = await callRest(rest, "rpc/refal_set_fact_status", {
    method: "POST",
    body: JSON.stringify({ p_fact_id: id, p_status: wanted, p_actor: namedActor, p_reason: trimmedReason })
  });

  return { migrationApplied: true, updated: true, factId: id, status: wanted, actor: namedActor, result: result ?? null };
}

// GET /api/facts/:factId/audit — the append only history, newest first. This is
// the trail M12 reads.
export async function factAudit(rest, factId) {
  const id = requireFactId(factId);
  const rows = await callRest(rest, `refal_fact_register_audit?fact_id=eq.${id}&select=${AUDIT_SELECT}&order=created_at.desc&limit=200`);
  return {
    migrationApplied: true,
    factId: id,
    entries: (Array.isArray(rows) ? rows : []).map(normalizeAuditRow)
  };
}
