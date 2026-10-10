"use strict";

// P3.9 — the fact register. This is Rule 2, and it is what lets REFAL state a
// number and still be safe.
//
// THE IDEA
// --------
// Every fact REFAL may assert carries provenance: where it came from, who
// approved it, when it was verified, from when it is effective, and when it
// must be looked at again. Status then drives behaviour, with no code change:
//
//   approved  -> statable, with its evidence
//   expired   -> REFAL says the figure is not currently confirmed and offers a
//                specialist follow up. It does NOT guess, and it does NOT go
//                silent either.
//   blocked   -> not retrievable at all. Not by lexical search, not by semantic
//                search, not as a fallback. It is removed at ingest and filtered
//                again at query time, because one layer is not a guarantee.
//   pending   -> authored but never approved. Treated as not statable.
//
// Rule 1 (W3.9.4, BOSS's authority instruction): MB manual facts are seeded
// APPROVED from day one. They are not blocked waiting for an external reviewer.
// Rule 2 (W3.9.5) is the safety net that makes Rule 1 survivable: each row
// carries an expiry, so a stale figure stops being asserted on its own.
//
// W3.9.6, the 12.5% question, is the worked example. Cyprus corporate tax was
// 12.5% historically and the manual says 15% from 2026. REFAL states 15% from
// day one, the row carries effectiveFrom 2026-01-01 and a short review cadence,
// and correcting it later is one field in one form rather than a release.

const { ROWS } = require("./factCatalogue");
const { reviewCadenceDays, TRUST_TIERS, VOLATILITY, LANGUAGES } = require("./brainTaxonomy");
const { normalizeFactId, isFactId } = require("./brainFactMap");

const STATUS = Object.freeze({
  APPROVED: "approved",
  EXPIRED: "expired",
  BLOCKED: "blocked",
  PENDING: "pending",
});
const STATUSES = Object.freeze(Object.values(STATUS));

// W3.9.4 — the seed identity. One place, so a migration, a test and the audit
// script cannot disagree about what "seeded by Rule 1" means.
const SEED = Object.freeze({
  reviewer: "BOSS",
  verifiedAt: "2026-10-07",
  sourceDocument: "newplan/Master Brain & Operating Rules Manual - REFAL AI.txt",
  status: STATUS.APPROVED,
});

// W3.9.2 — the twenty high risk facts that get a MANDATORY review date. The
// plan names them by their value; these are the ids those values live on.
// Listing them explicitly rather than deriving them from `numbers.length` is
// deliberate: the plan fixed this set, and a catalogue edit must not silently
// grow or shrink it.
const HIGH_RISK_FACTS = Object.freeze([
  "MB-F2",   // about two weeks to incorporate
  "MB-F6",   // Company Secretary, 4 consecutive months
  "MB-F7",   // Registered Address, 4 consecutive months
  "MB-F9",   // the formation package price
  "MB-F19",  // 15% corporate tax from 2026
  "MB-F20",  // IP Box effective 2.5% to 3%
  "MB-F30",  // EUR 300,000 minimum qualifying investment
  "MB-F31",  // EUR 50,000 main applicant income
  "MB-F32",  // EUR 15,000 spouse
  "MB-F33",  // EUR 10,000 per minor child
  "MB-F34",  // Non Dom, 17 years
  "MB-F38",  // Category A
  "MB-F39",  // Category B
  "MB-F40",  // Category C
  "MB-F41",  // Category D
  "MB-F48",  // property VAT 19% and reduced 5%
  "MB-C1",   // operational roots 2000
  "MB-C2",   // more than 20 years
  "MB-C3",   // 47 development projects
  "MB-C4",   // more than 400 multi sector projects
]);
const HIGH_RISK_SET = new Set(HIGH_RISK_FACTS);

// A high risk fact is never allowed a lazy cadence, whatever its topic says.
const HIGH_RISK_MAX_CADENCE_DAYS = 90;

