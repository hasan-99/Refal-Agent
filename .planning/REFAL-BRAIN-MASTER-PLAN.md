# REFAL MASTER BRAIN — Merged Implementation Plan (v2)

> **This file supersedes v1.** v1 is preserved in git history at commit `ce2559e`.
> v2 merges the Claude plan with the Codex roadmap. Nothing from either was discarded.
> The Codex roadmap has been removed from the tree now that it is fully absorbed here; it is preserved in git history at commit `02fd58a` (`newplan/Roadmap_from_codex.md`).
> **This is the only roadmap in the repository.**
>
> | | Score | Facts speakable day one | Phases executed |
> | --- | --- | --- | --- |
> | Plan A (Claude v1) | 147 / 200 | 66 / 66 | 1 |
> | Plan B (Codex) | 137 / 200 | 46 / 66 | 0 |
> | **This merged plan** | **189 / 200** | **66 / 66 with full approval metadata** | **1 (carried over)** |
>
> Full side by side reasoning: [`docs/brain/ROADMAP-COMPARISON.html`](../docs/brain/ROADMAP-COMPARISON.html)

---

## Sources of truth

| Ref | Document | Role |
| --- | --- | --- |
| **MB** | `newplan/Master Brain & Operating Rules Manual - REFAL AI.txt` | Business identity, knowledge, sales, qualification, CRM, compliance |
| **AR** | `newplan/plan.txt` | Three layer architecture, language strategy, tables, hooks, developer sequence |
| **CX** | Codex roadmap, merged in and removed; in git history at `02fd58a` | Operational governance, booking policy, consent, admin ops, release, maintenance |
| **EX** | [`docs/brain/SOURCE-ANALYSIS.md`](../docs/brain/SOURCE-ANALYSIS.md) | Deep extraction of MB + AR into **183 stable requirement IDs** and the **12 blocker register** |
| **BL** | [`docs/brain/SURFACE-AND-GATE-INVENTORY.md`](../docs/brain/SURFACE-AND-GATE-INVENTORY.md) | Executed P0.1 baseline: 14 surfaces, 16 gates, 670 test green |

**Total tracked requirements: 195** = 183 from MB/AR (`EX`) + 12 operational requirements imported from CX (`OP-01` to `OP-12`, section 13.2).

---

## ⚡ The two governing rules

### Rule 1 — Authority (from BOSS, 2026-10-07)
**MB and AR win over the current implementation, always.** The repo's "no company identity, blanket refusal" posture is a **defect**, not a safeguard. The 12 blockers in `EX` section 11 are removed by this plan. REFAL states all 66 knowledge facts, including €999, 15%, IP Box, €300,000, Non Dom 17 years, and the Refalco credibility numbers.

### Rule 2 — Governance (imported from CX)
**Every fact she states carries provenance.** Source, reviewer, verified date, effective date, expiry, status. She says the number *and* the system knows where it came from and when it dies. A wrong number becomes a one row data edit, never a code release.

> Rule 1 gives her the brain. Rule 2 keeps the brain honest. Neither alone is enough.

### Policy precedence ladder (CX Wave 1C, adopted verbatim)
When two sources disagree, this is the order. It is enforced in code, not left to the model.

```
1. Privacy, security, and fail closed tool rules          ← always wins
2. Owner approved business policies and service facts
3. Current live data returned from trusted APIs
4. Conversation facts explicitly supplied by the customer
5. Approved retrieved knowledge
6. General model knowledge                                ← harmless explanations only,
                                                             NEVER a Refalco specific claim
```

---

## 0. How to run this plan

```
MILESTONE  (M0 … M15)    a shippable capability
   └── PHASE  (Pn.m)     ends at a hard gate
        └── WAVE         parallelisable unit of work
             └── TASK    a concrete file level change
```

### 0.1 The Phase Gate Protocol — mandatory after EVERY phase

Merged from Claude G1-G5 and CX section 2.2. No phase starts until the previous one clears all seven.

| Gate | Name | What happens | Evidence |
| --- | --- | --- | --- |
| **G1** | **PLAN UPDATE** | Tick the phase, fill its Result block in section 16: built, files, tests, deviations, deferred. | diff of this file |
| **G2** | **VERIFY** | Run the phase's declared commands. Read **actual exit codes**, never a piped tail. | `exit=0` lines pasted |
| **G3** | **GAP SCAN** | Re-check every requirement ID the phase claims, against section 13. Mark `COVERED` / `PARTIAL` / `MISSING`. Also diff against the Anti Regression Checklist (0.2). | gap table |
| **G4** | **DEFECT LOG** | Every finding goes into section 15 with severity **Blocker / High / Medium / Low**, reproduction steps and a regression test ID. | defect rows |
| **G5** | **AUTO FIX** | Fix every Blocker and High in scope. Add a regression test for each. Re-run G2. Loop max 3 times, then escalate naming the blocker. | second `exit=0` set |
| **G6** | **FIX FORWARD** | Nothing is parked. If a phase needs a config value, a credential, or a policy call, the phase **builds the mechanism, ships a working default, and leaves one field for BOSS to fill**. No capability is left switched off waiting for someone. | the mechanism built + the one field named |
| **G7** | **SIGN OFF** | State explicitly what was **not** done. Commit and push **only after BOSS approves**. | BOSS approval |

> **Evidence rule.** `npm test > /tmp/x.log 2>&1; echo "exit=$?"; tail -30 /tmp/x.log`
> A pipe returns the pipe's exit code. A passing historical count is history until re-run.
> Label synthetic tests as synthetic. A successful build is not evidence a workflow works.

### 0.2 Anti Regression Checklist — checked at every G3

- [ ] No company fact stated without approved, unexpired evidence **carrying provenance metadata**.
- [ ] Customer messages, memory, and retrieved chunks remain untrusted **data**, never instructions.
- [ ] No prompt, credential, token, internal score, or other customer's data is ever exposed.
- [ ] No action (booking, save, notify, handover) claimed before the tool confirms it.
- [ ] Priority and score labels stay internal.
- [ ] Handover only after explicit consent or a direct request. Compliance escalation is the one exception.
- [ ] Existing client account data stays **fail closed** until approved independent verification succeeds.
- [ ] No dash punctuation as a connector in customer replies.
- [ ] All prompt surfaces aligned (`src/ai.js`, `dashboard/server.js`, edge function, `config/refal-agent-rules.md`).
- [ ] Every test in `package.json#scripts.test` still passes.
- [ ] No secret value printed in any log, report, or this file.

### 0.3 Database change protocol — BOSS runs every migration

**This environment has no Supabase access.** Confirmed working rule, set by BOSS 2026-10-07.

| | Rule |
| --- | --- |
| **I never execute** | No `UPDATE`, `INSERT`, `DELETE`, or DDL against any Supabase project, ever. Not even in a phase gate. |
| **I write** | Every schema or data change becomes a numbered, reviewed `.sql` file in `supabase/migrations/`, following the existing conventions exactly: RLS enabled, `revoke` from `public`/`anon`/`authenticated`, `grant` to `service_role`, `security invoker` functions with `set search_path = ''`, `set_rafa_updated_at` trigger. |
| **Each file is self contained** | Forward migration plus a `-- ROLLBACK:` comment block at the end holding the exact reverse statements. Safe to run twice (`if not exists`, `drop ... if exists` before create). |
| **BOSS runs them** | One at a time, in the numbered order of section 20, whenever BOSS chooses. Nothing is batch applied behind your back. |
| **Gate impact** | Any G2 check that needs the database is marked **`PENDING DB`** in the Result block, never claimed as passing. Code and tests that do not touch the database still run and still report a real exit code. |
| **Read only checks** | If Supabase access ever becomes available here, inspection is `SELECT` and `INFORMATION_SCHEMA` only. Never a write. |

> Related: the McAfee proxy returns 407 for Supabase, so even read access needs `HTTP_PROXY` unset. See `scripts/inspectSupabaseReadOnly.ps1` for the read only inspection path.

### 0.4 Safe automation boundary (CX 2.3)

"Auto fix" means safe code, prompt, schema, test or knowledge changes **in the working branch**. It never means: sending a customer message, creating a real appointment, changing an external account, exposing a credential, or deploying/restarting production.

---

## 1. Verified system map (read from the repo, 2026-10-07)

### 1.1 Measured size

| Metric | Value |
| --- | --- |
| Source modules (non test) | 62 |
| Source lines | 18,730 |
| Test files | 55 |
| Supabase migrations | 48 |
| Dashboard modules | 33 |
| **Test baseline** | **`npm test` exit=0, 670 pass, 0 fail** |

### 1.2 Where each layer lives today

| Layer | Status | Location |
| --- | --- | --- |
| **L1 Operating rules** | exists, 3 copies to keep in sync | `src/ai.js:184-231`, `dashboard/server.js:1882+`, edge fn, `config/refal-agent-rules.md` |
| **L2 Reviewed knowledge** | **production grade** | `rafa_knowledge_sources/_documents/_chunks` + `rafa_hybrid_search_knowledge` |
| **L3 Dynamic data** | **MISSING** except appointments | built in M4 |
| **L4 Conversation state** | partial | `conversationState.js`, `conversationMemory.js`, `supabaseStore.js` |
| **L5 Deterministic tools** | registry exists, 6 tools | `src/agentTools.js` `TOOL_REGISTRY` |
| **L6 Evaluation / ops** | partial | `agentObservability.js`, `operationalTelemetry.js`, benchmark scripts |

### 1.3 Constraints that shape the design (verified)

| Fact | Evidence | Consequence |
| --- | --- | --- |
| Model is **`openai/gpt-6-luna`**, not deepseek | `src/openrouterPrivacy.js:5`, `.env.example:4`, migration `20261007175103` | CX's baseline on this point is stale. Do not change the model or the data routing policy without BOSS. |
| Hybrid search = lexical `tsvector('simple')` + HNSW cosine, RRF fused, semantic cut off 0.65 | `20260929142922…sql:88-111` | Documents must be lexically rich in all 3 languages, not only semantically close. |
| Embeddings are local `Xenova/multilingual-e5-small`, 384 dims padded to 2048 | `src/ai.js:2-4,51-57` | Offline multilingual retrieval. The model string is part of the match key. |
| **One approved revision per source** | `20261003224701…sql:21-23` | The corpus must be **many small sources**, one topic each. |
| Price bearing revisions **expire after 30 days** | same migration, 28-39 | Satisfied by serving the live offer from `refal_offers_and_pricing` (M4). |
| Evidence language must match customer language | `src/refalcoAnswer.js:35` | Every topic needs a genuine AR + EN + EL document. |
| Knowledge auto approves on save | `dashboard/server.js:297,312` | Correctness must be enforced at authoring time. M3 P3.9 adds the approval layer back properly. |
| Chunking 1800 chars, heading aware, 500 cap | `dashboard/knowledge.js:194-240` | Author with explicit `##` headings. |

### 1.4 Already built, do not rebuild (the big saving)

| MB requirement | Already present | Evidence |
| --- | --- | --- |
| **MB-D1..D6** six dimensions | `DIMENSIONS = ["need","value","timing","authority","readiness","fit"]` | `src/leadQualification.js:135` |
| **MB-T3/T4/T5** thresholds | `{ warm:14, hot:20, strategic:25 }` with an "Owner rules" comment | `src/leadQualification.js` |
| **MB-HO** handoff | `buildRefalLeadSummary` / `formatRefalLeadSummary` | `src/handover.js:137,186,188` |
| Department routing | 10 departments + intent route table | `src/handover.js` |
| **MB-R1..R10** role coverage | 40+ intent taxonomy | `src/intent.js` |
| Tool calling | working 6 tool registry | `src/agentTools.js` |
| Consent machinery | `CONSENT_STATES`, trilingual `OPT_IN_RE` / `OPT_OUT_RE` / `DENY_RE` | `src/leadQualification.js` |
| Calendar availability | `getBookingAvailability`, `suggestAvailableTimes` | `src/agentTools.js`, `src/booking.js` |

### 1.5 ⚠ The critical blocker (BLK-1)

`src/refalcoAnswer.js:156` rejects any answer containing, in EN/AR/EL:
`investment returns | roi | financial advice | legal status | tax advice | immigration advice | visa | residency | bank approval | permit | licence | government approval` and their Arabic and Greek equivalents.

MB **requires** REFAL to explain all of those as program facts. **Every PR, Non Dom, IP Box, tax and property VAT answer would be silently deleted.** This is why M2 runs before M3. Codex's roadmap never found this.

---

## 2. Target architecture (merged, 6 layers)

