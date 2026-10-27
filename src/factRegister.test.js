const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  STATUS, SEED, HIGH_RISK_FACTS, HIGH_RISK_MAX_CADENCE_DAYS,
  addDays, cadenceForFact, seedRegister, applyOverrides,
  effectiveStatus, factBehaviour, isStatable,
  chunkFactIds, filterRetrievableEvidence, filterStatableEvidence, classifyEvidence,
  factsExpiringWithin, expiredFacts, reapprove, auditRegister,
} = require("./factRegister");
const { FACT_IDS, requiredFactsForTopic } = require("./brainFactMap");
const { TOPICS, LANGUAGES } = require("./brainTaxonomy");

// G2 for P3.9. The plan states the gate in four lines and every one of them is
// a behaviour, not a schema check:
//
//   an expired fact cannot be asserted
//   a blocked fact cannot be retrieved by lexical OR semantic search
//   an approved fact is asserted with its evidence
//   changing a register row changes behaviour with no redeploy
//
// The fourth is the one that is easy to fake. It is tested by mutating a row and
// asserting the SAME function call returns a different answer, with no module
// reload, because that is what "one field in one form" actually has to mean.

const DAY = "2026-10-09";
const chunk = (facts, content = "synthetic chunk body") => ({ content, metadata: { facts } });

// ------------------------------------------------------------------- seeding

test("the register seeds one row per catalogue fact, and the catalogue covers every id", () => {
  const register = seedRegister();
  assert.equal(register.size, FACT_IDS.length);
  for (const id of FACT_IDS) assert.ok(register.has(id), `missing register row for ${id}`);
});

test("manual claims remain pending until explicitly approved, despite carrying provenance", () => {
  const register = seedRegister();
  for (const row of register.values()) {
    assert.equal(row.status, STATUS.PENDING, `${row.id} became speakable without explicit approval`);
    assert.equal(row.reviewer, SEED.reviewer);
    assert.ok(row.verifiedAt);
    assert.ok(row.expiryOrReviewAt > row.verifiedAt);
    assert.ok(row.sourceDocument, `${row.id} has no source document`);
    assert.ok(
      /^https?:\/\//u.test(row.sourceDocument) || row.sourceDocument.includes("Master Brain"),
      `${row.id} should retain a primary-source URL or owner-source provenance for review`,
    );
  }
});

test("VAT/EORI and employer compliance facts use the volatile review cadence and remain pending", () => {
  const register = seedRegister();
  for (const id of ["MB-F26", "MB-F27"]) {
    const row = register.get(id);
    assert.equal(row.volatility, "VOLATILE", `${id} contains changing VAT, customs, or employment requirements`);
    assert.equal(row.status, STATUS.PENDING, `${id} cannot become customer evidence without independent approval`);
  }
});

test("only approved rows carry a review date after verification", () => {
  for (const row of seedRegister().values()) {
    if (row.status === STATUS.APPROVED) {
      assert.ok(row.expiryOrReviewAt, `${row.id} has no review date`);
      assert.ok(row.expiryOrReviewAt > row.verifiedAt, `${row.id} expires on or before it was verified`);
    }
  }
});

test("W3.9.2: the twenty high risk facts exist and none of them gets a lazy cadence", () => {
  const register = seedRegister();
  assert.equal(HIGH_RISK_FACTS.length, 20);
  for (const id of HIGH_RISK_FACTS) {
    const row = register.get(id);
    assert.ok(row, `high risk fact ${id} is missing from the register`);
    assert.equal(row.highRisk, true);
    assert.ok(
      row.reviewCadenceDays <= HIGH_RISK_MAX_CADENCE_DAYS,
      `${id} has a ${row.reviewCadenceDays} day cadence, over the ${HIGH_RISK_MAX_CADENCE_DAYS} day cap`,
    );
  }
});

test("the cadence is derived from the taxonomy, so a row cannot hand itself a friendlier date", () => {
  const register = seedRegister();
  for (const row of register.values()) {
    assert.equal(row.reviewCadenceDays, cadenceForFact(row), `${row.id} drifted from the derived cadence`);
    if (row.status === STATUS.APPROVED) assert.equal(row.expiryOrReviewAt, addDays(row.verifiedAt, row.reviewCadenceDays));
  }
});

test("every fact a topic is required to state has a register row", () => {
  const register = seedRegister();
  for (const topic of TOPICS) {
    for (const id of requiredFactsForTopic(topic.slug)) {
      assert.ok(register.has(id), `${topic.slug} must state ${id} but it has no register row`);
    }
  }
});

