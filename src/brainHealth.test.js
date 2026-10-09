"use strict";

// W3.10.6 — the gate for the brain health rules.
//
// Everything here runs on hand-built inputs, never on the corpus on disk and
// never against a database. That is the whole reason src/brainHealth.js has no
// I/O: the rules can be proved in an environment with neither, which is the
// environment this milestone is being built in.

const assert = require("node:assert/strict");
const { test } = require("node:test");

const health = require("../src/brainHealth");
const { seedRegister, STATUS } = require("../src/factRegister");
const { LANGUAGES, TOPICS } = require("../src/brainTaxonomy");
const { ENTRIES, NEGATIVE_QUERIES } = require("../src/brainGoldenSet");

const {
  SEVERITY, COVERAGE_THRESHOLD, MIN_COVERED_PER_CELL, NEGATIVE_MAX_COVERAGE,
  GOLDEN_QUESTIONS_PER_CELL, EXPECTED_CELLS,
} = health;

// ------------------------------------------------------------------ helpers

function cell(overrides = {}) {
  return {
    topic: "company-lifecycle", topicNumber: 1, phase: "P3.1", lang: "en",
    path: "knowledge/company-lifecycle/en.md",
    canonicalUrl: "refal://kb/corporate/company-lifecycle/en",
    exists: true, errors: [], warnings: [],
    title: "The life cycle of a Cyprus company",
    aliases: ["open a company in cyprus"],
    facts: ["MB-F1"], supporting: [],
    sections: [{ heading: "What the life cycle actually is", body: "Reserving a name is not registration." }],
    chunkCount: 1, chars: 100,
    ...overrides,
  };
}

// Ten questions whose every content token is in the document, so the cell is
// lexically perfect unless the test deliberately breaks it.
function reachableQuestions(topic, lang, n = GOLDEN_QUESTIONS_PER_CELL) {
  return Array.from({ length: n }, (_, i) => ({
    id: `Q-${i}`, topic, lang, question: `reserving a name is not registration ${i}`,
  }));
}

function gaps(findings) { return findings.filter((f) => f.severity === SEVERITY.GAP); }
function codes(findings) { return findings.map((f) => f.code); }

// ------------------------------------------------------------- the tokeniser

test("tokenize mirrors to_tsvector('simple'): lowercases, splits on non-word, never stems", () => {
  assert.deepEqual(health.tokenize("IP Box, 2.5% — rate!"), ["ip", "box", "2", "5", "rate"]);
  // `simple` has no stemmer, so these are three distinct lexemes. A proxy that
  // quietly stemmed would claim a reachability the live index does not have.
  assert.deepEqual(health.tokenize("register registration registered"),
    ["register", "registration", "registered"]);
  assert.deepEqual(health.tokenize("شركة في قبرص"), ["شركة", "في", "قبرص"]);
  assert.deepEqual(health.tokenize("Εταιρεία στην Κύπρο"), ["εταιρεία", "στην", "κύπρο"]);
  assert.deepEqual(health.tokenize(null), []);
});

test("content tokens drop function words and single characters, keep the meaning", () => {
  const tokens = health.contentTokens("What is the price of a Cyprus company?");
  assert.deepEqual([...tokens].sort(), ["company", "cyprus", "price"]);
  assert.ok(!health.contentTokens("ما هي الشركة في قبرص").has("في"));
  assert.ok(health.contentTokens("ما هي الشركة في قبرص").has("الشركة"));
});

test("indexedText covers title, aliases, headings and bodies; bodyText covers only what a chunk vector sees", () => {
  const c = cell({ title: "TITLEWORD", aliases: ["ALIASWORD"], sections: [{ heading: "HEADWORD", body: "BODYWORD" }] });
  const indexed = health.contentTokens(health.indexedText(c));
  for (const word of ["titleword", "aliasword", "headword", "bodyword"]) assert.ok(indexed.has(word), word);
  const body = health.contentTokens(health.bodyText(c));
  assert.ok(body.has("headword") && body.has("bodyword"));
  assert.ok(!body.has("aliasword"), "aliases are not in the live chunk search_vector");
});

