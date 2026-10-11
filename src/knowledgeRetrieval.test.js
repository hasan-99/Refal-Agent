const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  DEFAULTS, contentTerms, questionParts, anchorQueries, supportCoverage,
  boundSection, fuseCandidates, retrieveKnowledge, isEvidenceKind
} = require("./knowledgeRetrieval");

// A fake corpus shaped like the real one: a document is a topic, a chunk is a
// `##` section, and every document carries a `boundary` section holding the
// conditions. That shape is the point of most of these tests.
function makeStore({ rowsByQuery = {}, sections = [], onSearch, failSearch = false } = {}) {
  const calls = [];
  return {
    calls,
    searchKnowledgeDetailed: async (query, options) => {
      calls.push({ query, options });
      if (onSearch) onSearch(query);
      if (failSearch) throw new Error("edge function unreachable");
      return rowsByQuery[query] || rowsByQuery["*"] || [];
    },
    fetchKnowledgeSections: async (chunkIds, options) => {
      calls.push({ sectionsFor: chunkIds, options });
      const documents = new Set(sections.filter((s) => chunkIds.includes(s.chunk_id)).map((s) => s.document_id));
      return sections
        .filter((s) => documents.has(s.document_id))
        .map((s) => ({ ...s, is_match: chunkIds.includes(s.chunk_id) }));
    }
  };
}

const PACKAGE_MATCH = {
  chunk_id: "c-pkg", document_id: "d-1", chunk_index: 1, chunk_kind: "fact",
  document_title: "Cyprus company formation", source_name: "Refalco",
  heading: "What the package covers", content: "The package covers company name reservation and incorporation."
};

const PACKAGE_SECTIONS = [
  { chunk_id: "c-pkg", document_id: "d-1", chunk_index: 1, chunk_kind: "fact", document_title: "Cyprus company formation", source_name: "Refalco", heading: "What the package covers", content: "The package covers company name reservation and incorporation.", priority: 1 },
  { chunk_id: "c-bound", document_id: "d-1", chunk_index: 2, chunk_kind: "boundary", document_title: "Cyprus company formation", source_name: "Refalco", heading: "Limits and conditions", content: "This excludes bank account opening, which is quoted separately.", priority: 2 },
  { chunk_id: "c-extra", document_id: "d-1", chunk_index: 3, chunk_kind: "example", document_title: "Cyprus company formation", source_name: "Refalco", heading: "Example", content: "A typical holding structure.", priority: 3 }
];

test("term extraction drops stopwords in all three corpus languages", () => {
  assert.deepEqual(contentTerms("What is included in the package?"), ["included", "package"]);
  // 'شو' and 'في' are stopwords; the topical words survive.
  const arabic = contentTerms("شو بتشمل باقة تأسيس الشركة في قبرص؟");
  assert.ok(arabic.includes("باقة") && arabic.includes("قبرص"));
  assert.ok(!arabic.includes("شو") && !arabic.includes("في"));
  const greek = contentTerms("Τι περιλαμβάνει το πακέτο;");
  assert.ok(greek.includes("πακέτο"));
  assert.ok(!greek.includes("το"));
});

test("a two-part question is split into the parts that each need an answer", () => {
  const parts = questionParts("What does it include and how long does it take?");
  assert.equal(parts.length, 2);
  assert.ok(/include/u.test(parts[0]));
  assert.ok(/how long/u.test(parts[1]));
});

test("a colloquial Arabic question produces English and Greek anchor terms for the lexical arm", () => {
  const anchors = anchorQueries("شو بتشمل باقة تأسيس الشركة؟");
  assert.ok(anchors.some((term) => /company formation/iu.test(term)), "has an English anchor");
  assert.ok(anchors.some((term) => /σύσταση/u.test(term)), "has a Greek anchor");
});