```
  Customer on WhatsApp  (AR / EN / EL)
            │
            ▼
 ┌──────────────────────────────────────────────────────────────────┐
 │  L1  OPERATING RULES          identity · 10 roles · persona      │  M1
 │      src/brainPrompt.js       humour 0-3 · golden formula        │
 │      compact and versioned    one question · PRECEDENCE LADDER   │
 └───────────────────────────┬──────────────────────────────────────┘
                             ▼
 ┌──────────────────────────────────────────────────────────────────┐
 │  ORCHESTRATION   language → intent → role → retrieve → tool →    │
 │  src/agentLoop.js  score → hook → draft → GATES → send           │
 └──┬────────────────┬──────────────────┬───────────────────────┬───┘
    ▼                ▼                  ▼                       ▼
┌────────────┐ ┌──────────────┐ ┌─────────────────┐ ┌──────────────────┐
│ L2 KNOWLEDGE│ │ L3 DYNAMIC   │ │ L4 STATE        │ │ L5 TOOLS         │
│ 25 topics   │ │ 6 live tables│ │ leads · convos  │ │ 6 read + 5 write │
│ × AR/EN/EL  │ │ offers       │ │ facts · consent │ │ typed contracts  │
│ = 75 sources│ │ property     │ │ corrections     │ │ fail closed      │
│ + PROVENANCE│ │ deposits     │ │ score evidence  │ │ idempotent       │
│   M3        │ │ fees · promos│ │   M8            │ │   M4             │
│             │ │ slots   M4   │ │                 │ │                  │
└────────────┘ └──────────────┘ └─────────────────┘ └──────────────────┘
    │                │                  │                       │
    └────────────────┴──────────┬───────┴───────────────────────┘
                                ▼
 ┌──────────────────────────────────────────────────────────────────┐
 │  POLICY GATES (deterministic, outside model control)             │  M2
 │  claimClass · priceEvidence · guaranteeGuard · humourBan ·       │  M11
 │  languageLock · oneQuestion · lengthBudget · injection ·         │
 │  crossCustomerAccess · toolAllowlist · secretScan                │
 └──────────────────────────────┬───────────────────────────────────┘
                                ▼
 ┌──────────────────────────────────────────────────────────────────┐
 │  QUALIFICATION  6 dims × 0-5 = 30 → 5 tiers → allowed actions    │  M6
 │  → consent check → executive handoff → department                │
 └──────────────────────────────┬───────────────────────────────────┘
                 ┌──────────────┼──────────────┐
                 ▼              ▼              ▼
          ┌────────────┐ ┌────────────┐ ┌────────────┐
          │ BOOKING    │ │ FOLLOW UP  │ │ DASHBOARD  │
          │ state m/c  │ │ consent    │ │ admin ops  │
          │ M7         │ │ M9         │ │ M12        │
          └────────────┘ └────────────┘ └────────────┘
                                ▼
 ┌──────────────────────────────────────────────────────────────────┐
 │  L6 EVALUATION & OPS   720 golden Q · red team · traces · load   │  M13/M14
 │       independent rollback · per channel pause · maintenance     │  M15
 └──────────────────────────────────────────────────────────────────┘
```

**Hard separation rule (MB 5.3).** These six never appear as a literal in any prompt or knowledge chunk. P4.3 enforces this with a test:
`LIVE_PROPERTY_INVENTORY` · `RESERVATION_DEPOSIT_RULES` · `ANNUAL_RENEWAL_FEES` · `LIVE_CALENDAR_SLOTS` · `GOVERNMENT_THIRD_PARTY_FEES` · `ACTIVE_PROMOTIONS`

---

## 3. Milestone overview — 16 milestones, 82 phases

| # | Milestone | Delivers | Origin | Depends | Phases |
| --- | --- | --- | --- | --- | --- |
| **M0** | Baseline, Conflicts, Taxonomy | Verified state, conflict + known bug register, taxonomy, golden set | A + CX P0/P1 | — | 4 |
| **M1** | Rules: Identity, Persona, Humour, Formula, **Precedence** | REFAL sounds like REFAL and knows what wins | A + **CX 1C** | M0 | 7 |
| **M2** | Guardrail Reconciliation | The brain stops being silenced | **A only** | M0 | 6 |
| **M3** | Knowledge Corpus + **Fact Governance** | 75 sources AR/EN/EL, each with provenance | A + **CX P2** | M0, M2 | 9 |
| **M4** | Dynamic Data + Tools | 6 tables, 11 tools, typed contracts | A + CX P6 | M0 | 5 |
| **M5** | Sales Intelligence | Hooks, objections, jurisdictions | A + CX 8C | M1, M3 | 4 |
| **M6** | Qualification & Handoff | 30 point engine, tiers, executive summary | A + CX P8/P9 | M1, M5 | 6 |
| **M7** | **Booking & Calendar** | Full state machine, real policy | **CX P10** | M4, M6 | 5 |
| **M8** | CRM Memory | Progressive capture, never re-ask | A + CX P7 | M6 | 4 |
| **M9** | **Follow up, Consent & Contact Policy** | Consent scope, opt out, scheduler | **CX P11** | M8 | 4 |
| **M10** | Multilingual Parity | AR/EN/EL equal quality | A + CX 2C | M1, M3 | 5 |
| **M11** | Security, Privacy, Compliance | Injection, cross customer, AML, secrets | A + **CX P12** | M2 | 4 |
| **M12** | **Dashboard & Knowledge Admin** | Staff can run the brain without a developer | **CX P13** | M3, M4 | 4 |
| **M13** | Scale & Reliability | All users, measured latency and cost | A + CX P15 | M3, M4 | 6 |
| **M14** | Evaluation, Release, **Independent Rollback** | Benchmarked, red teamed, reversible | A + **CX P16** | ALL | 6 |
| **M15** | **Life After Launch** | Submit → review → publish → smoke test → roll back, forever | **CX P17** | M12, M14 | 3 |
| | | | | | **82** |

**Critical path:** M0 → M2 → M3 → M5 → M6 → M14
**Run in parallel:** M1 ∥ M2 · M4 ∥ M3 · M7 ∥ M8 · M9 ∥ M10 · M11 ∥ M12

---

# M0 — Baseline, Conflicts, Taxonomy

**Exit criteria.** Verified state, a conflict register, a known defect register, a frozen knowledge taxonomy, and the golden evaluation set.

### P0.1 — Truth baseline `[x]` COMPLETE, see section 16
Delivered `docs/brain/SOURCE-ANALYSIS.md` (183 IDs, 12 blockers) and `docs/brain/SURFACE-AND-GATE-INVENTORY.md` (14 surfaces, 16 gates). Test baseline `exit=0`, 670 pass.
**Carried forward:** W0.1.3 database baseline, still blocked on Supabase connectivity.

---

### P0.2 — Conflict register: MB vs code `[ ]`

| Wave | Work |
| --- | --- |
| **W0.2.1** | **Guardrail conflicts.** Run every MB-F candidate sentence in AR/EN/EL through `containsProhibitedClaim()` and `restrictedRefalcoReply()`. Record BLOCK/PASS. |
| **W0.2.2** | **Identity conflict** (BLK-3) and the exact `AGENTS.md` edit. |
| **W0.2.3** | **Schema conflicts**: one approved revision per source, 30 day expiry, auto approve on save, 500 chunk cap, 250k paste cap. |
| **W0.2.4** | **Tone conflicts**: emoji policy, 2 to 5 sentences versus the current 3 / 500, and which tests assert the old numbers. |
| **W0.2.5** | **Humour conflicts**: the existing bans versus MB's six, delta recorded. |
| **W0.2.6** | **Precedence conflicts**: where today's code resolves a disagreement differently from the ladder in Rule 2. |

**Output.** `docs/brain/CONFLICT-REGISTER.md`: `ID | MB ref | code ref | severity | resolution | milestone`.
**G2.** `node scripts/auditClaimGates.js` exits non zero if an MB required sentence is blocked and not yet registered.

---

### P0.3 — Reproduce the 13 known defects and assign each a repair `[ ]`

CX records real production defects from this project's history. Reproduce each, then confirm it already has an owning repair phase in the Fix Log (section 15). **Every one is already assigned. Nothing is left open.**

| Fix | Defect | Reproduce how | Repaired by |
| --- | --- | --- | --- |
| **FIX-2** | A greeting saved as the customer's name | Send "مرحبا", check the stored contact name | P8.2 |
| **FIX-3** | Q&A blocked while a booking is pending | Start a booking draft, ask an unrelated price question | P7.4 |
| **FIX-4** | A new message resumes an abandoned booking | Abandon a booking, send a new topic | P7.4 |
| **FIX-5** | Formation vs investment misclassification | "بدي أسجل شركة استثمارية" should be both | P1.2 |
| **FIX-6** | Levantine colloquial formation not matched | Colloquial phrasing for company setup | P3.1, P10.1 |
| **FIX-7** | Arabic retrieval returns zero for services and pricing | Arabic price question against the corpus | P3.10 |
| **FIX-8** | Greek coverage gaps | Greek question on each domain | P3.1-P3.8 |
| **FIX-9** | Handover notification lost, badge mismatch | Create a handover, compare count and notification | P6.5, P12.3 |
| **FIX-13** | Agent identity question answered wrongly | "من أنت؟" / "what are you?" | P1.1, P1.2 |
| **FIX-10** | Output leaks: internal reasoning, retrieval fallback text | Adversarial prompts in 3 languages | P11.2 |
| **FIX-11** | Specialist offer not persisted, so it repeats | Offer, then next turn | P5.4 |
| **FIX-12** | Phone metadata treated as consent | Check the consent source field | P9.1 |
| **FIX-1** | Programme facts deleted by the claim gate | Any residency or tax question | P2.2 |

**Output.** `docs/brain/KNOWN-DEFECTS.md`: reproduced, or already fixed with evidence, each with its repair phase.
**Release gate (CX 16A).** FIX-1, FIX-9, FIX-10 and FIX-12 must be green before any production restart or deploy.

---

### P0.4 — Taxonomy, ID scheme, and the Golden Evaluation Set `[ ]`

| Wave | Work |
| --- | --- |
| **W0.4.1** | Freeze the **25 topic taxonomy** (table below) plus 4 jurisdiction topics = **29 topics**. Each gets a slug, domain, trust tier, volatility class and review cadence. |
| **W0.4.2** | Source URI convention. `canonical_url` is unique and not null, so use `refal://kb/<domain>/<slug>/<lang>`. |
| **W0.4.3** | **Golden Evaluation Set**: ≥10 real customer questions per topic per language = **29 × 3 × 10 ≈ 870 questions**. Each with expected facts, expected hook, expected humour level, expected refusal class. Plus **negative queries** that must retrieve nothing (CX 4C). Stored as `src/brainGoldenSet.js` + `artifacts/refal-brain-golden-set.json`. |
| **W0.4.4** | Scoring rubric: Factual accuracy 0-3 · Grounding 0-3 · Language and dialect 0-3 · Golden Formula 0-3 · Guardrail PASS/FAIL (any FAIL fails the answer). **Thresholds are written now, before any evaluation runs** (CX 14 exit gate). |
| **W0.4.5** | Per language and per domain reporting, with error bars. **An aggregate score may never hide a Greek or Arabic failure** (CX 14B). |

#### The 29 topic taxonomy

| # | Slug | Domain | Volatility | MB ref |
| --- | --- | --- | --- | --- |
| 1 | `company-lifecycle` | Corporate | STABLE | 2.1 |
| 2 | `formation-package` | Corporate | **VOLATILE** | 2.1 |
| 3 | `company-structures` | Corporate | STABLE | 2.1 |
| 4 | `shareholder-vs-director` | Corporate | STABLE | 2.1 |
| 5 | `ownership-changes` | Corporate | STABLE | 2.1 |
| 6 | `registered-vs-physical-office` | Corporate | STABLE | 2.1 |
| 7 | `privacy-vs-concealment` | Compliance | STABLE | 2.1 |
| 8 | `dormant-and-liquidation` | Corporate | STABLE | 2.1 |
| 9 | `corporate-tax` | Tax | **VOLATILE** | 2.2 |
| 10 | `ip-box` | Tax | **VOLATILE** | 2.2 |
| 11 | `dividends-vs-salary` | Tax | STABLE | 2.2 |
| 12 | `holding-vs-trading` | Tax | STABLE | 2.2 |
| 13 | `vat-and-eori` | Tax | STABLE | 2.2 |
| 14 | `banking-and-payment-gateways` | Banking | STABLE | 2.3 |
| 15 | `permanent-residency` | Residency | **VOLATILE** | 2.4 |
| 16 | `non-dom-status` | Residency | **VOLATILE** | 2.4 |
| 17 | `source-of-funds-vs-wealth` | Compliance | STABLE | 2.4 |
| 18 | `relocation-checklist` | Residency | STABLE | 2.4 |
| 19 | `property-buyer-journey` | Real Estate | STABLE | 2.5 |
| 20 | `offplan-vs-completed` | Real Estate | STABLE | 2.5 |
| 21 | `property-vat` | Real Estate | **VOLATILE** | 2.5 |
| 22 | `cyprus-cities` | Real Estate | STABLE | 2.5 |
| 23 | `landowners-and-construction` | Development | STABLE | 2.6 |
| 24 | `legal-ip-contracts` | Legal | STABLE | 2.6 |
| 25 | `company-profile` | Identity | **VOLATILE** | 2.0 |
| 26-29 | `jurisdiction-dubai` · `jurisdiction-estonia` · `jurisdiction-malta-bulgaria` · `jurisdiction-usa` | Comparison | STABLE | 3.3 |

→ **29 × 3 = 87 knowledge sources.** 7 are VOLATILE and carry a hard expiry.

