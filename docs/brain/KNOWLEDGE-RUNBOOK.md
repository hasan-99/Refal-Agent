# Knowledge runbook

**W3.10.7.** Three procedures, written for the **operator** who has to change something today, not
for the author who wrote the corpus. Every step is a command you can paste.

If you are **writing** a document rather than changing one, you want
[`CORPUS-AUTHORING-CONTRACT.md`](CORPUS-AUTHORING-CONTRACT.md) instead. This file never repeats the
file format; it points at it.

The one command that tells you whether the brain is healthy right now:

```bash
npm run health:brain                      # offline, all 87 cells
node scripts/brainHealth.js --db          # same, plus the database
```

Exit `0` means no gap. Exit `1` means at least one gap. Exit `2` means you typed a bad argument.
`PENDING DB` lines are **not** gaps: they are checks that did not run. A green offline run says
nothing at all about what is in Supabase.

---

## 0. The map: what lives where

| Thing | Lives in | Changing it means |
|---|---|---|
| Topic slugs, domains, languages | `src/brainTaxonomy.js` | a **frozen** taxonomy change, see §1 |
| Which topic must state which fact | `src/brainFactMap.js` | a map edit plus corpus edits |
| What a fact actually claims, and its numbers | `src/factCatalogue.js` | a claim edit, see §2 |
| Status, reviewer, expiry of a fact | `refal_fact_register` (MIG-01) + the seed in `src/factRegister.js` | a **data** edit, see §3 |
| The customer-facing prose | `knowledge/<topic>/<lang>.md` | an authoring edit |
| The headline package price | `refal_offers_and_pricing` (MB-DYN6, **MIG-02, not yet written**) | a data edit, **never** a corpus edit |
| The 870 golden questions | `src/brainGoldenSet.*.js` | see §1 step 5 |

---

## 1. Add a topic

> **Read this first.** `src/brainTaxonomy.js` slugs are **frozen**. `canonical_url` is
> `unique not null` on `rafa_knowledge_sources`, and the url is derived from the slug
> (`refal://kb/<domain>/<slug>/<lang>`). Renaming a slug therefore orphans every stored revision
> for that topic and every chunk under it. Adding is safe; renaming is a migration, not an edit.
>
> Adding a topic is **not** "write a file". It is: a taxonomy change, **plus** a fact map entry,
> **plus** 3 corpus files, **plus** 30 golden questions, **plus** a register row per new fact.
> Skip any one of them and `brainHealth.js` fails, which is the point.

**Step 1 — taxonomy.** Append to `RAW_TOPICS` in `src/brainTaxonomy.js`. Never insert in the
middle and never renumber: `n` is referenced by `TOPIC_PHASE`.

```js
{ n: 30, slug: "my-new-topic", domain: DOMAINS.CORPORATE,
  volatility: VOLATILITY.STABLE, tier: TRUST_TIERS.EXPLANATORY, mbRef: "2.1" },
```

If the topic is `VOLATILE`, it also needs an entry in `VOLATILE_BACKING` naming either the M4
table that serves its number or `"expiry-policy"`. A volatile topic with no backing is a frozen
price waiting to happen.

**Step 2 — the facts it owns.** Add the claim rows to `src/factCatalogue.js` (`claim`,
`sourceType`, `sourceRef`, `jurisdiction`, `numbers`, `volatility`, `trustTier`,
`effectiveFrom`), then map them in `src/brainFactMap.js`:

```js
"my-new-topic": { required: ["MB-F67"], boundary: ["MB-F68"], dynamic: [] },
```

and give the topic a phase in `TOPIC_PHASE`. Every fact must appear in at least one topic or
`orphanFacts()` reports it.

```bash
node scripts/validateTaxonomy.js   > /tmp/tax.log 2>&1; echo "exit=$?"; tail -5 /tmp/tax.log
```

