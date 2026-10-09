"use strict";

// M3 / W3.10.1-W3.10.4 — the ingestion gate.
//
// This suite is table driven over the REAL 87 files on disk, not over a
// fixture. The whole reason corpusIngest.js is pure is so that the payload
// which would be posted to Supabase can be built and checked here, offline, on
// a machine with no database access at all. A constraint caught in this file is
// a constraint that never fails halfway through a write.
//
// Every assertion below corresponds to something the database would actually
// reject, or to a decision W3.10 made on purpose:
//
//   chunks.content          length between 1 and 12000       (check constraint)
//   (document_id,chunk_index) unique                          (unique index)
//   content_sha256          ~ '^[0-9a-f]{64}$'                (check constraint)
//   p_chunks                array of 1 to 500                 (RPC guard)
//   canonical_url           unique, and our own URI scheme    (unique + W0.4.2)
//   sources.source_kind     the SOURCES enum, not the taxonomy's trust tiers
//   chunks.metadata.facts   what factRegister#chunkFactIds reads at query time

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const {
  CONTRACT_VERSION, SOURCE_KIND, SOURCE_TRUST_TIER, ALIAS_CHUNK_KIND,
  MAX_CHUNKS, MAX_CHUNK_CHARS, MAX_DISPLAY_NAME_CHARS,
  PRICE_EXPIRY_PATTERN, PRICE_EXPIRY_DAYS, triggersPriceExpiry,
  contentSha256, buildChunks, buildSourceRow, buildDocumentPayload,
  assertPayload, planFile, planCorpus, sectionFactIds,
} = require("./corpusIngest");

const { validateCorpusFile, SECTION_KINDS } = require("./corpusFile");
const { TOPICS, LANGUAGES, CANONICAL_URL_PATTERN, canonicalUrl } = require("./brainTaxonomy");
const { seedRegister, chunkFactIds, STATUS } = require("./factRegister");

const REPO = path.join(__dirname, "..");
const CORPUS = path.join(REPO, "knowledge");

// The one place this suite touches the disk. corpusIngest.js itself never does.
function readCorpusFile(relative) {
  const abs = path.join(REPO, relative);
  return fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
}

// Frozen so that a date-sensitive register row cannot make this suite flap. It
// sits after the seed's verifiedAt (2026-10-07) and inside every cadence.
const NOW = "2026-10-09";
const REGISTER = seedRegister();

const PLAN = planCorpus({
  root: "knowledge",
  register: REGISTER,
  now: NOW,
  readFile: readCorpusFile,
  join: (...parts) => parts.join("/"),
});

const CASES = [];
for (const topic of TOPICS) {
  for (const lang of LANGUAGES) {
    CASES.push({ topic, lang, relative: `knowledge/${topic.slug}/${lang}.md` });
  }
}

// --------------------------------------------------------------- the corpus

test("the corpus on disk is complete and every file plans cleanly", () => {
  assert.equal(PLAN.summary.expected, TOPICS.length * LANGUAGES.length);
  assert.equal(PLAN.summary.expected, 87);
  assert.equal(PLAN.summary.missing, 0, "an expected topic/language file is missing from knowledge/");
  assert.deepEqual(
    PLAN.files.filter((f) => !f.ok).map((f) => f.errors).flat(),
    [],
    "a corpus file would be rejected by the database or by the authoring gate",
  );
  assert.equal(PLAN.ok, true);
});

test("a complete corpus plans one source and one document per topic/language", () => {
  assert.equal(PLAN.summary.sources, 87);
  assert.equal(PLAN.summary.documents, 87);
  assert.equal(PLAN.summary.aliasChunks, 87, "exactly one finding-aid chunk per document");
  assert.equal(PLAN.summary.chunks, PLAN.summary.aliasChunks + PLAN.summary.sectionChunks);
});

test("every planned canonical_url is unique, which is the only idempotency key", () => {
  const urls = PLAN.files.map((f) => f.source.canonical_url);
  assert.equal(new Set(urls).size, urls.length, "two files would collide on canonical_url");
});

// ------------------------------------------------- table driven, all 87 files

