# REFAL Known Defect Register

**Phase:** P0.3 · **Milestone:** M0 · **Produced:** 2026-10-08
**Source:** the 13 production defects recorded in CX history.
**Claim under test:** *"Every one is already assigned. Nothing is left open."*

Reproduce with:

```bash
node scripts/reproduceKnownDefects.js          # human readable
node scripts/reproduceKnownDefects.js --json   # machine readable
```

Every row below was **executed**, not reasoned about. Nothing here is a code-reading summary.

## Result

As first measured on 2026-10-08:

| Status | Count | Meaning |
| --- | --- | --- |
| **REPRODUCED** | **3** | the defect still happens on this code today |
| **ALREADY-FIXED** | **5** | executed and did not happen; the guard is cited |
| **NOT-TESTABLE here** | **6** | needs live Supabase / corpus / model |
| **Total** | **14** | 13 CX defects + 1 new defect found while reproducing |

**Revised the same day**, after the W0.1.3 database baseline was executed and the BLK-14/15/16 fixes landed:

| Status | Count | Change | Meaning |
| --- | --- | --- | --- |
| **REPRODUCED** | **2** | ▼ 1 | still happens today: FIX-1 and FIX-6 only |
| **ALREADY-FIXED** | **6** | ▲ 1 | the orthography defect was repaired, see below |
| **ROOT-CAUSED** | **2** | ▲ 2 | FIX-7 and FIX-8: cause identified, repair owned by M3 |
| **NOT-TESTABLE here** | **4** | ▼ 2 | each now states its own blocker, not a shared premise |
| **Total** | **14** | — | unchanged |

Three things moved, and each for a different reason:

- **The orthography defect is fixed.** Both halves of BLK-16 are closed: `foldArabicLetters` in `src/language.js` is applied to the incoming text *and* to the source of every rule pattern in `src/safetyPolicy.js` and `src/intent.js`. `الإقامة الدائمة` and `الاقامة الدائمة` now return identical intent **and** safety verdicts.
- **FIX-7 and FIX-8 are ROOT-CAUSED, not merely untestable.** The W0.1.3 baseline found the knowledge corpus completely empty: 0 sources, 0 documents, 0 chunks against a target of 87. Retrieval returns zero in *every* language, so these were never retrieval-quality defects. They are a content gap owned by M3, and no retrieval tuning could have repaired them.
- **The remaining four "not testable" verdicts had shared one premise**, *"no live DB from the agent session"*, which the baseline run disproved. Each now carries its real blocker: FIX-10 is waiting on an OpenRouter key, not the database; FIX-9, FIX-11 and FIX-12 need test data *written* to application tables, which needs BOSS's authorization.

**The CX claim still holds.** All 13 have an owning repair phase. Nothing is unassigned.

---

## REPRODUCED — still broken today

### FIX-1 — Programme facts deleted by the claim gate → **P2.2**

3 of 3 probe facts blocked. The full sweep in `CONFLICT-REGISTER.md` measures **27 of 66 sentences (40.9%)** destroyed.

| Fact | Result |
| --- | --- |
| MB-F30 PR investment €300,000 | BLOCKED |
| MB-F19 corporate tax 15% (Arabic) | BLOCKED |
| MB-F45 property VAT 5% | BLOCKED |

This is the single most damaging defect in the system. It is also the **release gate** item (CX 16A).

### FIX-6 — Levantine colloquial formation not matched → **P3.1, P10.1**

**4 of 5** natural Levantine phrasings return no `company_formation` intent:

| Phrase | Intent |
| --- | --- |
| `بدي افتح شركة` | ✅ company_formation |
| `شو بدي عشان افتح شركة بقبرص` | ❌ unknown |
| `بدي اسس شركة` | ❌ unknown |
| `كيف بفتح شركة؟` | ❌ unknown |
| `حابب اعمل شركة بقبرص` | ❌ unknown |

**Root cause** (`src/intent.js:67`). The Arabic formation pattern requires an **adjacent** verb-noun pair:

```
(?:بدي|اريد|أريد|حابب|حابة)\s+(?:اسجل|أسجل|أسس|أؤسس|افتح|أفتح)\s+(?:لي\s+)?(?:شركة|شركه)
```

Three separate failures fall out of that one shape:

