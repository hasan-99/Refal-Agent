const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const {
  MAX_SECTION_CHARS, MIN_SECTION_CHARS, MIN_ALIASES,
  parseCorpusFile, parseDirective, scriptRatios, validateCorpusFile,
} = require("./corpusFile");
const { TOPICS, LANGUAGES } = require("./brainTaxonomy");
const { requiredFactsForTopic, orphanFacts, topicsStatingFact, normalizeFactId } = require("./brainFactMap");

// G2 for P3.1 to P3.8. The corpus is authored by hand across three languages, so
// the thing that has to be tested is not the prose, it is the VALIDATOR: if the
// validator is lenient, 87 files drift and nothing notices until retrieval is
// already wrong.
//
// So every test here feeds the validator a file that is broken in exactly one
// way and asserts it is caught. A validator that passes everything passes this
// suite only if it is genuinely strict.

const REPO = path.join(__dirname, "..");

// A minimal file that is VALID, so each test can break exactly one thing.
function buildFile(overrides = {}) {
  const {
    topic = "company-lifecycle",
    lang = "en",
    title = "The full life cycle of a Cyprus company",
    facts = requiredFactsForTopic("company-lifecycle"),
    aliases = ["one phrase", "two phrase", "three phrase", "four phrase", "five phrase", "six phrase"],
    sections = [
      { heading: "What the stages are", directive: `facts: ${requiredFactsForTopic("company-lifecycle").join(", ")}`, body: "x".repeat(400) },
      { heading: "Where it surprises people", directive: "kind: example", body: "y".repeat(400) },
      { heading: "What this does not tell you", directive: "kind: boundary", body: "z".repeat(400) },
    ],
  } = overrides;

  const front = [
    "---",
    `topic: ${topic}`,
    `lang: ${lang}`,
    `title: ${title}`,
    `facts: ${facts.join(", ")}`,
    `aliases: ${aliases.join(" | ")}`,
    "---",
    "",
  ].join("\n");

  const body = sections
    .map((s) => `## ${s.heading}\n${s.directive === null ? "" : `<!-- ${s.directive} -->\n`}${s.body}\n`)
    .join("\n");

  return front + body;
}

const check = (text, opts = {}) =>
  validateCorpusFile(text, { topicSlug: "company-lifecycle", lang: "en", ...opts });

// ------------------------------------------------------------------- parsing

test("a well formed file parses into frontmatter and sections", () => {
  const parsed = parseCorpusFile(buildFile());
  assert.equal(parsed.error, null);
  assert.equal(parsed.meta.topic, "company-lifecycle");
  assert.equal(parsed.meta.lang, "en");
  assert.equal(parsed.meta.aliases.length, 6);
  assert.equal(parsed.sections.length, 3);
  assert.equal(parsed.sections[2].kind, "boundary");
});

test("the directive comment is stripped from the body, so retrieval never sees a fact id", () => {
  const parsed = parseCorpusFile(buildFile());
  for (const section of parsed.sections) {
    assert.ok(!/MB-F/u.test(section.body), `${section.heading} leaked a fact id into its body`);
    assert.ok(!/<!--/u.test(section.body), `${section.heading} leaked an html comment into its body`);
  }
});

test("a directive parses facts and kind in either order", () => {
  assert.deepEqual(parseDirective("facts: MB-F1, MB-F2"), { kind: "fact", facts: ["MB-F1", "MB-F2"], unknown: [] });
  assert.deepEqual(parseDirective("kind: boundary; facts: MB-F1"), { kind: "boundary", facts: ["MB-F1"], unknown: [] });
  assert.deepEqual(parseDirective("facts: MB-F1; kind: discovery"), { kind: "discovery", facts: ["MB-F1"], unknown: [] });
  assert.deepEqual(parseDirective("facts: MB-F06").facts, ["MB-F6"], "the padded legacy id is repaired, not rejected");
  assert.deepEqual(parseDirective("nonsense").unknown, ["nonsense"]);
});

test("a missing or unclosed frontmatter fence is an error, not a silent empty parse", () => {
  assert.match(check("## heading\nbody").errors[0], /must start with a --- frontmatter fence/u);
  assert.match(check("---\ntopic: x\n## heading").errors[0], /never closed/u);
});