**Step 3 — the three files.** `knowledge/my-new-topic/{ar,en,el}.md`. Shape, section rules, alias
rules and the numbers rule are all in [`CORPUS-AUTHORING-CONTRACT.md`](CORPUS-AUTHORING-CONTRACT.md).
All three languages or none: a topic with an English file and no Arabic one is FIX-7, and
`brainHealth.js` reports it under that name.

```bash
node scripts/validateCorpus.js --topic my-new-topic > /tmp/vc.log 2>&1; echo "exit=$?"; tail -20 /tmp/vc.log
```

**Step 4 — the register row.** The seed in `src/factRegister.js` builds a row for every catalogue
row automatically (Rule 1: MB facts are seeded **approved**). Confirm it:

```bash
node -e 'const {seedRegister,factBehaviour}=require("./src/factRegister");
const r=seedRegister();console.log(factBehaviour("MB-F67",{register:r}));'
```

For a **live** database you also need the row in `refal_fact_register`. See §3 for why that write
cannot be done from this machine today.

**Step 5 — the golden questions.** Exactly **10 per topic per language**, 30 in total, in the
domain file that matches (`src/brainGoldenSet.corporate.js`, `.tax.js`, `.residency.js`,
`.property.js`, `.profile.js`). `expectedFacts` must name facts the topic actually owns, or
`validateAll()` rejects the entry.

**Step 6 — prove it.**

```bash
node scripts/brainHealth.js --topic my-new-topic > /tmp/bh.log 2>&1; echo "exit=$?"; tail -30 /tmp/bh.log
node --test src/brainHealth.test.js                > /tmp/t.log 2>&1; echo "exit=$?"; tail -5 /tmp/t.log
```

A topic is added when that first command exits `0` with 3/3 present, 3/3 clean and 3/3 lexically
healthy.

**Step 7 — ingest.** `node scripts/ingestBrainCorpus.js --topic my-new-topic --apply` (**`--apply` is required — dry run is the default and writes nothing**), then re-run
`node scripts/brainHealth.js --db --topic my-new-topic` and read the `BH-DB-*` lines.

---

## 2. Update a price

> **A price is not a corpus edit.** This is the single most important line in this runbook.

### 2a. The headline package price — nothing to edit here at all

The formation package price is **MB-DYN6**. It is served from `refal_offers_and_pricing`
(**MIG-02, not yet written**) and it is forbidden to appear anywhere in the corpus.
`src/corpusFile.js` fails any file that freezes it, through two patterns in
`FORBIDDEN_CORPUS_LITERALS`: one that catches today's figure and one that catches the **concept**
(any currency amount near the word "package" / "الباقة" / "πακέτο"), so the guard keeps guarding on
the day the offer changes.

So to change the package price:

1. Update the row in `refal_offers_and_pricing`. **Not** a corpus file, **not** `factCatalogue.js`.
2. Change nothing else. MB-F9's register row deliberately carries no figure.
3. Confirm the corpus still refuses to name it:

```bash
node scripts/validateCorpus.js --topic formation-package > /tmp/vc.log 2>&1; echo "exit=$?"; tail -10 /tmp/vc.log
```

If you ever find a price in a `.md` file, that is a defect, not a shortcut. Delete the figure and
let the live table answer.

### 2b. A regulated number that IS in the corpus (15%, €300,000, 19% / 5%, 17 years)

These are different: they are authority-sourced facts with register rows, and the corpus states
them because an answer without the number is useless. Updating one is five steps, in this order.

```bash
# 1. find every place the number is written down
grep -rn "300,000\|300.000\|٣٠٠" src/factCatalogue.js knowledge/permanent-residency/
```

1. **Edit the claim in `src/factCatalogue.js`.** Both the `claim` sentence and the matching
   `numbers` entry. The `numbers` list is what `validateCorpusFile` derives "which figures this
   document may write" from, so a corpus sentence whose number is not in a declared fact's
   `numbers` fails the validator. Change the catalogue first or every file edit looks broken.