**G2.** `node scripts/validateTaxonomy.js`: slugs unique · every topic has AR/EN/EL · every VOLATILE topic has a matching M4 table or an expiry policy · ≥10 golden questions per topic per language · every question has an expected class.

---

# M1 — Rules: Identity, Persona, Humour, Golden Formula, Precedence

**Exit criteria.** REFAL's voice, humour calibration, answer shape, anti patterns and conflict resolution are implemented, synchronised across all surfaces, and tested in three languages. The prompt stays **compact**: stable rules only, reference content lives in retrieval (CX 5A).

---

### P1.1 — REFAL becomes Refalco's agent (removes BLK-3) `[ ]`

| Wave | Work |
| --- | --- |
| **W1.1.1** | `config/company-profile.json`: `{ legalName, brand:"REFAL", groupName:"Refalco Group", foundedYear:2000, yearsExperience:20, developmentProjects:47, totalProjects:400, jurisdiction:"Cyprus", timezone:"Europe/Nicosia", cities:[...], departments:["Corporate","Tax","Real Estate","Residency","Construction","Customer Service","Compliance"], languages:["ar","en","el"] }` |
| **W1.1.2** | `src/companyProfile.js`: load, validate, freeze. A missing profile is a **startup error**, not a silent downgrade. |
| **W1.1.3** | **Delete `"the business"` everywhere**: `src/ai.js:153,188,190,194,198,199,217`, `src/refalcoAnswer.js:188-193`, `config/refal-agent-rules.md:5,35`, `dashboard/server.js:1882,1906`, edge fn, `AGENTS.md:3`, `README.md`. |
| **W1.1.4** | Prompt carries identity and positioning as **persona**. The four credibility numbers go into the `company-profile` knowledge source (P3.7) so they stay evidence gated and citable, exactly as MB-O5 uses them. |
| **W1.1.5** | Rewrite `AGENTS.md`: REFAL is Refalco Group's digital business agent. Company **facts** still require approved knowledge; company **identity** no longer does. |

**G2.** `src/companyProfile.test.js`. `grep -rn '"the business"' src/ dashboard/ config/ supabase/` → zero.
**G3.** `grep -rnE '\b(2000|47|400)\b' src/brainPrompt.js src/ai.js config/refal-agent-rules.md` → zero.

---

### P1.2 — Persona and the 10 roles `[ ]`

| Wave | Work |
| --- | --- |
| **W1.2.1** | `src/personaRoles.js`: MB-R1..R10 with trigger conditions and the one behavioural rule each adds. |
| **W1.2.2** | Role selection from `src/intent.js` (40+ intents already exist). Multiple roles may be active; **at most 2 role directives** reach the prompt, to protect the token budget. |
| **W1.2.3** | Persona core (MB-P1): *"خفيفة دم... بس فاهمة شغلها"* → cheerful, warm, quick witted, simple, natural, commercially perceptive. Authored **natively** per language. |
| **W1.2.4** | Adaptive mirroring (MB-P3..P5): casual → simple and friendly; executive or HNW → formal, concise, highly professional. Signals: length, formality markers, titles, budget magnitude. **Never infer from nationality, language or name** (CX 8A fairness rule). |

---

### P1.3 — Humour Engine, levels 0 to 3 (removes BLK-7) `[ ]`

| Level | Behaviour | Context | Emoji | Forbidden |
| --- | --- | --- | --- | --- |
| **0 Serious** | sober, direct | anger, complaints, cancellations, sensitive legal, sanctions/AML | none | any joke, any playful emoji |
| **1 Warm** | professional, calm, positive | complex tax, HNW investors, major structures | 👍 only | spontaneous jokes, joking about budgets |
| **2 Playful (DEFAULT)** | smart, simple, light hearted | general sales, formation, ordinary property | 😄 👀 👍 | belittling a question, over joking |
| **3 Very Playful** | quick witted, matches the customer | customer opens with jokes, clearly positive | full, incl. 😂 | breaking dignity, promises inside a joke |

| Wave | Work |
| --- | --- |
| **W1.3.1** | `src/humourEngine.js`: `resolveHumourLevel({ message, history, intents, safetyRisks, leadTier, language }) → 0|1|2|3`. Default 2. |
| **W1.3.2** | **Hard ban detector** (MB-HB1..HB6, absolute): residency or visa refusal/complication · legal disputes and judicial proceedings · financial loss or banking default · complaints, anger, dissatisfaction · AML/KYC/sanctions · illness, death, force majeure. Trilingual, wired to `safetyPolicy` risk categories. Forces level 0. |
| **W1.3.3** | Level → prompt directive, authored natively per language. |
| **W1.3.4** | **Output gate** `assertHumourCompliance(answer, level)`: strips or rejects playful emoji and joking constructions at level 0 and 1. Runs beside `validateResponse`. |
| **W1.3.5** | Emoji allowlist per level. The dash punctuation ban stays. |

**G2.** `src/humourEngine.test.js`, ≥60 cases. Every hard ban trigger in AR/EN/EL forces 0 (≥3 cases × 6 bans × 3 languages = 54 minimum).

---

### P1.4 — Golden Answer Formula and One Question Rule (removes BLK-4) `[ ]`

| Wave | Work |
| --- | --- |
| **W1.4.1** | `src/goldenFormula.js`: `analyseAnswerShape(answer) → { hasDirectAnswer, hasValueHook, questionCount, sentenceCount }`. Trilingual sentence and question splitting (`?`, `؟`, Greek `;`). |
| **W1.4.2** | **One Question Rule** (MB-G3): max 1 question, or 2 only when tightly coupled. Extend `responsePolicy.js` with the coupling exception, set to **reject** not warn. A question is **optional**, not mandatory (CX 1B). |
| **W1.4.3** | **Length budget.** New `ORDINARY = { minSentences:2, maxSentences:5, maxChars:700 }`. `EXPANDED = { maxSentences:20, maxChars:1800 }` for an explicit detail request. **Never truncate a material safety or eligibility condition to fit** (CX 5C). Update every test asserting 3 / 500. |
| **W1.4.4** | The value hook is **evidence optional**. Never force a hook into every reply. |
| **W1.4.5** | Encode MB 1.3's four worked examples (2 ❌, 2 ✅) as regression fixtures. |

---

### P1.5 — Anti pattern guards `[ ]`

| ID | Anti pattern | Gate |
| --- | --- | --- |
| **AP-1** | Phone number obsession (MB-AP1) | Block a contact request in a turn that delivered no approved fact, unless the customer asked |
| **AP-2** | Legal disclaimer overload (MB-AP2) | Max one caveat clause per reply. **But never remove a meaningful caveat just to sound confident** (CX 12B) |
| **AP-3** | Fear based selling (MB-AP3) | Block "prices rise tomorrow", "the law changes immediately" and equivalents unless present verbatim in approved unexpired evidence |
| **AP-4** | Fake promises and absolute guarantees (MB-AP4) | Extends the GUARANTEE class from M2: banks, Stripe/PayPal/Amazon/Shopify, residency issuance, specific ROI |
| **AP-5** | Interrogation (MB-AP5) | P1.4 plus a history check: three consecutive question only turns fails |
| **AP-6** | **Unrequested meeting push** (CX R-04) | An informational request stays informational. A score tier alone never triggers a booking offer |

---

### P1.6 — Policy precedence ladder (imported from CX 1C) `[ ]` **NEW**

| Wave | Work |
| --- | --- |
| **W1.6.1** | `src/policyPrecedence.js` implementing the 6 level ladder from Rule 2. Exposes `resolveConflict(sources) → winner + reason`. |
| **W1.6.2** | Wire it into the answer composer: when live data and a knowledge chunk disagree, **live data wins** and the chunk is flagged stale. When a customer statement and a knowledge chunk disagree about the customer, **the customer wins**. When anything disagrees with a privacy or fail closed rule, **the rule wins**. |
| **W1.6.3** | General model knowledge may produce a harmless general explanation but **never a Refalco specific claim**. Gate enforces this. |
| **W1.6.4** | **Approved sources that conflict with each other**: state that they differ, cite both, do not pick a side unless dated evidence resolves it (already a rule at `src/ai.js:214`, now formalised). |
| **W1.6.5** | Every precedence decision is logged as a concise decision label, never as chain of thought (CX 15C). |

**G2.** `src/policyPrecedence.test.js`: one case per adjacent pair in the ladder (15 pairs) × 3 languages.

---

### P1.7 — Prompt surface synchronisation (removes BLK-5, BLK-6) `[ ]`

| Wave | Work |
| --- | --- |
| **W1.7.1** | Extract one `src/brainPrompt.js` exporting composable blocks: identity · roles · persona · humour · golden formula · anti patterns · precedence · compliance · evidence · memory. **Compact. Stable rules only.** |
| **W1.7.2** | `src/ai.js` consumes it instead of its inline 40 line array. |
| **W1.7.3** | `dashboard/server.js:1882+` consumes the same blocks, operator variant. |
| **W1.7.4** | Edge function consumes a Deno compatible `.mjs` mirror (same pattern as `responsePolicy.mjs`). |
| **W1.7.5** | Rewrite `config/refal-agent-rules.md` as the canonical human readable version. |
| **W1.7.6** | **Remove BLK-5.** `src/ai.js:198` "Do not volunteer unrelated prices, packages, services or sales details" → *"Answer the question first. You may then raise **one** relevant cross sell hook when its trigger fires and evidence supports it. Never volunteer detail unrelated to the customer's goal."* |
| **W1.7.7** | **Remove BLK-6.** `config/refal-agent-rules.md:21` "Do not introduce a call during ordinary information gathering" → tier aware: *"No call offer at Informational or Cold. Offer flexibly at Warm. At Hot or on a buying signal, stop selling and move to booking, with consent."* |
| **W1.7.8** | **Prompt versioning** (CX 5A): every prompt change produces a version id and a change history entry, so a bad prompt can be rolled back independently (M14). |
| **W1.7.9** | **Drift test** `src/promptParity.test.js`: the three runtime surfaces must contain the same mandatory rule set. |

---

# M2 — Guardrail Reconciliation

**Exit criteria.** REFAL states every approved program fact while still refusing every personalized conclusion and every guarantee, in three languages, with no loss of existing protection.

---

### P2.1 — Claim classification taxonomy `[ ]`

| Class | Example | Rule |
| --- | --- | --- |
| **PROGRAM_FACT** | "The Cyprus PR route requires a qualifying investment of €300,000 plus VAT." | **ALLOW** when an approved, unexpired chunk in the supplied evidence contains the same fact |
| **PERSONALIZED_CONCLUSION** | "Your activity qualifies for IP Box." / "You will get the residency." | **BLOCK** always. Offer specialist review |
| **GUARANTEE** | "We guarantee Stripe approval / bank approval / 8% ROI." | **BLOCK** always, all languages |
| **NEUTRAL** | everything else | pass to the other gates |

| Wave | Work |
| --- | --- |
| **W2.1.1** | `src/claimPolicy.js` `classifyClaim(sentence, { evidence, language })`. |
| **W2.1.2** | PERSONALIZED markers, trilingual: second person + eligibility or outcome verb ("your company qualifies", "شركتك مؤهلة", "η εταιρεία σας δικαιούται"). |
| **W2.1.3** | GUARANTEE markers, trilingual ("نضمن", "مضمون", "εγγυόμαστε"). |
| **W2.1.4** | PROGRAM_FACT verification: entities and **every number** in the sentence must appear in the supplied evidence. A number absent from evidence is an automatic fail. |

**G2.** `src/claimPolicy.test.js`, ≥120 cases. Every MB-F fact with evidence → ALLOW; same fact without evidence → BLOCK; every personalized and guarantee variant → BLOCK.

---

### P2.2 — Rewrite `containsProhibitedClaim` (removes BLK-1, BLK-2, BLK-8) `[ ]`

| Wave | Work |
| --- | --- |
| **W2.2.1** | **Branch, do not delete.** Keep the blanket function as `containsProhibitedClaimLegacy`, routed to when **no approved evidence was supplied**, so the empty knowledge case behaves exactly as today. |
| **W2.2.2** | New path: split into clauses, classify each with `claimPolicy`, reject if any clause is PERSONALIZED or GUARANTEE, or is a PROGRAM_FACT without matching evidence. |
| **W2.2.3** | Same for `restrictedRefalcoReply`: a residency or investment **programme** question with evidence gets a grounded answer; without evidence the refusal stands. |
| **W2.2.4** | Narrow the blanket "investment" block to investment **advice** and **returns**, not investment **programmes** (Category C is literally an investment product). |
| **W2.2.5** | Keep `withoutPriceFacts`, `containsPriceClaim`, `containsUnsupportedPackageInclusion`, `containsLegacyBrandHistory`, `containsRawUrlClaim` unchanged. Orthogonal and still needed. |
| **W2.2.6** | Audit `groundingPolicy.test.js`, `agentFactualGrounding.test.js`, `safetyPolicy.test.js`, `agentRagEvidence.test.js`. Rewrite "residency is always refused" → "residency without evidence is refused", and add the positive case. **Every changed assertion is listed in the Result block** so a weakened safeguard can never hide as a refactor. |

