"use strict";

// The unified knowledge-search engine. ONE path for every caller: the WhatsApp
// worker (src/bot.js), the Agent tool (src/agentTools.js) and the evaluation
// harnesses all run this, so a recall fix lands everywhere at once instead of
// in whichever copy was edited last.
//
// WHAT IT DOES, IN ORDER
// ----------------------
//   plan queries -> search broadly -> keep MANY candidates -> pull the
//   complete parent sections -> check coverage -> search again for the gaps ->
//   hand back evidence plus a trace.
//
// THE BUG THIS REPLACES
// ---------------------
// src/knowledgeQuery.js#retrieveKnowledgeForTurn asked the database for 6 rows
// per query and then called `.find(...)` on them: ONE row survived per query,
// and for a non-broad intent there was only one query, so a factual question
// retrieved exactly ONE chunk. Five ranked candidates were fetched over the
// network and dropped on the floor. If that single chunk was the wrong one, or
// was filtered by the fact register, the turn reported "no approved
// information" while the answer sat in row 2.
//
// WHY A SECTION IS NOT A CHUNK HERE
// ---------------------------------
// A chunk IS a `##` section (src/corpusIngest.js), but the CONDITIONS on a
// claim usually live in a different section of the same document -- every
// corpus document is required to carry a `kind: boundary` section
// (src/corpusFile.js:392). Retrieving the matched chunk alone therefore
// reliably retrieves the claim WITHOUT its exceptions, which is the worst
// possible half of the answer. `fetchKnowledgeSections` pulls the parent
// document's sections in original order so the condition travels with the
// claim.
//
// FAILURE IS NOT ABSENCE
// ----------------------
// `status` separates the three outcomes the old code collapsed into one:
//   found         -- evidence retrieved
//   no_evidence   -- the search ran correctly and the corpus has nothing
//   search_failed -- embedding/network/RPC error; the corpus was never consulted
// A caller must never tell a customer "I have no confirmed information" on
// `search_failed`. That sentence is a claim about the knowledge base, and a
// failed search has not earned it.

const { redactPersonalData } = require("./ai");

// ------------------------------------------------------------------- budgets
// Every limit the workflow spends is named here and overridable per call, so
// "continue within configurable search-round and context limits" is a config
// change rather than an edit.
const DEFAULTS = Object.freeze({
  maxRounds: 3,              // search rounds, including the first
  matchCount: 12,            // candidates requested per query
  maxCandidates: 40,         // ranked chunks kept across all rounds
  maxSections: 18,           // parent sections pulled into the answer context
  maxContextChars: 24000,    // total characters of section text handed upward
  maxSectionChars: 6000,     // per section before it is read in bounded parts
  minCoverage: 0.2,          // lexical admission floor passed to the RPC
  minTerms: 1,               // distinct query terms a candidate must match
  maxDistance: 0.85,         // cosine cutoff passed to the semantic arm
  coverageTarget: 0.75       // question-term support needed to stop early
});

// Stopwords exist so "what is included in the package" is not treated as six
// equally meaningful search terms. 'simple' tsvector strips none of these, so
// the un-stripped token list is also what made the old 0.6 coverage gate
// unreachable for a real sentence.
const STOPWORDS = new Set([
  // english
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "did", "do", "does", "for", "from",
  "get", "had", "has", "have", "how", "i", "if", "in", "is", "it", "its", "me", "much", "my", "no",
  "not", "of", "on", "or", "please", "so", "tell", "that", "the", "their", "them", "then", "there",
  "these", "they", "this", "to", "was", "we", "were", "what", "when", "where", "which", "who", "why",
  "will", "with", "would", "you", "your", "about", "any", "all", "also", "more", "need", "want",
  // arabic
  "في", "من", "على", "عن", "الى", "إلى", "هل", "ما", "ماذا", "شو", "كيف", "كم", "قديش", "هاد", "هذا",
  "هذه", "ذلك", "التي", "الذي", "و", "او", "أو", "مع", "بس", "يا", "لو", "اذا", "إذا", "بدي", "بدك",
  "عندي", "عندك", "في", "انا", "أنا", "انت", "أنت", "هو", "هي", "لي", "له", "بال", "ال",
  // greek
  "και", "το", "τα", "της", "του", "των", "στο", "στη", "στην", "με", "για", "που", "ποιο", "ποια",
  "πως", "πώς", "τι", "ειναι", "είναι", "να", "σε", "απο", "από", "η", "ο", "οι", "ένα", "μια", "αν"
]);