for (const { topic, lang, relative } of CASES) {
  test(`${topic.slug}/${lang}: the planned payload satisfies every database constraint`, () => {
    const text = readCorpusFile(relative);
    assert.ok(text, `${relative} is missing`);

    const plan = planFile({ text, topicSlug: topic.slug, lang, path: relative, register: REGISTER, now: NOW });
    assert.deepEqual(plan.errors, []);
    assert.equal(plan.ok, true);
    assert.equal(plan.skipped, false);

    // ---- source row
    const source = plan.source;
    assert.equal(source.canonical_url, canonicalUrl(topic.slug, lang));
    assert.match(source.canonical_url, CANONICAL_URL_PATTERN);
    assert.equal(source.source_kind, SOURCE_KIND);
    assert.equal(source.trust_tier, SOURCE_TRUST_TIER);
    assert.equal(source.enabled, true);
    assert.equal(source.approved, true);
    assert.ok(source.display_name.length >= 1 && source.display_name.length <= MAX_DISPLAY_NAME_CHARS);
    // The taxonomy tier is a DIFFERENT vocabulary and lives in metadata, never
    // in trust_tier, whose check constraint would reject it outright.
    assert.equal(source.metadata.brainTrustTier, topic.tier);
    assert.equal(source.metadata.volatility, topic.volatility);
    assert.equal(source.metadata.topicNumber, topic.n);
    assert.equal(source.metadata.domain, topic.domain);
    assert.equal(source.metadata.lang, lang);

    // ---- document payload
    const document = plan.document;
    const validated = validateCorpusFile(text, { topicSlug: topic.slug, lang, path: relative });
    assert.equal(document.p_content, validated.body, "canonical content must be validateCorpusFile().body verbatim");
    assert.equal(document.p_content_sha256, contentSha256(validated.body));
    assert.match(document.p_content_sha256, /^[0-9a-f]{64}$/u);
    assert.equal(document.p_language_code, lang);
    assert.equal(document.p_title, validated.parsed.meta.title);
    // The RPC writes display_name = left(trim(title),160) and compares
    // old title = left(trim(p_title),500). A title that needs truncating would
    // make `unchanged` impossible and the source name wrong.
    assert.equal(document.p_title.trim(), document.p_title.trim().slice(0, 500));
    assert.ok(document.p_title.trim().length <= MAX_DISPLAY_NAME_CHARS);
    assert.equal(document.p_metadata.contractVersion, CONTRACT_VERSION);
    assert.equal(document.p_metadata.canonicalUrl, source.canonical_url);
    assert.deepEqual(document.p_metadata.facts, validated.parsed.meta.facts);
    assert.deepEqual(document.p_metadata.supporting, validated.parsed.meta.supporting);
    assert.deepEqual(document.p_metadata.aliases, validated.parsed.meta.aliases);

    // ---- chunks
    const chunks = plan.chunks;
    assert.ok(chunks.length >= 1 && chunks.length <= MAX_CHUNKS);
    assert.equal(chunks.length, validated.parsed.sections.length + 1, "one chunk per ## section, plus the alias chunk");
    chunks.forEach((chunk, index) => {
      assert.equal(chunk.chunk_index, index, "chunk_index must be 0-based and contiguous");
      assert.equal(typeof chunk.heading, "string");
      assert.ok(chunk.content.length >= 1 && chunk.content.length <= MAX_CHUNK_CHARS,
        `chunk ${index} is ${chunk.content.length} chars`);
      assert.equal(chunk.metadata.topic, topic.slug);
      assert.equal(chunk.metadata.lang, lang);
      assert.equal(chunk.metadata.topicNumber, topic.n);
      assert.equal(chunk.metadata.domain, topic.domain);
      assert.ok(Array.isArray(chunk.metadata.facts));
      assert.ok(Array.isArray(chunk.metadata.supporting));
    });

    // ---- chunk 0 is the finding aid: a table of contents, not a keyword list
    const alias = chunks[0];
    assert.equal(alias.metadata.kind, ALIAS_CHUNK_KIND);
    assert.equal(alias.heading, validated.parsed.meta.title);
    assert.equal(alias.metadata.sectionIndex, null);
    assert.deepEqual(alias.metadata.facts, validated.parsed.meta.facts);

    // 'simple' does no stemming, so every anchor has to be LITERALLY present in
    // heading||content or it is not findable. metadata would be a no-op.
    assert.ok(alias.content.startsWith(validated.parsed.meta.title));
    for (const phrase of validated.parsed.meta.aliases) {
      assert.ok(alias.content.includes(phrase), `alias "${phrase}" is not in the finding-aid chunk`);
    }
    for (const section of validated.parsed.sections) {
      assert.ok(alias.content.includes(section.heading), `heading "${section.heading}" is not in the finding-aid chunk`);
    }
    // Exactly title + headings in document order + aliases, and nothing else.
    // Asserted as equality rather than as inclusions, because the thing being
    // ruled out is extra content sneaking in.
    assert.equal(
      alias.content,
      [validated.parsed.meta.title, ...validated.parsed.sections.map((s) => s.heading), ...validated.parsed.meta.aliases].join("\n"),
    );

    // ---- the real sections start at 1 and carry their governed facts
    const meta = validated.parsed.meta;
    validated.parsed.sections.forEach((section, index) => {
      const chunk = chunks[index + 1];
      assert.equal(chunk.heading, section.heading);
      assert.equal(chunk.content, section.body, "chunk content is the section body, directive already stripped");
      assert.ok(SECTION_KINDS.includes(chunk.metadata.kind));
      assert.equal(chunk.metadata.sectionIndex, index);

      const { facts, inherited } = sectionFactIds(section, meta);
      assert.equal(chunk.metadata.inheritedFacts, inherited);
      assert.deepEqual(chunk.metadata.facts, facts);

      if (section.facts.length) {
        // Authored: exactly what the directive declares, nothing added.
        assert.equal(inherited, false);
        assert.deepEqual(chunk.metadata.facts, section.facts);
      } else {
        // Inherited: the DOCUMENT's own facts, so a blocked topic takes its
        // factless sections down with it instead of leaving orphan chunks.
        assert.equal(inherited, true);
        assert.deepEqual(chunk.metadata.facts, meta.facts);
        // A citation is never inherited: a blocked supporting fact must not
        // take down a document that merely mentions it.
        assert.deepEqual(chunk.metadata.supporting, []);
        for (const id of meta.supporting) {
          assert.ok(!chunk.metadata.facts.includes(id), `supporting fact ${id} was inherited into "${chunk.heading}"`);
        }
      }

      // The query-time blocked filter reads metadata.facts through this
      // function; if it cannot see the ids, decision 7's second layer is dead.
      assert.deepEqual(chunkFactIds(chunk), facts);
      assert.ok(chunkFactIds(chunk).length > 0, "every chunk must be reachable by the blocked-fact filter");
    });

    // The whole point of inheritance: no chunk is ungoverned.
    for (const chunk of chunks) {
      assert.ok(chunkFactIds(chunk).length > 0, `chunk ${chunk.chunk_index} carries no fact and could never be blocked`);
    }

    // No section BODY text. Copying body sentences would duplicate content into
    // a second chunk and could lift a figure out of the sentence qualifying it.
    for (const section of validated.parsed.sections) {
      const sentence = section.body.split(/\n+/u).find((line) => line.trim().length > 40);
      if (sentence) assert.ok(!alias.content.includes(sentence.trim()), `body text from "${section.heading}" leaked into the finding-aid chunk`);
    }

    // ---- the fact ids never leak into indexed text
    const indexed = chunks.map((c) => `${c.heading}\n${c.content}`).join("\n");
    assert.ok(!/<!--/u.test(indexed), "a directive comment reached the chunk text");
    for (const id of [...validated.parsed.meta.facts, ...validated.parsed.meta.supporting]) {
      assert.ok(!indexed.includes(id), `fact id ${id} is in the embedded text`);
    }
  });
}

