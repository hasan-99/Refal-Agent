"use strict";

// M3 / W3.10.1-W3.10.4 — the corpus ingestion PLAN.
//
// This module turns a validated corpus file into the exact rows the knowledge
// store expects, and nothing else. It opens no file, makes no request and
// touches no clock it was not handed. scripts/ingestBrainCorpus.js is the thin
// I/O shell that reads the disk and (only with --apply) posts the result.
//
// The split is the point. Every database constraint the payload could violate
// is asserted HERE, in a function a test can call 87 times offline, so a dry
// run fails on this machine rather than halfway through a write.
//
// WHAT GETS WRITTEN, AND WHY IT LOOKS LIKE THIS
// ---------------------------------------------
// One `rafa_knowledge_sources` row per topic/language pair, keyed on
// canonical_url (`refal://kb/<domain>/<slug>/<lang>`), which is the table's
// only unique column and therefore the only idempotency key we have.
//
// One LIVE `rafa_knowledge_documents` revision per source, written through
// `rafa_store_knowledge_revision`.
//
// Updated 2026-10-10 for P3.9 / CR-014. That function used to be
// replace-in-place: it deleted every other document for the source, pinned
// revision = 1 and stamped the row approved on its own. It no longer deletes,
// because a superseded revision is the evidence of what was reviewed and when,
// and revisions increment again. CR-010's partial unique index still allows at
// most one APPROVED row per source, so "one live document per source" holds;
// what changed is that the history survives and approving is a decision the
// caller states. Re-running the ingest is still safe: identical content short
// circuits to `unchanged: true`.
//
// One `rafa_knowledge_chunks` row per `##` section (W3.10.2 — chunk by
// meaning, never by character count), plus ONE finding-aid chunk at index 0
// carrying the document title, its section headings as a table of contents,
// and the alias phrases.
//
// WHY THE ALIASES ARE A CHUNK AND NOT METADATA (W3.10.4)
// ------------------------------------------------------
// `chunks.search_vector` is `to_tsvector('simple', heading || ' ' || content)`.
// 'simple' means no stemming: a customer's literal words have to appear in the
// heading or the content or they are not findable, and no search RPC in this
// database reads `chunks.metadata` at all. Aliases stored in metadata would be
// a decorative no-op. Stored as chunk 0 they are exactly what makes "golden
// visa cyprus" reach the permanent-residency document.
//
// The alias chunk is marked `metadata.kind = "aliases"` so a later consumer can
// tell a finding aid from a claim. Real sections therefore start at index 1.
//
// WHY BLOCKED FACTS ARE DROPPED HERE TOO
// --------------------------------------
// src/factRegister.js already filters blocked facts at query time. That is one
// layer, and one layer is not a guarantee. A section whose register row says
// `blocked` is not ingested at all, so the text is not in the database to be
// found by a future search path that forgets to filter.
//
// INHERITED GOVERNANCE, AND WHY A FACTLESS SECTION IS NOT AN ORPHAN
// -----------------------------------------------------------------
// Both filters, here and at query time, key on `metadata.facts`. A section
// whose `<!-- ... -->` directive names no fact would therefore have been
// unreachable by either: 18 of the 29 English topics carry at least one such
// section, usually a `kind: boundary` one. Blocking MB-F1 would have taken the
// company-lifecycle document's claims down and left its "this is not advice for
// your case" section behind as an orphan chunk pointing at a topic REFAL is
// refusing to discuss.
//
// So a section that declares no facts of its own INHERITS the document's fact
// list, and its chunk is marked `metadata.inheritedFacts = true` so a reader
// can tell an inherited governance link from an authored one. `blocked` means
// this topic must not be retrievable at all, and failing closed is the only
// reading of that which holds.
//
// Only the document's OWN `facts` are inherited, never `supporting`. A
// supporting fact is a citation; a blocked citation must not take down a
// document that merely mentions it. A section that declares its own facts keeps
// exactly what it declares.
//
// THE 30 DAY PRICE EXPIRY
// -----------------------
// A BEFORE trigger on rafa_knowledge_documents (migration 20261003224701)
// matches canonical_content against a currency regex and forces
// `valid_until = now() + 30 days`. Both search RPCs then exclude anything past
// valid_until. Several corpus documents state €300,000, so they WILL stop being
// retrievable 30 days after ingestion. That is Rule 2 working, not a bug, but
// it makes re-ingestion a monthly operation, so the plan predicts it per
// document rather than letting the operator discover it in week five.

