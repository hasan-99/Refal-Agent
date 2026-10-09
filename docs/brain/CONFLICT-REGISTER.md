# REFAL Conflict Register — MB/AR versus the current code

**Phase:** P0.2 · **Milestone:** M0 · **Produced:** 2026-10-08
**Authority:** Rule 1. MB and AR win over the current implementation. Every conflict below is a **defect in the code**, not a defect in MB.

**How this file is used.** `scripts/auditClaimGates.js` reads the `MBC-xxx` IDs out of this file. A conflicting sentence that is *registered here* no longer fails the G2 gate; an unregistered one does. Registering a conflict does **not** fix it. It records it and names the milestone that repairs it.

## How the evidence was produced

```bash
node scripts/auditClaimGates.js            # the sweep, exit code is the G2 gate
node scripts/auditClaimGates.js --markdown # register-ready rows
node scripts/diagnoseClaimGate.js --all    # exact trigger term per conflict
```

Corpus: `src/brainMbCandidates.js`, 22 candidate sentences (18 MB facts that REFAL **must** be able to state, 4 controls that must **stay** blocked), each in Arabic, English and Greek = **66 sentences**.

## Headline measurement (W0.2.1)

> **Superseded 2026-10-08.** The figures below are the *original* sweep, kept as the P0.2 baseline. After the BLK-14/15/16 fixes the measurement is **25 conflicts (37.9%)** — en 8 · ar 9 · el 8 — and the gate exits **0**. See "RESOLVED 2026-10-08" below.

| Metric | Value |
| --- | --- |
| Sentences tested | **66** (22 candidates × 3 languages) |
| Conflicting | **27 (40.9%)** |
| ↳ English | 9 / 22 |
| ↳ Arabic | 10 / 22 |
| ↳ Greek | 8 / 22 |
| MB facts destroyed by a gate | 26 |
| Unsafe control sentences leaking through | **1** |

**Two in five approved MB fact sentences are deleted by the current gates before a customer ever sees them.** This is BLK-1 quantified, and it is worse than BLK-1 described, because a third gate is involved.

---

## ⚠ Scope correction to the existing blocker register

`SOURCE-ANALYSIS.md` section 11 attributes the blanket refusal to **BLK-1** (`refalcoAnswer.js:156`) and **BLK-2** (`refalcoAnswer.js:181-196`). The sweep shows that is **incomplete**.

The dominant blocker is a **third gate**: `classifySafety()` in `src/safetyPolicy.js:15-27`, reached through `restrictedRefalcoReply()` → line 194. Of the 27 conflicts, **24 are caused by `classifySafety`**, and 13 of those are *not* flagged by `containsProhibitedClaim` at all. Fixing only line 156 would leave most of BLK-1's damage in place.

```
                       customer-facing answer
                                 │
          ┌──────────────────────┼──────────────────────┐
          ▼                      ▼                      ▼
 containsProhibitedClaim   restrictedRefalcoReply   classifySafety
 refalcoAnswer.js:156      refalcoAnswer.js:181     safetyPolicy.js:15-27
   = BLK-1                   = BLK-2                  = NOT REGISTERED
   9 of 27 conflicts         investment/legal         24 of 27 conflicts ◀ dominant
                             branches                 reached via line 194
```

---

## New blockers found by this sweep

