"use strict";

// M3 / P3.1-P3.10 — the knowledge corpus file format, its parser and its rules.
//
// 29 topics x 3 languages = 87 files at knowledge/<topic-slug>/<lang>.md.
// Every one is authored by hand (or by a parallel authoring agent) and then has
// to survive this validator before it may be ingested. The validator exists so
// that twelve people writing in three languages converge on ONE shape instead
// of twelve, and so that the plan's authoring standard is machine checked
// rather than remembered.
//
// FILE SHAPE
// ----------
//   ---
//   topic: company-lifecycle
//   lang: en
//   title: The life cycle of a Cyprus company
//   facts: MB-F1
//   aliases: open a company in cyprus | company setup steps | ...
//   ---
//
//   ## What the life cycle actually is
//   <!-- facts: MB-F1 -->
//   Body ...
//
//   ## What we do not decide for you
//   <!-- kind: boundary -->
//   Body ...
//
// Frontmatter is deliberately NOT yaml. A yaml parser is a dependency, and the
// Arabic and Greek alias lists contain commas and colons that trip naive yaml.
// Aliases are pipe separated for exactly that reason.
//
// The `<!-- ... -->` directive under each heading carries the fact ids and the
// section kind. It is an HTML comment so that it is stripped before the chunk
// text is embedded: retrieval must never see `MB-F1` as content.

const {
  requiredFactsForTopic, supportingFactsForTopic, normalizeFactId, isFactId, topicsStatingFact,
  FORBIDDEN_CORPUS_LITERALS, CONNECTOR_DASH_PATTERN,
} = require("./brainFactMap");
const { topicBySlug, LANGUAGES, canonicalUrl } = require("./brainTaxonomy");
const { ROWS: CATALOGUE_ROWS } = require("./factCatalogue");

const MAX_SECTION_CHARS = 1800;   // authoring standard 1
const MIN_SECTION_CHARS = 120;    // a heading with two words is not a chunk
const MIN_SECTIONS = 3;
const MIN_ALIASES = 6;            // authoring standard 3 / W3.10.4
const REQUIRED_KEYS = Object.freeze(["topic", "lang", "title", "facts", "aliases"]);
// `supporting` is the one optional key. A document OWNS the facts in `facts`
// and must state every one of them. It may also REFERENCE a fact another topic
// owns, and that is what `supporting` declares.
//
// Four authors hit the same wall independently during P3.1 to P3.5: the IP Box
// page needs the 15% headline rate to make its own rate mean anything, the
// property VAT page needs the residency threshold to explain that the two do
// not interact, and a registered-address question is really answered by a
// formation-package fact. Without `supporting` the only options were to leave
// the sentence unsourced or to duplicate the fact into a second topic, and
// duplication is how two copies of a number drift apart.
//
// A supporting fact is still governed: its register row decides whether the
// number may be stated, and the ingestion script records it on the chunk, so a
// blocked or expired fact takes the referencing document with it.
const OPTIONAL_KEYS = Object.freeze(["supporting"]);
const KNOWN_KEYS = Object.freeze([...REQUIRED_KEYS, ...OPTIONAL_KEYS]);
const SECTION_KINDS = Object.freeze(["fact", "boundary", "example", "discovery"]);

const DIRECTIVE_LINE = /^<!--\s*(.*?)\s*-->$/u;
const HEADING_LINE = /^##\s+(\S.*)$/u;
const ARABIC = /[؀-ۿ]/gu;
const GREEK = /[Ͱ-Ͽἀ-῿]/gu;
const LATIN = /[A-Za-z]/gu;

// ------------------------------------------------------------------- parsing
function parseFrontmatter(text) {
  const lines = text.split(/\r?\n/u);
  if (lines[0] !== "---") return { error: "file must start with a --- frontmatter fence", meta: null, bodyLine: 0 };
  const end = lines.indexOf("---", 1);
  if (end === -1) return { error: "frontmatter fence is never closed", meta: null, bodyLine: 0 };

  const meta = {};
  for (let i = 1; i < end; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    const at = line.indexOf(":");
    if (at === -1) return { error: `frontmatter line ${i + 1} has no key: ${line}`, meta: null, bodyLine: 0 };
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (key in meta) return { error: `duplicate frontmatter key: ${key}`, meta: null, bodyLine: 0 };
    meta[key] = value;
  }
  return { error: null, meta, bodyLine: end + 1 };
}