// ------------------------------------------------------------- idempotency

test("planning the same file twice produces the identical hash", () => {
  const relative = "knowledge/company-lifecycle/en.md";
  const text = readCorpusFile(relative);
  const a = planFile({ text, topicSlug: "company-lifecycle", lang: "en", path: relative, register: REGISTER, now: NOW });
  const b = planFile({ text, topicSlug: "company-lifecycle", lang: "en", path: relative, register: REGISTER, now: NOW });
  assert.equal(a.document.p_content_sha256, b.document.p_content_sha256);
  assert.equal(a.document.p_content, b.document.p_content);
  // If the content were normalised after hashing, the RPC's `unchanged` check
  // (old hash = new hash AND old title = left(trim(title),500)) could never
  // fire, and every run would rewrite all 87 documents.
  assert.equal(contentSha256(a.document.p_content), a.document.p_content_sha256);
});

// ------------------------------------------------- the 30 day price expiry

test("the price-expiry prediction mirrors the database trigger's regex", () => {
  // Positive forms the Postgres regex matches.
  for (const content of [
    "The minimum is €300,000, plus VAT.",
    "A fee of EUR 999 applies.",
    "It costs 300,000 EUR in total.",
    "Roughly 50 euros a month.",
    "Το ποσό είναι 300.000 ευρώ.",
    "الحد الأدنى ٣٠٠٬٠٠٠ يورو",
    "$1 200 for the filing",
  ]) {
    assert.equal(triggersPriceExpiry(content), true, `expected a price match in: ${content}`);
  }
  // Negative forms it does not. A bare count is prose, not a price.
  for (const content of [
    "The process takes about two weeks.",
    "There are four investment categories.",
    "A company needs at least one director and one secretary.",
    "",
  ]) {
    assert.equal(triggersPriceExpiry(content), false, `unexpected price match in: ${content}`);
  }
  assert.equal(PRICE_EXPIRY_DAYS, 30);
  assert.ok(PRICE_EXPIRY_PATTERN instanceof RegExp);
});