| ID | Blocker | Location | Evidence | Severity | Resolution | Milestone |
| --- | --- | --- | --- | --- | --- | --- |
| **BLK-13** | **Language asymmetry.** The English rules require a *phrase* (`tax advice`, `tax rate`); the Arabic and Greek rules match a *bare noun* (`ضريبة`, `φόρος`). The identical approved fact passes in English and is refused in Arabic and Greek. | `src/safetyPolicy.js:19-21` | MB-F19 corporate tax: `en risks=[]` → PASS · `ar risks=[tax]` → BLOCK · `el risks=[tax]` → BLOCK | **Blocker** | Rebuild all three language rule sets to the same *claim class*, not the same keyword list. Parity test per language. | M2 (P2.2), parity test P2.6 |
| **BLK-14** | **Arabic guarantee leak (fail open).** Three natural Arabic guarantee phrasings pass every gate while the English and Greek equivalents are correctly blocked. The gate fails *open* on exactly the claim MB-F28 and MB-AP4 forbid. | `src/safetyPolicy.js:26`, `src/refalcoAnswer.js:184` | `عائد مضمون` LEAK · `أرباح مضمونة` LEAK · `عائد سنوي مؤكد` LEAK · `عوائد مضمونة` BLOCK · en/el equivalents BLOCK | **Blocker** (safety) | Match on the guarantee *construction* (`مضمون/مؤكد` + any profit noun), not on fixed noun-adjective pairs. | M2 (P2.3) |
| **BLK-15** | **Unanchored `vat` substring.** `vat` appears in the TAX rule with no word boundary, so every ordinary word containing the letters *v-a-t* is classified as a restricted tax topic. | `src/safetyPolicy.js:19` | `private` `innovative` `renovation` `activate` `cultivate` `excavation` `motivation` all return `risks=[tax]`. "We offer private office space in Limassol." is RESTRICTED. | **High** | Anchor as `\bvat\b`. Add a regression test over an ordinary-business-English wordlist. | M2 (P2.2) |

> BLK-15 is why MBC-013 (the GESY healthcare fact) is blocked in English: the phrase is *"pri**vat**e health insurance"*.

### ✅ RESOLVED 2026-10-08 — BLK-14, BLK-15 and BLK-16

All three were fixed in `src/safetyPolicy.js`, `src/intent.js` and `src/language.js`, and the gate moved with them:

```
node scripts/auditClaimGates.js   BEFORE: exit=2  27 conflicts (40.9%)  en 9 · ar 10 · el 8
                                  AFTER:  exit=0  25 conflicts (37.9%)  en 8 · ar  9 · el 8
RESULT: PASS — no unregistered conflict, no safety leak
```

| ID | Fix | Evidence it closed |
| --- | --- | --- |
| **BLK-14** | The fixed noun-adjective pairs were replaced by a *construction* match: any profit noun (`عائد`, `عوائد`, `عائدات`, `ربح`, `أرباح`, `مردود`) crossed against any guarantee qualifier (`مضمون`, `مؤكد`, `متوقع`), with an optional `ال` and up to two intervening words. | `عائد مضمون`, `أرباح مضمونة` and `عائد سنوي مؤكد` now all return `risks=[investment]`. The leak line `MBC-903 ar BLOCK->PASS via none` is gone from the audit. |
| **BLK-15** | `vat` → `\bvat\b`. | `private`, `innovative`, `renovation`, `activate` no longer classify as tax. **MBC-013 is no longer a conflict** — the GESY fact passes in English. The standalone term still blocks. |
| **BLK-16** | `foldArabicLetters` folds alef variants, alef maqsura and ta marbuta. Applied to the incoming text **and** to the `.source` of every rule pattern, so rules stay authored in pointed Arabic while matching bare spellings. Both the safety classifier and intent detection use it. | `الاقامة` and `الإقامة` now reach the same verdict, as do `ساحصل`/`سأحصل` and `تاسيس`/`تأسيس`. The orthography defect moved REPRODUCED → ALREADY-FIXED. |

Regression guards live in `src/safetyPolicy.test.js` (5 tests, including a cross-language symmetry test so the BLK-13 asymmetry cannot silently return). Full suite **675/675, exit=0**.

**BLK-13 is NOT closed by this.** The language asymmetry it describes is broader than the guarantee construction BLK-14 covered, and the remaining 25 conflicts still split unevenly (en 8 · ar 9 · el 8). It stays owned by M2 (P2.2) with its parity test in P2.6.

**The ordering constraint still stands.** BLK-14 and BLK-16 were the two fail-opens that had to ship before or with the P2.2 loosening. They have now shipped *first*, which satisfies the constraint rather than removing it: P2.2 may now proceed without re-opening a fail-open.

---

### ✅ RESOLVED 2026-10-09 — M1 closes BLK-3, BLK-4, BLK-5, BLK-6 and BLK-7