// Cross-language anchors. A colloquial Arabic question rarely shares a token
// with an English section, and the semantic arm alone is not reliable across
// scripts; these give the LEXICAL arm something to match on in every language
// the corpus is authored in. Deliberately small and concrete -- this is a
// retrieval aid, never a translation layer, and it never invents a fact.
const CONCEPT_ANCHORS = Object.freeze([
  { match: /شرك|تأسيس|باقة|company|formation|incorporat|εταιρ|ίδρυσ|σύστασ/iu,
    terms: ["company formation Cyprus Ltd", "تأسيس شركة قبرص", "σύσταση εταιρείας Κύπρος"] },
  { match: /ضريب|ضرائب|tax|vat|ip box|φόρ|φπα/iu,
    terms: ["corporate tax VAT Cyprus", "ضريبة الشركات قبرص", "εταιρικός φόρος ΦΠΑ Κύπρος"] },
  { match: /بنك|مصرف|حساب|bank|payment|iban|τραπεζ|πληρωμ/iu,
    terms: ["corporate bank account payments", "حساب بنكي للشركة", "εταιρικός τραπεζικός λογαριασμός"] },
  { match: /إقام|اقام|فيزا|residen|permit|visa|golden|διαμον|άδεια/iu,
    terms: ["permanent residency permit Cyprus", "الإقامة الدائمة في قبرص", "μόνιμη διαμονή Κύπρος"] },
  { match: /عقار|شقة|بيت|propert|real estate|apartment|ακίνητ|διαμέρισμ/iu,
    terms: ["property purchase Cyprus", "شراء عقار في قبرص", "αγορά ακινήτου Κύπρος"] },
  { match: /محاسب|accounting|audit|payroll|λογιστ|μισθοδοσ/iu,
    terms: ["accounting audit payroll Cyprus", "المحاسبة والتدقيق", "λογιστική μισθοδοσία"] },
  { match: /سعر|تكلف|رسوم|price|cost|fee|τιμή|κόστος|χρέωσ/iu,
    terms: ["price fees cost package", "السعر والرسوم", "τιμή κόστος χρέωση"] },
  { match: /وقت|مدة|كم يوم|timeline|how long|duration|διάρκει|πόσο καιρό/iu,
    terms: ["timeline how long duration", "المدة الزمنية كم يوم", "χρονοδιάγραμμα διάρκεια"] },
  { match: /شرو|مستند|وثائق|requirement|document|condition|προϋπόθεσ|δικαιολογητ/iu,
    terms: ["requirements documents conditions", "الشروط والمستندات المطلوبة", "προϋποθέσεις δικαιολογητικά"] }
]);

function contentTerms(text) {
  return [...new Set(
    String(text || "")
      .toLowerCase()
      .split(/[^\p{L}\p{N}_]+/u)
      .filter((token) => token.length > 1 && !STOPWORDS.has(token))
  )];
}

// The distinct things the customer asked for. Splitting on sentence and clause
// boundaries is enough to notice that "what does it include and how long does
// it take" is two questions, which is what drives the follow-up round when only
// one of them ends up supported.
// `\band\b` is fine (ASCII), but `\bو\b` and `\bκαι\b` are not: `\b` is
// ASCII-only, so both of those branches were unreachable and an Arabic or Greek
// two-part question was never actually split into its parts. Unicode-aware
// lookarounds do the job for the non-Latin conjunctions.
const CLAUSE_SPLIT = /[?؟;\n]+|،|\. |(?:\band\b|(?<![\p{L}\p{N}])(?:و|και)(?![\p{L}\p{N}]))/giu;

