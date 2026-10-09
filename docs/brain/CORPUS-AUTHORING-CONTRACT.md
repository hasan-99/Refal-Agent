# Corpus authoring contract (M3, phases P3.1 to P3.8)

One shape, 87 files, twelve authors, three languages. This document is the contract.
`scripts/validateCorpus.js` enforces it, so nothing here is advisory.

```
node scripts/validateCorpus.js --topic <slug>     # while writing
node scripts/validateCorpus.js                    # the phase gate, exit 0 required
```

Reference file to copy the shape from: `knowledge/company-lifecycle/en.md`.

---

## 1. Where the file goes

```
knowledge/<topic-slug>/<lang>.md        lang is one of: en, ar, el
```

Slugs come from `src/brainTaxonomy.js` and are **frozen**. A renamed slug orphans every
stored revision, because `canonical_url` is unique and not null in the database.

## 2. The file shape

```markdown
---
topic: ip-box
lang: en
title: The Cyprus IP Box and when it actually applies
facts: MB-F20, MB-F21
aliases: ip box cyprus | software company tax cyprus | patent box | ...
---

## A heading that is a topic, not a label
<!-- facts: MB-F20 -->
Body.

## Another heading
<!-- kind: boundary; facts: MB-F21 -->
Body.
```

Frontmatter is **not** yaml. Five required keys and one optional, in any order:

| Key | Form | Rule |
| --- | --- | --- |
| `topic` | slug | must equal the directory name |
| `lang` | `en` / `ar` / `el` | must equal the filename |
| `title` | plain text | 10 to 160 characters, in the file's own language |
| `facts` | comma separated | **exactly** the set `requiredFactsForTopic(topic)` returns, no more, no fewer |
| `aliases` | **pipe** separated | at least 6, each 2 to 90 characters, unique |
| `supporting` | comma separated, **optional** | facts another topic OWNS that this document only references |

Aliases are pipe separated because Arabic and Greek search phrases contain commas.

### `facts` versus `supporting`

A document **owns** the facts in `facts` and must state every one of them in a section.
It may also **reference** a fact another topic owns, and `supporting` is where that is declared.

The IP Box page needs the 15% headline rate for its own 2.5% to 3% to mean anything, but
MB-F19 belongs to `corporate-tax`. The property VAT page needs the €300,000 residency
threshold to explain that the two do **not** interact, but MB-F30 belongs to
`permanent-residency`. Without `supporting`, the only choices were to leave the sentence
unsourced or to copy the fact into a second topic, and two copies of a number drift apart.

```
facts: MB-F20, MB-F21
supporting: MB-F19
```

A supporting fact is still governed. Its register row decides whether the number may be
stated at all, and the ingestion script records it on the chunk, so a blocked or expired fact
takes the referencing document down with it. What `supporting` does **not** do is excuse you
from stating your own facts: everything in `facts` still needs a section.

## 3. Sections

- Every section starts with `## `. At least 3 sections per file.
- Directly under the heading, one HTML comment directive:
  `<!-- kind: boundary; facts: MB-F21 -->`. Both parts optional, `kind` defaults to `fact`.
- Valid kinds: `fact`, `boundary`, `example`, `discovery`.
- Section body: **120 to 1800 characters**. The 1800 ceiling is the chunk limit.
- Every fact in the frontmatter must be carried by at least one section.
- At least one `kind: boundary` section per file, and every boundary fact listed in
  `brainFactMap` must sit inside one.

The directive is an HTML comment so it is stripped before embedding. Retrieval must never
see `MB-F20` as content.

**Why boundaries are their own section kind.** A limitation buried in a paragraph that also
sells gets retrieved alongside the sales line and loses the argument. Policy, examples and
figures never share a chunk (CX 2A, W3.10.2).

## 4. What goes in, what stays out

**In:** facts, mechanics, what a thing is, what it is not, what it depends on, the questions
we need answered to be concrete, the limits of what can be said.

**Out:**

- Sales scripts, persona, humour, greetings. Those live in the prompt layer, not the corpus.
- Internal review language, phase IDs, plan references, "as discussed", "per MB".
- Any guarantee, any promise of approval, any predicted return.
- A personalised conclusion ("you should incorporate in Cyprus"). State what depends on what,
  then route to a specialist.
- **Dash as a connector.** No ` - `, no em dash. Markdown list markers at the start of a line
  are fine. Real identifiers keep their hyphens (`non-dom`, `e-commerce`).

## 5. Numbers: which ones may be written down

Two categories, and the validator blocks the wrong one.

**Frozen in the corpus, carried by a fact register row with an expiry (P3.9).**
15% corporate tax from 2026, IP Box effective ~2.5% to 3%, €300,000, €50,000, €15,000,
€10,000, 17 years, 19% and 5% property VAT, 4 consecutive months, about two weeks,
2000, 20 years, 47, 400+.