// -------------------------------------------------------------- the identity

test("the frontmatter must agree with where the file lives", () => {
  const wrongTopic = check(buildFile({ topic: "ip-box" }));
  assert.ok(wrongTopic.errors.some((e) => /does not match directory/u.test(e)));

  const wrongLang = check(buildFile({ lang: "ar" }));
  assert.ok(wrongLang.errors.some((e) => /does not match filename/u.test(e)));
});

test("a missing required frontmatter key is reported by name", () => {
  const text = buildFile().replace(/^aliases:.*$/mu, "");
  assert.ok(check(text).errors.some((e) => /missing required key `aliases`/u.test(e)));
});

// ----------------------------------------------------------------- the facts

test("the fact set must match brainFactMap exactly, in both directions", () => {
  // Wrong fact rather than no fact: an empty `facts:` is caught one step
  // earlier as a missing required key, which is a different failure.
  const wrong = check(buildFile({ facts: ["MB-J0"], sections: [
    { heading: "A", directive: "facts: MB-J0", body: "a".repeat(400) },
    { heading: "B", directive: "kind: example", body: "b".repeat(400) },
    { heading: "C", directive: "kind: boundary", body: "c".repeat(400) },
  ] }));
  assert.ok(wrong.errors.some((e) => /missing `MB-F1`/u.test(e)), "a missing required fact must be named");
  assert.ok(wrong.errors.some((e) => /carries `MB-J0`, which brainFactMap does not assign/u.test(e)));

  const extra = check(buildFile({ facts: ["MB-F1", "MB-F19"] }));
  assert.ok(extra.errors.some((e) => /carries `MB-F19`, which brainFactMap does not assign/u.test(e)));

  const empty = check(buildFile().replace(/^facts:.*$/mu, "facts:"));
  assert.ok(empty.errors.some((e) => /missing required key `facts`/u.test(e)));
});

test("a fact declared in the frontmatter but carried by no section is caught", () => {
  const text = buildFile({ sections: [
    { heading: "A", directive: "kind: example", body: "a".repeat(400) },
    { heading: "B", directive: "kind: example", body: "b".repeat(400) },
    { heading: "C", directive: "kind: boundary", body: "c".repeat(400) },
  ] });
  assert.ok(check(text).errors.some((e) => /`MB-F1` is declared in the frontmatter but no section carries it/u.test(e)));
});

test("a section may not declare a fact the frontmatter does not list", () => {
  const text = buildFile({ sections: [
    { heading: "A", directive: "facts: MB-F1, MB-F19", body: "a".repeat(400) },
    { heading: "B", directive: "kind: example", body: "b".repeat(400) },
    { heading: "C", directive: "kind: boundary", body: "c".repeat(400) },
  ] });
  assert.ok(check(text).errors.some((e) => /declares `MB-F19`, which is in neither the frontmatter facts nor supporting list/u.test(e)));
});

// ------------------------------------------------------------- the structure

test("every file needs a boundary section, so a limitation cannot share a chunk with a sales line", () => {
  const text = buildFile({ sections: [
    { heading: "A", directive: "facts: MB-F1", body: "a".repeat(400) },
    { heading: "B", directive: "kind: example", body: "b".repeat(400) },
    { heading: "C", directive: "kind: example", body: "c".repeat(400) },
  ] });
  assert.ok(check(text).errors.some((e) => /needs at least one `kind: boundary` section/u.test(e)));
});

test("a boundary fact must sit inside a boundary section, not just anywhere in the file", () => {
  // formation-package assigns MB-F9 as a boundary fact.
  const facts = requiredFactsForTopic("formation-package");
  const text = buildFile({
    topic: "formation-package", facts,
    sections: [
      { heading: "A", directive: `facts: ${facts.join(", ")}`, body: "a".repeat(400) },
      { heading: "B", directive: "kind: example", body: "b".repeat(400) },
      { heading: "C", directive: "kind: boundary", body: "c".repeat(400) },
    ],
  });
  const result = check(text, { topicSlug: "formation-package" });
  assert.ok(result.errors.some((e) => /boundary fact `MB-F9` must be stated inside a `kind: boundary` section/u.test(e)));
});