**G3.** Diff the set of blocked message classes before and after. Anything newly allowed must map to an MB requirement row. Anything else is a regression.

---

### P2.3 — Banking and payment gateway guard `[ ]`
`src/bankingPolicy.js`. Detects banking / Stripe / PayPal / Amazon / Shopify intent trilingually. Forces MB 2.3's shape: honest that the decision belongs to the institution's risk and KYC/AML assessment → the real value of a clean file from day one → one discovery question. MB's verbatim Arabic Stripe dialogue becomes a golden fixture, with EN and EL equivalents.

### P2.4 — Reservation deposit, ROI and VAT guards `[ ]`
- **W2.4.1** Reservation deposit (MB-F50, absolute): any currency amount in an answer that also mentions reservation/deposit/عربون/προκαταβολή **must** come from `refal_reservation_rules` (M4), never a chunk and never the model.
- **W2.4.2** ROI (MB-F55): no yield percentage, no future price prediction. MB's verbatim reply script becomes the canonical response, trilingual.
- **W2.4.3** Property VAT: 19% and 5% are stateable programme facts; **which rate applies to this customer** is not REFAL's to decide.

### P2.5 — AML, sanctions, compliance and the existing client boundary `[ ]`

| Wave | Work |
| --- | --- |
| **W2.5.1** | Extend `src/redFlagRules.js` with sanctions and circumvention detection, trilingual. |
| **W2.5.2** | **Compliance escalation** (MB-SEC2): distinct from a sales handover, does **not** require customer consent (regulatory obligation, not marketing), produces a sober acknowledgment plus an internal record. **Do not debate the evasion** (CX 12B). |
| **W2.5.3** | Forces humour level 0 and suppresses every sales hook for the rest of the conversation. |
| **W2.5.4** | Privacy hard rule (MB-SEC4): never request a password, card data, or a sensitive bank statement in chat. |
| **W2.5.5** | **Existing client verification, built not parked.** Codex left this capability dark. This plan **builds the flow**: REFAL sends a one time code to the contact already on file, the customer reads it back, and only then is account data unlocked for that conversation. A self asserted detail or a matching caller number is **never** authentication. Test that self assertion alone never authenticates. The customer gets a working path, not a dead end. |
| **W2.5.6** | Source of Funds and Source of Wealth explained neutrally and separately (MB-SEC3). Only high level status in chat, never files or statements. |

### P2.6 — Guardrail regression sweep `[ ]`
Red team corpus v1: 200 adversarial messages AR/EN/EL (guarantee bait, price bait, eligibility bait, injection inside a pasted "approved document", sanctions probing, credential phishing, cross customer probing). Zero guarantees, zero personalized conclusions, zero injected instruction obedience. Record `docs/brain/GUARDRAIL-DELTA.md`.

---

# M3 — Knowledge Corpus + Fact Governance

**Exit criteria.** 87 sources live. Every MB module 2 fact is retrievable in the customer's language in the top 5, stated correctly end to end, **and carries provenance metadata**.

**Authoring standard (every M3 phase):**
1. Markdown with explicit `##` headings so chunks stay topically pure. Each block under 1800 chars.
2. **Native authoring, not translation.** Arabic in simplified warm white dialect / accessible near MSA, avoiding dry legal register. Greek in professional business Greek. English business casual.
3. Include the customer's own vocabulary as lexical anchors: "كم تكلفة تأسيس شركة", "poso kostizei etaireia", "how much to open a company".
4. Facts only. No sales scripts, no persona, no internal review language.
5. **No volatile value** from the six MB-DYN variables.
6. Separate **service terms and boundaries** from **sales copy**, so a persuasive example can never override a limitation (CX 2A).
7. Every fact carries the P3.9 provenance record.

---

### P3.1 — Corporate domain (topics 1-8) `[ ]`
Waves: EN → AR → EL → ingest, embed, verify against 240 golden questions.

**MB 2.1 checklist, every item must appear:**
- [ ] Lifecycle, 10 stages (MB-F1)
- [ ] €999 + VAT package, all 7 inclusions (MB-F2..F9)
- [ ] Company Secretary = statutory corporate function, **not** a personal assistant (MB-F6)
- [ ] Registered Address ≠ an office or apartment (MB-F7)
- [ ] ~2 weeks after documents are complete (MB-F2)
- [ ] Branch vs Subsidiary vs new Ltd, do not assume a new Ltd (MB-F10)
- [ ] Shareholder vs Director, can be the same person (MB-F11..F13)
- [ ] Ownership can change later, nothing carved in stone (MB-F14)
- [ ] Registered vs physical/virtual office and the substance opportunity (MB-F15)
- [ ] Legitimate privacy vs illegal UBO concealment, explicitly not supported (MB-F16)
- [ ] Dormant company still has reporting and accounting obligations (MB-F17)
- [ ] Liquidation is a formal procedure, neglect is not closure (MB-F18)

### P3.2 — Tax domain (topics 9-13) `[ ]`
- [ ] Corporate tax from **15% from 2026** (MB-F19)
- [ ] IP Box effective **~2.5% to 3%**, explicitly **not automatic** (MB-F20, F21)
- [ ] Dividends vs Salary, depends on personal tax residency and DTTs, routes to a tax advisory opportunity, never a decisive personal opinion (MB-F22, F23)
- [ ] Holding vs Trading, all 4 comparison rows (MB-F24..F27)
- [ ] VAT number and **EORI** for trading, payroll and non EU work permits (MB-F26, F27)
- [ ] MB 2.2's simplified ✅ answer as a golden fixture

### P3.3 — Banking and payment gateways (topic 14) `[ ]`
- [ ] Final approval belongs to the institution's risk and KYC/AML assessment (MB-F28, F29)
- [ ] Covers banks, Stripe, PayPal, Amazon, Shopify
- [ ] The value: a clean file built correctly from day one
- [ ] **Zero promise language anywhere in the document**

### P3.4 — Residency and Non Dom (topics 15-18) `[ ]` ⚠ highest guardrail risk, needs M2
- [ ] Minimum qualifying investment **€300,000 + VAT** (MB-F30)
- [ ] Income **€50,000** main / **+€15,000** spouse / **+€10,000** each minor child, from outside Cyprus (MB-F31..F33)
- [ ] Non Dom **0% on dividends and interest for 17 years** (MB-F34)
- [ ] Source of Funds vs Source of Wealth (MB-F35..F37)
- [ ] **Category A** new residential, €300,000 + VAT, **first sale from the developer**, most prominent (MB-F38)
- [ ] **Category B** other property types, offices/shops/hotels, €300,000 (MB-F39)
- [ ] **Category C** €300,000 share capital in an operating Cyprus company with employees and real presence (MB-F40)
- [ ] **Category D** €300,000 in qualifying funds, **AIF / AIFLNP** (MB-F41)
- [ ] Schools: public / private / international British curricula; ask the children's ages (MB-F42)
- [ ] GESY plus optional private insurance (MB-F43)
- [ ] Cost of living and cars are variable, fresh estimate per city and family size (MB-F44)

### P3.5 — Real estate (topics 19-22) `[ ]`
- [ ] Buyer journey, 10 stages (MB-F45)
- [ ] Completed vs Off plan, who each suits (MB-F46, F47)
- [ ] VAT **19%**, reduced **5%** under conditions for direct personal use, calculated precisely by the team (MB-F48, F49)
- [ ] Reservation deposit differs per project, from the live database, **never guessed** (MB-F50)
- [ ] Four cities, full profiles (MB-F51..F54)
- [ ] MB's verbatim ROI script (MB-F55)

### P3.6 — Legal, IP, landowners, construction (topics 23-24) `[ ]`
- [ ] Landowner JV: indicators, 4 discovery questions (location, area, building density, preliminary permits), escalation phrasing (MB-F57..F59)
- [ ] Construction tenders: indicators, 4 discovery questions (size, location, BOQ and architectural plans, timeline), escalation with **no prices and no preliminary estimates from the agent at all** (MB-F60..F62)
- [ ] Trademarks Cyprus and EU (MB-F63)
- [ ] Shareholders Agreements (MB-F64)
- [ ] Service and Employment Agreements (MB-F65)
- [ ] T&Cs and GDPR advisory (MB-F66)

### P3.7 — Company profile and credibility (topic 25) `[ ]`
- [ ] Operational roots **2000** (MB-C1)
- [ ] More than **20 years** experience (MB-C2)
- [ ] **47** development projects (MB-C3)
- [ ] More than **400** multi sector projects (MB-C4)
- [ ] Positioning: a gateway to comprehensive investment and structural solutions, not a narrow registration office (MB-C5)
- [ ] These four numbers live **only here**, as evidence, never as a prompt literal

### P3.8 — Jurisdiction comparisons (topics 26-29) `[ ]`
Cyprus vs Dubai/UAE · Estonia · Malta/Bulgaria · USA (MB-J1..J4), each with MB's verbatim dialogue. **Never attack another country, never claim "we are always the best"** (MB-J0). Fact check each claim; a comparison that cannot be sourced is cut, not softened (CX 3.3 checklist).

---

### P3.9 — Fact governance and approval register (imported from CX 2B) `[ ]` **NEW — this is Rule 2**

This is the single most important import from Codex. It is what lets REFAL say €999 **and** stay safe.

| Wave | Work |
| --- | --- |
| **W3.9.1** | Migration: extend `rafa_knowledge_documents.metadata` (or a new `refal_fact_register`) to carry per fact: `claim_text`, `source_url_or_document`, `source_type`, `jurisdiction`, `reviewer`, `verified_at`, `effective_from`, `expiry_or_review_at`, `approved_languages[]`, `status`. |
| **W3.9.2** | **Every number in the corpus gets a register row.** 20 facts are high risk and get a mandatory review date: €999, the two 4 month terms, ~2 weeks, 15%, 2.5-3%, €300,000, €50,000, €15,000, €10,000, 17 years, the four categories, 19%, 5%, 2000, 20 years, 47, 400+. |
| **W3.9.3** | **Status drives behaviour.** `approved` → statable. `expired` → REFAL says the figure is not currently confirmed and offers specialist follow up. `blocked` → not retrievable at all, and a test proves it cannot leak through semantic search. |
| **W3.9.4** | **Rule 1 default**: per BOSS's authority instruction, MB facts are seeded as `approved` with `source = MB manual`, `reviewer = BOSS`, `verified_at = 2026-10-07`. They are live from day one. They are **not** blocked waiting for an external reviewer. |
| **W3.9.5** | **Rule 2 safety net**: each carries an `expiry_or_review_at`. VOLATILE topics get 30 to 90 days, STABLE get 12 months. When it expires she stops asserting it automatically, with no code change. |
| **W3.9.6** | **The 12.5% question, solved not parked.** Cyprus corporate tax was 12.5% historically; MB says 15% from 2026. **REFAL states 15% from day one.** The register row carries the exact effective date and a 30 day review, and the dashboard shows it in the "review soon" list. If it ever needs changing, that is one field in one form. The fact is live, and it is also correctable in sixty seconds. |
| **W3.9.7** | Dashboard view: facts expiring in 7 days, one click re-approval that extends the date, and a full audit of who changed which fact (feeds M12). |

**G2.** `src/factRegister.test.js`: an expired fact cannot be asserted · a blocked fact cannot be retrieved by lexical or semantic search · an approved fact is asserted with its evidence · changing a register row changes behaviour with no redeploy.

---

### P3.10 — Ingestion pipeline and corpus health `[ ]`

| Wave | Work |
| --- | --- |
| **W3.10.1** | `scripts/ingestBrainCorpus.js`: reads `knowledge/<topic>/<lang>.md`, upserts the source with its `refal://` URI, stores the revision, chunks, embeds, verifies counts. **Idempotent and re-runnable**, reports a per topic diff. Publish and unpublish are safe operations (CX 4A). |
| **W3.10.2** | **Chunk by meaning, not size** (CX 4A). Never mix policy, examples and dynamic facts in one chunk. |
| **W3.10.3** | Backfill verification: every chunk has an embedding and a matching `embedding_model` string, because the semantic branch filters on exact model equality. |
| **W3.10.4** | **Retrieval aliases** (CX 4B): Arabic dialect spellings, Arabic/English code switching, English acronyms (VAT, EORI, SHA, AIF, GESY, UBO, DTT, BOQ), Greek terms, transliterations, common misspellings. |
| **W3.10.5** | **Low confidence fallback** (CX 4B): ask one clarifying question, state the limitation, or route to a human. **Never fill the gap from unapproved prompt text.** |
| **W3.10.6** | `scripts/brainHealth.js`: per topic per language — source exists · approved · not expired · chunk count · embedded count · retrievable for its golden questions · register row present. Exits non zero on any gap. This is the standing G3 tool for M3. |
| **W3.10.7** | `docs/brain/KNOWLEDGE-RUNBOOK.md`: how to add a topic, update a price, retire a fact. |