1. **Adjacency.** Any intervening word breaks it. `بدي عشان افتح` has `عشان` between the verbs.
2. **No hamza normalisation.** `اسس` is not in the list; only `أسس` and `أؤسس` are.
3. **No Levantine b-prefix.** `بفتح`, `بسجل`, `بعمل` are absent entirely.
4. **Verb coverage.** `اعمل` (to make/do, extremely common for "set up") is missing.

### NEW — Arabic orthographic variants change intent **and** safety → **P2.2, new BLK-16**

Found while reproducing FIX-6. This is **not** in the CX list and is more serious than FIX-6 itself.

```
"الإقامة الدائمة"  →  intents=[residency_enquiry, immigration]   safety=[immigration]
"الاقامة الدائمة"  →  intents=[unknown]                          safety=[]
```

Identical meaning. The only difference is **إ** (hamza below) versus **ا** (bare alef), which WhatsApp users type interchangeably all day.

Two consequences, and the second is a safety issue:

1. The residency enquiry is not recognised, so the customer gets a worse answer.
2. **The immigration safety restriction silently does not apply.** This is a second fail-open path, independent of BLK-14.

**Root cause** (`src/intent.js:120`, `src/safetyPolicy.js:29`). Both normalisers strip **diacritics and tatweel only**:

```js
.replace(/[ً-ٰٟـ]/gu, "")
```

They do not fold hamza forms (أ إ آ → ا), alef maqsura (ى → ي), or taa marbuta (ة → ه). **Every Arabic regex in the repo inherits this brittleness**, not just the two measured here.

> **Proposed BLK-16.** No Arabic orthographic normalisation. Causes intent misses *and* safety-classifier bypass. Fix once in a shared normaliser and every Arabic pattern in the repo benefits. Owner: **P2.2**, with the regression wordlist in **P2.6**.

---

## ALREADY-FIXED — executed, did not reproduce

These stay in the register with their evidence so nobody "re-fixes" them, and so a future regression is detectable.

| Fix | Defect | Evidence it no longer happens | Guard |
| --- | --- | --- | --- |
| **FIX-2** | A greeting saved as the customer's name | 0 / 7 greetings captured as a name across ar/en/el (`مرحبا`, `السلام عليكم`, `hello`, `hi there`, `Γεια σας`, `صباح الخير`, `شكرا`). Control: 2 / 2 real names still extracted (`اسمي عمر` → `عمر`). The guard is **selective**, not a blanket refusal. | `extractCustomerName` + `isPlausibleCustomerName`, `messageRouter.js:419,435` |
| **FIX-3** | Q&A blocked while a booking is pending | With `status=awaiting_details`, an unrelated pricing question returned `null` from `handleBookingMessage`, so the router falls through to normal Q&A. | `booking.js:532` |
| **FIX-4** | A new message resumes an abandoned booking | A draft idle for 2 hours was **cleared** on the next message. Drafts expire after 60 minutes of inactivity; confirmed appointments are unaffected. | `booking.js:520-529` |
| **FIX-5** | Formation vs investment misclassification | `بدي أسجل شركة استثمارية` → `[company_formation, investment]`. `detectIntents` is multi-label, so it returns **both**, which is what MB requires. | `intent.js:124` |
| **FIX-13** | Agent identity answered wrongly | `agent_identity` intent detected in **all three** languages (`من أنت؟`, `what are you?`, `Ποιος είσαι;`). | `intent.js` AGENT_IDENTITY |

### ⚠ FIX-13 was only half fixed — ✅ now CLOSED (2026-10-09, P1.1)

Detection was green. **The answer was not.** The reply still contained the literal placeholder `the business` (BLK-3 / CR-009, **222 occurrences**), producing ungrammatical customer-facing text such as:

> "I can help with other approved **the business** information."

So FIX-13 split into two:

| Part | Status | Owner | Evidence |
| --- | --- | --- | --- |
| Identity **detection** | ALREADY-FIXED | — | `intent.js` AGENT_IDENTITY, all three languages |
| Identity **answer** | ✅ **FIXED 2026-10-09** | **P1.1** | `grep -rn "the business" src/ dashboard/ config/ supabase/` → **0**. The sweep touched **275 occurrences across 49 files**, more than the 222 recorded here, because the register counted only the non-test source files. |

**Why the count differs from CR-009.** CR-009 recorded 222 in 15 non-test source files. The real sweep had to include the test files that assert those exact strings, or the suite would have gone red against correct code. Hence 275 / 49.