test("a section over the chunk ceiling or under the floor is rejected", () => {
  const over = buildFile({ sections: [
    { heading: "A", directive: "facts: MB-F1", body: "a".repeat(MAX_SECTION_CHARS + 1) },
    { heading: "B", directive: "kind: example", body: "b".repeat(400) },
    { heading: "C", directive: "kind: boundary", body: "c".repeat(400) },
  ] });
  assert.ok(check(over).errors.some((e) => new RegExp(`over the ${MAX_SECTION_CHARS} limit`, "u").test(e)));

  const under = buildFile({ sections: [
    { heading: "A", directive: "facts: MB-F1", body: "a".repeat(MIN_SECTION_CHARS - 1) },
    { heading: "B", directive: "kind: example", body: "b".repeat(400) },
    { heading: "C", directive: "kind: boundary", body: "c".repeat(400) },
  ] });
  assert.ok(check(under).errors.some((e) => new RegExp(`under the ${MIN_SECTION_CHARS} floor`, "u").test(e)));
});

test("a section with no directive line is rejected", () => {
  const text = buildFile({ sections: [
    { heading: "A", directive: "facts: MB-F1", body: "a".repeat(400) },
    { heading: "B", directive: null, body: "b".repeat(400) },
    { heading: "C", directive: "kind: boundary", body: "c".repeat(400) },
  ] });
  assert.ok(check(text).errors.some((e) => /has no `<!-- ... -->` directive/u.test(e)));
});

test("prose between the frontmatter and the first heading is rejected", () => {
  const text = buildFile().replace("\n## ", "\nstray intro paragraph\n\n## ");
  assert.ok(text.includes("stray intro paragraph"), "the fixture did not actually insert the stray prose");
  assert.ok(check(text).errors.some((e) => /no prose is allowed between the frontmatter and the first/u.test(e)));
});

// --------------------------------------------------------------- the content

test("the package price can never be written into a chunk, in any script", () => {
  for (const literal of ["€999", "999 EUR", "999 euro", "999 ευρώ", "٩٩٩ يورو"]) {
    const text = buildFile({ sections: [
      { heading: "A", directive: "facts: MB-F1", body: `The package costs ${literal} plus VAT. ${"a".repeat(300)}` },
      { heading: "B", directive: "kind: example", body: "b".repeat(400) },
      { heading: "C", directive: "kind: boundary", body: "c".repeat(400) },
    ] });
    assert.ok(
      check(text).errors.some((e) => /forbidden literal \(DYN6-price\)/u.test(e)),
      `the validator let "${literal}" through, and MB-DYN6 says it never may`,
    );
  }
});

test("a reservation deposit amount can never be written into a chunk", () => {
  const text = buildFile({ sections: [
    { heading: "A", directive: "facts: MB-F1", body: `The reservation deposit is usually €5,000. ${"a".repeat(300)}` },
    { heading: "B", directive: "kind: example", body: "b".repeat(400) },
    { heading: "C", directive: "kind: boundary", body: "c".repeat(400) },
  ] });
  assert.ok(check(text).errors.some((e) => /forbidden literal \(DYN2-deposit\)/u.test(e)));
});

test("a dash used as a connector is rejected, a markdown bullet and a real hyphen are not", () => {
  const withConnector = buildFile({ sections: [
    { heading: "A", directive: "facts: MB-F1", body: `The company - and its director - must file. ${"a".repeat(300)}` },
    { heading: "B", directive: "kind: example", body: "b".repeat(400) },
    { heading: "C", directive: "kind: boundary", body: "c".repeat(400) },
  ] });
  assert.ok(check(withConnector).errors.some((e) => /dash used as a connector/u.test(e)));

  const clean = check(buildFile({ sections: [
    { heading: "A", directive: "facts: MB-F1", body: `- a bullet item\n- another\nnon-dom status and e-commerce are fine. ${"a".repeat(300)}` },
    { heading: "B", directive: "kind: example", body: "b".repeat(400) },
    { heading: "C", directive: "kind: boundary", body: "c".repeat(400) },
  ] }));
  assert.deepEqual(clean.errors, []);
});

