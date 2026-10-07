# REFAL MASTER BRAIN — Full Implementation Plan

> **Source of truth for this plan**
> 1. `C:\Users\hjahouse\Downloads\Master Brain & Operating Rules Manual - REFAL AI.txt` (referred to below as **MANUAL** / **MB**, 5 modules)
> 2. `C:\Users\hjahouse\Downloads\plan.txt` (referred to below as **ARCH** / **AR**, 3 layer architecture + developer action plan)
>
> **Deep extraction of both files, with 183 stable requirement IDs:** [`docs/brain/SOURCE-ANALYSIS.md`](../docs/brain/SOURCE-ANALYSIS.md). Read it before implementing any phase.
>
> ### ⚡ AUTHORITY RULE (set by BOSS, 2026-10-07)
> **The two source files win over the current implementation, always.** The repository's existing posture (no company identity, blanket refusals on residency / tax / licence / investment, 3 sentence cap, no proactive cross selling) is classified as a **defect to be removed**, not a safeguard to be preserved. Twelve named blockers are listed in `SOURCE-ANALYSIS.md` section 11 and are removed by this plan.
>
> The **only** restrictions carried forward are the ones the MANUAL itself demands (`SOURCE-ANALYSIS.md` section 11.1): no guarantees, no personalized legal/tax conclusions, no credential requests, no invented reservation deposit, no ROI prediction, no premature appointment confirmation, score stays internal.
>
> **There are no open decisions and no blocking questions.** Everything below is executable.
>
> **Goal.** REFAL holds the complete Refalco operating brain: identity, persona, humour calibration, the Golden Answer Formula, the full Cyprus corporate / tax / banking / residency / real estate / legal knowledge base, the sales hook and objection matrices, the silent 30 point qualification engine, the executive handoff format, and the compliance constitution. She answers correctly and naturally in **Arabic, English, Greek**, at scale, for every user, never inventing a fact and never promising an outcome.
>
> **Status:** DRAFT v1. Nothing in this plan has been implemented yet.
> **Created:** 2026-10-07
> **Owner:** BOSS
> **Branch convention:** `feature/refal-brain-M<n>-<slug>`

---

## 0. How to read and run this plan

```
MILESTONE  (M0 … M10)   a shippable capability of the brain
   └── PHASE  (Pn.m)    a coherent slice that ends at a hard quality gate
        └── WAVE (Wn.m.k)  a unit of work that can run in parallel with its siblings
             └── TASK      a concrete file level change
```

### 0.1 The Phase Gate Protocol (MANDATORY, runs after EVERY phase)

No phase is "done" and no next phase may start until all five gates pass in order.
This is the explicit loop BOSS asked for: *update plan → verify → find gaps/bugs → auto fix → only then continue*.

| Gate | Name | What happens | Evidence required |
| --- | --- | --- | --- |
| **G1** | **PLAN UPDATE** | Edit this file: tick the phase checkbox, fill the phase's Result block (what was built, files touched, what changed vs the plan, what was deferred). | Diff of this file. |
| **G2** | **VERIFY** | Run the phase's declared verification commands. Read **actual exit codes**, never a piped tail. Record output path + exit code in the Result block. | `exit=0` lines pasted in the Result block. |
| **G3** | **GAP SCAN** | Re run the phase's Traceability rows (section 12) and confirm every MANUAL/ARCH requirement claimed by this phase is (a) implemented, (b) covered by a test, (c) reachable at runtime from a real customer message. Also diff the phase against the Anti Regression Checklist (0.2). | Gap table with `COVERED` / `PARTIAL` / `MISSING` per requirement. |
| **G4** | **AUTO FIX** | Fix every `PARTIAL` / `MISSING` / failing check found in G2 and G3 inside the same phase. Re run G2. Loop until clean, max 3 iterations, then escalate to BOSS with the blocking item named. | Second `exit=0` evidence set. |
| **G5** | **SIGN OFF** | Append the phase Result block, state explicitly what was **not** done, commit **only after BOSS approves** (publishing is never automatic). | BOSS approval message. |

> **Evidence rule.** Never write "tests pass" without a captured exit code from this session.
> Use `npm test > /tmp/<phase>.log 2>&1; echo "exit=$?"; tail -30 /tmp/<phase>.log`.
> A piped command returns the pipe's exit code, not the test runner's.

### 0.2 Anti Regression Checklist (checked at every G3, all milestones)

These are the invariants the current repo already enforces. The brain must be added **beside** them, never by deleting them.

- [ ] No company fact is ever stated without approved, unexpired evidence in `rafa_knowledge_*`.
- [ ] Customer messages, conversation memory, and retrieved chunks remain **untrusted data**, never instructions.
- [ ] No system prompt, credential, token, or other customer's data is ever exposed.
- [ ] No appointment is described as confirmed before the booking system confirms it.
- [ ] A priority / score label stays internal and never appears in a customer reply.
- [ ] A handover is only created after explicit consent or a direct request.
- [ ] No dash punctuation as a connector in customer facing replies.
- [ ] The three prompt surfaces stay aligned: `src/ai.js`, `dashboard/server.js`, `supabase/functions/rafa-agent-api/index.ts`, plus `config/refal-agent-rules.md`.
- [ ] Every existing test in `package.json#scripts.test` still passes.

### 0.3 Legend

`[ ]` not started · `[~]` in progress · `[x]` complete and gated · `⚠` blocked on a decision in section 11

---

## 1. Current system map (verified by reading the repo on 2026-10-07)

### 1.1 Where the brain can live today

| Layer (per ARCH) | Repo reality | File |
| --- | --- | --- |
| **Layer 1. System Prompt** (identity, persona, golden formula, safety) | Exists, 3 copies that must stay in sync | `src/ai.js:184-231`, `dashboard/server.js:1882-1912`, `supabase/functions/rafa-agent-api/index.ts`, canonical text in `config/refal-agent-rules.md` |
| **Layer 2. RAG / Vector DB** (laws, tax, service catalogue) | Exists and is production grade | `rafa_knowledge_sources` → `rafa_knowledge_documents` → `rafa_knowledge_chunks`, hybrid RRF search in `rafa_hybrid_search_knowledge` |
| **Layer 3. Dynamic tables** (live property, prices, slots) | **DOES NOT EXIST YET** except appointments | `rafa_appointments`, `rafa_reminders` exist. Property / pricing / promotions / renewal fees / government fees tables must be built (M4) |

### 1.2 Retrieval facts that constrain the knowledge design

| Fact | Evidence | Consequence for the plan |
| --- | --- | --- |
| Hybrid search = lexical `tsvector('simple')` + semantic HNSW cosine, fused by RRF, semantic cut off at distance ≤ 0.65 | `20260929142922_add_rafa_hybrid_knowledge_search.sql:88-111` | Topic documents must be lexically rich in all three languages, not only semantically similar. |
| Embeddings are **local** `Xenova/multilingual-e5-small`, 384 dims zero padded to 2048 | `src/ai.js:2-4,51-57` | Multilingual retrieval works offline, no provider dependency. Model string is part of the match key, so a model change invalidates every embedding. |
| **Only ONE approved revision per source** (partial unique index) | `20261003224701_rafa_rag_freshness_and_revision_lifecycle.sql:21-23` | The brain must be **many small sources**, one topic each, not one giant document. Taxonomy is therefore load bearing (P0.3). |
| Price bearing approved revisions auto expire after **30 days** | same migration, lines 28-39 | The €999 offer will go stale and REFAL will stop confirming it. This is exactly why ARCH wants `ACTIVE_PROMOTIONS` as a live table (M4). |
| Deterministic fallback answers are rejected when evidence language ≠ customer language | `src/refalcoAnswer.js:35` | Every topic needs a genuine AR + EN + EL document. Translation is not optional. |
| Knowledge entries are **active on save** (auto approved) | `dashboard/server.js:297,312` | No pending review queue. Ingestion correctness must be enforced at authoring time, not by a reviewer. |
| Chunking: 1800 chars max, heading aware, 500 chunk cap per revision | `dashboard/knowledge.js:194-240` | Author documents with explicit `##` headings so chunks stay topically clean. |
| URL import is locked to `KNOWLEDGE_ALLOWED_HOSTS` (empty by default); upload TXT/PDF/DOCX and paste are open | `dashboard/knowledge.js:103-116`, `MAX_PASTE_CHARS = 250_000` | Primary ingestion path for this plan = authored Markdown/TXT upload, not scraping. |

### 1.3 ⚠ The critical conflict: existing guardrails will silence the new brain

`src/refalcoAnswer.js:156` `containsProhibitedClaim()` rejects any model answer matching, in EN/AR/EL:

```
investment returns | roi | irr | yield | financial advice | legally registered |
registration number | legal status | legal advice | tax advice | immigration advice |
visa | residency | bank approval | loan | mortgage | permit | licen[cs]e | government approval
… إقامة | تأشيرة | رخصة | ترخيص | موافقة البنك | معدل الضريبة …
… βίζα | διαμονή | άδεια | έγκριση τράπεζας …
```

The MANUAL **requires** REFAL to explain:

- Permanent Residency program, €300,000 threshold, Categories A/B/C/D (MANUAL 2.4)
- Non Dom status, 0% on dividends and interest for 17 years (MANUAL 2.4)
- Corporate tax 15% from 2026, IP Box ~2.5–3% (MANUAL 2.2)
- VAT 19% / reduced 5% on new property (MANUAL 2.5)
- Why bank and Stripe approval cannot be promised (MANUAL 2.3)

**Every one of those answers would be thrown away by the current regex.** Likewise `restrictedRefalcoReply()` (`src/refalcoAnswer.js:181-196`) returns a hard refusal for any message mentioning residency or investment returns.

**Resolution (M2).** Replace the single blanket blocklist with a three class claim taxonomy:

| Class | Example | Rule |
| --- | --- | --- |
| **PROGRAM_FACT** | "The Cyprus PR route requires a qualifying investment of €300,000 plus VAT." | **ALLOW** when an approved, unexpired chunk in the supplied evidence contains the same fact. |
| **PERSONALIZED_CONCLUSION** | "Your activity qualifies for IP Box." / "You will get the residency." | **BLOCK** always. Offer specialist review instead. |
| **GUARANTEE** | "We guarantee Stripe approval / bank approval / 8% ROI." | **BLOCK** always, in all languages. |

This is the single highest risk item in the plan. It must land **before** M3 loads the corpus, or the knowledge will be invisible at runtime.

---

## 2. Target architecture

```
                         ┌───────────────────────────────────────────────┐
   WhatsApp customer     │            LAYER 1 — SYSTEM PROMPT            │
   (AR / EN / EL)        │  identity · 10 roles · persona · mirroring    │
          │              │  humour levels 0-3 · Golden Answer Formula    │
          │              │  One Question Rule · anti patterns            │
          ▼              │  compliance constitution                      │
   ┌─────────────┐       └───────────────────┬───────────────────────────┘
   │  Baileys    │                           │
   │  worker     │                           ▼
   │  src/bot.js │   ┌───────────────────────────────────────────────────┐
   └──────┬──────┘   │           ORCHESTRATION (agentLoop.js)            │
          │          │  language detect → intent → hooks → retrieve →    │
          ▼          │  score → draft → POLICY GATES → send              │
   ┌─────────────┐   └───┬──────────────────────────────┬────────────────┘
   │ turnRouting │       │                              │
   └─────────────┘       ▼                              ▼
              ┌────────────────────────┐   ┌──────────────────────────────┐
              │ LAYER 2 — RAG CORPUS   │   │ LAYER 3 — DYNAMIC TABLES     │
              │ rafa_knowledge_*       │   │ refal_offers_and_pricing     │
              │ hybrid lexical+vector  │   │ refal_property_inventory     │
              │ 24 topics × AR/EN/EL   │   │ refal_reservation_rules      │
              │ = 72 approved sources  │   │ refal_annual_renewal_fees    │
              │ STABLE FACTS ONLY      │   │ refal_government_fees        │
              └────────────────────────┘   │ refal_active_promotions      │
                                           │ rafa_appointments (exists)   │
                                           │ VOLATILE FACTS ONLY          │
                                           └──────────────────────────────┘
                              │                              │
                              ▼                              ▼
              ┌───────────────────────────────────────────────────────────┐
              │  POLICY GATES (deterministic, outside model control)      │
              │  claimClass · priceEvidence · guaranteeGuard · humourBan  │
              │  languageLock · oneQuestion · lengthBudget · injection    │
              └───────────────────────────┬───────────────────────────────┘
                                          ▼
              ┌───────────────────────────────────────────────────────────┐
              │  QUALIFICATION ENGINE (silent)   6 dims × 0-5 = 30         │
              │  NEED VALUE TIMING AUTHORITY READINESS FIT                │
              │  → tier → action protocol → consent → handoff summary     │
              └───────────────────────────┬───────────────────────────────┘
                                          ▼
                     ┌────────────────────────────────────┐
                     │  CRM  leads · conversations ·       │
                     │  executive handoff → human advisor  │
                     └────────────────────────────────────┘
```