const crypto = require("node:crypto");

const { validateCorpusFile } = require("./corpusFile");
const {
  TOPICS, LANGUAGES, CANONICAL_URL_PATTERN, canonicalUrl, topicBySlug,
} = require("./brainTaxonomy");
const { TOPIC_PHASE, normalizeFactId } = require("./brainFactMap");
const { STATUS, factBehaviour, seedRegister } = require("./factRegister");

// ------------------------------------------------------------- the contract
// Bumped when the shape of what we write changes, so a stored document can be
// told apart from one written by an older ingest without diffing it.
const CONTRACT_VERSION = "w3.10.1";

// `rafa_knowledge_sources` has its OWN enums, which are about where a source
// came from operationally. They are not brainTaxonomy.TRUST_TIERS, and the two
// vocabularies must not be confused: the taxonomy tier is recorded separately
// in sources.metadata.brainTrustTier.
const SOURCE_KIND = "manual";
const SOURCE_TRUST_TIER = "operator_supplied";
const SOURCE_KINDS = Object.freeze([
  "first_party_website", "first_party_social", "official_registry", "secondary_directory", "manual",
]);
const SOURCE_TRUST_TIERS = Object.freeze(["official", "first_party", "secondary", "operator_supplied"]);
const APPROVAL_NOTE = "Ingested from the authored M3 knowledge corpus.";

// Every one of these is a real CHECK, a real unique index or a real guard
// inside rafa_store_knowledge_revision. Violating one is a 4xx from PostgREST
// in the middle of a write, so the plan refuses to produce it in the first
// place.
const MIN_CHUNKS = 1;
const REVIEW_STATUS_ON_INGEST = "approved";  // CR-014: stated, not assumed
const INGEST_REVIEWER = "m3-corpus-ingestion";   // tells a generated ingest apart from a human save
const MAX_CHUNKS = 500;              // rafa_store_knowledge_revision
const MIN_CHUNK_CHARS = 1;           // chunks.content check
const MAX_CHUNK_CHARS = 12000;       // chunks.content check
const MAX_CONTENT_CHARS = 1000000;   // rafa_store_knowledge_revision
const MAX_DOCUMENT_TITLE_CHARS = 500;  // left(trim(p_title), 500)
const MAX_DISPLAY_NAME_CHARS = 160;    // left(trim(p_title), 160)
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

const ALIAS_CHUNK_KIND = "aliases";

// The governed fact ids a section is answerable for, and whether they were
// authored on the section or inherited from the document. One place, so the
// ingest-time filter and the chunk metadata can never disagree about what a
// section carries.
function sectionFactIds(section, meta) {
  const own = (section.facts || []).map(normalizeFactId);
  if (own.length) return { facts: own, inherited: false };
  // Nothing declared: fail closed onto the document's own facts. `supporting`
  // is deliberately excluded, see the header note.
  return { facts: [...meta.facts], inherited: true };
}