// ------------------------------------------------------------------- dates
function toDate(value) {
  if (value instanceof Date) return new Date(value.getTime());
  const d = new Date(`${String(value)}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}
function toIsoDay(date) { return date.toISOString().slice(0, 10); }
function addDays(isoDay, days) {
  const d = toDate(isoDay);
  if (!d) throw new Error(`invalid date: ${isoDay}`);
  d.setUTCDate(d.getUTCDate() + days);
  return toIsoDay(d);
}
function daysBetween(fromIso, toIso) {
  const a = toDate(fromIso);
  const b = toDate(toIso);
  if (!a || !b) return null;
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}
function nowIsoDay(now) {
  if (!now) return toIsoDay(new Date());
  if (now instanceof Date) return toIsoDay(now);
  return String(now).slice(0, 10);
}

// ------------------------------------------------------------------ cadence
// W3.9.5. The taxonomy already derives a cadence from volatility and trust
// tier, and that derivation stays the single source so a row cannot hand-set a
// friendlier date for itself. High risk facts are then capped harder.
function cadenceForFact(row) {
  const base = reviewCadenceDays(row.volatility, row.trustTier);
  return HIGH_RISK_SET.has(row.id) ? Math.min(base, HIGH_RISK_MAX_CADENCE_DAYS) : base;
}

// ------------------------------------------------------------------- seeding
function seedRow(catalogueRow, { verifiedAt = SEED.verifiedAt } = {}) {
  const id = normalizeFactId(catalogueRow.id);
  if (!isFactId(id)) throw new Error(`factCatalogue carries an unknown id: ${catalogueRow.id}`);
  const cadence = cadenceForFact(catalogueRow);
  return {
    id,
    topics: [...(catalogueRow.topics || [])],
    claimText: catalogueRow.claim,
    sourceType: catalogueRow.sourceType,
    sourceRef: catalogueRow.sourceRef,
    sourceDocument: SEED.sourceDocument,
    jurisdiction: catalogueRow.jurisdiction,
    numbers: (catalogueRow.numbers || []).map((n) => ({ ...n })),
    volatility: catalogueRow.volatility,
    trustTier: catalogueRow.trustTier,
    highRisk: HIGH_RISK_SET.has(id),
    reviewer: SEED.reviewer,
    verifiedAt,
    effectiveFrom: catalogueRow.effectiveFrom || null,
    expiryOrReviewAt: addDays(verifiedAt, cadence),
    reviewCadenceDays: cadence,
    approvedLanguages: [...LANGUAGES],
    status: SEED.status,
    notes: catalogueRow.notes || "",
  };
}

// The register as it exists before any database row overrides it. The live
// system reads `refal_fact_register` (MIG-01); this seed is both the migration's
// payload and the offline fallback, so behaviour is identical either way.
function seedRegister(options = {}) {
  const register = new Map();
  for (const row of ROWS) {
    const seeded = seedRow(row, options);
    if (register.has(seeded.id)) throw new Error(`duplicate fact id in catalogue: ${seeded.id}`);
    register.set(seeded.id, seeded);
  }
  return register;
}

// Apply database rows (or a dashboard edit) over the seed. Anything the
// override does not mention keeps its seeded value, so a reviewer who only
// changed a status does not accidentally blank the provenance.
function applyOverrides(register, overrides = []) {
  for (const override of overrides) {
    const id = normalizeFactId(override.id);
    const base = register.get(id);
    if (!base) throw new Error(`override names an unknown fact: ${override.id}`);
    if (override.status && !STATUSES.includes(override.status)) {
      throw new Error(`override for ${id} has unknown status ${override.status}`);
    }
    register.set(id, { ...base, ...override, id });
  }
  return register;
}

// ------------------------------------------------------------------ status
// The stored status is an intent. The EFFECTIVE status also accounts for the
// clock and the effective date, which is the whole point of Rule 2: nobody has
// to remember to flip a row to expired.
function effectiveStatus(row, now) {
  if (!row) return STATUS.PENDING;
  if (row.status === STATUS.BLOCKED) return STATUS.BLOCKED;
  if (row.status === STATUS.PENDING) return STATUS.PENDING;
  const today = nowIsoDay(now);
  if (row.status === STATUS.EXPIRED) return STATUS.EXPIRED;
  if (row.expiryOrReviewAt && today > row.expiryOrReviewAt) return STATUS.EXPIRED;
  // A fact that is not yet in force is not wrong, it is early. Treat it as
  // pending rather than expired so the guidance tells the truth.
  if (row.effectiveFrom && today < row.effectiveFrom) return STATUS.PENDING;
  return STATUS.APPROVED;
}

// What the agent is allowed to do with this fact right now, and what it should
// say when the answer is no. The guidance strings are intentionally behavioural
// rather than literal copy: the language layer renders them, this module
// decides.
function factBehaviour(factId, { register, now, lang } = {}) {
  const id = normalizeFactId(factId);
  const reg = register || seedRegister();
  const row = reg.get(id) || null;
  const status = effectiveStatus(row, now);

  if (!row) {
    return { id, status: STATUS.PENDING, statable: false, retrievable: false, row: null,
      reason: "no_register_row", guidance: "unknown_fact_route_to_specialist" };
  }
  if (lang && !row.approvedLanguages.includes(lang)) {
    return { id, status, statable: false, retrievable: true, row,
      reason: "language_not_approved", guidance: "answer_in_approved_language_or_route_to_specialist" };
  }
  switch (status) {
    case STATUS.BLOCKED:
      return { id, status, statable: false, retrievable: false, row,
        reason: "blocked", guidance: "do_not_surface_route_to_specialist" };
    case STATUS.EXPIRED:
      return { id, status, statable: false, retrievable: true, row,
        reason: "expired", guidance: "state_not_currently_confirmed_and_offer_specialist_follow_up" };
    case STATUS.PENDING:
      return { id, status, statable: false, retrievable: true, row,
        reason: row.effectiveFrom ? "not_yet_effective" : "not_approved",
        guidance: "state_not_currently_confirmed_and_offer_specialist_follow_up" };
    default:
      return { id, status, statable: true, retrievable: true, row, reason: "approved", guidance: "state_with_evidence" };
  }
}

function isStatable(factId, options) { return factBehaviour(factId, options).statable; }
function isRetrievable(factId, options) { return factBehaviour(factId, options).retrievable; }

// ------------------------------------------------------- retrieval filtering
// W3.9.3's hard half. A blocked fact must not reach the model, so every chunk
// that carries it is dropped before evidence is assembled, whichever search
// path produced it. Chunks carry their fact ids in metadata.facts, written by
// the ingestion script from the `<!-- facts: ... -->` directives.
function chunkFactIds(chunk) {
  const raw = chunk?.metadata?.facts ?? chunk?.facts ?? [];
  const list = Array.isArray(raw) ? raw : String(raw).split(",");
  return list.map(normalizeFactId).filter(isFactId);
}

// CF-04. Chunk 0 of every document is a FINDING AID: the title, the section
// headings and the author's alias phrases. It exists so a dialect question can
// locate the document at all, and it carries no facts. It is a card catalogue,
// not content.
//
// It must never reach the model. A customer question matches a list of customer
// questions almost perfectly, so the aid routinely OUT-RANKS the real sections;
// the model then receives a block of question phrases, is forbidden by the M2
// claim gate from stating any number it cannot see in evidence, and recites the
// alias list back. That shipped: on 2026-10-10 "انت مين وشو عندكم خدمات"
// returned the company-profile finding aid at rank 0.70 with no fact chunk at
// all, and the reply was the alias list read aloud.
//
// The primary fix is sibling expansion in the search RPCs (migration
// 20261010140000), which swaps an aid for its own document's real chunks. This
// is the second line of defence, and it is deliberate rather than redundant:
// the RPC fix cannot be exercised by the offline suite, four callers reach the
// search, and an older deployed RPC would reopen the defect silently. Here it
// is one assertion on the single path the composer actually uses.
const FINDING_AID_KIND = "aliases";

function isFindingAid(chunk) {
  const kind = chunk?.chunk_kind ?? chunk?.chunkKind ?? chunk?.metadata?.kind ?? "";
  return String(kind) === FINDING_AID_KIND;
}

function filterRetrievableEvidence(chunks, { register, now } = {}) {
  const reg = register || seedRegister();
  const kept = [];
  const dropped = [];
  for (const chunk of Array.isArray(chunks) ? chunks : []) {
    if (isFindingAid(chunk)) {
      dropped.push({ chunk, blocked: [], reason: "finding_aid" });
      continue;
    }
    const ids = chunkFactIds(chunk);
    const blocked = ids.filter((id) => effectiveStatus(reg.get(id), now) === STATUS.BLOCKED);
    if (blocked.length) dropped.push({ chunk, blocked, reason: "blocked_fact" });
    else kept.push(chunk);
  }
  return { kept, dropped };
}

// Which facts in a retrieved set may actually be asserted, and what to do about
// the rest. This is what the composer asks before it writes a number.
function classifyEvidence(chunks, { register, now, lang } = {}) {
  const reg = register || seedRegister();
  const statable = new Set();
  const expired = new Set();
  const blocked = new Set();
  for (const chunk of Array.isArray(chunks) ? chunks : []) {
    for (const id of chunkFactIds(chunk)) {
      const behaviour = factBehaviour(id, { register: reg, now, lang });
      if (behaviour.statable) statable.add(id);
      else if (behaviour.status === STATUS.BLOCKED) blocked.add(id);
      else expired.add(id);
    }
  }
  return { statable: [...statable], expired: [...expired], blocked: [...blocked] };
}

// --------------------------------------------------------------- the review
// W3.9.7 — the dashboard's "review soon" list, and the one click that extends a
// date. Re-approval re-dates from TODAY, not from the old expiry, so a row that
// sat expired for a month does not come back already half spent.
function factsExpiringWithin(days, { register, now } = {}) {
  const reg = register || seedRegister();
  const today = nowIsoDay(now);
  const horizon = addDays(today, days);
  return [...reg.values()]
    .filter((row) => row.status === STATUS.APPROVED && row.expiryOrReviewAt && row.expiryOrReviewAt <= horizon)
    .map((row) => ({ ...row, effectiveStatus: effectiveStatus(row, now), daysLeft: daysBetween(today, row.expiryOrReviewAt) }))
    .sort((a, b) => a.expiryOrReviewAt.localeCompare(b.expiryOrReviewAt) || a.id.localeCompare(b.id));
}

function expiredFacts({ register, now } = {}) {
  const reg = register || seedRegister();
  return [...reg.values()].filter((row) => effectiveStatus(row, now) === STATUS.EXPIRED);
}

function reapprove(row, { reviewer, now, cadenceDays } = {}) {
  if (!reviewer) throw new Error("re-approval needs a named reviewer");
  const today = nowIsoDay(now);
  // Fall back to the row's STORED cadence, not to the derived one.
  //
  // Found by the W3.9.7 dashboard work: this function and refal_reapprove_fact
  // disagreed about the default. The SQL used `v_before.review_cadence_days`,
  // this used `cadenceForFact(row)`. They match on a freshly seeded row, so the
  // divergence is invisible until a reviewer sets a custom cadence once, after
  // which every later re-approval silently resets it here and preserves it in
  // the database. Two layers quietly disagreeing about the same operation is the
  // drift class this project keeps paying for, so the stored value wins in both:
  // it is what a human last decided, and the cap below still protects it.
  const cadence = cadenceDays || row.reviewCadenceDays || cadenceForFact(row);
  if (row.highRisk && cadence > HIGH_RISK_MAX_CADENCE_DAYS) {
    throw new Error(`${row.id} is high risk and cannot be given a ${cadence} day cadence`);
  }
  return {
    ...row,
    reviewer,
    verifiedAt: today,
    status: STATUS.APPROVED,
    reviewCadenceDays: cadence,
    expiryOrReviewAt: addDays(today, cadence),
  };
}

// ------------------------------------------------------------------- audit
// Every invariant the register has to hold, in one place, so the test suite and
// scripts/factRegisterAudit.js check the same list.
function auditRegister({ register, now } = {}) {
  const reg = register || seedRegister();
  const problems = [];
  const add = (id, severity, message) => problems.push({ id, severity, message });

  for (const id of HIGH_RISK_FACTS) {
    if (!reg.has(id)) add(id, "blocker", "named high risk in W3.9.2 but absent from the register");
  }
  for (const row of reg.values()) {
    if (!row.claimText || row.claimText.length < 25) add(row.id, "high", "claim text is missing or too short to review");
    if (!row.reviewer) add(row.id, "high", "no named reviewer");
    if (!row.verifiedAt) add(row.id, "high", "no verified_at");
    if (!row.expiryOrReviewAt) add(row.id, "blocker", "no expiry or review date, so Rule 2 cannot fire");
    if (!STATUSES.includes(row.status)) add(row.id, "blocker", `unknown status ${row.status}`);
    if (!row.approvedLanguages.length) add(row.id, "high", "no approved language, so it can never be stated");
    if (row.highRisk && row.reviewCadenceDays > HIGH_RISK_MAX_CADENCE_DAYS) {
      add(row.id, "blocker", `high risk fact has a ${row.reviewCadenceDays} day cadence, over the ${HIGH_RISK_MAX_CADENCE_DAYS} day cap`);
    }
    if (row.numbers.length && !row.highRisk && row.volatility === VOLATILITY.VOLATILE && row.reviewCadenceDays > 90) {
      add(row.id, "medium", "carries a number, is volatile, and has a cadence over 90 days");
    }
    if (row.trustTier === TRUST_TIERS.REGULATED && row.sourceType === "mb-manual" && row.numbers.length) {
      add(row.id, "medium", "regulated numeric claim sourced only to the manual, wants an authority reference before its next review");
    }
    if (effectiveStatus(row, now) === STATUS.EXPIRED && row.status === STATUS.APPROVED) {
      add(row.id, "high", `review date ${row.expiryOrReviewAt} has passed, the fact is no longer stated`);
    }
  }
  return problems;
}

module.exports = {
  STATUS, STATUSES, SEED, HIGH_RISK_FACTS, HIGH_RISK_MAX_CADENCE_DAYS,
  addDays, daysBetween, nowIsoDay, cadenceForFact,
  seedRow, seedRegister, applyOverrides,
  effectiveStatus, factBehaviour, isStatable, isRetrievable,
  chunkFactIds, filterRetrievableEvidence, classifyEvidence, isFindingAid, FINDING_AID_KIND,
  factsExpiringWithin, expiredFacts, reapprove, auditRegister,
};
