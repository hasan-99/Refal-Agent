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

| Status | Count | Meaning |
| --- | --- | --- |
| **REPRODUCED** | **3** | the defect still happens on this code today |
| **ALREADY-FIXED** | **5** | executed and did not happen; the guard is cited |
| **NOT-TESTABLE here** | **6** | needs live Supabase / corpus / model |
| **Total** | **14** | 13 CX defects + 1 new defect found while reproducing |

**The CX claim holds.** All 13 have an owning repair phase. Nothing is unassigned.

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

### ⚠ FIX-13 is only half fixed

Detection is green. **The answer is not.** The reply still contains the literal placeholder `the business` (BLK-3 / CR-009, **222 occurrences**), producing ungrammatical customer-facing text such as:

> "I can help with other approved **the business** information."

So FIX-13 splits into two:

| Part | Status | Owner |
| --- | --- | --- |
| Identity **detection** | ALREADY-FIXED | — |
| Identity **answer** | still broken | **P1.1** (remove BLK-3) |

Do not close FIX-13 on the detection evidence alone.

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

### A likely contributing cause for FIX-7 and FIX-8

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