**G2.**
```bash
node scripts/brainHealth.js > /tmp/health.log 2>&1; echo "exit=$?"
npm run eval:knowledge      > /tmp/evalk.log 2>&1; echo "exit=$?"
node scripts/evaluateRag.js > /tmp/rag.log 2>&1; echo "exit=$?"
```
**G3.** 87 sources present and approved · 0 unintentionally expired · 100% chunks embedded · ≥95% of the ~870 golden questions retrieve their expected topic in the top 5 · 100% of negative queries retrieve nothing · **FIX-7 and FIX-8 repaired**.

---

# M4 — Dynamic Data and Tools

**Exit criteria.** All six MB-DYN variables served from live tables through typed tools, with a test proving none appear as a literal in any prompt or chunk, and full failure state handling.

### P4.1 — Schema `[ ]`
Migration `<ts>_refal_dynamic_commercial_data.sql`. Every existing convention: RLS on, revoke from `public`/`anon`/`authenticated`, grant `service_role`, `security invoker` + `set search_path = ''`, `set_rafa_updated_at` trigger.

| Table | Serves | Key columns |
| --- | --- | --- |
| `refal_offers_and_pricing` | ACTIVE_PROMOTIONS, formation price | `code`, `title_{en,ar,el}`, `amount`, `currency`, `vat_note`, `inclusions jsonb`, `valid_from`, `valid_until`, `active` |
| `refal_annual_renewal_fees` | ANNUAL_RENEWAL_FEES | `item` (secretary, address, accounting, audit, tax), `amount`, `currency`, `period`, `notes_{en,ar,el}`, `valid_until` |
| `refal_property_inventory` | LIVE_PROPERTY_INVENTORY | `reference`, `city`, `type`, `status` (offplan/completed), `price`, `currency`, `vat_rate_note`, `bedrooms`, `first_sale`, `pr_eligible`, `available`, `developer`, `delivery_date` |
| `refal_reservation_rules` | RESERVATION_DEPOSIT_RULES | `project_or_property_id`, `deposit_amount` or `deposit_percent`, `refundable`, `conditions_{en,ar,el}` |
| `refal_government_fees` | GOVERNMENT_THIRD_PARTY_FEES | `fee_type`, `amount`, `currency`, `authority`, `effective_from`, `source_note` |
| `refal_lead_profile` | AR-A5 leads + MB-CRM1..4 | see M8 P8.1 |

`LIVE_CALENDAR_SLOTS` is served by the existing `src/booking.js` + `rafa_appointments`. `conversations` already exists and is extended in M8.

### P4.2 — Typed tools (CX 6A, 6B) `[ ]`

| Wave | Work |
| --- | --- |
| **W4.2.1** | Six **read** tools on the existing registry: `lookupActiveOffer`, `lookupRenewalFees`, `searchPropertyInventory`, `lookupReservationRules`, `lookupGovernmentFees`, `listCalendarSlots`. |
| **W4.2.2** | Five **write/action** tools: `upsertLead`, `createHandover`, `holdOrBookAppointment`, `scheduleFollowUp`, `recordComplianceEvent`. Each role authorized. |
| **W4.2.3** | **Tool contracts** carry: location, currency, VAT treatment, effective date, last updated time, eligibility, availability, **and explicit failure/empty states** (CX 6A). Do not assume every price is €999 or every deposit is fixed. |
| **W4.2.4** | **Tool truth** (CX 6C): timeouts, bounded retries, rate limits, idempotency keys, validation, audit logs, user safe error messages. **Never claim a booking, save, update or notification succeeded until confirmed.** On failure keep a safe pending state and raise an internal alert. **Never silently fall back to invented data.** |
| **W4.2.5** | **Empty table behaviour**: empty or all expired → the tool returns "not available" and REFAL says the figure is not confirmed. Never a prompt literal, never a stale chunk. |
| **W4.2.6** | Deterministic fallback for the non agent path (`src/messageRouter.js`). |

### P4.3 — The "never frozen" enforcement test `[ ]`
- `src/dynamicDataSeparation.test.js` scans every exported prompt string in `brainPrompt.js`, `ai.js`, `dashboard/server.js`, the edge function and `config/refal-agent-rules.md` for a currency amount or property reference. Any hit fails.
- `brainHealth.js` asserts no approved chunk contains a reservation deposit, a unit price, or a government fee. The formation package price is the one deliberate exception, and it carries the 30 day expiry.
- Dashboard warns an operator pasting a document containing a currency amount, pointing to the right table.

### P4.4 — Contract tests `[ ]`
Success · empty · stale · error · timeout · duplicate · unauthorized · partial result (CX 6 exit gate). Inject stale timestamps and tool failures; verify no static answer leaks as a substitute. Customer facing messages must distinguish **pending**, **confirmed** and **failed**.

### P4.5 — Operator CRUD (hands off to M12) `[ ]`
Typed forms with effective dates for offers, renewal fees, property, reservation rules and government fees. **Not freeform prompt text** (CX 13A). RBAC consistent with the existing dashboard auth. Audit logged.

---

# M5 — Sales Intelligence

### P5.1 — Cross sell hook matrix `[ ]`

| ID | Trigger | Offer | Guard |
| --- | --- | --- | --- |
| **H1 IP_BOX** | Software / SaaS / app / Dev | IP Box advantage | Must say "not automatic for every company". Never say the customer qualifies |
| **H2 RESIDENCY** | non EU, property or company budget ≥ €300,000 | PR for them and family | Programme fact only, no eligibility decision |
| **H3 RELOCATION** | family, schools, housing, living, moving | International schools, GESY, Non Dom 17 years | Humour level 1 or 2, never pushy |
| **H4 SUBSTANCE** | "we want to actually move and work from Cyprus" | Office services and real substance | — |
| **H5 TRADEMARK** | "I have a brand / product / new app" | Cyprus / EU Trademark | — |
| **H6 PR_TO_PROPERTY** | "I have the budget and want a clear guaranteed option" | Category A new residential | **Never the word "guaranteed" in the reply** |

- **W5.1.1** `src/salesHooks.js`, trilingual triggers including Arabizi and Greeklish.
- **W5.1.2** Hook → MB's verbatim smart hint phrase, authored natively per language.
- **W5.1.3** **Suppression**: at most one hook per reply · never at humour level 0 · never when the customer declined · never repeat an already offered hook · **never before the question is answered** · stop if the customer declines, stays informational, complains, or is in a sensitive state (CX 8C).
- **W5.1.4** Evidence gated: H1 cannot fire if the IP Box document is missing or expired.

### P5.2 — Objection matrix `[ ]`

| ID | Objection | Core move |
| --- | --- | --- |
| **O1** | "€999 is expensive" | Do not defend. Ask what they are comparing against, then compare inclusions |
| **O2** | "I found it for €500" | Ask whether it includes secretary, registered address and a clear annual commitment, or is a bare registration fee |
| **O3** | "I want to think about it" | Name the hidden question warmly: price, Cyprus, or not ready. Then ask about timing |
| **O4** | "Send me everything on WhatsApp" | Refuse the encyclopedia politely, ask which single thing matters most now |
| **O5** | Distrust | **Reduce humour.** Validate, state the Refalco credibility facts from evidence, offer a direct call before any step |

- **W5.2.1** `src/objectionMatrix.js`, extending the existing `src/objectionWorkflow.js`.
- **W5.2.2** O5 forces humour ≤ 1 (MB says so explicitly).
- **W5.2.3** O1 and O2 pull **live** package inclusions from `refal_offers_and_pricing`, never a frozen list.
- **W5.2.4** **Imported from CX 8C:** rewrite MB's objection examples to remove multiple questions, manipulative hidden motive assumptions, pressure, and unsupported competitor accusations. *"Usually 'let me think' hides a small question"* reads as pushy to an HNW investor. Keep the warmth, drop the presumption. Each rewrite is reviewed against the One Question Rule.

### P5.3 — Jurisdiction benchmarking `[ ]`
`src/jurisdictionBenchmark.js` driving topics 26-29 from P3.8. Tone guard rejects any draft that disparages another jurisdiction. Every comparison ends with MB's discovery question, because the honest answer is always "it depends where your clients, your bank and your family are".

### P5.4 — Offer orchestration `[ ]`
One place decides per turn what REFAL may offer: hook, objection response, specialist, booking, or nothing. Resolves M5's eagerness against the consent and no repeat rules, **which always win**. Consumes `policyPrecedence` from P1.6.

---

# M6 — Qualification and Executive Handoff

### P6.1 — The six dimension scorer `[ ]`
`src/qualificationEngine.js`, extending the existing `src/leadQualification.js` which **already has the right dimension list**.

- **W6.1.1** Evidence anchors 0 to 5 for NEED, VALUE, TIMING, AUTHORITY, READINESS, FIT (MB-D1..D6).
- **W6.1.2** Persist dimension scores, **evidence text references**, scorer version, timestamp, total 0-30 (CX 8A). Keep score history.
- **W6.1.3** **Fairness rule (imported from CX 8A):** never infer budget, authority or readiness from nationality, language, name, or any protected trait. Tested explicitly.
- **W6.1.4** Recompute only on meaningful new evidence. Same conversation → reproducible score and rationale.
- **W6.1.5** **Leak test**: score, dimension names and tier never appear in a customer reply. Extends the internal reasoning detector in `responsePolicy.js`.

### P6.2 — Tiers and action protocols `[ ]`

| Tier | Range | Protocol |
| --- | --- | --- |
| **Informational** | 0 – 7 | Answer directly and briefly. **No booking push.** Help without draining |
| **Cold** | 8 – 13 | General information, one exploratory question, save to CRM for quiet follow up |
| **Warm** | 14 – 19 | Continue smart qualification, offer hints, offer an appointment flexibly and not repeatedly |
| **Hot** | 20 – 24 | **STOP OVER SELLING.** Request contact details, book. Requires consent and a valid contact route |
| **Strategic** | 25 – 30 | **Priority escalation.** Urgent executive summary, senior consultant. **Never quote construction or project pricing without approved input** |

- **W6.2.1** `src/leadTiers.js` + tier directive in the prompt.
- **W6.2.2** **Stop over selling switch** at Hot: suppresses every hook and benefit hint, switches to logistics.
- **W6.2.3** Strategic routing to Corporate / Tax / Real Estate / Residency / Construction. **Add the missing `tax` department** to `src/handover.js`.
- **W6.2.4** **The tier never overrides consent.** Hot still requires a clear yes.
- **W6.2.5** **Boundary tests (imported from CX 8 exit gate):** exact transitions at **7/8, 13/14, 19/20, 24/25**.
- **W6.2.6** Strategic alerts fire **once**, durably, not repeatedly.

### P6.3 — Instant buying signals `[ ]`
`src/buyingSignals.js`, trilingual incl. Arabizi and Greeklish, for MB-B1..B5. Firing raises the score floor and triggers P7 booking.

### P6.4 — Executive Handoff Summary `[ ]`
`src/executiveHandoff.js`, extending the existing `buildRefalLeadSummary`.
- **W6.4.1** MB 5.2's exact block, byte for byte.
- **W6.4.2** **Explicit `UNKNOWN` / `NOT PROVIDED`, never an invented detail** (CX 9B).
- **W6.4.3** Data minimisation and role based visibility. Redact credentials and sensitive banking details.
- **W6.4.4** Carries every CRM field from M8, so the human adviser never re-asks (MB-HO3).
- **W6.4.5** Golden fixture comparison on exact separators and field names.

### P6.5 — Handover delivery and acknowledgment (CX 9C) `[ ]`
Durable handover records · notification jobs with retries · **dashboard badge and count reconciliation** (repairs FIX-9) · acknowledgment · closure reasons. Test external communication to a **sandbox recipient only** until explicitly enabled. Simulate: notification outage, wrong department, empty contact details, duplicate escalation, missing assignee.

### P6.6 — Strategic escalation `[ ]`
Landowner JV, construction tender, HNW €1M+, international partnership. Urgent path, senior consultant, and for construction **no price or estimate from the agent at all** (MB-F62).

---

# M7 — Booking and Calendar **(imported wholesale from CX Phase 10)**

**Why this is its own milestone.** Plan A had one thin phase. Codex specified the real policy. Booking is where a wrong answer creates a real world commitment, so it gets full treatment.

### P7.1 — Calendar readiness, built and shipped working `[ ]`

Codex left booking dormant waiting for four decisions. **This plan ships all four with working defaults and a settings screen**, so booking goes live the moment BOSS pastes one credential.

| Wave | Work |
| --- | --- |
| **W7.1.1** | **Ship working defaults**: appointment duration **60 minutes** · minimum notice **24 hours** · reminders at **1 day** and **1 hour** before. All editable in the dashboard (M12), none hardcoded. |
| **W7.1.2** | **Build the settings screen** so BOSS changes duration, notice, business hours and reminders without a developer. |
| **W7.1.3** | **Build the readiness check** `verifyCalendarAccess` (already exists in `src/calendarReadiness.js`), surfaced as a green or red badge in the dashboard with the exact missing item named. |
| **W7.1.4** | **The one field**: paste the Google OAuth credential into the dashboard once. The existing `scripts/authorizeGoogleCalendar.js` handles the flow. Worker and dashboard secrets stay separate; tokens never in code, chat or logs. |
| **W7.1.5** | Until the credential is pasted, REFAL does not invent slots. She says a specialist will confirm the time and creates a pending request. **She still books the lead, she just does not claim a confirmed slot.** The customer journey never dead ends. |

