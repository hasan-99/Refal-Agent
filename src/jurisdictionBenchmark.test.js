"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const {
  TOPICS,
  DISCOVERY_QUESTION,
  validateJurisdictionComparison: validateWithRegister,
} = require("./jurisdictionBenchmark");
const { seedRegister, applyOverrides } = require("./factRegister");
const { parseCorpusFile } = require("./corpusFile");
const { canonicalUrl } = require("./brainTaxonomy");

const FUTURE = new Date(Date.now() + 86_400_000).toISOString();
const CURRENT_FACT_REGISTER = seedRegister();
function validateJurisdictionComparison(options) {
  return validateWithRegister({ factRegister: CURRENT_FACT_REGISTER, ...options });
}
function evidence(topicSlug, fact, overrides = {}) {
  const comparator = {
    "jurisdiction-dubai": "Dubai",
    "jurisdiction-estonia": "Estonia",
    "jurisdiction-malta-bulgaria": "Malta and Bulgaria",
    "jurisdiction-usa": "the USA",
  }[topicSlug];
  return [{
    content: `MB-J0 posture and ${fact}: Cyprus and ${comparator} have different considerations.`,
    review_status: "approved",
    valid_until: FUTURE,
    sourceRef: `refal://kb/comparison/${topicSlug}/en`,
    factIds: ["MB-J0", fact],
    ...overrides,
  }];
}

test("P5.3 covers P3.8 topics 26 through 29 with their MB-J facts", () => {
  assert.deepEqual(Object.values(TOPICS).map(({ id }) => id), [26, 27, 28, 29]);
  assert.deepEqual(Object.values(TOPICS).map(({ fact }) => fact), ["MB-J1", "MB-J2", "MB-J3", "MB-J4"]);
});

test("a comparison passes only with approved, current topic evidence and MB-J0 posture", () => {
  for (const [topicSlug, { fact }] of Object.entries(TOPICS)) {
    const result = validateJurisdictionComparison({
      topicSlug,
      text: `Cyprus and ${{ "jurisdiction-dubai": "Dubai", "jurisdiction-estonia": "Estonia", "jurisdiction-malta-bulgaria": "Malta and Bulgaria", "jurisdiction-usa": "the USA" }[topicSlug]} have different considerations. ${DISCOVERY_QUESTION.en}`,
      evidence: evidence(topicSlug, fact),
    });
    assert.deepEqual(result, { ok: true, issues: [] }, topicSlug);
  }
});

test("MB-J0 posture and MB-J1..J4 content may come from separate approved chunks", () => {
  const topicSlug = "jurisdiction-dubai";
  const evidenceChunks = [
    evidence(topicSlug, "MB-J0")[0],
    evidence(topicSlug, "MB-J1")[0],
  ];
  const result = validateJurisdictionComparison({
    topicSlug,
    text: `Cyprus and Dubai have different considerations. ${DISCOVERY_QUESTION.en}`,
    evidence: evidenceChunks,
  });
  assert.equal(result.ok, true);
});

test("the real P3.8 corpus grounds all four topics in all three languages", () => {
  const comparator = {
    "jurisdiction-dubai": "Dubai",
    "jurisdiction-estonia": "Estonia",
    "jurisdiction-malta-bulgaria": "Malta",
    "jurisdiction-usa": "United States",
  };
  for (const [topicSlug, { fact }] of Object.entries(TOPICS)) {
    for (const language of ["en", "ar", "el"]) {
      const file = path.join(__dirname, "..", "knowledge", topicSlug, `${language}.md`);
      const parsed = parseCorpusFile(fs.readFileSync(file, "utf8"));
      assert.equal(parsed.error, null, file);
      const evidenceChunks = parsed.sections
        .filter((section) => section.facts.includes("MB-J0") || section.facts.includes(fact))
        .map((section) => ({
          content: section.body,
          review_status: "approved",
          sourceRef: canonicalUrl(topicSlug, language),
          factIds: section.facts,
        }));
      const factSection = evidenceChunks.find((chunk) => chunk.factIds.includes(fact));
      assert.ok(evidenceChunks.some((chunk) => chunk.factIds.includes("MB-J0")), `${file} has no MB-J0 chunk`);
      assert.ok(factSection, `${file} has no ${fact} chunk`);
      const firstSupportedSentence = factSection.content.split(/(?<=[.!?؟])\s+/u)[0];
      const question = DISCOVERY_QUESTION[language];
      const result = validateJurisdictionComparison({
        topicSlug,
        language,
        text: `${firstSupportedSentence} ${question}`,
        evidence: evidenceChunks,
        factRegister: CURRENT_FACT_REGISTER,
      });
      assert.equal(result.ok, true, `${file}: ${JSON.stringify(result)}`);
    }
  }
});

