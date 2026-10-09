"use strict";

// M3 / P3.1-P3.8 — the canonical topic -> MB fact map.
//
// WHY THIS FILE EXISTS
// --------------------
// Three places name MB facts and they did not agree:
//   1. docs/brain/SOURCE-ANALYSIS.md      — the extraction, MB-F1 .. MB-F66
//   2. .planning/REFAL-BRAIN-MASTER-PLAN.md section M3 — the per phase checklists
//   3. src/brainGoldenSet.*.js            — expectedFacts on 870 golden questions
//
// (1) and (2) agree. (3) carried a MECHANICAL PLACEHOLDER: topic n was given
// `MB-F0${n+5}`, which happens to be right for topics 9..18 and wrong for
// topics 1..8 and 19..29. See FIX-28 in section 15 of the plan.
//
// This module is the single source of truth. The golden set, the corpus
// validator, the fact register and brainHealth all read it, so the mapping
// can never drift into three copies again.
//
// ID FORM: unpadded, exactly as SOURCE-ANALYSIS writes it. `MB-F6`, never
// `MB-F06`. normalizeFactId() accepts the padded legacy form and repairs it so
// an old reference is corrected rather than silently missed.

const { TOPICS, topicBySlug } = require("./brainTaxonomy");

// ---------------------------------------------------------------- fact ranges
const FACT_IDS = Object.freeze([
  ...Array.from({ length: 66 }, (_, i) => `MB-F${i + 1}`),
  ...Array.from({ length: 5 }, (_, i) => `MB-C${i + 1}`),
  ...Array.from({ length: 5 }, (_, i) => `MB-J${i}`), // MB-J0 is the posture rule
  ...Array.from({ length: 6 }, (_, i) => `MB-DYN${i + 1}`),
]);
const FACT_ID_SET = new Set(FACT_IDS);

const FACT_ID_PATTERN = /^MB-(?:F(?:[1-9]|[1-5][0-9]|6[0-6])|C[1-5]|J[0-4]|DYN[1-6])$/u;

// `MB-F06` -> `MB-F6`. Anything else is returned unchanged so the caller's
// own validation reports it rather than this function guessing.
function normalizeFactId(raw) {
  const id = String(raw || "").trim().toUpperCase();
  const padded = /^MB-(F|C|J|DYN)0+(\d+)$/u.exec(id);
  if (padded) return `MB-${padded[1]}${padded[2]}`;
  return id;
}

function isFactId(raw) { return FACT_ID_SET.has(normalizeFactId(raw)); }