// --------------------------------------------------------- the price expiry
// A literal mirror of the regex inside rafa_apply_knowledge_approval_lifecycle
// (and inside both search RPCs' eligibility filters). Postgres applies it with
// `~*`, so this is case insensitive, and POSIX [[:space:]] is spelled out
// rather than borrowed from JS `\s`, which is wider.
const PG_SPACE = "[ \\t\\n\\v\\f\\r]";
const PG_DIGIT = "[0-9٠-٩]";
const PRICE_EXPIRY_PATTERN = new RegExp(
  `[$€£]${PG_SPACE}*${PG_DIGIT}` +
  `|(?:EUR|USD|GBP)${PG_SPACE}*${PG_DIGIT}` +
  `|${PG_DIGIT}[0-9٠-٩., \\t\\n\\v\\f\\r]*` +
  `(?:EUR|USD|GBP|euros?|dollars?|pounds?|يورو|دولار|جنيه|ευρώ)`,
  "iu",
);
const PRICE_EXPIRY_DAYS = 30;

function triggersPriceExpiry(content) {
  return PRICE_EXPIRY_PATTERN.test(String(content || ""));
}

// ------------------------------------------------------------------- hashing
// Hash the EXACT string that is sent as p_content. Normalising after hashing
// (or before sending but after hashing) makes the RPC's `unchanged` check fail
// forever, and every monthly run would rewrite all 87 documents and throw away
// their embeddings.
function contentSha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

// The canonical content, assembled exactly as src/corpusFile.js assembles it,
// so that an unfiltered document hashes identically to `validateCorpusFile().body`.
function canonicalContentFor(sections) {
  return sections.map((s) => `${s.heading}\n${s.body}`).join("\n\n");
}

// ------------------------------------------------------------------- chunks
// Title, then every section heading in document order, then the alias phrases,
// one per line. Newlines are token separators for to_tsvector, so each phrase
// and each heading stays individually matchable.
//
// The headings are the reason this is a table of contents rather than a bare
// keyword list. The alias chunk is a separate chunk, so a question that matches
// ONLY the aliases retrieves a block of question phrases and no facts at all.
// scripts/brainHealth.js measured that gap: Arabic golden-question coverage is
// 94.8% counting title plus aliases but 54.5% counting what a chunk's
// search_vector actually sees, and English drops from ~95% to 70.9%. Arabic
// reachability leans on the alias list far harder than English does, and in the
// worst case those hits land on a contentless chunk.
//
// Headings are the right filler and body sentences are not. They are authored,
// topical, already covered by the connector-dash and forbidden-literal checks,
// and they carry no figures. A model that retrieves only this chunk still
// learns what the document covers and can say so honestly, and the heading
// tokens lift lexical recall on their own. Copying body text would duplicate
// content into a second chunk and could lift a number out of the sentence that
// qualifies it.
//
// Only the sections that are actually being ingested are listed. A table of
// contents must not advertise a section the blocked-fact filter just removed.
function aliasChunkContent(meta, sections = []) {
  return [meta.title, ...sections.map((s) => s.heading), ...meta.aliases].join("\n");
}

// `parsed` is validateCorpusFile(...).parsed — { meta, sections, preamble }.
// `sections` may be narrowed by the caller (blocked facts removed); indexes are
// always rebuilt contiguously from 0 afterwards, because (document_id,
// chunk_index) is unique and the embeddings RPC matches on chunk_index.
function buildChunks(parsed, { sections, includeAlias = true } = {}) {
  const meta = parsed.meta;
  const topic = topicBySlug(meta.topic);
  const kept = sections || parsed.sections;
  const common = {
    topic: meta.topic,
    lang: meta.lang,
    topicNumber: topic ? topic.n : null,
    domain: topic ? topic.domain : null,
  };

  const chunks = [];
  // The finding aid carries the document's fact list, so it is subject to the
  // same blocked-fact rule as any other chunk: when one of those facts is
  // blocked the caller drops it, and the sections then number from 0.
  if (includeAlias) chunks.push({
    chunk_index: 0,
    heading: meta.title,
    content: aliasChunkContent(meta, kept),
    metadata: {
      ...common,
      kind: ALIAS_CHUNK_KIND,
      // The document's own fact list, so that a blocked owned fact also takes
      // the finding aid down at query time via factRegister#chunkFactIds.
      facts: [...meta.facts],
      supporting: [...meta.supporting],
      inheritedFacts: false,
      sectionIndex: null,
    },
  });

  kept.forEach((section, index) => {
    const { facts, inherited } = sectionFactIds(section, meta);
    chunks.push({
      chunk_index: chunks.length,
      heading: section.heading,
      content: section.body,
      metadata: {
        ...common,
        kind: section.kind,
        // Every governed id the section is answerable for, owned or referenced,
        // authored or inherited. This is the field factRegister#chunkFactIds
        // reads, so it has to be complete or the blocked-fact filter has a hole.
        facts,
        // Which of those this document only REFERENCES rather than owns. An
        // inherited list never contains a supporting fact by construction.
        supporting: inherited ? [] : facts.filter((id) => meta.supporting.includes(id)),
        // True when the section declared nothing and took the document's facts.
        inheritedFacts: inherited,
        sectionIndex: index,
      },
    });
  });

  return chunks;
}

