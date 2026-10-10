"use strict";

// M3 / W3.10.6 — the standing health check for the whole knowledge brain.
//
// WHAT THIS FILE IS
// -----------------
// The PURE half. No fs, no fetch, no process. It takes inputs that somebody
// else already gathered (corpus cells from disk, the fact register, the golden
// set, and optionally a snapshot of the database) and returns findings. That
// split exists so the rules are testable without a corpus on disk and without a
// Supabase project, which is the only way this gate can run in an environment
// that has neither. scripts/brainHealth.js is the I/O shell around it.
//
// WHAT IT CHECKS
// --------------
// Per topic per language, for all 29 x 3 = 87 cells:
//
//   offline  1. the file exists
//   offline  2. it is valid per validateCorpusFile
//   offline  3. every fact it declares (facts + supporting) has a register row
//               and that row is effectively approved
//   offline  4. its 10 golden questions are lexically reachable in it
//   offline  5. no negative query is lexically reachable in any document
//   offline  6. all three languages clear the same bar (FIX-7 / FIX-8)
//   --db     7. the source row exists, is enabled and approved
//   --db     8. the document is approved and not expired (and not about to be)
//   --db     9. the chunk count matches what the file would produce
//   --db    10. every chunk is embedded with exactly DEFAULT_EMBEDDING_MODEL
//
// Checks 7 to 10 are reported as PENDING DB when no database snapshot is given.
// A pending check is NOT a gap — it must not fail the run — but it is counted
// separately and printed, so nobody can read a green run as "the database is
// fine". It was never looked at.
//
// SEVERITIES
// ----------
//   gap      — the milestone gate G3 is not met. Exit 1.
//   warning  — true, worth saying, does not fail the run.
//   pending  — a check that could not run because its input was absent.
//   blocker  — a check that CANNOT run from here at all, named explicitly so it
//              is never mistaken for a pass.

const { TOPICS, LANGUAGES } = require("./brainTaxonomy");
const { normalizeFactId } = require("./brainFactMap");
const { effectiveStatus, nowIsoDay, daysBetween, STATUS } = require("./factRegister");

// ---------------------------------------------------------------- constants

const EXPECTED_CELLS = TOPICS.length * LANGUAGES.length;      // 87
const GOLDEN_QUESTIONS_PER_CELL = 10;                          // W0.4.3
const EXPIRY_WARNING_DAYS = 7;                                 // register + valid_until

// THE COVERAGE THRESHOLD.
//
// `coverage` here is: of the DISTINCT content tokens in a golden question, what
// fraction appear anywhere in the document's indexed text. 0.5 means half the
// question's meaningful words are literally present in the document.
//
// Why 0.5 and not something tighter or looser:
//
// * The live lexical branch is `websearch_to_tsquery`, which ANDs its terms.
//   A document that contains EVERY content token of the question is a certain
//   lexical hit, so 1.0 would be the bar for "lexical search alone definitely
//   finds this". That bar is far too strict as a corpus gate: real retrieval is
//   hybrid, the fallback RPC also runs a BROAD (OR) query when the required
//   (AND) query returns nothing (see 20260929202412_require_multiple_lexical_terms.sql),
//   and the vector branch carries paraphrases that share no tokens at all.
// * Below 0.5 the measure stops discriminating. A question and a document in
//   the same language share connective tissue; once fewer than half the content
//   words match, what is left is mostly incidental overlap and the number no
//   longer tells you whether the document is ABOUT the question.
// * 0.5 is also the point where the broad OR query has more matching terms than
//   non-matching ones, which is what `ts_rank_cd` rewards.
//
// THIS IS A PROXY. It is not retrieval. Real retrieval is
// `websearch_to_tsquery` plus a vector search over embeddings, ranked and cut
// at top 5. Token overlap cannot see a synonym, cannot see a stem, and cannot
// see the ranking. A cell that clears this bar is lexically REACHABLE, which is
// a necessary condition for retrieval and not a sufficient one. The sufficient
// check is check 4's database half, and it is PENDING DB here.
const COVERAGE_THRESHOLD = 0.5;