test("the plan names which documents the 30 day expiry will claim", () => {
  const expiring = PLAN.files.filter((f) => f.willAutoExpire);
  assert.ok(expiring.length > 0, "the corpus states prices, so some documents must be predicted to expire");
  assert.equal(PLAN.summary.willAutoExpire, expiring.length);

  // The programme's €300,000 threshold is the worked example from the brief.
  const pr = PLAN.files.find((f) => f.topic === "permanent-residency" && f.lang === "en");
  assert.equal(pr.willAutoExpire, true, "permanent-residency/en states €300,000 and must be flagged");

  // Every prediction has to be derivable from the content that is actually
  // sent, or the operator is being told about the wrong document.
  for (const file of PLAN.files) {
    assert.equal(file.willAutoExpire, triggersPriceExpiry(file.document.p_content));
  }
  assert.deepEqual(
    PLAN.summary.autoExpireTopics,
    [...new Set(expiring.map((f) => f.topic))].sort(),
  );
});

// ------------------------------------------- Rule 2 layer one: blocked facts

test("a section whose fact is blocked is not ingested at all", () => {
  const relative = "knowledge/permanent-residency/en.md";
  const text = readCorpusFile(relative);
  const clean = planFile({ text, topicSlug: "permanent-residency", lang: "en", path: relative, register: REGISTER, now: NOW });

  const blockedRegister = seedRegister();
  blockedRegister.set("MB-F30", { ...blockedRegister.get("MB-F30"), status: STATUS.BLOCKED });
  const filtered = planFile({ text, topicSlug: "permanent-residency", lang: "en", path: relative, register: blockedRegister, now: NOW });

  assert.equal(filtered.ok, true);
  assert.ok(filtered.skippedSections.length >= 1, "the blocked section was still ingested");
  assert.ok(filtered.chunks.length < clean.chunks.length);
  for (const skipped of filtered.skippedSections) assert.ok(skipped.facts.includes("MB-F30"));

  // The blocked text must be gone from the chunks AND from canonical_content.
  const skippedHeadings = filtered.skippedSections.map((s) => s.heading);
  for (const chunk of filtered.chunks) assert.ok(!skippedHeadings.includes(chunk.heading));
  for (const heading of skippedHeadings) assert.ok(!filtered.document.p_content.includes(heading));

  // Removing a section must not leave a hole in chunk_index: the column is
  // unique per document and the embeddings RPC matches rows on it.
  filtered.chunks.forEach((chunk, index) => assert.equal(chunk.chunk_index, index));
  assert.deepEqual(assertPayload(filtered), []);

  // Filtering genuinely changes the content, so the hash changes with it.
  assert.notEqual(filtered.document.p_content_sha256, clean.document.p_content_sha256);
  assert.equal(filtered.document.p_content_sha256, contentSha256(filtered.document.p_content));
});