test("tokenCoverage is the fraction of the question's content tokens present", () => {
  const haystack = health.contentTokens("cyprus company registration");
  const hit = health.tokenCoverage("How do I register a cyprus company?", haystack);
  // content tokens: register, cyprus, company -> 2 of 3 present ("register" is
  // not "registration" without a stemmer)
  assert.equal(hit.total, 3);
  assert.equal(hit.covered, 2);
  assert.deepEqual(hit.missing, ["register"]);
  assert.equal(health.tokenCoverage("the and of", haystack).total, 0);
});

// --------------------------------------------------- check 1 and 2: the file

test("a missing file is a gap, and nothing else is reported for it", () => {
  const found = health.assessFiles([cell({ exists: false, errors: ["knowledge/x/ar.md: MISSING"] })]);
  assert.deepEqual(codes(found), ["BH-FILE-MISSING"]);
  assert.equal(found[0].severity, SEVERITY.GAP);
});

test("every validateCorpusFile error is a gap; its warnings are warnings", () => {
  const found = health.assessFiles([cell({ errors: ["bad title", "no boundary section"], warnings: ["thin"] })]);
  assert.deepEqual(codes(found), ["BH-FILE-INVALID", "BH-FILE-INVALID", "BH-FILE-WARNING"]);
  assert.equal(gaps(found).length, 2);
});

// ------------------------------------------------------ check 3: the register

test("a live document standing on an expired or blocked fact is a gap", () => {
  const register = seedRegister();
  const approved = health.assessRegister([cell()], { register, now: "2026-10-09" });
  assert.deepEqual(approved, []);

  for (const status of [STATUS.EXPIRED, STATUS.BLOCKED, STATUS.PENDING]) {
    const broken = seedRegister();
    broken.set("MB-F1", { ...broken.get("MB-F1"), status });
    const found = health.assessRegister([cell()], { register: broken, now: "2026-10-09" });
    assert.deepEqual(codes(found), ["BH-FACT-NOT-APPROVED"], status);
    assert.equal(found[0].severity, SEVERITY.GAP);
  }
});

test("a fact that has run past its review date is a gap even though its stored status is approved", () => {
  const register = seedRegister();
  const found = health.assessRegister([cell()], { register, now: "2099-01-01" });
  assert.deepEqual(codes(found), ["BH-FACT-NOT-APPROVED"]);
});

test("supporting facts are governed exactly like owned facts", () => {
  const register = seedRegister();
  register.set("MB-F19", { ...register.get("MB-F19"), status: STATUS.BLOCKED });
  const found = health.assessRegister([cell({ supporting: ["MB-F19"] })], { register, now: "2026-10-09" });
  assert.equal(found.length, 1);
  assert.equal(found[0].fact, "MB-F19");
});

test("a fact with no register row at all is a gap", () => {
  const register = seedRegister();
  register.delete("MB-F1");
  const found = health.assessRegister([cell()], { register, now: "2026-10-09" });
  assert.deepEqual(codes(found), ["BH-FACT-NO-REGISTER-ROW"]);
});

test("an approaching review date is a warning and never a gap", () => {
  const rows = [{ id: "MB-F9", expiryOrReviewAt: "2026-10-12" }];
  const found = health.assessExpiring(rows, { now: "2026-10-09" });
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, SEVERITY.WARNING);
  assert.equal(health.exitCodeFor(found), 0);
});

// -------------------------------------------------- check 4: lexical reach

test("a cell whose questions are all in the document passes; one whose questions are not, fails", () => {
  const good = health.assessLexical([cell()], reachableQuestions("company-lifecycle", "en"));
  assert.deepEqual(good.findings, []);
  assert.equal(good.rows[0].passes, true);
  assert.equal(good.rows[0].covered, GOLDEN_QUESTIONS_PER_CELL);

  const unreachable = Array.from({ length: 10 }, (_, i) => ({
    id: `Q-${i}`, topic: "company-lifecycle", lang: "en", question: `moussaka recipe aubergine bechamel ${i}`,
  }));
  const bad = health.assessLexical([cell()], unreachable);
  assert.deepEqual(codes(bad.findings), ["BH-LEXICAL-UNREACHABLE"]);
  assert.equal(bad.rows[0].covered, 0);
  assert.equal(gaps(bad.findings).length, 1);
});