test("an oversized section is read in bounded parts that keep the END, where the conditions live", () => {
  const section = `${"CLAIM ".repeat(400)}IMPORTANT EXCEPTION AT THE END`;
  const bounded = boundSection(section, 600);
  assert.equal(bounded.truncated, true);
  assert.ok(bounded.content.length <= 600);
  assert.ok(bounded.content.includes("CLAIM"), "keeps the claim");
  assert.ok(bounded.content.includes("IMPORTANT EXCEPTION AT THE END"), "keeps the conditions");
  assert.ok(bounded.content.includes("[...]"), "states that text was elided");
});

test("a section inside the budget is never altered", () => {
  const bounded = boundSection("short section", 600);
  assert.equal(bounded.truncated, false);
  assert.equal(bounded.content, "short section");
});

test("fusion ranks a chunk that two different wordings both found above one a single wording ranked first", () => {
  const fused = fuseCandidates([
    [{ chunk_id: "a" }, { chunk_id: "shared" }],
    [{ chunk_id: "b" }, { chunk_id: "shared" }]
  ]);
  assert.equal(fused[0].chunk_id, "shared");
  assert.equal(fused[0].queryHits, 2);
});

test("only answer-bearing section kinds become customer evidence", () => {
  assert.equal(isEvidenceKind("fact"), true);
  assert.equal(isEvidenceKind("boundary"), true, "conditions are evidence");
  assert.equal(isEvidenceKind("example"), true);
  assert.equal(isEvidenceKind("discovery"), false, "questions to ask are not an answer");
  assert.equal(isEvidenceKind("aliases"), false, "a finding aid is navigation");
});

test("the conditions section is retrieved even though the question only matched the claim", async () => {
  const store = makeStore({ rowsByQuery: { "*": [PACKAGE_MATCH] }, sections: PACKAGE_SECTIONS });
  const result = await retrieveKnowledge("What does the Cyprus package cover?", {
    store, planQueries: () => ["What does the Cyprus package cover?"]
  });

  const ids = result.evidence.map((section) => section.chunkId);
  assert.ok(ids.includes("c-pkg"), "the matched claim");
  assert.ok(ids.includes("c-bound"), "the boundary section that never matched the query");
  const bound = result.evidence.find((section) => section.chunkId === "c-bound");
  assert.match(bound.content, /excludes bank account opening/u);
});

test("sections come back in original document order, not in relevance order", async () => {
  const store = makeStore({ rowsByQuery: { "*": [PACKAGE_MATCH] }, sections: PACKAGE_SECTIONS });
  const result = await retrieveKnowledge("package", { store, planQueries: () => ["package"] });
  const indexes = result.evidence.map((section) => section.chunkIndex);
  assert.deepEqual(indexes, [...indexes].sort((a, b) => a - b));
});

test("a second round fires with DIFFERENT wording when the first round leaves the question unsupported", async () => {
  const asked = [];
  const store = makeStore({
    rowsByQuery: {
      "original wording": [],
      "*": [PACKAGE_MATCH]
    },
    sections: PACKAGE_SECTIONS,
    onSearch: (query) => asked.push(query)
  });

  const result = await retrieveKnowledge("original wording", {
    store,
    planQueries: (round) => (round === 1 ? ["original wording"] : round === 2 ? ["retry wording"] : [])
  });

  assert.deepEqual(asked, ["original wording", "retry wording"]);
  assert.ok(result.evidence.length > 0, "the retry found what the first wording missed");
  assert.equal(result.trace.rounds.length, 2);
});

test("no further round runs once coverage is satisfied", async () => {
  const asked = [];
  const store = makeStore({
    rowsByQuery: { "*": [PACKAGE_MATCH] },
    sections: PACKAGE_SECTIONS,
    onSearch: (query) => asked.push(query)
  });
  const result = await retrieveKnowledge("package covers incorporation", {
    store,
    planQueries: (round) => (round === 1 ? ["package covers incorporation"] : ["should not be asked"])
  });
  assert.equal(result.status, "found");
  assert.deepEqual(asked, ["package covers incorporation"]);
});