| ID | Register entry | Fix | Evidence it closed |
| --- | --- | --- | --- |
| **BLK-3** | CR-008, CR-009 | Identity became configuration: `config/company-profile.json` + `src/companyProfile.js` (a missing or placeholder-bearing profile is a **startup error**). The blanket denial was removed from `AGENTS.md`, `src/ai.js`, `dashboard/server.js` and the edge function. Company **facts** stay evidence-gated, which is the distinction that keeps Rule 2 intact. | `grep -rn '"the business"' src/ dashboard/ config/ supabase/` → **0**. 275 occurrences across 49 files swept. `src/companyProfile.test.js` 10/10. The old assertion in `src/ragPolicy.test.js` that pinned the denial has been inverted. |
| **BLK-4** | the 3-sentence / 500-char cap | Only half of the register entry was real, as the P0.2 correction above already noted: `DEFAULT_MAX_SENTENCES` was already 5. The genuine conflict was the 500-character cap against a 5-sentence ceiling, which is unreachable, and worse in Arabic and Greek where the same content runs longer. `ORDINARY` is now `{ minSentences: 2, maxSentences: 5, maxChars: 700 }`, `EXPANDED` is `{ maxSentences: 20, maxChars: 1800 }`. | `src/goldenFormula.js`. A test pins the validator's ceiling to `ORDINARY` so the two cannot drift apart again, which is exactly how this conflict was created. |
| **BLK-5** | blanket ban on volunteering prices/services | Replaced by a conditional rule: *answer first, then at most ONE relevant cross-sell hook when its trigger fires and evidence supports it, never detail unrelated to the customer's goal.* | `src/brainPrompt.js` `crossSellBlock()` and the rewritten clause in `operationalBlock()`. Asserted on the live system prompt in `src/ragPolicy.test.js`. |
| **BLK-6** | blanket ban on offering a call | Replaced by a tier-aware rule in `bookingOfferBlock(leadTier)`: no offer at cold or unclassified, flexible at warm, move to booking with consent at hot. | `src/promptParity.test.js` asserts the ban is absent from the **assembled** prompt for every variant × tier, and `src/ragPolicy.test.js` asserts the tier reaches the live system prompt. |
| **BLK-7** | no humour calibration | `src/humourEngine.js`: four levels, default 2, six hard bans MB-HB1..HB6 forcing level 0, directives authored natively per language, an emoji allowlist per level, and `assertHumourCompliance` as an output gate beside `validateResponse`. | `src/humourEngine.test.js` **70 pass**, covering all six bans in Arabic, English and Greek. Live gate at `src/ai.js`. |

**Two traps worth recording, because both made a "fixed" blocker look fixed while it was still live.**

1. **BLK-6 survived inside the shared prompt module.** The blanket ban was lifted verbatim out of `src/ai.js` into `operationalBlock()`, so it reached the model **beside** the new tier-aware rule. Two contradictory instructions in one prompt. The W1.7.7 test passed throughout because it asserted on `bookingOfferBlock()` in isolation, never on the assembled prompt.
2. **The tier was hardcoded.** `src/ai.js` passed `leadTier: ""` into a correctly tier-aware builder, so only the protective default could ever be emitted. Tier-aware in the unit test, BLK-6 in production.

Both are now asserted against the finished prompt rather than the component.

**Still open and NOT closed by M1:** BLK-1, BLK-2, BLK-8 and BLK-13 remain owned by M2 (P2.2). The 25 remaining conflicts are theirs. **BLK-3 also survives on a fifth surface the plan never listed**, `src/agentDecision.js`, which is the bounded Agent loop behind `REFAL_AGENT_LIVE_ENABLED` (default off); see section 16 of the master plan.

---

## W0.2.1 — Guardrail conflicts

Grouped by root cause. Every row is reproducible with the commands above.