test("the cell floor is MIN_COVERED_PER_CELL out of ten, not an average", () => {
  const mixed = [
    ...reachableQuestions("company-lifecycle", "en", MIN_COVERED_PER_CELL),
    ...Array.from({ length: GOLDEN_QUESTIONS_PER_CELL - MIN_COVERED_PER_CELL }, (_, i) => ({
      id: `X-${i}`, topic: "company-lifecycle", lang: "en", question: `moussaka aubergine bechamel ${i}`,
    })),
  ];
  const at = health.assessLexical([cell()], mixed);
  assert.equal(at.rows[0].covered, MIN_COVERED_PER_CELL);
  assert.equal(at.rows[0].passes, true, "exactly at the floor passes");

  const below = health.assessLexical([cell()], mixed.slice(1));
  assert.equal(below.rows[0].passes, false, "one short of the floor fails");
});

test("a cell short of its ten golden questions is a gap in its own right", () => {
  const found = health.assessLexical([cell()], reachableQuestions("company-lifecycle", "en", 4));
  assert.ok(codes(found.findings).includes("BH-GOLDEN-SHORT"));
});

test("a missing file raises no lexical finding, so one defect is reported once", () => {
  const found = health.assessLexical([cell({ exists: false })], reachableQuestions("company-lifecycle", "en"));
  assert.deepEqual(found.findings, []);
});

// ------------------------------------------------ check 5: negative queries

test("a document that nearly contains a negative query is over-retrieving", () => {
  const moussaka = cell({
    title: "Moussaka",
    aliases: [],
    sections: [{ heading: "recipe", body: "give me a recipe for moussaka" }],
  });
  const found = health.assessNegatives([moussaka], [{ id: "NQ-07", lang: "en", q: "Give me a recipe for moussaka.", why: "unrelated" }]);
  assert.deepEqual(codes(found.findings), ["BH-NEGATIVE-REACHABLE"]);
  assert.equal(found.rows[0].worstCoverage, 1);
});

test("the real 17 negative queries stay under the ceiling against a plausible document", () => {
  const found = health.assessNegatives([cell()], NEGATIVE_QUERIES);
  assert.equal(found.rows.length, 17);
  assert.deepEqual(found.findings, []);
});

// ---------------------------------------------- check 6: FIX-7 and FIX-8

test("a healthy en document beside a thin ar twin is reported as FIX-7 by name", () => {
  const cells = [
    cell({ lang: "en" }),
    cell({ lang: "ar", path: "knowledge/company-lifecycle/ar.md", sections: [{ heading: "دورة الحياة", body: "نص عربي" }] }),
    cell({ lang: "el", path: "knowledge/company-lifecycle/el.md" }),
  ];
  const lexical = health.assessLexical(cells, [
    ...reachableQuestions("company-lifecycle", "en"),
    ...Array.from({ length: 10 }, (_, i) => ({ id: `A-${i}`, topic: "company-lifecycle", lang: "ar", question: `كم تكلفة تسجيل الشركة ${i}` })),
    ...reachableQuestions("company-lifecycle", "el"),
  ]);
  const parity = health.assessParity(cells, lexical.rows);
  assert.deepEqual(codes(parity.findings), ["BH-PARITY-AR"]);
  assert.match(parity.findings[0].message, /FIX-7/u);
  assert.equal(parity.findings[0].severity, SEVERITY.GAP);
});

test("a missing el document beside a healthy en one is reported as FIX-8 by name", () => {
  const cells = [cell({ lang: "en" }), cell({ lang: "ar" }), cell({ lang: "el", exists: false })];
  const lexical = health.assessLexical(cells, [
    ...reachableQuestions("company-lifecycle", "en"),
    ...reachableQuestions("company-lifecycle", "ar"),
  ]);
  const parity = health.assessParity(cells, lexical.rows);
  assert.deepEqual(codes(parity.findings), ["BH-PARITY-EL"]);
  assert.match(parity.findings[0].message, /FIX-8.*no el document exists|no el document exists/su);
});