test("unapproved, expired, unrelated, or incomplete evidence cannot ground a comparison", () => {
  const valid = evidence("jurisdiction-dubai", "MB-J1")[0];
  const cases = [
    { ...valid, review_status: "pending" },
    { ...valid, valid_until: new Date(Date.now() - 86_400_000).toISOString() },
    { ...valid, sourceRef: "refal://kb/comparison/jurisdiction-usa/en" },
    { ...valid, factIds: ["MB-J0"] },
    { ...valid, factIds: ["MB-J1"] },
  ];
  for (const item of cases) {
    const result = validateJurisdictionComparison({
      topicSlug: "jurisdiction-dubai",
      text: `Cyprus and Dubai have different considerations. ${DISCOVERY_QUESTION.en}`,
      evidence: [item],
    });
    assert.equal(result.ok, false);
    assert.ok(result.issues.includes("missing_approved_topic_evidence"));
  }
});

test("live fact-register status must allow both MB-J0 and the topic fact", () => {
  const topicSlug = "jurisdiction-dubai";
  const valid = {
    topicSlug,
    text: `Cyprus and Dubai have different considerations. ${DISCOVERY_QUESTION.en}`,
    evidence: evidence(topicSlug, "MB-J1"),
  };
  assert.equal(validateJurisdictionComparison({ ...valid, factRegister: seedRegister() }).ok, true);

  for (const rowOverride of [
    { id: "MB-J0", status: "pending" },
    { id: "MB-J1", status: "pending" },
    { id: "MB-J0", expiryOrReviewAt: "2020-01-01" },
    { id: "MB-J1", expiryOrReviewAt: "2020-01-01" },
  ]) {
    const register = applyOverrides(seedRegister(), [rowOverride]);
    const result = validateJurisdictionComparison({ ...valid, factRegister: register });
    assert.equal(result.ok, false, JSON.stringify(rowOverride));
    assert.ok(result.issues.includes("facts_not_statable"), JSON.stringify(rowOverride));
  }

  const missing = validateWithRegister(valid);
  assert.ok(missing.issues.includes("missing_fact_register"));
});

test("an invented jurisdictional number is rejected even when relevant facts are approved", () => {
  const result = validateJurisdictionComparison({
    topicSlug: "jurisdiction-dubai",
    text: `Cyprus has 0% tax compared with Dubai. ${DISCOVERY_QUESTION.en}`,
    evidence: evidence("jurisdiction-dubai", "MB-J1"),
  });
  assert.equal(result.ok, false);
  assert.ok(result.issues.includes("unsupported_jurisdictional_claim"));
});

test("an unsupported predicate is rejected even when its jurisdiction entity appears in evidence", () => {
  const result = validateJurisdictionComparison({
    topicSlug: "jurisdiction-dubai",
    text: `Dubai has a coastline. ${DISCOVERY_QUESTION.en}`,
    evidence: evidence("jurisdiction-dubai", "MB-J1"),
  });
  assert.equal(result.ok, false);
  assert.ok(result.issues.includes("unsupported_jurisdictional_claim"));
});

test("disparagement is rejected for any jurisdiction in English, Arabic, and Greek", () => {
  const examples = [
    "Dubai is backward.",
    "Estonia is corrupt.",
    "Malta is useless.",
    "Bulgaria is فوضوي.",
    "Η Αμερική είναι απαίσια.",
    "Bulgaria suffers from serious banking constraints.",
    "Cyprus is always the best.",
    "قبرص دائماً الأفضل.",
    "Η Κύπρος είναι πάντα η καλύτερη επιλογή.",
  ];
  for (const draft of examples) {
    const result = validateJurisdictionComparison({
      topicSlug: "jurisdiction-dubai",
      text: `${draft} ${DISCOVERY_QUESTION.en}`,
      // Even approved text cannot authorize an attack or an always-best claim.
      evidence: evidence("jurisdiction-dubai", "MB-J1", {
        content: `MB-J0 MB-J1 ${draft}`,
      }),
    });
    assert.equal(result.ok, false, draft);
    assert.ok(result.issues.includes("disparages_jurisdiction"), draft);
  }
});

test("every supported language must end with the approved clients, bank, and family question", () => {
  const topicSlug = "jurisdiction-estonia";
  const grounded = evidence(topicSlug, "MB-J2");
  for (const [language, question] of Object.entries(DISCOVERY_QUESTION)) {
    assert.equal(validateJurisdictionComparison({ topicSlug, text: `Cyprus and Estonia have different considerations. ${question}`, evidence: grounded, language }).ok, true);
  }
  const missing = validateJurisdictionComparison({
    topicSlug,
    text: "Cyprus and Estonia have different considerations. What matters most to you?",
    evidence: grounded,
    language: "en",
  });
  assert.ok(missing.issues.includes("missing_approved_discovery_question"));
  const notFinal = validateJurisdictionComparison({
    topicSlug,
    text: `${DISCOVERY_QUESTION.en} I can explain more if useful.`,
    evidence: grounded,
    language: "en",
  });
  assert.ok(notFinal.issues.includes("missing_approved_discovery_question"));
});

test("the closing discovery question must match the requested response language", () => {
  for (const foreignLanguage of ["ar", "el"]) {
    const result = validateJurisdictionComparison({
      topicSlug: "jurisdiction-dubai",
      text: `Cyprus and Dubai have different considerations. ${DISCOVERY_QUESTION[foreignLanguage]}`,
      evidence: evidence("jurisdiction-dubai", "MB-J1"),
      language: "en",
    });
    assert.equal(result.ok, false);
    assert.ok(result.issues.includes("missing_approved_discovery_question"));
  }
});