// ------------------------------------------------------------------ the rows
function buildSourceRow(parsed) {
  const meta = parsed.meta;
  const topic = topicBySlug(meta.topic);
  return {
    canonical_url: canonicalUrl(meta.topic, meta.lang),
    display_name: meta.title.slice(0, MAX_DISPLAY_NAME_CHARS),
    source_kind: SOURCE_KIND,
    trust_tier: SOURCE_TRUST_TIER,
    enabled: true,
    approved: true,
    approval_note: APPROVAL_NOTE,
    metadata: {
      // The taxonomy's real tier, kept out of `trust_tier` on purpose: that
      // column's enum is the sources table's own operational vocabulary.
      brainTrustTier: topic ? topic.tier : null,
      volatility: topic ? topic.volatility : null,
      topic: meta.topic,
      topicNumber: topic ? topic.n : null,
      domain: topic ? topic.domain : null,
      lang: meta.lang,
    },
  };
}

// The rafa_store_knowledge_revision argument object, minus p_source_id, which
// only exists after the source row has been upserted.
function buildDocumentPayload(parsed, body) {
  const meta = parsed.meta;
  const topic = topicBySlug(meta.topic);
  return {
    p_title: meta.title,
    p_content: body,
    p_content_sha256: contentSha256(body),
    p_language_code: meta.lang,
    // NOT optional. P3.9 / CR-014 changed rafa_store_knowledge_revision to
    // default to `pending`, because a save silently approving itself was the
    // conflict that phase had to remove. A call that omits these two still
    // RESOLVES against the new signature, so leaving them off would queue all
    // 87 documents and take retrieval dark while the script reported success.
    // That is the exact silent-failure class this module guards against
    // everywhere else, so it is stated here rather than inherited.
    p_review_status: REVIEW_STATUS_ON_INGEST,
    p_approved_by: INGEST_REVIEWER,
    p_metadata: {
      topic: meta.topic,
      topicNumber: topic ? topic.n : null,
      domain: topic ? topic.domain : null,
      lang: meta.lang,
      trustTier: topic ? topic.tier : null,
      volatility: topic ? topic.volatility : null,
      facts: [...meta.facts],
      supporting: [...meta.supporting],
      aliases: [...meta.aliases],
      canonicalUrl: canonicalUrl(meta.topic, meta.lang),
      contractVersion: CONTRACT_VERSION,
    },
  };
}