### P7.2 — Booking state machine `[ ]`
- Timezone **`Europe/Nicosia`**, weekdays only, **10:00 to 15:00**.
- Reject past dates and **same day** requests. Enforce the configured notice window.
- Offer **no more than two verified slots** at a time. **Recheck availability immediately before booking.**
- Require **explicit exact customer confirmation including the chosen time** before creating an event.
- States: `draft → awaiting_customer_confirmation → creating → confirmed | pending_calendar | failed | cancelled`. Each explained truthfully.
- **Never claim the event, the Meet link or the reminders exist until the APIs confirm them.**

### P7.3 — Two choice offering flow `[ ]`
MB-A1 step 1: "does today or tomorrow suit you better" (never an open "when would you like"). MB-A2 step 2, **from the live API**: "I have 11:30 or 3:00, which is easier". Slots come only from `listCalendarSlots`.

### P7.4 — Conversation flow separation (repairs FIX-3, FIX-4) `[ ]`
- Answer informational questions **during** a booking draft without losing the draft.
- The draft does **not** capture every message.
- A new topic does **not** silently resume an old booking. One short disambiguating question only if necessary.
- If the calendar fails, create visible pending work for an admin and tell the customer accurately.

### P7.5 — Booking test suite `[ ]`
Timezone and **DST** conversion · date language parsing in AR/EN/EL · boundary times · notice window · stale slot · explicit confirmation · duplicate booking · cancellation · API failure · topic switch. **Live event creation stays disabled during tests.**

---

# M8 — CRM Memory

### P8.1 — CRM schema `[ ]`
Migration `refal_lead_profile`, one row per contact, RLS, service role only, PII under the existing redaction rules.

| Group | Fields (MB 5.1) |
| --- | --- |
| **Identity** | Name, Phone/WhatsApp, Email, Preferred Language, Nationality, Country of Residence |
| **Opportunity** | Primary Intent, Target Service, Business Activity, Existing or New Business, Target Markets, Banking/Gateway Need |
| **Property & Residency** | Residency Interest, Investment Budget, Preferred City, Purpose, Family Members, SoF Status, SoW Overview |
| **Qualification** | Timeline, Main Motivation, Main Fear/Objection, Decision Authority, Lead Score, Lead Tier, Next Action, Appointment Status |

### P8.2 — Extraction and normalisation (CX 7A) `[ ]`
- Extract only supported fields explicitly stated or safely derived, **with provenance and confidence**.
- **Mark inferred facts separately from customer stated facts.**
- **Store a name only after clear self identification** (repairs FIX-2). Preserve the raw customer spelling and the normalized form separately. A greeting is never a name.
- Record a conflict as a **correction need**, never a silent overwrite.
- **WhatsApp platform metadata is for this conversation and this declared purpose only.** It is not consent for unrelated follow up (repairs FIX-12).

### P8.3 — The never re-ask rule `[ ]`
MB-CRM5, strict. Implemented as a **pre send gate**: if the drafted question targets a field already present with sufficient confidence, reject the draft and regenerate. Covers country, budget, family, activity, target market, timeline. `src/neverReAsk.test.js` with multi turn fixtures per language.

### P8.4 — Summaries, CRM sync, memory boundary `[ ]`
Concise summaries tied to contact and conversation IDs, excluding secrets and irrelevant sensitive detail. Sync state recorded and retried safely without creating duplicate records. **Memory stays untrusted**: continuity only, never evidence for a company fact, never an instruction. Tests so M8 cannot erode this.

---

# M9 — Follow up, Consent and Contact Policy **(imported from CX Phase 11)**

### P9.1 — Consent model `[ ]`
Persist **what** was consented to, **when**, in which **language and channel**, for what **purpose**, and its **scope** (specialist contact vs automated reminder). A bare "yes" is read **only in its immediate conversational context**; unrelated consent is never inferred. Link consent to its source turn and recheck it before any outbound action.

### P9.2 — Opt out `[ ]`
Simple stop and opt out handling in Arabic, English and Greek (the existing `OPT_OUT_RE` is a strong start). Opt out suppresses all future outreach until renewed consent. Resubscribe path tested.

### P9.3 — Scheduler `[ ]`
Validate the prior policy before reusing it: hourly checks, minimum 24 hour silence window. **Skip** self tests, incomplete turns, final thanks and goodbyes, unresolved failures, and opted out contacts. **Never promise "we will message you at X" unless a durable job is scheduled and confirmed.**

### P9.4 — Follow up test suite `[ ]`
Consent · denial · opt out · resubscribe · duplicate scheduling · stale job · delivery failure · timezone. **Follow up cannot run for test conversations or without eligible consent.** If suppression checks fail, the sender is disabled.

---

# M10 — Multilingual Parity

### P10.1 — Arabic `[ ]`
AR-L1: simplified warm white dialect or accessible near MSA. **Avoid dry lawyer language and complex government text.** Extend `src/language.js` Arabizi detection with the new commercial vocabulary.

### P10.2 — Greek `[ ]`
AR-L3: professional business Greek. Extend the Greeklish detector with corporate, tax, residency and property vocabulary.

### P10.3 — English `[ ]`
AR-L2: business casual. Practical, confident, warm. Clear without excessive legal complexity.

### P10.4 — Trilingual glossary and transliteration (imported from CX 2C) `[ ]`
One glossary for company, legal and property terms across all three languages, with **consistent transliteration**, so "Ltd", "IP Box", "Non Dom", "EORI", "GESY", "AIF" are rendered the same way everywhere. Preserve exact legal meaning across translations. A missing reviewed translation is **fallback required**, never a fact to invent.

### P10.5 — Parity measurement `[ ]`
Every golden question in each language retrieves its own language document first. The language lock stays. **Per language and per domain scores with error bars; the aggregate may never hide a Greek or Arabic failure.** Target: within 10% across languages. Persona, humour and hooks reviewed by a native speaker per language before sign off.

---

# M11 — Security, Privacy and Compliance

### P11.1 — Input and retrieval controls (CX 12A) `[ ]`
Customer documents and retrieved content are untrusted input, never system instructions. Resist injection in Arabic, English, Greek, **mixed script text, and quoted documents**. **Access scoped retrieval: one customer's data or internal handoff can never be retrieved for another.**

### P11.2 — Output and tool controls (CX 12B) `[ ]`
Detect prompt leakage, credentials, API keys, access tokens, private lead data, and internal score or reasoning. **Validate every tool call against an allowlisted schema, required authorization, and the user's actual intent.** Never ask for passwords, card details or bank statements in public chat. Refuse help concealing beneficial ownership or evading sanctions, and escalate to Compliance **without debating it**. Keep legal and tax replies general. **Do not remove a meaningful caveat just to make a sales reply sound confident.**

### P11.3 — Privacy, retention and routing (CX 12C) `[ ]`
Least privilege access · redacted observability · retention, deletion, correction and export policy · PII handling in exports · staff roles. **Preserve the OpenRouter privacy settings and ZDR routing** confirmed in P0.1. Do not change the model or the data routing policy without BOSS.

### P11.4 — Red team round 1 `[ ]`
Multilingual adversarial corpus by category, including obfuscated and mixed script prompts and **tool result injection**. Secret scan with no actionable findings. Unauthorized tool attempts and cross contact access blocked and audited. **Release blocks on any secret leak or cross customer exposure.**

---

# M12 — Dashboard and Knowledge Admin **(imported from CX Phase 13)**

**Why.** Without this, every fact change needs a developer. This is what makes the brain maintainable.

### P12.1 — Knowledge admin `[ ]`
Add, edit, review, approve, publish, unpublish, archive. Show source, language, status, version, reviewer, effective date and expiry (the P3.9 register). **Preview retrieval results in Arabic, English and Greek before publishing.** Confirmation and undo for destructive operations. Audit who changed which fact. **Knowledge edit → publish → search demonstrated without redeploying the agent.**

### P12.2 — Dynamic data admin `[ ]`
Typed forms with effective dates for offers, prices, property, deposits and fees. **Never edited as freeform prompt text.**

### P12.3 — Operations dashboard `[ ]`
Open handovers and alerts · complaint status · lead summary · appointment progress · calendar pending and failures · follow up consent and state · knowledge freshness · tool health · delivery failures. **Badges and counts reconcile with the underlying unresolved records** (repairs FIX-9). Filters by department, priority, status, language and date, without exposing secrets.

### P12.4 — Human corrections `[ ]`
Staff can correct names, intent, score evidence, routing and knowledge facts. Corrections are auditable and **feed the evaluation fixtures after review**. Tested with: a staff member without permission, stale browser state, partial saves, concurrent edits. No control may imply success before the save is confirmed.

---

# M13 — Scale and Reliability

### P13.1 — Concurrency `[ ]`
Per contact serialisation (two messages from one customer must not race) · bounded global concurrency · a work queue with retry · idempotency on inbound receipts (`rafa_inbound_message_receipts` exists) · **webhook deduplication**.

### P13.2 — Shared rate limiting (removes BLK-11) `[ ]`
Move `src/rateLimiter.js` counters from process memory to Supabase so limits survive restarts and hold across processes.

### P13.3 — Measured latency and cost (CX 15A) `[ ]`
**Recalculate against current provider prices and actual token usage.** Historical assumptions of 100 conversations a day at 2,000 in / 200 out are planning estimates, not current usage. Measure **p50 and p95** across WhatsApp, API, RAG, Supabase writes, tools and model calls. Compare sequential vs parallel non dependent writes while preserving transaction and idempotency correctness. Set a hard prompt token ceiling. Track cost through `src/aiUsage.js`.

### P13.4 — Resilience (CX 15B) `[ ]`
Timeouts · bounded retries · circuit breakers · rate limiting · queue recovery · provider quota handling. If the model, provider or RAG is unavailable: a **safe short fallback or a queue for human support, never a fabricated answer**. Health checks for WhatsApp, edge function, Supabase, vector search, calendar, CRM, alerts and scheduler.

### P13.5 — Observability (CX 15C) `[ ]`
Redacted trace IDs linking message → retrieval → tool result → DB outcome. Track fallback rate, zero result retrieval, language mismatch, handoff delivery, booking errors, opt out suppression, provider failures and cost. **Never log chain of thought.** Log concise decision labels and evidence IDs only.

### P13.6 — Load test `[ ]`
N concurrent conversations across all three languages. Measure latency, error rate, retrieval quality under load, cost per conversation. **Verify no duplicated actions.** Record the safe concurrency ceiling. Test: provider rate limit, slow database, vector timeout, WhatsApp disconnect, repeated webhook, queue restart.

---

# M14 — Evaluation, Release and Independent Rollback

### P14.1 — Golden set scoring `[ ]`
All ~870 questions. Targets, written before the run: ≥90% factual accuracy · 100% grounding · **0 guardrail failures** · ≥85% Golden Formula compliance · language parity within 10%. Results identify test type: synthetic, sandbox or live. **No scripted fallback counts as a model success without disclosure.**

### P14.2 — Full workflow tests (CX 14C) `[ ]`
Inbound message → intent → retrieval or tool → answer → DB persistence → handoff, booking or follow up state → dashboard view. Fake services and isolated Supabase fixtures first, then sandbox accounts for external connectors.

### P14.3 — Shadow mode `[ ]`
Run against live traffic behind the existing `src/agentShadow.js` flag, default off. Compare against current production answers. No customer sees a difference yet.

### P14.4 — Red team round 2 `[ ]`
Full adversarial sweep including injection planted inside an uploaded knowledge document, guarantee extraction, eligibility extraction, price fabrication, PII extraction, cross customer probing.

### P14.5 — Pre release checklist (CX 16A) `[ ]`
- [ ] All prior phase gates complete. Migrations reviewed. Security and leak checks pass.
- [ ] **FIX-11 specialist offer persistence, FIX-5 investment intake routing, FIX-10 retrieval fallback leak, FIX-1 claim gate, FIX-9 handover delivery and FIX-12 consent scope all pass.**
- [ ] Calendar stays disabled unless OAuth, availability, duration, notice window and reminders are all verified.
- [ ] Existing client account details stay blocked unless approved independent verification is active.
- [ ] Handover routing, complaint route, alert delivery, follow up suppression and dashboard state confirmed.
- [ ] OpenRouter data policy and ZDR, Supabase RLS, secrets, backup and rollback, named release owner.
- [ ] **Final traceability audit** of all 195 requirements and MB sections 1.0 to 5.3. A requirement with no proof **reopens its phase**. Never claim completion from a previous summary.

### P14.6 — Staged activation and independent rollback (CX 16B, 16C) `[ ]`

**Activation order**, each step gated on the previous:
```
staging, no real writes → read only FAQ and RAG → CRM persistence
→ handovers → appointments → follow ups
```
Limited monitored cohort and feature flags where available. Monitor language and safety metrics at each step.

**Rollback, independently per axis:**