// ------------------------------------------------------------- the four gates

test("an APPROVED fact is statable, and says so with its evidence", () => {
  const register = applyOverrides(seedRegister(), [{ id: "MB-F19", status: STATUS.APPROVED, reviewer: "reviewer", verifiedAt: DAY, expiryOrReviewAt: addDays(DAY, 30) }]);
  const behaviour = factBehaviour("MB-F19", { register, now: DAY });
  assert.equal(behaviour.status, STATUS.APPROVED);
  assert.equal(behaviour.statable, true);
  assert.equal(behaviour.guidance, "state_with_evidence");
  assert.ok(behaviour.row.claimText.length > 25);
});

test("an EXPIRED fact cannot be asserted, and REFAL offers a specialist instead of guessing", () => {
  const register = applyOverrides(seedRegister(), [{ id: "MB-F19", status: STATUS.APPROVED, reviewer: "reviewer", verifiedAt: "2025-01-01", expiryOrReviewAt: "2026-01-01" }]);
  const row = register.get("MB-F19");
  // No code change, no redeploy. One date moved into the past.
  register.set("MB-F19", { ...row, expiryOrReviewAt: "2026-01-01" });

  const behaviour = factBehaviour("MB-F19", { register, now: DAY });
  assert.equal(behaviour.status, STATUS.EXPIRED);
  assert.equal(behaviour.statable, false);
  assert.equal(behaviour.guidance, "state_not_currently_confirmed_and_offer_specialist_follow_up");
  // Expired is not blocked. The chunk is still retrievable so the agent can see
  // the topic exists and route the customer, rather than pretending it does not.
  assert.equal(behaviour.retrievable, true);
});

test("a BLOCKED fact cannot be retrieved by any search path, lexical or semantic", () => {
  const register = applyOverrides(seedRegister(), [{ id: "MB-F19", status: STATUS.BLOCKED }]);

  const lexicalHits = [chunk(["MB-F19"], "corporate tax rate"), chunk(["MB-F20"], "ip box")];
  const semanticHits = [chunk(["MB-F19"], "what companies pay on profits"), chunk(["MB-F21"], "not automatic")];

  for (const hits of [lexicalHits, semanticHits]) {
    const { kept, dropped } = filterRetrievableEvidence(hits, { register, now: DAY });
    assert.equal(kept.length, 1);
    assert.equal(dropped.length, 1);
    assert.deepEqual(dropped[0].blocked, ["MB-F19"]);
    for (const c of kept) assert.ok(!chunkFactIds(c).includes("MB-F19"));
  }

  assert.equal(isStatable("MB-F19", { register, now: DAY }), false);
  assert.equal(factBehaviour("MB-F19", { register, now: DAY }).retrievable, false);
});

test("a blocked fact does not leak through a chunk that also carries an approved fact", () => {
  const register = applyOverrides(seedRegister(), [{ id: "MB-F19", status: STATUS.BLOCKED }]);
  const mixed = [chunk(["MB-F19", "MB-F20"], "a chunk about both")];
  const { kept, dropped } = filterRetrievableEvidence(mixed, { register, now: DAY });
  assert.equal(kept.length, 0, "a chunk carrying a blocked fact must be dropped whole");
  assert.deepEqual(dropped[0].blocked, ["MB-F19"]);
});

test("pending, expired, and unapproved-language facts never reach the answer model", () => {
  const chunkWith = (status, language = "en", expiry = "2027-01-01") => ({
    metadata: { facts: ["MB-F19"] },
    policyMetadata: { facts: ["MB-F19"], factRegisterRows: [{
      id: "MB-F19", status, reviewer: "reviewer", verifiedAt: "2026-01-01",
      expiryOrReviewAt: expiry, effectiveFrom: null, approvedLanguages: [language]
    }] }
  });
  assert.equal(filterStatableEvidence([chunkWith("pending")], { lang: "en", now: DAY }).kept.length, 0);
  assert.equal(filterStatableEvidence([chunkWith("approved", "en", "2026-01-01")], { lang: "en", now: DAY }).kept.length, 0);
  assert.equal(filterStatableEvidence([chunkWith("approved", "en")], { lang: "ar", now: DAY }).kept.length, 0);
  assert.equal(filterStatableEvidence([chunkWith("approved")], { lang: "en", now: DAY }).kept.length, 1);
  assert.equal(filterStatableEvidence([chunk(["MB-F19"])], { lang: "en", now: DAY }).kept.length, 0, "offline seed is pending by default");
});