function questionParts(question) {
  const parts = String(question || "")
    .split(CLAUSE_SPLIT)
    .map((part) => part.trim())
    .filter((part) => contentTerms(part).length > 0);
  return parts.length ? parts.slice(0, 6) : [String(question || "").trim()].filter(Boolean);
}

// Alternative wordings for a round that found nothing. Step 7: retry with
// different words BEFORE reporting the knowledge as missing.
function anchorQueries(question) {
  const text = String(question || "");
  const out = [];
  for (const anchor of CONCEPT_ANCHORS) {
    if (anchor.match.test(text)) out.push(...anchor.terms);
  }
  return [...new Set(out)];
}

function rowChunkId(row) {
  return String(row?.chunk_id || row?.chunkId || "") || null;
}

// The kind lives under three different names depending on which layer produced
// the row (RPC column, camelCase adapter, or raw chunk metadata). Reading only
// `chunk_kind` silently treated an `aliases` finding aid as customer evidence,
// so all three are checked here in one place.
function rowKind(row) {
  const kind = row?.chunk_kind ?? row?.chunkKind ?? row?.metadata?.kind;
  return kind == null ? "" : String(kind);
}

// Which section kinds may become customer evidence.
//
// The corpus authors four kinds (src/corpusFile.js): `fact`, `boundary`,
// `example`, `discovery`, plus the ingest-built `aliases` finding aid.
//
// The previous retrieval kept `kind === "fact"` ONLY. That is the single line
// that made conditions unreachable: `boundary` is, by definition, the section
// carrying the limitations and exceptions, and every corpus document is
// required to have one. Excluding it meant the claim could be retrieved and
// the caveat attached to that same claim never could.
//
// `discovery` stays out: it is a list of questions to ASK the customer, not an
// answer to give them. `aliases` stays out: it is navigation.
const EVIDENCE_KINDS = new Set(["fact", "boundary", "example", ""]);

function isEvidenceKind(kind) {
  return EVIDENCE_KINDS.has(String(kind || ""));
}

function rowKey(row) {
  return rowChunkId(row) || [row?.document_id, row?.heading, String(row?.content || "").slice(0, 80)].join("|");
}

// Reciprocal-rank fusion across every query in every round. A chunk that two
// different wordings both surfaced outranks one that a single wording put
// first, which is the whole point of searching broadly.
function fuseCandidates(buckets) {
  const scores = new Map();
  for (const rows of buckets) {
    (Array.isArray(rows) ? rows : []).forEach((row, index) => {
      const key = rowKey(row);
      const entry = scores.get(key) || { row, score: 0, hits: 0 };
      entry.score += 1 / (60 + index + 1);
      entry.hits += 1;
      // Keep the copy carrying the richer diagnostics for the trace.
      if (row?.semantic_distance != null && entry.row?.semantic_distance == null) entry.row = row;
      scores.set(key, entry);
    });
  }
  return [...scores.values()]
    .sort((a, b) => (b.score - a.score) || (b.hits - a.hits))
    .map((entry) => ({ ...entry.row, fusedScore: entry.score, queryHits: entry.hits }));
}

// Step 4's "read oversized sections in bounded parts while preserving
// supporting evidence". A 12000-character section is not truncated to its first
// N characters, because the conditions are usually at the END. The head is kept
// (the claim) and the tail is kept (the caveats), and the elision is stated so
// a reader knows text was dropped rather than assuming the section ended.
const ELISION = "\n[...]\n";