test("a document with nothing left after filtering is skipped, not written empty", () => {
  // corporate-tax is used because every one of its sections declares a fact.
  const relative = "knowledge/corporate-tax/en.md";
  const text = readCorpusFile(relative);
  const parsed = validateCorpusFile(text, { topicSlug: "corporate-tax", lang: "en" }).parsed;
  assert.ok(parsed.sections.every((s) => s.facts.length > 0));

  const blockedRegister = seedRegister();
  const everyFact = new Set();
  for (const section of parsed.sections) for (const id of section.facts) everyFact.add(id);
  for (const id of everyFact) blockedRegister.set(id, { ...blockedRegister.get(id), status: STATUS.BLOCKED });

  const plan = planFile({ text, topicSlug: "corporate-tax", lang: "en", path: relative, register: blockedRegister, now: NOW });
  assert.equal(plan.skipped, true);
  assert.equal(plan.suppressed, true);
  assert.equal(plan.document, null);
  assert.equal(plan.chunks.length, 0);
  assert.match(plan.skipReason, /blocked/u);
});

// company-lifecycle/en is the fixture for inheritance: it owns MB-F1, supports
// MB-F2 and MB-F18, and has exactly one `kind: boundary` section with an empty
// directive. Guarded, because the corpus is authored by hand.
function companyLifecycleFixture() {
  const relative = "knowledge/company-lifecycle/en.md";
  const text = readCorpusFile(relative);
  const parsed = validateCorpusFile(text, { topicSlug: "company-lifecycle", lang: "en" }).parsed;
  const factless = parsed.sections.filter((s) => s.facts.length === 0);
  assert.ok(factless.length > 0, "fixture no longer has a factless section");
  assert.ok(parsed.meta.supporting.length > 0, "fixture no longer has supporting facts");
  return { relative, text, parsed, factless };
}

test("a section that declares no fact inherits the document's facts and IS blockable", () => {
  const { relative, text, parsed, factless } = companyLifecycleFixture();

  // Before blocking anything: the factless section is governed, not orphaned.
  const clean = planFile({ text, topicSlug: "company-lifecycle", lang: "en", path: relative, register: REGISTER, now: NOW });
  for (const heading of factless.map((s) => s.heading)) {
    const chunk = clean.chunks.find((c) => c.heading === heading);
    assert.equal(chunk.metadata.inheritedFacts, true);
    assert.deepEqual(chunk.metadata.facts, parsed.meta.facts);
    assert.ok(chunkFactIds(chunk).length > 0, "the factless section is still invisible to the blocked filter");
  }

  // Blocking the document's OWN fact must now reach it.
  const blockedRegister = seedRegister();
  for (const id of parsed.meta.facts) blockedRegister.set(id, { ...blockedRegister.get(id), status: STATUS.BLOCKED });
  const plan = planFile({ text, topicSlug: "company-lifecycle", lang: "en", path: relative, register: blockedRegister, now: NOW });

  const skippedHeadings = plan.skippedSections.map((s) => s.heading);
  for (const section of factless) {
    assert.ok(skippedHeadings.includes(section.heading), `factless section "${section.heading}" survived a blocked document fact`);
  }
  for (const chunk of plan.chunks) {
    assert.ok(!skippedHeadings.includes(chunk.heading));
    for (const id of chunkFactIds(chunk)) assert.ok(!parsed.meta.facts.includes(id));
  }
  // The inherited drop is marked as inherited, so a reader can tell it from an
  // authored governance link.
  assert.ok(plan.skippedSections.some((s) => s.inherited === true));
  assert.ok(plan.skippedSections.some((s) => s.inherited === false));

  // The finding aid carries the same blocked fact list, so it goes too, and
  // the surviving sections renumber contiguously from 0.
  assert.equal(plan.aliasChunkSkipped, true);
  assert.deepEqual(plan.blockedDocumentFacts, parsed.meta.facts);
  assert.ok(!plan.chunks.some((c) => c.metadata.kind === ALIAS_CHUNK_KIND));
  plan.chunks.forEach((chunk, index) => assert.equal(chunk.chunk_index, index));
  assert.deepEqual(assertPayload(plan), []);
});