test("the forbidden literals and the dash rule also cover the title and the aliases", () => {
  // Found by two authoring agents during P3.1: the validator built its scan
  // target from the sections alone, so the aliases, which ARE the retrieval
  // surface and are the most tempting place to paste a customer's own wording,
  // were never checked. The golden questions literally contain the price.
  const inAlias = check(buildFile({
    aliases: ["how much is the 999 euro package", "two phrase", "three phrase", "four phrase", "five phrase", "six phrase"],
  }));
  assert.ok(inAlias.errors.some((e) => /forbidden literal \(DYN6-price\)/u.test(e)),
    "an alias carrying the package price must fail, it reaches the index like any other text");

  const inTitle = check(buildFile({ title: "The company formation package and its contents" }).replace(
    /^title: .*$/mu, "title: What the package costs at €1,200 today"));
  assert.ok(inTitle.errors.some((e) => /forbidden literal \(DYN6-package-price\)/u.test(e)),
    "the concept guard must catch a package price that is not today's figure");

  const dashInTitle = check(buildFile().replace(/^title: .*$/mu, "title: The company - and what it costs you"));
  assert.ok(dashInTitle.errors.some((e) => /dash used as a connector/u.test(e)));
});

// --------------------------------------------------------- the numeric rule

test("a currency amount or a rate that no declared fact carries is rejected", () => {
  for (const claim of ["The rate in Dubai is 9%.", "Expect €1,200 in government fees.", "Rent is around 900 euro."]) {
    const text = buildFile({ sections: [
      { heading: "A", directive: "facts: MB-F1", body: `${claim} ${"a".repeat(300)}` },
      { heading: "B", directive: "kind: example", body: "b".repeat(400) },
      { heading: "C", directive: "kind: boundary", body: "c".repeat(400) },
    ] });
    assert.ok(check(text).errors.some((e) => /unapproved (?:amount|rate)/u.test(e)),
      `"${claim}" has no register row behind it and must fail`);
  }
});

test("a bare figure next to a money word fails even with no currency symbol", () => {
  for (const claim of ["The reservation deposit is 5.000.", "Η προκαταβολή είναι 5.000.", "العربون 5,000."]) {
    const text = buildFile({ sections: [
      { heading: "A", directive: "facts: MB-F1", body: `${claim} ${"a".repeat(300)}` },
      { heading: "B", directive: "kind: example", body: "b".repeat(400) },
      { heading: "C", directive: "kind: boundary", body: "c".repeat(400) },
    ] });
    assert.ok(check(text).errors.some((e) => /unapproved amount/u.test(e)),
      `"${claim}" drops the currency symbol, which is exactly how a frozen deposit slips through`);
  }
});

test("an alias may carry a figure the body may not, because an alias is a question", () => {
  // The one question the corporate-tax document most needs to answer is "is it
  // still 12.5?". Banning the figure from the anchor would make that question
  // unreachable, so the numeric rule scans the title and the body only.
  const inAlias = check(buildFile({
    aliases: ["is it still 12.5% or has it changed", "two phrase", "three phrase", "four phrase", "five phrase", "six phrase"],
  }));
  assert.deepEqual(inAlias.errors, []);

  const inBody = check(buildFile({ sections: [
    { heading: "A", directive: "facts: MB-F1", body: `The rate is still 12.5%. ${"a".repeat(300)}` },
    { heading: "B", directive: "kind: example", body: "b".repeat(400) },
    { heading: "C", directive: "kind: boundary", body: "c".repeat(400) },
  ] }));
  assert.ok(inBody.errors.some((e) => /unapproved rate "12.5%"/u.test(e)),
    "the same figure asserted in the body is a claim and must fail");
});