**Hard separation rule (from MANUAL 5.3).** These six values must NEVER be frozen into a prompt or a knowledge document. They are fetched live, every turn they are needed:
`LIVE_PROPERTY_INVENTORY`, `RESERVATION_DEPOSIT_RULES`, `ANNUAL_RENEWAL_FEES`, `LIVE_CALENDAR_SLOTS`, `GOVERNMENT_THIRD_PARTY_FEES`, `ACTIVE_PROMOTIONS`.
A test in P4.3 asserts that none of those six values appear as a literal in any prompt string or any knowledge chunk.

---

## 3. Milestone overview

| # | Milestone | Delivers | Depends on | Est. phases |
| --- | --- | --- | --- | --- |
| **M0** | Baseline, Conflicts, Taxonomy | Verified starting state, conflict register, knowledge taxonomy, golden eval set | — | 3 |
| **M1** | Layer 1: Identity, Persona, Humour, Golden Formula | REFAL sounds like REFAL in 3 languages | M0 | 6 |
| **M2** | Guardrail Reconciliation | The brain is no longer silenced by the policy layer | M0 | 6 |
| **M3** | Layer 2: Trilingual Knowledge Corpus | 24 topics × AR/EN/EL, retrievable | M0, M2 | 8 |
| **M4** | Layer 3: Dynamic Data | Live prices, property, promos, fees, slots | M0 | 5 |
| **M5** | Sales Intelligence | Hooks, objections, jurisdiction benchmarking | M1, M3 | 4 |
| **M6** | Qualification & Handoff | 30 point engine, tiers, buying signals, executive summary | M1, M5 | 6 |
| **M7** | CRM Memory | Progressive capture, never re ask | M6 | 4 |
| **M8** | Multilingual Parity | AR/EN/EL quality equal, dialect + transliteration | M1, M3 | 5 |
| **M9** | Scale & Reliability | All users, concurrently, within budget | M3, M4 | 6 |
| **M10** | Evaluation & Go Live | Benchmarked, red teamed, rolled out | ALL | 5 |
| | | | | **52 phases** |

**Critical path:** M0 → M2 → M3 → M5 → M6 → M10.
**Parallelisable:** M1 ∥ M2, M4 ∥ M3, M7 ∥ M8, M9 ∥ M8.

---

# MILESTONE M0 — Baseline, Conflicts, Taxonomy

**Why first.** The repo already contains deep, deliberate safety machinery. Loading a brain into it without first mapping every prompt surface and every policy gate guarantees silent failures where the knowledge exists in the database but never reaches the customer.

**Exit criteria.** A verified conflict register, a frozen knowledge taxonomy, and a golden evaluation set that every later milestone scores against.

---

### Phase P0.1 — Truth baseline `[~]` 3/4 waves done, see section 15

| Wave | Work | Output |
| --- | --- | --- |
| **W0.1.1** | Inventory every surface that can speak to a customer: `src/ai.js` system prompt, `dashboard/server.js:1882+`, `supabase/functions/rafa-agent-api/index.ts`, `config/refal-agent-rules.md`, `src/agentLoop.js` + `src/agentRuntime.js`, every deterministic reply string (`noApprovedEvidenceReply`, `safeLocalizedFallback`, `restrictedRefalcoReply`, workflow modules). | `docs/brain/SURFACE-INVENTORY.md` with file:line for each. |
| **W0.1.2** | Inventory every policy gate between a model draft and the customer: `responsePolicy.validateResponse`, `safetyPolicy.classifySafety`, `groundingPolicy.*`, `refalcoAnswer.containsProhibitedClaim`, `privacyIntent`, `sensitiveData`, `redFlagRules`, `priorityRules`, `runtimePolicy`. For each: what it blocks, in which languages, and whether the MANUAL needs that content allowed. | `docs/brain/GATE-INVENTORY.md`. |
| **W0.1.3** | Database truth: counts per table for `rafa_knowledge_sources` / `_documents` / `_chunks`, how many chunks have a non null `embedding`, which approved documents are expired by `valid_until`, which `embedding_model` strings are present. **Read only SELECT only.** | `docs/brain/DB-BASELINE.md`. |
| **W0.1.4** | Test baseline. Run `npm test`, `npm --prefix dashboard test`, `npm --prefix dashboard run build`. Capture real exit codes. Record any test already red on `main` so it is never misattributed to this work. | `docs/brain/TEST-BASELINE.md` with `exit=` lines. |

**Verification (G2).**
```bash
npm test > /tmp/p011.log 2>&1; echo "exit=$?"; tail -40 /tmp/p011.log
npm --prefix dashboard test > /tmp/p011d.log 2>&1; echo "exit=$?"; tail -40 /tmp/p011d.log
npm --prefix dashboard run build > /tmp/p011b.log 2>&1; echo "exit=$?"; tail -20 /tmp/p011b.log
```

**G3 gap scan.** Every file in `src/` that emits a customer facing string must appear in SURFACE-INVENTORY. Grep for quoted strings containing Arabic or Greek characters to catch hardcoded replies missed by the manual sweep.

**Result block (fill at G1):**
```
Built:
Files:
Exit codes:
Deviations:
Deferred:
```

---

### Phase P0.2 — Conflict register: MANUAL vs code `[ ]`

| Wave | Work |
| --- | --- |
| **W0.2.1** | **Guardrail conflicts.** For each MANUAL fact that must be sayable (PR €300k, income €50k/€15k/€10k, Non Dom 17y 0%, IP Box 2.5-3%, corporate tax 15% from 2026, VAT 19%/5%, Categories A-D, Company Secretary 4 months, Registered Address 4 months, ~2 weeks incorporation), run the exact candidate sentence in AR/EN/EL through `containsProhibitedClaim()` and `restrictedRefalcoReply()` and record BLOCK/PASS. |
| **W0.2.2** | **Identity conflict.** `AGENTS.md:3` forbids bundling company identity. The MANUAL supplies one. Document the resolution (section 11, DECISION-1) and the exact edit `AGENTS.md` will need. |
| **W0.2.3** | **Schema conflicts.** One approved revision per source; 30 day price expiry; auto approve on save; 500 chunk cap; 250k char paste cap. State for each how the taxonomy in P0.3 works with it. |
| **W0.2.4** | **Tone conflicts.** MANUAL uses emoji (😄 👀 👍 😂) heavily. Current rules forbid dash punctuation and cap ordinary replies at 3 sentences / 500 chars (`src/ai.js:224,284`), while the MANUAL's Golden Formula wants **2 to 5 sentences**. Record the required threshold changes and which tests assert the old numbers. |
| **W0.2.5** | **Humour conflicts.** `config/refal-agent-rules.md:15` already bans humour in complaints/legal/tax/financial loss/health/disputes/sanctions/AML. The MANUAL adds: residency or visa refusal, judicial proceedings, bank failure, death and force majeure. Record the delta. |

**Output.** `docs/brain/CONFLICT-REGISTER.md`, one row per conflict: `ID | MANUAL ref | code ref | severity | resolution | milestone`.

**Verification (G2).** A script `scripts/auditClaimGates.js` that feeds the candidate sentence list through the real gate functions and prints a PASS/BLOCK table. Exit non zero if any sentence the MANUAL requires is blocked **and** not yet listed in the register.

**G3 gap scan.** Every numbered fact in MANUAL modules 2.1 to 2.6 appears in the candidate sentence list, in all three languages.

**Result block:** _(fill at G1)_

---

### Phase P0.3 — Knowledge taxonomy, ID scheme, and the Golden Evaluation Set `[ ]`

**The taxonomy is load bearing.** Because only one revision per source can be approved, each topic gets its own source. One source per topic per language.

| Wave | Work |
| --- | --- |
| **W0.3.1** | Freeze the **24 topic taxonomy** (table below). Assign each a stable slug, a domain, a trust tier, a volatility class (STABLE → RAG, VOLATILE → dynamic table), and a review cadence. |
| **W0.3.2** | Source naming and URL convention. `canonical_url` is `not null unique`, so each source needs a stable synthetic URI, e.g. `refal://kb/corporate/formation-package/ar`. Define it once; every ingestion script uses it. |
| **W0.3.3** | Build the **Golden Evaluation Set**: minimum 10 real customer questions per topic per language = **24 × 3 × 10 = 720 questions**, each with the expected fact(s), the expected hook (if any), the expected humour level, and the expected refusal class. Stored as `src/brainGoldenSet.js` + `artifacts/refal-brain-golden-set.json`. |
| **W0.3.4** | Define the scoring rubric used by every later milestone: Factual accuracy (0-3), Grounding (0-3, must cite approved evidence), Language quality & dialect (0-3), Golden Formula compliance (0-3), Guardrail compliance (PASS/FAIL, any FAIL = whole answer fails). |

#### The 24 topic taxonomy

| # | Slug | Domain | Volatility | MANUAL ref |
| --- | --- | --- | --- | --- |
| 1 | `company-lifecycle` | Corporate | STABLE | 2.1 |
| 2 | `formation-package` | Corporate | **VOLATILE** (price) | 2.1 |
| 3 | `company-structures` (Branch/Subsidiary/New Ltd) | Corporate | STABLE | 2.1 |
| 4 | `shareholder-vs-director` | Corporate | STABLE | 2.1 |
| 5 | `ownership-changes` | Corporate | STABLE | 2.1 |
| 6 | `registered-vs-physical-office` | Corporate | STABLE | 2.1 |
| 7 | `privacy-vs-concealment` | Compliance | STABLE | 2.1 |
| 8 | `dormant-and-liquidation` | Corporate | STABLE | 2.1 |
| 9 | `corporate-tax` | Tax | **VOLATILE** (rate) | 2.2 |
| 10 | `ip-box` | Tax | STABLE | 2.2 |
| 11 | `dividends-vs-salary` | Tax | STABLE | 2.2 |
| 12 | `holding-vs-trading` | Tax | STABLE | 2.2 |
| 13 | `vat-and-eori` | Tax | STABLE | 2.2 |
| 14 | `banking-and-payment-gateways` | Banking | STABLE | 2.3 |
| 15 | `permanent-residency` | Residency | **VOLATILE** (thresholds) | 2.4 |
| 16 | `non-dom-status` | Residency | STABLE | 2.4 |
| 17 | `source-of-funds-vs-wealth` | Compliance | STABLE | 2.4 |
| 18 | `relocation-checklist` | Residency | STABLE | 2.4 |
| 19 | `property-buyer-journey` | Real Estate | STABLE | 2.5 |
| 20 | `offplan-vs-completed` | Real Estate | STABLE | 2.5 |
| 21 | `property-vat` | Real Estate | **VOLATILE** (rates) | 2.5 |
| 22 | `cyprus-cities` | Real Estate | STABLE | 2.5 |
| 23 | `landowners-and-construction` | Development | STABLE | 2.6 |
| 24 | `legal-ip-contracts` | Legal | STABLE | 2.6 |
| + | `company-profile` (Refalco credibility: 2000, 20y, 47, 400+) | Identity | STABLE | 2.0, 3.0 |

→ 25 topics × 3 languages = **75 knowledge sources**.

**Verification (G2).** `node scripts/validateTaxonomy.js` asserts: every slug unique, every topic has an AR/EN/EL entry, every VOLATILE topic has a matching dynamic table planned in M4, golden set has ≥10 questions per topic per language, every golden question has an expected answer class.

**G3 gap scan.** Cross check the taxonomy against MANUAL sections 2.1 to 2.6 heading by heading. Any MANUAL sub heading with no owning topic is a MISSING.

**Result block:** _(fill at G1)_

---

# MILESTONE M1 — Layer 1: Identity, Persona, Humour, Golden Formula