function boundSection(text, limit) {
  const content = String(text || "");
  const budget = Math.max(0, Number(limit) || 0);
  if (content.length <= budget) return { content, truncated: false };
  // Below the elision marker's own length there is no room to keep two ends;
  // keep the head so the caller still gets the claim.
  if (budget <= ELISION.length + 2) return { content: content.slice(0, budget), truncated: true };
  const usable = budget - ELISION.length;
  const head = Math.max(1, Math.floor(usable * 0.6));
  const tail = Math.max(1, usable - head);
  return {
    content: `${content.slice(0, head).trimEnd()}${ELISION}${content.slice(content.length - tail).trimStart()}`,
    truncated: true
  };
}

// How much of what the customer asked for is actually present in the text we
// are about to hand the answer model. Lexical on purpose: it must not need a
// model call, and it only ever decides whether to SEARCH AGAIN.
function supportCoverage(question, sections) {
  const haystack = sections.map((s) => `${s.heading || ""} ${s.content || ""}`).join(" ").toLowerCase();
  const parts = questionParts(question).map((part) => {
    const terms = contentTerms(part);
    const supported = terms.filter((term) => haystack.includes(term));
    return {
      part: part.slice(0, 120),
      terms: terms.length,
      supported: supported.length,
      ratio: terms.length ? supported.length / terms.length : 1,
      missing: terms.filter((term) => !haystack.includes(term)).slice(0, 8)
    };
  });
  const overall = parts.length ? parts.reduce((sum, p) => sum + p.ratio, 0) / parts.length : 0;
  return { overall, parts, unsupported: parts.filter((p) => p.ratio < 0.5) };
}

// Step 7's third outcome. "Missing" and "broken" are about the SEARCH;
// "conflicting" is about the RESULT: two approved sections that both survived
// every governance gate and still disagree on a figure.
//
// Deliberately narrow. It flags DISAGREEMENT, it does not adjudicate it, and
// it only looks at the two value kinds a wrong answer here actually costs
// money on: money amounts and stated durations. Anything subtler is a judgement
// a regex should not be making, and a false conflict is itself a harm -- it
// would suppress a correct number.
const MONEY = /(?:[$€£]\s*([0-9][0-9.,]*)|(?:EUR|USD|GBP)\s*([0-9][0-9.,]*)|([0-9][0-9.,]*)\s*(?:EUR|USD|GBP|euros?|يورو|ευρώ))/giu;
// No `\b` and no `\w` anywhere near the non-Latin alternatives: both are
// ASCII-only in JavaScript, so `\b(?:...|يوم)\b` silently makes every Arabic
// and Greek branch unreachable, and `ημέρ\w*` never matches the Greek suffix it
// was written for. Explicit Unicode-aware lookarounds instead.
const DURATION = /(?<![\p{L}\p{N}])([0-9]{1,3})\s*(days?|weeks?|months?|years?|يوم|أيام|شهر|أشهر|سنة|سنوات|ημέρ\p{L}*|εβδομάδ\p{L}*|μήν\p{L}*|χρόν\p{L}*)(?![\p{L}\p{N}])/giu;

function normalizeNumber(value) {
  return String(value || "")
    // "€999." at the end of a sentence captures the full stop. Left in, it
    // makes "999." and "999" two different values and invents a conflict
    // between a document and itself.
    .replace(/[.,]+$/u, "")
    // Thousands separators: 1,500 and 1.500 are the same amount as 1500.
    .replace(/[.,](?=\d{3}(?:\D|$))/gu, "")
    .replace(/,/gu, ".");
}

function durationUnit(unit) {
  const value = String(unit || "").toLowerCase();
  if (/^(day|days|يوم|أيام)|^ημέρ/u.test(value)) return "day";
  if (/^(week|weeks)|^εβδομάδ/u.test(value)) return "week";
  if (/^(month|months|شهر|أشهر)|^μήν/u.test(value)) return "month";
  return "year";
}