test("blocking every fact a document owns or supports suppresses it entirely", () => {
  const { relative, text, parsed } = companyLifecycleFixture();
  const blockedRegister = seedRegister();
  for (const id of [...parsed.meta.facts, ...parsed.meta.supporting]) {
    blockedRegister.set(id, { ...blockedRegister.get(id), status: STATUS.BLOCKED });
  }
  const plan = planFile({ text, topicSlug: "company-lifecycle", lang: "en", path: relative, register: blockedRegister, now: NOW });

  assert.equal(plan.suppressed, true);
  assert.equal(plan.skipped, true);
  assert.equal(plan.document, null);
  assert.equal(plan.source, null);
  assert.equal(plan.chunks.length, 0, "a zero-chunk payload would be rejected by the RPC anyway (p_chunks length >= 1)");
  assert.match(plan.skipReason, /fully suppressed/u);
  assert.equal(plan.skippedSections.length, parsed.sections.length, "every section, factless ones included");
});

test("a blocked SUPPORTING fact does not get inherited and does not suppress the document", () => {
  const { relative, text, parsed, factless } = companyLifecycleFixture();
  const supporting = parsed.meta.supporting[0];

  const blockedRegister = seedRegister();
  blockedRegister.set(supporting, { ...blockedRegister.get(supporting), status: STATUS.BLOCKED });
  const plan = planFile({ text, topicSlug: "company-lifecycle", lang: "en", path: relative, register: blockedRegister, now: NOW });

  assert.equal(plan.suppressed, false);
  assert.equal(plan.ok, true);

  // Only the sections that cite it go. A citation is not a reason to take down
  // a document that merely mentions it.
  for (const skipped of plan.skippedSections) {
    assert.deepEqual(skipped.facts, [supporting]);
    assert.equal(skipped.inherited, false, "a supporting fact must never arrive by inheritance");
  }
  // The factless sections inherit only the document's OWN facts, so they stay.
  const headings = plan.chunks.map((c) => c.heading);
  for (const section of factless) assert.ok(headings.includes(section.heading));
  // And the finding aid survives, because it carries no blocked fact.
  assert.equal(plan.aliasChunkSkipped, false);
  assert.equal(plan.chunks[0].metadata.kind, ALIAS_CHUNK_KIND);
  // Its table of contents must not advertise a section that was just removed.
  for (const skipped of plan.skippedSections) {
    assert.ok(!plan.chunks[0].content.includes(skipped.heading), `the finding aid still lists the removed section "${skipped.heading}"`);
  }
  for (const section of factless) assert.ok(plan.chunks[0].content.includes(section.heading));
  plan.chunks.forEach((chunk, index) => assert.equal(chunk.chunk_index, index));
  assert.deepEqual(assertPayload(plan), []);
});

test("buildChunks can omit the finding aid, and the sections then number from 0", () => {
  const { parsed } = companyLifecycleFixture();
  const withAlias = buildChunks(parsed);
  const without = buildChunks(parsed, { includeAlias: false });
  assert.equal(without.length, withAlias.length - 1);
  assert.equal(without[0].heading, parsed.sections[0].heading);
  without.forEach((chunk, index) => assert.equal(chunk.chunk_index, index));
});

test("an unblocked corpus skips nothing, so today's plan is the whole corpus", () => {
  assert.equal(PLAN.summary.skippedSections, 0);
  assert.equal(PLAN.summary.skipped, 0);
  assert.equal(PLAN.summary.suppressed, 0);
  assert.deepEqual(PLAN.summary.suppressedTopics, []);
  for (const file of PLAN.files) assert.equal(file.aliasChunkSkipped, false);
});

// --------------------------------------------- a broken file never gets built

test("a file that fails the authoring gate produces no payload", () => {
  const broken = "---\ntopic: ip-box\nlang: en\n---\n\nnot a corpus file\n";
  const plan = planFile({ text: broken, topicSlug: "ip-box", lang: "en", path: "knowledge/ip-box/en.md", register: REGISTER, now: NOW });
  assert.equal(plan.ok, false);
  assert.equal(plan.document, null);
  assert.equal(plan.source, null);
  assert.deepEqual(plan.chunks, []);
  assert.ok(plan.errors.length > 0);
});

test("a frontmatter/path mismatch is an error, never a silently relocated document", () => {
  const text = readCorpusFile("knowledge/ip-box/en.md");
  const plan = planFile({ text, topicSlug: "corporate-tax", lang: "en", path: "knowledge/corporate-tax/en.md", register: REGISTER, now: NOW });
  assert.equal(plan.ok, false);
  assert.equal(plan.source, null);
});