| ID | MB ref | Candidates | Code ref | Trigger | Severity | Resolution | Milestone |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **CR-001** | MB-F19, MB-F26, MB-F30, MB-F38, MB-F45 | `MBC-001` `MBC-005` `MBC-007` `MBC-012` `MBC-015` | `safetyPolicy.js:19` TAX | bare `vat` · `ضريبة` · `φόρος` · `φπα` | **Blocker** | Every MB price is quoted "+ VAT" and the whole tax domain (topics 9-13) is unreachable. Restrict only *personalised tax conclusions*, never the tax **programme facts**. | M2 (P2.2), M3 (P3.2) |
| **CR-002** | MB-F22, MB-F30, MB-F37 | `MBC-004` `MBC-007` `MBC-011` | `safetyPolicy.js:20` IMMIGRATION | bare `residency` · `إقامة` · `هجرة` | **Blocker** | Kills the entire PR / Non Dom domain (MB-F30 to MB-F44), which is a core Refalco service. Note MB-F22 is caught only because *"tax **residency**"* contains the word. | M2 (P2.2), M3 (P3.4) |
| **CR-003** | MB-F30, MB-F22, MB-F37 | `MBC-004` `MBC-007` `MBC-011` | `refalcoAnswer.js:156` | `residency` · `visa` · `إقامة` · `تأشيرة` · `διαμονή` | **Blocker** | This is BLK-1 proper. Replace with the three-class claim policy (PROGRAM_FACT / PERSONALIZED_CONCLUSION / GUARANTEE). | M2 (P2.2) |
| **CR-004** | MB-F52 | `MBC-016` | `refalcoAnswer.js:156` | `permit` · `licen[cs]e` · `رخصة` · `άδεια` | **High** | Construction and development facts (MB 2.6) cannot be stated. A *planning permission exists* fact is not a *you will get the permit* promise. Keep the guarantee ban, drop the noun ban. | M2 (P2.2), M3 (P3.6) |
| **CR-005** | MB-F35 | `MBC-010` | `safetyPolicy.js:21` BANKING | bare `bank account` · `قرض` · `حساب بنكي` | **High** | MB-F35 *defines* Source of Funds using the phrase "transfer from a personal bank account". The definition cannot be stated. | M2 (P2.3) |
| **CR-006** | MB-F43 | `MBC-013` | `safetyPolicy.js:19` TAX | substring `vat` inside *"private"* | **High** | Caused by BLK-15. Fixing the anchor resolves this row. | M2 (P2.2) |
| **CR-007** | MB-F28 (control) | `MBC-903` | `safetyPolicy.js:26`, `refalcoAnswer.js:184` | *no match* — leak | **Blocker** (safety) | Caused by BLK-14. This is the only row where the gate is too **weak**, not too strong. Must be fixed **before** M2 loosens anything else. | M2 (P2.3) |

**Registered candidate IDs:** `MBC-001` `MBC-004` `MBC-005` `MBC-007` `MBC-010` `MBC-011` `MBC-012` `MBC-013` `MBC-015` `MBC-016` `MBC-903`

### Ordering constraint this creates

CR-007 (the Arabic leak) must be repaired **before or with** the loosening in CR-001 to CR-006. Loosening the gates while a fail-open exists widens the hole. P2.3 therefore cannot be scheduled after P2.2 completes; they ship together.

---

## W0.2.2 — Identity conflict (BLK-3)

| ID | MB ref | Code ref | Severity | Finding | Resolution | Milestone |
| --- | --- | --- | --- | --- | --- | --- |
| **CR-008** | MB 1.0, MB 2.0, MB-C1 to MB-C5 | `AGENTS.md:3` | **Blocker** | The constitution states: *"No company identity or knowledge is bundled."* MB requires REFAL to speak **as Refalco Group**. | Remove the prohibition, replace with the Refalco identity clause. | M1 (P1.1) |
| **CR-009** | MB 1.0 | 222 occurrences of the literal `the business` across **15 non-test source files** plus tests and `config/refal-agent-rules.md` | **High** | The placeholder is not confined to config. It is hard-coded into customer-facing reply strings, including inside `refalcoAnswer.js` refusals ("other approved the business information"), which is also ungrammatical. | Single source of identity in config; replace every literal. Treat as a mechanical sweep with a test that fails if `the business` reappears in a customer-facing string. | M1 (P1.1) |

**Exact `AGENTS.md:3` edit required.**

```diff
- This repository implements a configurable business assistant. No company identity or
- knowledge is bundled. Preserve the operating rules in `config/refal-agent-rules.md`;
- company facts must come from approved knowledge added by the operator.
+ This repository implements REFAL, the conversational agent of **Refalco Group**, a Cyprus
+ based corporate services provider. REFAL speaks as Refalco. Preserve the operating rules in
+ `config/refal-agent-rules.md`. Company **facts** (prices, programmes, numbers) must still come
+ from approved knowledge with provenance; identity and credibility are configuration, not a
+ bundled fact.
```