**Second form of the same corruption, not in the original register.** Beyond the literal `the business`, the bare word `business` was standing in for the company name inside six detection patterns in `src/intent.js` and `src/conversationRecap.js` (`τι είναι η business`, `work for business`). Those were fixed by **adding** `refal(?:co)?(?:\s+group)?` alongside `business`, never replacing it, so phrasings real customers already use keep matching.

The guard that stops it returning: `src/companyProfile.js` rejects any profile containing the placeholder, and `src/companyProfile.test.js` asserts it.

---

## NOT-TESTABLE in this session — 6

Not run, and stated as not run. Per BOSS's protocol of 2026-10-08, the agent session does not open a live Supabase connection. These become testable once W0.1.3 lands and a seeded corpus exists.

| Fix | Defect | What it needs | Repaired by |
| --- | --- | --- | --- |
| **FIX-7** | Arabic retrieval returns zero for services and pricing | live Supabase corpus + embeddings | P3.10 |
| **FIX-8** | Greek coverage gaps | live Supabase corpus per domain | P3.1-P3.8 |
| **FIX-9** | Handover notification lost, badge mismatch | live store + dashboard counts | P6.5, P12.3 |
| **FIX-10** | Output leaks: internal reasoning, retrieval fallback text | live model round trip, adversarial, 3 languages | P11.2 |
| **FIX-11** | Specialist offer not persisted, so it repeats | live store across turns | P5.4 |
| **FIX-12** | Phone metadata treated as consent | live store consent source field | P9.1 |

### ⚠ Superseded 2026-10-08 — the actual cause of FIX-7 and FIX-8 is an empty corpus

**The hypothesis below was wrong about the primary cause.** The W0.1.3 database baseline measured the knowledge corpus directly: **0 sources, 0 documents, 0 chunks** against a target of 87. Retrieval returns zero in English and Greek too, not only Arabic, so language handling cannot be the explanation. FIX-7 and FIX-8 are a **content gap owned by M3**, and tuning retrieval would have produced nothing.

The three mechanisms described below are still **real defects** and still worth fixing. Two of them now are: BLK-16 is closed, and BLK-15 turned out to be why the English GESY fact was refused. What changes is their *status in this analysis*: they are contributing factors to multilingual quality, not the cause of zero retrieval. Re-measure FIX-7 and FIX-8 after M3 ingestion, not before.

### The original hypothesis, kept for the record

The two reproduced defects above are both **Arabic/Greek language-handling** faults, and `CONFLICT-REGISTER.md` BLK-13 shows a third: the safety rules restrict on a **bare noun** in Arabic and Greek but require a **phrase** in English.

That is three independent mechanisms all degrading non-English handling:

```
BLK-13  bare-noun safety rules in ar/el   →  approved facts refused in ar/el, allowed in en
BLK-16  no hamza normalisation            →  intent + safety miss on ordinary spellings
FIX-6   adjacency-bound formation regex   →  colloquial Levantine unmatched
                        │
                        ▼
        FIX-7 "Arabic retrieval returns zero"
        FIX-8 "Greek coverage gaps"
```

**Hypothesis, not a finding:** FIX-7 and FIX-8 may be partly *upstream* failures (the query is misclassified or refused before retrieval runs) rather than purely retrieval-quality failures. Worth testing both layers separately in P3.10 instead of assuming the corpus is at fault. Flagged so the M3 work does not start by rebuilding a corpus that may not be the problem.

---

## Release gate status (CX 16A)

FIX-1, FIX-9, FIX-10 and FIX-12 must be green before any production restart or deploy.

| Fix | Status today | Blocking? |
| --- | --- | --- |
| **FIX-1** | **REPRODUCED** | 🔴 yes, owned by P2.2 |
| FIX-9 | not testable yet | ⚪ unknown, owned by P6.5 / P12.3 |
| FIX-10 | not testable yet | ⚪ unknown, owned by P11.2 |
| FIX-12 | not testable yet | ⚪ unknown, owned by P9.1 |

**No deploy is possible today**: FIX-1 is reproduced and three of the four gate items are unverified.

## Defects added to the blocker register by this phase

| ID | Source | Severity |
| --- | --- | --- |
| **BLK-13** | W0.2.1 sweep — language asymmetry | Blocker |
| **BLK-14** | W0.2.1 sweep — Arabic guarantee leak (fail open) | Blocker (safety) |
| **BLK-15** | W0.2.1 sweep — unanchored `vat` substring | High |
| **BLK-16** | P0.3 — no Arabic orthographic normalisation (fail open) | Blocker (safety) |