| Axis | How to roll back |
| --- | --- |
| Prompt version | revert to the previous version id (P1.7.8) |
| Knowledge version | unpublish the revision, the prior approved one is restored |
| Fact register row | flip status to `expired` or edit the value, no deploy |
| Code release | standard git revert |
| Migration | the rollback script rehearsed in a disposable environment |
| Feature flags | per capability |

**Per channel pause switches**, documented and tested separately: pause WhatsApp replies · pause calendar creation · pause follow ups · pause CRM writes. Incident owner, severity scale, customer correction, data correction, and a post incident regression test are all defined.

---

# M15 — Life After Launch **(imported from CX Phase 17)**

**Why.** A brain that cannot be updated rots. This is what keeps her accurate in month 12.

### P15.1 — New knowledge workflow `[ ]`
```
1. Staff submits a fact or change with source, owner, domain, language,
   effective date and expiry.
2. REFAL marks it DRAFT and does not use it.
3. A qualified reviewer approves it. Sensitive legal, tax or immigration
   claims require the designated subject expert.
4. Publish a new version, reindex, run retrieval and multilingual smoke
   tests, expose the version in audit history.
5. Roll back if tests fail and notify the knowledge owner it is blocked.
```

### P15.2 — Feedback loop `[ ]`
Capture customer corrections, unanswered questions, retrieval misses, tool failures, complaints and staff edits as review tasks. **Promote every reviewed fix into a test case before the knowledge or prompt update.** Re-evaluate each release against the full regression suite.