test("`supporting` lets a document cite a fact another topic owns", () => {
  const facts = requiredFactsForTopic("ip-box");
  const withRate = (supporting) => {
    const front = [
      "---", "topic: ip-box", "lang: en",
      "title: The Cyprus IP Box regime and when it applies",
      `facts: ${facts.join(", ")}`,
      ...(supporting ? [`supporting: ${supporting}`] : []),
      "aliases: ip box | patent box | software tax cyprus | qualifying ip | ip box rate | effective tax on software",
      "---", "",
    ].join("\n");
    const body = [
      `## What it is\n<!-- facts: ${facts.join(", ")} -->\nThe effective rate reaches 2.5% to 3% against the base rate of 15% from 2026. ${"a".repeat(300)}\n`,
      `## Who it suits\n<!-- kind: example -->\n${"b".repeat(400)}\n`,
      `## What it does not do\n<!-- kind: boundary; facts: MB-F21 -->\n${"c".repeat(400)}\n`,
    ].join("\n");
    return validateCorpusFile(front + body, { topicSlug: "ip-box", lang: "en" });
  };

  assert.ok(withRate(null).errors.some((e) => /unapproved rate "15%"/u.test(e)),
    "15% belongs to corporate-tax, so without a declaration it is an unsourced number here");
  assert.deepEqual(withRate("MB-F19").errors, [],
    "declaring MB-F19 as supporting makes the same sentence legitimate and keeps it under review");
});

test("`supporting` cannot smuggle in a fact that is owned, unknown, or already declared", () => {
  const facts = requiredFactsForTopic("company-lifecycle");
  const withSupporting = (value) => check(buildFile().replace(/^facts: .*$/mu, `facts: ${facts.join(", ")}\nsupporting: ${value}`));

  assert.ok(withSupporting("MB-F1").errors.some((e) => /in both facts and supporting/u.test(e)));
  assert.ok(withSupporting("MB-F999").errors.some((e) => /supporting carries an unknown id/u.test(e)));
  assert.ok(withSupporting("MB-DYN1").errors.some((e) => /no topic owns it/u.test(e)),
    "a dynamic variable has no owning topic, so nothing would keep it reviewed");
});

test("an unknown frontmatter key is rejected rather than silently ignored", () => {
  const text = buildFile().replace(/^title: /mu, "subject: something\ntitle: ");
  assert.ok(check(text).errors.some((e) => /unknown key `subject`/u.test(e)));
});

test("the number normalizer reads each separator by position, not by glyph", () => {
  // The bug this replaced: stripping every comma turned the Greek "2,5%" into
  // 25 and reported a correctly authored IP Box rate as unapproved.
  const facts = requiredFactsForTopic("company-lifecycle");
  const greek = (claim) => validateCorpusFile([
    "---", "topic: company-lifecycle", "lang: el",
    "title: Ο κύκλος ζωής μιας κυπριακής εταιρείας",
    `facts: ${facts.join(", ")}`,
    "aliases: κύκλος ζωής εταιρείας | στάδια εταιρείας | ίδρυση εταιρείας κύπρος | τι γίνεται μετά | υποχρεώσεις εταιρείας | κλείσιμο εταιρείας",
    "---", "",
    `## Τα στάδια\n<!-- facts: ${facts.join(", ")} -->\n${claim} Η εταιρεία περνά από δέκα στάδια και κάθε στάδιο έχει τις δικές του υποχρεώσεις που πρέπει να προγραμματιστούν έγκαιρα από την αρχή.\n`,
    `## Παράδειγμα\n<!-- kind: example -->\nΗ τραπεζική διαδικασία είναι ξεχωριστή από την ίδρυση και η έγκριση ανήκει στο ίδρυμα, όχι σε εμάς. Αυτό εκπλήσσει πολλούς πελάτες στην αρχή της διαδικασίας.\n`,
    `## Τι δεν καλύπτει\n<!-- kind: boundary -->\nΑυτός ο χάρτης δεν αποτελεί προσφορά ούτε συμβουλή για τη δική σας περίπτωση. Η κατάλληλη δομή εξαρτάται από τη δραστηριότητα και τη φορολογική σας κατοικία.\n`,
  ].join("\n"), { topicSlug: "company-lifecycle", lang: "el" });

  const flagged = (claim) => greek(claim).errors.filter((e) => /unapproved/u.test(e)).map((e) => e.replace(/ —.*/su, ""));

  // 2,5 is two and a half, not twenty five. Neither is approved here, but the
  // reported VALUE is what proves the parse.
  assert.ok(flagged("Ο συντελεστής είναι 2,5%.")[0].includes("2,5%"));
  assert.equal(flagged("Δέκα στάδια και τέσσερις κατηγορίες.").length, 0, "a bare count is prose, not a claim");
});

// -------------------------------------------------------------- the language