function detectConflicts(sections) {
  const money = new Map();
  const duration = new Map();

  for (const section of sections) {
    const text = String(section.content || "");
    const where = { documentId: section.documentId, chunkId: section.chunkId, title: section.title };

    for (const match of text.matchAll(MONEY)) {
      const amount = normalizeNumber(match[1] || match[2] || match[3]);
      if (!amount) continue;
      if (!money.has(amount)) money.set(amount, []);
      money.get(amount).push(where);
    }
    for (const match of text.matchAll(DURATION)) {
      const key = `${normalizeNumber(match[1])} ${durationUnit(match[2])}`;
      if (!duration.has(key)) duration.set(key, []);
      duration.get(key).push(where);
    }
  }

  const conflicts = [];
  const report = (kind, map) => {
    // A single value repeated across sections is agreement. Two or more
    // DISTINCT values, each anchored in a different document, is a conflict.
    const distinct = [...map.entries()];
    if (distinct.length < 2) return;
    const documents = new Set(distinct.flatMap(([, places]) => places.map((place) => place.documentId)));
    if (documents.size < 2) return;
    conflicts.push({
      kind,
      values: distinct.map(([value, places]) => ({
        value,
        documentIds: [...new Set(places.map((place) => place.documentId))].slice(0, 5),
        titles: [...new Set(places.map((place) => String(place.title || "").slice(0, 60)))].slice(0, 5)
      })).slice(0, 6)
    });
  };
  report("money", money);
  report("duration", duration);
  return conflicts;
}

async function runOneSearch(query, { store, embedding, embeddingModel, options }) {
  const started = Date.now();
  const detailed = typeof store?.searchKnowledgeDetailed === "function";
  try {
    const rows = detailed
      ? await store.searchKnowledgeDetailed(query, {
        embedding,
        embeddingModel: embeddingModel || null,
        matchCount: options.matchCount,
        minCoverage: options.minCoverage,
        minTerms: options.minTerms,
        maxDistance: options.maxDistance
      })
      : typeof store?.searchKnowledge === "function"
        ? await store.searchKnowledge(query, embedding, embeddingModel || null, options.matchCount)
        : [];
    const safeRows = Array.isArray(rows) ? rows : [];
    return {
      query, rows: safeRows, error: null,
      trace: { query: query.slice(0, 200), mode: embedding ? "hybrid" : "lexical", returned: safeRows.length, ms: Date.now() - started }
    };
  } catch (error) {
    return {
      query, rows: [], error,
      trace: { query: query.slice(0, 200), mode: embedding ? "hybrid" : "lexical", returned: 0, ms: Date.now() - started, error: String(error?.message || error).slice(0, 200) }
    };
  }
}

async function embedAll(queries, { embedQueryTexts, embedText }) {
  if (typeof embedQueryTexts === "function") {
    try {
      const vectors = await embedQueryTexts(queries);
      if (Array.isArray(vectors) && vectors.length === queries.length) return { vectors, error: null };
      return { vectors: null, error: new Error("Query embedding batch did not match the knowledge query count.") };
    } catch (error) {
      return { vectors: null, error };
    }
  }
  if (typeof embedText === "function") {
    try {
      return { vectors: await Promise.all(queries.map((query) => embedText(query))), error: null };
    } catch (error) {
      return { vectors: null, error };
    }
  }
  return { vectors: null, error: null };
}