test("the round budget is configurable and honoured", async () => {
  const asked = [];
  const store = makeStore({ rowsByQuery: { "*": [] }, onSearch: (query) => asked.push(query) });
  await retrieveKnowledge("nothing matches this", {
    store,
    limits: { maxRounds: 2 },
    planQueries: (round) => [`round-${round}`]
  });
  assert.deepEqual(asked, ["round-1", "round-2"]);
});

test("a total search failure is search_failed, never no_evidence", async () => {
  const store = makeStore({ failSearch: true });
  const result = await retrieveKnowledge("anything", { store, planQueries: () => ["anything"] });
  assert.equal(result.status, "search_failed");
  assert.equal(result.searchFailed, true);
  assert.ok(result.trace.errors.some((entry) => entry.stage === "search"));
});

test("a search that ran correctly and found nothing is no_evidence, not a failure", async () => {
  const store = makeStore({ rowsByQuery: { "*": [] } });
  const result = await retrieveKnowledge("anything", { store, planQueries: () => ["anything"] });
  assert.equal(result.status, "no_evidence");
  assert.equal(result.searchFailed, false);
  assert.equal(result.trace.errors.length, 0);
});

test("partial support is reported as partial so the supported parts can still be answered", async () => {
  const store = makeStore({ rowsByQuery: { "*": [PACKAGE_MATCH] }, sections: [PACKAGE_SECTIONS[0]] });
  const result = await retrieveKnowledge("What does the package cover and what is the refund policy for cancelled registrations?", {
    store, limits: { maxRounds: 1 }, planQueries: () => ["q"]
  });
  assert.equal(result.status, "partial");
  assert.ok(result.evidence.length > 0, "the supported part still has evidence");
  assert.ok(result.coverage.unsupported.length > 0, "the unsupported part is named");
});

test("the context budget is never exceeded, and the match is kept when it has to choose", async () => {
  const big = (id, index) => ({
    chunk_id: id, document_id: "d-1", chunk_index: index, chunk_kind: index === 1 ? "fact" : "example",
    document_title: "T", source_name: "S", heading: `H${index}`, content: "x".repeat(5000), priority: index
  });
  const sections = [big("c-1", 1), big("c-2", 2), big("c-3", 3), big("c-4", 4)];
  const store = makeStore({ rowsByQuery: { "*": [{ ...sections[0] }] }, sections });
  const result = await retrieveKnowledge("question", {
    store, limits: { maxContextChars: 6000, maxSectionChars: 5000, maxRounds: 1 }, planQueries: () => ["question"]
  });
  const total = result.evidence.reduce((sum, section) => sum + section.content.length, 0);
  assert.ok(total <= 6000, `context budget respected (${total})`);
  assert.ok(result.evidence.some((section) => section.chunkId === "c-1"), "the matched section survives the budget");
});

test("the trace records the queries, rounds, section ids, coverage and errors for an administrator", async () => {
  const store = makeStore({ rowsByQuery: { "*": [PACKAGE_MATCH] }, sections: PACKAGE_SECTIONS });
  const result = await retrieveKnowledge("What does the Cyprus package cover?", {
    store, language: "english", planQueries: () => ["What does the Cyprus package cover?"]
  });
  const trace = result.trace;
  assert.equal(trace.language, "english");
  assert.ok(trace.rounds[0].queries[0].query.length > 0, "the query text is traced");
  assert.equal(typeof trace.rounds[0].queries[0].returned, "number");
  assert.ok(trace.chunkIds.includes("c-bound"), "section ids handed to the answer model are traced");
  assert.ok(trace.documentIds.includes("d-1"));
  assert.equal(typeof trace.coverage, "number");
  assert.equal(trace.status, result.status);
  assert.ok(Array.isArray(trace.errors));
  assert.equal(typeof trace.totalMs, "number");
});