// ------------------------------------------------------ constraint assertions
// Everything the database would reject, checked before anything is sent.
function assertPayload({ source, document, chunks }) {
  const problems = [];

  if (!CANONICAL_URL_PATTERN.test(source.canonical_url)) {
    problems.push(`canonical_url \`${source.canonical_url}\` does not match CANONICAL_URL_PATTERN`);
  }
  if (!SOURCE_KINDS.includes(source.source_kind)) problems.push(`source_kind \`${source.source_kind}\` is not in the sources check constraint`);
  if (!SOURCE_TRUST_TIERS.includes(source.trust_tier)) problems.push(`trust_tier \`${source.trust_tier}\` is not in the sources check constraint`);
  if (!source.display_name || source.display_name.length > MAX_DISPLAY_NAME_CHARS) {
    problems.push(`display_name must be 1 to ${MAX_DISPLAY_NAME_CHARS} characters, got ${source.display_name ? source.display_name.length : 0}`);
  }

  const title = String(document.p_title || "").trim();
  if (!title) problems.push("document title is empty, which rafa_store_knowledge_revision rejects");
  if (title.length > MAX_DOCUMENT_TITLE_CHARS) problems.push(`document title is ${title.length} chars, over the ${MAX_DOCUMENT_TITLE_CHARS} the RPC truncates to`);
  // A title longer than 160 would silently differ from the display_name the
  // RPC writes back, so the two would never agree again.
  if (title.length > MAX_DISPLAY_NAME_CHARS) problems.push(`document title is ${title.length} chars; the RPC truncates display_name to ${MAX_DISPLAY_NAME_CHARS}, so the source name would not match the title`);

  if (!String(document.p_content || "").trim()) problems.push("canonical content is empty");
  if (String(document.p_content || "").length > MAX_CONTENT_CHARS) {
    problems.push(`canonical content is ${document.p_content.length} chars, over the ${MAX_CONTENT_CHARS} the RPC allows`);
  }
  if (!SHA256_PATTERN.test(document.p_content_sha256)) {
    problems.push(`content_sha256 \`${document.p_content_sha256}\` does not match the documents check constraint`);
  }
  if (contentSha256(document.p_content) !== document.p_content_sha256) {
    problems.push("content_sha256 is not the hash of the exact content being sent");
  }
  if (!LANGUAGES.includes(document.p_language_code)) {
    problems.push(`language_code \`${document.p_language_code}\` is not a corpus language`);
  }

  if (chunks.length < MIN_CHUNKS || chunks.length > MAX_CHUNKS) {
    problems.push(`chunk count ${chunks.length} is outside the ${MIN_CHUNKS} to ${MAX_CHUNKS} the RPC allows`);
  }
  chunks.forEach((chunk, index) => {
    if (chunk.chunk_index !== index) {
      problems.push(`chunk_index is not 0-based and contiguous: position ${index} carries chunk_index ${chunk.chunk_index}`);
    }
    if (!Number.isInteger(chunk.chunk_index) || chunk.chunk_index < 0) {
      problems.push(`chunk_index \`${chunk.chunk_index}\` is not a non-negative integer`);
    }
    const length = String(chunk.content || "").length;
    if (length < MIN_CHUNK_CHARS || length > MAX_CHUNK_CHARS) {
      problems.push(`chunk ${chunk.chunk_index} ("${chunk.heading}") content is ${length} chars, outside the ${MIN_CHUNK_CHARS} to ${MAX_CHUNK_CHARS} check constraint`);
    }
    if (typeof chunk.heading !== "string") {
      problems.push(`chunk ${chunk.chunk_index} has a non-string heading; the column is NOT NULL`);
    }
  });

  return problems;
}