// ----------------------------------------------------------------- the engine
// `planQueries(round, context)` supplies the wordings to try for a round. The
// caller owns query planning (src/knowledgeQuery.js builds the intent-aware
// facets); this module owns rounds, fusion, sections, coverage and the trace.
async function retrieveKnowledge(question, {
  store, embedQueryTexts, embedText, embeddingModel,
  planQueries, language = "english", limits = {}, now = () => Date.now()
} = {}) {
  const options = { ...DEFAULTS, ...limits };
  const startedAt = now();
  const trace = {
    question: redactPersonalData(String(question || "")).slice(0, 300),
    language,
    limits: options,
    rounds: [],
    errors: [],
    sectionsFetched: 0,
    status: "no_evidence"
  };

  const plan = typeof planQueries === "function" ? planQueries : () => [String(question || "")];
  const buckets = [];
  const askedQueries = new Set();
  let candidates = [];
  let sections = [];
  let coverage = { overall: 0, parts: [], unsupported: [] };
  let searchErrors = 0;
  let searchAttempts = 0;

  for (let round = 1; round <= Math.max(1, options.maxRounds); round += 1) {
    const planned = (plan(round, { question, language, coverage, candidates, sections }) || [])
      .map((query) => String(query || "").trim())
      .filter((query) => query && !askedQueries.has(query))
      .slice(0, 8);
    if (!planned.length) break;
    for (const query of planned) askedQueries.add(query);

    const { vectors, error: embeddingError } = await embedAll(planned, { embedQueryTexts, embedText });
    if (embeddingError) trace.errors.push({ stage: "embedding", round, message: String(embeddingError.message || embeddingError).slice(0, 200) });

    const results = await Promise.all(planned.map((query, index) => runOneSearch(query, {
      store, embedding: vectors ? vectors[index] : null, embeddingModel, options
    })));
    searchAttempts += results.length;

    for (const result of results) {
      if (result.error) {
        searchErrors += 1;
        trace.errors.push({ stage: "search", round, query: result.query.slice(0, 120), message: String(result.error.message || result.error).slice(0, 200) });
      }
      buckets.push(result.rows);
    }

    candidates = fuseCandidates(buckets).slice(0, options.maxCandidates);
    trace.rounds.push({
      round,
      queries: results.map((result) => result.trace),
      embeddingFailed: Boolean(embeddingError),
      candidates: candidates.length
    });

    if (!candidates.length) continue;

    sections = await expandToSections(candidates, { store, options, trace });
    coverage = supportCoverage(question, sections);
    trace.rounds[trace.rounds.length - 1].coverage = Number(coverage.overall.toFixed(3));

    if (coverage.overall >= options.coverageTarget) break;
  }

  // Step 7. Every search attempt errored and nothing came back: this is a
  // technical failure, not an empty corpus, and it must not be reported as one.
  const allSearchesFailed = searchAttempts > 0 && searchErrors === searchAttempts;
  const status = candidates.length
    ? (coverage.overall >= options.coverageTarget ? "found" : "partial")
    : allSearchesFailed ? "search_failed" : "no_evidence";

  // Conflicting evidence is reported, never silently resolved. The answer
  // layer decides what to do with a contested figure; retrieval's job is to
  // say that the disagreement exists rather than to pick a side by ranking.
  const conflicts = detectConflicts(sections);
  trace.conflicts = conflicts;
  trace.hasConflict = conflicts.length > 0;

  trace.status = status;
  trace.candidateCount = candidates.length;
  trace.sectionCount = sections.length;
  trace.coverage = Number(coverage.overall.toFixed(3));
  trace.unsupportedParts = coverage.unsupported.map((part) => part.part);
  trace.totalMs = now() - startedAt;
  trace.chunkIds = sections.map((section) => section.chunkId).filter(Boolean).slice(0, 60);
  trace.documentIds = [...new Set(sections.map((section) => section.documentId).filter(Boolean))].slice(0, 30);

  return { status, evidence: sections, candidates, coverage, trace, conflicts, searchFailed: allSearchesFailed };
}