> Note the distinction that keeps Rule 2 intact: **identity** becomes configuration, **facts** still require an approved, provenance-carrying revision.

---

## W0.2.3 — Schema conflicts

All four claims verified by reading `supabase/migrations/*.sql`. The **live** database is not confirmed here; that is W0.1.3, pending BOSS's run of the inspection script.

| ID | Claim | Verified at | Status | Severity | Resolution | Milestone |
| --- | --- | --- | --- | --- | --- | --- |
| **CR-010** | One approved revision per source | `20261003224701_…sql:21` partial unique index `rafa_knowledge_documents_one_approved_per_source_idx` | **Confirmed** | Not a defect | **Keep** (BLK-9). Forces the corpus shape: one source per topic per language = 87 sources. | M3 (P3.10) |
| **CR-011** | Price-bearing revisions expire after 30 days | `20261003120000_…sql:15-16`, `20261003224701_…sql:27-33` | **Confirmed** | Medium | **Keep the mechanism.** Serve the live €999 offer from `refal_offers_and_pricing` (M4), not from a knowledge chunk, so expiry never silences the offer. | M4 (P4.1) |
| **CR-012** | 500 chunk cap per document | enforced in **6** migrations, latest `20261007160000_…sql:35` | **Confirmed** | Low | **Keep.** 500 chunks is far above the per-source need. | — |
| **CR-013** | 250,000 character paste cap | `20261007140000_…sql:27` | **Confirmed** | Low | **Keep.** | — |
| **CR-014** | Auto approve on save, no pending queue | `20261007150000_…sql:12` sets `review_status='approved'` on write; line 16 **deletes** every non-approved row | **Confirmed** | **High** | **Conflicts with Rule 2.** Governance requires reviewer + verified date before a fact goes live. Auto-approve means no review step exists, and the `delete` destroys any pending-review row. | M3 (P3.9 fact governance) |

| **CR-023** | Two incompatible `trust_tier` vocabularies | DB `rafa_knowledge_sources.trust_tier` CHECK allows `official / first_party / secondary / operator_supplied`; `src/brainTaxonomy.js` froze `regulated / commercial / explanatory` | **Confirmed** | Medium | Found while writing the W0.1.3 baseline. The two describe **different axes**: the DB tier says *where a fact came from*, the P0.4 tier says *how much provenance Rule 2 demands before it may be said*. Do not collapse them, and do not simply widen the CHECK. Keep the DB column as provenance and add the governance tier as a separate column. | M3 (P3.9) |

> **CR-014 is the Rule 2 conflict.** Rule 2 says every fact carries source, reviewer, verified date, effective date, expiry and status. Today `review_status` is written as `approved` by the saving operator and anything else is deleted.
>
> **Scope correction, in P3.9's favour.** The *schema already supports governance*: `review_status` is `not null default 'pending'` with `CHECK (review_status in ('pending','approved','rejected','superseded'))`, plus `CHECK ((review_status = 'approved') = (approved_at is not null))`. The pending and rejected states exist and are enforced by the database; only the **write path** bypasses them. P3.9 is therefore a change to the save path, not a schema redesign. It must still avoid breaking the partial unique index in CR-010.

---

## W0.2.4 — Tone conflicts

| ID | MB ref | Code ref | Severity | Finding | Resolution | Milestone |
| --- | --- | --- | --- | --- | --- | --- |
| **CR-015** | MB-G2 (2 to 5 sentences) | `src/responsePolicy.js:10,24` | **None — already compliant** | `DEFAULT_MAX_SENTENCES = 5` and `MODEL_DRAFT_THRESHOLDS.maxSentences = 5`. | No change needed. | — |
| **CR-016** | MB-G2 | `src/ai.js:224` | **High** | The **prompt text** still instructs the model: *"Keep ordinary replies to at most 3 short sentences and under 500 characters."* The enforcement layer allows 5; the prompt asks for 3. | Rewrite the prompt line to 2 to 5 sentences. | M1 (P1.4) |
| **CR-017** | MB-G2, MB 1.3 worked examples | `src/ai.js:284`, `src/responsePolicy.js:1,24` | **High** | Hard throw at **500 characters**. This is the binding constraint. MB's ✅ examples are 3 sentences **plus** a question and exceed 500 characters in Arabic. | Raise the ordinary preset to **700** characters. | M1 (P1.4) |