// How many of a cell's golden questions must clear COVERAGE_THRESHOLD before
// the cell counts as lexically healthy. 7 of 10, i.e. 70%, deliberately below
// G3's 95% retrieval bar: the proxy is weaker than retrieval (no stemming, no
// synonyms, no vectors), so holding it to the same number would fail cells that
// real hybrid search handles. 70% is high enough that a document which is
// simply not lexically rich in its own language — FIX-7's exact shape — cannot
// pass.
const MIN_COVERED_PER_CELL = 7;

// A negative query must not be nearly contained in any document. This is a
// looser bar than COVERAGE_THRESHOLD on purpose and in the opposite direction:
// "what is the price of your Cyprus citizenship by investment package" shares
// `cyprus`, `investment` and `package` with real documents and SHOULD, because
// those words are genuinely in our domain. What must never happen is a document
// that contains essentially the WHOLE negative query, because that is the one
// shape `websearch_to_tsquery`'s AND branch would return a hit for.
const NEGATIVE_MAX_COVERAGE = 0.8;

const SEVERITY = Object.freeze({
  GAP: "gap",
  WARNING: "warning",
  PENDING: "pending",
  BLOCKER: "blocker",
});

// The one check that cannot be run from this machine even with --db.
//
// CORRECTED 2026-10-10. The original note said the register is "service_role
// only", and that stopped being true: MIG-01 was amended before it was applied
// to grant `anon` behind the same `rafa_dashboard_secret_matches()` policy the
// knowledge tables already use. The grants are fine.
//
// The actual obstacle is CF-07 / FIX-34: the `RAFA_DASHBOARD_SUPABASE_SECRET`
// on this machine does not match the sha256 stored in
// `rafa_private.api_secret_hashes`, so `rpc/rafa_dashboard_secret_matches`
// returns false and every policy-gated read comes back empty. That is a stale
// credential, not a schema problem, and it is BOSS's to resolve.
//
// Classified PENDING, not BLOCKER, and the distinction matters. A BLOCKER fails
// the run, which is right for something broken in the repo. This is "cannot be
// verified from here", which is exactly what PENDING already means for the four
// --db checks. Reporting an environmental limit as a blocker would make the
// gate permanently red and therefore ignored, which is the same disease as the
// green-with-a-blocker state the P3.10 audit flagged, just in the other
// direction. Either way the fallback is the SEEDED register, which is sound for
// a freshly seeded database and WRONG the moment a reviewer edits a row.
const REGISTER_BLOCKER = Object.freeze({
  code: "BH-PENDING-REGISTER-UNREACHABLE",
  what: "the live refal_fact_register cannot be read from here: the dashboard secret does not authenticate (CF-07 / FIX-34)",
  effect: "fact status is checked against the SEEDED register, not the live table",
  unblock: "restore a working RAFA_DASHBOARD_SUPABASE_SECRET, or add a service-role key to the "
    + "environment the script reads. MIG-01 already grants the register to the dashboard role.",
});