// ----------------------------------------------------------------- planFile
// The whole per-file decision, offline. Returns a plan, never throws for a
// corpus problem: a caller gets `ok: false` plus the reasons so it can report
// all 87 files instead of dying on the first one.
function planFile({ text, topicSlug, lang, path = "", register, now } = {}) {
  const reg = register || seedRegister();
  const result = validateCorpusFile(text, { topicSlug, lang, path });

  const base = {
    ok: false, path, topic: topicSlug, lang,
    errors: [], warnings: [],
    source: null, document: null, chunks: [],
    skippedSections: [], willAutoExpire: false, skipped: false, suppressed: false,
  };

  // A file that fails the authoring gate must never reach the database. There
  // is no --force for this; fix the file.
  if (result.errors.length) return { ...base, errors: [...result.errors] };
  if (!result.parsed) return { ...base, errors: [`${path}: could not be parsed`] };

  const parsed = result.parsed;
  const warnings = [];

  // ---- Rule 2, layer one: a blocked fact is removed at ingest.
  const kept = [];
  const skippedSections = [];
  for (const section of parsed.sections) {
    // The inherited list, so a section that declares nothing is governed by the
    // document rather than slipping past both filters.
    const { facts, inherited } = sectionFactIds(section, parsed.meta);
    const blocked = [];
    for (const id of facts) {
      const behaviour = factBehaviour(id, { register: reg, now });
      if (behaviour.status === STATUS.BLOCKED) blocked.push(id);
      // An id with no register row is not blocked, but nothing keeps it
      // reviewed either, so it is worth saying out loud. Only for authored
      // ids: an inherited one is already reported against its own section.
      else if (behaviour.reason === "no_register_row" && !inherited) {
        warnings.push(`${path}: section "${section.heading}" declares \`${id}\`, which has no register row`);
      }
    }
    if (blocked.length) skippedSections.push({ heading: section.heading, kind: section.kind, facts: blocked, inherited });
    else kept.push(section);
  }

  // The finding aid is a chunk like any other, and it carries the document's
  // own fact list. The same rule applies to it: a chunk carrying a blocked fact
  // is dropped whole, or a topic REFAL is refusing to discuss stays findable by
  // every alias a customer might type for it.
  const aliasBlocked = parsed.meta.facts.filter(
    (id) => factBehaviour(id, { register: reg, now }).status === STATUS.BLOCKED,
  );
  if (aliasBlocked.length) {
    warnings.push(`${path}: the alias finding-aid chunk is dropped; the document's facts ${aliasBlocked.join(", ")} are blocked`);
  }

  // Fully suppressed. With inherited governance this is now the NORMAL shape of
  // a document whose own fact is blocked: every section goes with it, including
  // the factless ones, and the alias chunk carries the document fact list too.
  // Reported explicitly rather than emitted as a zero-chunk payload, which
  // rafa_store_knowledge_revision would reject anyway (p_chunks length >= 1)
  // and which would otherwise leave an empty approved shell in the database.
  if (!kept.length) {
    const blockedIds = [...new Set(skippedSections.flatMap((s) => s.facts))].sort();
    return {
      ...base, skipped: true, suppressed: true, ok: true, skippedSections, warnings,
      errors: [],
      canonicalUrl: canonicalUrl(parsed.meta.topic, parsed.meta.lang),
      skipReason: `fully suppressed: every section carries a blocked fact (${blockedIds.join(", ")}), so nothing is ingested for this topic`,
    };
  }

  // When nothing was filtered this is byte-identical to result.body, which is
  // what makes the RPC's `unchanged` short circuit work across runs. When a
  // section WAS filtered the content genuinely differs, and it must: blocked
  // text has no business sitting in canonical_content either.
  const body = skippedSections.length ? canonicalContentFor(kept) : result.body;

  const source = buildSourceRow(parsed);
  const document = buildDocumentPayload(parsed, body);
  const chunks = buildChunks(parsed, { sections: kept, includeAlias: aliasBlocked.length === 0 });

  const problems = assertPayload({ source, document, chunks });

  return {
    ...base,
    ok: problems.length === 0,
    errors: problems.map((p) => (path ? `${path}: ${p}` : p)),
    warnings,
    source, document, chunks,
    skippedSections,
    aliasChunkSkipped: aliasBlocked.length > 0,
    blockedDocumentFacts: aliasBlocked,
    willAutoExpire: triggersPriceExpiry(body),
    expiryDays: PRICE_EXPIRY_DAYS,
    canonicalUrl: source.canonical_url,
    contentChars: body.length,
  };
}