test("changing a register row changes behaviour with no redeploy", () => {
  const register = applyOverrides(seedRegister(), [{ id: "MB-F20", status: STATUS.APPROVED, reviewer: "reviewer", verifiedAt: DAY, expiryOrReviewAt: addDays(DAY, 30) }]);
  const call = () => factBehaviour("MB-F20", { register, now: DAY }).statable;

  assert.equal(call(), true);
  applyOverrides(register, [{ id: "MB-F20", status: STATUS.BLOCKED }]);
  assert.equal(call(), false, "the same call must follow the row, not a cached module decision");
  applyOverrides(register, [{ id: "MB-F20", status: STATUS.APPROVED }]);
  assert.equal(call(), true);
});

// ---------------------------------------------------------------- the clock

test("a fact that is not yet in force reads as pending, not as expired", () => {
  const register = seedRegister();
  const row = { ...register.get("MB-F19"), status: STATUS.APPROVED, reviewer: "reviewer", verifiedAt: DAY };
  register.set("MB-F19", { ...row, effectiveFrom: "2030-01-01", expiryOrReviewAt: "2031-01-01" });
  const behaviour = factBehaviour("MB-F19", { register, now: DAY });
  assert.equal(behaviour.status, STATUS.PENDING);
  assert.equal(behaviour.reason, "not_yet_effective");
  assert.equal(behaviour.statable, false);
});

test("expiry is evaluated against the caller's clock, not the module load time", () => {
  const register = seedRegister();
  const row = { ...register.get("MB-F19"), status: STATUS.APPROVED, reviewer: "reviewer", verifiedAt: DAY, expiryOrReviewAt: addDays(DAY, 30) };
  const dayBefore = row.expiryOrReviewAt;
  const dayAfter = addDays(row.expiryOrReviewAt, 1);
  assert.equal(effectiveStatus(row, dayBefore), STATUS.APPROVED, "a fact is still good on its review date");
  assert.equal(effectiveStatus(row, dayAfter), STATUS.EXPIRED);
});

test("an unknown fact id is never statable and never silently treated as approved", () => {
  const behaviour = factBehaviour("MB-F999", { register: seedRegister(), now: DAY });
  assert.equal(behaviour.statable, false);
  assert.equal(behaviour.reason, "no_register_row");
});

test("a language that is not approved for a fact cannot state it", () => {
  const register = applyOverrides(seedRegister(), [{ id: "MB-F19", status: STATUS.APPROVED, reviewer: "reviewer", verifiedAt: DAY, expiryOrReviewAt: addDays(DAY, 30), approvedLanguages: ["en"] }]);
  assert.equal(isStatable("MB-F19", { register, now: DAY, lang: "en" }), true);
  assert.equal(isStatable("MB-F19", { register, now: DAY, lang: "ar" }), false);
  assert.equal(factBehaviour("MB-F19", { register, now: DAY, lang: "el" }).reason, "language_not_approved");
});

test("every fact is approved in all three languages by default", () => {
  for (const row of seedRegister().values()) {
    for (const lang of LANGUAGES) {
      assert.ok(row.approvedLanguages.includes(lang), `${row.id} is not approved for ${lang}`);
    }
  }
});

// --------------------------------------------------------- evidence sorting

test("classifyEvidence separates what may be said from what must be deflected", () => {
  const register = applyOverrides(seedRegister(), [
    { id: "MB-F19", status: STATUS.APPROVED, reviewer: "reviewer", verifiedAt: DAY, expiryOrReviewAt: addDays(DAY, 30) },
    { id: "MB-F20", status: STATUS.BLOCKED },
    { id: "MB-F21", status: STATUS.APPROVED, reviewer: "reviewer", verifiedAt: "2025-01-01", expiryOrReviewAt: "2020-01-01" },
  ]);
  const result = classifyEvidence(
    [chunk(["MB-F19"]), chunk(["MB-F20"]), chunk(["MB-F21"])],
    { register, now: DAY },
  );
  assert.deepEqual(result.statable, ["MB-F19"]);
  assert.deepEqual(result.blocked, ["MB-F20"]);
  assert.deepEqual(result.expired, ["MB-F21"]);
});