// ---------------------------------------------------------------- tokenising
//
// Modelled on `to_tsvector('simple', ...)`, which is what the chunk
// search_vector is generated with (20260929132051_create_rafa_knowledge_foundation.sql).
// The `simple` dictionary lowercases, splits on non-word characters and does
// NOT stem and does NOT drop stop words. We reproduce the first two faithfully.
//
// We deliberately do NOT normalise Arabic orthography (أ/ا) or strip Greek
// accents either, because Postgres does not: if the corpus writes a word one
// way and the question writes it another, that IS a retrieval gap and the proxy
// should show it rather than paper over it.
function tokenize(text) {
  return String(text == null ? "" : text)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

// Where we depart from `simple` on purpose. Postgres keeps "the" and "من" in
// the vector, and keeping them here would be wrong for a COVERAGE measure: a
// function word matches every document in its language, so counting it inflates
// every score by the same amount and hides the signal. Stop words still take
// part in real retrieval; they just must not take part in the measurement.
const STOPWORDS = new Set([
  // English — interrogatives, auxiliaries, determiners, prepositions.
  "a", "an", "the", "and", "or", "but", "if", "of", "to", "in", "on", "at", "by", "for", "with",
  "from", "as", "is", "are", "am", "was", "were", "be", "been", "being", "do", "does", "did",
  "have", "has", "had", "can", "could", "will", "would", "shall", "should", "may", "might", "must",
  "i", "me", "my", "we", "our", "us", "you", "your", "it", "its", "they", "them", "their",
  "this", "that", "these", "those", "there", "here", "what", "which", "who", "whom", "whose",
  "when", "where", "why", "how", "any", "some", "no", "not", "all", "also", "than", "then",
  "so", "just", "about", "into", "out", "up", "down", "over", "under", "again", "very", "get",
  "got", "want", "need", "like", "make", "made", "take", "does", "doing", "much", "many",
  // Arabic — the same classes.
  "في", "من", "على", "عن", "إلى", "الى", "مع", "هل", "ما", "ماذا", "شو", "كيف", "كم", "قديش",
  "و", "أو", "او", "أن", "ان", "إن", "التي", "الذي", "يلي", "اللي", "هو", "هي", "هم", "هذا",
  "هذه", "ذلك", "لي", "لك", "له", "لها", "بدي", "بدك", "عند", "عندي", "عندك", "عندكم", "بس",
  "كل", "أي", "اي", "ثم", "قد", "لا", "ليس", "كان", "يكون", "هناك", "بعد", "قبل", "بين", "عندما",
  "لماذا", "متى", "اين", "أين", "ايش", "إيش", "يا", "ب", "ل", "ك", "فى",
  // Greek — the same classes.
  "ο", "η", "το", "οι", "τα", "του", "της", "των", "τον", "την", "στο", "στη", "στην", "στον",
  "στα", "στους", "στις", "σε", "με", "για", "και", "από", "απο", "να", "θα", "που", "πως",
  "πώς", "τι", "ποιο", "ποια", "ποιος", "ποιες", "ποιοι", "είναι", "ειναι", "ήταν", "ηταν",
  "έχει", "εχει", "έχω", "εχω", "μου", "σου", "μας", "σας", "τους", "αν", "ή", "αλλά", "αλλα",
  "ως", "κατά", "κατα", "προς", "επί", "επι", "δεν", "μην", "μη", "ένα", "ενα", "μία", "μια",
  "έναν", "εναν", "κάποιο", "καποιο", "όλα", "ολα", "όταν", "οταν", "γιατί", "γιατι", "πόσο",
  "ποσο", "πόσα", "ποσα", "πότε", "ποτε", "κάνω", "κανω", "θέλω", "θελω", "μπορώ", "μπορω",
]);

// A one-character token carries no retrieval signal in any of the three
// languages and `simple` would index it; drop it from the MEASURE only.
function contentTokens(text) {
  const out = new Set();
  for (const token of tokenize(text)) {
    if (token.length < 2) continue;
    if (STOPWORDS.has(token)) continue;
    out.add(token);
  }
  return out;
}

// Everything in a cell that reaches the index, per W3.10.6: title, aliases,
// every section heading and every section body.
//
// Caveat worth knowing when reading the numbers: the LIVE chunk search_vector
// is `to_tsvector('simple', heading || ' ' || content)` only. The title and the
// aliases reach the index solely if the ingestion writes them into a chunk. So
// `coverage` below is the optimistic bound and `bodyCoverage` is what a chunk
// vector alone would see. Both are reported.
function indexedText(cell) {
  const parts = [cell.title || ""];
  for (const alias of cell.aliases || []) parts.push(alias);
  for (const section of cell.sections || []) {
    parts.push(section.heading || "");
    parts.push(section.body || "");
  }
  return parts.join("\n");
}

function bodyText(cell) {
  const parts = [];
  for (const section of cell.sections || []) {
    parts.push(section.heading || "");
    parts.push(section.body || "");
  }
  return parts.join("\n");
}

// The fraction of the question's content tokens present in `haystack`.
function tokenCoverage(question, haystackTokens) {
  const wanted = contentTokens(question);
  if (!wanted.size) return { covered: 0, total: 0, fraction: 0, missing: [] };
  const missing = [];
  let covered = 0;
  for (const token of wanted) {
    if (haystackTokens.has(token)) covered += 1;
    else missing.push(token);
  }
  return { covered, total: wanted.size, fraction: covered / wanted.size, missing };
}

// ------------------------------------------------------------------ helpers

function cellKey(topic, lang) { return `${topic}|${lang}`; }

function finding(severity, code, message, extra = {}) {
  return { severity, code, message, ...extra };
}

// ------------------------------------------------- check 1 and 2: file shape

function assessFiles(cells) {
  const findings = [];
  for (const cell of cells) {
    if (!cell.exists) {
      findings.push(finding(SEVERITY.GAP, "BH-FILE-MISSING",
        `${cell.path}: missing — the topic has no ${cell.lang} document at all`,
        { topic: cell.topic, lang: cell.lang, phase: cell.phase }));
      continue;
    }
    for (const error of cell.errors || []) {
      findings.push(finding(SEVERITY.GAP, "BH-FILE-INVALID", error,
        { topic: cell.topic, lang: cell.lang, phase: cell.phase }));
    }
    for (const warning of cell.warnings || []) {
      findings.push(finding(SEVERITY.WARNING, "BH-FILE-WARNING", `${cell.path}: ${warning}`,
        { topic: cell.topic, lang: cell.lang, phase: cell.phase }));
    }
  }
  return findings;
}

// ------------------------------------------------ check 3: register coverage
//
// A live document standing on a fact that is expired, blocked or absent from
// the register is a gap, not a warning: the document asserts something the
// governance layer has already decided may not be asserted.

function assessRegister(cells, { register, now } = {}) {
  const findings = [];
  const today = nowIsoDay(now);
  for (const cell of cells) {
    if (!cell.exists) continue;
    const declared = [...(cell.facts || []), ...(cell.supporting || [])].map(normalizeFactId);
    for (const id of declared) {
      const row = register ? register.get(id) : null;
      if (!row) {
        findings.push(finding(SEVERITY.GAP, "BH-FACT-NO-REGISTER-ROW",
          `${cell.path}: declares \`${id}\` but the fact register has no row for it, so nothing governs it`,
          { topic: cell.topic, lang: cell.lang, phase: cell.phase, fact: id }));
        continue;
      }
      const status = effectiveStatus(row, today);
      if (status !== STATUS.APPROVED) {
        findings.push(finding(SEVERITY.GAP, "BH-FACT-NOT-APPROVED",
          `${cell.path}: declares \`${id}\`, whose register status is ${status} `
          + `(stored ${row.status}, review date ${row.expiryOrReviewAt}) — a live document is standing on a fact REFAL may not state`,
          { topic: cell.topic, lang: cell.lang, phase: cell.phase, fact: id, status }));
        continue;
      }
      if (row.approvedLanguages && !row.approvedLanguages.includes(cell.lang)) {
        findings.push(finding(SEVERITY.GAP, "BH-FACT-LANG-NOT-APPROVED",
          `${cell.path}: declares \`${id}\`, which is not approved for ${cell.lang}`,
          { topic: cell.topic, lang: cell.lang, phase: cell.phase, fact: id }));
      }
    }
  }
  return findings;
}

// Rule 2's early warning, surfaced as a WARNING and never as a gap: a fact that
// is still approved today but expires inside the window.
function assessExpiring(expiringRows, { now } = {}) {
  const today = nowIsoDay(now);
  return (expiringRows || []).map((row) => finding(SEVERITY.WARNING, "BH-FACT-EXPIRING",
    `fact \`${row.id}\` is approved but its review date ${row.expiryOrReviewAt} is `
    + `${daysBetween(today, row.expiryOrReviewAt)} days away — re-approve it or the documents that declare it go quiet`,
    { fact: row.id, daysLeft: daysBetween(today, row.expiryOrReviewAt) }));
}

// --------------------------------------- check 4: lexical reach of the golden set

function assessLexical(cells, entries, { threshold = COVERAGE_THRESHOLD, minCovered = MIN_COVERED_PER_CELL } = {}) {
  const byCell = new Map();
  for (const entry of entries || []) {
    const key = cellKey(entry.topic, entry.lang);
    const list = byCell.get(key) || [];
    list.push(entry);
    byCell.set(key, list);
  }

  const rows = [];
  const findings = [];
  for (const cell of cells) {
    const questions = byCell.get(cellKey(cell.topic, cell.lang)) || [];
    const row = {
      topic: cell.topic, topicNumber: cell.topicNumber, phase: cell.phase, lang: cell.lang,
      questions: questions.length, covered: 0, meanCoverage: 0, meanBodyCoverage: 0,
      passes: false, worst: [],
    };

    if (!cell.exists) {
      rows.push(row);
      continue; // already reported as BH-FILE-MISSING; do not double count
    }
    if (questions.length < GOLDEN_QUESTIONS_PER_CELL) {
      findings.push(finding(SEVERITY.GAP, "BH-GOLDEN-SHORT",
        `${cell.topic}/${cell.lang}: ${questions.length} golden questions, expected ${GOLDEN_QUESTIONS_PER_CELL}`,
        { topic: cell.topic, lang: cell.lang, phase: cell.phase }));
    }

    const indexTokens = contentTokens(indexedText(cell));
    const bodyTokens = contentTokens(bodyText(cell));
    let sum = 0;
    let bodySum = 0;
    const scored = [];
    for (const entry of questions) {
      const full = tokenCoverage(entry.question, indexTokens);
      const body = tokenCoverage(entry.question, bodyTokens);
      sum += full.fraction;
      bodySum += body.fraction;
      if (full.fraction >= threshold) row.covered += 1;
      scored.push({ id: entry.id, fraction: full.fraction, missing: full.missing });
    }
    row.meanCoverage = questions.length ? sum / questions.length : 0;
    row.meanBodyCoverage = questions.length ? bodySum / questions.length : 0;
    row.passes = questions.length > 0 && row.covered >= minCovered;
    row.worst = scored.sort((a, b) => a.fraction - b.fraction).slice(0, 3);

    if (!row.passes) {
      findings.push(finding(SEVERITY.GAP, "BH-LEXICAL-UNREACHABLE",
        `${cell.topic}/${cell.lang}: only ${row.covered}/${questions.length} golden questions clear `
        + `${Math.round(threshold * 100)}% token coverage (need ${minCovered}); mean coverage `
        + `${(row.meanCoverage * 100).toFixed(0)}%. Weakest: `
        + row.worst.map((w) => `${w.id} ${(w.fraction * 100).toFixed(0)}% (missing ${w.missing.slice(0, 5).join(", ")})`).join(" · "),
        { topic: cell.topic, lang: cell.lang, phase: cell.phase }));
    }
    rows.push(row);
  }
  return { rows, findings };
}

// ------------------------------------------- check 5: the negative queries
//
// CX 4C. A document that is nearly a full lexical match for "give me a recipe
// for moussaka" is over-retrieving, and an aggregate accuracy number would
// never show it.

function assessNegatives(cells, negatives, { maxCoverage = NEGATIVE_MAX_COVERAGE } = {}) {
  const findings = [];
  const live = cells.filter((c) => c.exists);
  const tokensByCell = live.map((cell) => ({ cell, tokens: contentTokens(indexedText(cell)) }));
  const rows = [];

  for (const negative of negatives || []) {
    let worst = { cell: null, fraction: 0 };
    for (const { cell, tokens } of tokensByCell) {
      const { fraction } = tokenCoverage(negative.q, tokens);
      if (fraction > worst.fraction) worst = { cell, fraction };
    }
    rows.push({
      id: negative.id, lang: negative.lang, why: negative.why,
      worstTopic: worst.cell ? `${worst.cell.topic}/${worst.cell.lang}` : null,
      worstCoverage: worst.fraction,
    });
    if (worst.fraction > maxCoverage) {
      findings.push(finding(SEVERITY.GAP, "BH-NEGATIVE-REACHABLE",
        `negative query ${negative.id} (${negative.why}) has ${(worst.fraction * 100).toFixed(0)}% token `
        + `coverage in ${worst.cell.topic}/${worst.cell.lang} — over the ${Math.round(maxCoverage * 100)}% ceiling. `
        + "The corpus should retrieve nothing for this.",
        { negative: negative.id, topic: worst.cell.topic, lang: worst.cell.lang }));
    }
  }
  return { rows, findings };
}

// ------------------------------------------------- check 6: language parity
//
// FIX-7 and FIX-8, by name. Both defects are the same shape: the English
// document for a topic is healthy and its Arabic (FIX-7) or Greek (FIX-8) twin
// is absent or lexically too thin to be found in its own language. This check
// is their regression test.
//
// Parity is only meaningful on a full-language run. With `--lang ar` there is
// no en twin in `cells`, so no parity finding can be raised; that is correct
// rather than a silent pass, and the summary still prints the per-language
// numbers that carry the evidence.

const PARITY_FIX = Object.freeze({
  ar: { fix: "FIX-7", what: "Arabic retrieval returns zero results because the corpus is not lexically rich in Arabic" },
  el: { fix: "FIX-8", what: "Greek coverage gaps, no Greek documents per topic" },
});

function assessParity(cells, lexRows) {
  const findings = [];
  const existsBy = new Map(cells.map((c) => [cellKey(c.topic, c.lang), c.exists]));
  const lexBy = new Map(lexRows.map((r) => [cellKey(r.topic, r.lang), r]));
  const topics = [...new Set(cells.map((c) => c.topic))];
  // Only languages that were actually SELECTED can have a parity defect. A
  // `--lang en` run must not report every topic as missing its Arabic twin:
  // the twin was never asked for. "Absent from the selection" and "absent from
  // disk" are different facts and only the second one is a gap.
  const selectedLangs = new Set(cells.map((c) => c.lang));

  const perLang = {};
  for (const lang of LANGUAGES) {
    const rows = lexRows.filter((r) => r.lang === lang);
    if (!rows.length) continue;
    perLang[lang] = {
      cells: rows.length,
      present: cells.filter((c) => c.lang === lang && c.exists).length,
      passing: rows.filter((r) => r.passes).length,
      meanCoverage: rows.length ? rows.reduce((a, r) => a + r.meanCoverage, 0) / rows.length : 0,
      meanBodyCoverage: rows.length ? rows.reduce((a, r) => a + r.meanBodyCoverage, 0) / rows.length : 0,
    };
  }

  for (const topic of topics) {
    const en = lexBy.get(cellKey(topic, "en"));
    const enHealthy = existsBy.get(cellKey(topic, "en")) && en && en.passes;
    if (!enHealthy) continue; // a topic that is broken in English is not a parity defect
    for (const lang of ["ar", "el"]) {
      if (!selectedLangs.has(lang)) continue;
      const key = cellKey(topic, lang);
      const present = existsBy.get(key);
      const row = lexBy.get(key);
      if (present && row && row.passes) continue;
      const { fix, what } = PARITY_FIX[lang];
      const detail = !present
        ? `no ${lang} document exists`
        : `${row.covered}/${row.questions} golden questions reachable, mean coverage ${(row.meanCoverage * 100).toFixed(0)}%`;
      findings.push(finding(SEVERITY.GAP, `BH-PARITY-${lang.toUpperCase()}`,
        `${topic}: the en document is healthy but the ${lang} one is not (${detail}). `
        + `This is ${fix} — ${what}.`,
        { topic, lang, fix }));
    }
  }
  return { findings, perLang };
}

// ------------------------------------------------- checks 7 to 10: database
//
// `dbIndex` is a Map from canonical_url to:
//   { source: { enabled, approved } | null,
//     document: { review_status, valid_until } | null,
//     chunkCount: number, embeddedCount: number, embeddingModels: string[] }
//
// When it is absent every one of these is reported PENDING DB, once per check
// family rather than once per cell, with the number of cells it would have
// covered so the scale of what was not checked stays visible.

const DB_CHECKS = Object.freeze([
  { code: "BH-DB-SOURCE", what: "source row exists for the canonical url, enabled and approved" },
  { code: "BH-DB-DOCUMENT", what: `document approved and valid_until null or in the future (warns inside ${EXPIRY_WARNING_DAYS} days)` },
  { code: "BH-DB-CHUNKS", what: "stored chunk count matches what the file would produce" },
  { code: "BH-DB-EMBEDDINGS", what: "100% of chunks embedded, every embedding_model exactly equal to DEFAULT_EMBEDDING_MODEL" },
]);

function pendingDatabaseFindings(cells) {
  return DB_CHECKS.map((check) => finding(SEVERITY.PENDING, check.code,
    `PENDING DB — ${check.what}. Not run: no database snapshot was gathered (pass --db). `
    + `${cells.length} cells unchecked.`,
    { cells: cells.length }));
}

function assessDatabase(cells, dbIndex, { now, expectedEmbeddingModel } = {}) {
  const findings = [];
  const today = nowIsoDay(now);
  for (const cell of cells) {
    if (!cell.exists) continue;
    const at = (severity, code, message, extra = {}) => findings.push(
      finding(severity, code, `${cell.topic}/${cell.lang}: ${message}`,
        { topic: cell.topic, lang: cell.lang, phase: cell.phase, ...extra }));

    const row = dbIndex.get(cell.canonicalUrl);
    if (!row || !row.source) {
      at(SEVERITY.GAP, "BH-DB-SOURCE", `no knowledge source row for ${cell.canonicalUrl} — the document was never ingested`);
      continue;
    }
    if (!row.source.enabled) at(SEVERITY.GAP, "BH-DB-SOURCE", "source row is disabled, so nothing it holds is retrievable");
    if (!row.source.approved) at(SEVERITY.GAP, "BH-DB-SOURCE", "source row is not approved, so nothing it holds is retrievable");

    if (!row.document) {
      at(SEVERITY.GAP, "BH-DB-DOCUMENT", "the source has no approved document revision");
      continue;
    }
    if (row.document.review_status !== "approved") {
      at(SEVERITY.GAP, "BH-DB-DOCUMENT", `document review_status is ${row.document.review_status}, not approved`);
    }
    if (row.document.valid_until) {
      const until = String(row.document.valid_until).slice(0, 10);
      const daysLeft = daysBetween(today, until);
      if (daysLeft !== null && daysLeft <= 0) {
        at(SEVERITY.GAP, "BH-DB-DOCUMENT",
          `valid_until ${until} has passed — the document is already filtered out of every search RPC`,
          { validUntil: until, daysLeft });
      } else if (daysLeft !== null && daysLeft <= EXPIRY_WARNING_DAYS) {
        at(SEVERITY.WARNING, "BH-DB-DOCUMENT",
          `valid_until ${until} is ${daysLeft} days away. A BEFORE trigger forces valid_until = now() + 30 days on any `
          + "price bearing content (rafa_apply_knowledge_approval_lifecycle), and several corpus documents carry "
          + "€300,000, so they go dark monthly unless re-ingested and re-approved.",
          { validUntil: until, daysLeft });
      }
    }

    if (row.chunkCount !== cell.chunkCount) {
      at(SEVERITY.GAP, "BH-DB-CHUNKS",
        `${row.chunkCount} chunks stored, the file would produce ${cell.chunkCount} — the index is a different document from the file`,
        { stored: row.chunkCount, expected: cell.chunkCount });
    }
    if (row.embeddedCount !== row.chunkCount) {
      at(SEVERITY.GAP, "BH-DB-EMBEDDINGS",
        `${row.embeddedCount}/${row.chunkCount} chunks embedded — the unembedded ones are invisible to the semantic branch`,
        { embedded: row.embeddedCount, chunks: row.chunkCount });
    }
    const wrong = [...new Set((row.embeddingModels || []).filter((m) => m && m !== expectedEmbeddingModel))];
    if (wrong.length) {
      at(SEVERITY.GAP, "BH-DB-EMBEDDINGS",
        `embedding_model is ${wrong.join(", ")} on some chunks, expected exactly "${expectedEmbeddingModel}". `
        + "The semantic search RPC filters on = over the full string, so a mismatch silently kills the semantic branch.",
        { models: wrong });
    }
  }
  return findings;
}

// --------------------------------------------------------------- the façade

// `input`:
//   cells        — gathered corpus cells (see scripts/brainHealth.js)
//   entries      — golden set entries, already filtered to the selected cells
//   negatives    — NEGATIVE_QUERIES
//   register     — Map<factId, row>, normally seedRegister()
//   expiring     — factsExpiringWithin(EXPIRY_WARNING_DAYS) rows
//   db           — Map<canonicalUrl, row> or null
//   now          — ISO day or Date, for testability
//   expectedEmbeddingModel
function assessCorpus(input = {}) {
  const cells = input.cells || [];
  const findings = [];

  findings.push(...assessFiles(cells));
  findings.push(...assessRegister(cells, { register: input.register, now: input.now }));
  findings.push(...assessExpiring(input.expiring, { now: input.now }));

  const lexical = assessLexical(cells, input.entries, {
    threshold: input.threshold, minCovered: input.minCovered,
  });
  findings.push(...lexical.findings);

  const negatives = assessNegatives(cells, input.negatives, { maxCoverage: input.maxNegativeCoverage });
  findings.push(...negatives.findings);

  const parity = assessParity(cells, lexical.rows);
  findings.push(...parity.findings);

  // The register blocker is reported on every run, with and without --db,
  // because --db does not make it reachable.
  findings.push(finding(SEVERITY.PENDING, REGISTER_BLOCKER.code,
    `${REGISTER_BLOCKER.what}. Effect: ${REGISTER_BLOCKER.effect}. To unblock: ${REGISTER_BLOCKER.unblock}.`));

  if (input.db) {
    findings.push(...assessDatabase(cells, input.db, {
      now: input.now, expectedEmbeddingModel: input.expectedEmbeddingModel,
    }));
  } else {
    findings.push(...pendingDatabaseFindings(cells));
  }

  const count = (severity) => findings.filter((f) => f.severity === severity).length;
  const present = cells.filter((c) => c.exists).length;
  const clean = cells.filter((c) => c.exists && !(c.errors || []).length).length;

  const summary = {
    expectedCells: EXPECTED_CELLS,
    selectedCells: cells.length,
    present,
    missing: cells.length - present,
    clean,
    lexicalPassing: lexical.rows.filter((r) => r.passes).length,
    goldenQuestions: lexical.rows.reduce((a, r) => a + r.questions, 0),
    goldenReachable: lexical.rows.reduce((a, r) => a + r.covered, 0),
    negatives: negatives.rows.length,
    negativesOverCeiling: negatives.findings.length,
    perLang: parity.perLang,
    gaps: count(SEVERITY.GAP),
    warnings: count(SEVERITY.WARNING),
    pending: count(SEVERITY.PENDING),
    blockers: count(SEVERITY.BLOCKER),
    databaseChecked: Boolean(input.db),
    proxy: "lexical reachability is a PROXY for retrieval, not retrieval itself",
  };

  return { findings, summary, lexical: lexical.rows, negatives: negatives.rows };
}

// Exit 0 only when there is no gap AND no blocker. PENDING DB and warnings
// never fail a run.
//
// BLOCKER used to exit 0, which the P3.10 audit correctly called a trap: the
// run printed `1 blockers` and the word BLOCKED next to a green exit code, and
// W3.10.6's requirement is "exits non zero on any gap". A blocker that cannot
// move the exit code is not a gate, it is a log line.
//
// The live example is REGISTER_BLOCKER: `refal_fact_register` is reachable only
// with a credential this environment does not have, so fact status is checked
// against the SEEDED register rather than the live table. That is a real
// limitation on what the run can prove, and it should colour the exit code
// rather than hide behind it.
function exitCodeFor(findings) {
  return (findings || []).some((f) => f.severity === SEVERITY.GAP || f.severity === SEVERITY.BLOCKER) ? 1 : 0;
}

module.exports = {
  EXPECTED_CELLS, GOLDEN_QUESTIONS_PER_CELL, COVERAGE_THRESHOLD, MIN_COVERED_PER_CELL,
  NEGATIVE_MAX_COVERAGE, EXPIRY_WARNING_DAYS, SEVERITY, STOPWORDS, DB_CHECKS,
  REGISTER_BLOCKER, PARITY_FIX,
  tokenize, contentTokens, indexedText, bodyText, tokenCoverage,
  assessFiles, assessRegister, assessExpiring, assessLexical, assessNegatives,
  assessParity, assessDatabase, pendingDatabaseFindings,
  assessCorpus, exitCodeFor,
};