2. **Edit the sentence in all 3 files** — `ar.md`, `en.md`, `el.md`. Three languages or the
   languages disagree about the law. Arabic-Indic digits (`٣٠٠٬٠٠٠`) normalise to the same value,
   so write the number the way that language writes it.
3. **Re-run the validator and read the exit code.**
   ```bash
   node scripts/validateCorpus.js --topic permanent-residency > /tmp/vc.log 2>&1; echo "exit=$?"; tail -20 /tmp/vc.log
   node scripts/brainHealth.js --topic permanent-residency    > /tmp/bh.log 2>&1; echo "exit=$?"; tail -30 /tmp/bh.log
   ```
4. **Re-ingest.** `node scripts/ingestBrainCorpus.js --topic permanent-residency --apply` (**without `--apply` this is a dry run and changes nothing**). Until this runs,
   the database still serves the old number: the corpus file is the source, the chunks are the copy.
5. **Re-approve the register row**, because the figure changed and the old approval was for the old
   figure. See §3's `refal_reapprove_fact`.

Then confirm the stored copy matches the file:

```bash
node scripts/brainHealth.js --db --topic permanent-residency > /tmp/bh.log 2>&1; echo "exit=$?"; grep BH-DB /tmp/bh.log
```

`BH-DB-CHUNKS` means the index is a different document from the file. `BH-DB-EMBEDDINGS` means some
chunks were never re-embedded and the semantic branch is serving the old text.

---

## 3. Retire a fact

Two ways, and they behave **differently**. Both are data edits. Neither needs a redeploy, a release
or a code change.

| | `expired` | `blocked` |
|---|---|---|
| Retrievable? | **Yes.** The chunk still comes back. | **No.** Dropped at ingest and filtered again at query time. |
| What REFAL says | "that figure is not currently confirmed", and offers a specialist follow-up | nothing about the fact at all; routes to a specialist |
| Use it when | the number is probably still right but its review date passed | the claim is wrong, withdrawn, or must not be said |
| How it happens | automatically, when `expiry_or_review_at` passes | only deliberately |

The behaviour is decided in one place, `factBehaviour()` in `src/factRegister.js`, and the
`guidance` strings there are what the composer reads. `expired` never guesses and never goes
silent; `blocked` is a hard removal and is filtered twice on purpose, because one layer is not a
guarantee.

**To block a fact** (migration `20261009180000_refal_fact_register.sql`):

```sql
select public.refal_set_fact_status('MB-F30', 'blocked', 'BOSS', 'withdrawn pending the 2026 circular');
```

**To let a fact expire:** do nothing. Rule 2 fires on its own when `expiry_or_review_at` passes,
and `effectiveStatus()` returns `expired` without anybody flipping a field.

**To bring a fact back:**

```sql
select public.refal_reapprove_fact('MB-F30', 'BOSS', 90, 'reverified against the 2026 circular');
```

Re-approval re-dates from **today**, not from the old expiry, so a row that sat expired for a month
does not come back already half spent. Both functions write an audit row, so a fact cannot be
extended without a named actor.

**To see what is about to go quiet:**

```sql
select fact_id, claim_text, expiry_or_review_at, days_left from public.refal_facts_due_for_review;
```

or offline, from the seed:

```bash
node -e 'const {seedRegister,factsExpiringWithin}=require("./src/factRegister");
for (const r of factsExpiringWithin(7,{register:seedRegister()}))
  console.log(r.id, r.expiryOrReviewAt, r.daysLeft);'
```

`brainHealth.js` surfaces the same list as `BH-FACT-EXPIRING` **warnings**. A document standing on
an already-expired or blocked fact is a `BH-FACT-NOT-APPROVED` **gap** and fails the run.

### Known blocker: you cannot run those two statements from this repo

`refal_fact_register` and both RPCs are granted to **`service_role` only**
(`20261009180000_refal_fact_register.sql`, the grant loop and the `revoke` / `grant execute` block at
the end). No Node-side service-role credential exists anywhere in `scripts/`, `src/` or
`dashboard/`: the REST client the scripts share uses the publishable key plus the
`x-rafa-dashboard-secret` header, which these grants deliberately exclude.