// ---------------------------------------------------------------- planCorpus
// `readFile(absolutePath)` returns the file text, or null when it is missing.
// Injected rather than imported so this module stays free of I/O: the script
// hands it `fs`, the test hands it `fs`, a future fixture can hand it a Map.
function planCorpus({ root = "knowledge", topics = TOPICS, langs = LANGUAGES, register, now, readFile, join } = {}) {
  if (typeof readFile !== "function") throw new Error("planCorpus needs a readFile(path) function; this module does no I/O of its own");
  const reg = register || seedRegister();
  const joinPath = join || ((...parts) => parts.join("/"));

  const files = [];
  for (const topic of topics) {
    for (const lang of langs) {
      const filePath = joinPath(root, topic.slug, `${lang}.md`);
      const text = readFile(filePath);
      if (text === null || text === undefined) {
        files.push({
          ok: false, path: filePath, topic: topic.slug, topicNumber: topic.n,
          phase: TOPIC_PHASE[topic.n], lang, missing: true,
          errors: [`${filePath}: MISSING`], warnings: [],
          source: null, document: null, chunks: [], skippedSections: [],
          willAutoExpire: false, skipped: false, suppressed: false,
        });
        continue;
      }
      const plan = planFile({ text, topicSlug: topic.slug, lang, path: filePath, register: reg, now });
      files.push({ ...plan, topicNumber: topic.n, phase: TOPIC_PHASE[topic.n], missing: false });
    }
  }

  const planned = files.filter((f) => f.ok && !f.skipped && !f.missing);
  const summary = {
    expected: files.length,
    present: files.filter((f) => !f.missing).length,
    missing: files.filter((f) => f.missing).length,
    broken: files.filter((f) => !f.ok).length,
    errors: files.reduce((a, f) => a + f.errors.length, 0),
    warnings: files.reduce((a, f) => a + f.warnings.length, 0),
    skipped: files.filter((f) => f.skipped).length,
    suppressed: files.filter((f) => f.suppressed).length,
    suppressedTopics: [...new Set(files.filter((f) => f.suppressed).map((f) => f.topic))].sort(),
    sources: planned.length,
    documents: planned.length,
    chunks: planned.reduce((a, f) => a + f.chunks.length, 0),
    aliasChunks: planned.length,
    sectionChunks: planned.reduce((a, f) => a + f.chunks.length - 1, 0),
    skippedSections: files.reduce((a, f) => a + f.skippedSections.length, 0),
    contentChars: planned.reduce((a, f) => a + (f.contentChars || 0), 0),
    willAutoExpire: planned.filter((f) => f.willAutoExpire).length,
    autoExpireTopics: [...new Set(planned.filter((f) => f.willAutoExpire).map((f) => f.topic))].sort(),
  };

  return { ok: summary.broken === 0, files, summary };
}

module.exports = {
  REVIEW_STATUS_ON_INGEST, INGEST_REVIEWER,
  CONTRACT_VERSION, SOURCE_KIND, SOURCE_TRUST_TIER, SOURCE_KINDS, SOURCE_TRUST_TIERS,
  ALIAS_CHUNK_KIND, APPROVAL_NOTE,
  MIN_CHUNKS, MAX_CHUNKS, MIN_CHUNK_CHARS, MAX_CHUNK_CHARS, MAX_CONTENT_CHARS,
  MAX_DOCUMENT_TITLE_CHARS, MAX_DISPLAY_NAME_CHARS, SHA256_PATTERN,
  PRICE_EXPIRY_PATTERN, PRICE_EXPIRY_DAYS, triggersPriceExpiry,
  contentSha256, canonicalContentFor, aliasChunkContent, sectionFactIds,
  buildChunks, buildSourceRow, buildDocumentPayload, assertPayload,
  planFile, planCorpus,
};