const range = (prefix, from, to) =>
  Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}`);

// ------------------------------------------------------- topic -> facts owned
// `required` — the corpus document for this topic MUST state every one of these
//              in all three languages. brainHealth fails if one is missing.
// `boundary` — a limitation or refusal rule that belongs to this topic. It is
//              required too, but it must live in a `kind: boundary` section so
//              a persuasive example can never override it (authoring standard
//              6, CX 2A).
// `dynamic`  — an MB-DYN variable this topic touches. Its VALUE must never
//              appear as a literal in the corpus; the topic describes the thing
//              and the live table supplies the number (M4).
// `supporting`— a fact ANOTHER topic owns that this topic may legitimately
//              reference. It does NOT have to be stated, and the owning topic
//              stays responsible for keeping it reviewed.
//
// Why `supporting` exists. Four corpus authors and the golden-set repair hit the
// same wall independently: the IP Box page needs the 15% headline rate for its
// own 2.5% to 3% to mean anything; the property VAT page needs the EUR 300,000
// residency threshold to explain that the two do NOT interact; "how long does
// registration take" is a lifecycle question answered by a formation-package
// fact; "can I use my home address" is a registered-office question answered by
// MB-F7. The only alternatives were an unsourced sentence or a second copy of
// the fact in another topic, and two copies of a number drift apart. Listing the
// reference here keeps one owner per fact and still lets the register govern
// every place the number appears.
const TOPIC_FACTS = Object.freeze({
  // ---- 1-8 corporate (P3.1)
  "company-lifecycle":            { required: ["MB-F1"], boundary: [], dynamic: [], supporting: ["MB-F2", "MB-F18"] },
  "formation-package":            { required: range("MB-F", 2, 8), boundary: ["MB-F9"], dynamic: ["MB-DYN6"] },
  "company-structures":           { required: ["MB-F10"], boundary: [], dynamic: [] },
  "shareholder-vs-director":      { required: range("MB-F", 11, 13), boundary: [], dynamic: [] },
  "ownership-changes":            { required: ["MB-F14"], boundary: [], dynamic: [] },
  "registered-vs-physical-office":{ required: ["MB-F15"], boundary: [], dynamic: [], supporting: ["MB-F7"] },
  "privacy-vs-concealment":       { required: ["MB-F16"], boundary: ["MB-F16"], dynamic: [] },
  "dormant-and-liquidation":      { required: ["MB-F17", "MB-F18"], boundary: [], dynamic: [] },
  // ---- 9-13 tax (P3.2)
  "corporate-tax":                { required: ["MB-F19"], boundary: ["MB-F23"], dynamic: [] },
  "ip-box":                       { required: ["MB-F20", "MB-F21"], boundary: ["MB-F21"], dynamic: [], supporting: ["MB-F19"] },
  "dividends-vs-salary":          { required: ["MB-F22"], boundary: ["MB-F23"], dynamic: [] },
  "holding-vs-trading":           { required: range("MB-F", 24, 27), boundary: [], dynamic: [] },
  "vat-and-eori":                 { required: ["MB-F26", "MB-F27"], boundary: [], dynamic: [] },
  // ---- 14 banking (P3.3)
  "banking-and-payment-gateways": { required: ["MB-F28", "MB-F29"], boundary: ["MB-F28", "MB-F29"], dynamic: [] },
  // ---- 15-18 residency (P3.4)
  "permanent-residency":          { required: [...range("MB-F", 30, 33), ...range("MB-F", 38, 41)], boundary: [], dynamic: [] },
  "non-dom-status":               { required: ["MB-F34"], boundary: [], dynamic: [] },
  "source-of-funds-vs-wealth":    { required: range("MB-F", 35, 37), boundary: ["MB-F37"], dynamic: [] },
  "relocation-checklist":         { required: range("MB-F", 42, 44), boundary: ["MB-F44"], dynamic: ["MB-DYN5"] },
  // ---- 19-22 real estate (P3.5)
  "property-buyer-journey":       { required: ["MB-F45"], boundary: ["MB-F50"], dynamic: ["MB-DYN1", "MB-DYN2"] },
  "offplan-vs-completed":         { required: ["MB-F46", "MB-F47"], boundary: [], dynamic: ["MB-DYN1"] },
  "property-vat":                 { required: ["MB-F48", "MB-F49"], boundary: ["MB-F49"], dynamic: [], supporting: ["MB-F30"] },
  "cyprus-cities":                { required: range("MB-F", 51, 54), boundary: ["MB-F55"], dynamic: ["MB-DYN1"] },
  // ---- 23-24 legal / development (P3.6)
  "landowners-and-construction":  { required: range("MB-F", 56, 62), boundary: ["MB-F62"], dynamic: [] },
  "legal-ip-contracts":           { required: range("MB-F", 63, 66), boundary: [], dynamic: [] },
  // ---- 25 identity (P3.7)
  "company-profile":              { required: range("MB-C", 1, 5), boundary: [], dynamic: [] },
  // ---- 26-29 jurisdiction comparisons (P3.8)
  "jurisdiction-dubai":           { required: ["MB-J0", "MB-J1"], boundary: ["MB-J0"], dynamic: [] },
  "jurisdiction-estonia":         { required: ["MB-J0", "MB-J2"], boundary: ["MB-J0"], dynamic: [] },
  "jurisdiction-malta-bulgaria":  { required: ["MB-J0", "MB-J3"], boundary: ["MB-J0"], dynamic: [] },
  "jurisdiction-usa":             { required: ["MB-J0", "MB-J4"], boundary: ["MB-J0"], dynamic: [] },
});

// ------------------------------------------------------------- owning phase
const TOPIC_PHASE = Object.freeze({
  1: "P3.1", 2: "P3.1", 3: "P3.1", 4: "P3.1", 5: "P3.1", 6: "P3.1", 7: "P3.1", 8: "P3.1",
  9: "P3.2", 10: "P3.2", 11: "P3.2", 12: "P3.2", 13: "P3.2",
  14: "P3.3",
  15: "P3.4", 16: "P3.4", 17: "P3.4", 18: "P3.4",
  19: "P3.5", 20: "P3.5", 21: "P3.5", 22: "P3.5",
  23: "P3.6", 24: "P3.6",
  25: "P3.7",
  26: "P3.8", 27: "P3.8", 28: "P3.8", 29: "P3.8",
});

// --------------------------------------------------- values frozen nowhere
// MB 5.3 names six variables that must never be frozen into a prompt or a
// chunk. Only two of them have a LITERAL that can be written by accident into
// the M3 corpus: the headline package price (MB-DYN6 / MB-F9) and a reservation
// deposit amount (MB-DYN2 / MB-F50). The others are per-unit or per-slot data
// that no authored document would carry anyway.
//
// Every pattern below is checked against the title, the aliases AND the body of
// every corpus file. Matching one is a hard validator failure, not a warning.
//
// Why all three surfaces: the aliases are lexical anchors that get indexed, and
// the golden questions literally contain the price, so "copy the customer's
// phrasing into the aliases" is a direct route to freezing the number. Checking
// only the body would leave that door open.
const FORBIDDEN_CORPUS_LITERALS = Object.freeze([
  // Two patterns, deliberately. The first catches TODAY's value. The second
  // catches the CONCEPT, so the guard does not quietly stop guarding the day the
  // offer changes to a different number.
  { id: "DYN6-price", why: "MB-DYN6 / MB-F9: the package price is served from refal_offers_and_pricing (MIG-02), never frozen in a chunk",
    pattern: /(?:€|eur|euro|ευρώ|يورو)\s*9\s*9\s*9|9\s*9\s*9\s*(?:€|eur\b|euro|ευρώ|يورو)|[٩]{3}/iu },
  { id: "DYN6-package-price", why: "MB-DYN6: no price may be attached to the formation package at all, whatever the figure is today",
    pattern: /(?:package|offer|promotion|الباقة|باقة|باقه|العرض|عرض|πακέτο|πακετο|προσφορά|προσφορα)[^.\n]{0,60}(?:€|eur\b|euro|ευρώ|يورو)\s*[\d٠-٩]|(?:€|eur\b|euro|ευρώ|يورو)\s*[\d٠-٩][\d٠-٩.,]*[^.\n]{0,40}(?:package|الباقة|باقة|باقه|πακέτο|πακετο)/iu },
  { id: "DYN2-deposit", why: "MB-DYN2 / MB-F50: a reservation deposit amount is per project and comes from the live property database",
    pattern: /(?:reservation|booking|κράτηση|κρατησ|حجز|عربون)[^.\n]{0,60}(?:€|eur\b|euro|ευρώ|يورو)\s*[\d٠-٩][\d٠-٩.,]*|(?:€|eur\b|euro|ευρώ|يورو)\s*[\d٠-٩][\d٠-٩.,]*[^.\n]{0,40}(?:reservation deposit|deposit to reserve|προκαταβολή κράτησης|عربون الحجز)/iu },
]);

// A connector dash is banned in every customer facing surface (anti-regression
// 0.2). A markdown list marker at the start of a line is not a connector.
const CONNECTOR_DASH_PATTERN = /\S[ \t]+[-–—][ \t]+\S|—/u;

// ---------------------------------------------------------------- accessors
function factsForTopic(slug) {
  const entry = TOPIC_FACTS[slug];
  if (!entry) throw new Error(`Unknown topic slug: ${slug}`);
  return entry;
}

// Everything the document must state: required plus boundary, de-duplicated and
// in catalogue order so two callers always see the same list.
function requiredFactsForTopic(slug) {
  const { required, boundary } = factsForTopic(slug);
  const seen = new Set([...required, ...boundary]);
  return FACT_IDS.filter((id) => seen.has(id));
}

// Facts this topic may reference but does not own. A document declares a subset
// of these in its `supporting:` frontmatter key, and a golden question for this
// topic may expect one of them.
function supportingFactsForTopic(slug) {
  const { supporting = [] } = factsForTopic(slug);
  const owned = new Set(requiredFactsForTopic(slug));
  const seen = new Set(supporting.map(normalizeFactId));
  // A supporting entry that the topic already owns is a mistake, not a synonym.
  for (const id of seen) {
    if (owned.has(id)) throw new Error(`${slug} lists ${id} as supporting but already owns it`);
    if (!FACT_ID_SET.has(id)) throw new Error(`${slug} lists an unknown supporting fact ${id}`);
  }
  return FACT_IDS.filter((id) => seen.has(id));
}

// Everything a document or a golden question for this topic may legitimately
// name: what it owns plus what it may cite.
function citableFactsForTopic(slug) {
  const allowed = new Set([...requiredFactsForTopic(slug), ...supportingFactsForTopic(slug)]);
  return FACT_IDS.filter((id) => allowed.has(id));
}

function phaseForTopic(slug) {
  const topic = topicBySlug(slug);
  if (!topic) throw new Error(`Unknown topic slug: ${slug}`);
  return TOPIC_PHASE[topic.n];
}

function topicsForPhase(phase) {
  return TOPICS.filter((t) => TOPIC_PHASE[t.n] === phase);
}

// Which topic owns a fact. A fact may legitimately be stated by more than one
// topic (MB-F26 is shared by holding-vs-trading and vat-and-eori), so this
// returns a list.
function topicsStatingFact(factId) {
  const id = normalizeFactId(factId);
  return TOPICS.filter((t) => requiredFactsForTopic(t.slug).includes(id)).map((t) => t.slug);
}

// Every fact in the catalogue that no topic states. A non-empty result means
// the corpus cannot possibly satisfy "every MB module 2 fact is retrievable".
function orphanFacts() {
  const stated = new Set(TOPICS.flatMap((t) => requiredFactsForTopic(t.slug)));
  return FACT_IDS.filter((id) => !stated.has(id) && !id.startsWith("MB-DYN"));
}

module.exports = {
  FACT_IDS, FACT_ID_PATTERN, TOPIC_FACTS, TOPIC_PHASE,
  FORBIDDEN_CORPUS_LITERALS, CONNECTOR_DASH_PATTERN,
  normalizeFactId, isFactId, factsForTopic, requiredFactsForTopic,
  supportingFactsForTopic, citableFactsForTopic,
  phaseForTopic, topicsForPhase, topicsStatingFact, orphanFacts,
};