test("the trace carries no raw customer identifiers beyond the redacted question", async () => {
  const store = makeStore({ rowsByQuery: { "*": [] } });
  const result = await retrieveKnowledge("my email is person@example.com and my phone is +35799123456", {
    store, planQueries: () => ["q"]
  });
  assert.ok(!result.trace.question.includes("person@example.com"));
  assert.ok(!result.trace.question.includes("+35799123456"));
});

test("the recall knobs are forwarded to the store so the SQL admission floor is configurable", async () => {
  const store = makeStore({ rowsByQuery: { "*": [] } });
  await retrieveKnowledge("q", {
    store, limits: { minCoverage: 0.1, minTerms: 2, maxDistance: 0.9, maxRounds: 1 }, planQueries: () => ["q"]
  });
  const search = store.calls.find((call) => call.query === "q");
  assert.equal(search.options.minCoverage, 0.1);
  assert.equal(search.options.minTerms, 2);
  assert.equal(search.options.maxDistance, 0.9);
});

test("retrieval degrades to the ranked chunks when the section RPC is unavailable", async () => {
  const store = {
    searchKnowledge: async () => [PACKAGE_MATCH]
  };
  const result = await retrieveKnowledge("package", { store, planQueries: () => ["package"], limits: { maxRounds: 1 } });
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].chunkId, "c-pkg");
  assert.notEqual(result.status, "search_failed");
});

test("a failing section fetch is traced and does not lose the turn", async () => {
  const store = {
    searchKnowledge: async () => [PACKAGE_MATCH],
    fetchKnowledgeSections: async () => { throw new Error("sections rpc down"); }
  };
  const result = await retrieveKnowledge("package", { store, planQueries: () => ["package"], limits: { maxRounds: 1 } });
  assert.ok(result.evidence.length > 0, "falls back to the ranked chunks");
  assert.ok(result.trace.errors.some((entry) => entry.stage === "sections"));
});

test("the documented defaults are the ones actually applied", async () => {
  const store = makeStore({ rowsByQuery: { "*": [] } });
  await retrieveKnowledge("q", { store, planQueries: () => ["q"], limits: { maxRounds: 1 } });
  const search = store.calls.find((call) => call.query === "q");
  assert.equal(search.options.minCoverage, DEFAULTS.minCoverage);
  assert.equal(search.options.maxDistance, DEFAULTS.maxDistance);
  assert.equal(search.options.matchCount, DEFAULTS.matchCount);
});

test("a cross-reference is followed through the section's `supporting` fact ids, not guessed", () => {
  const { crossReferenceQueries } = require("./knowledgeQuery");
  // MB-F2 is owned by the formation-package topic; a section that merely cites
  // it carries the id in metadata.supporting.
  const queries = crossReferenceQueries([{ metadata: { supporting: ["MB-F2"] } }]);
  assert.equal(queries.length, 1);
  assert.match(queries[0], /formation package/iu, "the referenced fact's own wording becomes the follow-up query");

  // No reference, no extra search.
  assert.equal(crossReferenceQueries([{ metadata: { facts: ["MB-F1"] } }]).length, 0);
  assert.equal(crossReferenceQueries([{}]).length, 0);
  // An unknown id is ignored rather than becoming a junk query.
  assert.equal(crossReferenceQueries([{ metadata: { supporting: ["NOT-A-FACT"] } }]).length, 0);
});

test("two approved sections that disagree on a figure are reported as a conflict", () => {
  const { detectConflicts } = require("./knowledgeRetrieval");
  const conflicts = detectConflicts([
    { documentId: "d-1", chunkId: "c-1", title: "Package A", content: "The package costs €999 in total." },
    { documentId: "d-2", chunkId: "c-2", title: "Package B", content: "The package costs EUR 1500 in total." }
  ]);
  const money = conflicts.find((entry) => entry.kind === "money");
  assert.ok(money, "the disagreement is reported");
  assert.deepEqual(money.values.map((item) => item.value).sort(), ["1500", "999"]);
});