// Step 4. Turn ranked chunks into complete parent sections, in original order,
// inside the context budget.
async function expandToSections(candidates, { store, options, trace }) {
  const chunkIds = candidates.map(rowChunkId).filter(Boolean).slice(0, options.maxSections);
  let rows = null;

  if (chunkIds.length && typeof store?.fetchKnowledgeSections === "function") {
    try {
      rows = await store.fetchKnowledgeSections(chunkIds, {
        maxSections: options.maxSections,
        includeSiblings: true
      });
      trace.sectionsFetched = Array.isArray(rows) ? rows.length : 0;
    } catch (error) {
      trace.errors.push({ stage: "sections", message: String(error?.message || error).slice(0, 200) });
      rows = null;
    }
  }

  // Governance metadata is attached server-side to SEARCH rows only; the
  // section fetch returns document text. Carry it across by chunk id so the
  // fact-register gate still sees it, and so a sibling section inherits the
  // metadata of the match that pulled it in (same document, same governance).
  const policyByChunk = new Map();
  const policyByDocument = new Map();
  for (const row of candidates) {
    const id = rowChunkId(row);
    if (row?.policyMetadata && id) policyByChunk.set(id, row.policyMetadata);
    if (row?.policyMetadata && row?.document_id && !policyByDocument.has(row.document_id)) {
      policyByDocument.set(row.document_id, row.policyMetadata);
    }
  }
  const policyFor = (chunkId, documentId) => policyByChunk.get(chunkId) || policyByDocument.get(documentId) || null;
  const sourceIdByDocument = new Map(candidates.filter((row) => row?.document_id).map((row) => [row.document_id, row.source_id || null]));

  // No section RPC (older deployment, or it failed): the ranked chunks ARE
  // sections, so degrade to them rather than losing the turn.
  const source = Array.isArray(rows) && rows.length
    ? rows.filter((row) => isEvidenceKind(row.chunk_kind)).map((row) => ({
      documentId: row.document_id, chunkId: row.chunk_id, title: row.document_title,
      sourceName: row.source_name, heading: row.heading, content: row.content,
      chunkIndex: row.chunk_index, kind: row.chunk_kind, isMatch: row.is_match === true,
      priority: Number(row.priority) || 999, validUntil: row.valid_until || null,
      sourceId: sourceIdByDocument.get(row.document_id) || null,
      // The chunk's own metadata, carrying `facts`. Without it the blocked-fact
      // gate in src/factRegister.js sees nothing to check and fails open on
      // every sibling section this fetch added.
      metadata: row.metadata || null,
      policyMetadata: policyFor(row.chunk_id, row.document_id)
    }))
    // A finding aid is navigation and a discovery block is a list of questions
    // to ask, not an answer. The section RPC already excludes `aliases`; the
    // degraded path has to apply the same rule or the two routes disagree
    // about what counts as evidence.
    : candidates.filter((row) => isEvidenceKind(rowKind(row))).map((row, index) => ({
      documentId: row.document_id, chunkId: rowChunkId(row), title: row.document_title,
      sourceName: row.source_name, heading: row.heading, content: row.content,
      chunkIndex: row.chunk_index, kind: rowKind(row), isMatch: true,
      priority: index + 1, validUntil: row.valid_until || null, rank: row.rank,
      semanticDistance: row.semantic_distance ?? null, lexicalRank: row.lexical_rank ?? null,
      sourceId: row.source_id || null,
      metadata: row.metadata || null,
      policyMetadata: row.policyMetadata || null
    }));

  // Spend the character budget in priority order (match, then the boundary
  // sections carrying the conditions), then restore reading order so the
  // document still reads top to bottom.
  const byPriority = [...source].sort((a, b) => a.priority - b.priority);
  const kept = [];
  let used = 0;
  for (const section of byPriority) {
    if (kept.length >= options.maxSections) break;
    const bounded = boundSection(section.content, options.maxSectionChars);
    if (used + bounded.content.length > options.maxContextChars && kept.length > 0) continue;
    used += bounded.content.length;
    kept.push({ ...section, content: bounded.content, contentTruncated: bounded.truncated });
  }

  return kept.sort((a, b) => String(a.documentId).localeCompare(String(b.documentId)) || (a.chunkIndex - b.chunkIndex));
}

module.exports = {
  DEFAULTS, STOPWORDS, CONCEPT_ANCHORS, EVIDENCE_KINDS,
  contentTerms, questionParts, anchorQueries, supportCoverage,
  boundSection, fuseCandidates, expandToSections, retrieveKnowledge,
  rowKind, isEvidenceKind, detectConflicts
};