**Why.** This is what makes REFAL *her* rather than a generic retrieval bot. It is pure prompt and policy work, no company facts, so it can run in parallel with M2.

**Exit criteria.** REFAL's voice, humour calibration, answer shape, and anti patterns are implemented, synchronised across all prompt surfaces, and covered by tests in three languages.

---

### Phase P1.1 — REFAL becomes Refalco's agent (removes BLK-3) `[ ]`

**Decision D-1 applies.** The "no company identity is bundled" rule is removed. REFAL says who she is.

| Wave | Work |
| --- | --- |
| **W1.1.1** | Create `config/company-profile.json` (committed, this is Refalco's own repo) with `{ legalName, brand: "REFAL", groupName: "Refalco Group", foundedYear: 2000, yearsExperience: 20, developmentProjects: 47, totalProjects: 400, jurisdiction: "Cyprus", cities: [...], departments: ["Corporate","Tax","Real Estate","Residency","Construction"], languages: ["ar","en","el"] }`. |
| **W1.1.2** | `src/companyProfile.js`: load, validate, freeze. A missing or malformed profile is a **startup error**, not a silent downgrade, because an identity-less REFAL is now a defect. |
| **W1.1.3** | **Delete the `"the business"` placeholder everywhere.** Sweep: `src/ai.js:188,190,194,198,199,217`, `src/refalcoAnswer.js:188-193`, `config/refal-agent-rules.md:5,35`, `dashboard/server.js:1882+`, the edge function, `AGENTS.md:3`, `README.md`. Replace with the profile's brand and group name. |
| **W1.1.4** | Prompt carries identity and positioning (MB-R1..R10, MB-C5) as **persona**. The four credibility **numbers** (MB-C1 2000, MB-C2 20+ years, MB-C3 47, MB-C4 400+) go into the `company-profile` knowledge source (P3.7) so they remain evidence gated and citable, exactly as MB-O5 deploys them. |
| **W1.1.5** | Rewrite `AGENTS.md`: REFAL is Refalco Group's digital business agent. Company **facts** still require approved knowledge; company **identity** no longer does. |

**Verification (G2).** `src/companyProfile.test.js`: the assembled prompt names REFAL and Refalco Group; no credibility number appears as a literal in any prompt string; `grep -rn '"the business"' src/ dashboard/ config/ supabase/` returns zero.

**G3 gap scan.** `grep -rnE '\b(2000|47|400)\b' src/brainPrompt.js src/ai.js config/refal-agent-rules.md` → zero hits (those numbers must come from evidence only).

---

### Phase P1.2 — Persona and the 10 operational roles `[ ]`

MANUAL 1.1 defines 10 parallel roles. They are **behavioural modes**, not separate agents.

| Wave | Work |
| --- | --- |
| **W1.2.1** | `src/personaRoles.js`: the 10 roles with their trigger conditions, primary responsibility, and the one behavioural rule each adds. Business Development · Client Relationship · Sales Qualification · Corporate Services · Investment Enquiry · Real Estate & Development · Construction Enquiry · Customer Service · Appointment Coordinator · Lead Routing. |
| **W1.2.2** | Role selection from detected intent (`src/intent.js` already classifies). Multiple roles may be active; the prompt receives at most the two most relevant role directives to protect the token budget. |
| **W1.2.3** | Persona core text (MANUAL 1.2): *"خفيفة دم بس فاهمة شغلها"* → cheerful, warm, quick witted, simple, natural, commercially perceptive, never pushy. Written natively in AR/EN/EL, **not** translated catchphrases. |
| **W1.2.4** | Adaptive mirroring: casual customer → simple warm tone; executive / HNW investor → formal, concise, highly professional. Signals: message length, formality markers, title mentions, budget magnitude. |

**Verification (G2).** `src/personaRoles.test.js`: a land development message activates Real Estate & Development + Lead Routing; a complaint activates Customer Service only; an HNW message raises formality; at most 2 role directives reach the prompt.

---

### Phase P1.3 — Humour Engine, levels 0 to 3 `[ ]`

MANUAL 1.2 defines four levels with explicit contexts and prohibitions. ARCH describes 0/1/2. We implement all four; level 3 is reachable only by customer initiated humour.

| Level | Behaviour | Context | Forbidden |
| --- | --- | --- | --- |
| **0 Serious** | Sober, direct, zero humour, zero playful emoji | Angry customers, complaints, cancellations, sensitive legal topics, sanctions/AML | Laughing emoji, over friendly tone, any joke |
| **1 Warm** | Professional, calm, positive, minimal formal emoji 👍 | Complex tax consulting, HNW investors, major structures | Spontaneous jokes, joking about budgets, informal tone |
| **2 Playful (DEFAULT)** | Smart, simple, light hearted, natural, friendly emoji 😄👀 | General sales conversation, formation enquiries, ordinary property | Belittling a question, over joking, crossing commercial politeness |
| **3 Very Playful** | Quick witted, responds to the customer's own humour | Customer opens with jokes and is clearly in a positive mood | Breaking company dignity, fake promises inside a joke, touching the fundamentals |

| Wave | Work |
| --- | --- |
| **W1.3.1** | `src/humourEngine.js`: `resolveHumourLevel({ message, history, intents, safetyRisks, leadTier, language }) → 0|1|2|3`. Default 2. |
| **W1.3.2** | **Hard ban detector** (MANUAL 1.2, absolute). Forces level 0 on: residency/visa refusal or complication, legal disputes and judicial proceedings, financial loss or banking failure, complaints/anger/dissatisfaction, AML/KYC/sanctions checks, illness/death/force majeure. Trilingual regex + the existing `safetyPolicy` risk categories. |
| **W1.3.3** | Level → prompt directive, written natively per language (Levantine playfulness is not Greek playfulness). |
| **W1.3.4** | **Output gate**: `assertHumourCompliance(answer, level)` strips or rejects playful emoji and joking constructions when level is 0 or 1. Runs after the model, alongside the existing `validateResponse`. |
| **W1.3.5** | Emoji allowlist per level. Current rules allow emoji but no dash punctuation; keep the dash rule, add the emoji policy. |

**Verification (G2).** `src/humourEngine.test.js`, minimum 60 cases: every hard ban trigger in AR/EN/EL forces 0; a jokey opener in Arabizi reaches 3; a €2M land enquiry sits at 1; the output gate strips 😄 from a level 0 draft.

**G3 gap scan.** All six MANUAL hard ban categories have ≥3 test cases per language = 54 minimum.

---

### Phase P1.4 — Golden Answer Formula and the One Question Rule `[ ]`

MANUAL 1.3: **direct answer + attractive benefit/insight + one smart question**, default length **2 to 5 sentences**.

| Wave | Work |
| --- | --- |
| **W1.4.1** | `src/goldenFormula.js`: `analyseAnswerShape(answer) → { hasDirectAnswer, hasValueHook, questionCount, sentenceCount }`, trilingual sentence and question splitting (`?`, `؟`, Greek `;`). |
| **W1.4.2** | **One Question Rule** gate: max 1 question, or 2 only when they are tightly coupled. `responsePolicy.js` already counts questions; extend it with the coupling exception and wire it to reject rather than warn. |
| **W1.4.3** | Length budget change: ordinary reply **2 to 5 sentences**. Current code caps at 3 sentences / 500 chars (`src/ai.js:224,284`) and the expanded path at 20 sentences / 1800 chars. New presets: `ORDINARY = { minSentences: 2, maxSentences: 5, maxChars: 700 }`, `EXPANDED = { maxSentences: 20, maxChars: 1800 }` for an explicit "tell me everything" request. Update every test asserting the old numbers. |
| **W1.4.4** | The value hook is **optional by evidence**: a benefit is only added when approved evidence supports it. Never force a hook into every reply (already a rule in `config/refal-agent-rules.md:15`; keep it). |
| **W1.4.5** | Encode the two MANUAL worked examples (formation cost ❌/✅, corporate tax ❌/✅) as regression fixtures in the golden set. |

**Verification (G2).** `src/goldenFormula.test.js`: the two MANUAL ✅ answers score full marks; the two ❌ answers fail; a 6 sentence reply is rejected; a 2 question reply is rejected; two tightly coupled questions pass.

---

### Phase P1.5 — Anti pattern guards `[ ]`

MANUAL 1.3 lists five prohibited behaviours. Each becomes a deterministic gate.

| ID | Anti pattern | Gate |
| --- | --- | --- |
| **AP-1** | Phone number obsession: asking for contact details before delivering real value | Block any contact request in a turn where no approved fact was delivered and the customer did not ask for contact. Hooks into existing consent machinery. |
| **AP-2** | Legal disclaimer overload | Max one caveat clause per reply; reject repeated "subject to approval" / "consult your advisor" boilerplate. Prefer the MANUAL's positive sober phrasing. |
| **AP-3** | Fear based selling | Block "prices will rise tomorrow", "the law changes immediately" and equivalents in AR/EN/EL **unless** the claim is present verbatim in approved, unexpired evidence. |
| **AP-4** | Fake promises / absolute guarantees | Extends the GUARANTEE class from M2. Covers bank accounts, Stripe/PayPal/Amazon/Shopify, residency issuance, specific ROI. |
| **AP-5** | Interrogation / multi question overload | Covered by P1.4 One Question Rule; add a history aware check so three consecutive question only turns is also a failure. |

**Verification (G2).** `src/antiPatterns.test.js`, minimum 15 cases per anti pattern per language.

---

### Phase P1.6 — Prompt surface synchronisation `[ ]`

| Wave | Work |
| --- | --- |
| **W1.6.1** | Extract the shared prompt into one module, `src/brainPrompt.js`, exporting composable blocks: identity, roles, persona, humour directive, golden formula, anti patterns, compliance constitution, evidence block, memory block. |
| **W1.6.2** | `src/ai.js` consumes `brainPrompt` instead of its inline 40 line array. Behaviour preserving. |
| **W1.6.3** | `dashboard/server.js:1882+` consumes the same blocks, minus customer only directives, plus operator only directives. |
| **W1.6.4** | `supabase/functions/rafa-agent-api/index.ts` consumes a Deno compatible mirror (`.mjs` sibling, same pattern already used by `responsePolicy.mjs`). |
| **W1.6.5** | Rewrite `config/refal-agent-rules.md` as the canonical human readable version of the same blocks. |
| **W1.6.6** | **Remove BLK-5.** Rewrite `src/ai.js:198` / `config/refal-agent-rules.md:11` "Do not volunteer unrelated prices, packages, services or sales details" → *"Answer the question first. You may then raise **one** relevant cross sell hook when its trigger fires and evidence supports it. Never volunteer detail unrelated to the customer's goal."* |
| **W1.6.7** | **Remove BLK-6.** Rewrite `config/refal-agent-rules.md:21` "Do not introduce a call, meeting or the business contact during ordinary information gathering" → tier aware: *"Do not offer a call at Informational or Cold. Offer it flexibly at Warm. At Hot, or on any buying signal, stop selling and move to booking."* The consent and no repeat rules still bind. |
| **W1.6.8** | **Drift test**: `src/promptParity.test.js` asserts the three runtime surfaces contain the same mandatory rule set. A new rule added in one place and missed in another fails CI. |

**Verification (G2).** Full `npm test` plus the new parity test. Token count of the assembled prompt recorded, must stay under the budget set in P9.4.

**G3 gap scan.** Every MANUAL module 1 requirement maps to a block in `brainPrompt.js`. Section 12 traceability rows M1-* all `COVERED`.

---

# MILESTONE M2 — Guardrail Reconciliation

**Why.** Without this, M3's corpus is invisible. See section 1.3.

**Exit criteria.** REFAL can state every approved program fact from the MANUAL while still refusing every personalized conclusion and every guarantee, in three languages, with no loss of existing protection.

---

### Phase P2.1 — Claim classification taxonomy `[ ]`

| Wave | Work |
| --- | --- |
| **W2.1.1** | `src/claimPolicy.js` with `classifyClaim(sentence, { evidence, language }) → 'PROGRAM_FACT' \| 'PERSONALIZED_CONCLUSION' \| 'GUARANTEE' \| 'NEUTRAL'`. |
| **W2.1.2** | PERSONALIZED_CONCLUSION markers, trilingual: second person subject + eligibility/outcome verb ("your company qualifies", "you will receive", "شركتك مؤهلة", "رح تحصل على", "η εταιρεία σας δικαιούται"). |
| **W2.1.3** | GUARANTEE markers, trilingual: guarantee/ensure/promise + approval/account/return/residency ("نضمن", "مضمون", "εγγυόμαστε"). |
| **W2.1.4** | PROGRAM_FACT verification: the sentence's numeric and named entities must appear in the supplied approved evidence. Reuse `hasQuestionEvidenceOverlap` style token overlap, tightened for numbers (a number in the answer that is absent from evidence is an automatic fail). |

**Verification (G2).** `src/claimPolicy.test.js`, minimum 120 cases. Every MANUAL fact as PROGRAM_FACT with evidence → ALLOW; the same fact without evidence → BLOCK; each personalized and guarantee variant → BLOCK.

---

### Phase P2.2 — Rewrite `containsProhibitedClaim` `[ ]`

| Wave | Work |
| --- | --- |
| **W2.2.1** | **Branch, do not replace.** Keep the existing blanket function as `containsProhibitedClaimLegacy` and route to it when no approved evidence was supplied, so the no knowledge case behaves exactly as today. |
| **W2.2.2** | New path: split the answer into clauses (the existing `removeSafeDisclaimerClauses` splitter), classify each with `claimPolicy`, reject the answer if any clause is PERSONALIZED_CONCLUSION or GUARANTEE, or is a PROGRAM_FACT without matching evidence. |
| **W2.2.3** | Same treatment for `restrictedRefalcoReply` (`src/refalcoAnswer.js:181-196`): a residency or investment **program question** with approved evidence now gets a grounded answer instead of a flat refusal; without evidence the existing refusal stands. |
| **W2.2.4** | Keep `withoutPriceFacts` / `containsPriceClaim` / `containsUnsupportedPackageInclusion` from `groundingPolicy.js` unchanged. They are orthogonal and still needed. |
| **W2.2.5** | Audit every existing test in `src/groundingPolicy.test.js`, `src/agentFactualGrounding.test.js`, `src/safetyPolicy.test.js`, `src/agentRagEvidence.test.js`. Any test that asserts "residency is always refused" must be rewritten to "residency without evidence is refused" and a new positive test added. **Document each changed assertion in the Result block** so a weakened safeguard can never hide as a refactor. |

**Verification (G2).** Full `npm test`. Plus `scripts/auditClaimGates.js` from P0.2 now showing zero MANUAL required sentences blocked.

**G3 gap scan.** Diff the set of blocked message classes before and after. Anything newly allowed must map to a MANUAL requirement row; anything else is a regression.

---

### Phase P2.3 — Banking and payment gateway guard `[ ]`

MANUAL 2.3 golden rule: never promise account opening or gateway approval.

| Wave | Work |
| --- | --- |
| **W2.3.1** | `src/bankingPolicy.js`: detects banking / Stripe / PayPal / Amazon / Shopify intent in AR/EN/EL. |
| **W2.3.2** | Forces the MANUAL's response shape: acknowledge honestly that the final decision belongs to the institution's own risk and KYC/AML assessment, explain the value of building a clean file from day one, then one discovery question. |
| **W2.3.3** | Encode the MANUAL's Stripe dialogue (2.3) as a golden fixture in AR, plus EN and EL equivalents. |

---

### Phase P2.4 — Reservation deposit and ROI guards `[ ]`

| Wave | Work |
| --- | --- |
| **W2.4.1** | **Reservation deposit guardrail** (MANUAL 2.5, absolute): REFAL must never guess or state a fixed deposit amount. Any currency amount in an answer that also mentions reservation/deposit/عربون/προκαταβολή must come from `refal_reservation_rules` (M4), not from a chunk and not from the model. |
| **W2.4.2** | **ROI guardrail** (MANUAL 2.5): no yield percentage, no future price prediction. Encode the MANUAL's reply script ("I will not throw a nice percentage at you just to please you") as the canonical response, trilingual. |
| **W2.4.3** | **Property VAT guardrail**: 19% / 5% may be stated as published program facts; the **applicable rate for this customer** may not be decided by REFAL. |

---

### Phase P2.5 — AML, sanctions, and compliance escalation `[ ]`

MANUAL 5.3: on a sanctioned entity or an attempt at illegal circumvention, escalate to the compliance manager **immediately, without entering the discussion**.

| Wave | Work |
| --- | --- |
| **W2.5.1** | Extend `src/redFlagRules.js` with sanctions and circumvention detection, trilingual. |
| **W2.5.2** | Compliance escalation path: distinct from a sales handover, does **not** require customer consent (it is a regulatory obligation, not a marketing contact), and produces a sober acknowledgment plus an internal escalation record. |
| **W2.5.3** | Forces humour level 0 and suppresses every sales hook for the remainder of the conversation. |
| **W2.5.4** | Privacy hard rule: never request a password, card data, or a sensitive bank statement in chat. Already partly in `sensitiveData.js`; extend and test. |

---

### Phase P2.6 — Guardrail regression sweep `[ ]`

| Wave | Work |
| --- | --- |
| **W2.6.1** | Red team corpus v1: 200 adversarial messages in AR/EN/EL (guarantee bait, price bait, eligibility bait, prompt injection inside a pasted "approved document", sanctions probing, credential phishing). |
| **W2.6.2** | Run the full existing suite plus the new corpus. Zero guarantees, zero personalized conclusions, zero injected instruction obedience. |
| **W2.6.3** | Record the before/after block matrix in `docs/brain/GUARDRAIL-DELTA.md`. |

**Verification (G2).** `npm test` + `node scripts/redTeamBrain.js > /tmp/rt.log 2>&1; echo "exit=$?"`.

---

# MILESTONE M3 — Layer 2: The Trilingual Knowledge Corpus

**Why.** This is the brain's actual content: 25 topics × 3 languages = 75 approved sources.

**Exit criteria.** Every MANUAL module 2 fact is retrievable, in the customer's language, within the top 5 hybrid search results for its golden questions, and is correctly stated by the agent end to end.

**Authoring standard for every document** (applies to all M3 phases):
1. Markdown with explicit `##` headings so `chunkKnowledge` produces clean, topically pure chunks.
2. Each heading block under 1800 chars.
3. **Native authoring, not translation.** The Arabic document is written in simplified warm white dialect / near MSA that a Levantine reader finds natural, avoiding dry legal register (ARCH 2.b). The Greek document is professional business Greek. The English is business casual.
4. Include the customer's own vocabulary as lexical anchors (the lexical half of hybrid search uses `tsvector('simple')`, so the literal words matter): "كم تكلفة تأسيس شركة", "poso kostizei etaireia", "how much to open a company".
5. Facts only. No sales scripts, no persona, no internal review language (`src/ai.js:148-151` strips provenance anyway).
6. **No volatile value** from the M4 list (section 2 hard separation rule).
7. Every price bearing document carries an explicit `valid_until` and enters the 30 day renewal workflow (P3.8).

---

### Phase P3.1 — Corporate domain `[ ]`
Topics 1 to 8. Lifecycle, formation package, Branch/Subsidiary/New Ltd, Shareholder vs Director, ownership changes, registered vs physical office, privacy vs concealment, dormant and liquidation.

| Wave | Work |
| --- | --- |
| **W3.1.1** | Author EN for all 8 topics. |
| **W3.1.2** | Author AR for all 8 topics (Levantine friendly). |
| **W3.1.3** | Author EL for all 8 topics. |
| **W3.1.4** | Ingest + embed + verify retrieval against the golden questions for topics 1-8 (240 questions). |

**Content checklist from MANUAL 2.1, every item must appear:**
- [ ] Lifecycle: Idea → Incorporation → Banking → Tax → Accounting → Operations → Growth → Changes → Renewal → Closure
- [ ] €999 + VAT package, all 7 inclusions: Ltd formation (~2 weeks after documents complete), name reservation and approval, document preparation (MoA/AoA), Certificate of Incorporation, Company Secretary **4 months**, Registered Address **4 months**, remote file management
- [ ] Company Secretary is a statutory corporate function, **not** a personal assistant
- [ ] Registered Address is not an office or an apartment
- [ ] Branch vs Subsidiary vs new Ltd for an existing foreign entity (corporate advisory opportunity, do not assume a new Ltd)
- [ ] Shareholder = owner of shares and capital; Director = executive, administrative, legal manager; can be the same person
- [ ] Ownership structure can change later; nothing is carved in stone from day one
- [ ] Registered vs physical/virtual office and the substance opportunity
- [ ] Legitimate structural privacy vs illegal UBO concealment, explicitly not supported
- [ ] Dormant company still carries reporting and accounting obligations while on the register
- [ ] Liquidation is a formal legal procedure; neglecting a company is not closure

**Verification (G2).** `node scripts/evaluateRag.js --topics corporate > /tmp/p31.log 2>&1; echo "exit=$?"`. Every golden question returns its expected topic in the top 5 and the correct language document first.

---

### Phase P3.2 — Tax domain `[ ]`
Topics 9 to 13.

**Content checklist from MANUAL 2.2:**
- [ ] Corporate tax starts at **15% from 2026**
- [ ] IP Box: effective rate down to **~2.5% to 3%** on qualifying IP and software development profits. Explicitly **not automatic for every company**
- [ ] Dividends vs Salary: different tax treatment, depends on the person's own tax residency and DTTs, never a flat "tax free" answer, routes to a tax advisory opportunity
- [ ] Holding vs Trading full comparison: purpose, discovery questions, compliance requirements, employment capacity
- [ ] Trading company compliance: **VAT number**, **EORI** registration for customs, shipping procedures
- [ ] Holding company: international ownership structure review and substance requirements
- [ ] The MANUAL's simplified tax answer (2.2 ✅ example) as a golden fixture: start from the rate, hint at structure specific advantages, ask about the activity

---

### Phase P3.3 — Banking and payment gateways `[ ]`
Topic 14. Pairs with the P2.3 guard.

**Content checklist from MANUAL 2.3:**
- [ ] Final approval belongs to the financial institution's risk and KYC/AML assessment
- [ ] Applies to banks and to Stripe, PayPal, Amazon, Shopify
- [ ] The value proposition: build the company and the file cleanly from the start, matched to the real activity, instead of registering and discovering compliance problems later
- [ ] Zero promise language anywhere in the document

---

### Phase P3.4 — Residency and Non Dom `[ ]`
Topics 15 to 18. **Highest guardrail risk.** Depends on M2 being complete.

**Content checklist from MANUAL 2.4:**
- [ ] Qualifying investment minimum **€300,000 + VAT (where applicable)**
- [ ] Proven annual income from outside Cyprus: main applicant **€50,000**, spouse **+€15,000**, each eligible minor child **+€10,000**
- [ ] Non Dom: **0% on dividends and interest for 17 years** for new Cyprus tax residents
- [ ] Source of Funds (the direct path of the money for this specific transaction) vs Source of Wealth (the cumulative history of how the wealth was built)
- [ ] Documentation of SoF, and in some cases SoW, is a normal standard compliance step, communicated calmly and without interrogation
- [ ] **Category A**: new residential property (house/apartment), €300,000 + VAT, **first sale directly from the developer**, the most prominent option
- [ ] **Category B**: other property types (offices, shops, hotels), €300,000, including combined or redeveloped commercial property
- [ ] **Category C**: €300,000 in the share capital of a Cyprus company that operates, has employees and real presence in Cyprus
- [ ] **Category D**: €300,000 in units of qualifying Cyprus investment funds (AIF / AIFLNP)
- [ ] Relocation: public vs private vs international schools (British/English curricula); discovery question "how old are the children"
- [ ] Healthcare: GESY national system plus optional private insurance
- [ ] Cost of living and car purchase are variable and need a fresh estimate per city and family size, never a generic number

---

### Phase P3.5 — Real estate `[ ]`
Topics 19 to 22. Pairs with the P2.4 guards.

**Content checklist from MANUAL 2.5:**
- [ ] Buyer journey: Search → Selection → Reservation Deposit → Legal Due Diligence → Contract → Payment Plan → Tax/VAT → Transfer/Registration → Delivery → Management
- [ ] Completed property suits a buyer who wants to live there or wants rental yield quickly
- [ ] Off plan suits a buyer who needs an easier payment plan and a future delivery date
- [ ] New property VAT **19%**, reduced **5%** under specific conditions for direct personal use, calculated precisely by the team, no loose generic numbers
- [ ] Reservation deposit: amounts and conditions differ per project, must come from the live property database, **never guessed**
- [ ] Four cities: Limassol (international, business hub, coastal, luxury, most expensive, capital growth, HNW and international corporates), Larnaca (fast growth, near the airport, coastal, medium and rising, excellent rental yields, major infrastructure plans), Paphos (lifestyle, tourism, quiet, medium, international buyers, holiday homes, short and long term rentals, family living), Nicosia (capital, administrative, governmental and university centre, stable and locally driven, very stable long term rentals, students and corporate staff)
- [ ] The MANUAL's ROI reply script as a golden fixture

---

### Phase P3.6 — Legal, IP, Landowners, Construction `[ ]`
Topics 23 to 24.

**Content checklist from MANUAL 2.6:**
- [ ] Landowners JV: indicators ("I have land in Cyprus and want to develop it / partner with a developer"); discovery questions (land location, area, building density, any preliminary permits); escalation phrasing (this is a development opportunity, not an ordinary property purchase, so it needs direct review by the development and investment team)
- [ ] Construction tenders: indicators ("we need a contractor for a large project / we have a construction tender"); discovery questions (project size, location, availability of BOQ and architectural plans, planned start date); escalation with **no prices and no preliminary estimates from the agent at all**
- [ ] Legal portfolio as cross sell: Cyprus / EU Trademarks, Shareholders Agreements (SHA), Service and Employment Agreements, T&Cs and GDPR advisory

---

### Phase P3.7 — Company profile and credibility `[ ]`
The `company-profile` topic. Depends on DECISION-1.

**Content checklist from MANUAL 2.0 and 3.0:**
- [ ] Refalco Group operational roots from **2000**
- [ ] More than **20 years** of field experience
- [ ] **47** real estate development projects
- [ ] More than **400** multi sector projects
- [ ] Positioning: not a narrow company registration office, a gateway to comprehensive investment and structural solutions
- [ ] These numbers live **only** here, as evidence, never in a prompt string

---

### Phase P3.8 — Ingestion pipeline, freshness, and renewal `[ ]`

| Wave | Work |
| --- | --- |
| **W3.8.1** | `scripts/ingestBrainCorpus.js`: reads `knowledge/<topic>/<lang>.md`, creates or updates the source with the `refal://kb/...` canonical URI, stores the revision, chunks, embeds, verifies chunk and embedding counts match. Idempotent, re runnable, reports a per topic diff. |
| **W3.8.2** | **Freshness workflow.** Price bearing documents expire after 30 days by design. Build a dashboard view listing documents expiring in the next 7 days plus a one click re approval that extends `valid_until`. Without this the brain silently goes quiet on pricing after a month. |
| **W3.8.3** | `npm run index:knowledge` backfill verification. Confirm every chunk has an embedding and a matching `embedding_model` string, because the semantic branch of hybrid search filters on exact model equality (`20260929142922…sql:98`). |
| **W3.8.4** | **Corpus health check** `scripts/brainHealth.js`: per topic per language, reports source exists / revision approved / not expired / chunk count / embedded count / retrievable for its golden questions. Exits non zero on any gap. This is the standing G3 tool for M3. |
| **W3.8.5** | Document the operator runbook: how to add a topic, how to update a price, how to retire a fact. `docs/brain/KNOWLEDGE-RUNBOOK.md`. |

**Verification (G2).**
```bash
node scripts/brainHealth.js > /tmp/health.log 2>&1; echo "exit=$?"; tail -40 /tmp/health.log
npm run eval:knowledge > /tmp/evalk.log 2>&1; echo "exit=$?"
node scripts/evaluateRag.js > /tmp/rag.log 2>&1; echo "exit=$?"
```

**G3 gap scan.** 75 sources present, 75 approved, 0 expired unintentionally, 100% chunks embedded, ≥95% of the 720 golden questions retrieve their expected topic in the top 5.

---

# MILESTONE M4 — Layer 3: Dynamic Data

**Why.** MANUAL 5.3 forbids freezing six values into the prompt. ARCH 3 names four core tables. Without this layer, the €999 offer rots, property answers are invented, and reservation deposits get guessed.

**Exit criteria.** All six dynamic variables are served from live tables through agent tools, with a test proving none of them appear as a literal in any prompt or chunk.

---

### Phase P4.1 — Schema `[ ]`

New migration `supabase/migrations/<ts>_refal_dynamic_commercial_data.sql`. Follow every existing convention: RLS enabled, revoke from `public`/`anon`/`authenticated`, grant to `service_role`, `security invoker` functions with `set search_path = ''`, `set_rafa_updated_at` trigger.

| Table | Serves | Key columns |
| --- | --- | --- |
| `refal_offers_and_pricing` | `ACTIVE_PROMOTIONS`, formation package price | `code`, `title_{en,ar,el}`, `amount`, `currency`, `vat_note`, `inclusions jsonb`, `valid_from`, `valid_until`, `active` |
| `refal_annual_renewal_fees` | `ANNUAL_RENEWAL_FEES` | `item` (secretary, registered address, accounting, audit, tax), `amount`, `currency`, `period`, `notes_{en,ar,el}`, `valid_until` |
| `refal_property_inventory` | `LIVE_PROPERTY_INVENTORY` | `reference`, `city` (limassol/larnaca/paphos/nicosia), `type`, `status` (offplan/completed), `price`, `currency`, `vat_rate_note`, `bedrooms`, `first_sale boolean`, `pr_eligible boolean`, `available boolean`, `developer`, `delivery_date` |
| `refal_reservation_rules` | `RESERVATION_DEPOSIT_RULES` | `project_or_property_id`, `deposit_amount` or `deposit_percent`, `refundable`, `conditions_{en,ar,el}` |
| `refal_government_fees` | `GOVERNMENT_THIRD_PARTY_FEES` | `fee_type` (registry, land registry, residency application), `amount`, `currency`, `authority`, `effective_from`, `source_note` |
| `refal_leads` / `refal_lead_profile` | ARCH `leads` table + MANUAL 5.1 CRM fields | see M7 P7.1 |

`LIVE_CALENDAR_SLOTS` is already served by `src/booking.js` + `rafa_appointments`; it is wired, not rebuilt.

`conversations` (ARCH) already exists as the conversation history tables; it is extended in M7, not duplicated.

---

### Phase P4.2 — Agent tools `[ ]`

| Wave | Work |
| --- | --- |
| **W4.2.1** | Register six read only tools in `src/agentTools.js`: `lookupActiveOffer`, `lookupRenewalFees`, `searchPropertyInventory`, `lookupReservationRules`, `lookupGovernmentFees`, `listCalendarSlots`. Follow the existing registry shape and `agentToolResult.js` contract. |
| **W4.2.2** | Each tool returns a bounded, redacted, language tagged result and records provenance so the answer can be grounded the same way knowledge chunks are. |
| **W4.2.3** | Deterministic fallback for the non agent path (`src/messageRouter.js`), so the dynamic data works whether or not the agentic loop is enabled. |
| **W4.2.4** | **Empty table behaviour**: if a table is empty or every row is expired, the tool returns "not available" and REFAL says the figure is not confirmed. It never falls back to a prompt literal or a stale chunk. |

---

### Phase P4.3 — The "never frozen" enforcement test `[ ]`

| Wave | Work |
| --- | --- |
| **W4.3.1** | `src/dynamicDataSeparation.test.js`: scans every exported prompt string in `src/brainPrompt.js`, `src/ai.js`, `dashboard/server.js`, the edge function, and `config/refal-agent-rules.md` for a currency amount or a property reference. Any hit fails. |
| **W4.3.2** | A query based check in `scripts/brainHealth.js`: no approved knowledge chunk contains a reservation deposit amount, a property unit price, or a government fee. (The formation package price is the one deliberate exception, and it is the one with the 30 day expiry.) |
| **W4.3.3** | Operator warning in the dashboard knowledge editor when a pasted document contains a currency amount, pointing to the dynamic table instead. |

---

### Phase P4.4 — Calendar wiring `[ ]`

MANUAL 4.3 double choice flow: first a day choice ("today or tomorrow"), then real slots from the API ("11:30 or 3:00"). Wires `src/booking.js` `suggestAvailableTimes` into the new flow. Never claim confirmation before the booking system confirms (existing invariant).

---

### Phase P4.5 — Dashboard CRUD `[ ]`

Operator screens for offers, renewal fees, property inventory, reservation rules, government fees. RBAC consistent with the existing dashboard auth (`20260930092548_rafa_dashboard_auth_rbac.sql`). Audit logged via the existing `logDashboardEvent`.

**Verification (G2).** `npm --prefix dashboard test`, `npm --prefix dashboard run build`, plus the separation test.

---

# MILESTONE M5 — Sales Intelligence

**Exit criteria.** The 6 cross sell hooks, 5 objection responses, and 4 jurisdiction comparisons fire correctly in three languages, never fire in a banned context, and never repeat.

---

### Phase P5.1 — Cross selling hook matrix `[ ]`

MANUAL 3.1 + ARCH 4. Six hooks:

| ID | Trigger | Offer | Guard |
| --- | --- | --- | --- |
| **H1 IP_BOX** | activity is Software / SaaS / app / Dev | IP Box tax advantage | Must say "not automatic for every company"; never say the customer qualifies |
| **H2 RESIDENCY** | non EU customer with property or company budget ≥ €300,000 | Permanent Residency for them and family | Program fact only, no eligibility decision |
| **H3 RELOCATION** | mentions family, schools, housing, living, moving | International schools, GESY, Non Dom 17 years | Level 1 or 2 humour, never pushy |
| **H4 SUBSTANCE** | "we want to actually move and work from Cyprus" | Office services and real substance | — |
| **H5 TRADEMARK** | "I have a brand / product / new app" | Cyprus / EU Trademark registration | — |
| **H6 PR_TO_PROPERTY** | "I have the budget and want a clear guaranteed option" for residency | Category A new residential | Never the word "guaranteed" in the reply |

| Wave | Work |
| --- | --- |
| **W5.1.1** | `src/salesHooks.js`: trilingual trigger detection (including Arabizi and Greeklish). |
| **W5.1.2** | Hook → smart hint phrase, authored natively per language from the MANUAL's phrasing, not translated. |
| **W5.1.3** | **Suppression rules**: at most one hook per reply; never in a humour level 0 context; never when the customer declined offers (existing persisted preference machinery); never repeat a hook already offered in recent history; never before the customer's actual question has been answered. |
| **W5.1.4** | Hook must be evidence gated: H1 cannot fire if the IP Box knowledge document is missing or expired. |

**Verification.** `src/salesHooks.test.js`, ≥20 cases per hook per language.

---

### Phase P5.2 — Objection handling matrix `[ ]`

MANUAL 3.2. Five objections, each with hidden meaning, recommended answer, and the next guiding question.

| ID | Objection | Core move |
| --- | --- | --- |
| **O1** | "€999 is expensive" | Do not defend the price. Ask what they are comparing it against, then compare inclusions in detail. |
| **O2** | "I found it for €500" | Ask whether that includes secretary, registered address, and a clear annual commitment, or whether it is a bare registration fee with hidden later costs. |
| **O3** | "I want to think about it / later" | Name the hidden question warmly: is it the price, choosing Cyprus, or simply not being ready yet. Then ask the timing question. |
| **O4** | "Send me everything on WhatsApp" (escape manoeuvre) | Refuse the encyclopedia politely and humorously, ask which single thing matters most right now: price and steps, taxes, or the bank account. |
| **O5** | Distrust ("I do not know you / afraid of a scam") | **Reduce humour.** Validate the concern, state the Refalco credibility facts from approved evidence, offer a direct call with the team before any step. |

| Wave | Work |
| --- | --- |
| **W5.2.1** | `src/objectionMatrix.js`: detection + response selection. Extends the existing `src/objectionWorkflow.js` rather than replacing it. |
| **W5.2.2** | O5 forces humour level ≤ 1 (MANUAL explicitly notes "reduce the joking"). |
| **W5.2.3** | O1 and O2 must pull the **live** package inclusions from `refal_offers_and_pricing`, never from a frozen list. |
| **W5.2.4** | Each objection response still obeys the Golden Formula and the One Question Rule. |

---

### Phase P5.3 — Jurisdiction benchmarking `[ ]`

MANUAL 3.3. Four comparisons. **Rule: never attack another country, never claim "we are always the best".**

| ID | Comparison | Angle |
| --- | --- | --- |
| **J1** | Cyprus vs Dubai/UAE | Dubai is excellent with no personal income tax; Cyprus gives a direct EU gateway, an EU VAT number, and real substance that eases payment gateways and EU expansion. Often an addition to the structure, not a replacement. |
| **J2** | Cyprus vs Estonia | Estonia is excellent for e Residency but gives no actual residence or property stability, and taxes at distribution. Cyprus gives a flexible tax system, real presence, and tangible residency and property paths. |
| **J3** | Cyprus vs Malta/Bulgaria | Bulgaria 10% but banking constraints and language/environment complexity. Malta has a complex refund system. Cyprus is direct (15%), English is widely used, with a stable property market and residency. |
| **J4** | Cyprus vs USA | US LLC/Inc is excellent for Stripe and e commerce, but complex for non resident taxation and lacks direct EU market access. |

Every comparison ends with the MANUAL's discovery question, because the honest answer is always "it depends on where your clients, your bank, and your family are".

| Wave | Work |
| --- | --- |
| **W5.3.1** | `src/jurisdictionBenchmark.js` + a knowledge source per comparison (these are facts, so they belong in the corpus; add 4 topics to the taxonomy as `jurisdiction-*`, raising the corpus to 29 topics / 87 sources). |
| **W5.3.2** | Tone guard: reject any draft that disparages another jurisdiction. |

---

### Phase P5.4 — Hook and offer orchestration `[ ]`

One place decides, per turn, what REFAL may offer: hook, objection response, specialist, booking, or nothing. Resolves conflicts between M5's eagerness and the existing consent/no repeat rules, which always win.

---

# MILESTONE M6 — Qualification Engine and Executive Handoff

**Exit criteria.** Every turn produces a silent 0 to 30 score across 6 dimensions, maps to one of 5 tiers, drives the right action protocol, detects instant buying signals, and generates the exact executive handoff format on escalation.

---

### Phase P6.1 — The 6 dimension scorer `[ ]`

MANUAL 4.1. Each dimension 0 to 5, total 30, **secret**.

| Dim | 0 | 5 |
| --- | --- | --- |
| **NEED** | general exploratory interest | a very clear and specific commercial or investment need |
| **VALUE** | simple free enquiry | a major investment/property deal or a large partner structure |
| **TIMING** | just looking for the far future | intent to execute within days or this month |
| **AUTHORITY** | gathering information, no decision power | the direct owner or chairman |
| **READINESS** | total hesitation and fear | capital and documents ready, wants to start |
| **FIT** | activity that Cyprus does not serve | full strategic fit with Refalco services |

| Wave | Work |
| --- | --- |
| **W6.1.1** | `src/qualificationEngine.js`: pure, deterministic, auditable scoring from conversation state. Extends `src/leadQualification.js` and `src/leadTemperature.js` rather than replacing them. |
| **W6.1.2** | Signal extraction per dimension, trilingual, with an explicit evidence trail (which turn moved which dimension) for the handoff summary. |
| **W6.1.3** | Score is monotonic within a conversation except on an explicit customer correction. |
| **W6.1.4** | **Leak test**: the score, the dimension names, and the tier must never appear in a customer reply. Extends the existing internal reasoning detector in `responsePolicy.js`. |

---

### Phase P6.2 — Tiers and action protocols `[ ]`

MANUAL 4.2.

| Tier | Range | Protocol |
| --- | --- | --- |
| **Informational** | 0 – 7 | Answer directly and briefly. No pressure to book. Help without draining. |
| **Cold Lead** | 8 – 13 | General information, one exploratory question, save to CRM for quiet follow up. |
| **Warm Lead** | 14 – 19 | Continue smart qualification, offer sales hints, offer an appointment flexibly. |
| **Hot Lead** | 20 – 24 | **STOP OVER SELLING immediately.** Request contact details, book the appointment. |
| **Strategic Lead** | 25 – 30 | **Priority escalation.** Urgent executive summary, assign a senior consultant. Large landowners, construction tenders, HNW (€1M+), international partnerships. |

| Wave | Work |
| --- | --- |
| **W6.2.1** | `src/leadTiers.js` mapping and protocol directives injected into the prompt. |
| **W6.2.2** | **Stop over selling switch** at Hot: suppresses every sales hook and every benefit hint, switches to logistics. |
| **W6.2.3** | Strategic routing to the right department (Corporate / Tax / Real Estate / Residency / Construction). |
| **W6.2.4** | **The tier never overrides consent.** A Hot tier still requires the customer's clear yes before a handover is created. The existing consent machinery wins. |

---

### Phase P6.3 — Instant buying signals `[ ]`

MANUAL 4.3. On any of these, REFAL stops explaining and moves to close:
- "How do I start the procedures with you?"
- "What documents do you need from me now?"
- "Payment method and how do I confirm the booking?"
- "Can I speak to the consultant or visit your office?"
- "I have land for development / I have financing ready for the project."

`src/buyingSignals.js`, trilingual including Arabizi and Greeklish. Firing a buying signal raises the score floor and triggers the P6.4 flow.

---

### Phase P6.4 — Double choice appointment flow `[ ]`

MANUAL 4.3. ❌ "Do you want to book? When would you like to talk?" (open ended).
✅ Step 1: "Does today or tomorrow suit you better?" Step 2 (after the day, from the live API): "I have 11:30 or 3:00 available, which is easier for you?"

| Wave | Work |
| --- | --- |
| **W6.4.1** | Extend `src/agentBookingTools.js` / `src/booking.js` with the two step flow. |
| **W6.4.2** | Step 2 slots come only from `listCalendarSlots` (P4.2). Never invent a slot. |
| **W6.4.3** | Visitor timezone handling (already a rule in `config/refal-agent-rules.md:51`). |
| **W6.4.4** | `pending_review` is **not** a confirmation; the existing wording invariant stands. |

---

### Phase P6.5 — Executive Handoff Summary `[ ]`

MANUAL 5.2 gives the exact block format. Reproduce it byte for byte.

```
==================================================
REFAL LEAD SUMMARY — EXECUTIVE HANDOFF
==================================================
CLIENT PROFILE:
- Name / Phone-WhatsApp / Email / Country of Residence / Nationality / Language

COMMERCIAL INTENT & OPPORTUNITY:
- Primary Intent / Secondary Intent / Business Activity-Project /
  Estimated Budget-Value / Timeline / Decision Authority

QUALIFICATION & SCORE:
- Lead Score [XX / 30] / Lead Classification / Main Motivation / Main Concern-Objection

RECOMMENDATION & ROUTING:
- Recommended Department / Assigned Consultant-Role / Recommended Next Action /
  Appointment Status [CONFIRMED | PENDING] / Appointment Date & Time

CONVERSATION SUMMARY:
[3-4 sentences]
==================================================
```

| Wave | Work |
| --- | --- |
| **W6.5.1** | `src/executiveHandoff.js` generating the exact block. Extends `src/handover.js`. |
| **W6.5.2** | Summary contains only customer stated facts plus system state. Unconfirmed items are labelled unconfirmed. |
| **W6.5.3** | Delivered to the dashboard handover record and, where configured, email. Never shown to the customer. |
| **W6.5.4** | Format test: golden fixture comparison, exact separators and field names. |
| **W6.5.5** | MANUAL rule "the human advisor should never have to re ask the customer": the summary must carry every CRM field captured in M7. |

---

### Phase P6.6 — Strategic escalation `[ ]`

Landowner JV, construction tender, HNW €1M+, international partnership. Urgent path, senior consultant, and for construction **explicitly no price or estimate from the agent at all** (MANUAL 2.6).

---

# MILESTONE M7 — CRM Memory

**Exit criteria.** All four MANUAL 5.1 field groups are captured progressively and silently, and REFAL never re asks something the customer already said.

---

### Phase P7.1 — CRM schema `[ ]`

| Group | Fields (MANUAL 5.1) |
| --- | --- |
| **Identity** | Name, Phone/WhatsApp, Email, Preferred Language, Nationality, Country of Residence |
| **Opportunity** | Primary Intent, Target Service, Business Activity, Existing or New Business, Target Markets, Banking/Payment Gateway Need |
| **Property & Residency** | Residency Interest, Investment Budget, Preferred City, Purpose (Living/Investment), Family Members, Source of Funds Status, Source of Wealth Overview |
| **Qualification** | Timeline, Main Motivation, Main Fear/Objection, Decision Authority, Lead Score, Lead Tier, Next Action, Appointment Status |

Migration `refal_lead_profile`, one row per contact, RLS, service role only, PII handled under the existing `sensitiveData` redaction rules.

---

### Phase P7.2 — Progressive silent capture `[ ]`
Extract fields from the conversation without asking. Never more than one explicit question per turn (One Question Rule). Never ask for identity documents in chat.

---

### Phase P7.3 — The never re ask rule `[ ]`
MANUAL 5.1, strict: it is absolutely forbidden to re ask something already said in the same conversation (country, budget, family). Implement as a **pre send gate**: if the drafted question targets a field already present in `refal_lead_profile` with sufficient confidence, reject the draft and regenerate.

**Verification.** `src/neverReAsk.test.js` with multi turn fixtures per language.

---

### Phase P7.4 — Memory stays untrusted `[ ]`
Reaffirm the existing boundary: memory is continuity, never evidence for a company fact, and never an instruction. Covered today by `src/ai.js:222`; add explicit tests so M7 cannot erode it.

---

# MILESTONE M8 — Multilingual Parity

**Exit criteria.** Arabic, English, and Greek score within 10% of each other on the golden set. Dialect and transliteration are handled.

---

### Phase P8.1 — Arabic `[ ]`
ARCH 2.b: simplified warm white dialect or accessible near MSA. **Explicitly avoid dry lawyer language and complex government text.** Existing rules already require Levantine mirroring for colloquial input (`config/refal-agent-rules.md:21`). Extend `src/language.js` Arabizi detection with the MANUAL's commercial vocabulary.

### Phase P8.2 — Greek `[ ]`
Professional business Greek. Extend the existing Greeklish detector with the corporate, tax, residency, and property vocabulary of the new corpus.

### Phase P8.3 — English `[ ]`
Business casual: practical, confident, warm. Simple and clear without excessive legal complexity.

### Phase P8.4 — Cross language retrieval parity `[ ]`
Every golden question in each language retrieves its own language document first. The language lock in `src/refalcoAnswer.js:35` stays. Measure and close per topic per language retrieval gaps.

### Phase P8.5 — Native persona and humour per language `[ ]`
Humour and hooks are authored natively, not translated. A Levantine joke and a Greek pleasantry are different artefacts. Reviewed by a native speaker per language before sign off.

---

# MILESTONE M9 — Scale and Reliability

**Why.** BOSS's requirement is "handle all users". Today: one Baileys worker, in process rate limiting that resets on restart, and a local embedding model loaded per process.

---

### Phase P9.1 — Concurrency model `[ ]`
Per contact serialisation (two messages from one customer must not race), bounded global concurrency, a work queue with retry, and idempotency on inbound receipts (`rafa_inbound_message_receipts` already exists).

### Phase P9.2 — Shared rate limiting `[ ]`
Move `src/rateLimiter.js` counters from process memory to Supabase so limits survive restarts and hold across processes.

### Phase P9.3 — Retrieval performance `[ ]`
HNSW parameter review, embedding warmup on both `src/bot.js` and `dashboard/server.js` (each process needs its own call), query embedding cache for repeated questions, and a p95 latency budget per turn.

### Phase P9.4 — Token and cost budget `[ ]`
The assembled brain prompt is large. Measure it. Set a hard ceiling. Role directives capped at 2, evidence capped at 5 chunks (current behaviour), memory capped. Track cost through the existing `src/aiUsage.js`.

### Phase P9.5 — Observability `[ ]`
Per turn trace: detected language, humour level, active roles, intents, hooks considered and suppressed, retrieved chunk ids, claim classifications, score deltas, tier, gates that fired. Extends `src/agentObservability.js` and `src/operationalTelemetry.js`. **No PII in traces.**

### Phase P9.6 — Load test `[ ]`
Simulate N concurrent conversations across all three languages. Measure latency, error rate, retrieval quality under load, and cost per conversation. Record the safe concurrency ceiling.

---

# MILESTONE M10 — Evaluation and Go Live

### Phase P10.1 — Golden set scoring `[ ]`
Run all 720+ golden questions. Target: ≥90% factual accuracy, 100% grounding, 0 guardrail failures, ≥85% Golden Formula compliance, language parity within 10%.

### Phase P10.2 — Shadow mode `[ ]`
Run the brain against live traffic in shadow (the existing `src/agentShadow.js` flag, default off) and compare against the current production answers. No customer sees a difference until P10.5.

### Phase P10.3 — Red team round 2 `[ ]`
Full adversarial sweep including prompt injection planted inside an uploaded knowledge document, guarantee extraction, eligibility extraction, price fabrication, PII extraction, cross customer data probing.

### Phase P10.4 — Operator acceptance `[ ]`
BOSS and the advisory team review a curated set of real transcripts per language and per domain. Sign off recorded in this file.

### Phase P10.5 — Staged rollout `[ ]`
Enable for an internal test number → a small customer cohort → full traffic. Each stage gated on error rate and guardrail failures. Documented rollback: one env flag returns to the pre brain path, because M2 kept the legacy gate intact.

---

## 11. Decisions — ALL RESOLVED, no blockers

Per the Authority Rule, every decision resolves in favour of the source files. Nothing below needs BOSS input before work starts.

| ID | Question | **RESOLVED** | Authority |
| --- | --- | --- | --- |
| **D-1** | Company identity in the repo | **REFAL is Refalco Group's agent, explicitly.** `AGENTS.md`'s "no company identity is bundled" prohibition is **removed**. Identity, brand and departments live in `config/company-profile.json`; the credibility numbers (2000, 20+ years, 47, 400+) live in the `company-profile` knowledge source so they stay evidence gated and citable. The literal `"the business"` placeholder is deleted from every prompt and rule file. | MB 1.0, MB 2.0, MB-C1..C5, BLK-3 |
| **D-2** | Emoji | **Allowed, gated by humour level.** L0 none, L1 👍 only, L2 😄 👀 👍, L3 full including 😂. MB's voice depends on them. Dash punctuation stays banned (house style, no MB conflict). | MB 1.2, BLK-7 |
| **D-3** | Reply length | **2 to 5 sentences, max 700 characters** for the ordinary preset. The 3 sentence / 500 character cap is removed. Expanded preset (20 sentences / 1800 chars) stays for an explicit "tell me everything". | MB-G2, BLK-4 |
| **D-4** | Corporate tax "15% from 2026" | Authored verbatim as MB states it, with an explicit `effective_from = 2026` and a `valid_until`, plus the rate also mirrored in `refal_offers_and_pricing` style live data so a change is a data edit, not a code change. REFAL states the rate exactly as the approved evidence words it, never paraphrased. | MB-F19 |
| **D-5** | Handoff delivery | Dashboard handover record **plus** the existing email notification path, in the exact MB 5.2 block format. An external CRM connector is deferred to M11 and is not in scope here. | MB-HO1..HO3 |
| **D-6** | Knowledge authoring ownership | **Claude authors all 87 documents** from the MB extraction in `SOURCE-ANALYSIS.md` section 6, natively per language. Every document is a faithful rendering of an MB-F fact, nothing invented. BOSS reviews before the corpus is marked approved in M10 P10.4. | MB module 2, AR-A9 |
| **D-7** | Target runtime | **The agentic loop** (`src/agentLoop.js` + `src/agentTools.js`), because MB-DYN1..DYN6 require live tool calls. The deterministic router keeps working for simple turns; it is not deleted. | AR-A4, MB 5.3 |
| **D-8** | Proactive cross selling | **Required, not forbidden.** The prompt rule "do not volunteer unrelated prices, packages, services or sales details" is rewritten: a hook is permitted once per conversation per trigger, after the customer's question has been answered, subject to the P5.4 suppression rules. | MB-X1..X6, BLK-5 |
| **D-9** | Offering a call during information gathering | **Tier aware, not blanket forbidden.** Suppressed at Informational and Cold, permitted at Warm, **required** at Hot and on any buying signal. | MB-T1..T5, MB-B1..B5, BLK-6 |
| **D-10** | Residency / tax / licence content | **Allowed as PROGRAM_FACT with approved evidence.** The blanket blocklist is replaced by the three class claim policy. Personalized eligibility and guarantees stay blocked. | MB-F19..F55, MB-SEC1, MB-SEC5, BLK-1, BLK-2, BLK-8 |

### 11.1 Blocker removal register

Each blocker from `SOURCE-ANALYSIS.md` section 11 is owned by exactly one phase. Nothing is left pending.

| Blocker | Owning phase | Action |
| --- | --- | --- |
| BLK-1 blanket `containsProhibitedClaim` | **P2.2** | Replace with claim policy |
| BLK-2 `restrictedRefalcoReply` hard refusals | **P2.2** | Replace with evidence gated answers |
| BLK-3 "no company identity", `"the business"` placeholder | **P1.1** | Remove prohibition, delete placeholder |
| BLK-4 3 sentence / 500 char cap | **P1.4** | Raise to 5 / 700 |
| BLK-5 "do not volunteer services or sales details" | **P1.6 + P5.4** | Rewrite rule, add hook orchestration |
| BLK-6 "do not introduce a call during info gathering" | **P1.6 + P6.2** | Make tier aware |
| BLK-7 no emoji policy | **P1.3** | Per level allowlist |
| BLK-8 blanket "investment" refusal | **P2.2** | Narrow to advice and returns |
| BLK-9 one approved revision per source | **P0.3** | Keep, shape the taxonomy around it |
| BLK-10 30 day price expiry | **P3.8 + P4.1** | Keep mechanism, serve live offer from the table |
| BLK-11 in process rate limiting | **P9.1 + P9.2** | Shared Supabase backed limits |
| BLK-12 no dynamic commercial tables | **P4.1 + P4.2** | Build six tables + six tools |

---

## 12. Traceability matrix

Every requirement from both source documents, mapped to its owning phase. **G3 for each phase re checks its own rows.** A requirement with no `COVERED` mark at M10 is a release blocker.

### MANUAL Module 1 — Identity, Persona, Core Rules

| Ref | Requirement | Phase | Status |
| --- | --- | --- | --- |
| 1.0 | Strategic positioning: consultative system, not an FAQ bot; lead qualification engine | P1.2 | `[ ]` |
| 1.1 | 10 operational roles, running in parallel by context | P1.2 | `[ ]` |
| 1.2 | Adaptive mirroring (casual ↔ executive) | P1.2 | `[ ]` |
| 1.2 | Humour levels 0, 1, 2 default, 3 | P1.3 | `[ ]` |
| 1.2 | 6 absolute humour bans | P1.3 | `[ ]` |
| 1.3 | Golden Answer Formula (answer + benefit + one question) | P1.4 | `[ ]` |
| 1.3 | 2 to 5 sentence default length | P1.4 | `[ ]` |
| 1.3 | One Question Rule | P1.4 | `[ ]` |
| 1.3 | Worked example: formation cost ❌/✅ | P1.4 | `[ ]` |
| 1.3 | Worked example: corporate tax ❌/✅ | P1.4 | `[ ]` |
| 1.3 | AP-1 phone number obsession | P1.5 | `[ ]` |
| 1.3 | AP-2 legal disclaimer overload | P1.5 | `[ ]` |
| 1.3 | AP-3 fear based selling | P1.5 | `[ ]` |
| 1.3 | AP-4 fake promises / absolute guarantees | P1.5, P2.1 | `[ ]` |
| 1.3 | AP-5 interrogation / multi question overload | P1.5 | `[ ]` |

### MANUAL Module 2 — Knowledge Base

| Ref | Requirement | Phase | Status |
| --- | --- | --- | --- |
| 2.0 | Refalco depth: 2000, 20+ years, 47 developments, 400+ projects | P3.7 | `[ ]` |
| 2.0 | Positioning as a gateway to comprehensive solutions, not a registration office | P3.7 | `[ ]` |
| 2.1 | Full company lifecycle, 10 stages | P3.1 | `[ ]` |
| 2.1 | €999 + VAT package, all 7 inclusions | P3.1, P4.1 | `[ ]` |
| 2.1 | Company Secretary 4 months, statutory not personal | P3.1 | `[ ]` |
| 2.1 | Registered Address 4 months, not an office | P3.1 | `[ ]` |
| 2.1 | ~2 weeks incorporation after documents complete | P3.1 | `[ ]` |
| 2.1 | Branch vs Subsidiary vs new Ltd | P3.1 | `[ ]` |
| 2.1 | Shareholder vs Director | P3.1 | `[ ]` |
| 2.1 | Ownership and director changes later | P3.1 | `[ ]` |
| 2.1 | Registered vs physical/virtual office, substance opportunity | P3.1 | `[ ]` |
| 2.1 | Privacy vs illegal UBO concealment | P3.1 | `[ ]` |
| 2.1 | Dormant company obligations | P3.1 | `[ ]` |
| 2.1 | Liquidation is a formal procedure | P3.1 | `[ ]` |
| 2.2 | Corporate tax from 15% from 2026 | P3.2 | `[ ]` |
| 2.2 | IP Box ~2.5 to 3%, not automatic | P3.2 | `[ ]` |
| 2.2 | Dividends vs Salary, personal tax residency and DTT | P3.2 | `[ ]` |
| 2.2 | Holding vs Trading comparison, all 4 rows | P3.2 | `[ ]` |
| 2.2 | VAT number and EORI for trading | P3.2 | `[ ]` |
| 2.2 | IP Box sales hook script | P5.1 H1 | `[ ]` |
| 2.3 | Banking golden rule, no promises | P2.3, P3.3 | `[ ]` |
| 2.3 | Stripe / PayPal / Amazon / Shopify covered | P2.3, P3.3 | `[ ]` |
| 2.3 | Stripe dialogue script | P2.3 | `[ ]` |
| 2.4 | PR minimum €300,000 + VAT | P3.4 | `[ ]` |
| 2.4 | Income €50,000 / +€15,000 / +€10,000 | P3.4 | `[ ]` |
| 2.4 | Non Dom 0% dividends and interest, 17 years | P3.4 | `[ ]` |
| 2.4 | Source of Funds vs Source of Wealth | P3.4 | `[ ]` |
| 2.4 | Category A, first sale from developer | P3.4 | `[ ]` |
| 2.4 | Category B, other property types | P3.4 | `[ ]` |
| 2.4 | Category C, company share capital with substance | P3.4 | `[ ]` |
| 2.4 | Category D, AIF / AIFLNP funds | P3.4 | `[ ]` |
| 2.4 | Relocation: schools, ask children's ages | P3.4, P5.1 H3 | `[ ]` |
| 2.4 | GESY + private insurance | P3.4 | `[ ]` |
| 2.4 | Cost of living and cars are variable, fresh estimate needed | P3.4 | `[ ]` |
| 2.5 | Buyer journey, 10 stages | P3.5 | `[ ]` |
| 2.5 | Off plan vs Completed | P3.5 | `[ ]` |
| 2.5 | Property VAT 19% / reduced 5% | P3.5, P2.4 | `[ ]` |
| 2.5 | Reservation deposit guardrail, never guess | P2.4, P4.1 | `[ ]` |
| 2.5 | 4 cities comparison | P3.5 | `[ ]` |
| 2.5 | ROI and price rise reply script | P2.4, P3.5 | `[ ]` |
| 2.6 | Landowner JV: indicators, questions, escalation | P3.6, P6.6 | `[ ]` |
| 2.6 | Construction tenders: indicators, questions, no estimates | P3.6, P6.6 | `[ ]` |
| 2.6 | Trademarks CY/EU | P3.6, P5.1 H5 | `[ ]` |
| 2.6 | Shareholders Agreements | P3.6 | `[ ]` |
| 2.6 | Service and Employment Agreements | P3.6 | `[ ]` |
| 2.6 | T&Cs and GDPR advisory | P3.6 | `[ ]` |

### MANUAL Module 3 — Sales Logic

| Ref | Requirement | Phase | Status |
| --- | --- | --- | --- |
| 3.0 | Selling through curiosity and relevance, not hard selling | P5.1 | `[ ]` |
| 3.1 | Hook: formation → PR + property | P5.1 H2 | `[ ]` |
| 3.1 | Hook: software → IP Box | P5.1 H1 | `[ ]` |
| 3.1 | Hook: €300k+ non EU → PR | P5.1 H2 | `[ ]` |
| 3.1 | Hook: PR request → Category A residential | P5.1 H6 | `[ ]` |
| 3.1 | Hook: relocating to work → substance and offices | P5.1 H4 | `[ ]` |
| 3.1 | Hook: new brand → EU Trademark | P5.1 H5 | `[ ]` |
| 3.2 | Objection O1 €999 expensive | P5.2 | `[ ]` |
| 3.2 | Objection O2 found at €500 | P5.2 | `[ ]` |
| 3.2 | Objection O3 I will think about it | P5.2 | `[ ]` |
| 3.2 | Objection O4 send everything on WhatsApp | P5.2 | `[ ]` |
| 3.2 | Objection O5 distrust, reduce humour | P5.2 | `[ ]` |
| 3.3 | Cyprus vs Dubai | P5.3 J1 | `[ ]` |
| 3.3 | Cyprus vs Estonia | P5.3 J2 | `[ ]` |
| 3.3 | Cyprus vs Malta / Bulgaria | P5.3 J3 | `[ ]` |
| 3.3 | Cyprus vs USA | P5.3 J4 | `[ ]` |
| 3.3 | Never attack other jurisdictions | P5.3 | `[ ]` |

### MANUAL Module 4 — Qualification Engine

| Ref | Requirement | Phase | Status |
| --- | --- | --- | --- |
| 4.0 | Engine runs silently, customer never feels measured | P6.1 | `[ ]` |
| 4.1 | NEED 0-5 | P6.1 | `[ ]` |
| 4.1 | VALUE 0-5 | P6.1 | `[ ]` |
| 4.1 | TIMING 0-5 | P6.1 | `[ ]` |
| 4.1 | AUTHORITY 0-5 | P6.1 | `[ ]` |
| 4.1 | READINESS 0-5 | P6.1 | `[ ]` |
| 4.1 | FIT 0-5 | P6.1 | `[ ]` |
| 4.2 | Informational 0-7 protocol | P6.2 | `[ ]` |
| 4.2 | Cold 8-13 protocol | P6.2 | `[ ]` |
| 4.2 | Warm 14-19 protocol | P6.2 | `[ ]` |
| 4.2 | Hot 20-24, stop over selling | P6.2 | `[ ]` |
| 4.2 | Strategic 25-30, priority escalation | P6.2, P6.6 | `[ ]` |
| 4.3 | 5 instant buying signals | P6.3 | `[ ]` |
| 4.3 | Double choice appointment offering | P6.4 | `[ ]` |
| 4.3 | Live slots from the API as step 2 | P6.4, P4.4 | `[ ]` |

### MANUAL Module 5 — CRM, Handoff, Architecture

| Ref | Requirement | Phase | Status |
| --- | --- | --- | --- |
| 5.1 | Identity field group | P7.1 | `[ ]` |
| 5.1 | Opportunity field group | P7.1 | `[ ]` |
| 5.1 | Property and residency field group | P7.1 | `[ ]` |
| 5.1 | Qualification field group | P7.1 | `[ ]` |
| 5.1 | Strict never re ask rule | P7.3 | `[ ]` |
| 5.2 | Executive Handoff Summary exact format | P6.5 | `[ ]` |
| 5.3 | No absolute promises | P2.1, P1.5 | `[ ]` |
| 5.3 | AML / sanctions immediate compliance escalation | P2.5 | `[ ]` |
| 5.3 | SoF vs SoW without frightening the customer | P3.4, P2.5 | `[ ]` |
| 5.3 | Never request password / card / sensitive statement in chat | P2.5 | `[ ]` |
| 5.3 | General approved info only, no binding legal or tax opinion | P2.1 | `[ ]` |
| 5.3 | LIVE_PROPERTY_INVENTORY dynamic | P4.1, P4.2 | `[ ]` |
| 5.3 | RESERVATION_DEPOSIT_RULES dynamic | P4.1, P2.4 | `[ ]` |
| 5.3 | ANNUAL_RENEWAL_FEES dynamic | P4.1 | `[ ]` |
| 5.3 | LIVE_CALENDAR_SLOTS dynamic | P4.4 | `[ ]` |
| 5.3 | GOVERNMENT_THIRD_PARTY_FEES dynamic | P4.1 | `[ ]` |
| 5.3 | ACTIVE_PROMOTIONS dynamic | P4.1, P3.8 | `[ ]` |
| 5.3 | None of the six frozen in a prompt | P4.3 | `[ ]` |

### ARCH (plan.txt)

| Ref | Requirement | Phase | Status |
| --- | --- | --- | --- |
| 1 | 3 layer split: prompt / RAG / dynamic tables | M1, M3, M4 | `[ ]` |
| 1 | Do not put everything in the system prompt | P9.4 | `[ ]` |
| 2.a | Golden Response Formula | P1.4 | `[ ]` |
| 2.b | Arabic: simplified warm white dialect, avoid dry legal language | P8.1 | `[ ]` |
| 2.b | English: business casual, confident, warm | P8.3 | `[ ]` |
| 2.b | Greek: professional business Greek | P8.2 | `[ ]` |
| 2.b | Mirroring rule | P1.2 | `[ ]` |
| 2.c | Humour calibration 0/1/2 | P1.3 | `[ ]` |
| 3 | `leads` table | P7.1 | `[ ]` |
| 3 | `conversations` memory table | P7.1, P7.3 | `[ ]` |
| 3 | `offers_and_pricing` table | P4.1 | `[ ]` |
| 3 | `real_estate_inventory` table | P4.1 | `[ ]` |
| 4 | IP Box hook | P5.1 H1 | `[ ]` |
| 4 | Residency hook (non EU, ≥€300k) | P5.1 H2 | `[ ]` |
| 4 | Relocation hook (schools, GESY, Non Dom 17y) | P5.1 H3 | `[ ]` |
| 5 | 0-30 scoring, 6 dimensions | P6.1 | `[ ]` |
| 5 | 5 tiers with action protocols | P6.2 | `[ ]` |
| 5 | Executive handoff summary to CRM | P6.5 | `[ ]` |
| Dev plan | Adopt the manual as the reference document | this file | `[x]` |
| Dev plan | Set the system prompt from the operating rules | P1.6 | `[ ]` |
| Dev plan | Upload files to Supabase vector embeddings | P3.8 | `[ ]` |
| Dev plan | Wire webhooks between the AI engine and Supabase | P4.2, P9.5 | `[ ]` |

---

## 13. Risk register

| ID | Risk | Impact | Mitigation | Owner phase |
| --- | --- | --- | --- | --- |
| **R1** | Existing guardrails silence the new corpus | The whole brain looks broken at runtime | M2 runs before M3; `scripts/auditClaimGates.js` is the proof | M2 |
| **R2** | The guardrail rewrite weakens a real safeguard | Compliance exposure | Branch do not replace; every changed test assertion documented; red team twice | P2.2, P2.6, P10.3 |
| **R3** | Price knowledge expires after 30 days and REFAL goes quiet | Customers get "not confirmed" on the €999 offer | Dynamic offers table + the expiry dashboard in P3.8 | P3.8, P4.1 |
| **R4** | Translated rather than natively authored AR/EL content reads badly | Loss of trust in exactly the two languages the brand needs | Native authoring requirement + native speaker sign off | M3, P8.5 |
| **R5** | Prompt grows past the token budget | Latency and cost blow up, quality drops | Hard ceiling measured in P9.4, role directives capped at 2 | P9.4 |
| **R6** | One approved revision per source is discovered late | Corpus has to be restructured mid build | Taxonomy frozen in P0.3 before any authoring | P0.3 |
| **R7** | Prompt injection planted inside an uploaded knowledge document | The agent obeys an attacker | Evidence is already data not instructions; `containsPromptInjection` on every chunk; explicit red team case | P10.3 |
| **R8** | Scale: single worker and in memory rate limits | Dropped or duplicated messages under load | M9 before full rollout | M9 |
| **R9** | Sales hooks fire in a sensitive context | Brand damage | Humour level 0 suppresses all hooks; orchestration in P5.4 | P5.4 |
| **R10** | Score or tier leaks into a customer reply | Embarrassment and loss of trust | Leak test in P6.1, extends the existing internal reasoning detector | P6.1 |

---

## 14. Standing verification commands

```bash
# Full suite, real exit code
npm test > /tmp/refal-test.log 2>&1; echo "exit=$?"; tail -40 /tmp/refal-test.log

# Dashboard
npm --prefix dashboard test  > /tmp/refal-dash.log  2>&1; echo "exit=$?"
npm --prefix dashboard run build > /tmp/refal-build.log 2>&1; echo "exit=$?"

# Brain specific
node scripts/brainHealth.js      > /tmp/brain-health.log 2>&1; echo "exit=$?"
node scripts/auditClaimGates.js  > /tmp/claim-gates.log  2>&1; echo "exit=$?"
node scripts/validateTaxonomy.js > /tmp/taxonomy.log     2>&1; echo "exit=$?"
node scripts/redTeamBrain.js     > /tmp/redteam.log      2>&1; echo "exit=$?"

# Knowledge and conversation quality
npm run eval:knowledge   > /tmp/evalk.log  2>&1; echo "exit=$?"
node scripts/evaluateRag.js > /tmp/rag.log 2>&1; echo "exit=$?"
npm run benchmark:agent  > /tmp/bench.log  2>&1; echo "exit=$?"
```

> Never judge a result from a piped command. Redirect, echo the exit code, then tail.

---

## 15. Phase completion log

Append one Result block per completed phase at G1. Never delete an entry.

```
### <PHASE ID> — <name> — completed <date>
Built:
Files touched:
Verification: <command> exit=<n>
Gap scan: <COVERED/PARTIAL/MISSING counts>
Auto fixes applied:
Deviations from plan:
Explicitly NOT done:
BOSS sign off:
```

### P0.1 — Truth baseline — 2026-10-07 — `[~]` 3 of 4 waves

**Built:**
- `docs/brain/SOURCE-ANALYSIS.md` — deep extraction of both source files, **183 stable requirement IDs** (MB-*, AR-*), plus the 12 blocker register and the "what is NOT removed" list.
- `docs/brain/SURFACE-AND-GATE-INVENTORY.md` — W0.1.1 (14 customer facing surfaces) and W0.1.2 (16 policy gates, each marked KEEP / MODIFY / REPLACE against MB).
- Master plan updated: Authority Rule added, all 10 decisions resolved, blocker removal register added, P1.1 and P1.6 rewritten to remove BLK-3/5/6.

**Files touched:** `docs/brain/SOURCE-ANALYSIS.md` (new), `docs/brain/SURFACE-AND-GATE-INVENTORY.md` (new), `.planning/REFAL-BRAIN-MASTER-PLAN.md`.

**Verification (G2):** `npm test` → **exit=0**, 670 tests, 670 pass, 0 fail, 483.5 s.
Not run, stated as unrun: `npm --prefix dashboard test`, `npm --prefix dashboard run build`.

**Gap scan (G3):** W0.1.1 COVERED, W0.1.2 COVERED, W0.1.4 COVERED, **W0.1.3 MISSING** (database baseline).

**Major finding that changes the plan (in BOSS's favour):** six MB subsystems are already partially implemented with the exact MB values.
- `src/leadQualification.js` already has `DIMENSIONS = ["need","value","timing","authority","readiness","fit"]` = **MB-D1..D6 exactly**.
- …and `{ warm: 14, hot: 20, strategic: 25 }` = **MB-T3/T4/T5 exactly**, with a code comment citing "Owner rules".
- `src/handover.js` already builds and formats a `REFAL LEAD SUMMARY` → P6.5 is a format upgrade, not a build.
- `src/agentTools.js` already has a working 6 tool registry → P4.2 adds tools to it.
- `src/intent.js` has a 40+ intent taxonomy covering every MB role domain → P1.2 maps onto it.
- Hybrid RAG is production grade → **M3 is content work, not infrastructure work.**

**Auto fixes applied (G4):** none needed; no check failed.

**Deviations from plan:** none.

**Explicitly NOT done:**
- W0.1.3 database baseline. Blocked on Supabase connectivity (per project memory, the McAfee proxy returns 407 for Supabase; `HTTP_PROXY` must be unset). Carried into P0.2.
- Dashboard test and build not executed.
- Nothing committed. No code changed yet, only new documentation.

**BOSS sign off:** _pending_