test("the same figure repeated across sections is agreement, not a conflict", () => {
  const { detectConflicts } = require("./knowledgeRetrieval");
  const conflicts = detectConflicts([
    { documentId: "d-1", chunkId: "c-1", title: "A", content: "The package costs €999." },
    { documentId: "d-2", chunkId: "c-2", title: "B", content: "It remains €999 for the standard case." }
  ]);
  assert.equal(conflicts.length, 0);
});

test("two figures inside a SINGLE document are not a cross-source conflict", () => {
  const { detectConflicts } = require("./knowledgeRetrieval");
  const conflicts = detectConflicts([
    { documentId: "d-1", chunkId: "c-1", title: "A", content: "Formation is €999 and the optional add-on is €250." }
  ]);
  assert.equal(conflicts.length, 0, "a price list is not a contradiction");
});

test("conflicting durations across documents are reported", () => {
  const { detectConflicts } = require("./knowledgeRetrieval");
  const conflicts = detectConflicts([
    { documentId: "d-1", chunkId: "c-1", title: "A", content: "It takes 10 days." },
    { documentId: "d-2", chunkId: "c-2", title: "B", content: "It takes 21 days." }
  ]);
  assert.ok(conflicts.some((entry) => entry.kind === "duration"));
});

test("the conflict flag reaches the trace", async () => {
  const store = makeStore({
    rowsByQuery: { "*": [
      { ...PACKAGE_MATCH, chunk_id: "x1", document_id: "dx1", content: "The package costs €999." },
      { ...PACKAGE_MATCH, chunk_id: "x2", document_id: "dx2", content: "The package costs €1500." }
    ] }
  });
  const result = await retrieveKnowledge("price", { store, planQueries: () => ["price"], limits: { maxRounds: 1 } });
  assert.equal(result.trace.hasConflict, true);
  assert.ok(result.trace.conflicts.length > 0);
});

test("a failed search and an empty corpus produce DIFFERENT customer replies", () => {
  const { noApprovedEvidenceReply, knowledgeSearchUnavailableReply } = require("./refalcoAnswer");
  for (const language of ["english", "arabic", "greek"]) {
    const missing = noApprovedEvidenceReply(language);
    const broken = knowledgeSearchUnavailableReply(language);
    assert.notEqual(missing, broken, `${language}: a technical failure must not claim the corpus is empty`);
    assert.ok(broken.length > 0);
  }
  // The English failure reply must not assert anything about what REFAL knows.
  assert.doesNotMatch(knowledgeSearchUnavailableReply("english"), /don['’]t have approved information/iu);
});

test("a turn that failed technically is not mined as the prior topic for the next question", () => {
  const { buildKnowledgeSearchQuery } = require("./knowledgeQuery");
  const { knowledgeSearchUnavailableReply } = require("./refalcoAnswer");
  const user = {
    history: [{ message: "Tell me about company formation", response: knowledgeSearchUnavailableReply("english") }]
  };
  // "how much does it cost" is context-dependent, so it WOULD pull in a prior
  // topic if that turn had carried one. A failed turn carries none.
  const query = buildKnowledgeSearchQuery("how much does it cost?", user, ["pricing"]);
  assert.doesNotMatch(query, /knowledge base/iu);
  assert.equal(query, "how much does it cost?");
});

test("supportCoverage names the specific part of a multi-part question that has no support", () => {
  const coverage = supportCoverage(
    "What does the package include and what is the cancellation refund?",
    [{ heading: "Package", content: "The package includes incorporation and name reservation." }]
  );
  assert.ok(coverage.unsupported.length >= 1);
  assert.ok(/cancellation|refund/iu.test(coverage.unsupported[0].part));
});