**Correction to BLK-4.** BLK-4 records the cap as *"3 sentences / 500 characters"* in both places. That is only half right: **the sentence limit is already 5**. Only the prompt string and the character cap conflict. The fix is smaller than BLK-4 implies.

**Tests asserting the old numbers:** 3 assertions total, in `src/agentLoop.test.js` (2) and `src/responsePolicy.test.js` (1). Low blast radius.

---

## W0.2.5 — Humour conflicts

Current state: humour exists **only as prose** in `config/refal-agent-rules.md:15`. There is **no level mechanism and no code**. `grep -rnE 'emoji' src/*.js` returns **no match** in non-test source.

| ID | MB ref | Severity | Finding | Resolution | Milestone |
| --- | --- | --- | --- | --- | --- |
| **CR-018** | MB-H0 to MB-H3 | **Blocker** | The four humour levels do not exist in any form. There is no selector, no state, no per-level emoji allowlist. | Build the Humour Engine with levels 0-3 and a per-level emoji allowlist (H0 none, H1 👍, H2/H3 full). | M1 (P1.3) |
| **CR-019** | MB-HB1 | **High** | **Missing ban.** The config ban list covers complaints, anger, legal/tax, financial loss, health, disputes, sanctions, AML. It does **not** cover *residency or visa refusal / complications* (MB-HB1). | Add MB-HB1 as a level-0 forcing trigger. | M1 (P1.3) |
| **CR-020** | MB-H1 | **Medium** | **Over-restrictive.** The config bans humour outright on *"tax concerns"*. MB places complex tax consulting at **level 1 Warm & Professional** (minimal formal emoji), not level 0 Serious. | Demote tax from "humour banned" to "level 1". | M1 (P1.3) |

**Delta summary:** of MB's six absolute bans, the config covers **five** (HB2 HB3 HB4 HB5 HB6), misses **one** (HB1), and adds **one** restriction MB does not ask for (tax → should be level 1, not level 0).

---

## W0.2.6 — Precedence conflicts

| ID | Severity | Finding | Resolution | Milestone |
| --- | --- | --- | --- | --- |
| **CR-021** | **Blocker** | **The policy precedence ladder does not exist in code.** No module resolves a disagreement between live data, customer-supplied facts, approved knowledge and model knowledge. `src/priorityRules.js` is *lead* priority (triage), not *source* precedence, and the `PRIORITY_` matches in `handover.js` and `leadQualification.js` are lead tiers. | Implement the 6-rung ladder as an enforced resolver, not prompt text. Rule 2 requires it in code. | M1 (P1.6) |
| **CR-022** | **High** | Precedence today is **implicit and scattered**: whichever gate runs first wins. The sweep demonstrates this directly. `classifySafety` (rung 1, fail-closed) silently overrides rung 2 owner-approved business facts, with no way to express "this is an approved programme fact, let it through". | The resolver must let rung 2 present evidence that satisfies rung 1, rather than rung 1 short-circuiting unconditionally. | M1 (P1.6), M2 (P2.2) |

> CR-022 is the architectural statement of BLK-1. The gates are not merely too broad; they sit at the **wrong rung** with no appeal path. Widening the regexes alone would fix the symptom and leave the design fault.

---

## Totals

| Wave | Conflicts | Blockers | High | Medium/Low | Already compliant |
| --- | --- | --- | --- | --- | --- |
| W0.2.1 guardrails | 7 | 4 | 3 | 0 | 0 |
| W0.2.2 identity | 2 | 1 | 1 | 0 | 0 |
| W0.2.3 schema | 6 | 0 | 1 | 4 | 1 (not a defect) |
| W0.2.4 tone | 3 | 0 | 2 | 0 | 1 |
| W0.2.5 humour | 3 | 1 | 1 | 1 | 0 |
| W0.2.6 precedence | 2 | 1 | 1 | 0 | 0 |
| **Total** | **23** | **7** | **9** | **5** | **2** |

**New blockers added to the register:** BLK-13, BLK-14, BLK-15 (register now runs BLK-1 to BLK-15).
**Corrections to existing entries:** BLK-1 and BLK-2 scope (third gate), BLK-4 premise (sentences already compliant).