test("a single-language selection raises no parity finding: absent from the selection is not absent from disk", () => {
  const cells = [cell({ lang: "en" })];
  const lexical = health.assessLexical(cells, reachableQuestions("company-lifecycle", "en"));
  const parity = health.assessParity(cells, lexical.rows);
  assert.deepEqual(parity.findings, []);
  assert.deepEqual(Object.keys(parity.perLang), ["en"]);
});

test("a topic that is broken in English raises no parity finding, because that is a different defect", () => {
  const cells = [cell({ lang: "en", exists: false }), cell({ lang: "ar", exists: false }), cell({ lang: "el", exists: false })];
  const lexical = health.assessLexical(cells, []);
  assert.deepEqual(health.assessParity(cells, lexical.rows).findings, []);
});

// --------------------------------------------- checks 7 to 10: the database

test("with no database snapshot, all four db checks are PENDING and none of them fails the run", () => {
  const result = health.assessCorpus({
    cells: [cell()], entries: reachableQuestions("company-lifecycle", "en"),
    negatives: NEGATIVE_QUERIES, register: seedRegister(), expiring: [], db: null, now: "2026-10-09",
  });
  const pending = result.findings.filter((f) => f.severity === SEVERITY.PENDING);
  assert.equal(pending.length, health.DB_CHECKS.length);
  for (const row of pending) assert.match(row.message, /PENDING DB/u);
  assert.equal(result.summary.databaseChecked, false);
  assert.equal(result.summary.pending, 4);
  assert.equal(health.exitCodeFor(result.findings), 0, "PENDING DB must never fail a run");
});

test("the service_role blocker on refal_fact_register is reported on every run and is not a gap", () => {
  for (const db of [null, new Map()]) {
    const result = health.assessCorpus({
      cells: [cell()], entries: reachableQuestions("company-lifecycle", "en"),
      negatives: [], register: seedRegister(), expiring: [], db, now: "2026-10-09",
      expectedEmbeddingModel: "m",
    });
    const blockers = result.findings.filter((f) => f.severity === SEVERITY.BLOCKER);
    assert.equal(blockers.length, 1);
    assert.equal(blockers[0].code, "BH-BLOCKER-REGISTER-SERVICE-ROLE");
    assert.match(blockers[0].message, /service_role/u);
  }
});

test("database checks: missing source, unapproved source, missing document, wrong chunk count", () => {
  const c = cell({ chunkCount: 4 });
  const model = "Xenova/multilingual-e5-small";
  const at = (row) => health.assessDatabase([c], new Map(row ? [[c.canonicalUrl, row]] : []),
    { now: "2026-10-09", expectedEmbeddingModel: model });

  assert.deepEqual(codes(at(null)), ["BH-DB-SOURCE"]);
  assert.deepEqual(codes(at({ source: { enabled: false, approved: false }, document: null })),
    ["BH-DB-SOURCE", "BH-DB-SOURCE", "BH-DB-DOCUMENT"]);
  assert.deepEqual(codes(at({
    source: { enabled: true, approved: true },
    document: { id: "d", review_status: "approved", valid_until: null },
    chunkCount: 3, embeddedCount: 3, embeddingModels: [model],
  })), ["BH-DB-CHUNKS"]);
});

test("database checks: unembedded chunks and a mismatched embedding model are both gaps", () => {
  const c = cell({ chunkCount: 4 });
  const model = "Xenova/multilingual-e5-small";
  const found = health.assessDatabase([c], new Map([[c.canonicalUrl, {
    source: { enabled: true, approved: true },
    document: { id: "d", review_status: "approved", valid_until: null },
    chunkCount: 4, embeddedCount: 2, embeddingModels: [model, "text-embedding-3-small"],
  }]]), { now: "2026-10-09", expectedEmbeddingModel: model });
  assert.deepEqual(codes(found), ["BH-DB-EMBEDDINGS", "BH-DB-EMBEDDINGS"]);
  assert.ok(found.every((f) => f.severity === SEVERITY.GAP));
});