test("chunk fact ids are read from metadata and the padded legacy form is repaired", () => {
  assert.deepEqual(chunkFactIds({ metadata: { facts: ["MB-F06", "MB-F7"] } }), ["MB-F6", "MB-F7"]);
  assert.deepEqual(chunkFactIds({ metadata: { facts: "MB-F1, MB-F2" } }), ["MB-F1", "MB-F2"]);
  assert.deepEqual(chunkFactIds({}), []);
  assert.deepEqual(chunkFactIds({ metadata: { facts: ["not-a-fact"] } }), []);
});

// ------------------------------------------------------------- the dashboard

test("W3.9.7: the review soon list finds exactly the rows inside the horizon", () => {
  const register = seedRegister();
  const soon = addDays(DAY, 3);
  const later = addDays(DAY, 90);
  applyOverrides(register, [
    { id: "MB-F19", status: STATUS.APPROVED, reviewer: "reviewer", verifiedAt: DAY, expiryOrReviewAt: soon },
    { id: "MB-F20", status: STATUS.APPROVED, reviewer: "reviewer", verifiedAt: DAY, expiryOrReviewAt: later },
  ]);
  const due = factsExpiringWithin(7, { register, now: DAY });
  const ids = due.map((r) => r.id);
  assert.ok(ids.includes("MB-F19"));
  assert.ok(!ids.includes("MB-F20"));
  assert.equal(due.find((r) => r.id === "MB-F19").daysLeft, 3);
});

test("one click re-approval re-dates from today, not from the stale expiry", () => {
  const register = seedRegister();
  const stale = { ...register.get("MB-F19"), status: STATUS.APPROVED, reviewer: "reviewer", verifiedAt: "2025-01-01", expiryOrReviewAt: "2026-01-01" };
  assert.equal(effectiveStatus(stale, DAY), STATUS.EXPIRED);

  const fresh = reapprove(stale, { reviewer: "BOSS", now: DAY });
  assert.equal(fresh.status, STATUS.APPROVED);
  assert.equal(fresh.verifiedAt, DAY);
  assert.equal(fresh.expiryOrReviewAt, addDays(DAY, fresh.reviewCadenceDays));
  assert.equal(effectiveStatus(fresh, DAY), STATUS.APPROVED);
});

test("re-approval keeps a reviewer's chosen cadence instead of resetting it to the derived one", () => {
  // The SQL falls back to the row's stored review_cadence_days. This must too,
  // or a custom cadence survives in the database and is silently reset here.
  const register = seedRegister();
  const row = register.get("MB-F19");
  const custom = reapprove(row, { reviewer: "BOSS", now: DAY, cadenceDays: 60 });
  assert.equal(custom.reviewCadenceDays, 60);

  const again = reapprove(custom, { reviewer: "BOSS", now: DAY });
  assert.equal(again.reviewCadenceDays, 60, "the reviewer's choice must survive the next re-approval");
  assert.equal(again.expiryOrReviewAt, addDays(DAY, 60));
});

test("re-approval refuses an anonymous reviewer and refuses to stretch a high risk fact", () => {
  const register = seedRegister();
  const row = register.get("MB-F19");
  assert.throws(() => reapprove(row, { now: DAY }), /named reviewer/u);
  assert.throws(() => reapprove(row, { reviewer: "BOSS", now: DAY, cadenceDays: 365 }), /high risk/u);
});

test("expiredFacts reports every row the clock has retired", () => {
  const register = applyOverrides(seedRegister(), [{ id: "MB-F19", status: STATUS.APPROVED, reviewer: "reviewer", verifiedAt: "2019-01-01", expiryOrReviewAt: "2020-01-01" }]);
  const ids = expiredFacts({ register, now: DAY }).map((r) => r.id);
  assert.deepEqual(ids, ["MB-F19"]);
});

// ------------------------------------------------------------------- audit

test("the seeded register passes its own audit on the day it was seeded", () => {
  const problems = auditRegister({ register: seedRegister(), now: SEED.verifiedAt });
  const blocking = problems.filter((p) => p.severity === "blocker" || p.severity === "high");
  assert.deepEqual(blocking, [], `seeded register has blocking audit findings: ${JSON.stringify(blocking, null, 1)}`);
});