test("an English document filed as Arabic or Greek is caught", () => {
  const english = buildFile({ lang: "ar" });
  const asArabic = validateCorpusFile(english, { topicSlug: "company-lifecycle", lang: "ar" });
  assert.ok(asArabic.errors.some((e) => /under the 45% floor/u.test(e)));
});

test("Arabic and Greek documents may carry Latin business terms without failing the script floor", () => {
  const arabicBody = `الشركة القبرصية لازم يكون عندها VAT number و EORI registration للجمارك، وكمان الـ IP Box ممكن يكون مفيد لشركات البرمجيات المؤهلة. هاد الشي بيعتمد على طبيعة النشاط وبيحتاج مراجعة من المختص عنا. ${"المعلومات هون عامة وبتوضح الآلية وما بتعطي استنتاج شخصي. "}`.repeat(2);
  const text = buildFile({ lang: "ar", title: "دورة حياة الشركة القبرصية من الفكرة حتى الإغلاق", sections: [
    { heading: "مراحل الشركة", directive: "facts: MB-F1", body: arabicBody },
    { heading: "أمثلة عملية", directive: "kind: example", body: arabicBody },
    { heading: "حدود هالمعلومات", directive: "kind: boundary", body: arabicBody },
  ] });
  const result = validateCorpusFile(text, { topicSlug: "company-lifecycle", lang: "ar" });
  assert.deepEqual(result.errors, [], `a realistic Arabic document failed: ${result.errors.join(" | ")}`);
});

test("scriptRatios measures letters only, so punctuation and digits cannot skew it", () => {
  const ratios = scriptRatios("مرحبا 12345 !!!! VAT");
  assert.ok(ratios.arabic > 0.4);
  assert.ok(ratios.latin > 0.2);
});

// ------------------------------------------------------------- the aliases

test("too few aliases, or a duplicate alias, is rejected", () => {
  const few = check(buildFile({ aliases: ["a one", "a two"] }));
  assert.ok(few.errors.some((e) => new RegExp(`at least ${MIN_ALIASES} aliases`, "u").test(e)));

  const dup = check(buildFile({ aliases: ["same", "SAME", "c one", "d one", "e one", "f one"] }));
  assert.ok(dup.errors.some((e) => /duplicate alias/u.test(e)));
});

// --------------------------------------------------- the map it validates to

test("brainFactMap leaves no MB fact without a topic that states it", () => {
  assert.deepEqual(orphanFacts(), [],
    "a fact no topic owns can never satisfy the M3 exit criterion that every MB module 2 fact is retrievable");
});

test("every topic in the taxonomy has a fact assignment, and every assignment is a real fact", () => {
  for (const topic of TOPICS) {
    const required = requiredFactsForTopic(topic.slug);
    assert.ok(required.length > 0, `${topic.slug} is assigned no facts at all`);
    for (const id of required) {
      assert.equal(normalizeFactId(id), id, `${topic.slug} carries a non-canonical id ${id}`);
      assert.ok(topicsStatingFact(id).includes(topic.slug));
    }
  }
});

// ------------------------------------------------- the corpus actually on disk

test("the reference file every author copies is itself valid", () => {
  const rel = path.join("knowledge", "company-lifecycle", "en.md");
  const abs = path.join(REPO, rel);
  assert.ok(fs.existsSync(abs), `${rel} is the authoring reference and must exist`);
  const result = validateCorpusFile(fs.readFileSync(abs, "utf8"), { topicSlug: "company-lifecycle", lang: "en", path: rel });
  assert.deepEqual(result.errors, [], `the reference file is invalid: ${result.errors.join(" | ")}`);
});

test("every corpus file present on disk is valid", () => {
  const broken = [];
  for (const topic of TOPICS) {
    for (const lang of LANGUAGES) {
      const rel = path.join("knowledge", topic.slug, `${lang}.md`);
      const abs = path.join(REPO, rel);
      if (!fs.existsSync(abs)) continue;
      const result = validateCorpusFile(fs.readFileSync(abs, "utf8"), { topicSlug: topic.slug, lang, path: rel });
      broken.push(...result.errors);
    }
  }
  assert.deepEqual(broken, [], `corpus files on disk have validation errors:\n${broken.join("\n")}`);
});