function splitList(value, separator) {
  return String(value || "")
    .split(separator)
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseDirective(raw) {
  // `facts: MB-F1, MB-F2; kind: boundary` in any order, either part optional.
  const out = { kind: "fact", facts: [], unknown: [] };
  for (const part of splitList(raw, ";")) {
    const at = part.indexOf(":");
    if (at === -1) { out.unknown.push(part); continue; }
    const key = part.slice(0, at).trim().toLowerCase();
    const value = part.slice(at + 1).trim();
    if (key === "facts") out.facts = splitList(value, ",").map(normalizeFactId);
    else if (key === "kind") out.kind = value.toLowerCase();
    else out.unknown.push(part);
  }
  return out;
}

// Returns { meta, sections, error }. `sections` is [{ heading, kind, facts,
// body, startLine }]. `body` has the directive comments removed, which is
// exactly the text that gets chunked and embedded.
function parseCorpusFile(text) {
  const { error, meta, bodyLine } = parseFrontmatter(text);
  if (error) return { error, meta: null, sections: [] };

  const lines = text.split(/\r?\n/u);
  const sections = [];
  let current = null;
  let preamble = [];

  for (let i = bodyLine; i < lines.length; i += 1) {
    const line = lines[i];
    const heading = HEADING_LINE.exec(line);
    if (heading) {
      if (current) sections.push(current);
      current = { heading: heading[1].trim(), kind: "fact", facts: [], directive: null, bodyLines: [], startLine: i + 1 };
      continue;
    }
    const directive = DIRECTIVE_LINE.exec(line.trim());
    if (directive) {
      if (current && current.directive === null && current.bodyLines.join("").trim() === "") {
        current.directive = parseDirective(directive[1]);
        current.kind = current.directive.kind;
        current.facts = current.directive.facts;
      }
      continue; // a comment is never body text, wherever it sits
    }
    if (current) current.bodyLines.push(line);
    else preamble.push(line);
  }
  if (current) sections.push(current);

  for (const s of sections) s.body = s.bodyLines.join("\n").trim();

  return {
    error: null,
    meta: {
      topic: meta.topic, lang: meta.lang, title: meta.title,
      facts: splitList(meta.facts, ",").map(normalizeFactId),
      supporting: splitList(meta.supporting, ",").map(normalizeFactId),
      aliases: splitList(meta.aliases, "|"),
      raw: meta,
    },
    preamble: preamble.join("\n").trim(),
    sections,
  };
}

// ------------------------------------------------------------ numeric claims
//
// Three authoring agents independently reported the same hole during P3.1:
// FORBIDDEN_CORPUS_LITERALS named two of the six MB-DYN variables, so a frozen
// renewal fee, a government fee, a monthly rent or an invented foreign tax rate
// all passed a green validator. Adding four more hand-written regexes would
// have left the same shape of hole one variable wider.
//
// So the rule is inverted. Instead of listing what may not be written, the
// validator derives what MAY be written: a currency amount or a percentage is
// allowed in a document only if one of the facts that document declares has
// that number in its register row. Everything else is an unapproved frozen
// number, whichever MB-DYN variable it happens to belong to.
//
// That one rule covers all six dynamic variables, MB-F44's cost of living, and
// the P3.8 instruction that a jurisdiction comparison which cannot be sourced is
// cut rather than softened. A fabricated "Dubai is 9%" has no register row, so
// it fails.
//
// Durations, counts and years are deliberately NOT scanned. "ten stages" and
// "four categories" are prose, and a scanner strict enough to catch them would
// cry wolf often enough to be switched off.

const ARABIC_INDIC = { "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4", "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9" };
const CURRENCY = String.raw`€|\bEUR\b|\beuro?s?\b|ευρώ|يورو`;
const DIGITS = String.raw`[\d٠-٩][\d٠-٩.,٫٬   ]*[\d٠-٩]|[\d٠-٩]`;
const AMOUNT_PATTERN = new RegExp(String.raw`(?:${CURRENCY})\s*(${DIGITS})|(${DIGITS})\s*(?:${CURRENCY})`, "giu");
const RATE_PATTERN = new RegExp(String.raw`(${DIGITS})\s*%|%\s*(${DIGITS})`, "giu");

// A bare number with no currency symbol next to it is usually prose ("ten
// stages", "four categories"). Next to a money word it is a frozen price with
// the symbol left off, which is the one way a dynamic figure can still slip
// past the two patterns above. Reported by the P3.5 author: "the reservation is
// 5000" and the Greek "προκαταβολή 5.000" both read as money to a customer.
const MONEY_WORD = [
  "deposit", "fee", "fees", "price", "cost", "costs", "charge", "charges", "rent", "budget",
  "عربون", "رسوم", "سعر", "تكلفة", "أجرة", "ايجار", "إيجار", "دفعة",
  "προκαταβολή", "προκαταβολη", "τέλος", "τέλη", "τελη", "τιμή", "τιμη", "κόστος", "κοστος", "ενοίκιο", "ενοικιο",
].join("|");
const BARE_MONEY_PATTERN = new RegExp(
  String.raw`(?:${MONEY_WORD})[^.\n]{0,30}?\b(\d[\d.,  ]{2,}\d|[٠-٩][٠-٩.,٫٬  ]{2,}[٠-٩])|\b(\d[\d.,  ]{2,}\d|[٠-٩][٠-٩.,٫٬  ]{2,}[٠-٩])[^.\n]{0,20}?(?:${MONEY_WORD})`,
  "giu",
);

// "300,000" and "300.000" and "٣٠٠٬٠٠٠" are the same number. "2.5" is not 25.
function normalizeNumber(raw) {
  let text = String(raw).replace(/[٠-٩]/gu, (d) => ARABIC_INDIC[d]).replace(/\s/gu, "");
  text = text.replace(/٫/gu, ".").replace(/٬/gu, ",");

  const lastComma = text.lastIndexOf(",");
  const lastDot = text.lastIndexOf(".");
  const separators = (text.match(/[,.]/gu) || []).length;

  // Which separator is the DECIMAL mark, decided by position and never by
  // glyph. An earlier cut stripped every comma, which turned the Greek "2,5%"
  // into 25 and reported a correctly authored IP Box rate as unapproved.
  let decimalAt = -1;
  if (lastComma !== -1 && lastDot !== -1) {
    // Both present: whichever comes last is the decimal, the other groups.
    decimalAt = Math.max(lastComma, lastDot);
  } else if (separators === 1) {
    // A lone separator with exactly three digits after it groups thousands
    // ("300,000", "300.000"). Anything else is a decimal ("2,5", "12.50").
    const at = lastComma !== -1 ? lastComma : lastDot;
    if (!/^\d{3}$/u.test(text.slice(at + 1))) decimalAt = at;
  }
  // Two or more separators of the same kind always group ("1,234,567").

  const whole = text.slice(0, decimalAt === -1 ? text.length : decimalAt).replace(/[,.]/gu, "");
  const fraction = decimalAt === -1 ? "" : text.slice(decimalAt + 1).replace(/[,.]/gu, "");
  text = fraction ? `${whole}.${fraction}` : whole;
  if (!/^\d+(?:\.\d+)?$/u.test(text)) return null;
  return String(Number(text));
}

function extractNumbers(text, pattern) {
  const found = [];
  const re = new RegExp(pattern.source, pattern.flags);
  let match = re.exec(text);
  while (match) {
    const raw = match[1] ?? match[2];
    const normalized = normalizeNumber(raw);
    if (normalized !== null) found.push({ raw: match[0].trim(), value: normalized });
    match = re.exec(text);
  }
  return found;
}

// Every number any of these facts is approved to assert, whatever its kind. A
// fact's `numbers` entries are free text like "€300,000 plus VAT" or
// "2.5% to 3%", so both endpoints of a range are harvested.
function approvedNumbersFor(factIds) {
  const allowed = new Set();
  const byId = new Map(CATALOGUE_ROWS.map((row) => [normalizeFactId(row.id), row]));
  for (const id of factIds) {
    const row = byId.get(normalizeFactId(id));
    if (!row) continue;
    for (const entry of row.numbers || []) {
      for (const token of String(entry.value).match(new RegExp(DIGITS, "gu")) || []) {
        const normalized = normalizeNumber(token);
        if (normalized !== null) allowed.add(normalized);
      }
    }
  }
  return allowed;
}

function validateNumericClaims(text, factIds) {
  const allowed = approvedNumbersFor(factIds);
  const problems = [];
  for (const [kind, pattern] of [["amount", AMOUNT_PATTERN], ["rate", RATE_PATTERN], ["amount", BARE_MONEY_PATTERN]]) {
    for (const hit of extractNumbers(text, pattern)) {
      if (allowed.has(hit.value)) continue;
      problems.push(
        `unapproved ${kind} "${hit.raw}" — no fact this document declares has that number in its register row. ` +
        `A figure is either carried by an approved fact or it is dynamic data that is read live, never frozen here.`,
      );
    }
  }
  return problems;
}

// --------------------------------------------------------------- script mix
function scriptRatios(text) {
  const stripped = text.replace(/[^\p{L}]/gu, "");
  const total = stripped.length || 1;
  return {
    arabic: (stripped.match(ARABIC) || []).length / total,
    greek: (stripped.match(GREEK) || []).length / total,
    latin: (stripped.match(LATIN) || []).length / total,
  };
}

// Arabic and Greek documents legitimately carry Latin terms (VAT, EORI, IP Box,
// Stripe, Ltd), so the floor is deliberately not 90%. It is high enough that an
// English document filed as ar.md cannot pass.
const SCRIPT_FLOOR = Object.freeze({ ar: 0.45, el: 0.45, en: 0.80 });

// ---------------------------------------------------------------- validation
function validateCorpusFile(text, { topicSlug, lang, path = "" } = {}) {
  const errors = [];
  const warnings = [];
  const at = (msg) => errors.push(path ? `${path}: ${msg}` : msg);

  const parsed = parseCorpusFile(text);
  if (parsed.error) { at(parsed.error); return { errors, warnings, parsed: null }; }
  const { meta, sections, preamble } = parsed;

  for (const key of REQUIRED_KEYS) {
    if (!meta.raw[key]) at(`frontmatter is missing required key \`${key}\``);
  }
  if (errors.length) return { errors, warnings, parsed };

  // ---- identity: the frontmatter must agree with where the file lives
  const topic = topicBySlug(meta.topic);
  if (!topic) at(`unknown topic \`${meta.topic}\``);
  if (topicSlug && meta.topic !== topicSlug) at(`frontmatter topic \`${meta.topic}\` does not match directory \`${topicSlug}\``);
  if (!LANGUAGES.includes(meta.lang)) at(`unknown lang \`${meta.lang}\``);
  if (lang && meta.lang !== lang) at(`frontmatter lang \`${meta.lang}\` does not match filename \`${lang}\``);
  if (!topic || !LANGUAGES.includes(meta.lang)) return { errors, warnings, parsed };

  if (meta.title.length < 10 || meta.title.length > 160) {
    at(`title must be 10 to 160 characters, got ${meta.title.length}`);
  }
  if (preamble) at("no prose is allowed between the frontmatter and the first ## heading");

  // ---- facts: exact set equality against the canonical map
  const required = requiredFactsForTopic(meta.topic);
  const declared = new Set(meta.facts);
  for (const id of meta.facts) if (!isFactId(id)) at(`frontmatter facts carries an unknown id \`${id}\``);
  for (const id of required) if (!declared.has(id)) at(`frontmatter facts is missing \`${id}\` (required by brainFactMap)`);
  for (const id of declared) if (!required.includes(id)) at(`frontmatter facts carries \`${id}\`, which brainFactMap does not assign to this topic — if the document only REFERENCES it, move it to \`supporting\``);

  // ---- supporting: facts another topic owns that this document may reference
  const supporting = new Set(meta.supporting);
  for (const key of Object.keys(meta.raw)) {
    if (!KNOWN_KEYS.includes(key)) at(`frontmatter has an unknown key \`${key}\` (known keys: ${KNOWN_KEYS.join(", ")})`);
  }
  // The list of facts a topic may cite is canonical, in brainFactMap, not
  // per file. Otherwise every author invents their own cross references and the
  // golden set has no way to know which ones are legitimate.
  const citable = supportingFactsForTopic(meta.topic);
  for (const id of supporting) {
    if (!isFactId(id)) at(`frontmatter supporting carries an unknown id \`${id}\``);
    else if (declared.has(id)) at(`\`${id}\` is in both facts and supporting; a document either owns a fact or references it`);
    else if (!topicsStatingFact(id).length) at(`\`${id}\` is in supporting but no topic owns it, so nothing keeps it reviewed`);
    else if (!citable.includes(id)) at(`\`${id}\` is not in this topic's \`supporting\` list in brainFactMap; add it there first so the golden set and brainHealth agree with this file`);
  }
  const governed = [...declared, ...supporting];

  // ---- aliases: the lexical anchors that make retrieval work (W3.10.4)
  if (meta.aliases.length < MIN_ALIASES) at(`needs at least ${MIN_ALIASES} aliases, got ${meta.aliases.length}`);
  const seenAlias = new Set();
  for (const alias of meta.aliases) {
    const key = alias.toLowerCase();
    if (seenAlias.has(key)) at(`duplicate alias \`${alias}\``);
    seenAlias.add(key);
    if (alias.length < 2 || alias.length > 90) at(`alias \`${alias}\` must be 2 to 90 characters`);
  }

  // ---- sections
  if (sections.length < MIN_SECTIONS) at(`needs at least ${MIN_SECTIONS} \`##\` sections, got ${sections.length}`);
  const sectionFacts = new Set();
  let boundarySections = 0;
  for (const s of sections) {
    const where = `section "${s.heading}"`;
    if (!s.directive) at(`${where} has no \`<!-- ... -->\` directive line directly under the heading`);
    else if (s.directive.unknown.length) at(`${where} directive has unparsed parts: ${s.directive.unknown.join("; ")}`);
    if (!SECTION_KINDS.includes(s.kind)) at(`${where} has unknown kind \`${s.kind}\` (expected one of ${SECTION_KINDS.join(", ")})`);
    if (s.kind === "boundary") boundarySections += 1;
    if (s.body.length > MAX_SECTION_CHARS) at(`${where} is ${s.body.length} chars, over the ${MAX_SECTION_CHARS} limit`);
    if (s.body.length < MIN_SECTION_CHARS) at(`${where} is only ${s.body.length} chars, under the ${MIN_SECTION_CHARS} floor`);
    for (const id of s.facts) {
      if (!isFactId(id)) at(`${where} declares an unknown fact id \`${id}\``);
      else if (!declared.has(id) && !supporting.has(id)) at(`${where} declares \`${id}\`, which is in neither the frontmatter facts nor supporting list`);
      sectionFacts.add(id);
    }
  }
  for (const id of declared) {
    if (!sectionFacts.has(id)) at(`fact \`${id}\` is declared in the frontmatter but no section carries it`);
  }

  // ---- the boundary rule (authoring standard 6, CX 2A)
  const { boundary } = require("./brainFactMap").factsForTopic(meta.topic);
  if (boundarySections === 0) at("needs at least one `kind: boundary` section, so a limitation can never be overridden by a persuasive example");
  for (const id of boundary) {
    const carried = sections.some((s) => s.kind === "boundary" && s.facts.includes(id));
    if (!carried) at(`boundary fact \`${id}\` must be stated inside a \`kind: boundary\` section`);
  }

  // ---- the body as it will actually be embedded
  const body = sections.map((s) => `${s.heading}\n${s.body}`).join("\n\n");

  // The forbidden literals are checked against every surface that reaches the
  // index, not just the body. The aliases are the easy one to forget, and they
  // are the most tempting place to paste a customer's own wording, which is
  // exactly where the frozen number would arrive.
  const indexed = [meta.title, ...meta.aliases, body].join("\n");
  for (const rule of FORBIDDEN_CORPUS_LITERALS) {
    const hit = rule.pattern.exec(indexed);
    if (hit) at(`forbidden literal (${rule.id}) at "${hit[0].trim()}" — ${rule.why}`);
  }
  const dashTarget = [meta.title, body].join("\n");
  const dash = CONNECTOR_DASH_PATTERN.exec(dashTarget);
  if (dash) at(`dash used as a connector near "${dashTarget.slice(Math.max(0, dash.index - 24), dash.index + 24).replace(/\n/gu, " ")}"`);

  // Every currency amount and every percentage in the ASSERTED text must be
  // traceable to a fact this document owns or declares as supporting. See
  // validateNumericClaims for why this replaced a list of forbidden patterns.
  //
  // The aliases are deliberately out of scope here, and the distinction is the
  // point. An alias is a QUESTION a customer types, not a claim REFAL makes.
  // "is it still 12.5% or has it changed" has to stay an anchor or the one
  // question the corpus most needs to answer never reaches the document that
  // answers it. The forbidden-literal pass above still covers the aliases,
  // because a dynamic value must not be frozen even as a search anchor.
  const asserted = [meta.title, body].join("\n");
  for (const problem of validateNumericClaims(asserted, governed)) at(problem);

  // ---- language
  const ratios = scriptRatios(body);
  const floor = SCRIPT_FLOOR[meta.lang];
  const measured = meta.lang === "ar" ? ratios.arabic : meta.lang === "el" ? ratios.greek : ratios.latin;
  if (measured < floor) {
    at(`body is only ${(measured * 100).toFixed(0)}% ${meta.lang} script, under the ${(floor * 100).toFixed(0)}% floor — this reads like it was filed under the wrong language`);
  }

  return { errors, warnings, parsed, canonicalUrl: canonicalUrl(meta.topic, meta.lang), body };
}

module.exports = {
  MAX_SECTION_CHARS, MIN_SECTION_CHARS, MIN_SECTIONS, MIN_ALIASES, SECTION_KINDS, SCRIPT_FLOOR,
  parseFrontmatter, parseCorpusFile, parseDirective, scriptRatios, validateCorpusFile,
};