test("the audit catches a row whose review date has quietly passed", () => {
  const register = applyOverrides(seedRegister(), [{ id: "MB-F19", status: STATUS.APPROVED, reviewer: "reviewer", verifiedAt: "2019-01-01", expiryOrReviewAt: "2020-01-01" }]);
  const problems = auditRegister({ register, now: DAY });
  assert.ok(problems.some((p) => p.id === "MB-F19" && p.severity === "high"));
});

test("the audit refuses a high risk fact with a stretched cadence", () => {
  const register = applyOverrides(seedRegister(), [{ id: "MB-F19", reviewCadenceDays: 365 }]);
  const problems = auditRegister({ register, now: SEED.verifiedAt });
  assert.ok(problems.some((p) => p.id === "MB-F19" && p.severity === "blocker"));
});

test("applyOverrides rejects an unknown fact and an unknown status", () => {
  assert.throws(() => applyOverrides(seedRegister(), [{ id: "MB-F999" }]), /unknown fact/u);
  assert.throws(() => applyOverrides(seedRegister(), [{ id: "MB-F19", status: "nearly" }]), /unknown status/u);
});

// --------------------------------------------- the W3.9.6 worked example

test("unreviewed tax figures remain unstatable even when the catalogue records a candidate value", () => {
  const register = seedRegister();
  const row = register.get("MB-F19");
  assert.equal(row.effectiveFrom, "2026-01-01", "the 12.5% question is answered by the effective date, not by hedging");
  assert.ok(row.claimText.includes("15"), "the claim text must carry the rate it approves");
  assert.ok(row.highRisk, "the corporate tax rate is one of the twenty");
  assert.ok(row.reviewCadenceDays <= 90);
  assert.equal(factBehaviour("MB-F19", { register, now: DAY }).statable, false);
});

test("MB-F9 holds the package price row without holding the number", () => {
  const row = seedRegister().get("MB-F9");
  assert.ok(row, "the formation package price still needs a register row");
  assert.deepEqual(row.numbers, [], "the price itself lives in refal_offers_and_pricing, never here");
  assert.ok(row.highRisk);
  assert.ok(!/999/u.test(row.claimText), "the claim text must not freeze the figure either");
});

// --------------------------------------------------------------- CF-04 / FIX
// The finding aid must never leave as evidence. These two tests are a pair on
// purpose: the first fails if the guard is removed, the second fails if the
// guard turns into a block-everything filter. Section 21's bar for closing a
// carry-forward row is exactly that, because a gate that drops all evidence
// would "pass" the first test on its own and reopen BLK-1 through a new door.

test("CF-04: a finding aid is never returned as evidence, whichever shape it arrives in", () => {
  const chunks = [
    { chunk_kind: "aliases", content: "who are you | company profile | وين مكاتبكم" }, // RPC shape
    { metadata: { kind: "aliases" }, content: "title\nheading\nalias phrases" },        // ingest shape
    { chunkKind: "aliases", content: "camelCase caller" },                              // defensive
    { chunk_kind: "fact", metadata: { facts: ["MB-C1"] }, content: "Operational roots in 2000." },
  ];
  const { kept, dropped } = filterRetrievableEvidence(chunks);

  assert.equal(kept.length, 1, "only the fact-bearing chunk may survive");
  assert.equal(kept[0].chunk_kind, "fact");
  assert.equal(dropped.length, 3);
  assert.ok(dropped.every((d) => d.reason === "finding_aid"), "each drop must say why it was dropped");
  assert.ok(
    !kept.some((c) => /alias|company profile/iu.test(String(c.content))),
    "an alias list reaching the model is what made REFAL recite her own index back at a customer"
  );
});

test("CF-04: the guard drops ONLY finding aids, so real sections still reach the model", () => {
  const chunks = [
    { chunk_kind: "fact", metadata: { facts: ["MB-C1"] }, content: "Operational roots in 2000." },
    { chunk_kind: "fact", metadata: { facts: ["MB-C3"] }, content: "47 development projects." },
    { chunk_kind: "boundary", metadata: { facts: ["MB-C5"] }, content: "Not a narrow registration office." },
    { chunk_kind: "example", metadata: { facts: ["MB-C1"] }, content: "How to verify us." },
    { chunk_kind: "discovery", metadata: { facts: ["MB-C5"] }, content: "What is the company for?" },
    { content: "a chunk from a caller that sends no kind at all" },
  ];
  const { kept, dropped } = filterRetrievableEvidence(chunks);

  assert.equal(kept.length, chunks.length, "no non-alias chunk may be dropped by the CF-04 guard");
  assert.equal(dropped.length, 0);
});