// -------------------------------------------- assertPayload catches each rule

function samplePayload() {
  const text = readCorpusFile("knowledge/ip-box/en.md");
  const validated = validateCorpusFile(text, { topicSlug: "ip-box", lang: "en" });
  return {
    source: buildSourceRow(validated.parsed),
    document: buildDocumentPayload(validated.parsed, validated.body),
    chunks: buildChunks(validated.parsed),
  };
}

test("assertPayload is clean on a real file", () => {
  assert.deepEqual(assertPayload(samplePayload()), []);
});

test("assertPayload catches a chunk over the 12000 character check constraint", () => {
  const payload = samplePayload();
  payload.chunks[1] = { ...payload.chunks[1], content: "x".repeat(MAX_CHUNK_CHARS + 1) };
  assert.match(assertPayload(payload).join("\n"), /12000/u);
});

test("assertPayload catches an empty chunk", () => {
  const payload = samplePayload();
  payload.chunks[1] = { ...payload.chunks[1], content: "" };
  assert.match(assertPayload(payload).join("\n"), /outside the 1 to 12000/u);
});

test("assertPayload catches a non-contiguous chunk_index", () => {
  const payload = samplePayload();
  payload.chunks[2] = { ...payload.chunks[2], chunk_index: 9 };
  assert.match(assertPayload(payload).join("\n"), /contiguous/u);
});

test("assertPayload catches an empty and an over-long chunk set", () => {
  const empty = samplePayload();
  empty.chunks = [];
  assert.match(assertPayload(empty).join("\n"), /chunk count 0/u);

  const huge = samplePayload();
  huge.chunks = Array.from({ length: MAX_CHUNKS + 1 }, (_, i) => ({ chunk_index: i, heading: "h", content: "c", metadata: {} }));
  assert.match(assertPayload(huge).join("\n"), /chunk count 501/u);
});

test("assertPayload catches a hash that is not the hash of the content being sent", () => {
  const payload = samplePayload();
  payload.document = { ...payload.document, p_content: `${payload.document.p_content} trailing edit` };
  assert.match(assertPayload(payload).join("\n"), /not the hash of the exact content/u);
});

test("assertPayload catches a malformed sha256", () => {
  const payload = samplePayload();
  payload.document = { ...payload.document, p_content_sha256: "NOTAHASH" };
  assert.match(assertPayload(payload).join("\n"), /check constraint/u);
});

test("assertPayload catches a title longer than the display_name truncation", () => {
  const payload = samplePayload();
  payload.document = { ...payload.document, p_title: "t".repeat(MAX_DISPLAY_NAME_CHARS + 1) };
  assert.match(assertPayload(payload).join("\n"), /truncates display_name/u);
});

test("assertPayload catches a canonical_url outside the URI scheme", () => {
  const payload = samplePayload();
  payload.source = { ...payload.source, canonical_url: "https://example.invalid/ip-box" };
  assert.match(assertPayload(payload).join("\n"), /CANONICAL_URL_PATTERN/u);
});

test("assertPayload catches the sources enums being fed a taxonomy trust tier", () => {
  const payload = samplePayload();
  // brainTaxonomy.TRUST_TIERS.REGULATED is a valid tier in OUR vocabulary and
  // an instant check-constraint violation in the sources table's.
  payload.source = { ...payload.source, trust_tier: "regulated" };
  assert.match(assertPayload(payload).join("\n"), /trust_tier `regulated`/u);
});

// ------------------------------------------------------------- planCorpus I/O

test("planCorpus refuses to do its own I/O", () => {
  assert.throws(() => planCorpus({ root: "knowledge" }), /readFile/u);
});

test("planCorpus reports a missing file rather than silently planning 86", () => {
  const plan = planCorpus({
    root: "knowledge",
    topics: TOPICS.slice(0, 2),
    langs: ["en"],
    register: REGISTER,
    now: NOW,
    readFile: (p) => (p.includes("company-lifecycle") ? null : readCorpusFile(p)),
    join: (...parts) => parts.join("/"),
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.summary.missing, 1);
  assert.equal(plan.summary.expected, 2);
  assert.match(plan.files[0].errors.join(""), /MISSING/u);
});