**Never frozen anywhere. Served from a live table (MB-DYN1 to MB-DYN6, M4).**

| Variable | What it is | Where it comes from |
| --- | --- | --- |
| MB-DYN1 | property inventory, unit prices, availability | `refal_property_inventory` |
| MB-DYN2 | reservation deposit amount and conditions | `refal_reservation_rules` |
| MB-DYN3 | annual renewal fees | `refal_annual_renewal_fees` |
| MB-DYN4 | calendar slots | calendar integration |
| MB-DYN5 | government and third party fees | `refal_government_fees` |
| MB-DYN6 | active promotions, **including the headline formation package price** | `refal_offers_and_pricing` |

So: describe the formation package and all seven of its inclusions, and **never write its
price**. Describe the reservation deposit step, and **never write an amount**.

### How this is actually enforced

Not by a list of banned numbers. The validator inverts it:

> **Every currency amount and every percentage in the title or the body must be carried by a
> fact the document declares, in `facts` or in `supporting`. Anything else fails.**

That single rule covers all six dynamic variables, MB-F44's cost of living, and the P3.8
instruction that an unsourceable jurisdiction comparison is cut rather than softened. An
invented "Dubai is 9%" has no register row, so it fails. A bare figure next to a money word
("the deposit is 5000") fails too, with or without a currency symbol.

Durations, counts and years are **not** scanned. "ten stages" and "four categories" are prose.

**Aliases are exempt from this rule and only from this rule.** An alias is a question the
customer types, not a claim REFAL makes, so `is it still 12.5% or has it changed` is a
legitimate and necessary anchor. The forbidden-literal pass still covers the aliases, because
a *dynamic* value must not be frozen even as a search anchor.

Write it as a capability, not a gap. "The package price is confirmed live before anything is
agreed" reads better than "I cannot tell you the price", and it is what actually happens.

## 6. Language

Three native documents, **not three translations**. Write each one from the facts.

| Lang | Register |
| --- | --- |
| `en` | business casual. Short sentences. No consultancy padding. |
| `ar` | simplified warm white dialect, leaning on accessible near-MSA. Avoid dry legal register. The customer's own words matter more than correctness of form: `كم تكلفة تأسيس شركة`, `شو بيشمل`, `قديش بتكلف`. |
| `el` | professional business Greek. Natural, not translationese. |

Latin terms stay Latin inside Arabic and Greek text where that is how people actually say
them: VAT, EORI, IP Box, Stripe, Ltd, GESY, AIF, UBO, DTT, BOQ, SHA. The validator's script
floor (45% for ar and el) is set to allow exactly this.

Headings are in the file's own language. The `title` too.

## 7. Aliases are the retrieval surface

The alias list is how a customer's actual phrasing finds the document (W3.10.4, and the
repair for FIX-7 and FIX-8). Per file, include a spread of:

- the plain question in that language, as typed, including the colloquial form
- dialect spellings and common misspellings
- English acronyms even in the `ar` and `el` files, because people code switch
- transliterations (`sherka`, `etaireia`, `ip box`)

Minimum 6. Twelve is better. `src/brainGoldenSet.*.js` holds **10** real questions for your exact
topic and language, so 30 per topic across the three. Read them. They are the questions the
corpus is graded against.

**Never paste a figure out of a golden question into an alias.** Some of them ask for the
package price by name. The validator checks the title and the alias list for forbidden
literals exactly as it checks the body, because the aliases are the retrieval surface.

```bash
node -e "const g=require('./src/brainGoldenSet');g.ENTRIES.filter(e=>e.topic==='ip-box'&&e.lang==='ar').forEach(e=>console.log(e.id,e.question))"
```

## 8. Source of truth for the facts

`docs/brain/SOURCE-ANALYSIS.md` section 6 (`## 6. Knowledge base`) holds every MB module 2
fact with its ID. Section 7.4 holds the jurisdiction comparisons MB-J0 to MB-J4.
`newplan/Master Brain & Operating Rules Manual - REFAL AI.txt` is the original and wins on
any wording question.

The authority rule from the plan applies: **the source documents beat the current
implementation.** If the repo's existing behaviour contradicts the manual, the manual is
right and the repo has a defect.

Fact IDs are unpadded: `MB-F6`, never `MB-F06`. `src/brainFactMap.js` is the single source of
truth for which facts each topic owns.

## 9. Done means

```bash
node scripts/validateCorpus.js --topic <slug> > /tmp/vc.log 2>&1; echo "exit=$?"; cat /tmp/vc.log
```

`exit=0`, three files present, every required fact carried, every boundary in a boundary
section. Nothing claimed before that line has been read.