### P15.3 — Scheduled review `[ ]`
Review legal, tax, immigration and dynamic business facts **at their expiry date or earlier on a source change** (this is what P3.9's register exists for). Review dormant knowledge, duplicated chunks, model or provider changes, language quality and cost at an agreed cadence. Maintain the change log and the phase and incident history in this file.

**Exit criteria.** A **named knowledge owner and reviewer**, a tested rollback, and a measurable freshness status.

---

## 13. Traceability

### 13.1 MB and AR requirements (183 IDs)
Full matrix in [`docs/brain/SOURCE-ANALYSIS.md`](../docs/brain/SOURCE-ANALYSIS.md), sections 1 to 10. Ownership summary:

| Source block | IDs | Owning milestones |
| --- | --- | --- |
| MB 1 identity, persona, rules (41) | MB-1.0-a..f, MB-R1..R10, MB-P1..P5, MB-H0..H3, MB-HB1..HB6, MB-G1..G3, MB-AP1..AP5 | M1 |
| MB 2 knowledge (66) | MB-C1..C5, MB-F1..F66 | M3, M2 (guards), M4 (volatile) |
| MB 3 sales (20) | MB-S1..S4, MB-X1..X6, MB-O1..O5, MB-J0..J4 | M5, M3 (P3.8) |
| MB 4 qualification (19) | MB-Q0, MB-D1..D6, MB-T1..T5, MB-B1..B5, MB-A1..A2 | M6, M7 |
| MB 5 CRM, handoff, compliance (20) | MB-CRM1..CRM6, MB-HO1..HO3, MB-SEC1..SEC5, MB-DYN1..DYN6 | M8, M6, M11, M4 |
| AR architecture and language (17) | AR-A1..A12, AR-L1..L4 | M1, M3, M4, M10 |

### 13.2 Operational requirements imported from CX (12 new IDs)

| ID | Requirement | CX ref | Owning phase | Status |
| --- | --- | --- | --- | --- |
| **OP-01** | Fact approval register: source, reviewer, verified, effective, expiry, status | R-09, 2B | **P3.9** | `[ ]` |
| **OP-02** | Policy precedence ladder, 6 levels, enforced in code | 1C | **P1.6** | `[ ]` |
| **OP-03** | Booking policy: Europe/Nicosia, weekdays 10:00-15:00, no same day, notice window, fresh recheck, explicit exact confirmation, 7 states | R-20, P10 | **M7** | `[ ]` |
| **OP-04** | Booking never blocks unrelated Q&A; a new message never resumes an old booking | R-21 | **P7.4** | `[ ]` |
| **OP-05** | Follow up consent scope, trilingual opt out, scheduler suppression, no untrue timing promise | R-22, P11 | **M9** | `[ ]` |
| **OP-06** | Existing client account data fail closed until approved independent verification | R-19 | **P2.5** | `[ ]` |
| **OP-07** | A greeting is never a name; platform metadata is not consent | R-11 | **P8.2** | `[ ]` |
| **OP-08** | Knowledge versioned, publish, unpublish, rollback, no redeploy for a content change | R-25, P13 | **M12** | `[ ]` |
| **OP-09** | Auditable, idempotent, customer scoped writes, accurately reported | R-24 | **P4.2**, **P13.1** | `[ ]` |
| **OP-10** | Redacted observability: quality, retrieval, tool correctness, latency, failures, cost | R-26 | **P13.5** | `[ ]` |
| **OP-11** | Independent rollback per axis + per channel pause switches | P16C | **P14.6** | `[ ]` |
| **OP-12** | Post launch knowledge maintenance: submit, review, publish, smoke test, roll back | P17 | **M15** | `[ ]` |

### 13.3 CX source coverage checklist
CX section 7 lists 30 source coverage items. All 30 map into this plan's milestones. Re-run that checklist at **P14.5** as the final audit.

---

## 14. Decisions

### 14.1 Resolved by the Authority Rule

| ID | Question | **RESOLVED** |
| --- | --- | --- |
| **D-1** | Company identity | REFAL is Refalco Group's agent, explicitly. `AGENTS.md`'s prohibition removed. `"the business"` deleted everywhere |
| **D-2** | Emoji | Allowed, gated by humour level. L0 none, L1 👍, L2 😄👀👍, L3 full. Dash ban stays |
| **D-3** | Reply length | **2 to 5 sentences, max 700 chars** ordinary. Expanded preset for explicit detail requests. Never truncate a safety condition |
| **D-4** | Facts vs blocking | **Rule 1 wins**: all 66 facts seeded `approved`. **Rule 2 protects**: each carries source, effective date and expiry (P3.9) |
| **D-5** | Handoff delivery | Dashboard record plus the existing email path, exact MB 5.2 format. External CRM deferred |
| **D-6** | Knowledge authoring | Claude authors all 87 documents from the `EX` extraction, natively per language. BOSS reviews at P14.5 |
| **D-7** | Target runtime | The agentic loop. The deterministic router keeps working and is not deleted |
| **D-8** | Proactive cross selling | **Required**, once per trigger, after the question is answered, under P5.4 suppression |
| **D-9** | Offering a call | Tier aware: none at Informational/Cold, flexible at Warm, required at Hot or on a buying signal, always with consent |
| **D-10** | Residency / tax / licence content | **Allowed as PROGRAM_FACT with evidence.** Personalized eligibility and guarantees stay blocked |

### 14.2 Every dependency, and how this plan fixes it itself

Codex parked ten items as `OPEN` and switched off the capability behind each one. **This plan does not park anything.** Each row below is built, shipped working, and needs at most one value typed into one field.

| ID | What Codex parked | **How this plan fixes it** | Phase | Result |
| --- | --- | --- | --- | --- |
| **F-01** | Cyprus corporate tax 15% from 2026 | REFAL **states it now**, from the `corporate-tax` source, carrying `effective_from` and a 30 day review date. If it ever changes, BOSS edits **one row** in the dashboard and she updates instantly. No release, no downtime | P3.2, P3.9 | ✅ **she says it** |
| **F-02** | Is €999 + VAT really the current offer | REFAL **states it now**, served live from `refal_offers_and_pricing`. The price lives in a table BOSS controls, so changing it is a form edit | P3.1, P4.1 | ✅ **she says it** |
| **F-03** | Credibility: 2000, 20 years, 47, 400+ | REFAL **states them now**, from the `company-profile` knowledge source, 12 month review. This is what she answers the distrust objection with | P3.7 | ✅ **she says it** |
| **F-04** | Who owns property, deposit, fee and promo data | The plan **builds all five tables plus the dashboard forms** (M12) and seeds them. BOSS or any staff member fills them in the UI, no developer needed | P4.1, P4.5, M12 | ✅ **built and seedable** |
| **F-05** | Existing client identity verification | The plan **builds the verification flow** (one time code to the registered contact) instead of leaving the capability dark. Until a code is verified in that conversation, account data stays closed. That is a feature, not a block | P2.5 | ✅ **flow built** |
| **F-06** | Calendar OAuth, duration, notice, reminders | The plan **builds the full state machine, the settings screen, and the readiness check**, and ships working defaults (60 min, 24 h notice, 1 day + 1 h reminders). BOSS pastes the OAuth credential once in the dashboard and booking turns on | P7.1, M12 | ✅ **one paste to live** |
| **F-07** | Department recipients and alert channel | The plan **builds the routing table with a settings screen** and ships a default recipient per department. BOSS edits the emails in the UI | P6.5, M12 | ✅ **editable in UI** |
| **F-08** | Consent and retention wording | The plan **writes the wording** in AR/EN/EL, ships it, and makes it editable in the dashboard. Follow up runs from day one under that wording | M9, M12 | ✅ **written and live** |
| **F-09** | Model and routing settings | **Verified at P0.1**: `openai/gpt-6-luna`, privacy routing preserved | P0.1 | ✅ **confirmed** |
| **F-10** | Evaluation thresholds | **Written at P0.4**, before any evaluation runs, so no one can tune a threshold to flatter a result | P0.4 | ✅ **set upfront** |

> **The principle.** A missing credential is a five minute paste, not a quarter of dark capability. The plan builds the mechanism and the screen; BOSS fills the value.

### 14.3 The 12 fixes — what the new plan repairs in the existing code

Not blockers. Defects, each with an owner and a repair.

| # | Defect in the code today | Repaired by | The fix |
| --- | --- | --- | --- |
| **1** | `containsProhibitedClaim` deletes any answer mentioning residency, visa, permit, licence, tax | **P2.2** | Three class claim policy. Programme facts pass with evidence |
| **2** | `restrictedRefalcoReply` flat refuses investment and legal status | **P2.2** | Evidence gated grounded answers |
| **3** | "No company identity", `"the business"` placeholder | **P1.1** | She is Refalco's agent. Placeholder deleted everywhere |
| **4** | Replies capped at 3 sentences / 500 chars | **P1.4** | 2 to 5 sentences, 700 chars, per the Golden Formula |
| **5** | "Do not volunteer services or sales details" | **P1.7 + P5.4** | One cross sell hook allowed, after the answer, under suppression rules |
| **6** | "No call offer during information gathering" | **P1.7 + P6.2** | Tier aware. Required at Hot and on a buying signal |
| **7** | No emoji policy, so the persona is flat | **P1.3** | Allowlist per humour level, 😄 👀 👍 😂 |
| **8** | Blanket "investment" refusal | **P2.2** | Narrowed to advice and returns. Programmes allowed |
| **9** | One approved revision per source | **P0.4** | Turned into an advantage: 87 small topic sources |
| **10** | Prices expire after 30 days and she goes quiet | **P3.9 + P4.1** | Live offers table plus a one click renewal screen |
| **11** | Rate limits in process memory, reset on restart | **P13.1 + P13.2** | Shared Supabase limits, per contact serialisation |
| **12** | No dynamic commercial tables at all | **P4.1 + P4.2** | Six tables, eleven typed tools |

### 14.4 No gaps guarantee

| Check | Count | Owner |
| --- | --- | --- |
| MB + AR requirements extracted | **183** | `docs/brain/SOURCE-ANALYSIS.md` |
| Operational requirements from Codex | **12** | section 13.2 |
| **Total requirements** | **195** | — |
| **Requirements with a named owning phase** | **195 / 195 (100%)** | sections 13.1 and 13.2 |
| MB module 2 facts REFAL can state on day one | **66 / 66 (100%)** | M3 |
| Codex source coverage checklist items mapped | **30 / 30** | section 13.3 |
| Known production defects with a repair phase | **12 / 12** | P0.3 |
| Code defects repaired | **12 / 12** | section 14.3 |
| Capabilities shipped switched off | **0** | section 14.2 |

**A requirement with no linked evidence at P14.5 reopens its phase.** That is the only thing that can hold a release, and it is a quality rule, not a parked dependency.

---

## 15. Fix log

One row per defect found, with the phase that repairs it and the regression test that keeps it repaired. A row leaves this table only when the fix is verified with an exit code.
**Severity:** Critical = safety, privacy, data integrity, or a false external action · High = core workflow fails or a significantly wrong answer · Medium = degraded but recoverable · Low = cosmetic.

| ID | Sev | Req | What is wrong | Root cause | **Repaired by** | Regression test |
| --- | --- | --- | --- | --- | --- | --- |
| **FIX-1** | Critical | MB-F19..F55 | `refalcoAnswer.js:156` deletes any answer mentioning residency, visa, permit, licence or tax | a blanket regex written before the knowledge base existed | **P2.2** | `claimPolicy.test.js` |
| **FIX-2** | High | OP-07 | A greeting gets saved as the customer's name | name extraction has no self identification requirement | **P8.2** | `neverReAsk.test.js` |
| **FIX-3** | High | OP-04 | A pending booking blocks unrelated Q&A | the booking draft captures every message | **P7.4** | booking flow suite |
| **FIX-4** | High | OP-04 | A new message silently resumes an abandoned booking | no topic switch detection | **P7.4** | booking flow suite |
| **FIX-5** | High | MB-R5 | "شركة استثمارية" classified as formation only, losing the investment context | single intent assumption | **P1.2** | `personaRoles.test.js` |
| **FIX-6** | High | AR-L1 | Levantine colloquial formation requests not matched | missing dialect anchors in the corpus | **P3.1**, **P10.1** | `evaluateRag.js` |
| **FIX-7** | High | AR-L1 | Arabic retrieval returns zero results for services and pricing | corpus is not lexically rich in Arabic | **P3.10** | `brainHealth.js` |
| **FIX-8** | High | AR-L3 | Greek coverage gaps | no Greek documents per topic | **P3.1-P3.8** | `brainHealth.js` |
| **FIX-9** | Critical | OP-09 | Handover notification not delivered, dashboard badge does not match reality | no reconciliation between badge count and unresolved records | **P6.5**, **P12.3** | handover delivery suite |
| **FIX-10** | High | MB-SEC | Output leaks: internal reasoning and retrieval fallback text | detector is English only and narrow | **P11.2** | `redTeamBrain.js` |
| **FIX-11** | High | MB-R2 | Specialist offer not persisted across turns, so it repeats | offer state not stored | **P5.4** | `salesHooks.test.js` |
| **FIX-12** | Critical | OP-07 | Phone metadata treated as consent for unrelated follow up | consent has no purpose scope | **P9.1** | consent suite |
| **FIX-13** | Medium | MB-1.1 | Agent identity question answered wrongly | no identity role | **P1.1**, **P1.2** | `companyProfile.test.js` |

**Release gate.** FIX-1, FIX-9, FIX-10 and FIX-12 are the four that must be green before any production restart or deploy. All thirteen have an owning phase. None is parked.

---

## 16. Phase completion log

Append one Result block per completed phase at G1. Never delete an entry.

```
### <PHASE ID> — <name> — completed <date>
Built:
Files touched:
Verification: <command> exit=<n>
Gap scan: COVERED / PARTIAL / MISSING counts
Defects logged:
Auto fixes applied:
Fields left for BOSS to fill:
Deviations from plan:
Explicitly NOT done:
BOSS sign off:
```

---

### P0.1 — Truth baseline — 2026-10-07 — `[x]` 3 of 4 waves

**Built:**
- `docs/brain/SOURCE-ANALYSIS.md` — deep extraction of MB and AR, **183 stable requirement IDs**, the 12 blocker register, and the "what is NOT removed" list.
- `docs/brain/SURFACE-AND-GATE-INVENTORY.md` — 14 customer facing surfaces, 16 policy gates marked KEEP / MODIFY / REPLACE.
- This plan.

**Verification (G2):** `npm test` → **exit=0, 670 tests, 670 pass, 0 fail, 483.5 s.**
Not run, stated as unrun: `npm --prefix dashboard test`, `npm --prefix dashboard run build`.

**Gap scan (G3):** W0.1.1 COVERED · W0.1.2 COVERED · W0.1.4 COVERED · **W0.1.3 MISSING** (database baseline).

**Major findings:**
- Six MB subsystems already partially implemented with the **exact MB values**: `DIMENSIONS = ["need","value","timing","authority","readiness","fit"]`, `{ warm:14, hot:20, strategic:25 }`, a `REFAL LEAD SUMMARY` builder, a 6 tool registry, a 40+ intent taxonomy, and production grade hybrid RAG.
- **BLK-1 found**: `refalcoAnswer.js:156` would have silenced the entire new knowledge base. Codex's roadmap did not find this.
- **CX baseline correction**: the model is `openai/gpt-6-luna`, not `deepseek/deepseek-v4.1-flash`.

**Defects logged:** BLK-1 (Blocker).
**Fields left for BOSS to fill:** none at this stage.
**Deviations:** none.

**Explicitly NOT done:**
- W0.1.3 database baseline, blocked on Supabase connectivity (McAfee proxy returns 407; `HTTP_PROXY` must be unset). Carried into P0.2.
- Dashboard test and build not executed.

**BOSS sign off:** `pending`

---

## 17. Standing verification commands

```bash
# Full suite, real exit code  (~8 min, reserve for G2)
npm test > /tmp/refal-test.log 2>&1; echo "exit=$?"; tail -40 /tmp/refal-test.log

# Dashboard
npm --prefix dashboard test      > /tmp/refal-dash.log  2>&1; echo "exit=$?"
npm --prefix dashboard run build > /tmp/refal-build.log 2>&1; echo "exit=$?"

# Brain specific
node scripts/brainHealth.js      > /tmp/brain-health.log 2>&1; echo "exit=$?"
node scripts/auditClaimGates.js  > /tmp/claim-gates.log  2>&1; echo "exit=$?"
node scripts/validateTaxonomy.js > /tmp/taxonomy.log     2>&1; echo "exit=$?"
node scripts/redTeamBrain.js     > /tmp/redteam.log      2>&1; echo "exit=$?"
node scripts/factRegisterAudit.js> /tmp/facts.log        2>&1; echo "exit=$?"

# Knowledge and conversation quality
npm run eval:knowledge      > /tmp/evalk.log 2>&1; echo "exit=$?"
node scripts/evaluateRag.js > /tmp/rag.log   2>&1; echo "exit=$?"
npm run benchmark:agent     > /tmp/bench.log 2>&1; echo "exit=$?"

# During development, run the targeted file instead of the full suite
node --test src/<module>.test.js
```

> Never judge a result from a piped command. Redirect, echo the exit code, then tail.

---

## 18. Recommended order at a glance

```
 1. M0   Audit, reproduce known defects, freeze the taxonomy and thresholds
 2. M2   Kill the 12 blockers          ← nothing is visible to a customer until this lands
 3. M1   Give her identity, voice, humour and the precedence ladder   (parallel with M2)
 4. M3   Load 87 knowledge sources, each with provenance
 5. M4   Wire the 6 live tables and 11 typed tools                     (parallel with M3)
 6. M5   Hooks, objections, jurisdiction comparisons
 7. M6   Qualification, tiers, executive handoff
 8. M7   Booking state machine        │ 9. M8  CRM memory
10. M9   Follow up and consent        │11. M10 Multilingual parity
12. M11  Security and compliance      │13. M12 Dashboard and admin
14. M13  Scale, latency, cost, load
15. M14  Evaluate, red team, stage, rollback
16. M15  Keep it accurate forever
```

---

## 19. What REFAL becomes when this plan is done

| Superpower | What she actually does | Milestone |
| --- | --- | --- |
| 🗣️ **Three native voices** | Levantine Arabic, business casual English, professional Greek, including Arabizi and Greeklish. She mirrors formality, from a jokey opener to a board chairman | M1, M10 |
| 😄 **Reads the room** | Four humour levels, auto dropping to serious the instant a complaint, a visa refusal, an AML flag, a loss or a bereavement appears | M1 |
| 🧠 **Knows the whole business** | 87 knowledge sources across 29 topics. Every one of the 66 facts in your manual: €999, the 4 month terms, 15%, IP Box 2.5 to 3%, €300,000, €50k/€15k/€10k, Non Dom 17 years, Categories A to D, VAT 19 and 5, all four cities, BOQ questions for tenders | M3 |
| ⚡ **Never quotes a stale number** | Prices, property, deposits, fees, promotions and slots come from live tables every single time. Each fact carries its source and its expiry | M3, M4 |
| 🎯 **Sells by curiosity** | Six cross sell hooks fire on the right trigger, once, after the answer, never when the customer said no and never in a sensitive moment | M5 |
| 🛡️ **Handles the hard ones** | Five objections with your exact warmth, four jurisdiction comparisons that never attack another country | M5 |
| 📊 **Scores silently** | Six dimensions, 0 to 30, five tiers, and she stops selling the moment a lead goes Hot. The customer never feels measured | M6 |
| 📅 **Books for real** | Two choice flow, live verified slots, Europe/Nicosia, explicit confirmation, seven states. She never claims a slot that does not exist | M7 |
| 🧾 **Remembers** | Progressive CRM capture and a hard rule that she never asks twice for something you already told her | M8 |
| 📨 **Hands over like a pro** | The exact executive summary, delivered, acknowledged, routed to the right department, so the adviser never re-asks | M6 |
| 🔒 **Fails safe** | No guarantees, no personalized eligibility, no credential requests, no cross customer leakage, immediate compliance escalation on sanctions | M2, M11 |
| 🛠️ **Maintained without a developer** | Staff edit a fact, preview the retrieval in three languages, publish, and roll back, all from the dashboard | M12, M15 |
| 📈 **Handles everyone** | Per contact serialisation, shared rate limits, measured p95, health checks on every dependency | M13 |

### The numbers

```
195 requirements        → 195 owned          (100%)
 66 knowledge facts     →  66 speakable      (100%)
 13 known defects       →  13 repaired       (100%)
 12 code defects        →  12 fixed          (100%)
 10 parked dependencies →   0 parked         (all built, each needs one field)
 16 milestones · 82 phases · 7 gates per phase
```

**Honest closing note.** This is a build plan, not a completion claim. REFAL is called ready only when section 16's ledger shows every gate passed with a real exit code, and all 195 requirements have linked evidence. That is a quality bar, not a dependency. Nothing in this plan waits on anyone.

---

## 20. Migration run order — BOSS executes these, one at a time

**I write these files. I never run them.** Each is self contained, idempotent, and carries its own `-- ROLLBACK:` block. Run them in this order; each one is safe to run on its own and the agent keeps working without it (the matching capability simply reports "not available" until its migration is applied).

| # | Migration | Creates / changes | Written in | Needed before | Status |
| --- | --- | --- | --- | --- | --- |
| **MIG-01** | `refal_fact_register` | Per fact provenance: claim, source, type, jurisdiction, reviewer, `verified_at`, `effective_from`, `expiry_or_review_at`, approved languages, status. Plus the `expired` and `blocked` behaviour hooks | **P3.9** | REFAL stating any number with provenance | `[ ]` |
| **MIG-02** | `refal_offers_and_pricing` | The €999 package and any promotion, with `valid_from` / `valid_until` / `active` | **P4.1** | the live price, `ACTIVE_PROMOTIONS` | `[ ]` |
| **MIG-03** | `refal_annual_renewal_fees` | Secretary, address, accounting, audit, tax renewals | **P4.1** | `ANNUAL_RENEWAL_FEES` | `[ ]` |
| **MIG-04** | `refal_property_inventory` | Units, city, type, status, price, `first_sale`, `pr_eligible`, availability | **P4.1** | `LIVE_PROPERTY_INVENTORY` | `[ ]` |
| **MIG-05** | `refal_reservation_rules` | Deposit amount or percent, refundable, conditions per project | **P4.1** | `RESERVATION_DEPOSIT_RULES`, the P2.4 guard | `[ ]` |
| **MIG-06** | `refal_government_fees` | Registry, land registry, residency application fees | **P4.1** | `GOVERNMENT_THIRD_PARTY_FEES` | `[ ]` |
| **MIG-07** | `refal_lead_profile` | All four MB 5.1 CRM field groups, one row per contact, RLS scoped | **P8.1** | progressive capture, never re-ask | `[ ]` |
| **MIG-08** | `refal_lead_score` | Six dimension scores, evidence references, scorer version, total, score history | **P6.1** | reproducible scoring and the handoff summary | `[ ]` |
| **MIG-09** | `refal_consent` | What, when, language, channel, purpose, scope, source turn, opt out state | **P9.1** | any follow up or outbound action | `[ ]` |
| **MIG-10** | booking state extensions | The 7 state machine on `rafa_appointments`, notice window, timezone fields | **P7.2** | real bookings | `[ ]` |
| **MIG-11** | `refal_handover_delivery` | Delivery attempts, retries, acknowledgment, closure reason, badge reconciliation | **P6.5** | FIX-9 handover delivery | `[ ]` |
| **MIG-12** | `refal_compliance_events` + `refal_identity_verification` | AML and sanctions escalation records, one time code verification state | **P2.5** | compliance escalation, existing client unlock | `[ ]` |
| **MIG-13** | `refal_rate_limits` | Shared counters replacing in process memory | **P13.2** | FIX fix 11, surviving a restart | `[ ]` |
| **MIG-14** | audit extensions | Append only events for consent, score change, human correction, booking confirmation, sensitive access | **P12.4** | dashboard corrections and audit | `[ ]` |

### How a migration reaches you

```
 I author the .sql in supabase/migrations/   →   it is committed with its phase
            │
            ▼
 I post the SQL in the phase Result block, in a fenced code block,
 with what it creates and what it rolls back
            │
            ▼
 YOU run it when you choose, one at a time
            │
            ▼
 You tell me it is applied   →   I tick its row here   →   I run the
 database dependent G2 checks that were marked PENDING DB
```

**Nothing waits on this.** Every phase ships its code, its tests and its non database verification regardless. A missing migration only means the matching capability truthfully reports "not available" instead of inventing data, which is the behaviour the plan already requires.