So today a status change is run from the Supabase SQL editor or by a service-role client, and
`brainHealth.js` checks fact status against the **seeded** register in `src/factRegister.js`
instead of the live table. That fallback is correct for a freshly seeded database and **wrong the
moment a reviewer edits a row**, which is why the script reports it on every run as
`BH-BLOCKER-REGISTER-SERVICE-ROLE` rather than hiding it.

**To unblock:** either put a service-role key into the environment `scripts/brainHealth.js` reads,
or add a read-only RPC over `refal_fact_register` granted to the dashboard role the REST client
already authenticates as. Until one of those exists, treat the register half of a `--db` run as
unverified.

---

## 4. The monthly re-ingestion nobody asked for

`rafa_apply_knowledge_approval_lifecycle` is a **BEFORE** trigger on
`rafa_knowledge_documents`. When a document is approved, it scans `canonical_content` for a currency
amount and, if it finds one, forces:

```
valid_until := least(coalesce(valid_until, ∞), now() + interval '30 days')
```

Several corpus documents legitimately carry `€300,000` (the permanent residency threshold) and
other approved regulated amounts. The trigger cannot tell a regulated threshold from a sales price,
so **those documents expire 30 days after approval**, and every search RPC filters on
`valid_until is null or valid_until > now()`. They do not degrade. They go dark.

That is a deliberate safety default, not a bug: a current price must never sit in the index without
a finite expiry. The cost is a standing monthly chore.

**The chore:**

```bash
node scripts/brainHealth.js --db > /tmp/bh.log 2>&1; echo "exit=$?"; grep BH-DB-DOCUMENT /tmp/bh.log
```

* a **`WARN`** line means `valid_until` is inside 7 days. Re-ingest and re-approve now, while the
  document is still being served.
* a **`GAP`** line means it already passed. That topic is currently unanswerable in that language
  and has been since the date in the message.

Re-ingesting and re-approving resets the 30 days. Put the `--db` run on a weekly schedule; 7 days of
warning against a 30 day window gives three chances to catch it before it bites.

---

## 5. What `brainHealth.js` actually checks

Ten checks, per topic per language, over all 87 cells.

| # | Check | Needs the database? |
|---|---|---|
| 1 | the file exists | no |
| 2 | it is valid per `validateCorpusFile` | no |
| 3 | every declared fact (`facts` + `supporting`) has an approved register row | no (seed) |
| 4 | its 10 golden questions are lexically reachable in it | no |
| 5 | no negative query is lexically reachable in any document | no |
| 6 | all three languages clear the same bar — **FIX-7** (ar), **FIX-8** (el) | no |
| 7 | the source row exists, is enabled and approved | **yes** |
| 8 | the document is approved and `valid_until` is null or future | **yes** |
| 9 | the stored chunk count matches what the file would produce | **yes** |
| 10 | 100% of chunks embedded, every `embedding_model` **exactly** `DEFAULT_EMBEDDING_MODEL` | **yes** |

Check 10 is strict on purpose: the semantic search RPC filters on `=` over the full model string,
so one mismatched chunk is silently invisible to the vector branch while still looking indexed.

**Check 4 is a PROXY and the output says so.** It is token overlap against a `to_tsvector('simple')`
style tokenisation: lowercase, split on non-letter and non-digit, **no stemming**. Real retrieval is
`websearch_to_tsquery` plus a vector search, ranked and cut at top 5. Clearing the proxy means a
document is lexically **reachable**, which is necessary and not sufficient. The sufficient check is
`scripts/evaluateRag.js` against a live index.

Two numbers are printed per language. The higher one covers title + aliases + headings + bodies. The
lower one, `body+headings only`, is what a chunk's generated `search_vector` actually sees, because
that column is `to_tsvector('simple', heading || ' ' || content)`. If the gap between them is large
for a language, that language's retrieval is leaning on aliases, and aliases only reach the index if
the ingester writes them into a chunk.