test("valid_until: past is a gap, inside 7 days is a warning that names the 30 day price trigger", () => {
  const c = cell({ chunkCount: 1 });
  const row = (validUntil) => new Map([[c.canonicalUrl, {
    source: { enabled: true, approved: true },
    document: { id: "d", review_status: "approved", valid_until: validUntil },
    chunkCount: 1, embeddedCount: 1, embeddingModels: ["m"],
  }]]);
  const opts = { now: "2026-10-09", expectedEmbeddingModel: "m" };

  const expired = health.assessDatabase([c], row("2026-10-01T00:00:00Z"), opts);
  assert.equal(expired[0].severity, SEVERITY.GAP);
  assert.match(expired[0].message, /valid_until 2026-10-01 has passed/u);

  const soon = health.assessDatabase([c], row("2026-10-13T00:00:00Z"), opts);
  assert.equal(soon[0].severity, SEVERITY.WARNING);
  assert.match(soon[0].message, /30 days/u);
  assert.match(soon[0].message, /€300,000/u);
  assert.equal(health.exitCodeFor(soon), 0);

  assert.deepEqual(health.assessDatabase([c], row("2027-10-13T00:00:00Z"), opts), []);
});

// ----------------------------------------------------------- the whole gate

test("exitCodeFor is 1 on any gap and 0 on warnings, pendings and blockers alone", () => {
  assert.equal(health.exitCodeFor([]), 0);
  assert.equal(health.exitCodeFor([{ severity: SEVERITY.WARNING }, { severity: SEVERITY.PENDING }, { severity: SEVERITY.BLOCKER }]), 0);
  assert.equal(health.exitCodeFor([{ severity: SEVERITY.PENDING }, { severity: SEVERITY.GAP }]), 1);
});

test("assessCorpus summarises the cells, the golden questions and the four severities", () => {
  const cells = [cell({ lang: "en" }), cell({ lang: "ar" }), cell({ lang: "el" })];
  const entries = LANGUAGES.flatMap((lang) => reachableQuestions("company-lifecycle", lang));
  const result = health.assessCorpus({
    cells, entries, negatives: NEGATIVE_QUERIES, register: seedRegister(), expiring: [],
    db: null, now: "2026-10-09",
  });
  assert.equal(result.summary.selectedCells, 3);
  assert.equal(result.summary.present, 3);
  assert.equal(result.summary.lexicalPassing, 3);
  assert.equal(result.summary.goldenQuestions, 30);
  assert.equal(result.summary.goldenReachable, 30);
  assert.equal(result.summary.gaps, 0);
  assert.equal(result.summary.blockers, 1);
  assert.equal(result.summary.negatives, 17);
  assert.match(result.summary.proxy, /PROXY/u);
  for (const lang of LANGUAGES) assert.equal(result.summary.perLang[lang].passing, 1);
});

// ------------------------------------------------- the constants themselves

test("the constants still describe the shape the milestone was planned against", () => {
  assert.equal(EXPECTED_CELLS, 87);
  assert.equal(TOPICS.length * LANGUAGES.length, 87);
  assert.equal(GOLDEN_QUESTIONS_PER_CELL, 10);
  // 10 per cell is a FLOOR, not a quota, so 87 x 10 is the minimum and not the
  // count. Pinning the exact number made adding a question a test failure, and
  // that is backwards: topic 23 needed three more per language because MB-F60,
  // MB-F61 and MB-F62 were stated by the corpus and measured by nothing.
  assert.ok(ENTRIES.length >= EXPECTED_CELLS * GOLDEN_QUESTIONS_PER_CELL,
    `the golden set has ${ENTRIES.length} entries, under the ${EXPECTED_CELLS * GOLDEN_QUESTIONS_PER_CELL} floor`);
  assert.equal(NEGATIVE_QUERIES.length, 17);
  // The proxy bar must stay below the ceiling it measures against, or a
  // negative query could clear the positive bar and the negative one at once
  // and be reported as both reachable and clean.
  assert.ok(COVERAGE_THRESHOLD < NEGATIVE_MAX_COVERAGE);
  assert.ok(MIN_COVERED_PER_CELL > 0 && MIN_COVERED_PER_CELL <= GOLDEN_QUESTIONS_PER_CELL);
});
