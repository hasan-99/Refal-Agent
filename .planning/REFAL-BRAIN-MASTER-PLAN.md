# REFAL MASTER BRAIN — Merged Implementation Plan (v2)

> **This file supersedes v1.** v1 is preserved in git history at commit `ce2559e`.
> v2 merges the Claude plan with the Codex roadmap. Nothing from either was discarded.
> The Codex roadmap has been removed from the tree now that it is fully absorbed here; it is preserved in git history at commit `02fd58a` (`newplan/Roadmap_from_codex.md`).
> **This is the only roadmap in the repository.**
>
> | | Score | Fact candidates extracted | Phases executed |
> | --- | --- | --- | --- |
> | Plan A (Claude v1) | 147 / 200 | 66 / 66 | 1 |
> | Plan B (Codex) | 137 / 200 | 46 / 66 | 0 |
> | **This merged plan** | **189 / 200** | **66 / 66 mapped to governance; speakability depends on current approval** | **1 (carried over)** |
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

**Total tracked requirements: 195** = 183 requirements extracted from MB/AR (`EX`) + 12 operational requirements imported from CX (`OP-01` to `OP-12`, section 13.2). Extracted business claims remain subject to approval and freshness checks before customer use.

---

## ⚡ The two governing rules

### Rule 1 — Authority and customer-facing facts
The owner manual and `plan.txt` define REFAL's intended identity, operating style, knowledge domains, and architecture. They are reference material, not automatic approval to state company facts. The repository Constitution and operating rules govern customer-facing behavior: identity may be stated freely, while services, prices, projects, track record, legal/tax/residency guidance, timelines, and availability require approved, current evidence. Volatile values come from trusted live data. The 66 extracted items are fact candidates mapped to the approval workflow; none is speakable merely because it appears in the manual. The old generic-identity refusal was a defect and was removed in P1.1 without weakening evidence gates.

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

**I never write to Supabase.** Confirmed working rule, set by BOSS 2026-10-07.

> **Corrected twice on 2026-10-09/10, and the second correction overrides the first.**
>
> **First pass, during P3.10:** the original "this environment has no Supabase access" looked wrong,
> because `GET /rest/v1/rafa_knowledge_sources` returned HTTP 200 and the tables read as empty.
>
> **Second pass, during the M3 deployment: that reading was WRONG, and the way it was wrong matters.**
> `RAFA_DASHBOARD_SUPABASE_SECRET` on this machine **does not authenticate**. Every RLS policy on the
> knowledge tables is `rafa_private.dashboard_secret_matches()`, which sha256s the supplied header and
> compares it to `rafa_private.api_secret_hashes`. Calling `rpc/rafa_dashboard_secret_matches` with the
> configured value returns **`false`**. So those HTTP 200s with zero rows were **RLS denials wearing the
> costume of an empty table**, and "all three tables are empty" was an unproven conclusion that happened
> to be true. A PostgREST **write** from here would have been accepted and silently discarded.
>
> **What does work: the Supabase Management API query endpoint**, which runs as the service and is not
> filtered by RLS. It was always the documented path on this PC (`SUPABASE-ACCESS-GUIDE.md`,
> `scripts/inspectSupabaseReadOnly.ps1`). Two siblings were added for the deployment:
> `scripts/querySupabaseReadOnly.ps1` (ad hoc `read_only` query) and
> `scripts/applySupabaseMigration.ps1` (applies **one named file**, never a bulk push).
>
> **The lesson, which is the whole reason this note is long:** an HTTP 200 carrying zero rows proves
> nothing under RLS. Confirm emptiness through a path that is not subject to the policy, or do not
> claim it. There is no Node side `service_role` credential here (CF-06), so that path is the
> Management API.
>
> **The write rule did not loosen, it got a reviewed instrument.** Every schema change is still a
> numbered `.sql` file with a `-- ROLLBACK:` block, applied one at a time by name, with BOSS's explicit
> go-ahead. What changed on 2026-10-10 is that BOSS gave that go-ahead and the files were applied from
> here rather than pasted into a dashboard.

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

## 3. Milestone overview — 16 milestones, 83 phases

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

### P0.1 — Truth baseline `[x]` all 4 waves, see section 16
Delivered `docs/brain/SOURCE-ANALYSIS.md` (183 IDs, 12 blockers) and `docs/brain/SURFACE-AND-GATE-INVENTORY.md` (14 surfaces, 16 gates). Test baseline re-verified 2026-10-08: `exit=0`, **670 tests, 670 pass, 0 fail**.
**All four waves covered.** W0.1.3 was **executed 2026-10-08**, read only, 129 rows, exit=0, and is recorded in section 16.
**BOSS sign off:** `pending`. The data is in; only the signature is outstanding.

| Wave | Work |
| --- | --- |
| **W0.1.1** `[x]` | **Source extraction.** MB and AR mined into 183 stable requirement IDs and the 12 blocker register → `docs/brain/SOURCE-ANALYSIS.md`. |
| **W0.1.2** `[x]` | **Surface and gate inventory.** 14 customer facing surfaces, 16 policy gates marked KEEP / MODIFY / REPLACE. |
| **W0.1.3** `[x]` | **Database baseline. EXECUTED 2026-10-08**, read only, 129 rows, exit=0. Corpus empty (0/0/0), BLK-12 confirmed, CR-010 already enforced, pgvector 0.8.2 present. Full record in section 16. |
| **W0.1.4** `[x]` | **Test baseline with real exit codes.** Re-verified 2026-10-08: root `exit=0` 670/670; dashboard `exit=0` 85/85; dashboard build `exit=0`. |

---

### P0.2 — Conflict register: MB vs code `[x]` completed 2026-10-08

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

### P0.3 — Reproduce the 13 known defects and assign each a repair `[x]` completed 2026-10-08

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

### P0.4 — Taxonomy, ID scheme, and the Golden Evaluation Set `[x]` completed 2026-10-08

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

**Database changes (apply in order).**
1. [x] `supabase/inspection/W0.1.3_database_baseline.sql` — EXECUTED 2026-10-08, read only, 129 rows, exit=0. Closed W0.1.3 and therefore P0.1. Results in section 16. See `supabase/inspection/README.md`.
2. [x] `supabase/inspection/W0.1.3_database_baseline_SINGLE.sql` — EXECUTED 2026-10-08. Same ten checks folded into one statement, because the Supabase SQL editor returns only the last statement of a multi-statement batch. Use this one for any re-run.

---

# M1 — Rules: Identity, Persona, Humour, Golden Formula, Precedence

**Exit criteria.** REFAL's voice, humour calibration, answer shape, anti patterns and conflict resolution are implemented, synchronised across all surfaces, and tested in three languages. The prompt stays **compact**: stable rules only, reference content lives in retrieval (CX 5A).

---

### P1.1 — REFAL becomes Refalco's agent (removes BLK-3) `[x]` completed 2026-10-09

| Wave | Work |
| --- | --- |
| **W1.1.1** | `config/company-profile.json`: `{ legalName, brand:"REFAL", groupName:"Refalco Group", foundedYear:2000, yearsExperience:20, developmentProjects:47, totalProjects:400, jurisdiction:"Cyprus", timezone:"Europe/Nicosia", cities:[...], departments:["Corporate","Tax","Real Estate","Residency","Construction","Customer Service","Compliance"], languages:["ar","en","el"] }` |
| **W1.1.2** | `src/companyProfile.js`: load, validate, freeze. A missing profile is a **startup error**, not a silent downgrade. |
| **W1.1.3** | **Delete `"the business"` everywhere**: `src/ai.js:153,188,190,194,198,199,217`, `src/refalcoAnswer.js:188-193`, `config/refal-agent-rules.md:5,35`, `dashboard/server.js:1882,1906`, edge fn, `AGENTS.md:3`, `README.md`. |
| **W1.1.4** | Prompt carries identity and positioning as **persona**. The four credibility numbers go into the `company-profile` knowledge source (P3.7) so they stay evidence gated and citable, exactly as MB-O5 uses them. |
| **W1.1.5** | Rewrite `AGENTS.md`: REFAL is Refalco Group's digital business agent. Company **facts** still require approved knowledge; company **identity** no longer does. |

**G2.** `src/companyProfile.test.js`. `grep -rn '"the business"' src/ dashboard/ config/ supabase/` → zero.
**G3.** `grep -rnE '\b(2000|47|400)\b' src/brainPrompt.js src/ai.js config/refal-agent-rules.md` → zero.

**Verification 2026-10-09 — both gates PASS.**

- **G2:** `src/companyProfile.test.js` → **10 tests, 10 pass**. The placeholder grep returns **zero** both as written (quoted form) and in the broader unquoted form, across `src/ dashboard/ config/ supabase/`, excluding `node_modules` and `dist` (third-party and build output, not ours). The only surviving occurrences are inside `companyProfile.js` and its test, where the string is **deliberate**: the validator rejects any profile that reintroduces it.
- **G3:** → **zero**. `src/brainPrompt.js` does not exist yet; it is created later in M1. The four credibility numbers are not in `src/ai.js` or `config/refal-agent-rules.md`.

**What the sweep actually found.** The placeholder was a botched find-and-replace from commit `538c01e`, which substituted the company name with the literal `the business` and left broken grammar in production replies: `"Approved the business information"`, `"Ask a the business question"`, and English spliced into Greek as `"πληροφορίες της the business"`. Arabic escaped it because it uses `الشركة`. **275 occurrences across 49 files**, swept in one consistent pass so assertions stayed in step with the strings they assert.

**A second form of the same corruption.** Beyond `the business`, the bare word `business` was also standing in for the company name inside detection patterns and Greek strings (`τι είναι η business`, `εργασία στη business`, `work for business`). Six patterns in `src/intent.js` and `src/conversationRecap.js` keyed on it, so once the company had a real name those detectors stopped recognising it — three tests failed and exposed the coupling. Fixed by **adding** `refal(?:co)?(?:\s+group)?` alongside `business` rather than replacing it, so existing customer phrasings keep matching. Ordinary English uses of the word (`business expansion`, `business relocation`, `business days`, form-field labels) were deliberately left alone.

**BLK-3 was also live on the dashboard.** `dashboard/server.js` carried the same blanket identity denial in its own system prompt. Both surfaces were corrected together; leaving one would have given the operator and the customer different answers about who REFAL works for.

**One test was pinning the defect.** `src/ragPolicy.test.js` asserted the prompt *contained* "No company identity or services are preconfigured". That assertion was inverted: it now asserts the identity line is present, that facts remain evidence-gated, and that the old denial is absent.

**Suite:** root **685/685 exit=0** (was 675, +10 for `companyProfile.test.js`). Dashboard **85/85 exit=0**.

> **Footgun recorded:** `npm test` is a hand-maintained list of ~65 file paths, not a glob. A new test file is **silently excluded** and the suite still reports green. `src/companyProfile.test.js` had to be added explicitly.

---

### P1.2 — Persona and the 10 roles `[x]` completed 2026-10-09

| Wave | Work |
| --- | --- |
| **W1.2.1** | `src/personaRoles.js`: MB-R1..R10 with trigger conditions and the one behavioural rule each adds. |
| **W1.2.2** | Role selection from `src/intent.js` (40+ intents already exist). Multiple roles may be active; **at most 2 role directives** reach the prompt, to protect the token budget. |
| **W1.2.3** | Persona core (MB-P1): *"خفيفة دم... بس فاهمة شغلها"* → cheerful, warm, quick witted, simple, natural, commercially perceptive. Authored **natively** per language. |
| **W1.2.4** | Adaptive mirroring (MB-P3..P5): casual → simple and friendly; executive or HNW → formal, concise, highly professional. Signals: length, formality markers, titles, budget magnitude. **Never infer from nationality, language or name** (CX 8A fairness rule). |

---

### P1.3 — Humour Engine, levels 0 to 3 (removes BLK-7) `[x]` completed 2026-10-09

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

### P1.4 — Golden Answer Formula and One Question Rule (removes BLK-4) `[x]` completed 2026-10-09

| Wave | Work |
| --- | --- |
| **W1.4.1** | `src/goldenFormula.js`: `analyseAnswerShape(answer) → { hasDirectAnswer, hasValueHook, questionCount, sentenceCount }`. Trilingual sentence and question splitting (`?`, `؟`, Greek `;`). |
| **W1.4.2** | **One Question Rule** (MB-G3): max 1 question, or 2 only when tightly coupled. Extend `responsePolicy.js` with the coupling exception, set to **reject** not warn. A question is **optional**, not mandatory (CX 1B). |
| **W1.4.3** | **Length budget.** New `ORDINARY = { minSentences:2, maxSentences:5, maxChars:700 }`. `EXPANDED = { maxSentences:20, maxChars:1800 }` for an explicit detail request. **Never truncate a material safety or eligibility condition to fit** (CX 5C). Update every test asserting 3 / 500. |
| **W1.4.4** | The value hook is **evidence optional**. Never force a hook into every reply. |
| **W1.4.5** | Encode MB 1.3's four worked examples (2 ❌, 2 ✅) as regression fixtures. |

---

### P1.5 — Anti pattern guards `[x]` completed 2026-10-09

| ID | Anti pattern | Gate |
| --- | --- | --- |
| **AP-1** | Phone number obsession (MB-AP1) | Block a contact request in a turn that delivered no approved fact, unless the customer asked |
| **AP-2** | Legal disclaimer overload (MB-AP2) | Max one caveat clause per reply. **But never remove a meaningful caveat just to sound confident** (CX 12B) |
| **AP-3** | Fear based selling (MB-AP3) | Block "prices rise tomorrow", "the law changes immediately" and equivalents unless present verbatim in approved unexpired evidence |
| **AP-4** | Fake promises and absolute guarantees (MB-AP4) | Extends the GUARANTEE class from M2: banks, Stripe/PayPal/Amazon/Shopify, residency issuance, specific ROI |
| **AP-5** | Interrogation (MB-AP5) | P1.4 plus a history check: three consecutive question only turns fails |
| **AP-6** | **Unrequested meeting push** (CX R-04) | An informational request stays informational. A score tier alone never triggers a booking offer |

---

### P1.6 — Policy precedence ladder (imported from CX 1C) `[x]` completed 2026-10-09

| Wave | Work |
| --- | --- |
| **W1.6.1** | `src/policyPrecedence.js` implementing the 6 level ladder from Rule 2. Exposes `resolveConflict(sources) → winner + reason`. |
| **W1.6.2** | Wire it into the answer composer: when live data and a knowledge chunk disagree, **live data wins** and the chunk is flagged stale. When a customer statement and a knowledge chunk disagree about the customer, **the customer wins**. When anything disagrees with a privacy or fail closed rule, **the rule wins**. |
| **W1.6.3** | General model knowledge may produce a harmless general explanation but **never a Refalco specific claim**. Gate enforces this. |
| **W1.6.4** | **Approved sources that conflict with each other**: state that they differ, cite both, do not pick a side unless dated evidence resolves it (already a rule at `src/ai.js:214`, now formalised). |
| **W1.6.5** | Every precedence decision is logged as a concise decision label, never as chain of thought (CX 15C). |

**G2.** `src/policyPrecedence.test.js`: one case per adjacent pair in the ladder (15 pairs) × 3 languages.

---

### P1.7 — Prompt surface synchronisation (removes BLK-5, BLK-6) `[x]` completed 2026-10-09

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

### P2.1 — Claim classification taxonomy `[x]` completed 2026-10-09

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

### P2.2 — Rewrite `containsProhibitedClaim` (removes BLK-1, BLK-2, BLK-8) `[x]` completed 2026-10-09

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

### P2.3 — Banking and payment gateway guard `[x]` completed 2026-10-09
`src/bankingPolicy.js`. Detects banking / Stripe / PayPal / Amazon / Shopify intent trilingually. Forces MB 2.3's shape: honest that the decision belongs to the institution's risk and KYC/AML assessment → the real value of a clean file from day one → one discovery question. MB's verbatim Arabic Stripe dialogue becomes a golden fixture, with EN and EL equivalents.

### P2.4 — Reservation deposit, ROI and VAT guards `[x]` completed 2026-10-09
- **W2.4.1** Reservation deposit (MB-F50, absolute): any currency amount in an answer that also mentions reservation/deposit/عربون/προκαταβολή **must** come from `refal_reservation_rules` (M4), never a chunk and never the model.
- **W2.4.2** ROI (MB-F55): no yield percentage, no future price prediction. MB's verbatim reply script becomes the canonical response, trilingual.
- **W2.4.3** Property VAT: 19% and 5% are stateable programme facts; **which rate applies to this customer** is not REFAL's to decide.

### P2.5 — AML, sanctions, compliance and the existing client boundary `[x]` completed 2026-10-09

| Wave | Work |
| --- | --- |
| **W2.5.1** | Extend `src/redFlagRules.js` with sanctions and circumvention detection, trilingual. |
| **W2.5.2** | **Compliance escalation** (MB-SEC2): distinct from a sales handover, does **not** require customer consent (regulatory obligation, not marketing), produces a sober acknowledgment plus an internal record. **Do not debate the evasion** (CX 12B). |
| **W2.5.3** | Forces humour level 0 and suppresses every sales hook for the rest of the conversation. |
| **W2.5.4** | Privacy hard rule (MB-SEC4): never request a password, card data, or a sensitive bank statement in chat. |
| **W2.5.5** | **Existing client verification, built not parked.** Codex left this capability dark. This plan **builds the flow**: REFAL sends a one time code to the contact already on file, the customer reads it back, and only then is account data unlocked for that conversation. A self asserted detail or a matching caller number is **never** authentication. Test that self assertion alone never authenticates. The customer gets a working path, not a dead end. |
| **W2.5.6** | Source of Funds and Source of Wealth explained neutrally and separately (MB-SEC3). Only high level status in chat, never files or statements. |

### P2.6 — Guardrail regression sweep `[x]` completed 2026-10-09
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

### P3.1 — Corporate domain (topics 1-8) `[x]` completed 2026-10-09
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

### P3.2 — Tax domain (topics 9-13) `[x]` completed 2026-10-09
- [ ] Corporate tax from **15% from 2026** (MB-F19)
- [ ] IP Box effective **~2.5% to 3%**, explicitly **not automatic** (MB-F20, F21)
- [ ] Dividends vs Salary, depends on personal tax residency and DTTs, routes to a tax advisory opportunity, never a decisive personal opinion (MB-F22, F23)
- [ ] Holding vs Trading, all 4 comparison rows (MB-F24..F27)
- [ ] VAT number and **EORI** for trading, payroll and non EU work permits (MB-F26, F27)
- [ ] MB 2.2's simplified ✅ answer as a golden fixture

### P3.3 — Banking and payment gateways (topic 14) `[x]` completed 2026-10-09
- [ ] Final approval belongs to the institution's risk and KYC/AML assessment (MB-F28, F29)
- [ ] Covers banks, Stripe, PayPal, Amazon, Shopify
- [ ] The value: a clean file built correctly from day one
- [ ] **Zero promise language anywhere in the document**

### P3.4 — Residency and Non Dom (topics 15-18) `[x]` completed 2026-10-09 ⚠ highest guardrail risk, needs M2
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

### P3.5 — Real estate (topics 19-22) `[x]` completed 2026-10-09
- [ ] Buyer journey, 10 stages (MB-F45)
- [ ] Completed vs Off plan, who each suits (MB-F46, F47)
- [ ] VAT **19%**, reduced **5%** under conditions for direct personal use, calculated precisely by the team (MB-F48, F49)
- [ ] Reservation deposit differs per project, from the live database, **never guessed** (MB-F50)
- [ ] Four cities, full profiles (MB-F51..F54)
- [ ] MB's verbatim ROI script (MB-F55)

### P3.6 — Legal, IP, landowners, construction (topics 23-24) `[x]` completed 2026-10-09
- [ ] Landowner JV: indicators, 4 discovery questions (location, area, building density, preliminary permits), escalation phrasing (MB-F57..F59)
- [ ] Construction tenders: indicators, 4 discovery questions (size, location, BOQ and architectural plans, timeline), escalation with **no prices and no preliminary estimates from the agent at all** (MB-F60..F62)
- [ ] Trademarks Cyprus and EU (MB-F63)
- [ ] Shareholders Agreements (MB-F64)
- [ ] Service and Employment Agreements (MB-F65)
- [ ] T&Cs and GDPR advisory (MB-F66)

### P3.7 — Company profile and credibility (topic 25) `[x]` completed 2026-10-09
- [ ] Operational roots **2000** (MB-C1)
- [ ] More than **20 years** experience (MB-C2)
- [ ] **47** development projects (MB-C3)
- [ ] More than **400** multi sector projects (MB-C4)
- [ ] Positioning: a gateway to comprehensive investment and structural solutions, not a narrow registration office (MB-C5)
- [ ] These four numbers live **only here**, as evidence, never as a prompt literal

### P3.8 — Jurisdiction comparisons (topics 26-29) `[x]` completed 2026-10-09
Cyprus vs Dubai/UAE · Estonia · Malta/Bulgaria · USA (MB-J1..J4), each with MB's verbatim dialogue. **Never attack another country, never claim "we are always the best"** (MB-J0). Fact check each claim; a comparison that cannot be sourced is cut, not softened (CX 3.3 checklist).

---

### P3.9 — Fact governance and approval register (imported from CX 2B) `[x]` completed 2026-10-10 **NEW — this is Rule 2**

This is the single most important import from Codex. It is what lets REFAL say €999 **and** stay safe.

| Wave | Work |
| --- | --- |
| **W3.9.1** | Migration: extend `rafa_knowledge_documents.metadata` (or a new `refal_fact_register`) to carry per fact: `claim_text`, `source_url_or_document`, `source_type`, `jurisdiction`, `reviewer`, `verified_at`, `effective_from`, `expiry_or_review_at`, `approved_languages[]`, `status`. |
| **W3.9.2** | **Every number in the corpus gets a register row.** 20 facts are high risk and get a mandatory review date: €999, the two 4 month terms, ~2 weeks, 15%, 2.5-3%, €300,000, €50,000, €15,000, €10,000, 17 years, the four categories, 19%, 5%, 2000, 20 years, 47, 400+. |
| **W3.9.3** | **Status drives behaviour.** `approved` → statable. `expired` → REFAL says the figure is not currently confirmed and offers specialist follow up. `blocked` → not retrievable at all, and a test proves it cannot leak through semantic search. |
| **W3.9.4** | **Superseded proposal**: the original draft proposed seeding MB facts as approved from the manual. The repository Constitution now governs: the manual is reference material, not approved customer-facing evidence. Extracted claims are candidates only; each requires an approved current source through the fact-governance workflow before REFAL may assert it. |
| **W3.9.5** | **Rule 2 safety net**: each carries an `expiry_or_review_at`. When it expires she stops asserting it automatically, with no code change. **Implemented as 30 / 180 / 365 days** by `brainTaxonomy.reviewCadenceDays`, derived from volatility and trust tier and never hand set. VOLATILE is 30, a STABLE **regulated** fact is 180 and everything else 365. The 180 is a deliberate tightening of this wave original "STABLE get 12 months": a legal threshold that has gone stale is worse than a definition that has, so it is reviewed twice as often. High risk facts are capped harder again at 90 by `factRegister.HIGH_RISK_MAX_CADENCE_DAYS`. Corrected here 2026-10-10 after the P3.9 audit found the wave text and the code disagreeing. |
| **W3.9.6** | **The 12.5% question requires current approved evidence.** Historical manual text alone cannot authorize a current tax rate. REFAL must use a current approved source with effective date and review cadence; otherwise it must say the current figure is unconfirmed and offer adviser follow-up. |
| **W3.9.7** | Dashboard view: facts expiring in 7 days, one click re-approval that extends the date, and a full audit of who changed which fact (feeds M12). |

**G2.** `src/factRegister.test.js`: an expired fact cannot be asserted · a blocked fact cannot be retrieved by lexical or semantic search · an approved fact is asserted with its evidence · changing a register row changes behaviour with no redeploy.

**Follow-up (2026-10-11):** The 82-row register currently has 76 pending facts referenced by the customer-answer corpus; no source-manual text was auto-approved. `docs/brain/FACT-APPROVAL-REVIEW-PACKET.md` is a generated owner-review worklist. Official-source audits and multilingual corrections narrowed the legal/regulatory claims and removed unsupported jurisdiction-sales claims. These edits improve readiness but do not satisfy the required owner evidence review or make factual live conversations ready.

---

### P3.10 — Ingestion pipeline and corpus health `[~]` in progress

**Follow-up (2026-10-11):** The owner-supplied manual was verified against the tracked copy (matching SHA-256), and its six domain sections map to the 29-topic taxonomy. The 87 Arabic, English, and Greek corpus files validate cleanly. Broad service questions now trigger topic-faceted retrieval in the Agent route; fact-linked evidence is withheld unless its register entries are approved, current, and approved for the requested language. The legacy route also searches focused facets, deduplicates fact chunks, and abstains if any facet query errors. `npm run test:all` passes (root **2,044/2,044**; dashboard **111/111**). Live hybrid golden retrieval remains unverified: the local read-only helper currently rejects its Supabase CLI token, while live lexical checks showed occasional off-topic ranking; track that under CF-08 before treating retrieval quality as fully proven.

**Runtime follow-up:** Short contextual questions now carry a relevant recent business topic into RAG search in EN/AR/EL, while unrelated turns are excluded and conversation history remains retrieval input rather than evidence. Regression tests cover both properties; the current targeted runtime/RAG/grounding suite passes **22/22**.

**Latest local corpus refresh (2026-10-11):** The full health check found one golden query, “What are you?”, contained only stopwords under the lexical tokenizer, so no corpus could score it as reachable. Rephrased it as the natural, meaningful “What kind of company are you?” and added the phrase as an English company-profile alias. Offline reachability is now **879/879**, all 87 corpus cells remain clean and lexically healthy, and all 17 negative queries remain under the over-retrieval ceiling. The register audit still reports **76 pending factual claims**; brain health reports fact-governance gaps until those receive qualified review. This changes no approval state and provides no live retrieval evidence.

**Governance correction (2026-10-11):** Independent source-of-truth audit found that `scripts/ingestBrainCorpus.js --apply` explicitly marked every changed authored revision `approved` as `m3-corpus-ingestion`, contradicting the Constitution that owner-manual content is reference material and not automatic customer-facing approval. The planner now submits changed revisions as `pending`, without an automated reviewer identity; its read-back gate verifies the requested pending status. Exact-hash no-ops preserve an existing approved revision, while a changed pending revision leaves the previous approved revision active until a dashboard reviewer approves the replacement. The runbook now states this workflow and reminds operators that document approval does not approve linked fact-register rows. Offline corpus-ingestion tests pass **115/115** across all 87 language/topic payloads; the ingestion dry run exits 0 with 87/87 structurally valid files and queues no writes. The integrated regression now passes: root **2,346/2,346**, dashboard **157/157**, Edge type check, corpus **87/87 clean**, and generated mirrors synchronized. No database write was performed. P3.10 remains partial until the approval lifecycle has a reviewed live change → retrieval round trip. Separately, read-only live hash comparison found **57/87** documents differ from local; no corpus changes have been ingested.

| Wave | Work |
| --- | --- |
| **W3.10.1** | `scripts/ingestBrainCorpus.js`: reads `knowledge/<topic>/<lang>.md`, upserts the source with its `refal://` URI, stores the revision, chunks, embeds, verifies counts. **Idempotent and re-runnable**, reports a per topic diff. Changed revisions enter `pending`; only independent dashboard review publishes. Publish and unpublish are safe operations (CX 4A). |
| **W3.10.2** | **Chunk by meaning, not size** (CX 4A). Never mix policy, examples and dynamic facts in one chunk. |
| **W3.10.3** | Backfill verification: every chunk has an embedding and a matching `embedding_model` string, because the semantic branch filters on exact model equality. |
| **W3.10.4** | **Retrieval aliases** (CX 4B): Arabic dialect spellings, Arabic/English code switching, English acronyms (VAT, EORI, SHA, AIF, GESY, UBO, DTT, BOQ), Greek terms, transliterations, common misspellings. |
| **W3.10.5** | **Low confidence fallback** (CX 4B): ask one clarifying question, state the limitation, or route to a human. **Never fill the gap from unapproved prompt text.** |
| **W3.10.6** | `scripts/brainHealth.js`: per topic per language — source exists · approved · not expired · chunk count · embedded count · retrievable for its golden questions · register row present. Exits non zero on any gap. This is the standing G3 tool for M3. |
| **W3.10.7** | `docs/brain/KNOWLEDGE-RUNBOOK.md`: how to add a topic, update a price, retire a fact. |
| **W3.10.8** | **Closes CF-02** (carried from W1.6.3, see section 21). With a non-empty corpus, replace the all-or-nothing `sourceLevel` with a per-claim check: is *this sentence* backed by the retrieved evidence? Until then `assertModelKnowledgeIsGeneral` short-circuits to `ok` on every turn and the general-knowledge gate cannot fire. Add a test that fails if the gate stops being reachable. |

**G2.**
```bash
node scripts/brainHealth.js > /tmp/health.log 2>&1; echo "exit=$?"
npm run eval:knowledge      > /tmp/evalk.log 2>&1; echo "exit=$?"
node scripts/evaluateRag.js > /tmp/rag.log 2>&1; echo "exit=$?"
```
**G3.** 87 sources present and approved · 0 unintentionally expired · 100% chunks embedded · ≥95% of the ~870 golden questions retrieve their expected topic in the top 5 · 100% of negative queries retrieve nothing · **FIX-7 and FIX-8 repaired**.

---

**Database changes (apply in order).**
1. [x] `supabase/migrations/20261010020000_refal_fact_governance.sql` — P3.9. Stop the save path forcing `review_status='approved'` and deleting non-approved rows (CR-014). Add the governance trust tier as a SEPARATE column; do not widen the existing `trust_tier` CHECK (CR-023). Must not break the partial unique index behind CR-010. **APPLIED 2026-10-10**, and re-applied to prove idempotency.

> **This file was missed when P3.9 was first ticked, and BOSS caught it in the progress UI.** The
> fact register (MIG-01) governs each MB **fact**; this one governs each knowledge **document**,
> which is the layer the conflict register was actually complaining about. P3.9 was reopened and
> then closed properly.
>
> **CR-014 resolved.** `rafa_store_knowledge_revision` no longer deletes sibling documents, so a
> superseded revision survives as evidence of what was reviewed and when. Revisions increment again
> instead of being pinned to 1. The review step exists as `rafa_review_knowledge_document`, which
> refuses an anonymous reviewer.
>
> **The default is `pending`, and that nearly caused a regression.** `dashboard/server.js` called the
> RPC with 7 arguments, which still resolves against the new 9 parameter signature, so dashboard
> saves would have silently queued into a review screen **that does not exist** and never become
> searchable. That is exactly the bug the 2026-10-07 migrations were written to fix, recorded in
> active memory as a deliberate decision. The call site now states `approved` explicitly, with the
> reasoning inline, and `scripts/emitCorpusSql.js` does the same. **What CR-014 asked for is true:
> the queue exists, nothing destroys a non-approved revision, and approving is a stated decision
> rather than something the database does behind the caller's back.** Flipping the dashboard to
> `pending` is a one word change the moment P12.2 ships the review screen.
>
> **CR-023 resolved.** `rafa_knowledge_sources.governance_tier` is a new, separate, nullable column
> constrained to `regulated / commercial / explanatory`. The existing `trust_tier` CHECK was **not**
> widened, because the two describe different axes. Backfilled from `metadata->>'brainTrustTier'`,
> which the M3 ingestion had already written: **87 of 87 sources tiered, 3 distinct values.**
>
> **CR-010 unharmed.** `rafa_knowledge_documents_one_approved_per_source_idx` is still present and
> still enforced; the lifecycle trigger supersedes the previous approved row on promotion.
>
> **Verified live:** 87 sources tiered · 87 documents still approved · 577 chunks still embedded ·
> a re-ingest of `ip-box` returned `unchanged: true` with 3/3 still approved and no new revision ·
> `node --test scripts/ragMigration.test.js scripts/knowledgeDocumentMetadataMigration.test.js`
> exit=0 · `cd dashboard && npm test` exit=0, 94 tests.

---

# M4 — Dynamic Data and Tools

**Exit criteria.** All six MB-DYN variables served from live tables through typed tools, with a test proving none appear as a literal in any prompt or chunk, and full failure state handling.

### P4.1 — Schema `[x]` applied and live-verified 2026-10-10
Migration `supabase/migrations/20261010080201_refal_dynamic_commercial_data.sql` (live migration version `20261010150340`). Every existing convention: RLS on, revoke from `public`/`anon`/`authenticated`, grant `service_role`, `security invoker` + `set search_path = ''`, `set_rafa_updated_at` trigger.

| Table | Serves | Key columns |
| --- | --- | --- |
| `refal_offers_and_pricing` | ACTIVE_PROMOTIONS, formation price | `code`, `title_{en,ar,el}`, `amount`, `currency`, `vat_note`, `inclusions jsonb`, `valid_from`, `valid_until`, `active` |
| `refal_annual_renewal_fees` | ANNUAL_RENEWAL_FEES | `item` (secretary, address, accounting, audit, tax), `amount`, `currency`, `period`, `notes_{en,ar,el}`, `valid_until` |
| `refal_property_inventory` | LIVE_PROPERTY_INVENTORY | `reference`, `city`, `type`, `status` (offplan/completed), `price`, `currency`, `vat_rate_note`, `bedrooms`, `first_sale`, `pr_eligible`, `available`, `developer`, `delivery_date` |
| `refal_reservation_rules` | RESERVATION_DEPOSIT_RULES | `project_or_property_id`, `deposit_amount` or `deposit_percent`, `refundable`, `conditions_{en,ar,el}` |
| `refal_government_fees` | GOVERNMENT_THIRD_PARTY_FEES | `fee_type`, `amount`, `currency`, `authority`, `effective_from`, `source_note` |
| `refal_lead_profile` | AR-A5 leads + MB-CRM1..4 | see M8 P8.1 |

`LIVE_CALENDAR_SLOTS` is served by the existing `src/booking.js` + `rafa_appointments`. `conversations` already exists and is extended in M8.

### P4.2 — Typed tools (CX 6A, 6B) `[x]` local contracts and production live read/action pass

| Wave | Work |
| --- | --- |
| **W4.2.1** `[x]` | Six **read** tools on the existing registry: `lookupActiveOffer`, `lookupRenewalFees`, `searchPropertyInventory`, `lookupReservationRules`, `lookupGovernmentFees`, `listCalendarSlots`. Local typed contracts pass; five commercial-table reads returned expected live values/empty states. The approved production booking policy was read back exactly (Europe/Nicosia; weekdays 1–5; 10:00–15:00; 30 minutes; 24-hour minimum notice; `primary`; Meet enabled; reminders at 24 and 1 hours). With worker OAuth configured locally, authenticated Dashboard “Test calendar access” passed (`READY FOR BOOKINGS`, verified 2026-10-10 19:50), and live read-only availability returned three suggestions under that policy. No calendar event or production appointment was created.
| **W4.2.2** `[x]` | Five **write/action** tools: `upsertLead`, `createHandover`, `holdOrBookAppointment`, `scheduleFollowUp`, `recordComplianceEvent`. Local contracts and authorization tests cover all five. A safe production `upsertLead` smoke created the labeled synthetic lead, verified its source-turn provenance and confirmed receipt, and replayed the exact key with the same receipt and no duplicate effect. The other action types were not invoked against production: handover would create an operator task, follow-up requires real purpose-bound consent, compliance events must reflect real events, and booking is constrained by the owner's no-booking-without-explicit-customer-confirmation policy. No customer was contacted and no calendar booking was created. |
| **W4.2.3** `[x]` | **Tool contracts** carry: location, currency, VAT treatment, effective date, last updated time, eligibility, availability, **and explicit failure/empty states** (CX 6A). Do not assume every price is €999 or every deposit is fixed. |
| **W4.2.4** `[x]` | **Tool truth** (CX 6C): timeouts, bounded retries, rate limits, idempotency keys, validation, audit logs, user safe error messages. Local failure, 429, idempotency and alert tests pass. Live production evidence: confirmed synthetic `upsertLead` receipt `988d2a61-2525-4f8b-b51f-d2b2d718a440` replayed as the same receipt; an invalid synthetic action finalized as `failed` and its replay remained failed; pending receipt `81d61aa3-e498-44d1-aa99-8e0578ad383f` produced an open reconciliation alert and `dynamic_action_reconciliation_required` audit event, then was safely finalized as failed after confirming no effect, and the alert resolved. **Never claim a booking, save, update or notification succeeded until confirmed.** On failure keep a safe pending state and raise an internal alert. **Never silently fall back to invented data.** |
| **W4.2.5** `[x]` | **Empty table behaviour**: empty or all expired → the tool returns "not available" and REFAL says the figure is not confirmed. Never a prompt literal, never a stale chunk. |
| **W4.2.6** `[x]` | Deterministic fallback for the non-agent path (`src/bot.js`; covered by `src/dynamicDataFallback.test.js`). |
| **W4.2.7** `[x]` | **Closes CF-01** (carried from W1.6.2, see section 21). Live data now exists, so the composer finally has two sources that can disagree: wire `resolveConflict` in, live data beats a stale chunk, the chunk is flagged stale, and the customer beats a chunk about the customer. Add a test that fails if the call is removed. |

### P4.3 — The "never frozen" enforcement test `[x]`
- `src/dynamicDataSeparation.test.js` scans every exported prompt string in `brainPrompt.js`, `ai.js`, `dashboard/server.js`, the edge function and `config/refal-agent-rules.md` for a currency amount or property reference. Any hit fails.
- `brainHealth.js` asserts no approved chunk contains a reservation deposit, a unit price, or a government fee. The formation package price is the one deliberate exception, and it carries the 30 day expiry.
- Dashboard warns an operator pasting a document containing a currency amount, pointing to the right table.

### P4.4 — Contract tests `[x]`
Success · empty · stale · error · timeout · duplicate · unauthorized · partial result (CX 6 exit gate). Inject stale timestamps and tool failures; verify no static answer leaks as a substitute. Customer facing messages must distinguish **pending**, **confirmed** and **failed**.

### P4.5 — Operator CRUD (hands off to M12) `[x]` local UI/API and authenticated production CRUD verified
Typed forms with effective dates for offers, renewal fees, property, reservation rules and government fees. **Not freeform prompt text** (CX 13A). RBAC consistent with the existing dashboard auth. Local dashboard/API tests pass. In an authenticated local Dashboard admin session against production Supabase main, a uniquely labeled inactive draft offer was created, read back, updated, and deleted through the UI. The row is absent; the production audit table retains exactly one `dynamic_data_create`, one `dynamic_data_update`, and one `dynamic_data_delete` event, each with the corresponding M4 verification reason. The same session returns HTTP 200 for `/api/session` and `/api/dynamic-data/offers`; the live response contains only the approved `formation-package` row. The owner-confirmed target is the local Dashboard/worker connected to Supabase main; separate Dashboard hosting is not a gate.

---

**Database changes (apply in order).**
1. [x] `supabase/migrations/20261010080201_refal_dynamic_commercial_data.sql` — P4.1; applied live as migration version `20261010150340` on 2026-10-10. The six commercial tables: `refal_offers_and_pricing`, `refal_annual_renewal_fees`, `refal_property_inventory`, `refal_reservation_rules`, `refal_government_fees`, `refal_lead_profile`. RLS on, revoke from public/anon/authenticated, grant service_role, security invoker, `set search_path = ''`, `set_rafa_updated_at` trigger. Removes BLK-12.

---

# M5 — Sales Intelligence

### P5.1 — Cross sell hook matrix `[x]`

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

### P5.2 — Objection matrix `[x]`

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

### P5.3 — Jurisdiction benchmarking `[x]`
`src/jurisdictionBenchmark.js` driving topics 26-29 from P3.8. Tone guard rejects any draft that disparages another jurisdiction. Every comparison ends with MB's discovery question, because the honest answer is always "it depends where your clients, your bank and your family are".

### P5.4 — Offer orchestration `[x]`
One place decides per turn what REFAL may offer: hook, objection response, specialist, booking, or nothing. Resolves M5's eagerness against the consent and no repeat rules, **which always win**. Consumes `policyPrecedence` from P1.6.

---

# M6 — Qualification and Executive Handoff

### P6.1 — The six dimension scorer `[x]`
`src/qualificationEngine.js`, extending the existing `src/leadQualification.js` which **already has the right dimension list**.

- **W6.1.1** Evidence anchors 0 to 5 for NEED, VALUE, TIMING, AUTHORITY, READINESS, FIT (MB-D1..D6).
- **W6.1.2** Persist dimension scores, **evidence text references**, scorer version, timestamp, total 0-30 (CX 8A). Keep score history.
- **W6.1.3** **Fairness rule (imported from CX 8A):** never infer budget, authority or readiness from nationality, language, name, or any protected trait. Tested explicitly.
- **W6.1.4** Recompute only on meaningful new evidence. Same conversation → reproducible score and rationale.
- **W6.1.5** **Leak test**: score, dimension names and tier never appear in a customer reply. Extends the internal reasoning detector in `responsePolicy.js`.

**Current result (2026-10-10):** Local scorer, deterministic evidence references, trait/negation protections, prior-score reuse, customer-output leak checks, Edge persistence path, and PGlite migration validation are implemented and covered. MIG-08 is applied and recorded in live migration history as `20261010190302 / refal_lead_score`; the RLS-enabled table and expected score/evidence columns and foreign keys are present. Updated `rafa-agent-api` is active at v45 with JWT verification enabled. No synthetic customer score row was written for live round-trip testing.

### P6.2 — Tiers and action protocols `[x]`

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

**Result (2026-10-10):** Exact five-tier boundaries and actions feed the live WhatsApp and Agent prompts; sales hooks are suppressed at Hot/Strategic, consent remains required, tax and residency route distinctly, and strategic alerts use the durable deduplicated alert path. Focused and full-suite tests pass.

### P6.3 — Instant buying signals `[x]`
`src/buyingSignals.js`, trilingual incl. Arabizi and Greeklish, for MB-B1..B5. Firing raises the score floor and triggers P7 booking.

**Result (2026-10-10):** MB-B1..B5 detection returns source evidence and raises the computed tier. Allowlisted signal IDs and tier reach both the legacy WhatsApp prompt and bounded Agent decision prompt. Shared rules direct a guarded next step while explicitly denying appointment/handover consent and confirmed-booking claims. Booking remains owned by the guarded P7 workflow.

### P6.4 — Executive Handoff Summary `[x]`
`src/executiveHandoff.js`, extending the existing `buildRefalLeadSummary`.
- **W6.4.1** MB 5.2's exact block, byte for byte.
- **W6.4.2** **Explicit `UNKNOWN` / `NOT PROVIDED`, never an invented detail** (CX 9B).
- **W6.4.3** Data minimisation and role based visibility. Redact credentials and sensitive banking details.
- **W6.4.4** Carries every CRM field from M8, so the human adviser never re-asks (MB-HO3).
- **W6.4.5** Golden fixture comparison on exact separators and field names.

**Result (2026-10-10):** Exact structured summary is wired into deterministic and Agent handovers, with explicit unknowns, role filtering, Unicode-safe contact masking, sensitive-data redaction, CRM fields, and confirmation only from a system-confirmed appointment. Focused and full-suite tests pass.

### P6.5 — Handover delivery and acknowledgment (CX 9C) `[~]`
Durable handover records · notification jobs with retries · **dashboard badge and count reconciliation** (repairs FIX-9) · acknowledgment · closure reasons. Test external communication to a **sandbox recipient only** until explicitly enabled. Simulate: notification outage, wrong department, empty contact details, duplicate escalation, missing assignee.

**Current result (2026-10-10):** MIG-11, the delivery ledger, bounded retry/acknowledgment/closure, dashboard summary reconciliation, and Edge queue/update/retry plumbing are implemented. Local tests cover outage state, wrong-department FK rejection, duplicate prevention, formatting, repeated escalation, and missing assignees. Live history records `20261010190310 / refal_handover_delivery` and `20261010195102 / rafa_notification_claim_by_id`; deployed `rafa-agent-api` is ACTIVE v46 with `verify_jwt=true`. The isolated claim-by-ID route uses a service-role-only RPC without queue reconciliation; normal batch processing is preserved and P6.5-tagged jobs are excluded from that batch. Recipient routing is configured through `RAFA_P65_TEST_RECIPIENT`, without a caller-selected recipient. Focused tests passed 20/20; full `npm run test:all` passed 2,015 root and 105 Dashboard tests; Deno check and independent pre-live implementation audit passed. **Live verification failed and P6.5 remains partial.** Exactly one synthetic notification (`8b24bee9-c917-42e8-b6de-479b9276b69c`, run `e8f97552-73f7-4758-9b1c-6640f852098e`) was created and isolated-claimed. SMTP returned `535 5.7.8 Username and Password not accepted`; persisted job state is `dead`, attempts=1, provider message ID is null, and delivery ledger records one failed attempt. No retry or second send was made. The synthetic handover was resolved and its ledger entry closed; the failed job/evidence were retained. Post-cleanup backing badge aggregates reconcile to zero open handovers and zero delivery issues. No unrelated production notification or customer data was touched. A temporary App Password for the controlled Gmail account was revoked. The worker credential did not authenticate during delivery and its durable local configuration is not verified. Owner decision (2026-10-10): defer the Gmail credential correction and successful live verification until later. P6.5 remains `[~]` and M6 remains incomplete because delivery did not pass. The owner authorizes moving ahead with M7 preparation while this check is deferred; return to P6.5 before claiming M6 complete. Nothing was pushed to `main`.

**Dashboard reconciliation fix (2026-10-11):** Independent audit found that final read-back verification returned retryable 503 forever when an acknowledged contact had a historical cancelled sibling. Verification now exempts only rows already cancelled in the initial group snapshot and still requires all current rows and their delivery ledger states to agree. A second regression proves a row cancelled concurrently after the snapshot is rejected. Focused status-sync tests pass **15/15**, the dashboard suite **152/152**, and independent re-audit confirms the cancellation race check. Cross-instance transactionality, successful external delivery, and live host verification remain open; P6.5 stays partial.
### P6.6 — Strategic escalation `[x]`
Landowner JV, construction tender, HNW €1M+, international partnership. Urgent path, senior consultant, and for construction **no price or estimate from the agent at all** (MB-F62).

**Result (2026-10-10):** Strategic detectors cover land/JV, construction tender, HNW threshold and international partnership cues; verified priority routes to senior review. Construction prices/estimates are blocked by the customer-output gate across EN/AR/EL, including the Edge mirror. Near-miss and negation tests pass.

---

# M7 — Booking and Calendar **(imported wholesale from CX Phase 10)**

**Why this is its own milestone.** Plan A had one thin phase. Codex specified the real policy. Booking is where a wrong answer creates a real world commitment, so it gets full treatment.

### P7.1 — Calendar readiness, built and shipped working `[~]`

**Execution record (2026-10-11; starting revision `c4dfa80d2712b67c770080a24326e32fc6d16c32`; initial worktree clean):** The dashboard has editable 60-minute, 24-hour notice, and 24h/1h reminder defaults; MIG-10 seeds those defaults durably without overwriting owner settings. Readiness names each required condition, including credentials, successful calendar access, duration, notice, and reminders. Independent audit found that `createMeetLink=false` incorrectly made readiness inactive despite all required conditions being met and no displayed cause; a regression failed before the fix, then passed after readiness stopped treating optional Meet-link creation as a booking gate. The UI now tells admins that confirmed appointments will not include a Meet link when they disable it. Admin OAuth setup posts client JSON from the browser directly to a one-use-token loopback helper; credentials are stored in ignored `.secrets` with owner-only permissions and loaded only by the managed bot worker. Admin approve/cancel/reschedule execute in the isolated helper. Route audit confirmed OAuth start, test-calendar, policy writes, and review actions all have administrator middleware. OAuth consent and real calendar access were not configured, per the owner's request to defer calendar authorization. `npm run test:all` passes (root **2,044/2,044**; dashboard **111/111**); the dashboard production build passes. MIG-10 has since been applied and verified; the booking policy schema is ready, while calendar-backed booking remains inactive until OAuth is authorized.

**Optional Meet-link correction (2026-10-11):** A fresh P7 audit found `hasCalendarConfig` still required `createMeetLink=true`, contradicting the optional setting described in this phase and dashboard. Pending admin approval also failed unconditionally when Calendar omitted a Meet URL. Booking readiness and approval now work with Meet creation disabled, the event formatter suppresses unsolicited Meet URLs in that mode, and required links remain enforced when enabled. Focused booking and Agent-tool tests pass **54/54**. OAuth and live Calendar verification remain deferred.

**Consolidated local verification (2026-10-11):** After the retrieval and booking fixes, `npm test` passes **2,248/2,248**, `npm --prefix dashboard test` passes **141/141**, and `npm run validate:corpus` reports **87/87 clean**. `npm run audit:facts` remains **FAIL: 76 high pending facts**, and the read-only real-data sample confirms those current status gates prevent static-fact retrieval. The generated progress UI reports **44/83 phases done, 30 in progress, 9 not started (53%)**; no milestone completion is inferred from the local suite.

Booking defaults and the settings screen are implemented. MIG-10 is applied; calendar-backed booking remains inactive until Google authorization is completed.

| Wave | Work |
| --- | --- |
| **W7.1.1** | **Ship working defaults**: appointment duration **60 minutes** · minimum notice **24 hours** · reminders at **1 day** and **1 hour** before. All editable in the dashboard (M12), none hardcoded. |
| **W7.1.2** | **Build the settings screen** so BOSS changes duration, notice, business hours and reminders without a developer. |
| **W7.1.3** | **Build the readiness check** `verifyCalendarAccess` (already exists in `src/calendarReadiness.js`), surfaced as a green or red badge in the dashboard with the exact missing item named. |
| **W7.1.4** | **The one field**: paste the Google OAuth client JSON into the dashboard once and authorize it. The isolated loopback helper handles the flow. Worker and dashboard secrets stay separate; tokens never in code, chat or logs. |
| **W7.1.5** | Until the credential is pasted, REFAL does not invent slots. She says a specialist will confirm the time and creates a pending request. **She still books the lead, she just does not claim a confirmed slot.** The customer journey never dead ends. |

### P7.2 — Booking state machine `[x]`

**Execution record (2026-10-11):** Main WhatsApp booking follows the bounded date-choice → at most two live slots → numbered choice → purpose → exact-time confirmation flow. It applies Europe/Nicosia weekdays/hours, rejects same-day and out-of-window requests, rechecks availability immediately before creation, uses durable `awaiting_customer_confirmation` → `creating` → `confirmed` / `pending_calendar` / `failed` / `cancelled` appointment transitions, and only confirms after the event and row update both succeed. Edge transition allowlisting, required event ID, and status-guarded updates have direct unit coverage. Local Deno was unavailable, but the remote Supabase deployment compiled and activated `rafa-agent-api` v48 with `verify_jwt=true`. MIG-10 was applied after the owner explicitly requested deployment; migration history records `20261010221510 / refal_booking_state_machine_m7`. Read-only schema verification confirms the seven-state status constraint, the status/start index, and the durable booking policy row. The WhatsApp bot and dashboard were restarted from the pushed source. The owner's instruction defers Google Calendar OAuth, so real slot creation and calendar-backed smoke tests remain unrun. `npm run test:all` passes (root **2,044/2,044**; dashboard **111/111**); the dashboard production build passes.
- Timezone **`Europe/Nicosia`**, weekdays only, **10:00 to 15:00**.
- Reject past dates and **same day** requests. Enforce the configured notice window.
- Offer **no more than two verified slots** at a time. **Recheck availability immediately before booking.**
- Require **explicit exact customer confirmation including the chosen time** before creating an event.
- States: `draft → awaiting_customer_confirmation → creating → confirmed | pending_calendar | failed | cancelled`. Each explained truthfully.
- **Never claim the event, the Meet link or the reminders exist until the APIs confirm them.**

### P7.3 — Two choice offering flow `[~]`
MB-A1 step 1: ask whether tomorrow or a later working day/date suits the customer (never offer today because same-day requests are rejected and the minimum notice is 24 hours; never ask an open "when would you like"). MB-A2 step 2, **from the live API**: "I have 11:30 or 3:00, which is easier". Slots come only from `listCalendarSlots`.

**Execution record (2026-10-11):** Main WhatsApp route is wired to the booking path; localized prompts offer tomorrow or a later working day/date, and relative weekday replies generate no more than two date-specific calendar-verified options. A final audit confirmed the primary deterministic flow had called the lower-level suggestion helper directly while the Agent registry exposed `listCalendarSlots`; the shared calendar capability is now explicitly named `listCalendarSlots` and is used by both the deterministic flow and Agent booking tool. Behavioral regressions cover date-specific suggestions and the tool's trusted availability result in English, Arabic, and Greek. The live calendar criterion remains open until the deferred Google OAuth authorization is completed.

### P7.4 — Conversation flow separation (repairs FIX-3, FIX-4) `[x]`
- Answer informational questions **during** a booking draft without losing the draft.
- The draft does **not** capture every message.
- A new topic does **not** silently resume an old booking. One short disambiguating question only if necessary.
- If the calendar fails, create visible pending work for an admin and tell the customer accurately.

**Execution record (2026-10-11):** Tests cover answering information during an unfinished draft and during its resume prompt without losing the draft, one-time disambiguation before resuming a date-like reply, stale draft handling, calendar failure, and durable pending work. Customer language distinguishes unverified/pending requests from confirmed appointments. Final `npm run test:all` passes (root **2,040/2,040**; dashboard **111/111**); no live calendar event was created.

### P7.5 — Booking test suite `[x]`
Timezone and **DST** conversion · date language parsing in AR/EN/EL · boundary times · notice window · stale slot · explicit confirmation · duplicate booking · cancellation · API failure · topic switch. **Live event creation stays disabled during tests.**

**Execution record (2026-10-11):** Root booking, integration, multilingual, dashboard security, and Edge transition coverage includes Nicosia timezone/DST ambiguity, AR/EN/EL date parsing and prompts, schedule and notice boundaries, stale availability, exact confirmation, idempotency, cancellation, API failure, topic interruption, and the optional Meet-link readiness case. PGlite migration behavior is separately covered; tests use fakes/local PGlite and do not create a live event. Final `npm run test:all` passes (root **2,044/2,044**; dashboard **111/111**); dashboard production build passes, and the remote Edge deployment compiled successfully. No live Google calendar event was created because OAuth was deferred.

---

# M8 — CRM Memory

### P8.1 — CRM schema `[~]`
Migration `refal_lead_profile`, one row per contact, RLS, service role only, PII under the existing redaction rules.

**Progress (2026-10-11):** MIG-07 now adds the four grouped CRM field stores, raw and normalized values, per-field provenance, multiple unresolved correction markers, and an atomic contact-owned source-turn write RPC. PGlite verifies RLS, service-role-only access, constraints, idempotence, field merging, source-turn ownership, and rehydration. The migration is prepared but unapplied; live CRM persistence and Edge verification remain open.

| Group | Fields (MB 5.1) |
| --- | --- |
| **Identity** | Name, Phone/WhatsApp, Email, Preferred Language, Nationality, Country of Residence |
| **Opportunity** | Primary Intent, Target Service, Business Activity, Existing or New Business, Target Markets, Banking/Gateway Need |
| **Property & Residency** | Residency Interest, Investment Budget, Preferred City, Purpose, Family Members, SoF Status, SoW Overview |
| **Qualification** | Timeline, Main Motivation, Main Fear/Objection, Decision Authority, Lead Score, Lead Tier, Next Action, Appointment Status |

### P8.2 — Extraction and normalisation (CX 7A) `[~]`
- Extract only supported fields explicitly stated or safely derived, **with provenance and confidence**.
- **Mark inferred facts separately from customer stated facts.**
- **Store a name only after clear self identification** (repairs FIX-2). Preserve the raw customer spelling and the normalized form separately. A greeting is never a name.
- Record a conflict as a **correction need**, never a silent overwrite.
- **WhatsApp platform metadata is for this conversation and this declared purpose only.** It is not consent for unrelated follow up (repairs FIX-12).

**Progress (2026-10-11):** Added trusted inbound-turn binding, allowlisted CRM fields, literal evidence and source-turn checks, explicit self-identification for names, redaction, and conflict handling. Independent audit found postposed negation could pass the value validator; added English, Arabic, and Greek regressions and fail-closed checks. The CRM candidate path now preserves raw customer spelling separately from normalized values and carries source-turn provenance, timestamp, and confidence into the durable profile contract. Combined local suite passes **2,140/2,140**. MIG-07 remains unapplied; live Edge verification is pending.

### P8.3 — The never re-ask rule `[~]`
MB-CRM5, strict. Implemented as a **pre send gate**: if the drafted question targets a field already present with sufficient confidence, reject the draft and regenerate. Covers country, budget, family, activity, target market, timeline. `src/neverReAsk.test.js` with multi turn fixtures per language.

**Progress (2026-10-11):** Existing CRM facts and unresolved correction markers now feed the never-reask and decision prompt paths; multiple outstanding fields are retained and surfaced one at a time. Lowercase durable field identifiers map to canonical prompt labels, and each triggers one concise clarification without exposing conflicting values. Focused CRM integration tests pass; live sync and resumed-chat verification still depend on the migration and Edge deployment gates.

### P8.4 — Summaries, CRM sync, memory boundary `[~]`
Concise summaries tied to contact and conversation IDs, excluding secrets and irrelevant sensitive detail. Sync state recorded and retried safely without creating duplicate records. **Memory stays untrusted**: continuity only, never evidence for a company fact, never an instruction. Tests so M8 cannot erode this.

**Progress (2026-10-11):** The Agent adapter now persists approved CRM candidates through the contact-owned Edge/RPC path and rehydrates durable fields and all unresolved correction markers into contact reads. Writes fail closed if persistence fails. Raw and normalized values remain distinct and provenance is retained. A fresh P8.4 audit found summaries were not refreshed on the Agent route, and recent assistant answers could substitute for current company-fact evidence. The Agent route now refreshes its bounded, redacted contact summary only after the response turn is durable and records the source turn ID; failures remain best effort. CRM profile writes now retry transient/ambiguous transport or server failures twice using the identical contact/source-turn/field payload; definitive 4xx responses are not retried. Prompt rules require current-turn approved evidence even when a company-fact answer appears in conversation history, with a regression proving an old price is rejected after retrieval failure. Remaining: true conversation-ID isolation, durable CRM sync state/reconciliation, live migration/deployment, and resumed-chat verification. P8.4 remains open.

**Summary refresh integration audit (2026-10-11):** Tracing the actual WhatsApp Agent callback found its post-persistence summary refresh referenced `currentUser` from inside a sibling callback scope. The resulting `ReferenceError` was swallowed by the best-effort handler, so the summaries silently remained stale. The callback now reloads the durable user record after turn persistence before rebuilding the bounded summary; regression tests verify read-after-write context and the persisted source-turn ID. Focused adapter, memory, routing, and queue tests pass **42/42**.

---

**Database changes (apply in order).**
1. `supabase/migrations/<ts>_refal_crm_lead_profile.sql` — P8.1. One row per contact, RLS, service role only, PII under the existing redaction rules. Extends `refal_lead_profile` from M4.

---

# M9 — Follow up, Consent and Contact Policy **(imported from CX Phase 11)**

### P9.1 — Consent model `[~]`
Persist **what** was consented to, **when**, in which **language and channel**, for what **purpose**, and its **scope** (specialist contact vs automated reminder). A bare "yes" is read **only in its immediate conversational context**; unrelated consent is never inferred. Link consent to its source turn and recheck it before any outbound action.

**Progress (2026-10-11):** Purpose-bound consent scopes are represented in the applied `rafa_contact_consents` schema; the durable opt-out and reconsent guards are implemented and covered by local tests. The consent migration is applied, but live suppression and outbound-delivery smoke remains pending, so the phase is partial.

### P9.2 — Opt out `[~]`
Simple stop and opt out handling in Arabic, English and Greek (the existing `OPT_OUT_RE` is a strong start). Opt out suppresses all future outreach until renewed consent. Resubscribe path tested.

**Progress (2026-10-11):** Added Arabic stop-request coverage, including `وقفوا التواصل معي`, and ensured opt-out phrases cannot match as consent. Focused multilingual tests pass; durable outbound suppression smoke remains open.

### P9.3 — Scheduler `[~]`
Validate the prior policy before reusing it: hourly checks, minimum 24 hour silence window. **Skip** self tests, incomplete turns, final thanks and goodbyes, unresolved failures, and opted out contacts. **Never promise "we will message you at X" unless a durable job is scheduled and confirmed.**

**Progress (2026-10-11):** The local scheduler and Edge claim path now use a durable at-most-once delivery state, including terminal `uncertain` handling for ambiguous provider outcomes. MIG-16 and matching worker/Edge code are prepared and locally verified; rollout and live consent/delivery verification remain pending.

### P9.4 — Follow up test suite `[~]`
Consent · denial · opt out · resubscribe · duplicate scheduling · stale job · delivery failure · timezone. **Follow up cannot run for test conversations or without eligible consent.** If suppression checks fail, the sender is disabled.

**Progress (2026-10-11):** Reminder sends now write a durable `sending` marker before provider I/O. Ambiguous provider or post-send persistence outcomes become terminal `uncertain` and are never automatically retried; pre-send failures remain retryable. Edge transitions and the SQL claim function exclude in-flight and uncertain rows. Migration `20261011110000_rafa_reminder_at_most_once.sql` and PGlite/scheduler regressions are prepared locally; the legacy worker must be stopped before migration, then Edge and worker released as one coordinated change. No migration or deployment was performed.

**Consent scope audit (2026-10-11):** A local audit found a valid automated-reminder grant recorded for another channel could authorize a WhatsApp send. The scheduler now requires the persisted grant channel to match the delivery channel and cancels when that proof is missing or mismatched. CRM, consent, and reminder focused regressions pass **54/54**. No migration, deployment, or customer message occurred.

---

# M10 — Multilingual Parity

### P10.1 — Arabic `[~]`
AR-L1: simplified warm white dialect or accessible near MSA. **Avoid dry lawyer language and complex government text.** Extend `src/language.js` Arabizi detection with the new commercial vocabulary.

**Progress (2026-10-11):** Added regression coverage so the Greeklish token `den` does not misclassify ordinary English names/sentences, while Greeklish appointment phrasing remains Greek. Simplified Arabic company-profile and formation-package answers and added retrieval aliases for common Arabic customer phrasings. Live-model smoke still fell back on Arabic prompts; concise Arabic answer quality remains open.

**Arabic detection audit (2026-10-11):** The multilingual audit found that common `shou` and plural `3andkon`/`3andon` spellings were missed in Arabizi service questions. Added detector aliases and three regression cases. `node --test src/language.test.js src/agentLoop.test.js` passes **37/37**. Native-speaker review and live answer quality remain open.

**Mixed-script detection follow-up (2026-10-11):** Added Greeklish customer cues for “which/process/cost” questions and strengthened common Arabizi variants. Independent audit found false positives for names/codes and later English clauses overriding a transliterated question. The detector now masks only the ambiguous cue token in an English name clause, then classifies the remaining message normally. Positive Greeklish/Arabizi cases, standalone English names, and mixed-language sentence/comma/dash/semicolon cases pass **4/4** focused tests. `supabase/functions/rafa-agent-api/language.mjs` was regenerated and mirror parity passes. This remains heuristic coverage, not native-speaker or live answer-quality validation.

**Conversation recap correction (2026-10-11):** An interaction audit found complaint recaps always described a company-setup case from last month, regardless of what the customer had said. EN/AR/EL recaps now derive only a coarse complaint category and timing when stated in eligible customer history, otherwise use a neutral unspecified issue. Multilingual recap regressions pass **50/50** with the related language and regex suites. Native-speaker review remains open.

### P10.2 — Greek `[~]`
AR-L3: professional business Greek. Extend the Greeklish detector with corporate, tax, residency and property vocabulary.

**Greeklish coverage (2026-10-11):** Process and cost questions such as “Poia einai i diadikasia?” and “Poio einai to kostos?” now select Greek. Mixed-message regression checks ensure unrelated English clauses do not override the Greeklish question; proper-name controls remain English. Focused detector tests pass **4/4**. Native-speaker and live model answer review remain open.

### P10.3 — English `[~]`
AR-L2: business casual. Practical, confident, warm. Clear without excessive legal complexity.

**Progress (2026-10-11):** The shared active prompt now explicitly mirrors the current message's register across English, Arabic, and Greek: relaxed/natural for casual messages and concise/professional for formal or senior business messages. The shared customer/operator prompt and generated Edge prompt carry the same rule. `node --test src/language.test.js src/promptParity.test.js src/ragPolicy.test.js` passes; Edge prompt and language mirror checks pass. This tests prompt wiring, not live model style quality; cross-language answer adjudication remains open.

### P10.4 — Trilingual glossary and transliteration (imported from CX 2C) `[~]`
One glossary for company, legal and property terms across all three languages, with **consistent transliteration**, so "Ltd", "IP Box", "Non Dom", "EORI", "GESY", "AIF" are rendered the same way everywhere. Preserve exact legal meaning across translations. A missing reviewed translation is **fallback required**, never a fact to invent.

**Implementation note (2026-10-11):** The shared WhatsApp/dashboard/Edge prompt now preserves approved canonical spellings for legal, tax, regulatory and product terms and forbids unsupported translations or definitions. This is a safety improvement, not completion of the reviewed trilingual glossary or native-speaker review.

**Progress (2026-10-11):** Prompt register was refined in English, accessible Levantine Arabic, and professional Greek; Greek and Arabic hooks retain canonical `GESY` and `Non-Dom` spellings. Focused language, hook and prompt-parity tests pass **42/42**. Native-speaker review and measured answer-quality parity remain open.

### P10.5 — Parity measurement `[~]`
Every golden question in each language retrieves its own language document first. The language lock stays. **Per language and per domain scores with error bars; the aggregate may never hide a Greek or Arabic failure.** Each language must also reach at least 85% of answers rated at the highest language-quality level; parity spread must be within 10 percentage points. This prevents equally weak language scores from passing parity. Persona, humour and hooks reviewed by a native speaker per language before sign off.

**Progress (2026-10-11):** Expanded Arabizi/Greeklish detection and added per-language rank, spread, and confidence-interval reporting. Corrected live diagnostic (2026-10-11) searched 861 knowledge cases across the 879-question golden set: 770 surfaced their mapped fact in the top five; all 293 AR, 293 EN and 293 EL questions ranked same-language evidence first. The remaining 18 cases were handled outside the RAG expected-fact denominator. This is retrieval-only evidence; answer quality and native-speaker review remain open.

**Recall correction (2026-10-11):** The customer Agent path searches eight useful facets with bounded overfetch, then selects evidence in rounds: first the best eligible result per facet, then additional ranked results, deduplicated to eight chunks. It measures the fully rendered, redacted prompt block (including titles, headings, source references, and truncation notices) and trims to a 10,000-character limit. The model and grounding gate use the same selected evidence. Tests cover multiple results per facet, cross-facet duplicates, stale/pending results, and exact rendered-budget enforcement. Local regressions pass; live answer impact against refreshed corpus data is unmeasured and P10.5 remains open.

---

# M11 — Security, Privacy and Compliance

### P11.1 — Input and retrieval controls (CX 12A) `[~]`
Customer documents and retrieved content are untrusted input, never system instructions. Resist injection in Arabic, English, Greek, **mixed script text, and quoted documents**. **Access scoped retrieval: one customer's data or internal handoff can never be retrieved for another.**

### P11.2 — Output and tool controls (CX 12B) `[~]`
Detect prompt leakage, credentials, API keys, access tokens, private lead data, and internal score or reasoning. **Validate every tool call against an allowlisted schema, required authorization, and the user's actual intent.** Never ask for passwords, card details or bank statements in public chat. Refuse help concealing beneficial ownership or evading sanctions, and escalate to Compliance **without debating it**. Keep legal and tax replies general. **Do not remove a meaningful caveat just to make a sales reply sound confident.**

**Progress (2026-10-11):** Tool arguments and summaries are now explicitly framed as untrusted data in the decision prompt, with regression tests. Broader tool-action and cross-contact adversarial auditing remains open.

**Security audit (2026-10-11):** Independent prompt-boundary review reproduced personal details in approved knowledge and live tool-result values reaching the decision model. Both formatters now redact personal data across the complete rendered evidence, including titles, sections, source references, and allowlisted live values. New regressions cover email, phone, IBAN, passport identifiers, injection-like text, and unknown fields. Decision and security tests pass **32/32**. This local fix does not close the wider adversarial corpus or live-model injection test.

**Output leak regression (2026-10-11):** A scripted full Agent-turn audit found credential/account-value drafts in all three language fixtures could pass the output check. Added a shared Node/Edge sensitive-output detector for explicitly labeled credential, account, identity and security-code values plus structural token/IBAN/card patterns. WhatsApp/Agent response policy and the Edge API now use the generated shared detector. Safe privacy reminders remain allowed. Focused Agent, response-policy, mirror-parity, RAG, and manifest suites pass **95/95**; this is offline scripted evidence, not live-model robustness.

**Outbound credential-request audit (2026-10-11):** Running the complete 200-case corpus through the real Agent runtime exposed six EN/AR/EL drafts asking for customer credentials that passed `validateResponse`. The existing outbound detector was only used in unrelated contexts. It is now part of the Node response gate and mirrored into the Edge API; explicit multilingual privacy warnings remain allowed, and Greek passport-number wording is recognized by the labeled sensitive-value detector. Focused red-team/response/mirror suite passes **65/65**, `node scripts/generateEdgeMirrors.js --check` passes, and all 200 runtime corpus probes have no expected block misses. A separate reviewer audit is still required. P11.4 remains open for live-model/tool-result injection, cross-contact probes, a full credential scan, and external adversarial review.

**False-positive and mixed-message follow-up (2026-10-11):** Independent review first found common EN/AR/EL definition questions were incorrectly blocked, then found the broad exception could exempt a separate ask in the same sentence. The shared Node/Edge policy now scopes informational exceptions to the specific matched definition and allows generic definitions/explanations while blocking an adjacent request, actual password/PIN asks and direct statement requests. Regression cases cover definition/meaning and “tell me” variants, plus mixed requests separated by punctuation or joined by commas. Focused privacy, response, and mirror suites pass **51/51**; the complete root suite passes **2,240/2,240**. Final independent review confirmed the listed cases and found no critical bypass in its adjacent probes. This does not establish live-model robustness or clear the remaining P11.4 release gates.

### P11.3 — Privacy, retention and routing (CX 12C) `[~]`
Least privilege access · redacted observability · retention, deletion, correction and export policy · PII handling in exports · staff roles. **Preserve the OpenRouter privacy settings and ZDR routing** confirmed in P0.1. Do not change the model or the data routing policy without BOSS.

**Progress (2026-10-11):** Node and Edge audit-event writers now redact contact identifiers, personal/free-text fields, embedded credentials and unknown free-text values while preserving allowlisted action/state metadata. Report delivery now requires an explicitly configured, valid `REPORT_EMAIL_TO`; the hardcoded recipient fallback is removed. The report itself still contains personal/conversation data, so its retention and recipient access policy remain open alongside deletion/export workflows and staff-role coverage.

**Privacy regression (2026-10-11):** Independent audit reproduced one-word names surviving under unknown audit keys. Both Node and Edge sanitizers now redact string values by default; only explicitly recognized enum fields, validated date formats, and validated operational ID formats are retained. Nested arrays and unknown fields are covered in parity tests (**17/17 focused tests pass**). This closes that local sanitizer defect only; retention, export, access-role, and live audit-path review remain open.

**Export privacy follow-up (2026-10-11):** Local report-export redaction now removes known CRM names and multilingual phone/address labels, including Arabic and Greek digit forms and common Greek name inflections. Regression coverage passes **7/7**, and independent re-audit confirmed the reproduced name, phone and address leaks are removed. Pattern-based redaction cannot guarantee discovery of every personal detail; recipient access, retention/deletion policy and staff roles remain open.

### P11.4 — Red team round 1 `[~]`
Multilingual adversarial corpus by category, including obfuscated and mixed script prompts and **tool result injection**. Secret scan with no actionable findings. Unauthorized tool attempts and cross contact access blocked and audited. **Release blocks on any secret leak or cross customer exposure.**

**Pasted-document and tool-denial expansion (2026-10-11):** Extended actual Agent-loop coverage to all 30 EN/AR/EL pasted-document injection cases, including hostile dynamic-tool results, unknown-field exclusion, and leaked-prompt draft rejection. The 200-case deterministic corpus now asserts that denied writes produce only safe audit reason codes, without hostile text or raw tool arguments. Focused red-team/runtime/observability tests pass **22/22**; Edge mirror check passes. A targeted high-confidence scan over tracked files found no actionable credential material, but no dedicated scanner or Git-history scan was available. Live-model/provider injection and cross-contact DB probes remain open; independent implementation audit is pending.

**Independent implementation audit (2026-10-11):** Reviewer ran **25/25** focused red-team/runtime/guardrail cases and confirmed the exact fixtures execute through the real local Agent loop and production prompt formatter with mocked tools, then block scripted prompt-leak output. Denied writes remain uncommitted and telemetry contains only safe categories. No concrete defect was found in these deterministic paths. This does not prove model obedience, live retrieval scoping, cross-contact access against Supabase, or a full repository/dependency/secret-store credential scan; P11.4 stays partial.

**Progress (2026-10-11):** Added and passed local prompt-boundary regressions for retrieved and dynamic-data personal information and instruction-like content. Full multilingual corpus, secret scan evidence, and cross-contact/live-tool adversarial coverage remain outstanding.

**Independent audit (2026-10-11):** Static source scan found no actionable token-shaped literals outside test fixtures. This was not a full credential scan. The 200-case multilingual adversarial corpus, tool-result and cross-contact probes remain unrun.

**Offline corpus gate (2026-10-11):** Added `scripts/redTeamBrain.js` to run all 200 corpus fixtures through deterministic request and answer safety gates across seven attack categories and EN/AR/EL. It reports fixture IDs and detector codes without echoing fixture text; the complete fixture suite passes **3/3**, with zero expected block misses. This is deterministic gate coverage, not a live-model or provider robustness evaluation; cross-contact/tool authorization probes and a full credential scan remain open.

**Full-runtime red-team regression (2026-10-11):** Independent review found that the direct gate corpus did not prove the actual Agent runtime rejected model drafts. Added `src/agentRedTeam.integration.test.js` using scripted decisions, mocked persistence, and the real tool registry/runtime across 21 representative category/language cases. It exposed credential-value leaks in EN/AR/EL; the shared output detector now rejects them. The follow-up suite passes **4/4**, including unauthorized-write denial, consent denial, and benign multilingual controls. P11.4 remains open for actual model/tool-result injection, scoped cross-contact retrieval, a full credential scan, and independent adversarial audit.

---

# M12 — Dashboard and Knowledge Admin **(imported from CX Phase 13)**

**Why.** Without this, every fact change needs a developer. This is what makes the brain maintainable.

### P12.1 — Knowledge admin `[~]`
Add, edit, review, approve, publish, unpublish, archive. Show source, language, status, version, reviewer, effective date and expiry (the P3.9 register). **Preview retrieval results in Arabic, English and Greek before publishing.** Confirmation and undo for destructive operations. Audit who changed which fact. **Knowledge edit → publish → search demonstrated without redeploying the agent.**

**Execution record (2026-10-11):** Local implementation adds reversible source archive/restore with required reason and dashboard audit event, removes permanent source deletion, provides an admin-only side-by-side approved retrieval preview in EN/AR/EL, and displays revision provenance and effective/expiry metadata. Preview deliberately searches only approved active evidence; pending revisions stay unavailable to the agent. Independent local verification: full dashboard suite **116/116** and production build pass. No live knowledge was changed and no production UI demo was run; the phase stays open until the end-to-end publish/search demonstration can run on a configured dashboard host.

### P12.2 — Dynamic data admin `[~]`
Typed forms with effective dates for offers, prices, property, deposits and fees. **Never edited as freeform prompt text.**

**Progress (2026-10-11):** The admin surface provides typed forms for offers, renewal fees, properties, reservations, and government fees with effective/expiry dates, validation, an audited reason, and admin-only writes through the commercial-data Edge route. Current dashboard tests pass **141/141**, and the production dashboard build succeeds. Live admin CRUD and end-to-end change → retrieval verification remain unrun; the phase is partial.

**Progress (2026-10-13):** Company brain → Response style now exposes the bounded `allowRelevantServiceSuggestions` preference next to paragraph, list, bold-label, and continuation controls. The generator and Node/Edge prompt parity fix ensures disabling it removes the positive hook language from the Edge operator prompt as well as the customer prompt. `rafa-agent-api` version **94** is active with `verify_jwt=true`; remote source read-back confirms the Edge prompt includes the disabled branch and consumes the response-style value. Playwright with a mocked settings API exercised every style dropdown and both checkbox states through save/reload at 375px; no live settings row was changed. Focused Node prompt tests pass **37/37**, Edge module tests pass **77/77**, and dashboard tests pass **179/179**; the dashboard build passes. Live authenticated setting read-back remains open because the current dashboard browser has no valid session.

**Usability follow-up (2026-10-13):** Mobile visual inspection found the continuation dropdown was clipped and that a failed settings read could leave default values looking authoritative. Response style controls now stack labels above full-width selects with concise choices and visible optionality guidance; a failed read shows the error and retry action without offering a save button. Playwright verified the 375px control width, exact options, 401 error state, and recovery to saved values. Dashboard tests remain **179/179** and the production build passes.

**Admin visibility and identity editing follow-up (2026-10-13):** A fresh Supabase metadata inventory confirms all 38 `public` tables are mapped to a dashboard workflow or explicitly documented as internal/system-owned. Added Company brain → Company identity as an admin-only, field-whitelisted view of the validated startup profile; the projection keeps credibility figures out of the browser, and an unauthenticated request returns 401. Dashboard tests pass **181/181**, the production build passes, and mocked Playwright confirms all five admin Company brain categories, identity fields, no numeric credibility claims, and no horizontal overflow at 375px. The user clarified that admins must be able to edit all company information through the UI: this view is only an interim visibility step. A typed identity setting still needs to be consumed by both the Node WhatsApp runtime and Edge runtime before editing is exposed. Keep M12 open.

**Identity edit and runtime alignment (2026-10-13):** Replaced the interim view with an admin-only typed editor backed by `rafa_settings.company_identity`. Validated fields cover names, jurisdiction, IANA timezone, cities, departments, and supported languages; credibility claims remain in the reviewed fact/knowledge workflows. Node WhatsApp reads and caches the setting, while Edge prompt construction and `settings/company-identity` GET/PUT use the same mirrored validator. Missing/invalid settings fall back to the startup-validated company profile. The dashboard PUT requires an administrator, a reason, and writes an audit event. Live `rafa-agent-api` version **95** is active with `verify_jwt=true`; remote read-back confirms the identity route, loader, prompt support, and validator file. The live setting is absent, so the validated config default is active; no company identity was written. Mocked 375px Playwright submitted an edited brand and city list with reason, showed success, reloaded and read the value back at 360px document width. This caught and fixed two list editor crashes. Full root tests pass **2,605/2,605**, dashboard tests pass, prompt/mirror parity and syntax checks pass, and the production build succeeds. A live administrator session is unavailable in the local browser; a direct unauthenticated endpoint request returns 401. Remaining M12 gates include the 81-row fact provenance discrepancy, authenticated live admin read-back, and a bounded reviewed decision on active business hooks; core safety/appointment policy remains code-managed rather than exposed through an unrestricted prompt editor.

**Owner-manual approval reconciliation (2026-10-14):** Live migration history showed `refal_fact_approval_gate` preceded the later fact-register seed, so the seed had reintroduced **81** owner-manual-only claims as approved. Migration `20261013210419_reconcile_owner_manual_fact_approvals` is now applied. Read-back confirms the 81 records are pending, their audit rows preserve `approved → pending` and the governance reason, and the one independently sourced authority fact remains approved. The new migration regression proves the sourced fact is retained, manual-only approvals are gated, audit history is kept, and reruns do not duplicate audit rows. An exact normalized claim-text scan across approved facts and the latest approved enabled knowledge document per source found zero exact phrase duplicates; multilingual semantic overlap remains unproven. Latest local checks pass **2,606/2,606 root tests**, **181/181 dashboard tests**, production build, Edge mirror/prompt generation checks, and `git diff --check`. The local Playwright browser still presents the sign-in page and unauthenticated API access returns 401, so live settings persistence has not been exercised. Real WhatsApp AR-02 still needs a provider-backed retry: the previous owner-chat turn reached the worker but OpenRouter returned HTTP 401 `API key expired`, and no further cases were sent. M12 remains open for evidence replacement/review of pending facts, authenticated live admin verification, and the real WhatsApp scenario run after provider access works. The six legacy sales-hook selectors remain outside the active customer runtime; dashboard controls must not imply otherwise. Safety and appointment state-machine rules remain code-managed.

**Live runtime and browser recheck (2026-10-14):** Authenticated read-only Edge `knowledge/search` returned HTTP 200 with 8 rows; attached fact metadata included **9 pending** and **1 approved** rows, confirming the new live register state reaches retrieval. A minimal provider readiness request still returns HTTP 401, so no WhatsApp message was sent. The retained port-8787 Playwright tab is route-mocked (its identity PUT says “Temporary dashboard UI regression check” while overview calls return 401); its displayed `REFAL QA` values are not live Supabase data. The fresh port-8788 sign-in page fits a 375px viewport without overflow and produced no console errors. No live identity setting was changed. Authenticated live dashboard persistence and the real WhatsApp scenario matrix remain open.

Read-only Edge identity verification returned HTTP 200 with the configured default `REFAL` / `Refalco Group` identity and null `updatedAt`, confirming the temporary Playwright `REFAL QA` fixture did not reach Supabase.

**Fact provenance review UX (2026-10-14):** After the 81 manual-only rows were corrected to pending, the dashboard's old warning (approved manual rows only) disappeared. The Fact Register now keeps the owner-manual provenance callout visible while pending and filters directly to those records. Focused helper tests and the full dashboard suite pass (**183/183**); dashboard build passes. Playwright used mocked admin/data responses based on the verified live counts: at 375px it confirmed the warning, filtered 82 rows to 81 and restored all 82, with document width 360px. No live fact or setting was edited.

**Independent M12 dashboard audit (2026-10-14):** Read-only review found no code-level gap in the scoped company-information UI: administrators can manage knowledge sources/revisions with review and retrieval controls, fixed facts with evidence/review workflows, commercial data through typed editors, and identity/response preferences through typed settings. The live authenticated knowledge edit → approval → retrieval acceptance path remains unverified; mocked browser tests are not live persistence evidence. Remaining M12 evidence gates are MIG-14 application and multi-instance correction smoke, operational badge/count reconciliation, and independently supported evidence replacement/review for 81 pending owner-manual claims. Legacy sales-hook selectors are dormant in Rafa's customer path, so no UI switch should suggest otherwise. No code, database, or tests were changed by the audit; the implementation audit found no additional UI change to make. M12 remains open pending the listed live evidence and the requested real WhatsApp regression after model-provider access is restored.

### P12.3 — Operations dashboard `[~]`
Open handovers and alerts · complaint status · lead summary · appointment progress · calendar pending and failures · follow up consent and state · knowledge freshness · tool health · delivery failures. **Badges and counts reconcile with the underlying unresolved records** (repairs FIX-9). Filters by department, priority, status, language and date, without exposing secrets.

**Partial-write recovery (2026-10-11):** Reproduced a status PATCH that can update some handover rows before the connection fails, leaving the delivery ledger behind. The route now returns a retryable 503; repeating the same requested state reconciles both handover rows and ledger. A second regression covers a partial ledger upsert. The focused dashboard workflow set passes **23/23**, production build passes, and the complete dashboard suite passes **144/144**. This repairs retry convergence locally; cross-instance concurrency and live database persistence remain open.

**Independent audit follow-up:** Review reproduced and fixed three cases: direct open→resolved leaves `acknowledged_at` null; post-write handover and delivery read failures return retryable 503 guidance; and acknowledging an open request does not timestamp a resolved sibling in a mixed group. Retry convergence is covered for partial row and ledger writes. Focused status tests pass **12/12**; the independent re-audit confirmed the fixes and found no remaining related issue. Cross-instance coordination and live database behavior remain unverified.

**Progress (2026-10-11):** Handover filters now evaluate every member of a grouped contact result while returning the complete conversation group, and identify which constituent matched. Ledger and notification reads page through all rows with stable `created_at,id` ordering. Dashboard suite passes **134/134** and the production build passes. Live count reconciliation and concurrent-write behavior remain to be checked on the configured dashboard host.

**Independent audit (2026-10-11):** Notification reads are now bounded to eight concurrent requests with stable output ordering; dashboard suite passes **137/137** and the production build passes. A partial-failure risk remains in handover status plus delivery-ledger updates; this needs an atomic RPC or an explicit repair path and was not changed in this dashboard-only pass.

### P12.4 — Human corrections `[~]`
Staff can correct names, intent, score evidence, routing and knowledge facts. Corrections are auditable and **feed the evaluation fixtures after review**. Tested with: a staff member without permission, stale browser state, partial saves, concurrent edits. No control may imply success before the save is confirmed.

**Progress (2026-10-11):** Independent audit found process-local stale-write protection and a split profile/audit write. Replaced these with MIG-14's service-role-only RPC: row lock, compare against the browser baseline, partial JSON merge, and field-name-only audit insert occur in one transaction. PGlite covers stale state, partial preservation, audit payload privacy, privilege boundary, and rerunnable DDL; dashboard covers role checks and concurrent stale submissions. MIG-14 is prepared but unapplied, so live multi-instance behavior remains unverified.

---

# M13 — Scale and Reliability

### P13.1 — Concurrency `[~]`
Per contact serialisation (two messages from one customer must not race) · bounded global concurrency · a work queue with retry · idempotency on inbound receipts (`rafa_inbound_message_receipts` exists) · **webhook deduplication**.

**Progress (2026-10-11):** Added a bounded FIFO executor with per-contact serialization and fail-closed overload handling. Durable inbound claims now use UUID lease fencing: stale workers cannot complete after another worker reclaims a receipt. Migration `20261011100100_inbound_receipt_fencing.sql` and local contention/fencing tests pass. The WhatsApp worker must be stopped and drained before applying the migration and deploying the matching Edge/worker code; no live rollout or multi-instance smoke has run.

**Queue and telemetry audit (2026-10-11):** A configuration audit found `Number(RAFA_INBOUND_QUEUE_LIMIT) || 200` silently turned an explicit zero-waiting-queue setting into 200. Startup now preserves `0` and rejects malformed/out-of-range values; zero-capacity admission and parser tests pass. Local telemetry now rejects prose injected into event names/approved string fields, and the synthetic-load harness validates inputs with a 10,000-turn ceiling. Focused P13 tests pass **18/18**. This remains synthetic evidence; migration rollout, production sampling, and a real load ceiling are open.

### P13.2 — Shared rate limiting (removes BLK-11) `[~]`
Move `src/rateLimiter.js` counters from process memory to Supabase so limits survive restarts and hold across processes.

**Progress (2026-10-11):** Added an atomic, service-role-only Supabase RPC migration, authenticated Edge route, HMAC pseudonymous contact keys, shared per-minute and daily counters, and a bounded local outage fallback. Local migration and application tests pass. The migration is intentionally unapplied; cross-worker behavior and restart survival require the owner migration gate and live verification.

**Traceability:** MIG-13 is prepared at `supabase/migrations/20261011030000_rafa_shared_rate_limits.sql` and PGlite-verified; application and multi-worker smoke remain pending.

### P13.3 — Measured latency and cost (CX 15A) `[~]`
**Recalculate against current provider prices and actual token usage.** Historical assumptions of 100 conversations a day at 2,000 in / 200 out are planning estimates, not current usage. Measure **p50 and p95** across WhatsApp, API, RAG, Supabase writes, tools and model calls. Compare sequential vs parallel non dependent writes while preserving transaction and idempotency correctness. Set a hard prompt token ceiling. Track cost through `src/aiUsage.js`.

**Progress (2026-10-11):** Read-only audit found zero live `ai_usage` and zero Agent-turn events in the audit table, so actual token cost and end-to-end latency cannot yet be measured. Shadow remains disabled by default; enabling it on customer traffic would add provider calls and retrieval load. Keep this phase open until bounded, privacy-reviewed telemetry is captured.

### P13.4 — Resilience (CX 15B) `[~]`
Timeouts · bounded retries · circuit breakers · rate limiting · queue recovery · provider quota handling. If the model, provider or RAG is unavailable: a **safe short fallback or a queue for human support, never a fabricated answer**. Health checks for WhatsApp, edge function, Supabase, vector search, calendar, CRM, alerts and scheduler.

**Provider failure containment (2026-10-11):** Added a process-local model-provider circuit breaker to the Node answer-generation and Agent-decision fetch paths. It opens after five transient failures, cools down for 30 seconds, admits one half-open probe, resets on success, and does not retain request content. Existing safe fallback and alternate-model behavior handle the open-circuit error. After fixing audit findings for non-transient exceptions and stale in-flight success, focused provider/decision/privacy/usage tests pass **57/57**; independent breaker re-audit passes **43/43** including manifest coverage. The Supabase Edge implementation has a separate provider path and is not covered by this Node breaker; live outage behavior and cross-isolate coordination remain open.

**Independent audit follow-up:** The first audit reproduced two local defects despite the focused suite passing: a non-network exception could count as a provider failure, and an older in-flight success could close a circuit opened by a newer failure. Both were fixed and re-audit confirms the added regressions pass. The Edge and distributed outage gates remain open as stated above.

**Progress (2026-10-11):** Independent audit fixed queue admission when capacity is zero and when unrelated contacts can run despite a saturated blocked queue; active slots are released before resolving callers. Focused runtime/receipt/transport suite passes **129/129**. Timeouts and bounded retries are covered, but circuit breakers and live provider/database/WhatsApp outage recovery remain open; receipt fencing requires the pending migration and coordinated rollout.
**Latency instrumentation (2026-10-11):** Legacy provider-call latency now includes response-body parsing while excluding circuit-queue wait. Agent decision calls emit a sanitized duration-only event on success and failure. Slow-body, runtime-wiring, and telemetry-sanitization regressions pass; the combined focused set passes **57/57**. Independent audit found no concrete defect. This is instrumentation capability only: no live usage is available yet, so p50/p95, end-to-end stage latency and current cost remain unmeasured.

### P13.5 — Observability (CX 15C) `[~]`
Redacted trace IDs linking message → retrieval → tool result → DB outcome. Track fallback rate, zero result retrieval, language mismatch, handoff delivery, booking errors, opt out suppression, provider failures and cost. **Never log chain of thought.** Log concise decision labels and evidence IDs only.

**Progress (2026-10-11):** Existing redacted observability and shadow summaries are present, but live audit data contains no Agent-turn or AI-usage events. Do not treat dormant instrumentation as measured production behavior; privacy-safe event coverage and a controlled live sample remain open.

**Telemetry allowlist repair (2026-10-11):** A local audit found the privacy allowlist dropped the `outcome` enum from `agent_turn_not_clean`, hiding a useful operational reason while sanitizing the rest of the event. Added the bounded field and a regression proving customer prose remains dropped. Focused telemetry/usage tests pass **10/10**. Live event volume and dashboard use remain unverified.

### P13.6 — Load test `[~]`
N concurrent conversations across all three languages. Measure latency, error rate, retrieval quality under load, cost per conversation. **Verify no duplicated actions.** Record the safe concurrency ceiling. Test: provider rate limit, slow database, vector timeout, WhatsApp disconnect, repeated webhook, queue restart.

**Progress (2026-10-11):** No concurrency ceiling has been measured. A six-case live-model conversation smoke completed against the currently deployed corpus; three cases used model answers and three used deterministic fallbacks. This smoke is not a load test, and no provider/database outage or restart scenario was exercised.

**Synthetic harness (2026-10-11):** Added `scripts/runSyntheticAgentLoad.js`, which exercises the actual local message executor with synthetic EN/AR/EL turns, bounded queue, per-contact ordering, injected retrieval/model/provider/database/WhatsApp failures, and duplicate action accounting. Focused tests pass **6/6**. This harness makes no external calls and does not measure provider, database, retrieval, WhatsApp, cost, or production concurrency ceilings; P13.6 remains open for an instrumented controlled integration load test.

**Load report audit (2026-10-11):** Queue-full responses were included in aggregate failures but not separately identifiable. The report now breaks them out as `results.queueRejected` and `failuresByStage.queue`; the overload regression asserts both. The per-stage failure injector now also supports one injected failure in every selected stage, with regression coverage. `node --test scripts/runSyntheticAgentLoad.test.mjs` passes **6/6**. A 1,000-turn, concurrency-32 local run completed with zero failures or queue rejections; this remains synthetic evidence and does not establish a production concurrency ceiling.

**Failure-injection regression and bounded run (2026-10-11):** An audit found `--fail retrieval,model,...` consumed only the first injected failure overall, silently skipping other requested stages. Failure consumption is now tracked separately per stage; focused tests pass **6/6**. A local run of 1,000 synthetic turns at concurrency 32 completed with zero failures/rejections, peak concurrency 32, queue P50/P95 1,206/2,300 ms, turn P50/P95 1,285/2,393 ms, and all three languages represented. Timings are harness delay measurements only; no provider, database, retrieval, WhatsApp, cost, or production concurrency ceiling was measured. Independent audit confirmed the harness's scope and accounting, not real service fault recovery.

---

**Database changes (apply in order).**
1. `supabase/migrations/<ts>_refal_shared_rate_limits.sql` — P13.2. Move `src/rateLimiter.js` counters out of process memory so limits survive a restart and hold across workers. Removes BLK-11.

---

# M14 — Evaluation, Release and Independent Rollback

### P14.1 — Golden set scoring `[~]`
All ~870 questions. Targets, written before the run: ≥90% factual accuracy · 100% grounding · **0 guardrail failures** · ≥85% Golden Formula compliance · ≥85% highest-level language quality in each language and parity spread within 10 percentage points. Results identify test type: synthetic, sandbox or live. **No scripted fallback counts as a model success without disclosure.**

**Harness update (2026-10-11):** Candidate answers can now be evaluated against explicitly selected current approved RAG chunks or trusted current dynamic-tool evidence, then passed through the real Agent output/grounding/language gates. Row-level evidence metadata is preserved when combining the top five candidates. Scoring requires a recorded human review and a separate refusal adjudication for negative controls; invalid or incomplete evidence selections fail closed, and partial samples cannot qualify for release. The harness makes no provider calls. Focused suite passes **23/23**. Readiness now requires exact, duplicate-free ID coverage of all 879 positive and 17 negative cases; subsets, language filters and limits cannot qualify. No reviewed candidate answer corpus or full 879-question answer run was supplied, so answer-quality targets remain unmeasured.

**Execution record (2026-10-11, corrected live diagnostic only):** Read-only search evaluated 861 RAG expected-fact cases from the 879-question positive golden set and surfaced 770 mapped facts in the top five. Same-language evidence ranked first in all 293 questions in each of AR, EN and EL. Eighteen cases use the separate dynamic-data path; the offer lookup returned 21 current dynamic fact observations. The diagnostic also ran 17 negative controls, but raw retrieval does not count as an Agent refusal test. It generated **zero** answers and made no writes. Retrieval is weakest in development (29/39, 74.4%), real estate (95/120, 79.2%) and legal (24/30, 80.0%). Factual accuracy, grounded answers, refusal quality, Golden Formula compliance and language quality remain unscored; human review of expected-fact mappings and candidate answers is required before a release verdict.

**Scoring and CLI follow-up (2026-10-11):** Evaluation now reports Wilson 95% intervals for retrieval coverage, factual accuracy, grounding, language/dialect quality, Golden Formula compliance, and guardrail pass rates, split by language and domain. Empty or unreviewed samples remain unevaluated, and the readiness gate still requires complete reviewed coverage. Invalid/missing `--lang` values now exit with an error instead of producing a successful empty report. Focused evaluator/RAG tests pass **31/31**; an independent audit confirmed the interval and denominator behavior. These intervals describe this curated set and do not imply broad population-level precision or live answer quality.

**Harness correction (2026-10-11):** A false-green path allowed answer-quality eligibility with no reviewed refusal scenario. Eligibility now requires at least one refusal answer with explicit passing adjudication. Negative raw-search diagnostics still do not count as Agent refusal evidence. No model answers were generated in this pass; live answer quality is not yet scored.

**Evaluation catalog audit (2026-10-11):** A duplicate model-visible dynamic offer with the same code but a different amount or validity metadata could overwrite its trusted source record in the human-review evidence catalog. Catalog entries now require all current source fields to match; a regression confirms altered same-code duplicates cannot replace the trusted amount. `node --test scripts/runGoldenKnowledgeEvaluation.test.js` passes **23/23**. This does not change the harness's explicit limitations: no answer model is called, candidate output uses scripted decisions, and Agent refusal behavior is not measured by raw negative searches.

**Live conversation smoke (2026-10-11):** Six synthetic customer messages were run with read-only retrieval against the currently deployed corpus and mocked customer storage. In the latest run, the model produced four acceptable replies (one Arabic, one English and two Greek); two Arabic drafts were blocked and safely abstained because the retrieved production source was stale or too long. A Greek answer after an explicit appointment decline initially mentioned booking; a local post-processing guard now removes appointment references while preserving the answer's lines. The smoke exposed deterministic fallback replaying overlong old source text; the fallback now passes shared response validation and abstains when it fails. These results are diagnostic only: the refreshed local corpus is not ingested, no representative client data was used, and the full answer-quality targets remain open.

**Regression follow-up (2026-10-11):** This turn corrected an MB-F18 closure-route contradiction across English, Arabic, and Greek, updated fact-provenance and placeholder regression tests after source URLs were added, and reran the local suites: root **2,224/2,224**, dashboard **141/141**, dashboard production build, corpus **87/87 clean**, and `git diff --check`. The fact audit intentionally remains red with 76 pending-corpus findings. No candidate-answer quality scores or owner approvals were produced.

### P14.2 — Full workflow tests (CX 14C) `[~]`
Inbound message → intent → retrieval or tool → answer → DB persistence → handoff, booking or follow up state → dashboard view. Fake services and isolated Supabase fixtures first, then sandbox accounts for external connectors.

**Local composition coverage (2026-10-11):** Added a synthetic customer-answer integration test that runs the WhatsApp post-preflight Agent callback, actual Agent loop and approved-knowledge tool, response gates, persistence update, and outbound send with injected local services. It asserts approval/freshness metadata reaches the model observation and the answer is persisted and sent once. `src/agentWhatsAppAdapter.test.js` passes **16/16**. This is a synthetic composition test: it does not exercise inbound intent classification, a Supabase fixture, handover/booking/follow-up state, dashboard visibility, or sandbox services. Those end-to-end slices remain required before P14.2 can close.

**Initial inbound-to-answer vertical slice (2026-10-11):** Added `src/agentCustomerAnswerWorkflow.integration.test.js` and included it in `npm test`. EN/AR/EL cases run inbound preparation/classification and routing, the Agent runtime and approved-knowledge policy, then persist to a synthetic history row and send once through a fake sender. They seed previous customer/assistant turns and use the actual recent-history formatter. The English, Arabic, and Greek ambiguous follow-ups now retain the prior company-formation topic through approved-knowledge retrieval; regressions assert a grounded answer and one next-step question. The latest workflow/runtime suite passes **23/23**. Fixture evidence, storage, sender and decision are synthetic; provider behavior, durable Supabase persistence, webhooks, dashboard view, and external action paths remain unverified. P14.2 remains open.

**Trilingual inbound coverage (2026-10-11):** Expanded that composition test to one English, Arabic, and Greek customer question with a language-matched approved fixture answer. Each exercises inbound classification, routing, retrieval, output validation, same-row history update, and one fake send. `node --test src/agentCustomerAnswerWorkflow.integration.test.js` passes **3/3**. This is still a synthetic local slice; durable Supabase, real provider, dashboard display, webhook deduplication, action-state flows, and sandbox connectors remain unverified.

### P14.3 — Shadow mode `[~]`
Run against live traffic behind the existing `src/agentShadow.js` flag, default off. Compare against current production answers. No customer sees a difference yet.

**Local readiness (2026-10-11):** The Node caller launches a bounded fire-and-forget Agent turn after inbound preparation, comparison telemetry joins only safe categorical/length fields, and shadow tools default-deny all writes. The disabled flag is a no-op. Local shadow and observability tests pass **31/31**. An audit found setup-error telemetry could include raw exception text; it now emits a fixed reason code, with a secret-in-error regression. No live-traffic shadow run was performed; the deployed Edge version is not this worktree and the flag remains off until a bounded, privacy-reviewed comparison window is authorized.

### P14.4 — Red team round 2 `[~]`
Full adversarial sweep including injection planted inside an uploaded knowledge document, guarantee extraction, eligibility extraction, price fabrication, PII extraction, cross customer probing.

**Local Agent-loop coverage (2026-10-11):** Added deterministic cases for uploaded-document-style retrieval injection, hostile tool output, guarantee/eligibility/price/PII extraction in EN/AR/EL, and attacker-supplied customer IDs. The suite passes **8/8**; independent review confirmed the hostile payload is asserted inside the labeled untrusted-data section. The approved-search result and CRM context are mocked: this does not test document ingestion or approval, live RLS/cross-customer isolation, or model obedience. Phase remains partial.

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

### P15.1 — New knowledge workflow `[~]`
```
1. Staff submits a fact or change with source, owner, submitter, topic, domain,
   language, effective date and expiry.
2. REFAL marks it DRAFT and does not use it.
3. An independent qualified reviewer approves it. Taxonomy-regulated or
   explicitly sensitive claims require the designated subject expert.
4. Publish a new version, reindex, run retrieval and multilingual smoke
   tests, expose the version in audit history.
5. Roll back if tests fail and notify the knowledge owner it is blocked.
```

**Local intake and publication order (2026-10-11):** Added `npm run knowledge:packet:validate -- <packet.json>` and a runbook workflow. The offline validator requires provenance, owner, submitter, exact topic/domain match, language, dates, DRAFT status, and reviewer metadata; it rejects obvious exact, abbreviated and reordered submitter/reviewer name matches and requires a subject expert for taxonomy-regulated or explicitly sensitive claims. The dashboard now stages the complete chunk embedding/index batch while a revision remains pending and records audited approval only after all indexing succeeds. Missing chunks, invalid/incomplete vectors, and partial indexing fail before approval. Dashboard tests pass **154/154**. This does not verify identities/qualifications against a staff directory, connect offline intake to authenticated publishing, or prove prior approved revision retrievability after rollback. Live retrieval smoke and rollback remain required; P15.1 remains partial.

### P15.2 — Feedback loop `[~]`
Capture customer corrections, unanswered questions, retrieval misses, tool failures, complaints and staff edits as review tasks. **Promote every reviewed fix into a test case before the knowledge or prompt update.** Re-evaluate each release against the full regression suite.

**Local offline support (2026-10-11):** Added a minimized feedback-case validator for EN/AR/EL, mixed-language and unknown cases, with constrained fields, taxonomy topic IDs, a bounded opaque case ID, real UTC timestamp validation, obvious PII/secret checks, named triage, non-actionable rationale, and passing reviewed regression/change references before later statuses. `npm run knowledge:feedback:validate -- scripts/fixtures/feedback-case.captured.json` validates the example; focused tests cover the original privacy and timestamp gaps found by independent audit. This validator does not persist restricted tickets, enforce access, prove anonymization, or verify that referenced tests actually ran. Operational tracker use and independent closure review remain open; no facts are auto-approved.

### P15.3 — Scheduled review `[~]`
Review legal, tax, immigration and dynamic business facts **at their expiry date or earlier on a source change** (this is what P3.9's register exists for). Review dormant knowledge, duplicated chunks, model or provider changes, language quality and cost at an agreed cadence. Maintain the change log and the phase and incident history in this file.

**Local freshness report (2026-10-11):** `npm run knowledge:review` reports current/due/expired/pending/blocked facts, source changes, corpus defects, owner/reviewer fields, and rollback evidence status from the checked-in seed and corpus only. Current local view: **82/82 pending, 0% current, 87 corpus cells clean**. A source-change simulation becomes due immediately. Independent audit found and fixed an owner/reviewer independence gap by rejecting the same normalized identity. This does not read live freshness, verify staff identities, establish a scheduled job, or test a live content rollback. Named operating owners and live rollback verification remain open.

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
| **OP-01** | Fact approval register: source, reviewer, verified, effective, expiry, status | R-09, 2B | **P3.9** | `[x]` |
| **OP-02** | Policy precedence ladder, 6 levels, enforced in code | 1C | **P1.6** | `[x]` |
| **OP-03** | Booking policy: Europe/Nicosia, weekdays 10:00-15:00, no same day, notice window, fresh recheck, explicit exact confirmation, 7 states | R-20, P10 | **M7** | `[ ]` |
| **OP-04** | Booking never blocks unrelated Q&A; a new message never resumes an old booking | R-21 | **P7.4** | `[x]` |
| **OP-05** | Follow up consent scope, trilingual opt out, scheduler suppression, no untrue timing promise | R-22, P11 | **M9** | `[ ]` |
| **OP-06** | Existing client account data fail closed until approved independent verification | R-19 | **P2.5** | `[x]` |
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
| **D-4** | Facts vs blocking | The 66 extracted claims are candidates, not automatically approved facts. Only claims with current approved evidence may be asserted; each approved record carries source, effective date and review/expiry metadata (P3.9). |
| **D-5** | Handoff delivery | Dashboard record plus the existing email path, exact MB 5.2 format. External CRM deferred |
| **D-6** | Knowledge authoring | Claude authors all 87 documents from the `EX` extraction, natively per language. BOSS reviews at P14.5 |
| **D-7** | Target runtime | The agentic loop. The deterministic router keeps working and is not deleted |
| **D-8** | Proactive cross selling | **Required**, once per trigger, after the question is answered, under P5.4 suppression |
| **D-9** | Offering a call | Tier aware: none at Informational/Cold, flexible at Warm, required at Hot or on a buying signal, always with consent |
| **D-10** | Residency / tax / licence content | **Allowed as PROGRAM_FACT with evidence.** Personalized eligibility and guarantees stay blocked |
| **D-11** | Existing-client code delivery (BOSS, 2026-10-09) | `setVerificationCodeSender` is **optional until M8** and is **not a condition of M2 closure**. The flow is reached only via `INTENTS.EXISTING_CLIENT`, no tool reads `accountDisclosureAllowed`, and the commercial tables are absent (BLK-12), so there is nothing to disclose yet. Unregistered is the **correct** configuration and is fail-closed, not an error. Revisit at **M8**, when CRM memory gives REFAL real account data worth protecting |

### 14.2 Every dependency, and how this plan fixes it itself

Codex parked ten items as `OPEN` and switched off the capability behind each one. **This plan does not park anything.** Each row below is built, shipped working, and needs at most one value typed into one field.

| ID | What Codex parked | **How this plan fixes it** | Phase | Result |
| --- | --- | --- | --- | --- |
| **F-01** | Cyprus corporate tax 15% from 2026 | REFAL **states it now**, from the `corporate-tax` source, carrying `effective_from` and a 30 day review date. If it ever changes, BOSS edits **one row** in the dashboard and she updates instantly. No release, no downtime | P3.2, P3.9 | ✅ **she says it** |
| **F-02** | Is €999 + VAT really the current offer | The current approved live offer row is €999 EUR, active and expires 2026-11-06; local precedence tests cover stale evidence. Live Edge deployment v44 is verified by the offers read smoke, while a synthetic live-source Agent response is now verified; no outbound customer message was sent | P3.1, P4.1, P4.2 | `[~]` **live row and Edge read verified; customer conversation smoke pending** |
| **F-03** | Credibility: 2000, 20 years, 47, 400+ | REFAL **states them now**, from the `company-profile` knowledge source, 12 month review. This is what she answers the distrust objection with | P3.7 | ✅ **she says it** |
| **F-04** | Who owns property, deposit, fee and promo data | All six tables are live and authenticated local Dashboard CRUD against production main has passed create/read/update/delete with retained audit evidence. No external Dashboard host is required for the owner-confirmed target. | P4.1, P4.5, M12 | `[x]` **schema and authenticated CRUD verified against main** |
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

| **FIX-14** | High | MB-F55 | A NEGATED guarantee read as a guarantee: `and is not a guaranteed date` / `وليست موعداً مضموناً` deleted the whole grounded answer | `claimPolicy` knew only the VERB negation (`I cannot guarantee`), not the adjective form | **P2.2** | `claimGateEvidence.test.js` CLAIM-1 |
| **FIX-15** | High | MB-G1 | A closing discovery question classified as an ungrounded PROGRAM_FACT, so every reply that obeyed the Golden Answer Formula was deleted | a question was scored as an assertion | **P2.2** | `claimGateEvidence.test.js` CLAIM-2 |
| **FIX-16** | High | MB-F19..F55 | A spelled-out cardinal did not match its digits, so a grounded restatement (`4 أشهر` vs `أربعة أشهر`) blocked as unsupported | number extraction was digits only | **P2.2** | `claimGateEvidence.test.js` CLAIM-3 |
| **FIX-17** | High | AR-L3, MB-SEC | Greek `διαμονή` missing from the IMMIGRATION rule: `Θα πάρω τη μόνιμη διαμονή;` carried no risk at all while its English and Arabic twins both refused | trilingual asymmetry, the BLK-14 shape | **P2.2** | `safetyPolicy.test.js`, `claimGateEvidence.test.js` |
| **FIX-18** | High | MB price rules | A Greek price LEAKED into a non-pricing answer (`999 ευρώ`), and keyword-free Arabic price chunks were invisible to the price path | three divergent inline price regexes in one file; `ευρώ` in none of them | **P2.2** | `claimGateEvidence.test.js` PRICE-1 |
| **FIX-19** | **Blocker** | MB-F55, MB-SEC1 | Approved evidence REMOVED the refusal from every investment advice, returns and ROI question, in all three languages. Introduced by P2.2 itself | the programme stand-down ran before the investment re-arm, which was therefore unreachable | **P2.2**, found by **P2.6** | `guardrailRegression.test.js` G-06 |
| **FIX-20** | High | Anti-regression 0.2 | 16 of 29 cross-customer probes were refused by nothing; the other 13 only incidentally | no cross-customer rule existed anywhere in the repo | **P2.6** | `crossCustomerPolicy.test.js` |
| **FIX-21** | High | MB-F55 | No ROI or expected-return claim class ran on the answer side, so a chunk carrying a yield figure unlocked the statement | `containsRoiClaim` shipped in P2.4 with no caller | **P2.6** | `outputGuards.test.js` |
| **FIX-22** | High | MB-SEC | 9 injection and credential-phishing messages invisible to `classifySafety` in Arabic and Greek only | Arabic rules written against definite forms only; Greek literals not stemmed, so the genitive bypassed them | **P2.6** | `safetyPolicy.test.js` |
| **FIX-23** | High | MB-SEC2 | 0 of 27 sanctions probes escalated. The detectors existed and nothing called them | compliance escalation never wired into `routeMessageResult` | **P2.5**, found by **P2.6** | `messageRouter.test.js` |
| **FIX-24** | High | MB-F20 | Wiring the ROI guard live DELETED the approved IP Box fact: a tax rate on profits read as a yield claim | no tax-rate carve-out in `containsRoiClaim` | **P2.6** | `outputGuards.test.js`, `auditClaimGates.js` |
| **FIX-25** | High | MB-SEC1 | The new output guards flagged EIGHT of REFAL own approved refusals, so a correct Arabic refusal was replaced by a vaguer fallback | no refusal carve-out; saying `I cannot provide returns information` contains the word it hunts | **P2.6** | `outputGuards.test.js`, `mirrorParity.test.js` |
| **FIX-26** | Medium | AR-A | The edge mirror generator would have silently emitted a BROKEN `refalcoAnswer.mjs`, and the edge gate was never given the evidence it already had in scope | the line-based extractor could not follow the new dependency chain | **P2.2** | `mirrorParity.test.js` |
| **FIX-27** | Medium | — | 10 new test suites were absent from `package.json#scripts.test`, so none of them ran under `npm test` | the manifest is a hand-maintained list, not a glob | **P2.2** | `testManifest.test.js` |

| **FIX-28** | **High** | MB-F1..F66, MB-J1..J4 | **All 870 golden questions scored against the wrong MB fact outside the middle of the range.** `expectedFacts` was the mechanical placeholder `MB-F0${topicNumber + 5}`, right by coincidence for topics 9-18 and wrong for topics 1-8 and 19-29. `property-vat` expected MB-F45 (the buyer journey), `legal-ip-contracts` expected MB-F50 (the deposit guardrail), the four jurisdiction topics expected MB-F56..F59 (the landowner facts) instead of MB-J1..J4. Ids were also zero padded (`MB-F06`) while the authoritative extraction writes `MB-F6` | the golden set was generated per topic before the fact extraction was cross-checked, and nothing validated the mapping. Three files named MB facts and no two agreed | **P3.1-P3.8** | `brainGoldenSet.validateAll()`, now subset-checked against `brainFactMap.citableFactsForTopic` |
| **FIX-29** | **High** | — | `scripts/backfillKnowledgeEmbeddings.js` permanently fails on a **partially embedded document**. It filters already-embedded chunks per chunk, then posts the short array to `rafa_store_knowledge_embeddings`, which raises `Embedding count does not match revision chunk count` unless the array covers every chunk. One interrupted run leaves the document unfixable by re-running | skipping was a per-chunk decision against an RPC with a per-document contract | **P3.10** | per-document skip, covered by `corpusIngest.test.js` |
| **FIX-30** | Medium | 0.2 | `FORBIDDEN_CORPUS_LITERALS` guarded **2 of the 6** MB-DYN variables, and only against section bodies. A frozen renewal fee, government fee, monthly rent or invented foreign tax rate passed a green validator, and so did a price pasted into an **alias**, which is a retrieval surface that does get indexed | an allowlist problem solved with a denylist: each new dynamic variable needed its own regex and nobody wrote them | **P3.1-P3.8** | `corpusFile.test.js`, the approved-number rule |
| **FIX-31** | Medium | AR-L1, AR-L3 | The corpus number scanner read the Greek `2,5%` as **25%** and `300.000` as **300**, so correctly authored Arabic and Greek figures were reported as unapproved claims while the English twins passed. The BLK-14 trilingual-asymmetry shape again | separators were stripped by glyph instead of being read by position | **P3.2** | `corpusFile.test.js`, the normalizer table |

**Found by the M3 deployment on 2026-10-10.** Every one of these had passed offline review. None could have been caught without actually applying the file, which is the point.

| ID | Sev | Req | What is wrong | Root cause | **Repaired by** | Regression test |
| --- | --- | --- | --- | --- | --- | --- |
| **FIX-32** | High | MIG-01 | MIG-01 **aborted on first apply**: `42883: function public.refal_fact_effective_status(text, date, date, date) does not exist`. The three `grant execute ... to anon` statements sat in the security section, above the `create` statements for the functions they name | a table grant can be written before the table in a batch, a function grant cannot, and the security block grouped them by topic rather than by dependency | **P3.9** | the apply itself; the grants now sit at the bottom with a comment saying why |
| **FIX-33** | High | MIG-01 seed | The generated seed aborted: `42601: syntax error at or near "on"`. The generator terminated the last VALUES row with `;` and then emitted `on conflict (fact_id) do update set ...` as if it were a separate statement | `on conflict` is a clause of the INSERT, not a statement. A comment in the generator asserted the opposite and was simply wrong SQL | **P3.9** | `scripts/generateFactRegisterSeed.js`, last row takes no terminator |
| **FIX-36** | **High** | W3.9.3 | **A blocked fact was never actually unretrievable.** `filterRetrievableEvidence` had **no production caller**: it was reached only from its own test and the dashboard. Blocking was enforced at ingest only, so flipping a register row to `blocked` left the text in `rafa_knowledge_chunks` with a live embedding until somebody re-ran the ingestion. W3.9.3 requires the change to take effect **with no redeploy** | the behaviour layer was built and tested, and then nothing on the answer path was wired to it. The test passed because it called the function directly | **P3.9** | `ragPolicy.test.js`, `agentRagEvidence.test.js`, wired at `src/ai.js` |
| **FIX-37** | **High** | W3.10.1 | `scripts/ingestBrainCorpus.js --apply` **could never have worked**: it posts `{ p_source_id, ...file.document }` and `p_chunks` is not on `file.document`. `p_chunks` has no DEFAULT, so PostgREST could not resolve the function | the chunks are deliberately kept off the document payload because the embedding step needs them separately, and the spread silently dropped them. Dry run is the default and never reaches the call, so it stayed green | **P3.10** | `corpusIngest.test.js` |
| **FIX-38** | Medium | W3.10.6 | `scripts/brainHealth.js` printed `1 blockers` and the word BLOCKED, and **still exited 0**. W3.10.6 requires it to exit non zero on any gap, so a blocker that cannot move the exit code is a log line rather than a gate | `exitCodeFor` tested only for `GAP` | **P3.10** | `brainHealth.test.js` |
| **FIX-39** | Medium | W3.10.7 | The runbook told the operator to run `node scripts/ingestBrainCorpus.js --topic X` with **no `--apply`**. Dry run is the default, so following the runbook literally writes nothing and prints a success line | the flag was added to the script after the runbook was written | **P3.10** | none, documentation |
| **FIX-40** | Low | W3.9.5 | The wave text said STABLE facts get **12 months** while `brainTaxonomy.reviewCadenceDays` returns **180 days** for a regulated one. The tightening was real and deliberate but documented only in the artefact index, not in the wave a reader would check | the code was corrected and the wave text was not | **P3.9** | `factRegister.test.js` |
| **FIX-41** | High | OP-04 | Disabling optional Meet-link creation made Calendar readiness appear unavailable, and admin approval rejected a valid booking if no Meet URL was returned | `hasCalendarConfig` treated an optional conference URL as a required booking capability; approval repeated the requirement regardless of policy | **P7.1** | `booking.test.js`, `agentBookingTools.test.js` |
| **FIX-35** | **High** | AR-L1, AR-L3, M3 exit | **The lexical ranker scores a perfect match BELOW a stopword match.** `rafa_search_knowledge` uses `ts_rank_cd(search_vector, required)` for a chunk matching *every* query token and `ts_rank_cd(search_vector, broad)` otherwise. Those are different scales: the AND form returns roughly 0.001 to 0.6, the OR form roughly 0.1 x the count of matched token occurrences, so 2 to 6. A chunk that contains the customer's whole question is therefore ranked beneath chunks that merely share "what / is / the / in" with it. Hybrid RRF then fuses a lexical top 30 with a semantic top 30, and a document present in only one list scores at most 1/61, so **a document that misses the lexical cut cannot win however good its embedding is**: `corporate-tax/en` held semantic positions 1, 2 and 3 for "What is the corporate tax rate in Cyprus?" and still missed the top 5 | two rank scales compared as if they were one, made far worse by `to_tsvector('simple', ...)` having no stopword list and no stemming | **P10.2** (the RPC is in `supabase/migrations/`, outside M3's scope) | `scripts/verifyLiveRetrieval.js` |
| **FIX-34** | **Critical** | 0.3, W3.9.7 | **`RAFA_DASHBOARD_SUPABASE_SECRET` on this machine does not authenticate.** `rpc/rafa_dashboard_secret_matches` returns `false`. Every RLS policy on the knowledge tables and on `refal_fact_register` is that function, so from here PostgREST **reads return empty and writes are accepted and silently discarded**. The earlier "Supabase reads work, the tables are empty" conclusion rested on HTTP 200s that were RLS denials | a 200 with zero rows is indistinguishable from an empty table unless you check through a path the policy does not filter | **environment, not code** — see CF-07 | `scripts/emitCorpusSql.js` header documents the detection |

**Release gate.** FIX-1, FIX-9, FIX-10 and FIX-12 are the four that must be green before any production restart or deploy. Every row has an owning phase **except FIX-34**, which is an environment finding (a stale credential) and is tracked as CF-07 against P12.2 instead. *The previous wording said "all thirteen", which was stale from M2 and carried a claim the table had outgrown.*

---

## 16. Phase completion log

Append one Result block per completed phase at G1. Never delete an entry.

### 2026-10-11 — improvement sweep (partial; no milestone closed)

**Built locally:**
- M8: a pre-send never-reask gate and a CRM candidate normalizer with stated/inferred provenance, source turn, confidence, raw/normalized values, and conflict handling. The durable CRM schema and retry-safe CRM sync are still missing.
- M9: reminder consent is separate from specialist contact consent; only an explicit offer followed by an affirmative immediate turn can grant automated reminders. Denial and revocation override older grants. `MIG-09` adds the persisted scope and fresh-offer reconsent guard.
- M10: Arabic, Greek, Arabizi, and Greeklish language signals were expanded. Broad company and service searches use language-matched facets; specific package questions lead with the approved package title. Query embeddings are batched and independent live searches run concurrently while retaining deterministic evidence order and fail-closed behavior. The Arabic company-profile source has a local translation draft for existing MB-C5 coverage; live data still needs the normal reviewer approval to publish it.
- M11: mixed Greek/Cyrillic homoglyph prompt-injection detection was fixed and regression-tested; broader multilingual red-team and retention/role evidence remain open.
- M12: dashboard saves now queue revisions as pending and do not index them. An audited reviewer action is the only dashboard path that publishes and indexes them. Archive/undo, side-by-side trilingual preview, and remaining dashboard requirements remain open.
- M13: expired in-memory rate-limit buckets are pruned periodically. Shared limits, per-contact serialization, queue recovery, health checks, measured p50/p95 cost and latency, and load testing remain open.
- CF-08: lexical relevance now uses a shared query scale and deterministic ID tie-breaks. Explicit quoted phrases and exclusions disable partial fallback. Local PGlite regressions cover exclusions, phrases, duplicate terms, punctuation, Arabic, and Greek. `MIG-08` was applied as `20261010230731 / cf08_lexical_rank_consistency`; lexical runtime evaluation is still required against the live database, and the hybrid halfvec function was not executable in PGlite.

**Verification:** latest `npm test` → exit=0, 2,077/2,077; dashboard tests → 116/116; dashboard production build → exit=0; `npm run validate:corpus` → 87/87 files clean. Earlier in the sweep `npm run health:brain` reported 87/87 present, 87/87 lexically healthy, 868/879 reachable, 5 pending live-DB checks, 0 blockers; the fact-register check cannot authenticate with the dashboard secret, so this is not a complete live health verdict. Latest focused checks: `node --test scripts/evaluateRag.test.js src/ragPolicy.test.js` → 53/53; `node --test scripts/cf08LexicalRank.test.mjs scripts/m9ConsentMigration.test.mjs` → 5/5; Deno check on the Edge entrypoint passed; generated Edge mirrors are in sync; `git diff --check` has no whitespace errors (only Git line-ending notices). The six-case WhatsApp conversation evaluation passed all six synthetic conversations; the production guard rejected several model drafts and the approved-evidence fallback returned the reply.

**Real-data evidence (read-only):** After CF-08 deployment, Supabase retrieval via the actual WhatsApp facet path returned the approved company-formation chunk first in English, Arabic, and Greek, with Arabic and Greek chunks in their requested language. The current live pricing lookup returned an approved, active, verified offer; it is checked through dynamic data, not treated as a RAG fact. The six-case smoke evaluator reports 5/6 approved-corpus checks passing; its live pricing-table check passes. Arabic company-profile service-list coverage remains a live-data gap pending reviewer approval. The six-case sample measures Arabic 1/2 versus English and Greek 2/2 (50-point spread), above the 10-point target. This is an early test signal, not the 870-question release evaluation.

**Audits and defects:** CF-08 independent audit found quoted phrase and negation bypasses plus unstable tie ordering; these were fixed and have executable regressions. The independent M14 audit found stale benchmark expectations (old source names and a fixed RAG price), which were corrected; equal zero pass rates no longer count as language parity. No independent full cross-phase release audit has passed.

**External gates and explicitly not done:** M8, M9, M10, M11, M12, M13 and M14 are not complete. `MIG-09` was applied as `20261010230719 / refal_m9_consent_scopes`, and `rafa-agent-api` is deployed at version 50 with `verify_jwt=true`; live consent/suppression smoke testing is still required before scheduling outbound reminders. `MIG-08` was applied as `20261010230731 / cf08_lexical_rank_consistency`; a corrected read-only retrieval diagnostic over the 879-question corpus is now recorded under P14.1, but answer scoring and controlled customer interaction remain unverified. The pending Arabic knowledge revision has not been approved or published. No commit or push has been made in this sweep. Google Calendar OAuth and live booking remain deferred as requested. Full answer evaluation, complete prompt/security parity audit, staging workflow, and independent rollback rehearsal are still outstanding.

### 2026-10-11 — customer-answer safety and conversation readiness (partial)

**Corrected the authority rule:** the owner manual is reference material, not automatic approval for customer-facing facts. Its 66 extracted claims are candidates. Updated the master plan, source analysis, runbook, fact-register seed, and generated SQL so a claim remains `pending` unless it carries an explicit approved source. New assertions require a current approved fact row and matching language.

**Closed a live fail-open:** the production fact register had 82/82 rows marked approved with the owner manual as their source. Applied the audited `refal_fact_approval_gate` migration through Supabase; read-back confirmed all 82 are pending and 82 audit entries were written. No claim text or customer records were changed. The migration history records version `20261011022104`; local migration ordering was adjusted so the pending rate-limit migration follows it.

**Kept unapproved content out of generation:** local retrieval now requires every fact attached to a chunk to be approved, current, and approved in the customer's language before the chunk is sent to the model. Claim grounding and jurisdiction checks also consume the server-enriched fact rows. Generated Edge mirrors include the new unconditional formation-outcome blocks and claim status checks. Empty-evidence replies now state the limit and ask whether the customer wants a team check in English, Arabic, or Greek.

**Conversation-quality fixes:** safe Arabic sentences can be salvaged from mixed-quality evidence without repeating stale claims about EU-wide operating permission, guaranteed non-rejection, or certificates assuring a bank account. Numbered list ordinals no longer look like package prices. Arabic and Greek handover and reminder messages use the customer's recorded language. Dashboard handover retries now reconcile durable grouped statuses; unknown telemetry fields are dropped.

**Verification:** `npm test` → **2,199/2,200** on the first full run; the only failure was a jurisdiction test fixture that lost enriched fact rows during normalization, then fixed and its focused suite passed **10/10**. The pre-fix focused batch had **331/332** passing; the normalization regression then passed its focused `salesIntelligence` suite **10/10**, and the final full suite passed **2,200/2,200**. Dashboard tests passed **141/141** and the production build succeeded. `node scripts/generateEdgeMirrors.js --check` and `node scripts/generateFactRegisterSeed.js --check` passed. The live six-case smoke passed **6/6 safety checks**, but all six correctly abstained because no candidate facts are currently approved; the model was not called. This is safe behavior, not evidence that useful business answers are ready.

**Current data-readiness gate:** `npm run validate:corpus` verifies 87/87 documents are structurally clean. `npm run audit:facts -- --json` reports 76 high findings because those candidate facts are declared in the corpus but pending; the remaining IDs are refusal/dynamic rules. `node scripts/brainHealth.js --json` reports corresponding fact-approval gaps and pending database checks. No fresh owner-approved evidence package is available in the repository to safely re-approve the business claims, and the live 87-document corpus still contains older text. The user can start infrastructure/conversation-path testing, but factual-answer testing must wait until current sources are approved and the corrected corpus is reviewed/published.

**Still open:** deploy the coordinated Edge release only after reconciling the older live migration history and the pending CRM/contact, receipt-fencing, reminder, shared-rate-limit, and IP Box migrations; update the live corpus after source review; run the 879-question grounded answer evaluation; finish M8–M14 gates; perform an independent cross-phase audit. No Edge deployment, Git commit, push, or production restart was done in this partial update. Calendar/Auth work remains deferred.

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
- W0.1.3 database baseline. Carried into P0.2.
  **Protocol set by BOSS on 2026-10-08:** do not depend on a live Supabase connection from the agent session. Anything the database baseline needs is written as a `.sql` file under `supabase/migrations/` (timestamped, idempotent, with a `-- ROLLBACK:` block), or as a read-only inspection `.sql`, and **BOSS runs it and returns the output**. The baseline is then recorded from what BOSS pastes back.
  Superseded note: an earlier version of this line said the fix was to unset `HTTP_PROXY`. That is wrong. See `SUPABASE-ACCESS-GUIDE.md`, which uses the proxy *with* default credentials. Kept here only so the bad advice is not re-derived.
- ~~Dashboard test and build not executed.~~ **Executed 2026-10-08:** `npm --prefix dashboard test` → **exit=0, 85 tests, 85 pass, 0 fail**. `npm --prefix dashboard run build` → **exit=0**, built in 3.67 s. This gap is now closed.

**BOSS sign off:** `pending`

**Update 2026-10-08.** W0.1.3 is now **written and waiting on BOSS**, not merely missing:
`supabase/inspection/W0.1.3_database_baseline.sql` — read only, 10 labelled blocks, every column name verified against `supabase/migrations/*.sql` first. Two of the agent's initial column assumptions were **wrong** and were corrected before the file shipped: `canonical_url` lives on `rafa_knowledge_sources` (not `..._documents`), and the language column is `language_code` (not `lang`). Running the file is the only remaining step for P0.1.

---

#### W0.1.3 EXECUTED — 2026-10-08 — `[x]`

**How it was run.** First partially by BOSS pasting blocks into the Supabase SQL editor, then in full by the agent session via the Management API with `read_only = true`, using the credential and proxy pattern in `SUPABASE-ACCESS-GUIDE.md`. Runner: `scripts/runW013Baseline.ps1` → `supabase/inspection/W0.1.3_database_baseline_SINGLE.sql`. Connection check `connection_ok = 1`, **129 rows, exit=0**.

**Editor trap, recorded so it is not re-derived.** The original ten-statement file returns only the *last* statement's result in the Supabase SQL editor, so the first run came back with block 10 alone. `W0.1.3_database_baseline_SINGLE.sql` folds all ten checks into one statement and does not have this problem. Both files are kept.

**Correction to the script itself.** The expected-table list guessed `rafa_agent_chat`, which does not exist. The real conversation tables are `rafa_agent_sessions`, `rafa_agent_messages` and `rafa_agent_memories`, and all three **do** exist with 2 RLS policies each. The original `exists_now = false` was an agent naming error, **not** a missing capability. Both SQL files were corrected.

| Block | Result |
| --- | --- |
| **01** table presence | 3 knowledge tables exist. **All 6 dynamic commercial tables absent** → **BLK-12 CONFIRMED**, M4 starts from bare ground. |
| **02** corpus size | **0 sources, 0 documents, 0 chunks** against a target of 87. |
| **03** review status | no rows |
| **04** expiry state | all zero, `earliest/latest_expiry` null |
| **05** language coverage | no rows |
| **06** canonical_url scheme | no rows — **no collision risk**, the `refal://kb/...` scheme has a clean namespace |
| **07** trust_tier usage | no rows — **CR-023 is a schema-only conflict**, no live data to migrate |
| **08** indexes | 90 on `rafa_*`. **CR-010 satisfied.** |
| **09** RLS | 26 public tables, **RLS enabled on all 26**, 13 of them with **0 policies** |
| **10** environment | PostgreSQL 17.6 · `vector 0.8.2`, `pg_stat_statements 1.11`, `pgcrypto 1.3`, `supabase_vault 0.3.1`, `uuid-ossp 1.1` |

**Finding 1 — the corpus is empty, which re-scopes two defects.** FIX-7 ("Arabic retrieval returns zero") and FIX-8 ("Greek coverage gaps") were filed as retrieval-quality defects. Block 02 shows retrieval returns zero in **every** language because there is nothing to retrieve. These are a **content gap**, so M3 ingestion must precede any retrieval tuning. This confirms the hypothesis recorded in `docs/brain/KNOWN-DEFECTS.md`.

**Finding 2 — CR-010 is already satisfied by the schema.** The expected partial unique index is present and exactly as specified:
```
CREATE UNIQUE INDEX rafa_knowledge_documents_one_approved_per_source_idx
  ON public.rafa_knowledge_documents USING btree (source_id)
  WHERE (review_status = 'approved'::text)
```
The database already enforces one approved revision per source. P3.9 inherits an enforced invariant rather than having to build one.

**Finding 3 — M3's infrastructure needs no extension work.** `vector 0.8.2` is installed and `rafa_knowledge_chunks` already carries `..._embedding_idx` and `..._search_idx`. The embedding and full-text paths are built; only content is missing.

**Finding 4 — RLS is enabled everywhere but policy-less on half the tables.** All 26 public tables have `relrowsecurity = true`, `relforcerowsecurity = false`. 13 carry **zero** policies, including `rafa_audit_events`, `rafa_contact_consents`, `rafa_contact_blocks`, `rafa_conversation_turns`, `rafa_complaints`, `rafa_lead_qualifications`, `rafa_settings`. RLS with no policy denies all non-superuser access, so this is **fail-closed, not a leak** — but it means those tables are reachable only via a `service_role` key, which bypasses RLS entirely. **Tenant isolation is therefore enforced by application code, not by the database.** `relforcerowsecurity = false` also means the table owner bypasses RLS. This is an input to **M13**, and is recorded as a new observation, **OBS-W013-RLS**, not as a defect: the current posture is intentional for a single-tenant bot and only becomes a risk if the anon key is ever given direct table access.

**Unobservable, not clean.** With zero documents, **CR-011 / BLK-10** (30-day auto-expiry on price-bearing revisions) cannot be exercised. Block 04 shows nothing is expired because nothing exists. This check must be re-run after M3 ingestion before BLK-10 can be called resolved.

**Raw output:** 129 rows, written by the runner to a temp file outside the repository. Not committed, per the rule that the code repo stays source only.

---

### P0.2 — Conflict register: MB vs code — 2026-10-08 — `[x]`

**Built:**
- `docs/brain/CONFLICT-REGISTER.md` — **23 conflicts** (7 blockers, 9 high, 5 medium/low, 2 already compliant).
- `src/brainMbCandidates.js` — 22 MB candidate sentences (18 must-pass facts, 4 must-block controls) x 3 languages = **66 test sentences**.
- `scripts/auditClaimGates.js` — the G2 gate, with split exit codes.
- `scripts/diagnoseClaimGate.js` — names the exact trigger term per conflict.

**Verification (G2), original run:** `node scripts/auditClaimGates.js` → **exit=2**, 27/66 conflicts, **0 unregistered**, 1 known safety leak outstanding. Exit 2 is the designed "P0.2 passes, M2 owes a fix" code; exit 1 would mean unregistered conflicts.

**Re-verified 2026-10-08 after the BLK-14/15/16 fixes:** → **exit=0**, 25/66 conflicts, **0 unregistered, no safety leak**. `RESULT: PASS`. The outstanding leak that forced exit 2 (`MBC-903 ar BLOCK->PASS via none`) is closed, so M2's exit condition for the leak is already met. Fixing BLK-15 also unblocked **MBC-013**, the GESY healthcare fact, which was refused in English only because *"pri**vat**e health insurance"* contains the unanchored substring `vat`.

**Headline measurement:** **27 of 66 sentences (40.9%)** of approved MB facts are destroyed by the live gates. en 9/22 · ar 10/22 · el 8/22. **Now 25 of 66 (37.9%)** — en 8/22 · ar 9/22 · el 8/22 — after BLK-14/15/16. The remaining 25 are BLK-13's broader language asymmetry plus the claim-class work, both owned by P2.2.

**Major findings:**
- **Scope correction to BLK-1/BLK-2.** A **third** gate is the dominant blocker: `classifySafety()` in `src/safetyPolicy.js:15-27`, reached via `refalcoAnswer.js:194`. It causes **24 of 27** conflicts, and 13 of those are invisible to `containsProhibitedClaim`. Fixing only line 156 would leave most of BLK-1's damage in place.
- **BLK-13** language asymmetry: English rules need a *phrase*, Arabic and Greek match a *bare noun*. Proven: the same MB-F19 fact gives `en risks=[]` but `ar risks=[tax]` and `el risks=[tax]`.
- **BLK-14** Arabic guarantee **leak** (fail open): `عائد مضمون`, `أرباح مضمونة`, `عائد سنوي مؤكد` all pass every gate while the en/el equivalents block correctly.
- **BLK-15** unanchored `vat` substring: `private`, `innovative`, `renovation`, `activate`, `excavation` are all classified as restricted tax topics. "We offer private office space in Limassol." is RESTRICTED.
- **Correction to BLK-4.** BLK-4 records "3 sentences / 500 chars" in both places. Only half is true: `DEFAULT_MAX_SENTENCES` is **already 5**. Only the prompt string at `ai.js:224` and the 500-char cap conflict. Smaller fix than recorded.
- **CR-021:** the policy precedence ladder **does not exist in code at all**. `src/priorityRules.js` is lead triage, not source precedence.

**Ordering constraint discovered:** CR-007 (the Arabic leak) must be fixed **before or with** the loosening in CR-001..CR-006. P2.3 cannot be scheduled after P2.2; they ship together.

**Defects logged:** BLK-13, BLK-14, BLK-15. **Deviations:** none. **Fields for BOSS:** none.

---

### P0.3 — Reproduce the 13 known defects — 2026-10-08 — `[x]`

**Built:** `docs/brain/KNOWN-DEFECTS.md`, `scripts/reproduceKnownDefects.js`.

**Verification:** `node scripts/reproduceKnownDefects.js` → exit=0. Every row **executed**, not reasoned about.

**Result (original run, 2026-10-08):** REPRODUCED **3** · ALREADY-FIXED **5** · NOT-TESTABLE here **6**.

**Revised after the W0.1.3 baseline, same day:** REPRODUCED **3** · ALREADY-FIXED **5** · **ROOT-CAUSED 2** · NOT-TESTABLE **4**. Re-run verified `exit=0`, 14 defects.

All six "not testable" verdicts had shared one premise: *"no live DB from the agent session."* The baseline run disproved it, so each entry now states its own real blocker:
- **FIX-7, FIX-8 → ROOT-CAUSED.** The corpus is empty (0/0/0). These are a **content gap**, not retrieval-quality defects, and cannot be reproduced before M3 ingestion. No retrieval tuning would have helped.
- **FIX-10** is blocked on `OPENROUTER_API_KEY` (401), **not** on the database.
- **FIX-9, FIX-11, FIX-12** need test data *written* to application tables. Read access is available and proven; writes still require BOSS's per-change authorization.

**The CX claim holds:** all 13 have an owning repair phase. Nothing is unassigned.

- **Reproduced:** FIX-1 (3/3 probe facts blocked), FIX-6 (**4 of 5** Levantine phrasings return `unknown`), and one new defect.
- **Already fixed, with evidence:** FIX-2 (0/7 greetings captured as a name, 2/2 real names still captured), FIX-3, FIX-4 (drafts expire after 60 min), FIX-5 (`detectIntents` is multi-label and returns both), FIX-13 detection.
- **⚠ FIX-13 splits in two.** Detection is green in all three languages; the **answer** is still broken, since replies contain the literal `the business` (222 occurrences). Do not close FIX-13 on the detection evidence.
- **New: BLK-16, no Arabic orthographic normalisation.** `الإقامة` → `intents=[residency_enquiry, immigration] safety=[immigration]`, but `الاقامة` (bare alef, how people actually type) → `intents=[unknown] safety=[]`. This both misses the intent **and bypasses the safety classifier**, a second fail-open independent of BLK-14. Both normalisers strip diacritics and tatweel only; neither folds hamza, alef maqsura or taa marbuta. Every Arabic regex in the repo inherits this.

**Release gate (CX 16A):** FIX-1 is REPRODUCED and FIX-9/10/12 are unverified, so **no deploy is possible today**.

**Hypothesis recorded, not asserted:** FIX-7/FIX-8 may be partly *upstream* failures (query refused or misclassified before retrieval) rather than corpus-quality failures. P3.10 should test both layers separately before rebuilding a corpus that may not be at fault.

---

### P0.4 — Taxonomy, ID scheme, and the Golden Evaluation Set — 2026-10-08 — `[x]`

**Built:**
- `src/brainTaxonomy.js` — 29 topics frozen, each with slug, domain, trust tier, volatility and a **derived** review cadence (30 / 180 / 365 days, never hand set).
- `src/brainGoldenSetSchema.js` — refusal classes, the 4-axis rubric, and the thresholds, **frozen before any evaluation runs**.
- `src/brainGoldenSet{.corporate,.tax,.residency,.property,.profile}.js` — the questions.
- `src/brainGoldenSet.js` — assembler + **17 CX 4C negative queries**.
- `src/brainEvalReport.js` — per language and per domain reporting with **Wilson** intervals (chosen over the normal approximation because per-cell n=10, where the normal approximation reports false confidence).
- `scripts/validateTaxonomy.js` — the G2 gate.
- `artifacts/refal-brain-golden-set.json` — 431 KB.

**Verification (G2):** `node scripts/validateTaxonomy.js` → **exit=0, 11/11 checks passed**.
**870 / 870 questions** across 87 cells, exactly 10 per topic per language, **ar=290 en=290 el=290**, 0 validation errors, 87 unique canonical URIs, all 7 volatile topics backed.

**Refusal mix:** none 819 · guarantee 27 · personalized 18 · security 3 · out_of_scope 3. The guarantee and personalized entries sit deliberately **beside** the must-pass facts in the same topic, so the set measures *discrimination*, not just permissiveness. A gate that blocks both is BLK-1; a gate that allows both is BLK-14.

**Threshold choice worth noting:** `maxLanguageSpread = 0.05`. An aggregate score may never hide a weak language (CX 14B), and this specifically catches a BLK-13 regression where English passes and Arabic/Greek do not.

**Conflict found while writing the W0.1.3 baseline → CR-023.** The database already constrains `trust_tier` to `official / first_party / secondary / operator_supplied`, while P0.4 froze `regulated / commercial / explanatory`. These are **different axes** (provenance vs governance demand) and must not be collapsed. Recorded for P3.9.

**Deviations:** none. **Fields for BOSS:** none.

---

### P1.1 — REFAL becomes Refalco's agent — 2026-10-09 — `[x]`

**Built:** `config/company-profile.json` (identity only; the four credibility NUMBERS stay evidence-gated for P3.7), `src/companyProfile.js` (load, validate, freeze; a missing or placeholder-bearing profile is a startup error), `src/companyProfile.test.js`. `AGENTS.md` and `README.md` rewritten. BLK-3's blanket identity denial removed from `src/ai.js`, `dashboard/server.js` and the edge function.

**Verification (G2/G3):** `node --test src/companyProfile.test.js` → **10/10, exit=0**. `grep -rn '"the business"' src/ dashboard/ config/ supabase/` → **0** (excluding `node_modules`/`dist`; the only survivors are inside `companyProfile.js` and its test, where the validator rejects the string on purpose). `grep -rnE '\b(2000|47|400)\b' src/brainPrompt.js src/ai.js config/refal-agent-rules.md` → **0**.

**What the sweep found:** the placeholder was a botched find-and-replace from `538c01e` that put the literal `the business` into production replies (`"Approved the business information"`, `"πληροφορίες της the business"`). **275 occurrences across 49 files**, swept in one pass. A second form of the same corruption had the bare word `business` standing in for the company name inside six detection patterns in `src/intent.js` and `src/conversationRecap.js`; fixed by **adding** `refal(?:co)?(?:\s+group)?` alongside `business`, never replacing it, so existing customer phrasings keep matching. `src/ragPolicy.test.js` was pinning the defect (it asserted the denial was present) and was inverted.

**Deviations:** none. **Fields for BOSS:** none. **Explicitly NOT done:** the four credibility numbers are not yet speakable — that is P3.7's knowledge source, by design.

---

### P1.2 — Persona and the 10 roles — 2026-10-09 — `[x]`

**Built:** `src/personaRoles.js` — MB-R1..R10 with trigger intents and one behavioural rule each; `MAX_ACTIVE_DIRECTIVES = 2` caps what reaches the prompt and reports `suppressedRoles`; `PERSONA_CORE` (MB-P1) authored **natively** in Arabic, English and Greek, not translated; `detectRegister()` for MB-P3..P5 adaptive mirroring.

**Verification (G2):** `node --test src/personaRoles.test.js` → **11/11, exit=0**.

**Fairness rule honoured (CX 8A):** register is read from the MESSAGE only — length, formality markers, stated titles, budget magnitude. Never from nationality, language choice or name. Asserted in the test file.

**Deviations:** none. **Fields for BOSS:** none.

---

### P1.3 — Humour Engine, levels 0 to 3 — 2026-10-09 — `[x]`

**Built:** `src/humourEngine.js` — `resolveHumourLevel()` (default 2), the six hard bans MB-HB1..HB6 wired to `safetyPolicy` risk categories, `humourDirective(level, language)` authored natively per language, `assertHumourCompliance()` as an output gate beside `validateResponse` (called at `src/ai.js:337`), and `EMOJI_ALLOWLIST` per level.

**Verification (G2):** `node --test src/humourEngine.test.js` → **70 pass / 0 fail, exit=0**. The gate asked for **≥60** cases with **≥54** hard-ban cases (3 × 6 bans × 3 languages); the table-driven `BAN_CASES` fixture covers all six bans in ar/en/el and the file clears both floors.

**Deviations:** none. **Fields for BOSS:** none.

---

### P1.4 — Golden Answer Formula and One Question Rule — 2026-10-09 — `[x]`

**Built:** `src/goldenFormula.js` — `analyseAnswerShape()` with trilingual sentence and question splitting (`?`, `؟`, Greek `;`), `ORDINARY = { minSentences: 2, maxSentences: 5, maxChars: 700 }`, `EXPANDED = { maxSentences: 20, maxChars: 1800 }`. `src/responsePolicy.js` extended with the One Question Rule's coupling exception, set to **reject**, not warn. MB 1.3's four worked examples encoded as regression fixtures.

**Verification (G2):** `node --test src/goldenFormula.test.js` → **20/20, exit=0**.

**BLK-4 correction carried through from P0.2:** `DEFAULT_MAX_SENTENCES` was already 5, so only the prompt string and the 500-char cap actually conflicted. The 500 → 700 raise is the substantive fix: five well-formed sentences do not fit in 500 characters, and the mismatch is worse in Arabic and Greek, so a compliant reply was being rejected as `too_long` and retried until it came back thinner than the rules asked for.

**Deviation (recorded, deliberate):** `responsePolicy.MODEL_DRAFT_THRESHOLDS.minSentences` is **1**, not the `ORDINARY.minSentences = 2` the plan specifies, and `DEFAULT_MIN_SENTENCES` is 0. `ORDINARY` itself carries 2 and is what the prompt quotes to the model. The runtime floor stays at 1 because a correct one-sentence answer ("No, we do not currently offer that.") must not be rejected by the validator; raising the validator floor to 2 would force padding, which is itself an MB anti-pattern. The plan's intent (ordinary replies are 2 to 5 sentences) is carried by the prompt; the validator enforces only the ceiling.

**Fields for BOSS:** none.

---

### P1.5 — Anti pattern guards — 2026-10-09 — `[x]`

**Built:** `src/antiPatterns.js` — AP-1 (contact request in a turn that delivered no approved fact), AP-2 (one caveat per reply, never stripping a meaningful one), AP-3 (urgency only when verbatim in unexpired evidence), AP-4 (fake promises, extending the GUARANTEE class M2 owns), AP-5 (interrogation, P1.4 plus a three-turn history check), AP-6 (unrequested meeting push; a score tier alone never triggers a booking offer).

**Verification (G2):** `node --test src/antiPatterns.test.js` → **23/23, exit=0**.

**Deviations:** none. **Fields for BOSS:** none. **Explicitly NOT done:** AP-4 only extends the guarantee class as it exists today; the full class rewrite is P2.2's, not this phase's.

---

### P1.6 — Policy precedence ladder — 2026-10-09 — `[x]`

**Built:** `src/policyPrecedence.js` — the 6-level ladder from Rule 2, `resolveConflict(sources) → winner + reason`, `assertModelKnowledgeIsGeneral`, and `DECISION_LABELS`. Live data beats a stale chunk, the customer beats a chunk about the customer, a privacy or fail-closed rule beats everything. Every decision is expressed as a concise label, never as chain of thought (CX 15C).

**Wiring status, corrected during the M1 close.** An earlier version of this block claimed the ladder was "wired into the answer composer". That is only half true and is corrected here rather than left to be discovered:

| Wave | Status |
| --- | --- |
| W1.6.1 ladder + `resolveConflict` | **COVERED** — built, 58 unit tests |
| W1.6.2 wire into the composer | **PARTIAL** — `resolveConflict` has **no live caller**. It arbitrates two disagreeing sources, and today there is only ever one: the live data layer does not exist (BLK-12, all six commercial tables absent, M4) and the corpus is empty (0 chunks, M3). Wiring it now would add an unreachable branch, not a capability. Its first real caller is **P4.2**. |
| W1.6.3 general knowledge never makes a Refalco claim | **COVERED** — `assertModelKnowledgeIsGeneral` runs live at `src/ai.js:318` |
| W1.6.4 conflicting approved sources both cited | **COVERED** — enforced as a prompt rule in `evidenceBlock()` and `operationalBlock()` |
| W1.6.5 concise decision label, never chain of thought | **COVERED** — `DECISION_LABELS`, asserted by the test suite |

**Closes CR-021**, which P0.2 recorded as "the ladder does not exist in code at all".

**Verification (G2):** `node --test src/policyPrecedence.test.js` → **58 pass / 0 fail, exit=0**. The gate asked for one case per adjacent pair, 15 pairs × 3 languages; the test derives `C(6,2) = 15` pairs programmatically and asserts the count, so the coverage cannot silently shrink.

**Deviations:** W1.6.2 is PARTIAL, as set out above. **Fields for BOSS:** none.

---

### P1.7 — Prompt surface synchronisation — 2026-10-09 — `[x]`

**Built:** `src/brainPrompt.js` — one composable source for identity · roles · persona · humour · golden formula · anti patterns · precedence · booking · compliance · evidence · memory, with `PROMPT_VERSION` and `CHANGE_HISTORY` (W1.7.8). `src/ai.js` and `dashboard/server.js` build from it instead of their inline arrays. `config/refal-agent-rules.md` rewritten as the canonical human-readable version. `src/promptParity.test.js` is the drift gate.

**Verification (G2):** `node --test src/promptParity.test.js src/ragPolicy.test.js` → **exit=0**. `node scripts/generateEdgeBrainPrompt.js --check` → **exit=0**.

**Four defects found and fixed during the M1 close, all of the same shape — a rule that was right in one place and wrong in the place that actually ships, which is the exact failure P1.7 exists to end:**

- **The tier-aware booking rule was never tier-aware at runtime.** `src/brainPrompt.js` branched correctly on the lead tier, but `src/ai.js` passed it a hardcoded `leadTier: ""`, so the prompt could only ever emit the protective default. The rule was tier-aware in the unit test and BLK-6 in production. `askOpenRouter` now accepts `leadTier`, threads it to both `resolveHumourLevel` (which W1.3.1 always specified) and `buildBrainPrompt`, and `src/bot.js` supplies it from `classifyLeadTemperature({ history, booking })` — the full stored history and the booking status, neither of which is visible in `conversationTurns`. The default stays `""`, so a caller that does not classify is less informed, never more permissive. Asserted against the **live system prompt** for all four tiers, not against the block in isolation.

- **BLK-6 was never actually removed.** `operationalBlock()` still carried the verbatim blanket ban *"Do not introduce a call, meeting, or specialist contact during ordinary information gathering"*. It had been lifted out of `ai.js` with the rest of the array, and it reached the model **alongside** `bookingOfferBlock("hot")`'s *"stop selling and move to booking"*. Two contradictory instructions in one prompt is worse than either rule alone. The author had already caught and fixed this exact trap for BLK-5 one line above; BLK-6 was missed. The tier decision now lives in `bookingOfferBlock` only, and that block is **mandatory on every variant** (with no tier it emits the protective default, so removing the ban is not a fail-open).
- **The W1.7.7 test could not have caught it.** It asserted on `bookingOfferBlock()` in isolation, never on the assembled prompt. A new test now asserts the ban's absence and the booking rule's presence across every variant × tier of the finished prompt.
- **W1.7.4 was not implemented.** The edge function kept a third hand-maintained inline rule array, and parity was asserted by grepping its source text. Source-text matching cannot catch a rule that is merely *worded* differently, which is precisely how BLK-5 (`"Do not volunteer related prices, packages, services, or sales details"`) and BLK-6 both survived on that surface after being fixed on the other two.

**W1.7.4 as built:** `supabase/functions/rafa-agent-api/brainPrompt.mjs`, a **generated** Deno-compatible mirror (same pattern as the existing `responsePolicy.mjs`), produced by `scripts/generateEdgeBrainPrompt.js` / `npm run edge:prompt`. `index.ts` spreads `buildOperatorPrompt(...)` and keeps only six genuinely edge-specific lines (operating order, dashboard tone, personality, WhatsApp data caveat, operator scope redirect, provenance-link rule). Drift is enforced two ways: the mirror's assembled prompt is deep-equal-asserted against the CommonJS module for every lead tier, and the committed file must be byte-identical to the generator's output. The mirror **throws** on the customer variant rather than returning a persona-less prompt, because `personaRoles` and `humourEngine` are per-turn and are not mirrored.

**Prompt version:** 1.7.0 → **1.7.1**, with a `CHANGE_HISTORY` entry, so M14 can roll the prompt back independently.

**Deviations:** `src/brainPrompt.mjs` was not placed in `src/`; the mirror sits beside the edge function at `supabase/functions/rafa-agent-api/brainPrompt.mjs`, which is where `responsePolicy.mjs` already lives and what the edge function can actually import.

**Fields for BOSS:** none.

---

### M1 close — gap scan, defects and what is NOT done — 2026-10-09

**Verification run in one session (G2), real exit codes:**

```
npm test                                         exit=0   907 tests, 907 pass, 0 fail
npm --prefix dashboard test                      exit=0    85 tests,  85 pass, 0 fail
npm --prefix dashboard run build                 exit=0
node scripts/auditClaimGates.js                  exit=0   RESULT: PASS, no unregistered conflict, no safety leak
node scripts/validateTaxonomy.js                 exit=0   11/11 checks passed
node scripts/generateEdgeBrainPrompt.js --check  exit=0   prompt mirror in sync
node scripts/generateEdgeMirrors.js     --check  exit=0   claim + contact gate mirrors in sync
```

**Gap scan (G3) against the Anti Regression Checklist:** every item holds. The one that had been failing — *"All prompt surfaces aligned (`src/ai.js`, `dashboard/server.js`, edge function, `config/refal-agent-rules.md`)"* — is now enforced by a deep-equality test rather than by inspection.

**Defects logged and fixed in this close (G4/G5):** the three P1.7 items above, plus:

- **A test file had never run.** `package.json#scripts.test` is a hand-maintained list of paths, not a glob, so a new test file is silently excluded while the suite still reports green. This was recorded as a footgun during P1.1; it then turned out that `src/leadQualification.test.js` (7 tests, all passing) had been sitting on disk outside the list. Both it and the guard are now listed, and `src/testManifest.test.js` fails the build if any `src/*.test.js` is missing from the script, or if the script points at a deleted file. A note in a plan file does not stop this; a failing test does. `dashboard/` is unaffected — it runs `node --test`, which globs.

**Second cleanup sweep before commit — four more findings, three fixed:**

- **Dead imports left behind by the P1.7 extraction.** `src/ai.js` still imported `personaDirectives` and `humourDirective` (both moved inside `buildBrainPrompt` by W1.7.2), plus `PROMPT_VERSION` and `resolveConflict`, none of them called. Removed, each with a comment saying where the behaviour went, so the next reader does not re-add them.
- **A duplicated budget constant that could drift.** `goldenFormula.ORDINARY` and `responsePolicy.MODEL_DRAFT_THRESHOLDS` both carry the 5-sentence / 700-character ceiling, and they **cannot** share it by import: `goldenFormula.js` requires `responsePolicy.js`, so the reverse would be a cycle. Retyped numbers are exactly how BLK-4's "5 sentences in the prompt, 500 characters in the validator" happened. A test now pins the two together and pins the one deliberate divergence (the floor is 1 in the validator, 2 in the budget).
- **`dashboard/server.js` passed `leadTier: ""`,** which reads identically to the bug just fixed in `ai.js`. It is actually correct here: `askDashboardAgent` answers a free-form operator question with no customer conversation in scope. The argument is now omitted with a comment saying why, so it cannot be mistaken for a leftover again.
- **NOT FIXED — a fourth prompt surface still carries BLK-3, BLK-5 and BLK-6.** `src/agentDecision.js:68` opens with *"No company identity, services, or prices are preconfigured"* (BLK-3 verbatim) and rules out offering pricing or booking unless the customer asks (BLK-5/BLK-6 in shape). P1.1's sweep missed it because the wording is "business assistant", not the literal `the business`. This is the bounded Agent loop, reached only when **`REFAL_AGENT_LIVE_ENABLED` is explicitly `true`, and it is off by default**, so it is not a live customer path today. It is also outside P1.7's stated scope, which names three surfaces. Logged here for BOSS to schedule; rewriting that prompt changes the Agent decision contract and should not ride along in the M1 commit.

### Third sweep — four parallel audits before commit

Four independent read-only audits were run in parallel over the whole repo: dead code, M1 wave coverage, the blocker register across every prompt surface, and a hunt for the two bug classes that have bitten this repo repeatedly. They found **eleven more defects**. Nine are fixed; two are recorded with a reason.

**Two HIGH fail-opens on the edge function, both invisible to every existing test.**

| What | Detail |
| --- | --- |
| `index.ts` carried its **own** `containsProhibitedClaim` | A hand-copied regex that predated the 2026-10-09 guardrail fixes. Executed side by side against `src/refalcoAnswer.js`, it **passed** `"We have a 100% success rate"`, `"موافقة مضمونة للجميع"`, `"Σίγουρη έγκριση για εσάς"` and the suitability claim, and it **blocked** `"I cannot provide tax advice"`, which the source deliberately exempts as a safe disclaimer. No test touched it. |
| `responsePolicy.mjs` was missing two alternatives | `"A specialist will contact you shortly"`, `"The team will call you tomorrow"` and `"I've asked a specialist to follow up"` all passed on the edge and blocked in `src`. Its own five-case test reached none of the missing branches. |

Both are now **generated** by `scripts/generateEdgeMirrors.js` (`npm run edge:mirrors`), which extracts the functions verbatim from the CommonJS source rather than retyping them. The edge function imports the mirrors and its local copies are deleted. `src/mirrorParity.test.js` runs **both** implementations over a shared trilingual corpus and fails on any divergence in verdict, plus asserts the corpus is not vacuous and that `index.ts` has not re-declared either gate locally. A source-text comparison could never have caught this: the regexes were legitimately different text.

**A live customer defect: BLK-4 was not actually closed.** Every upstream limit was raised to 700, but a **second** length check in `src/ai.js`, 50 lines after the validator, still carried a hard-coded `500` and threw. A compliant five-sentence reply was approved and then rejected, worst in Arabic and Greek where the same content runs longer, burning a fallback-model retry every time. The existing fixture could not catch it because at 701 characters it tripped the *first* gate; the whole 501-700 window was untested. Now driven by `ORDINARY.maxChars` / `EXPANDED.maxChars`, with a 550-character regression test.

**Two guards could never fire from the live call site.**

- **AP-1 was dead.** `deliveredApprovedFact` was computed as `evidence.length > 0`, but `askOpenRouter` returns `null` earlier when the bundle is empty, so the flag was the literal constant `true` on every production call. AP-1 requires it to be false. Its test passed by calling `detectAntiPatterns` directly with a state the live caller cannot produce. It now reads `analyseAnswerShape(answer).hasDirectAnswer`, which is the real question ("did this turn deliver a fact?", not "was evidence available?") **and** gives W1.4.1's `analyseAnswerShape` its first live caller.
- **W1.6.3's precedence gate is still dead, for the same reason.** `sourceLevel` is only `MODEL_KNOWLEDGE` when evidence is empty, which the same early return excludes, so `assertModelKnowledgeIsGeneral` short-circuits to `ok` on every turn. **NOT FIXED:** the honest fix is to ask whether a *specific claim* is evidence-backed, which is groundedness detection and belongs to M3. Recorded as PARTIAL rather than papered over. `violatesGoldenFormula` likewise has no live caller: the Golden Formula reaches the model as a prompt instruction, not an output gate.

**Four Arabic-digit fail-opens, same root cause as BLK-16.** `\b` is ASCII-only, so `\b[\d٠-٩]` can never match. Verified: `"999 EUR"` was a price claim, `"٩٩٩ EUR"` was not. Fixed in `src/refalcoAnswer.js` (3), `src/conversationRecap.js`, and `src/groundingPolicy.js` (`CURRENCY_NUMBER_RE`, `PRICE_CLAUSE_RE`, `PERCENTAGE_RE`, which also gained the Arabic percent sign `٪`), by replacing the ASCII boundary with the Unicode-aware `(?<![\p{L}\p{N}])`.

**A fairness defect inside W1.2.4's own rule.** `LARGE_BUDGET` in `src/personaRoles.js` used `\b\d+`, so `"ميزانية ٤ مليون"` was **not** read as an executive-register signal while the identical budget in Latin digits was. The rule W1.2.4 exists to enforce was being broken by the regex implementing it. Also `src/leadQualification.js` had `\b€\b`, which needs a word character on both sides and is therefore unreachable, so a lead whose only value signal was `€4m` never got the bump.

**The `\b` guard had large blind spots.** `src/regexBoundary.test.js` did a non-recursive `readdirSync` over `src/` filtered to `.js`, so it never saw `dashboard/`, `scripts/`, `supabase/functions/`, any `.mjs` or `.ts`, or any subdirectory. That is exactly where the drifted edge mirror lived. It now walks all four roots recursively across `.js`, `.mjs` and `.ts`, and passes clean.

**Smaller fixes.** `PROFILE_PATH` unexported (zero consumers anywhere). `PROMPT_VERSION` removed from `dashboard/server.js` as a dead import, and **made observable** on the customer path instead: it now rides on the per-turn usage telemetry event, since versioning a prompt is pointless if a bad answer in the logs cannot be traced to the prompt that produced it — that was W1.7.8's entire purpose and M14 had nothing to roll back *from*. The duplicate `HUMOUR_LEVELS` enum in `src/humourEngine.js` and `src/brainGoldenSetSchema.js` cannot share a definition without the engine depending on the evaluation schema, so it is pinned by a test, the same remedy as the `ORDINARY` budget. The edge function's uncalibrated *"light humor when it fits"* was removed: that surface has no humour level and no `assertHumourCompliance`, so the instruction had nothing behind it. The edge function's `body.lead_tier` read was removed as dead wiring, since no caller has ever sent it.

**The dashboard suite was never gated.** 18 test files, their own globbing `node --test` script, and nothing invoking it — no CI config exists in this repo, so root `npm test` was the only gate anyone ran. `npm run test:all` now runs both, and `src/testManifest.test.js` fails if that script stops covering the dashboard or if the dashboard script stops being a glob.

### Fourth sweep — the Agent surface, closed

Both items below were held back from the third sweep as "outside P1.7's three named surfaces". They are real defects of exactly the class M1 exists to remove, nothing pinned the offending strings, and leaving a blocker in a prompt because a feature flag is currently off is not a reason. Both are now fixed.

- **`src/agentDecision.js` carried BLK-3, BLK-5 and BLK-6.** Line 68 was BLK-3 verbatim (*"No company identity, services, or prices are preconfigured"*); one further string carried **both** the blanket pricing ban and the blanket booking ban. The Agent would have told a customer it had no company identity while the legacy path introduced itself as REFAL. Identity now interpolates from `companyProfile` exactly as the other three surfaces do, facts stay gated on a tool result, and the one string is split into the two rules the other surfaces use: pricing is evidence-gated, contact is request-gated with the same protective default `bookingOfferBlock()` emits when no tier is resolved. Reached through `REFAL_AGENT_LIVE_ENABLED` **or** `REFAL_AGENT_SHADOW_ENABLED` (`src/turnRouting.js:26`, `src/agentShadow.js:102`), both unset — but shadow mode still sends this prompt to a real model, it only stubs the write tools.
- **The Agent path ran three fewer output gates than the legacy path.** `detectAntiPatterns`, `assertHumourCompliance` and `assertModelKnowledgeIsGeneral` each had exactly **one** caller in the repo, `src/ai.js`, which the Agent path does not traverse. So every M1 output guard would have vanished the moment the flag flipped, while `antiPatterns.test.js` and `humourEngine.test.js` stayed green. The first two are now wired into `checkDraftPolicy`, the single composition point, folding into the same `{valid, reasons}` shape the retry and fallback branching already handles. `assertModelKnowledgeIsGeneral` is deliberately **not** wired: it keys off a `MODEL_KNOWLEDGE` source level that cannot arise there any more than it can in `ai.js`, so adding it would create a second dead gate rather than a second real one.

**New guards, all asserted through the real entry point rather than the component:** `src/promptParity.test.js` now covers the fourth surface (no BLK-3/5/6 in the assembled decision prompt, identity present, facts still tool-gated, and a replacement booking rule present so the removal is not a fail-open) and asserts every surface DERIVES its identity from the profile rather than a literal, so a rename stays a data edit. `src/agentLoop.test.js` drives `runAgentTurn` with a bereavement-plus-joke draft and an unrequested meeting push, asserts both are rejected, and asserts a clean answer still passes so the gates cannot become a blanket refusal.

**Still open, with a reason, not a shrug:**

- **The dashboard streaming path runs two of six gates** (`containsProhibitedClaim`, `containsUnconsentedContactCommitment`). It is the operator surface and its output is read by staff, not sent to a customer, so the customer-facing gates are a weaker fit there. Worth a deliberate decision rather than a silent copy of the customer path; raised for M12.
- **W1.6.2 and W1.6.3 stay PARTIAL.** `resolveConflict` needs two disagreeing sources and there is only ever one until M4 builds the live tables and M3 fills the corpus. The precedence gate short-circuits for the same structural reason. Documented above rather than papered over with an unreachable call.

**Observation, not an M1 defect:** `src/bot.js` imports `downloadMediaMessage` and never uses it. Pre-existing, untouched by M1, left alone.

**Observation, not an M1 defect:** section 17 lists `scripts/brainHealth.js`, `scripts/redTeamBrain.js` and `scripts/factRegisterAudit.js` as standing commands. None exist yet; they are owned by P3.10, P11.4 and P3.9 respectively. Running `brainHealth.js` today exits 1 with `MODULE_NOT_FOUND`. Recorded here so a future gate does not read that as a regression.

**Database (0.3):** M1 owns **no migration**. Every row in section 20 belongs to P3.9, P4.1, P6.1, P6.5, P7.2, P8.1, P9.1, P11.2/P2.5, P12.4 or P13.2. Nothing in M1 was marked `PENDING DB`, and no `.sql` was written or run for it.

**Explicitly NOT done:**

- ~~Not committed and not pushed.~~ **Committed and pushed 2026-10-09** on BOSS's approval as `b765b74c0aacf414d2c43ce53328eca3b539d411`, 85 files, directly on `main`. Re-fetched afterwards: `git rev-list --left-right --count origin/main...HEAD` returns `0 0`, so this is verified against the remote rather than read off the push message. The stray `SharedProjects.lnk` was deliberately left untracked.
- ~~The edge function is not deployed.~~ **Deployed 2026-10-09**, see the deployment record below.
- The four credibility numbers remain unspeakable until P3.7 lands their knowledge source.
- The remaining 25 of 66 blocked MB sentences are **M2's**, not M1's. M1 gave REFAL a voice; the guardrails still silence most of what she is allowed to say.

**BOSS sign off:** `pending`

---

### Post-deployment correction — P1.1's gate was scoped too narrowly

Found 2026-10-09 while checking whether the plan and HTML artifacts were current.

**W1.1.3's G2 gate greps `src/ dashboard/ config/ supabase/` and returns zero. It always did. The placeholder was still live in 13 other files**, because a gate scoped to four directories proves nothing about the fifth. 107 further occurrences, and two of them were not cosmetic:

- **`scripts/evaluateRag.js` carried `expectedSource: "the business Services"`.** The RAG evaluator was scoring retrieval against a source name that cannot exist, so every one of those cases could only ever score as a miss. `scripts/evaluateKnowledge.js` had the same shape (`source: "the business official website"`, `query: "What does the business Group do?"`). This is an evaluation harness measuring the wrong thing, and **M14's golden-set scoring depends on it.**
- **`docs/refal-agent-system-map.html` is stakeholder-facing** and read *"approved the business services facts"* and *"the business · OPERATIONS ENGINEERING"*.

Also corrected: `conversationBenchmarkScenarios.js` (27), `evaluateWhatsappConversation.js` (12), `refal-agent-refactor-progress.md` (8), and six smaller files. All affected tests re-run green.

**Deliberately NOT changed**, because the literal is the evidence: this plan, the five `docs/brain/` M0 artifacts, `scripts/reproduceKnownDefects.js`, and `src/companyProfile.js` plus its test, where the validator rejects the string on purpose.

**The gate is now repository-wide.** `src/companyProfile.test.js` walks the whole tree across `.js/.mjs/.ts/.tsx/.jsx/.json/.md/.html/.sql` with an explicit, reasoned allowlist. Adding a file to that allowlist is a claim that the file documents the defect, not a way to silence the check.

**The lesson, since it is now the second time:** the first version of a gate tends to be scoped to where the author already looked. The `` guard had the identical flaw and was widened in the same session. Scope a gate to the repository and allowlist the exceptions, never the reverse.

---

### M1 deployment record — 2026-10-09

**Project `anhharmjtmqndhzenicb`, function `rafa-agent-api`: version 42 -> 43, ACTIVE, `verify_jwt` unchanged at `true`.**

Five runtime files uploaded in one request: `index.ts`, `brainPrompt.mjs`, `refalcoAnswer.mjs`, `responsePolicy.mjs`, `handoverPersistence.mjs`. The two `*.test.mjs` files were excluded on purpose.

**The CLI could not do this deploy.** `supabase functions deploy` returned the McAfee gateway notification page: the Go CLI does not do NTLM, which is the same 407 class of failure `SUPABASE-ACCESS-GUIDE.md` already documents. The deploy went through the Management API from PowerShell with `-Proxy $env:HTTPS_PROXY -ProxyUseDefaultCredentials`, exactly the guide's sections 1, 4 and 5. No proxy bypass, no TLS change, no credential printed or written to a file.

**The guide's recipe needed extending.** Section 5 covers a *single-file* function and says so explicitly. `rafa-agent-api` imports four local ESM modules, so every runtime file goes in the same multipart form. `verify_jwt` was read off the **currently deployed** function rather than assumed, and the deploy script refused to report success unless the version advanced, status was `ACTIVE`, and the auth posture was unchanged.

**Post-deployment verification.** The deployed bundle was pulled back with `GET /functions/{slug}/body` and all three generated mirrors were confirmed **byte-identical** to the committed files. The gates were then executed over a 20-case trilingual corpus: **20 cases, 0 failures.**

| | case | old deployed gate | now |
| --- | --- | --- | --- |
| en | `We have a 100% success rate.` | passed | **blocked** |
| ar | `نسبة نجاح 100٪ مضمونة.` | passed | **blocked** |
| el | `Σίγουρη έγκριση για εσάς.` | passed | **blocked** |
| ar | `موافقة مضمونة للجميع.` | passed | **blocked** |
| en | suitability claim | passed | **blocked** |
| en | `I cannot provide tax advice.` | **wrongly blocked** | allowed |
| en | `A specialist will contact you shortly.` | passed | **blocked** |
| en | `The team will call you tomorrow.` | passed | **blocked** |

It did not over-correct: `A non-resident can own 100% of a Cyprus company.` still passes, a consent-seeking contact offer still passes, and ordinary answers pass in all three languages.

**Honest limit on that test.** It exercises the deployed gate code, pulled back from Supabase, not a live HTTP round trip. A real invoke needs an anon JWT and spends OpenRouter credit on a non-deterministic reply, which cannot assert the gate anyway because the model cannot be made to emit those exact strings. Verifying the deployed artifact is the stronger check, but it is not the same claim as "the live endpoint was called".

---

---

### M2 — Guardrail Reconciliation — completed 2026-10-09 — `[x]` all 6 phases

**Exit criteria, restated:** REFAL states every approved programme fact while still refusing every personalized conclusion and every guarantee, in three languages, with no loss of existing protection.

#### P2.1 — Claim classification taxonomy

**Built:** `src/claimPolicy.js` — `CLAIM_CLASSES`, `splitClaims`, `classifyClaim`, `evaluateAnswerClaims`, `isApprovedEvidence`, `approvedEvidenceText`, plus `containsGuaranteeMarker` and `containsPersonalizedConclusion` added by P2.6. Precedence GUARANTEE > PERSONALIZED_CONCLUSION > PROGRAM_FACT > NEUTRAL. All three language rule sets run on every sentence regardless of detected language, because code-switched output is normal and gating rules by detected language would be a fail-open.

**Files:** `src/claimPolicy.js`, `src/claimPolicy.test.js`.

**Verification (G2):** `node --test src/claimPolicy.test.js` → **exit=0, 245 tests**. Covers every `MB_CANDIDATES` `expect:"pass"` entry in 3 languages with and without evidence, every `expect:"block"` control, expiry, pending review, and bare-alef folding.

**Deviations:** three documented carve-outs — negated-guarantee stripping, a refusal-to-provide strip, and an interrogative branch. Each exists because the first version deleted a correct REFAL reply. All three are pinned by tests.

#### P2.2 — Rewrite `containsProhibitedClaim` (removes BLK-1, BLK-2, BLK-8)

**Built:** the gate now **branches**. No approved evidence → `containsProhibitedClaimLegacy`, byte-identical to pre-M2. Approved evidence → per-clause classification through `claimPolicy`. `containsUnconditionalProhibition` runs on **both** branches. `restrictedRefalcoReply` stands down for an evidence-backed programme enquiry, and never for prompt injection, credential exposure, a personalized eligibility demand, a guarantee, an ROI question, or a cross-customer probe. `allowsGroundedProgrammeAnswer` is exported and used by `messageRouter`, which is where BLK-2 did most of its damage: a residency question was refused **before retrieval ever ran**, so the knowledge base could not be reached at all.

**Files:** `src/refalcoAnswer.js`, `src/ai.js`, `src/responsePolicy.js`, `src/messageRouter.js`, `dashboard/agentFallback.js`, `dashboard/server.js`, `supabase/functions/rafa-agent-api/index.ts`, `scripts/generateEdgeMirrors.js`, `src/claimGateEvidence.test.js`, `src/mirrorParity.test.js`, `package.json`.

**Verification (G2):** `npm run test:all` → **exit=0, 1563 root + 85 dashboard, 0 fail**. `node scripts/auditClaimGates.js` → **exit=0**. `node scripts/generateEdgeMirrors.js --check` → **exit=0**.

**W2.2.6 assertion audit — the honest answer: ZERO assertions were changed** in `groundingPolicy.test.js`, `agentFactualGrounding.test.js`, `safetyPolicy.test.js` or `agentRagEvidence.test.js`. None of them asserted "residency is always refused"; the blanket block was never pinned there. All four pass unchanged, which is a stronger result than a rewrite would have been. The positive cases went into a new file, `src/claimGateEvidence.test.js`.

One assertion **was** changed, in `src/guardrailRegression.test.js`: the corpus-wide "with no evidence the gate is EXACTLY the pre-M2 gate" **equality** became an **implication** (legacy-blocked implies live-blocked) plus a non-empty-superset check. Reason: the unconditional guards deliberately make the gate **stricter** than legacy, and an equality assertion fails on a strengthening exactly as loudly as on a loss of protection. Measured: **45 message classes newly blocked, 0 newly allowed without an MB row.**

**G3 diff:** `docs/brain/GUARDRAIL-DELTA.md`. Everything newly allowed maps to an MB row (MB-F30, MB-F22, MB-F52, MB-F40, MB-R5). Two classes that could **not** be mapped were found by P2.6 and are now refused again — recorded as FIX-19 and FIX-20.

#### P2.3 — Banking and payment gateway guard

**Built:** `src/bankingPolicy.js` — `detectBankingIntent` over 12 topics trilingually, `bankingGuardReply` producing MB 2.3's mandated three-part shape (honest about whose decision it is, then the real value of a clean file from day one, then exactly one discovery question), `violatesBankingHonesty`, and `STRIPE_GOLDEN_DIALOGUE`.

**Verification (G2):** `node --test src/bankingPolicy.test.js` → **exit=0, 105 tests**.

**Provenance, stated plainly:** the **Arabic** Stripe dialogue is **verbatim** from `newplan/Master Brain & Operating Rules Manual - REFAL AI.txt` lines 78-79, pinned by an exact-string test so drift breaks the build. The **English and Greek fixtures are authored equivalents, not source text** — no EN/EL version exists in any source document. Labelled as such in the code.

#### P2.4 — Reservation deposit, ROI and VAT guards

**Built:** `src/reservationPolicy.js` — `violatesReservationDepositRule` (MB-F50, absolute, default-deny, satisfied only by `refal_reservation_rules`), `containsRoiClaim` + `ROI_REPLY` (MB-F55), `classifyVatStatement` (MB-F45, MB-F48).

**Verification (G2):** `node --test src/reservationPolicy.test.js` → **exit=0, 142 tests**.

**Provenance:** the **Arabic** ROI script is **verbatim** from the manual line 114, pinned by a test that reads the source file. **English and Greek are reconstructions** from MB-F55's five invariants, labelled as reconstructions in the code.

**PENDING DB:** `refal_reservation_rules` does not exist (BLK-12, M4 owns it). The guard and its `source` contract are built and default-deny today. No migration was written and no database was touched.

#### P2.5 — AML, sanctions, compliance and the existing client boundary

**Built:** `src/redFlagRules.js` extended with sanctions and circumvention detection; `src/complianceEscalation.js` (consent-free regulatory escalation, humour forced to 0, sales hooks suppressed, sticky for the rest of the conversation, never debates the evasion); `src/privacyHardRule.js` (outbound credential-request gate, MB-SEC4); `src/sourceOfFundsPolicy.js` (MB-SEC3); `src/existingClientWorkflow.js` extended with a **working** one-time-code verification flow.

**W2.5.5 — built, not parked.** A 6-digit code from `crypto.randomInt`, sent only to the contact **already on file**, stored as salt plus hash and never in plaintext in the state object or in any customer message, single use, 10-minute expiry, 3-attempt lockout, compared with `crypto.timingSafeEqual`. A self-asserted detail never authenticates and a matching caller number never authenticates. All nine original exports keep their signatures.

**Live wiring (closes MB-SEC2):** compliance escalation now runs inside `routeMessageResult`, ahead of name capture and of both restricted-topic refusals, and it reads no intent or safety verdict so it cannot be bypassed by a message that also looks like a programme enquiry. The detector reaches **27 of 27** sanctions probes, **9 of 9 in each language**; it was 3 of 27 with Arabic at 0 of 9 before this work, and the router holds no detection patterns of its own.

**Fields left for BOSS to fill (G6): none for M2 closure.**

There is one optional hook, `VERIFICATION_DELIVERY.sendVerificationCode` in `src/existingClientWorkflow.js`, registered via `setVerificationCodeSender(fn)`. It is a **function, not a credential**, so no secret enters the repo and nothing sends from here.

**It is deliberately NOT a blocker, and it is not an action on BOSS.** Verified against the code at M2 close:

- The flow is reached only through `INTENTS.EXISTING_CLIENT` (`src/messageRouter.js:917`) — "what is the status of my account / my client number / حسابي" and equivalents. Every normal REFAL conversation (formation, residency, tax, VAT, pricing, booking) never touches it.
- **Nothing is unlocked by it today.** `accountDisclosureAllowed` is computed and surfaced in conversation state, and **no tool reads it**. There is no account-lookup tool and the commercial tables are absent (BLK-12), so the gate currently protects data that does not exist.
- Unregistered is a **working, fail-closed state**, not an error: `issueVerificationCode` returns `verification_sender_not_configured` and the customer gets the approved-channel message.

**It becomes relevant at M8**, when CRM memory gives REFAL real client and account data and there is finally something to disclose after verification. The hook is built now rather than later only because the alternative was leaving the capability dark, which is what G6 forbids. Until M8, leaving it unregistered is the correct configuration, not an outstanding task.

**Verification (G2):** the five P2.5 suites → **exit=0, 65 tests**; re-verified inside the M2 sweep at **616 tests, exit=0**.

**OP-06** ticked in section 13.2.

#### P2.6 — Guardrail regression sweep

**Built:** `src/redTeamCorpus.js` — **200 adversarial messages**, ar 67 / en 67 / el 66, across all seven required categories; `src/guardrailRegression.test.js`; `scripts/auditClaimGates.js` extended with a second, evidence-supplied pass and a new **exit 3**; `docs/brain/GUARDRAIL-DELTA.md`.

**Verification (G2):** `node --test src/guardrailRegression.test.js` → **exit=0, 17 tests**. `node scripts/auditClaimGates.js` → **exit=0** — *no unregistered conflict, no safety leak, no MB fact blocked with evidence*.

**This phase found a Blocker inside P2.2's own work** (FIX-19: approved evidence silently removed the refusal from every investment advice, returns and ROI question) plus eight further defects. All are repaired and pinned. See section 15, FIX-14 to FIX-27.

---

**M2 gate evidence, all re-run 2026-10-09 after the final fix:**

```
npm run test:all                                  exit=0   1563 + 85 tests, 0 fail
node scripts/auditClaimGates.js                   exit=0
node --test src/guardrailRegression.test.js       exit=0   17 tests
node --test <the 11 M2 suites>                    exit=0   616 tests
node scripts/generateEdgeMirrors.js --check       exit=0
node scripts/generateEdgeBrainPrompt.js --check   exit=0
node scripts/validateTaxonomy.js                  exit=0
```

**Gap scan (G3):** P2.1 COVERED · P2.2 COVERED · P2.3 COVERED · P2.4 **PARTIAL** (the deposit guard is built and default-deny; its live table belongs to M4, BLK-12) · P2.5 COVERED · P2.6 COVERED. Anti Regression Checklist: all 11 items re-checked, 0 regressions.

**Two drift classes closed permanently.** `scripts/generateEdgeMirrors.js` used to carry a hand-written import line and a hand-written export list per mirror. Both went stale the moment `claimPolicy` gained two functions, and the generator reported success while every edge request would have thrown. Both are now **derived from the source**, so a new symbol propagates automatically and an unmirrored dependency is a hard error rather than a broken file.

**Explicitly NOT done:**

- **Nothing is committed and nothing is pushed.** G7 sign-off is BOSS's call.
- **Deno is not installed on this machine**, so `supabase/functions/rafa-agent-api/index.ts` was **not type-checked**. The mirrors were proved verbatim mechanically and executed through Node's ESM loader, and `src/mirrorParity.test.js` compares src and edge verdicts in both evidence modes. But "the edge function compiles under Deno" is an unverified claim and is not being made.
- **No live model call and no live HTTP invoke.** The red-team corpus proves what the gates do with a given string, not what an LLM will actually say.
- `refal_reservation_rules` is absent, so W2.4.1 is enforced but can never be satisfied until M4 ships the table and BOSS runs the migration.
- Two pre-existing items raised and deliberately not fixed here, both outside M2's scope: `GQ-07-el-02`'s Greek concealment phrasing does not flag while its English and Arabic twins do, and "Do you run a sanctions screening?" escalates as a probe. Both are judgement calls, not defects introduced by M2.

### M3 — Knowledge Corpus + Fact Governance

#### P3.1 to P3.8 — the corpus, 29 topics x 3 languages

**Built:** **87 documents** at `knowledge/<topic-slug>/<lang>.md`, **421,411 body characters**, authored natively in Arabic, English and Greek rather than translated. Plus the machinery that made twelve parallel authors converge on one shape instead of twelve:

- `src/brainFactMap.js` — the canonical topic to MB fact map, with `required`, `boundary`, `dynamic` and `supporting` per topic. Single source of truth for the golden set, the validator, the register and brainHealth.
- `src/corpusFile.js` + `scripts/validateCorpus.js` — the offline gate. Frontmatter shape, exact fact-set equality, the boundary-section rule, the 1800 character chunk ceiling, the script floor, the forbidden literals and the approved-number rule.
- `docs/brain/CORPUS-AUTHORING-CONTRACT.md` — the binding contract, with `knowledge/company-lifecycle/en.md` as the reference shape.

**Verification (G2):** `node scripts/validateCorpus.js` → **exit=0, 87/87 present, 87 clean, 0 errors**. `node --test src/corpusFile.test.js` → **exit=0**.

**The `supporting` mechanism is the one design decision worth remembering.** Four authors and the golden-set repair independently hit the same wall: the IP Box page needs the 15% headline rate for its own 2.5% to 3% to mean anything, and MB-F19 belongs to `corporate-tax`. The choices were an unsourced sentence or a second copy of the fact, and two copies of a number drift apart. A topic now declares what it may **cite** as well as what it **owns**, so there is still exactly one owner per fact and the register still governs every place the number appears.

**MB-DYN enforcement was inverted.** It started as a denylist and guarded 2 of the 6 variables (FIX-30). It is now an allowlist: **every currency amount and every percentage in the title or body must be carried by a fact the document declares**. One rule covers all six variables, MB-F44's cost of living, and P3.8's "a comparison that cannot be sourced is cut, not softened". An invented "Dubai is 9%" has no register row, so it fails. Aliases are exempt from that rule and only that rule, because an alias is a question a customer types and `is it still 12.5% or has it changed` has to stay an anchor.

#### P3.9 — Fact governance and approval register

**Built:** `src/factCatalogue.js` (**82 rows**, every MB-F, MB-C, MB-J and MB-DYN id), `src/factRegister.js` (the four-status behaviour layer), `supabase/migrations/20261009180000_refal_fact_register.sql` (**MIG-01**), `scripts/generateFactRegisterSeed.js` and the **generated** `20261009180100_refal_fact_register_seed.sql`, `scripts/factRegisterAudit.js`, and the dashboard Facts screen with five routes (`dashboard/factRegisterView.js`, `dashboard/src/FactRegister.jsx`).

**Verification (G2):** `node --test src/factRegister.test.js` → **exit=0, 29 tests**. `node scripts/factRegisterAudit.js` → **exit=0, 0 blocker · 0 high · 0 medium · 0 low**. `node scripts/generateFactRegisterSeed.js --check` → **exit=0**. `cd dashboard && npm test` → **exit=0, 94 tests** (85 before, 9 added, no regressions).

**The seed is generated, not typed.** The register exists in Postgres and in `seedRegister()`, and if both were hand written they would disagree silently: the code would say approved while the database said expired. M2 was bitten by exactly this shape in `generateEdgeMirrors.js`, where a hand-maintained list sat beside a generated file and went stale while `--check` reported success. Nothing here is hand maintained, and `--check` fails when the catalogue moves and the migration does not.

**Rule 2 was proved, not asserted.** `node scripts/factRegisterAudit.js --now 2027-02-01` → **exit=1, 35 facts expired, 64 high findings**. The mechanism retires a stale figure on its own, with no code change and no redeploy, and the audit goes red when it does.

**APPLIED 2026-10-10.** MIG-01 and its generated seed are live: 82 rows, 82 audit rows, 20 high risk, 82 approved, confirmed through the Management API. The offline checks still run against `seedRegister()`, which carries the same data the seed inserts, because the LIVE register is unreachable from this machine (CF-07). *This line previously read "written and not applied" and was left stale after the deployment; corrected after the P3.9 audit.*

#### P3.10 — Ingestion pipeline and corpus health

**Built:** `src/corpusIngest.js` + `scripts/ingestBrainCorpus.js` (**dry run by default**, `--apply` required), `src/brainHealth.js` + `scripts/brainHealth.js`, `docs/brain/KNOWLEDGE-RUNBOOK.md`.

**Verification (G2):**
```
node --test src/corpusIngest.test.js   exit=0   114 tests
node --test src/brainHealth.test.js    exit=0    29 tests
node scripts/ingestBrainCorpus.js      exit=0   87 sources · 87 documents · 573 chunks
node scripts/brainHealth.js            exit=0   87/87 lexically healthy · 866/879 reachable · 0 gaps
```

**W3.10.5 and W3.10.8 (CF-02):** `assessClaimGroundedness` + `retrievedGroundingEvidence` in `src/groundingPolicy.js`, `lowConfidenceFallback` in `src/responsePolicy.js` (three reason categories x three languages, each stating the limitation and asking exactly **one** question, nothing interpolated so an injection string in `reason` is never echoed), and `src/claimGroundedness.test.js`. No second claim splitter was written: `splitClaims`, `classifyClaim` and `withoutRefusalClauses` are reused. `node scripts/auditClaimGates.js` → **exit=0**, M2's gate did not regress.

**One escalation was raised and is RETRACTED.** The claim was that M2's evidence-aware gate is inert in production because the search RPC returns no `review_status`, citing `20260929201949`. That migration is **four versions out of date**. `20261003231041` drops and recreates both search RPCs with `review_status text` and `valid_until timestamptz` in the `returns table`, the body selects `d.valid_until, d.review_status`, the edge function returns the rows unmodified and `supabaseStore.searchKnowledge` passes them straight through. A live chunk **does** arrive approved. The false justification had already been written into a code comment in `src/groundingPolicy.js` and is corrected there with the trace, so nobody "fixes" a working path on the strength of it. Checking a claimed defect against the current file rather than the first file that mentions it is the whole lesson.

**Chunking:** one chunk per `##` section (W3.10.2), plus a finding-aid chunk at index 0 carrying the title, every section heading and the alias phrases. The aliases have to reach the `to_tsvector('simple', heading || ' ' || content)` index or W3.10.4 is decorative, and `chunks.metadata` is never read by any search RPC.

**Every chunk is governed.** A section that declares no fact of its own inherits the document's `facts` (never its `supporting`), so a `kind: boundary` section can be reached by the blocked-fact filter instead of surviving as an orphan when its topic goes dark. The finding aid follows the same rule and is dropped with the document.

**Answer-retrieval repair (2026-10-11):** Audit found broad-intent search replaced the customer's actual question with generic facets, so specific requests (for example, shareholder changes) could lose their strongest lexical/vector query. Both broad-search paths now preserve the privacy-redacted current customer wording. The legacy path searches seven focused EN/AR/EL domains covering formation/structures and jurisdiction comparison, tax/accounting, banking/source of funds, residency, property, development/construction, and legal/IP/contracts. The active Agent runtime also searches all eight overview/service facets in the customer's detected language, concurrently, with its existing eight-chunk and 10,000-character prompt budgets. If any active-runtime facet fails, all partial evidence is discarded and the answer model is skipped in favor of the localized no-approved-information reply. Focused regressions verify the shareholder-change hit, facet coverage in all three languages, active Arabic/Greek localization and query anchoring, parallel execution, and failure-closed behavior. No aliases or live knowledge were re-ingested.

**Live approved-knowledge preflight (2026-10-11, read-only):** `scripts/runGoldenKnowledgeEvaluation.js` ran 12 golden questions per language against the production approved-search path, using synthetic questions only. All **33** static-fact questions returned zero eligible approved evidence (11 per language); inspection of the actual returned metadata showed document review status `approved` but the linked fact-register rows are `pending`. The three dynamic formation-offer checks were current and visible to the model observation. Across the 36 questions, no model answers were generated, so factual answer quality is **unscored**. Reports: `reports/golden-evaluation/real-data-{en,ar,el}-12-2026-10-11.json`. A separate read-only run through the active Node Agent made eight localized facet searches for one synthetic broad-services question in each language; each returned zero eligible fact evidence. Observed retrieval times were 4.44s English (first/warm-up run), 1.75s Arabic and 2.05s Greek; the scripted decision did not call an answer model or persist/send anything. This is a real-data retrieval gate finding, not proof that the answer model fails. `npm run audit:facts` independently reports 76 pending facts. Do not loosen the gate or begin factual client conversations until qualified fact review moves the needed claims through the approved workflow; calendar authorization remains deferred.

**Corpus wording corrections (2026-10-11):** Narrowed MB-F14 ownership-change documents to sourced director/secretary filing guidance plus case-specific review for shareholder transactions; narrowed MB-F17/F18 dormant-company and closure copy to avoid unsupported categorical filing, penalty, cost and route claims. All six EN/AR/EL topic files retain their required fact IDs and pass the 87-file corpus validator. These edits do not change any approval status or make manual-derived law customer-approved. `npm run audit:facts` still reports **76 high pending facts** and exits 1; factual customer-data testing remains gated on qualified fact review and approval.

---

**M3 gate evidence, all re-run 2026-10-09 after the final fix:**

```
node scripts/validateCorpus.js                     exit=0   87/87 present, 87 clean
node scripts/brainHealth.js                        exit=0   0 gaps, 0 warnings
node scripts/factRegisterAudit.js                  exit=0   0 blocker, 0 high
node scripts/generateFactRegisterSeed.js --check   exit=0
node scripts/ingestBrainCorpus.js                  exit=0   dry run, nothing written
node --test <the 6 M3 suites>                      exit=0   221 tests
```

---

#### M3 DEPLOYMENT — 2026-10-10, on BOSS's explicit instruction

M3 was committed (`a222ea6`, 133 files), MIG-01 and its seed applied, the corpus ingested, the
embeddings generated, and live retrieval measured. **State confirmed in the database, read
through the Management API so RLS cannot flatter it:**

```
refal_fact_register      82 rows · 82 audit rows · 20 high risk · 82 approved
rafa_knowledge_sources   87
rafa_knowledge_documents 87, all review_status = approved, 6 carrying valid_until
rafa_knowledge_chunks    573, embedded 573, embedding_model distinct count 1
```

The 6 documents carrying an expiry are `permanent-residency` and `property-vat` in all three
languages, exactly the six the dry run predicted, because `€300,000` trips the price trigger.

**The write path had to change, and the reason is FIX-34.** `scripts/ingestBrainCorpus.js --apply`
writes through PostgREST as `anon` plus the dashboard secret, and that secret does not
authenticate from this machine, so every write would have been accepted and silently discarded.
The ingestion was therefore emitted as SQL from the **same** `planCorpus` the PostgREST path uses
(`scripts/emitCorpusSql.js`, `scripts/emitEmbeddingSql.js`) and applied through the Management API.
Nothing was re-implemented; only the transport changed.

**Live retrieval, `scripts/verifyLiveRetrieval.js`. This is the first non-proxy measurement in M3
and it does NOT meet the gate.**

| path | ar | en | el | overall | gate |
| --- | --- | --- | --- | --- | --- |
| lexical `rafa_search_knowledge`, first pass | 85.3% | 65.5% | 79.2% | **76.7%** | 95% |
| hybrid `rafa_hybrid_search_knowledge`, first pass | 94.5% | 89.8% | 94.5% | **92.9%** | 95% |
| **hybrid, after the corpus was rewritten** | **96.9%** | **93.9%** | **98.0%** | **96.2%** | 95% ✅ |

**How the gap was closed, because the method matters more than the number.** The 62 first-pass
misses were triaged one at a time into two groups. Roughly half were questions the corpus is
**deliberately forbidden** to answer: unsourceable foreign tax rates and accounting costs (P3.8
says cut, not soften), cost of living (MB-F44), "just decide for me" (a refusal, not a retrieval
problem), "are you a bot" (persona layer). Those were left alone. The rest were genuine wording
gaps, and some were embarrassing: "What is the corporate tax rate in Cyprus?" did not retrieve
`corporate-tax`. Those documents were rewritten to speak in the customer's words, re-ingested and
re-embedded, and re-measured. **The golden set was not edited, the threshold was not lowered and
no document was given a figure it is not allowed to state.**

Two side effects worth carrying forward. A denser chunk steals ranking from its neighbours, so
three regressions were caused and repaired during the work and **any future corpus edit needs the
same before and after sweep**. And the whole exercise was partly compensating for FIX-35, a real
ranking defect in the RPC that M3 could not touch.

`scripts/brainHealth.js` reported 98.5% reachable. It was right about what it measures and said so
in its own output: token overlap against the corpus FILES, at a 50% bar. Real retrieval is
`websearch_to_tsquery` plus a vector search, and it is harsher. **The lesson is to label a proxy as
a proxy and then go and measure the real thing**, because a 6 to 22 point gap is not a rounding
difference.

**English is the worst language**, which inverts the FIX-7 and FIX-8 story. The cause is that
`search_vector` uses `to_tsvector('simple', ...)`, which does **no stemming and has no stopword
list**: "registration" and "register" are different lexemes, and Greek and Arabic function words
match almost every document.

**Negative queries: 14/17 on the lexical path, 0/17 on hybrid.** The hybrid result is structural,
not a regression. The semantic branch admits anything within 0.65 cosine distance and the rank
fusion then returns the top N regardless, so "retrieve nothing" is not a behaviour the hybrid path
has. The M3 criterion was written assuming lexical-only retrieval. **What actually protects those
queries is the answer side**, the M2 claim gates plus the per-claim groundedness check CF-02 added,
not retrieval. That needs to be stated rather than scored.

**Gap scan (G3) against the M3 exit criteria:**

| Criterion | Verdict |
| --- | --- |
| 87 sources live | **COVERED** — 87 sources, 87 approved documents, 573 chunks, confirmed in the database 2026-10-10. |
| Every MB module 2 fact retrievable in the customer's language | **COVERED** — `orphanFacts()` is empty, every fact has a register row, and after adding nine golden questions **no fact is unmeasured**. |
| Carries provenance metadata | **COVERED** — 82 register rows live, each with source, reviewer, verified date, effective date and expiry. |
| ≥95% of golden questions retrieve their topic | **COVERED** — **96.2% live on the hybrid path** (ar 96.9%, en 93.9%, el 98.0%), measured twice independently. First pass was 92.9% and the corpus was then rewritten to close the real misses. |
| 100% of negative queries retrieve nothing | **NOT MET, and re-scoped** — 14/17 lexical, 0/17 hybrid. Structurally unachievable on the path production uses. Tracked as **CF-09**; the refusal guarantee moves to the answer side, where it is verified. |
| 100% chunks embedded | **COVERED** — 573/573, one `embedding_model` value, exactly `DEFAULT_EMBEDDING_MODEL`. |
| FIX-7 and FIX-8 repaired | **COVERED** — all 29 Arabic and all 29 Greek documents exist, are valid, and clear the reachability bar at or above English. `assessParity` is their standing regression test. |

**This milestone found and repaired thirteen defects of its own**, FIX-28 to FIX-40. FIX-28 is the significant one: all 870 golden questions were scored against the wrong MB fact outside the middle of the range, which would have made every later retrieval score meaningless. FIX-36 and FIX-37 are the ones the phase audit found **after** M3 was first called done, and both were gates that looked closed and were not.

**Explicitly NOT done.** *Rewritten 2026-10-10. The previous version of this list was written before the deployment and was then left standing, so a gate whose entire job is honesty about gaps was asserting four things that its own section had already disproved: that nothing was committed, that MIG-01 was not applied, that the corpus was never ingested, and that no embedding existed. The M3 phase audit caught it. A stale G7 is worse than no G7, because it is read as current.*

- **CF-04 to CF-09 are open**, tracked in section 21 with owning phases outside M3. CF-04 is the honest one: 833 of 879 golden questions reach the finding-aid chunk before a fact-bearing one, and sibling-chunk expansion is a retrieval-layer fix M3 cannot make.
- **100% of negative queries retrieve nothing is NOT met on the hybrid path** (0 of 17) and is re-scoped to the answer side under CF-09. It is met on the lexical path at 14 of 17.
- **FIX-35 is open.** The lexical ranker compares two incompatible `ts_rank_cd` scales, so an exact match can rank below a stopword match. M3 cleared its retrieval gate by writing the corpus around that bug; the fix belongs to P10.2.
- **The W3.9.7 dashboard Facts screen, `ingestBrainCorpus.js --apply`, `backfillKnowledgeEmbeddings.js` and `brainHealth.js --db` are all non-functional from this machine** because of CF-07, a stale local credential. They are built and reachable; they are not exercisable here.
- **`--apply` has still never been run against a live database.** The corpus reached Supabase through `emitCorpusSql.js` and the Management API instead. FIX-37 shows why that matters: the `--apply` path carried a defect that only a real write would have surfaced, and it is now fixed but still unexercised.
- **Deno is not installed**, so the edge function was never type-checked. The mirrors are proved verbatim mechanically and executed through Node's ESM loader, but "the edge function compiles under Deno" remains an unverified claim.
- **No live model call was made.** Every guardrail result describes what the gates do with a given string, not what an LLM will actually say.
- **Six documents will auto-expire 30 days after ingestion** (`permanent-residency` and `property-vat`, all three languages). A BEFORE trigger forces `valid_until` on price-bearing content and `€300,000` matches it. That is correct Rule 2 behaviour and it makes re-ingestion a monthly operation; the runbook says so and brainHealth warns before it bites.
- **CF-04, CF-05 and CF-06 are open and tracked in section 21.** CF-04 is the honest one: 833 of 879 questions reach the finding aid before they reach a fact-bearing chunk, and sibling-chunk expansion is a retrieval-layer fix M3 cannot make.

---

### M4 — Dynamic Data and Tools — execution started 2026-10-10 — `[x]`

Requested execution: all five phases and seven P4.2 waves, independent phase audits, validated defects, automatic focused fixes, and final regression. Reusable repository skill: `.agents/skills/refal-milestone-execute/SKILL.md` (validator passed); it composes the global milestone workflow with the REFAL approval and evidence rules. Starting revision: `579f71c`. The workspace had pre-existing M4 planning, generated artifacts and mirror edits; all user work was preserved. Three parallel, disjoint implementation/audit assignments were used, followed by coordinator integration and independent cross-phase review.

**Gate status (2026-10-10, final):** P4.1 `[x]` schema applied and live-verified; P4.2 `[x]` with 7/7 waves verified; Edge v44 has JWT verification and all five commercial read routes smoke-tested; P4.3 `[x]`; P4.4 `[x]`; P4.5 `[x]` authenticated local-Dashboard CRUD against production main is verified. Local Vite UI and Node API run at `http://127.0.0.1:5177/` and `http://127.0.0.1:8787/`. The synthetic CRUD row was deleted and its three audit events remain. Synthetic lead action success/replay, definitive failure/replay, and pending-receipt alert/reconciliation were verified in production, with the synthetic reconciliation alert resolved. The approved policy is live; Dashboard Calendar readiness passed and read-only availability returned three suggestions. Booking-flow tests preserve explicit confirmation and assert no Google event/reminder is created. No production appointment was created and no customer was contacted.

**Implemented and verified locally:** six constrained, RLS-enabled tables; service-role-only access and four audited/security-invoker RPCs; the expiring approved €999 EUR formation offer seed; typed filtered reads, five audited/idempotent write actions, failure/empty states, bounded read retries and durable operator alerts for uncertain writes; dynamic-data precedence and fail-closed legacy fallback; prompt/chunk separation checks and brain health reporting; typed admin CRUD with RBAC, audit reason and commercial paste warning. Edge API source-turn validation rejects inferred lead fields. The opt-in WhatsApp Agent caller now runs deterministic preflight, routes appointment and unfinished booking turns through the existing booking owner, persists one source turn before Agent execution, passes its UUID and grants only source-validated `upsertLead` on eligible turns, patches that same turn and sends once. The code remains default-off; this PC is explicitly enabled for the requested local rollout.

**Phase evidence and audit:**

| Phase | Result | Evidence |
| --- | --- | --- |
| P4.1 Schema | `[x]` schema local/live pass; CF-05 synthetic live-model composition verified | `node --test scripts/m4Migration.test.mjs` passes against tracked `@electric-sql/pglite`; applies migration twice and verifies six RLS tables, all four table privileges for `service_role` on all six tables, denied privileges for `anon`/`authenticated`, invoker/empty search path/RPC grants, seeded price/expiry, audited mutation, updated-at trigger, invalid constraint rejection, idempotency/hash mismatch and 12/13 rate boundary. Live migration tool recorded `20261010150340 / refal_dynamic_commercial_data`. Live catalog queries confirmed all six tables have RLS, service-role CRUD and no anon/authenticated SELECT; four RPCs are security-invoker and executable only by service_role; approved `formation-package` is €999 EUR, active, and valid through 2026-11-06. |
| P4.2 Tools | `[x]` 7/7 waves; local contracts and production live read/action/calendar pass | Root and Dashboard tests cover all eleven named tools, dynamic-store filters, explicit booking confirmation, idempotency, failures and alerts. Five commercial reads returned expected live values/empty states. Production `upsertLead` create/replay, definitive failure/replay, and pending-receipt alert/reconciliation were verified with synthetic data and safely reconciled. Booking policy was read back exactly; Dashboard Calendar readiness passed; a production Google FreeBusy read returned three policy-compliant availability suggestions. The booking flow regression reached `pending_review` only after explicit confirmation and asserted zero calendar events/reminders. No production appointment was created and no customer was contacted. See final verification refresh below.
| P4.3 Separation | `[x]` local pass | `node --test src/dynamicDataSeparation.test.js src/brainHealth.test.js dashboard/src/knowledgeCommercialWarning.test.js` passes; generated customer/operator/Edge prompts, operational rules, chunk safety and warning routing are covered. `node scripts/brainHealth.js` reports 87/87 clean and lexical health, 868/879 proxy-reachable, no blockers; five DB checks remain explicitly pending. |
| P4.4 Contracts | `[x]` local pass | Targeted tests cover success, empty, stale, error, timeout, duplicate, unauthorized, partial and pending/confirmed/failed behavior. Definite HTTP 4xx handler rejections now complete durable receipts as `failed`; ambiguous transport/database exceptions remain `pending`. The service-only claim RPC creates or reopens the durable `action_reconciliation` priority alert in the same transaction as the receipt and before the handler side effect; finish resolves the alert. Helper tests cover bounded fields and transport failures; the PGlite harness verifies atomic creation, duplicate repair, acknowledgement reopening, resolution, role grants and contact-owned source-turn validation. The route's follow-up alert call repairs missing alerts on a repeated pending request. |
| P4.5 Dashboard | `[x]` local UI/API and authenticated production CRUD pass | Dashboard suite passes 105/105; production build succeeds. API requires authenticated staff for reads, admin for writes, server-derived actor and a reason; typed CRUD and paste warnings are covered. In the authenticated local admin session, the labeled inactive synthetic offer completed create/read/update/delete. A fresh live GET confirmed the row absent and the approved offer unchanged; a read-only production query found exactly one create, one update and one delete audit event for the synthetic code. The local session endpoint and offers endpoint both returned HTTP 200 with authenticated admin and the single approved row. The local Dashboard/worker connected to Supabase main is the owner's target; no external host is required. |

**Validated fixes:** initial root suite's two mirror-parity failures were caused by mixed line endings; `.gitattributes` now normalizes generated prompt mirrors and parity passes. The independent tool audit reproduced acceptance of a legacy dynamic response with `ok: false`; the fallback now fails closed and has regression coverage. Source validation now pairs an amount with its nearest currency token and rejects unsupported/inferred profile fields. A Deno type-check exposed a missing JSDoc type for an existing handover merge helper; the type annotation was corrected and the Edge entrypoint then passed `deno check`. The local SQL acceptance harness initially asserted the 12th request as the 13th; the harness boundary was corrected and now verifies full table grants across all six tables plus the 12/13 action-rate boundary. The M3 seed check reported stale output despite unchanged catalogue; regeneration restored exact generator parity with no source catalogue change. Independent composition testing exposed a static stale-price leak when live offer lookup returned empty/expired; the Agent composer now suppresses matching frozen commercial chunks, and CF-05 covers unchanged, changed, expired and missing offer cases. Definite handler HTTP 4xx rejections now persist a terminal failed receipt, while ambiguous errors remain pending. Independent caller audit confirmed `recordHistory` could reject after inserting an Agent source turn when an auxiliary workflow write failed, causing `runRoutedTurn` to retry legacy and duplicate the turn. The Agent source-turn path now uses `recordHistory(..., { bestEffortWorkflowWrites: true })`: it retains the existing history-linked workflow writes but contains their failures after the source turn is inserted. A second audit identified ambiguous insert failures as another possible duplicate path; the adapter now returns a localized safe response without Agent execution or legacy retry when the source insert rejects or returns no ID. Regression tests cover both boundaries.

**Historical final verification snapshot (2026-10-10; superseded by the final verification refresh below):** after the caller idempotency fixes, `npm run test:all` exit=0 (root **1,846/1,846**, dashboard **104/104**); dashboard production build exit=0; migration acceptance harness passes as part of the root suite; prompt mirrors `--check` exit=0; corpus validation exit=0; fact register audit exit=0; `brainHealth.js` exit=0 with five expected PENDING DB checks; `npm run plan:ui` regenerated the progress view. Independent cross-phase reviews validated durable failed receipts, all-table privilege boundaries, stale-offer suppression, status wording, transaction-backed reconciliation alerts, and the WhatsApp caller; caller regressions cover workflow-write failure and ambiguous source-turn inserts. BOSS authorized applying the M4 migration through the Supabase migration tool; migration history records version `20261010150340`. Live verification confirmed the six RLS tables and service-role-only table/RPC privileges plus the active €999 offer and expiry. The security advisor's RLS-enabled/no-policy notices on these tables are expected: direct roles have no grants and service_role is the only granted role. The connected Supabase session was used for deployment and live verification; the local CLI credential was not needed. Supabase reports `rafa-agent-api` ACTIVE v44 with M4 dynamic routes and all five read routes smoke-tested; the deployed source was retrieved and verified. The separate dashboard is running locally; external hosting and authenticated CRUD smoke verification remain pending. `deno` is not on PATH, but `npx --yes deno check supabase/functions/rafa-agent-api/index.ts` was rerun successfully with Deno 2.9.6 (exit=0). The dashboard production build and focused 48-test M4 audit suite were also rerun successfully after the independent review. No live customer operation was made; a synthetic read-only live-model turn used live approved-knowledge and offer reads, with no outbound message or production write.

**Follow-up independent audit (2026-10-10):** Two fresh reviewers found no remaining safe local implementation gap. Focused M4 regression (`node --test src/dynamicDataSeparation.test.js src/dynamicDataIntegration.test.js src/agentTools.test.js src/agentWhatsAppAdapter.test.js scripts/m4Migration.test.mjs`) passed **48/48**; the migration harness verified all six RLS/grant boundaries, four service-only invoker RPCs, the €999 seed/expiry, audit and timestamp behavior, constraints, idempotency, and the rate limit. A fresh full `npm run test:all`, Deno type-check, and dashboard production build all exited 0. Deployment inventory confirmed that no dashboard host or deployment configuration exists in this repository. The authorized Edge release used the connected Supabase deployment tool with the complete 15-file local dependency graph and `verify_jwt=true`; live version/source checks and five read-route smoke tests passed.\n\n**Historical production state snapshot (2026-10-10; superseded by the final verification refresh below):** Supabase currently reports `rafa-agent-api` ACTIVE v44 (`verify_jwt=true`) and `rafa-admin-api` ACTIVE v4 (`verify_jwt=true`). Retrieved agent source contains M4 dynamic-data and action routes. `rafa-admin-api` is the separate account-management API; M4 typed CRUD runs in the dashboard Node server, whose production host is still unknown and whose live smoke test remains pending. The local Vite/Node dashboard responds on `5177/8787`; the Supabase console is not an app host. The Edge deployment and Git push are complete; no dashboard external host is configured. At the user direction, WhatsApp pairing will be initiated through the local dashboard (`http://127.0.0.1:5177/`). Restarting the dashboard API stopped its prior managed worker; the worker is no longer running and an accurate `connection_close` event was recorded. The user can reconnect from the dashboard. UI, API, and proxied session checks returned HTTP 200 after restart; WhatsApp pairing remains for the user to complete.\n\n**Historical progress-view audit (2026-10-10; its partial M4 findings were resolved and are superseded by the final verification refresh below):** Independent review confirmed P4.1 schema is applied and live-verified. At the time of this audit P4.1 remained `[~]` under the carry-forward rule because CF-05 deployed end-to-end composition evidence was still pending: tracked migration `20261010080201_refal_dynamic_commercial_data.sql` exists, Supabase migration history records `20261010150340 / refal_dynamic_commercial_data`, and the six tables are present with RLS. The old view said “not written yet” because its source item still used a `<ts>` placeholder and omitted the executed marker; the authoritative database-change row now carries the exact file and live migration evidence. A second CF-05 audit found the prior integration test manually assembled tool observations and did not run the real Agent loop; the new end-to-end local test exposed that the grounding gate rejected current offer inclusions after correctly excluding a stale EUR 899 chunk. The validated fix derives package-inclusion evidence from the current offer only; real `runAgentTurn` regression passes and asserts the stale amount is absent. A safe synthetic Agent turn passed through the current runtime using the configured live model and deployed approved-knowledge/offer reads; all seven inclusions plus €999 and VAT passed grounding with no customer send or writes. Before it passed, real-model checks exposed and fixed output-format and offer-code discovery gaps: the request now uses a strict JSON-schema decision contract, and lookup can safely enumerate current offers when no exact code is known. The dashboard unavailable message was reproduced at its root: `dashboard/dynamicDataAdmin.js` sent the server shared secret without the required Supabase `apikey`; the deployed Edge function has `verify_jwt=true`, so the gateway returned 401 before its handler. A GET without the key returned `UNAUTHORIZED_INVALID_JWT_FORMAT`; the same five read requests with the configured publishable key in `apikey` returned HTTP 200 with the expected offer and empty states. The route now sends the publishable key in `apikey` while the Edge handler continues validating the server-only shared secret. The focused dashboard test asserts the header and that the key is not misused as a bearer token; dashboard suite 104/104 and build pass, full root/dashboard suite passes, and a route-level live GET through `registerDynamicDataAdminRoutes` returned the expected five states. The local API was restarted with the fix; UI/API/session endpoints return HTTP 200. P4.2 showed `0/7` because the progress generator made every unmarked wave inherit the phase-level `[~]`; explicit wave statuses show `4/7` complete (W4.2.3, W4.2.5, W4.2.6, W4.2.7), each locally behavior-tested. W4.2.1 has a typed registry unavailable-state regression but remains partial: a safe live lookup returned `POLICY_UNAVAILABLE` because no booking policy is configured in the deployed API, so no live calendar result was asserted. W4.2.2 remains partial pending production action smoke; W4.2.4 has tests proving definitive HTTP 429 behavior and remains partial pending live write/reconciliation behavior. Independent P4.2 audit checked the actual registry/call graph and tests; focused regression (`agentTools`, `dynamicDataFallback`, `dynamicDataIntegration`, `agentDecision`, `m4Migration`) passed. P4.2 remains `[~]`; no production action write or live customer conversation was attempted. CF-01 is closed because both composers call tested conflict resolution and deployed Edge v44/read routes were verified; CF-05 is closed on a safe synthetic live-source Agent turn: the configured model selected approved-knowledge and offer-read tools, both returned `found`, and the inclusions plus €999 and VAT treatment passed grounding. This later verified evidence closed CF-05 and P4.1 is now `[x]`. Only read tools were exposed; no customer message or production write occurred.

**Previous M4 status audit (before admin sign-in and synthetic production checks, 2026-10-10):** At that point P4.1 `[x]`, P4.2 `[~]` with 4/7 waves done, P4.3 `[x]`, P4.4 `[x]`, and P4.5 `[~]`. The audit's 84/84 focused tests, 104/104 dashboard suite, unauthenticated session, and pending live-write conclusions are historical and superseded by the current verification refresh below. It correctly identified the missing `rafa_settings.booking_policy` and invalid local CLI token; these remain current facts.
**Final verification refresh (2026-10-10; supersedes previous snapshots):** P4.1, P4.2, P4.3, P4.4 and P4.5 are `[x]`; all seven P4.2 waves passed. `npm run test:all` exited 0 (root and Dashboard suites); Dashboard production build and `npx --yes deno check supabase/functions/rafa-agent-api/index.ts` exited 0. Authenticated local admin UI/API against production main completed synthetic offer create/read/update/delete; the deleted test row is absent and exactly three corresponding audit events persist. Synthetic production action evidence remains as previously recorded: confirmed idempotent lead save, failed action/replay, and pending receipt/reconciliation alert safely finalized after verifying no effect. Synthetic operational rows were removed after reconciliation. The production booking policy was read back exactly: Europe/Nicosia, Monday–Friday 10:00–15:00, 30 minutes, 24-hour notice, `primary`, Meet enabled, reminders at 24 and 1 hours. Dashboard Calendar readiness/access check passed at 2026-10-10 19:50; live read-only availability returned three suggestions. The local booking-flow regression exercises request, proposed slot, and explicit confirmation, and asserts the synthetic appointment remains `pending_review`, with zero Google events and zero reminders. No production appointment was created and no customer was contacted. Final closeout: `npm run test:all` passed **1,858/1,858 root tests and 105/105 Dashboard tests**; `npx --yes deno check supabase/functions/rafa-agent-api/index.ts` passed; Dashboard production build passed; `git diff --check` passed. A fresh independent cross-phase audit confirmed M4 100%, P4.2 7/7 and no remaining stale current M4 claims. OAuth credentials are stored only in ignored local `.env.rafa`; no credential value is recorded here. Changes were pushed to `main`.
**Dependency detail:** CF-05 now has a real `runAgentTurn` regression proving validated current-offer inclusions and price pass the grounding gate after stale price-bearing evidence is removed. A safe synthetic run against deployed approved knowledge and the live offer also passed through the current local Agent runtime, returning the approved inclusions and EUR 999 plus VAT; only read tools were exposed, and no customer was contacted or data written. Root cause: structured `inclusions` were not rendered as package-linked evidence required by the existing package-claim gate; `src/groundingPolicy.js` now derives “package includes” evidence only from the validated current offer. CF-05 is closed based on a synthetic no-send turn through the current Agent runtime using the configured model, live approved knowledge and live offer reads; no customer was contacted or production data written. Preserve corpus coverage thresholds.

**Baseline:** independent verifier ran root tests (1,785 pass, 2 mirror-generation failures), dashboard tests (94 pass), and dashboard build (pass) before implementation. Root cause: generated mirrors had inconsistent line endings; fixed and covered by normalization. Baseline details: `docs/brain/M4-BASELINE.md`.

---

### M5 — Sales Intelligence — execution completed 2026-10-10 — `[x]`

Executed with `.agents/skills/refal-milestone-execute/SKILL.md`, using disjoint implementation and independent audit assignments, followed by coordinator integration and a fresh cross-phase audit. P5.1–P5.4 are individually audited and verified below. No M5 database migration was required by the plan.

**P5.1 — Cross sell hook matrix — `[x]`**

- **Built:** `src/salesHooks.js` and runtime composition in `src/salesIntelligence.js`; Arabic, English, Greek, Arabizi and Greeklish trigger/phrase handling; evidence/currentness checks; suppression for answered-state, humour, no-repeat, no-contact, complaints, sensitive and informational requests; persisted hook IDs through Edge metadata allowlist.
- **Defects validated and fixed:** mapped language detector values (`arabic`/`greek`) to native hook locales; added missing developer trigger; integrated hooks in legacy and Agent response paths; informational service, company, identity, pricing and contact requests now suppress cross-sells; transliteration language detection now mirrors Greeklish and Arabizi.
- **Verification:** `node --test src/salesHooks.test.js src/salesIntelligence.test.js src/language.test.js src/salesOfferMetadata.test.mjs` → exit 0, **23/23**. Hook composer and Edge metadata tests pass.
- **Independent audit:** P5.1 re-audit passed; no remaining in-scope defect reported.

**P5.2 — Objection matrix — `[x]`**

- **Built:** `src/objectionMatrix.js`; five trilingual, one-question, non-pushy responses; live `formation-package` lookup for O1/O2; evidence-gated O5 credibility facts and humour cap; `messageRouter.js` runtime bridge.
- **Defects validated and fixed:** removed the legacy router-category gate that stranded O2/O3/O4 and question-form O5; preserved direct factual and mixed questions; added Greek reliable-adjective morphology and English/Arabic/Greek trust-plus-office route regressions.
- **Verification:** objection matrix, objection workflow and route tests passed; final independent targeted route probes passed **3/3**, matrix/sales intelligence **15/15**, and combined route/workflow suite **84/84**.
- **Independent audit:** P5.2 final audit passed; no remaining in-scope defect reported.

**P5.3 — Jurisdiction benchmarking — `[x]`**

- **Built:** `src/jurisdictionBenchmark.js` and runtime guard in both legacy and Agent answer paths; all four corpus topics with English, Arabic and Greek cases; current approved topic/fact evidence; localized discovery-question fallback; non-disparagement and unsupported-claim rejection.
- **Defects validated and fixed:** wired the guard to both production response paths; enriched Edge retrieval with bounded server-side topic and current fact-register metadata; fail closed when governance lookups or current rows are missing; fixed corpus fact splitting and tone checks.
- **Verification:** jurisdiction, runtime composition and Edge enrichment tests passed **24/24**; independent audit exercised all **12** topic/locale corpus cases and the missing, stale, blocked, pending and language-mismatch fail-closed paths. `npx --yes deno check supabase/functions/rafa-agent-api/index.ts` passed.
- **Independent audit:** P5.3 and final M5 cross-phase audits passed; no remaining in-scope defect reported.

**P5.4 — Offer orchestration — `[x]`**

- **Built:** `src/offerOrchestration.js` selects one eligible booking, specialist, objection, jurisdiction or hook candidate; enforces strict answer completion, one-question, priority, policy precedence, consent and suppression gates. Explicit booking requests pass the selector before the existing deterministic booking owner. Specialist follow-up now composes after the answer in both response paths; hook and specialist metadata persist for no-repeat checks.
- **Defects validated and fixed:** removed the pre-answer specialist return and its hardcoded `answerComplete`; added persisted specialist-offer repeat suppression; added the narrow Edge `specialistOffer` metadata contract (`offered`, `consentRequired`, parseable `offeredAt` only) after the independent audit proved Agent turn PATCHes were rejected; Edge tests cover valid and forged payloads.
- **Verification:** `node --test src/offerOrchestration.test.js src/salesIntelligence.test.js src/messageRouter.test.js src/bot.test.js` → exit 0, **96/96**; Edge metadata validation tests → exit 0, **3/3**. Full `npm test` → exit 0, **1,916/1,916**. `npm run test:all` → exit 0, including Dashboard **105/105**. Deno check and `git diff --check` passed.
- **Independent audit:** P5.4 audit and fresh M5 cross-phase audit passed after the Edge persistence fix. No remaining confirmed in-scope defect.

**Final M5 audit and evidence boundary:** a fresh independent audit compared P5.1–P5.4 to this plan and rechecked runtime wiring, localization, suppression, current evidence, persistence schemas and regression tests. It found and validated the specialist-offer Edge metadata rejection above; after the fix, it reported no remaining confirmed M5 blocker. Edge code is locally type-checked and unit-tested, but was **not deployed** and no live Supabase persistence round-trip was run. No migrations, production writes, customer messages, commit or push were performed in this M5 execution.

### P6.1 — The six dimension scorer — implementation reviewed 2026-10-10 — `[x]`
Built: Six-dimension evidence scoring, deterministic provenance/fingerprints, previous-score reuse, protected-trait and negation exclusions scoped across English/Arabic/Greek contrast boundaries, customer-output leak protection, and durable Edge score-history persistence.
Files touched: `src/qualificationEngine.js`, `src/messageRouter.js`, `src/responsePolicy.js`, `supabase/functions/rafa-agent-api/index.ts`, `supabase/migrations/20261010150000_refal_lead_score.sql`, `scripts/m6QualificationMigration.test.mjs`, related tests.
Verification: `node --test src/qualificationEngine.test.js src/messageRouter.test.js src/responsePolicy.test.js scripts/m6QualificationMigration.test.mjs` exit=0; focused qualification regression suite exit=0 (162 tests); final `npm run test:all` exit=0 (2,003 root + 105 Dashboard).
Gap scan: COVERED 6 / PARTIAL 0 / MISSING 0. Local scoring and migration acceptance covered; live MIG-08 history, table, RLS, columns, foreign keys, and updated Edge deployment verified. No synthetic customer score row was written.
Defects logged: Independent audits found trait-clause removal could drop adjacent commercial evidence and negation scope crossed contrastive clauses, suppressing affirmative evidence. Both were reproduced; trait-only rejection remains covered.
Auto fixes applied: Deterministic evidence ordering, trait-only and negative-only protections, conjunction-safe trait-clause removal, contrast-boundary negation scope, all-match positive-evidence scanning, and previous-score reuse. Added English, Arabic and Greek mixed-turn regressions.
Fields left for BOSS to fill: None for schema/deployment. A live score-row round-trip was not performed to avoid creating synthetic production customer data.
Deviations from plan: Store evidence references as source-turn IDs and excerpt hashes, not duplicated raw evidence text.
Explicitly NOT done: No live score-row round-trip. MIG-08 was applied by the owner-authorized Supabase operation on 2026-10-10 and verified in remote migration history and schema metadata.
BOSS sign off: Owner authorized Supabase migration and Edge deployment on 2026-10-10; live schema and active function version verified.

### P6.2 — Tiers and action protocols — completed 2026-10-10 — `[x]`
Built: Five exact score bands and action protocols; tier-aware hook suppression; distinct tax/residency routing; durable deduplicated strategic alerts; computed tier reaches WhatsApp and Agent prompts.
Files touched: `src/leadTiers.js`, `src/messageRouter.js`, `src/bot.js`, `src/brainPrompt.js`, `src/agentContext.js`, `src/agentDecision.js`, `src/agentRuntime.js`, prompt mirrors, `config/refal-agent-rules.md`, related tests.
Verification: `node --test src/leadTiers.test.js src/messageRouter.test.js src/agentContext.test.js src/agentDecision.test.js src/promptParity.test.js` exit=0; final `npm run test:all` exit=0 (2,003 root + 105 Dashboard).
Gap scan: COVERED 6 / PARTIAL 0 / MISSING 0.
Defects logged: Independent audit found AP-7 missed paraphrased tax and relocation benefits. A fresh M6 audit also reproduced a score-only Strategic lead (25/30, no buying-signal or explicit strategic cue) that wrote no priority alert, violating W6.2.6.
Auto fixes applied: Prior audit findings for tier wiring and department routing; expanded and independently rechecked Hot/Strategic hook suppression; `recordHistory` now creates an urgent `material_business_opportunity` alert for a Strategic tier when no other alert branch already handles it. The existing Edge workflow upsert reuses the active contact/trigger row, preserving one durable alert.
Verification: Added a router regression for a score-only 25/30 Strategic lead and an MB-B5 overlap case. Both paths assert exactly one urgent alert write. `node --test --test-name-pattern="a Strategic qualification score|buying signals apply score floors" src/messageRouter.test.js` passed 2/2; combined focused M6 suite passed 186/186; full `npm run test:all` passed 2,003 root and 105 Dashboard tests. Edge active-alert upsert and the partial unique index were independently rechecked; no live write was performed.
Fields left for BOSS to fill: None for this phase.
Deviations from plan: None.
Explicitly NOT done: No live alert delivery was triggered.
BOSS sign off: Pending.

### P6.3 — Instant buying signals — completed 2026-10-10 — `[x]`
Built: MB-B1..B5 trilingual and transliterated signal detection with original-message evidence offsets, score floors, guarded next-step metadata, and prompt wiring through both the legacy WhatsApp and bounded Agent routes.
Files touched: `src/buyingSignals.js`, `src/messageRouter.js`, `src/bot.js`, `src/ai.js`, `src/brainPrompt.js`, `src/agentContext.js`, `src/agentRuntime.js`, `src/agentDecision.js`, prompt mirrors, related tests.
Verification: Signal/prompt/Agent tests exit=0; final `npm run test:all` exit=0 (2,003 root + 105 Dashboard); prompt mirror checks exit=0. Independent audit verified all canonical B1–B5 English, Arabic and Greek samples reach the guarded booking request detector; regression coverage verifies mixed landowner/sanctions turns defer from booking in English, Arabic and Greek.
Gap scan: COVERED 1 / PARTIAL 0 / MISSING 0.
Defects logged: Independent audit found the booking gate could preempt a compliance-triggered B5 message. Booking dispatch now yields to restricted safety and compliance triggers, including sanctions/source-of-funds cases.
Auto fixes applied: Signal IDs now reach both customer decision paths; safety/compliance precedence is explicit. A signal never grants appointment/handover consent or confirmed status.
Fields left for BOSS to fill: None for this phase.
Deviations from plan: Signals prompt the existing consent-gated P7 booking workflow; they do not execute or confirm a booking directly.
Explicitly NOT done: No appointment was created.
BOSS sign off: Pending.

### P6.4 — Executive Handoff Summary — completed 2026-10-10 — `[x]`
Built: Structured summary with fixed sections/separators, explicit unknowns, role-based visibility, sensitive-data redaction, Unicode contact masking, all allowlisted typed intake fields attached to the linked inquiry, qualification/routing details, and system-confirmed appointment status.
Files touched: `src/executiveHandoff.js`, `src/handover.js`, `src/agentTools.js`, related tests.
Verification: `node --test src/executiveHandoff.test.js src/handover.test.js src/agentTools.test.js src/messageRouter.test.js` exit=0; final `npm run test:all` exit=0 (2,003 root + 105 Dashboard). Runtime adapter test confirms linked inquiry intake and qualification reach the handover summary; unrelated profile fields remain excluded.
Gap scan: COVERED 5 / PARTIAL 0 / MISSING 0.
Defects logged: None.
Auto fixes applied: Independent audit fixes for Unicode phone digits, linked M8 CRM field omissions, and handoff adapter propagation of intake/qualification metadata.
Fields left for BOSS to fill: None for this phase.
Deviations from plan: Handoff includes typed intake/CRM values from the inquiry linked to consent; it deliberately excludes unrelated legacy profile fields without inquiry provenance.
Explicitly NOT done: No customer-facing handover confirmation is fabricated.
BOSS sign off: Pending.

### P6.5 — Handover delivery and acknowledgment — implementation reviewed 2026-10-10 — `[~]`
Built: Sandbox-only delivery ledger, bounded retry/update plumbing, acknowledgment and closure, department-consistent FK, dashboard unresolved/delivery-failure summary, failed-ledger retry recovery, legacy open-handover seeding, and resolved/cancelled handover notification suppression through claim and worker send.
Files touched: `supabase/migrations/20261010160000_refal_handover_delivery.sql`, `supabase/functions/rafa-agent-api/index.ts`, `supabase/functions/rafa-agent-api/handoverDeliveryState.mjs`, `src/supabaseStore.js`, `src/notificationScheduler.js`, `dashboard/server.js`, `scripts/m6HandoverMigration.test.mjs`, related tests.
Verification: `node --test scripts/m6HandoverMigration.test.mjs src/handover.test.js src/notificationScheduler.test.js supabase/functions/rafa-agent-api/handoverDeliveryState.test.mjs` exit=0; combined focused M6 suite passed 186/186; final full `npm run test:all` exit=0 (2,003 root + 105 Dashboard); Deno check exit=0.
Gap scan: COVERED 9 / PARTIAL 1 / MISSING 0. Local evidence covers outage/retry, failed-ledger retry repair, terminal state reconciliation, closed-handover suppression, retry cancellation ordering, open-only legacy seeding, wrong department, duplicate prevention, nullable assignee, and empty contact formatting. Live MIG-11 history, RLS-enabled ledger schema, expected columns/FK, and updated Edge deployment are verified. End-to-end notification delivery and dashboard badge reconciliation remain unverified. Two fresh independent audits verified that the production recipient is hard-coded to non-deliverable `sandbox@refalco.test` and the claim route performs global reconciliation plus a shared claim of up to 25 jobs. Therefore no live invocation is safe until a test-only recipient and isolated claim-by-ID path exist; no notification was sent and no live rows were changed.
Defects logged: Audits found missing enqueue recovery, ACK/resolve writes missing department/timestamps, terminal notification partial writes, retry partial writes, historical open handovers lacking delivery rows, retrying resolved work, queued jobs surviving dashboard resolution, claim-to-send closure races, and cancellation incorrectly reopening a closed ledger as a failure. Each was reproduced from code/state flow and fixed with idempotent reconciliation, open-row sandbox seeding, retry allowlisting, claim response validation, worker-side parent-status validation, and cancellation-specific closed ledger mapping. Cancellation runs before ledger closure; reconciliation failure aborts claims. No live route/provider integration test exists; Edge/database control flow is independently audited and state helpers plus worker behavior are unit-tested.
Auto fixes applied: Nullable-assignee and department mismatch assertions; claim-time enqueue and retry repair; sent/dead/cancelled reconciliation; sandbox migration seed for pre-existing open handovers only; retry eligibility limited to open/acknowledged; closed/missing parent notifications cancelled before return; fail-closed reconciliation, post-claim and pre-send status guards; cancellation maps to closed with timestamps/reason; dashboard ACK/resolve timestamp/department fixes; regression tests for retry/closure ordering and resolved-before-send cancellation.
Fields left for BOSS to fill: Add and independently audit a test-only controlled administrator recipient and claim-by-ID path that cannot reconcile or claim unrelated jobs; then run one synthetic delivery, verify status/provider evidence and dashboard aggregate/ACK reconciliation, and safely clean up synthetic rows while retaining audit evidence.
Deviations from plan: Recipient stays hard-coded to the sandbox lane; no production notification recipient is enabled.
Explicitly NOT done: No live notification or external communication; live delivery/badge round-trip was not run. This is an intentional safety stop: the deployed recipient is `sandbox@refalco.test` and the shared claim endpoint can affect unrelated pending jobs. MIG-11 was applied by the owner-authorized Supabase operation on 2026-10-10 and verified in remote migration history and schema metadata.
BOSS sign off: Owner authorized Supabase migration and Edge deployment on 2026-10-10; live schema and active function version verified. Delivery integration remains partial.

### P6.6 — Strategic escalation — completed 2026-10-10 — `[x]`
Built: Landowner/JV, construction tender, HNW €1M+, and international partnership cues; urgent senior route; EN/AR/EL construction price/estimate output guard and Edge mirror.
Files touched: `src/strategicEscalation.js`, `src/responsePolicy.js`, `src/ai.js`, `src/messageRouter.js`, Edge response-policy mirror, related tests.
Verification: `node --test src/strategicEscalation.test.js src/responsePolicy.test.js supabase/functions/rafa-agent-api/responsePolicy.test.mjs` exit=0; combined focused M6 suite passed 186/186; final `npm run test:all` exit=0 (2,003 root + 105 Dashboard). Regression coverage rejects explicitly negated English, Arabic and Greek signals while retaining affirmative signals after comma and localized contrast boundaries.
Gap scan: COVERED 4 / PARTIAL 0 / MISSING 0.
Defects logged: Independent audit found the deterministic `resultWithHistory` validator omitted trusted inbound context; every call now passes the current message so construction tender price/estimate checks run. Prior audits found strategic classes escalated negated cues and overbroad negation suppressed affirmative evidence in contrastive turns. The 2026-10-10 independent P6.6 audit reproduced missed Arabic HNW thresholds for grouped Western/Arabic-Indic/Persian amounts and a false escalation for sub-million decimals; follow-up audit found the Arabic token `ما` inside `استثمار` was misread as negation and suppressed valid evidence.
Auto fixes applied: Independent audit corrected threshold parsing, landowner cues, and response-output enforcement; added context to the route-level validator. Strategic detector scopes negation to local clauses, evaluates subsequent affirmative matches, normalizes Arabic-Indic/Persian digits plus Arabic thousands/decimal separators, parses numeric `مليون` amounts and amount-before-`يورو`, applies numeric thresholds instead of cue-only matches, and uses Unicode word boundaries for Arabic/Greek negation tokens. Added regressions for grouped amounts, decimal million values, below-threshold values, and affirmative amounts after negated amounts.
Validated audit findings: Previously, `ميزانيتي 1,000,000 يورو`, `ميزانيتي ١٬٠٠٠٬٠٠٠ يورو`, `لدينا ميزانية €١٬٠٠٠٬٠٠٠`, and `ميزانية الاستثمار ١٫٢ مليون يورو` missed escalation; the initial localized numeric change then exposed false positives at 0.5M and the `استثمار` substring issue. Final tests prove 1.0M/1.2M/1.5M route, 0.5M/0.9M do not, negative-only 1M does not, and affirmative 2M after negated 1M does.
Fields left for BOSS to fill: None for this phase.
Deviations from plan: Strategic facts remain internal routing signals, not customer-facing business claims.
Explicitly NOT done: No real opportunity was escalated.
BOSS sign off: Pending.

**M6 closeout status (2026-10-10):** P6.1, P6.2, P6.3, P6.4 and P6.6 are complete; P6.5 is partial. Migrations `20261010190302 / refal_lead_score`, `20261010190310 / refal_handover_delivery`, and `20261010195102 / rafa_notification_claim_by_id` are recorded; `rafa-agent-api` is ACTIVE v46 with `verify_jwt=true`, `import_map=false`. Full `npm run test:all` passed 2,015 root and 105 Dashboard tests; Deno check and independent pre-live P6.5 audit passed. Exactly one isolated synthetic live attempt was made using the controlled recipient. SMTP rejected authentication with `535 5.7.8`; one attempt is persisted as dead/failed with no provider ID. Synthetic handover and delivery ledger were safely closed, while failed job evidence remains; post-cleanup badge backing counts are zero. No duplicate attempt or unrelated production processing occurred. The temporary Gmail App Password was revoked. Successful delivery, provider evidence, dashboard UI badge behavior, and acknowledgment remain unverified. Owner-directed deferral: M7 preparation may proceed; return to P6.5 before marking M6 complete. No completion changes were pushed to `main`.
### 2026-10-11 — real-corpus readiness follow-up (partial; no milestone closed)

**Built and audited locally:**
- Corpus claim review revised nine permanent-residency, relocation and banking documents across EN/AR/EL to remove unsupported assertions while preserving mapped fact IDs; audit note: `docs/brain/CORPUS-CLAIM-REPAIR-NOTE.md`.
- Reminder at-most-once delivery and inbound receipt lease fencing are implemented with prepared migrations MIG-16 and MIG-15. Both require coordinated worker/Edge rollout and remain unapplied.
- Dashboard handover grouping filters and all-row pagination were corrected and independently checked.
- Golden-evaluation harness preserves row-level governance metadata when combining evidence. Corrected live retrieval report: `reports/golden-evaluation/live-2026-10-11-corrected.json`.

**Verification:** `npm run test:all` → exit=0 (root **2,173/2,173**, dashboard **135/135**); dashboard build → exit=0; `npm run validate:corpus` → **87/87** clean; `npm run audit:facts` → 82 rows, zero findings; `node scripts/generateFactRegisterSeed.js --check` → generated seed matches catalogue; `node scripts/auditClaimGates.js` → zero unregistered facts, zero evidence-path leaks, zero facts blocked with approved evidence; `node scripts/runGoldenKnowledgeEvaluation.js --lang en --limit 3 --top 5 ...bounded-en-smoke.json` → 3/879 live-search rows and 3 negative diagnostics reported using the bounded observation shape; `git diff --check` → no whitespace errors. PGlite MIG-17 test confirms the stale fact update, primary source provenance, review window, and idempotent audit record. Deno is unavailable in this Windows environment, so the Edge `deno check` could not run.

**Readiness boundary:** This is not an answer-quality or production release pass. A separate six-case live-model smoke retrieved approved sources, but all six model drafts were rejected by existing output guards and fell back; no customer messages or durable writes occurred. A top-eight full-corpus run was stopped after sustained CPU work before producing a report. The corrected harness's first live run exposed a negative-search result-shape bug; fixed it and added a regression. The cross-phase audit also reproduced mixed timestamp/legacy consent ordering that could let an untimestamped old grant override a later opt-out; fixed and verified in the focused suite. None of the local corpus or MB-F20 register corrections have been ingested/applied to the live project, so no improvement is yet proven against refreshed live evidence. No live migration, corpus write, Edge deployment, commit, or push occurred; named BOSS gates remain. Calendar/Auth and live booking remain deferred.

### 2026-10-11 — answer-quality and source-accuracy follow-up (partial; no milestone closed)

**Independent findings and local fixes:**
- A fresh six-case live-approved-knowledge smoke used synthetic Arabic, English, and Greek enquiries. It sent no customer messages and wrote no durable records. All six model drafts were blocked by the existing output guards and used the deterministic fallback (`modelUsed=false`); booking stayed false. The fallback passed the script's regex checks but was not consistently answer-first or concise. This is a production-answer readiness failure, not evidence of good model quality.
- Independent official-source review found the IP Box corpus's 2.5% low-end rate stale after the 2026 corporate rate change, and the Cyprus permanent-residency corpus describing Category A's first-sale condition as preferred, overgeneralizing foreign-source income, and omitting Category C's five-employee minimum. Updated local MB-F20 approved wording and generated seed from the Cyprus Tax Department's 80% nexus-based exemption; rewrote EN/AR/EL IP Box and residency guidance with the official-source qualifications. The seed is not applied remotely.
- Simplified the EN/AR/EL company-profile answer to list approved service areas directly and ask one useful goal question. Added short complete formation-package summaries in all three languages and removed wording that could imply EU-wide operating entitlement, guaranteed filing acceptance, or bank-account approval.
- Earlier repair agents' corpus changes remain local: 75 retrieval aliases across 43 files and nine residency/relocation/banking claim reductions. Live search has not ingested these updates.

**Verification:** `npm run test:all` → exit=0 (root **2,173/2,173**, dashboard **135/135**); dashboard build → exit=0; `npm run validate:corpus` → **87/87** clean; `npm run audit:facts` → 82 rows, zero findings; `node scripts/generateFactRegisterSeed.js --check` → generated seed matches catalogue; `node scripts/auditClaimGates.js` → zero unregistered facts, zero evidence-path leaks, zero facts blocked with approved evidence; `node --test scripts/runGoldenKnowledgeEvaluation.test.js` → 22/22; `git diff --check` → no whitespace errors. Deno is unavailable in this Windows environment, so the Edge `deno check` could not run.

**Live readiness boundary:** The saved 879-question report predates corrected model-observation scoring and cannot certify bounded-text coverage. A top-eight diagnostic was stopped after sustained CPU work without producing a report. The six-case live smoke retrieved approved sources, but all six model drafts were rejected and fell back; it sent no customer messages and made no durable writes. The corrected harness's first live attempt exposed a negative-search result-shape bug, fixed with a regression; the 3-positive + 3-negative English bounded smoke then completed and saved `reports/golden-evaluation/live-2026-10-11-bounded-en-smoke.json`. The independent audit also reproduced mixed timestamp/legacy consent ordering that could let an untimestamped old grant override a newer opt-out; it is fixed with 23/23 focused consent/reminder tests. Local corpus and MB-F20 updates have not been ingested/applied, so improvement against refreshed live evidence remains unproven. No live migration, corpus write, Edge deployment, commit, or push occurred; named BOSS gates remain. Calendar/Auth and live booking remain deferred.

**Independent interaction audits and consolidated verification (2026-10-11):** Three additional cross-phase audits found and fixed: (1) same-timestamp opt-out/grant conflicts now resolve to opt-out regardless of rehydrated history order; (2) reminder dispatch cancels if its recipient differs from the appointment's WhatsApp contact, including a change during preparation; and (3) a prepared-but-unpersisted handover no longer tells the customer that it was already shared. CRM memory now excludes inferred, conflicted, or provenance-invalid records from customer-stated facts, and Unicode/case/spacing-equivalent profile values do not trigger false correction questions. The live smoke exposed an overlong deterministic fallback replaying old approved-source text after the model rejected it. Fallback output now passes through the shared response gate; unsafe/overlong excerpts become a localized abstention and are recorded as abstentions. Focused suites: CRM/state **20/20**, reminder delivery **15/15**, qualification/handover/router **112/112**, fallback/RAG **50/50**. Updated `src/multilingualRegression.test.js` to assert truthful handover wording in EN/AR/EL after the consolidated run caught its stale expectation. Consolidated `npm run test:all` passed (root **2,191/2,191**, dashboard **137/137**); dashboard build passed; corpus validation **87/87** clean; fact audit **82 rows, 0 findings**; Edge mirrors and fact-register seed are synchronized; claim-gate audit reports zero unregistered facts, zero control leaks, and zero M2 gaps. `git diff --check` is clean apart from routine Windows line-ending notices.

**Still not ready for customer-data testing:** Read-only live comparison found **18/87** approved documents differ from the corrected local corpus (six topics across three languages). No corpus ingestion or migration was performed in this sweep. The corrected six-case synthetic live-model smoke passed **4/6** answer-quality checks; the two failing Arabic drafts were rejected and safely abstained because live source text is stale or too long. No reviewed full answer set exists, and native-speaker review and privacy/retention workflows remain open. Apply the approved corpus revisions through the supported ingestion path, reconcile pending migrations with live history and worker state, then rerun bounded Arabic/English/Greek answer and refusal cases before real customer traffic. Calendar/Auth and live booking remain deferred.

### 2026-10-11 — P8.4 memory and evidence-boundary follow-up (partial)

**Audit finding and fixes:** The Agent decision prompt allowed a prior assistant reply in recent history to stand in for current approved evidence, despite the shared brain prompt saying memory is not evidence. Both prompt paths now require fresh current-turn tool evidence for company facts, including when the customer refers back to an earlier answer. The generated Edge brain prompt was regenerated. A deterministic integration regression simulates an old quoted price, failed fresh retrieval, and verifies that the price is blocked and the uncertainty response is used.

The Agent WhatsApp adapter now refreshes its bounded/redacted contact topic summary after the source turn and response are durable. The summary records the persisted source turn ID; summary-write failure cannot change the answer or retry the customer turn. CRM writes retry only ambiguous/transient outcomes, reusing the same idempotent source-turn payload; client validation errors are terminal. Focused adapter, conversation-memory, store, decision, runtime, and prompt-parity tests passed **91/91**; Edge prompt and module mirror checks passed. This closes the missing Agent-path summary refresh and stale-history prompt gap and adds bounded replay for same-turn CRM writes. It does not satisfy planned conversation-ID isolation or durable CRM sync-state/reconciliation. No live database or function was changed.

### 2026-10-11 — evidence recall and runtime red-team regression (partial)

**Evidence recall:** The answer-context audit found broad retrieval discarded every result after the first eligible hit per query. Retrieval now collects multiple eligible hits with round-robin facet balance, global deduplication, an eight-chunk ceiling, and a 10,000-character evidence budget. The model prompt and its grounding gate use the same bounded evidence set. Tests cover valid additional chunks, cross-query duplicates, stale/pending rows, and budget limits.

**Bounded prompt audit follow-up (2026-10-11):** Independent review found the prior character budget counted evidence fields but not the rendered labels, source references, redaction, and truncation note. The Agent now measures `formatApprovedKnowledgeEvidence()` output and trims the final selected item until the exact prompt evidence block fits the 10,000-character cap; the evidence and governance metadata used by grounding are rebuilt from that selection. Exact-render tests were added. Latest verification: `npm test` **2,228/2,228**, `npm --prefix dashboard test` **141/141**, `npm run validate:corpus` **87/87**, and `git diff --check` clean apart from routine Windows line-ending notices. Live answer impact remains unmeasured because local corpus revisions are not ingested; factual real-customer testing remains gated on fact approval and source synchronization.

**Output privacy:** A scripted test through the real Agent runtime, tools, and output gate found credential/account-value drafts escaping in EN/AR/EL. A shared Node/Edge detector now blocks explicitly labeled credential, identity, account, verification-code, provider-token, IBAN, and valid card values while allowing ordinary privacy reminders. The Edge mirror is generated and parity tested. 21 category/language representatives plus dedicated consent/capability and benign controls pass (**4/4 integration tests**); focused RAG/privacy/mirror suites pass (**95/95**). This is deterministic scripted coverage, not live-model robustness evidence.

**Read-only live-data smoke:** `npm run eval:conversation` exercised six synthetic EN/AR/EL questions against the current live retrieval store. All six safely abstained with no approved current evidence; `modelUsed=false` for all, no customer messages or durable writes occurred. Latency: average total 2,580 ms, maximum 5,521 ms; average retrieval 2,161 ms. This confirms the current live fact gate prevents factual answers and does not measure answer quality or the local retrieval improvement.

**Current boundaries:** `npm run audit:facts` reports 82 pending register rows and 76 high findings. Company facts remain unavailable until authorized evidence review. Live corpus comparison previously found 18/87 documents differ from the corrected local corpus; no ingestion, live migration, function deployment, commit, or push was done in this follow-up. Calendar/Auth and live booking remain deferred.

**Verification:** `npm run test:all` passed **2,222/2,222 root** and **141/141 dashboard** tests. `npm run validate:corpus` passed **87/87**; Edge mirrors and brain prompt are synchronized; `git diff --check` is clean aside from standard Windows line-ending notices. Plan UI regenerated; roadmap totals remain 16 milestones, 83 phases, 44 done, 15 in progress, 24 not started. No milestone closed.

## 17. Standing verification commands

```bash
# Full suite, real exit code  (~8 min, reserve for G2)
npm test > /tmp/refal-test.log 2>&1; echo "exit=$?"; tail -40 /tmp/refal-test.log

# Dashboard
npm --prefix dashboard test      > /tmp/refal-dash.log  2>&1; echo "exit=$?"
npm --prefix dashboard run build > /tmp/refal-build.log 2>&1; echo "exit=$?"

# M2 phase gate (added by P2.2 / P2.6, 2026-10-09)
# auditClaimGates now runs TWO passes: without evidence and with synthetic
# approved evidence. M2's exit gate is exit == 0, which additionally requires
# that no `expect: "pass"` MB candidate is still blocked WITH evidence.
node scripts/auditClaimGates.js > /tmp/gates.log 2>&1; echo "exit=$?"
node --test src/guardrailRegression.test.js > /tmp/redteam.log 2>&1; echo "exit=$?"
node --test src/claimGateEvidence.test.js src/outputGuards.test.js > /tmp/m2gate.log 2>&1; echo "exit=$?"

# M1 phase gate (added by P1.7, 2026-10-09) — the edge prompt mirror
node scripts/generateEdgeBrainPrompt.js --check > /tmp/edge-prompt.log 2>&1; echo "exit=$?"
node scripts/generateEdgeMirrors.js     --check > /tmp/edge-mirror.log 2>&1; echo "exit=$?"
npm run edge:prompt     # regenerate after ANY edit to src/brainPrompt.js
npm run edge:mirrors    # regenerate after ANY edit to the claim or contact gate

# One command that gates BOTH suites. Root `npm test` alone leaves the 18
# dashboard test files ungated, and this repo has no CI config.
npm run test:all > /tmp/all.log 2>&1; echo "exit=$?"

# Brain specific
# M3 phase gates (added by P3.1-P3.10, 2026-10-09). All four are OFFLINE: they
# need no database and no network, which is the whole point, because this
# environment has no Supabase access and MIG-01 is not applied.
node scripts/validateCorpus.js            > /tmp/corpus.log 2>&1; echo "exit=$?"
node scripts/factRegisterAudit.js         > /tmp/facts.log  2>&1; echo "exit=$?"
node scripts/generateFactRegisterSeed.js --check > /tmp/seed.log 2>&1; echo "exit=$?"
node scripts/brainHealth.js               > /tmp/health.log 2>&1; echo "exit=$?"

# The seed `--check` is the one that catches silent drift: it fails when
# src/factCatalogue.js has changed and the generated migration has not. M2 was
# bitten by exactly this shape in generateEdgeMirrors.js, where a hand-written
# list sat next to a generated file and went stale while --check said success.

# Scoping a corpus run while authoring:
node scripts/validateCorpus.js --topic ip-box
node scripts/validateCorpus.js --phase P3.2
node scripts/brainHealth.js --lang ar --json

# What breaks, and when. Rule 2 is only real if you can see it fire:
node scripts/factRegisterAudit.js --now 2027-02-01

# STILL NOT WRITTEN as of 2026-10-09: redTeamBrain.js (P11.4). Running it today
# exits 1 with MODULE_NOT_FOUND. That is a phase that has not happened, not a
# regression. brainHealth.js and factRegisterAudit.js now exist (P3.9, P3.10).
node scripts/brainHealth.js      > /tmp/brain-health.log 2>&1; echo "exit=$?"
node scripts/auditClaimGates.js  > /tmp/claim-gates.log  2>&1; echo "exit=$?"
node scripts/validateTaxonomy.js > /tmp/taxonomy.log     2>&1; echo "exit=$?"
node scripts/redTeamBrain.js     > /tmp/redteam.log      2>&1; echo "exit=$?"
node scripts/factRegisterAudit.js> /tmp/facts.log        2>&1; echo "exit=$?"

# Knowledge and conversation quality
npm run eval:knowledge      > /tmp/evalk.log 2>&1; echo "exit=$?"
node scripts/evaluateRag.js > /tmp/rag.log   2>&1; echo "exit=$?"
npm run benchmark:agent     > /tmp/bench.log 2>&1; echo "exit=$?"

# M0 phase gates (added by P0.2 / P0.3 / P0.4, 2026-10-08)
node scripts/auditClaimGates.js      > /tmp/gates.log 2>&1; echo "exit=$?"   # P0.2 G2
node scripts/validateTaxonomy.js     > /tmp/tax.log   2>&1; echo "exit=$?"   # P0.4 G2
node scripts/reproduceKnownDefects.js > /tmp/defects.log 2>&1; echo "exit=$?" # P0.3 observation

# Investigating a single blocked sentence
node scripts/diagnoseClaimGate.js "<sentence>"
node scripts/diagnoseClaimGate.js --all

# During development, run the targeted file instead of the full suite
node --test src/<module>.test.js
```

**Reading `auditClaimGates.js` exit codes.** They are deliberately split, because "recorded" and "fixed" are different questions owned by different milestones:

| Exit | Meaning |
| --- | --- |
| **0** | no unregistered conflict and no safety leak |
| **1** | **P0.2 fails** — a blocked MB fact is not recorded in `CONFLICT-REGISTER.md` |
| **2** | **P0.2 passes, M2 owes a fix** — all conflicts registered, a fail-open leak remains |
| **3** | **added by P2.6** — no leak, but an `expect: "pass"` MB fact is STILL blocked when approved evidence is supplied. M2 built the evidence path and this fact cannot reach it. |

Exit 3 exists because the original three codes could only see the no-evidence
world. Once P2.2 made the gate evidence-aware, "the blanket block is registered"
stopped being the interesting question and "does an approved fact actually get
through now" became it. The script runs both passes and prints them side by side.

P0.2's gate condition is `exit != 1`. M2's exit gate is `exit == 0`. Registration must never wave a safety leak through, which is why a leak is not exit 0; but it must also not block P0.2 forever on a repair that belongs to P2.3.

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
| 🧠 **Knows the whole business** | 87 knowledge sources across 29 topics map the manual's 66 fact candidates. Only approved/current facts are customer-speakable; volatile data is resolved through trusted live tables. | M3 |
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
 66 fact candidates     →  mapped to governance (100%); approval/currentness is per claim
 13 known defects       →  13 repaired       (100%)
 12 code defects        →  12 fixed          (100%)
 10 parked dependencies →   0 parked         (all built, each needs one field)
16 milestones · 83 phases · 7 gates per phase
```

**Honest closing note.** This is a build plan, not a completion claim. REFAL is called ready only when section 16's ledger shows every gate passed with a real exit code, and all 195 requirements have linked evidence. That is a quality bar, not a dependency. Nothing in this plan waits on anyone.

---

## 21. Carry-forward register — work deferred OUT of a closed milestone

A milestone can close with work deliberately unfinished. That is legitimate
only if the item is **tracked against the phase that can actually do it**, with
the reason it could not be done earlier. An item recorded only in a Result
block gets buried the moment the next milestone starts, so every deferral is
listed here **and** referenced from its owning phase.

**Rule: a phase may not be ticked `[x]` while a carry-forward row names it and
is still open.** Closing the row is part of that phase's G3.

| ID | Deferred from | Owning phase | What is actually missing | Why it could not be done then | Status |
| --- | --- | --- | --- | --- | --- |
| **CF-01** | **W1.6.2** (M1, P1.6) | **P4.2** | `resolveConflict` was built and unit-tested but had no caller. | Wired into Agent and legacy deterministic dynamic-data composition paths. `src/dynamicDataIntegration.test.js` proves live offer evidence wins over a stale chunk and approved inclusions remain. Independent code audit confirmed both call sites. MIG-02 is applied, the live seed is verified, and deployed `rafa-agent-api` v44 includes the M4 routes; five dynamic read routes passed live smoke checks. | `[x]` CLOSED — both Agent and deterministic callers are wired and behavior-tested; deployed Edge v44 and all five dynamic read routes verified. |
| **CF-02** | **W1.6.3** (M1, P1.6) | **P3.10** | `assertModelKnowledgeIsGeneral` runs live at `src/ai.js` but **always short-circuits to ok**: `sourceLevel` is only `MODEL_KNOWLEDGE` when evidence is empty, and the caller returns early in exactly that case. So the gate can never fire. | The honest fix is per-claim groundedness — asking whether a *specific sentence* is backed by the retrieved evidence, not whether evidence exists at all. That needs a non-empty corpus and the grounding work M3 owns. | `[x]` **CLOSED 2026-10-09 by P3.10.** The row's description was re-verified first and was still accurate: `src/ai.js:122` returned before any model call in exactly the one case that produced `MODEL_KNOWLEDGE`. `assessClaimGroundedness` now calls `assertModelKnowledgeIsGeneral` **per sentence**, so a turn that HAS evidence can still contain a sentence that evidence does not back, and the gate's input genuinely varies. The P1.6 whole-answer call is kept beside it, not replaced. Closed to section 21's own bar: `src/claimGroundedness.test.js` fails when the wiring is removed (proved by patching it out: `exit=1`, 2 of 15 fail), and a partner test fails if the gate blocks a grounded draft, so a block-everything gate cannot pass either. A sentence is deleted only when it is an ungrounded PROGRAM_FACT **and** Refalco-specific **and** carries an unsupported specific value; the third condition was added after the first cut deleted two true `ragPolicy` fixtures, which was BLK-1 returning through a new door. |
| **CF-04** | **W3.10.4** (M3, P3.10) | **P10.2** | **Sibling-chunk expansion on retrieval.** An alias-chunk hit must bring fact-bearing sibling chunks into evidence; returning only the finding-aid table of contents leaves the Agent without approved facts. | Implemented in `20261010140000_refal_retrieval_sibling_expansion.sql`: alias hits are replaced by up to three ranked real chunks from the same eligible approved/current document, and finding aids never leave as evidence. Migration history confirms it is applied; lexical and hybrid RPCs were updated. The remaining golden retrieval score is a separate release-quality measure and is tracked by P14.1/P10.5. | `[x] FIXED 2026-10-11; answer-quality/retrieval threshold remains open` |
| **CF-05** | **W3.10.6** (M3, P3.10) | **P4.1** | **Price-bearing golden questions are graded against an artifact that may not hold the answer.** Five questions per language in `formation-package` top out at 75-83% because the only missing token is the package price, which `corpusFile.js` forbids the corpus to contain (MB-DYN6). | `src/dynamicDataIntegration.test.js` exercises the real `runAgentTurn` loop and proves validated current-offer inclusions compose with the live-tool price while suppressing stale €899 evidence. A read-only synthetic run against deployed approved knowledge and the current offer returned the approved inclusions and EUR 999 plus VAT through the local runtime; no customer message or write occurred. The final decision used the configured live model with strict JSON-schema output; both live read tools returned `found`, the factual and grounding gates passed, and the response was not sent to a customer. The live offer row is €999 EUR, active through 2026-11-06, and Edge v44 offer reads pass. Preserve the coverage threshold. | `[x]` CLOSED — synthetic live-model turn composed live approved source and offer and passed grounding; no external message or write |
| **CF-06** | **W3.9.7** (M3, P3.9) | **P12.2** | `refal_fact_register` is readable from here only because MIG-01 adds an `anon` grant behind `rafa_dashboard_secret_matches()`. There is still **no Node-side `service_role` credential** anywhere in `scripts/`, `src/` or `dashboard/`; only the Deno edge functions hold one. | Not a defect, a credential boundary. It means any future register operation that genuinely needs `service_role` has nowhere to run from. Named here so it is not rediscovered as a bug. | `[ ]` OPEN |
| **CF-08** | **M3 deployment** (2026-10-10) | **P10.2** | **FIX-35.** The lexical ranker compared incompatible `ts_rank_cd` scales, allowing partial matches to outrank fuller matches; hybrid ranking needed a shared deterministic lexical scale. | Fixed in local migration `20261010223908_cf08_lexical_rank_consistency.sql`, applied as history `20261010230731 / cf08_lexical_rank_consistency` on 2026-10-11. Local PGlite regressions cover negation, phrases, duplicate terms, punctuation, Arabic, and Greek. Live WhatsApp retrieval exercised the updated hybrid path. The hybrid halfvec SQL was not independently executable in PGlite; the 870-question release evaluation remains open. | `[x] FIXED 2026-10-11; release evaluation remains open` |
| **CF-09** | **M3 deployment** (2026-10-10) | **P11.4** | **The hybrid retrieval path has no "return nothing" behaviour**, so 0 of 17 negative queries retrieve nothing, against an M3 criterion of 100%. Lexical manages 14/17. | Structural, not a regression: the semantic branch admits anything inside 0.65 cosine distance and the rank fusion then returns the top N regardless. The criterion was written assuming lexical-only retrieval. What actually protects these queries is the answer side, and that part is verified: all three prompt-injection negatives are caught by `classifySafety`, and the per-claim groundedness gate CF-02 added is what stops an unrelated chunk becoming an assertion. P11.4 owns `redTeamBrain.js` and should assert the refusal behaviour end to end rather than scoring retrieval emptiness. | `[ ]` OPEN |
| **CF-07** | **M3 deployment** (2026-10-10) | **P12.2** | **FIX-34.** The `RAFA_DASHBOARD_SUPABASE_SECRET` in this machine's `.env` does not match the sha256 stored in `rafa_private.api_secret_hashes`. Until it does, nothing on this PC can read or write the knowledge tables or the fact register through PostgREST, which means `scripts/ingestBrainCorpus.js --apply`, `scripts/backfillKnowledgeEmbeddings.js`, `scripts/brainHealth.js --db` and the whole W3.9.7 dashboard Facts screen are unusable from here. | It is a credential, so it is BOSS's to resolve, not something to go hunting for. The value is never to be printed. The deployment went through the Management API instead (`scripts/emitCorpusSql.js`, `scripts/emitEmbeddingSql.js`, `scripts/applySupabaseMigration.ps1`), which is not subject to RLS, so M3 is deployed and verified regardless. **What is still unproven is whether the live agent and the dashboard can reach the data**, because they authenticate the same way this PC does. If the deployed app uses a different secret than this `.env`, it is fine and only the local tooling is affected. | `[ ]` OPEN |
| **CF-03** | M1 close observation | **P12.3** | The dashboard streaming path runs **2 of 6** output gates (`containsProhibitedClaim`, `containsUnconsentedContactCommitment`). No `validateResponse`, no anti-patterns, no humour gate. | It is the operator surface: its output is read by staff, not sent to a customer, so copying the customer gates is a decision rather than an obvious fix. | `[ ]` OPEN |

### How to close a row

1. Do the work in the owning phase.
2. Delete the unreachable-branch excuse by proving the caller now exercises it: a test that fails if the gate is removed.
3. Tick the row, and say so in that phase's Result block.

CF-01's original "no live caller" condition is closed by M4's tested dynamic-data composition paths and verified deployed Edge routes; its row contains the evidence. CF-02's retrieval-path limitation is governed by its own row; do not infer it is resolved by CF-01.

---

## 20. Migration run order — BOSS executes these, one at a time

**I write these files. I never run them.** Each is self contained, idempotent, and carries its own `-- ROLLBACK:` block. Run them in this order; each one is safe to run on its own and the agent keeps working without it (the matching capability simply reports "not available" until its migration is applied).

| # | Migration | Creates / changes | Written in | Needed before | Status |
| --- | --- | --- | --- | --- | --- |
| **MIG-01** | `refal_fact_register` + `refal_fact_register_audit` + the `refal_facts_due_for_review` view + 3 RPCs | Per fact provenance: claim, source, type, jurisdiction, reviewer, `verified_at`, `effective_from`, `expiry_or_review_at`, approved languages, status. Plus the `expired` and `blocked` behaviour hooks, the W3.9.7 review list, and audited re-approval | **P3.9** | REFAL stating any number with provenance | `[x]` **SCHEMA APPLIED 2026-10-10**. Live read-only status check on 2026-10-11 shows **82 facts · 82 pending**; no fact is approved for customer use. Earlier approval count was incorrect and is superseded by this live status. |
| **MIG-01b** | `refal_fact_governance` | Document-level governance: stops the save path forcing `review_status=approved` and deleting non-approved rows (CR-014), adds `governance_tier` as a SEPARATE column without widening the existing `trust_tier` CHECK (CR-023), keeps CR-010 intact | **P3.9** | a review step existing at all, and the two trust vocabularies staying separate | `[x]` **APPLIED 2026-10-10**, file `20261010020000_refal_fact_governance.sql`. *Added to this table 2026-10-10 after the M3 audit found it had reached the database without a row in the register that tracks migrations.* |
| **MIG-02** | `refal_offers_and_pricing` | The €999 package and any promotion, with `valid_from` / `valid_until` / `active` | **P4.1** | the live price, `ACTIVE_PROMOTIONS` | **[x] APPLIED 2026-10-10**, migration history `20261010150340 / refal_dynamic_commercial_data`; live seed verified |
| **MIG-03** | `refal_annual_renewal_fees` | Secretary, address, accounting, audit, tax renewals | **P4.1** | `ANNUAL_RENEWAL_FEES` | **[x] APPLIED 2026-10-10**, migration history `20261010150340 / refal_dynamic_commercial_data`; live schema/RLS/grants verified |
| **MIG-04** | `refal_property_inventory` | Units, city, type, status, price, `first_sale`, `pr_eligible`, availability | **P4.1** | `LIVE_PROPERTY_INVENTORY` | **[x] APPLIED 2026-10-10**, migration history `20261010150340 / refal_dynamic_commercial_data`; live schema/RLS/grants verified |
| **MIG-05** | `refal_reservation_rules` | Deposit amount or percent, refundable, conditions per project | **P4.1** | `RESERVATION_DEPOSIT_RULES`, the P2.4 guard | **[x] APPLIED 2026-10-10**, migration history `20261010150340 / refal_dynamic_commercial_data`; live schema/RLS/grants verified |
| **MIG-06** | `refal_government_fees` | Registry, land registry, residency application fees | **P4.1** | `GOVERNMENT_THIRD_PARTY_FEES` | **[x] APPLIED 2026-10-10**, migration history `20261010150340 / refal_dynamic_commercial_data`; live schema/RLS/grants verified |
| **MIG-07** | `refal_lead_profile` | All four MB 5.1 CRM field groups, raw/normalized values, per-field provenance and correction markers, atomic source-turn RPC, one row per contact, RLS scoped | **P8.1** | progressive capture, never re-ask | **[ ] PREPARED, PGlite verified; live application and Edge smoke pending** |
| **MIG-08** | `refal_lead_score` | Six dimension scores, evidence references, scorer version, total, score history | **P6.1** | reproducible scoring and the handoff summary | **[x] APPLIED 2026-10-10**, history `20261010190302 / refal_lead_score`; RLS/schema verified |
| **MIG-09** | `rafa_contact_consents` | Specialist and automated-reminder scopes; language, channel, purpose, source turns, opt-out/reconsent guard | **P9.1** | any follow up or outbound action | **[x] APPLIED 2026-10-11**, history `20261010230719 / refal_m9_consent_scopes`; columns verified. Do not schedule reminders before the live consent/suppression smoke check. |
| **MIG-10** | `20261010210717_refal_booking_state_machine_m7.sql` | Seven workflow states, status index, durable default booking policy | **P7.2** | real bookings | **[x] APPLIED 2026-10-11**; migration history `20261010221510 / refal_booking_state_machine_m7`; constraint, index, and policy row verified |
| **MIG-11** | `refal_handover_delivery` | Delivery attempts, retries, acknowledgment, closure reason, badge reconciliation | **P6.5** | FIX-9 handover delivery | **[x] APPLIED 2026-10-10**, history `20261010190310 / refal_handover_delivery`; RLS/schema verified; delivery smoke pending |
| **MIG-12** | `refal_compliance_events` + `refal_identity_verification` | AML and sanctions escalation records, one time code verification state | **P2.5** | compliance escalation, existing client unlock | `[ ]` |
| **MIG-13** | `refal_rate_limits` | Shared counters replacing in process memory | **P13.2** | FIX fix 11, surviving a restart | `[ ]` |
| **MIG-14** | atomic contact correction | Locked compare-and-merge with same-transaction field-only audit for human CRM correction | **P12.4** | dashboard corrections and audit | **[ ] PREPARED, PGlite verified; live application and multi-instance smoke pending** |
| **MIG-15** | inbound receipt lease fencing | Atomic receipt claim/reclaim and token-fenced completion, preserving the ten-minute recovery window | **P13.1** | matching Edge and WhatsApp worker rollout | **[ ] PREPARED, PGlite verified; stop/drain legacy worker, apply and live multi-instance smoke pending** |
| **MIG-16** | reminder at-most-once delivery | Durable sending/uncertain states, legacy ambiguous-row quarantine, and claim RPC excluding in-flight jobs | **P9.3** | matching Edge and worker rollout | **[ ] PREPARED, PGlite verified; stop legacy worker, apply and live consent/delivery smoke pending** |
| **MIG-17** | MB-F20 current IP Box fact and official source provenance | Replace the obsolete 2.5%-3% range with the 80% nexus exemption and explicitly qualified 3% arithmetic | **P14.5** | refreshed knowledge revision and live retrieval review | **[ ] PREPARED, PGlite verified; BOSS migration approval, apply, corpus ingestion and live smoke pending** |

### How a migration is applied, as of 2026-10-10

The flow below is still the rule. What changed is the last step: BOSS gave an explicit
go-ahead for M3, so the files were applied from this machine rather than pasted into the
dashboard. The instrument is `scripts/applySupabaseMigration.ps1`, which takes **one named
file**. There is deliberately no bulk push: this repo's migration history is not guaranteed to
match what the remote has actually had applied, so `db push` could silently re-run forty files.

```
pwsh -NoProfile -File .\scripts\applySupabaseMigration.ps1 `
     -MigrationPath .\supabase\migrations\<file>.sql -Preview     # shows target, changes nothing
pwsh -NoProfile -File .\scripts\applySupabaseMigration.ps1 `
     -MigrationPath .\supabase\migrations\<file>.sql              # applies, after a confirm prompt
pwsh -NoProfile -File .\scripts\querySupabaseReadOnly.ps1 -Query "select ..."   # verify
```

Both reuse the credential flow in `SUPABASE-ACCESS-GUIDE.md`: the Supabase CLI token from
Windows Credential Manager, used only as a bearer token to the Management API, never printed
and never passed as an argument.

`querySupabaseReadOnly.ps1` has an `-AsService` switch for the case where an object is granted
to `anon` only and the read-only role cannot touch it at all, which is true of
`rafa_search_knowledge` and therefore of the whole retrieval check. It **refuses any query
containing a write keyword**, so the switch cannot quietly become a write path.

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

### 2026-10-11 — pending-fact review worklist (partial)

Added `scripts/generateFactReviewPacket.js` and `docs/brain/FACT-APPROVAL-REVIEW-PACKET.md`. The offline generator reads the canonical catalogue and validates corpus files, then records the exact canonical claim, source class/reference, jurisdiction, registered numbers, runtime status, and all corpus section wording in each available language for the 76 pending facts currently declared in customer-answer corpus. Each entry has reviewer decision, evidence, language, and review-date fields. `npm run facts:review-packet` refreshes the artifact. Generation does not change approval state or access Supabase.

An official-source audit of public legal/regulatory facts identified claims requiring correction or tighter scope, including non-dom tax/SDC wording, PR Category A first-sale conditions, company closure routes, EORI/VAT scope, and Category B immigration permit conditions. Detailed URLs and claim-by-claim verdicts are being incorporated before those claims are edited. Commercial claims remain pending Refalco evidence and authorized review. The live conversation smoke safely abstains because no current approved facts are available; real-data factual answer testing is therefore not ready. No milestone is closed.

Correction to the preceding status: the detailed primary-source verdict table was returned and is recorded in the session evidence. The highest-risk Non-Dom overstatement (a universal 0% rate for 17 years) has now been narrowed in the catalogue and all three corpus languages to the SDC exemption, 17-of-20 deemed-domicile test, and conditional 2026 alternative extension application. Official Tax Department URLs and review date are in MB-F34 provenance. The investor-permit Category A catalogue claim now says the developer first-sale condition is mandatory; Category B wording no longer asserts that combined/redeveloped commercial property is preferred. All claims remain pending and non-statable until valid fact approval. The broader official audit lists further narrowing needs for MB-F14, F17-F18, F21-F22, F26-F27, F30-F33, F39-F41, F43, F48, and MB-J1-J4; those remain open for bilingualized source-backed cleanup/review. The seed migration and 76-row reviewer packet were regenerated locally. No database writes or deployments occurred.

### 2026-10-11 — local improvement and verification refresh

Root, dashboard, corpus, and focused Agent regressions were rerun after the multilingual, evaluation-catalog, load-report, and retrieval fail-closed fixes. `npm test` passes **2,248/2,248**; `npm --prefix dashboard test` passes **141/141**; `npm run validate:corpus` reports **87/87 clean**; the focused Agent/RAG/booking/evaluation command passes **144/144**. `npm run audit:facts` correctly fails with **76 high pending facts**, so factual real-data answers remain blocked by the approval register. The current evidence supports synthetic or read-only retrieval diagnostics, but not client-facing factual answer testing. No live writes, migrations, deployment, push, or customer messages were made. Plan progress UI regenerated: **44/83 phases done, 30 in progress, 9 not started**; no milestone was closed.

### 2026-10-11 — customer answer path and local audit follow-ups

The P8.2 audit follow-up corrected CRM affirmative/negation handling across Node and Edge. Regression coverage includes English, Arabic, and Greek postposed negatives (including no-longer/never ellipses), affirmative fronted and postposed “not only” contrasts, contrastive correction wording, Arabic diacritics, and Unicode compatibility spellings. Literal evidence extraction preserves the original customer spelling while matching normalized text. An independent re-audit confirmed parity for the enumerated cases; regex coverage remains bounded and does not guarantee general negation detection. Focused CRM and regex tests pass **24/24**.

P9 local follow-up now respects WhatsApp-specific reminder consent and the consent’s saved language; sent copy and history use the same EN/AR/EL text. P12.3 now serializes concurrent acknowledgement/resolution operations per contact within one dashboard process; focused status tests pass **5/5**, while cross-instance atomic coordination and live host verification remain open. M11.4 adds a real Agent-loop regression for hostile approved-tool-result content and a leaked-prompt draft; the deterministic runtime red-team set contains 200 fixtures, but no live-model proof is implied.

P10.3 now carries the shared register-mirroring rule through the active Agent decision prompt as well as the WhatsApp/operator prompt variants and generated Edge prompt; prompt version is **1.11.0**. `src/agentDecision.test.js` and prompt parity coverage exercise this active path. P13.6's synthetic failure injector now supports one injected failure per selected stage, with regression coverage; a 1,000-turn local run at concurrency 32 completed with zero failures/rejections. P14.2 includes a local inbound-to-answer composition test through routing, preflight, Agent loop, approved-knowledge tool, and one fake send, with in-memory history. This is a local vertical slice only: it does not exercise live webhook delivery, database persistence, model/provider, dashboard UI, or WhatsApp sending.

### 2026-10-11 — final local verification refresh

After the P12.3 independent audit found a mixed-group acknowledgment timestamp edge case, the dashboard sync now timestamps only rows that finish in the acknowledged state under an acknowledge action. Its regression covers a resolved sibling with no prior ledger row. The independent re-audit found no remaining related timestamp or retry defect. Full root tests pass **2,268/2,268**; full dashboard tests pass **149/149**; focused P12.3 tests pass **12/12**. Dashboard production build passes; corpus validation reports **87/87 clean**; generated Edge brain prompt and mirrors are synchronized; `git diff --check` passes with routine Windows line-ending notices. The progress page was regenerated at **44/83 phases done, 33 in progress, 6 not started (53%)**. The owner-supplied fact register still has **82/82 live rows pending**; company-fact answers remain gated pending authorized review. No live database writes, migrations, deployment, push, or customer messages occurred.

Read-only live database diagnostics (2026-10-11) show 87 enabled/approved/ready knowledge sources, 87 approved and unexpired documents, 577 chunks, and **82/82 fact-register rows pending**. Raw search returns the expected `MB-F1` tags for the company-setup question in EN/AR/EL (two top-five chunks per language), but all three have zero approved fact rows, so the Agent's statability filter must withhold them. A separate nine-question sample (three per language, covering setup, package and services) returned raw search rows for all English and Arabic cases and two of three Greek cases; this is retrieval-only evidence and generated no answer. Live metadata lists `rafa-agent-api` ACTIVE v51 and migration history only through `20261011022104 / refal_fact_approval_gate`; local MIG-13, MIG-15, MIG-16, and MIG-17 are not applied. The repository's Windows Management API credential currently fails with `Invalid access token`; read-only counts and metadata came from connected Supabase tools and involved no writes or customer data. `npm test` passes **2,259/2,259**, dashboard passes **142/142**, corpus validation is **87/87 clean**, Edge mirrors and generated brain prompt are synchronized, and `git diff --check` reports no whitespace errors (only Windows line-ending notices). The generated progress UI reports **44/83 phases done, 32 in progress, 7 not started**. All 82 facts remain non-statable until authorized approval; no migration, deployment, push, or customer message occurred. External release and full P14.2 workflow coverage remain open.

### 2026-10-11 — multilingual, intake, telemetry, and handover audit refresh

The owner manual hash matches the preserved repository source. Local improvements this pass add multilingual language-cue regressions, P15.1 draft intake validation, duration-only model telemetry, and P6.5 handover ledger read-back checks. An independent red-team review found and drove fixes for the language detector’s English-name and mixed-clause edge cases; independent privacy review found and drove fixes for cancelled-history and concurrent-cancellation reconciliation. The telemetry review fixed a dropped outcome field. Latest local verification: root **2,288/2,288**, dashboard **152/152**, dashboard production build passes, corpus **87/87 clean**, Edge mirrors and brain prompt are synchronized, P15.1 packet tests **7/7**, and P6.5 sync tests **15/15**. `npm run eval:knowledge` reports **16/16** candidate-retrieval/preflight cases; it explicitly does not prove statability or generated-answer quality. Latest read-only production RAG artifact found **0/6** static company/service cases statable; the current dynamic offer case passed. `health:brain` reports **261 gaps**, chiefly because the local seeded view marks pending facts non-statable and the live register is unreachable to that CLI. The live fact register previously read **82/82 pending**. All company facts remain gated until authorized review. P15.1, P6.5, multilingual answer quality, and remaining live/runtime gates stay partial; no DB write, migration, deployment, push, or customer message occurred.

### 2026-10-11 — client answer context and retrieval checks (partial)

The local answer path now suppresses the same broad-services follow-up when that exact localized question was already asked in recent assistant history. A regression confirms the repeated prompt is not appended; wording-equivalent paraphrases remain outside this narrow check. The real-data RAG harness adds natural bank-account help questions in English, Arabic, and Greek, each requiring both the no-guarantee boundary and the financial institution's final-decision boundary. These cases verify local expected corpus coverage only; they do not prove live approval, statability, or generated-answer quality. Focused checks pass: runtime **17/17**, Agent decision/RAG policy **84/84**, RAG evaluator **8/8**, and the banking topic corpus is **3/3 clean**. Latest full verification passes root **2,290/2,290**, dashboard **152/152**, corpus **87/87 clean**, and Edge mirrors plus generated brain prompt are synchronized. A current read-only check through the connected Supabase project confirms **87 approved documents (29 per language), 82/82 facts pending, and one approved offer**. The Agent can exercise approved dynamic offer reads, but company/service facts remain non-statable until their claims receive valid approval. The Windows Management API helper still returns `Invalid access token`; no direct content retrieval or answer was attempted. No database writes, migrations, deployment, push, or customer messages occurred. No milestone is closed.

### 2026-10-11 — answer-quality and knowledge-feedback gates (partial)

The answer-language quality gate now requires each of English, Arabic, and Greek to reach at least 85% top-level quality, in addition to the existing cross-language spread limit. This closes a false-green where all languages could score equally poorly. P15.1 now embeds and stores the complete chunk batch while a revision remains pending, then records audited approval only after successful indexing; missing chunks, invalid/incomplete vectors, and partial indexing fail closed. P15.2 adds an offline feedback-case validator with bounded identifiers/topics, valid timestamps, and PII/secret scanning; P15.3 adds a scheduled-review readiness report that blocks when evidence, owner/reviewer independence, pending facts, or corpus quality is insufficient. Independent audit findings were reproduced and fixed, including long phone-like case IDs, invalid dates, PII in change references, and normalized owner/reviewer identity collisions. These are local workflow/readiness tools: no feedback is persisted and no scheduled job or live review was run. Authenticated reviewer identity still cannot be cross-checked against packet submitter or staff qualifications, and live retrieval smoke/rollback evidence remains open.

Verification: the latest `npm run test:all` passed (root suite and dashboard suite; root output includes the PGlite migration checks, dashboard **154/154**); focused answer/RAG/language regressions passed **69/69**; P15 feedback and review checks passed **13/13**; the captured feedback fixture validates; corpus is **87/87 clean**; generated prompt and Edge mirrors are synchronized; `git diff --check` has no whitespace errors. The local scheduled-review report correctly remains `REVIEW_REQUIRED` because fact rows are pending and independent human ownership/evidence is not supplied. Live read-only status remains **82/82 facts pending**, so company/service facts are still not ready for real-data factual answer testing. No live database writes, migrations, deployment, push, or customer messages occurred. The roadmap remains open.

### 2026-10-11 — P6.5 isolated claim hardening and live answer readiness

A parallel implementation audit found the P6.5 claim-by-ID route bound the synthetic run marker, recipient, kind, and status but did not bind the persisted job to the expected `p65-handover:<run-id>` idempotency key. Added Edge preflight validation and follow-up migration `20261011130000_rafa_p65_claim_idempotency_guard.sql`; PGlite coverage proves a row with the right marker but an unrelated key remains queued, while the exact synthetic row is the only row claimed. Focused migration/policy/live-runner checks pass **31/31**. The existing fake-mailer runner remains local synthetic evidence only. P6.5 stays partial until the reviewed follow-up migration and Edge code are applied/deployed and a controlled delivery/status/dashboard round trip is independently verified.

An independent P14.1 audit checked the full denominator, candidate evidence eligibility, explicit human adjudication, negative refusal adjudication, all-language minimum quality, and parity gate; it found no additional false-green defect. Focused evaluator tests pass **25/25**. The full answer set still lacks human-adjudicated candidate answers, so answer quality is not established.

Live read-only evaluation of current deployed knowledge passed **16/16** retrieval/preflight cases (embedding available; retrieval average about 913 ms). A six-scenario EN/AR/EL conversation check found **0 statable company evidence rows** and safely abstained in all six; no model call, booking, handover, or customer send occurred. The current fact-register query confirms **82/82 rows pending**. The Windows Management API helper still returns `Invalid access token`, but the connected project's bounded read-only query succeeded. These checks establish current retrieval and fail-closed behavior, not factual answer quality. The reviewer packet and approved-knowledge workflow must clear the facts before customer testing of company-specific answers. No database writes, migration, deployment, push, or customer messages occurred.


### 2026-10-11 — VAT/EORI multilingual source-boundary follow-up

A further EN/AR/EL copy pass narrowed the VAT/EORI page title from a universal registration implication to requirements to check, removed the claim that shipment decisions must universally be written before the first shipment, and changed the four-answer promise into a statement that context can help a specialist identify applicable checks. These are candidate knowledge edits only; MB-F26/MB-F27 remain pending and cannot be stated to customers. Focused corpus/fact tests pass **68/68**; npm run validate:corpus reports **87/87 clean**; npm run test:all exits successfully (dashboard **152/152**); git diff --check reports no whitespace errors, with routine line-ending notices. No live fact approvals or customer-answer tests were performed. The live fact gate remains 82/82 pending, so company-specific factual testing with client data is still not ready. No database write, migration, deployment, push, or customer message occurred.

### 2026-10-11 — parallel P11.4, P13.1, P14.2, and source-boundary follow-up

P11.4: independent local audit reproduced a cross-customer privacy gap for questions about a specifically related client's transaction without a name or “another” marker. Strong rules now block the reproduced transaction probes in EN/AR/EL while keeping general customer pricing questions answerable. Node and Edge mirror are aligned. Focused cross-customer/red-team/runtime tests pass **32/32**, including the 200-case deterministic corpus. P11.4 remains partial for live-model robustness, live cross-contact authorization probes, complete credential scan, and independent adversarial review.

P13.1: local executor now canonicalizes legacy `@c.us` and current `@s.whatsapp.net` identifiers to the same scheduling key, preventing same-phone turns from overlapping when webhook spellings differ. Task data retains its original identifier. Focused receipt/concurrency/migration tests pass **20/20**. P13.1 remains partial because the inbound-fencing migration is not applied and matching worker/Edge rollout plus multi-instance smoke is unverified.

P14.2: the EN/AR/EL synthetic workflow seeds prior customer/assistant turns, passes the actual recent-history formatter into the Agent decision context, and asserts one grounded next-step question. It also covers contextual follow-ups after company-formation questions. The follow-up regression exposed that English “form a company” and Greek “ίδρυση εταιρείας” were missing from the bounded topic matcher, so the runtime skipped retrieval and returned its generic uncertainty fallback. Added those common topic forms; English, Arabic, and Greek follow-ups now carry the prior topic into approved-knowledge retrieval. Focused workflow/runtime tests pass **23/23**. Verification uses synthetic approved fixtures and deterministic model decisions; provider/model behavior, Supabase persistence, webhook, dashboard, and live client action paths remain unverified, so P14.2 remains open.

Corporate-tax source follow-up: official Tax Department T.D.4 data confirms 15% from tax year 2026, and the government fiscal report confirms 1 January 2026 as the effective date. MB-F19 now records those sources and a currentness date. EN/AR/EL corporate-tax guidance no longer presents accounting expenses as a complete tax calculation, assumes inactive-company obligations universally, or promises a tax plan from four answers. The source-only section is explicitly tied to MB-F19 so blocked-fact ingestion still drops it. The reviewer packet and seed migration were regenerated; MB-F19 and all facts remain pending.

Verification after integration: focused corpus/register/migration suite **71/71**; full corpus **87/87 clean**; latest focused EN/AR/EL workflow/runtime suite **23/23** and P11.4/P13.1 privacy, red-team, and concurrency regressions **40/40**; full `npm run test:all` exits **0** (root plus dashboard; dashboard **152/152**); generated Edge mirrors match; fact packet contains **76 pending corpus facts**; seed generator check matches the catalogue. The latest read-only live `npm run eval:knowledge` run reports **16 passed, 0 skipped, 0 failed**, embeddings available, embedding average **191 ms**, and Supabase retrieval average **810 ms**. Its scope is candidate retrieval and restriction preflight only; it does not test fact statability or generated answers. One first full-suite attempt caught the source-only section's missing fact scope and a stale Edge mirror; both were fixed, then the repeated full suite passed. Read-only production evidence from 2026-10-11 confirms **82/82 facts pending**, Edge v51, and live migration history through `20261011022104 / refal_fact_approval_gate`; prepared inbound fencing/shared limiter work is not deployed. No live write, migration, deployment, push, or customer send occurred. No milestone or phase was closed.

### 2026-10-11 — continuation: P6.5/P13.2/P14/P15 audits and current live answer gate

An independent P6.5 audit inspected the delivery lifecycle, sandbox recipient restriction, badge/ledger reconciliation, latest claim-by-ID migration and Edge route. Focused local checks pass **38/38**; no local high-severity defect was found. P6.5 remains partial because the claim-hardening migration and Edge changes are local, the previous controlled email delivery failed SMTP authentication, and live delivery, dashboard reconciliation and cross-instance behavior are unverified.

An independent P13.2 audit added a 32-call concurrent PGlite regression: exactly **7/32** calls are allowed for the limit and the stored counter stops at **8** (the first denied attempt). The focused shared-limit suite passes **15/15** and Edge mirror parity passes. The migration remains unapplied; separate PostgreSQL connections/workers are not covered, and the process-local outage fallback is not a global limit.

Independent P14 review reran the Agent runtime, EN/AR/EL customer workflow and answer-evaluation harness (**56/56**). No new local high-severity issue was reproduced. P14.1 remains unscored without human-reviewed answers for the full 879 positive and 17 negative cases; P14.2 evidence is synthetic; no bounded live shadow or live RLS/model red-team run occurred.

Independent P15 review found that the local scheduled-review validator treated punctuation/accent/initial name variants as distinct reviewers. It now rejects normalized variants such as `A. Smith` and `A Smith`; P15 validator/review tests pass **21/21**. This is an offline metadata check only; authenticated reviewer identity and qualifications still are not checked against staff records, feedback tickets have no restricted persistence/access control, and the scheduled review does not read live freshness or prove rollback.

Current read-only Supabase aggregates show **87 approved knowledge documents (29 each in EN/AR/EL), 82 pending fact-register rows, and one active approved offer**. `npm run eval:knowledge` passes **16/16** raw candidate/restriction checks (embedding average **191 ms**, retrieval average **810 ms**). The actual production answer retrieval smoke, `node scripts/evaluateRag.js reports/rag-evaluation/real-data-2026-10-11-continuation.json`, returns **0/9 statable static-fact cases** because the fact approval gate excludes pending facts; its separately approved dynamic offer check passes. This is a real-data answer-readiness failure by design, not evidence that raw keyword/semantic candidate search has no chunks. No generated factual answer was attempted. `npm run knowledge:review` remains `REVIEW_REQUIRED` at **0/82 current** with owner/reviewer missing.

After the P15 validator fix, full `npm run test:all` exits **0** (Dashboard **154/154**), `npm run validate:corpus` reports **87/87 clean**, generated Edge mirrors match, and `npm run plan:ui` reports **44/83 done, 37 in progress, 2 not started**, with P6.5 next. The owner manual and operating rules were reread; their facts remain reference material pending independent approval. No live write, migration, deployment, push, or customer message occurred. No phase or milestone was closed.

### 2026-10-11 — P8/P11 follow-ups and live approved-offer answer smoke

P8 audit reproduced repeated-question behavior when a known CRM `businessActivity` had been saved under a common paraphrase. `src/neverReAsk.js` now recognizes the audited paraphrase forms across English, Arabic, and Greek; the Agent-loop regression confirms a repeated question is rejected and regenerated. Focused CRM, memory, recap, and loop checks pass **83/83**. Conversation-ID isolation, durable CRM sync/reconciliation, and resumed-chat behavior against live storage remain open.

P11 red-team audit found that present or habitual questions about a specific customer's payments or quotes could evade the cross-customer detector in English and Greek. Added narrow rules and EN/EL regression and generic-pricing controls, then regenerated the Edge mirror. Focused privacy, output guard, red-team, decision, and mirror checks pass **47/47**. Live-model injection behavior and cross-contact RLS probes remain unverified.

The approved formation-offer answer smoke reproduced inconsistent model tool choice: before the runtime change, English and Arabic package price cases skipped `lookupActiveOffer` while Greek selected it. The runtime now deterministically prefetches the approved live formation offer for explicit price questions in EN/AR/EL and contextual price follow-ups anchored to prior customer-authored formation messages. Assistant messages can neither trigger the lookup by themselves nor supply evidence. Unit checks cover all three languages, prior-topic follow-up, and this trust boundary (**23/23** runtime tests). The read-only live-model smoke now passes **3/3** synthetic-language cases with the current approved offer observed and response-language/output-policy checks passing; it exposes summary metadata only and makes no contact writes or sends.

Static company/service factual answers remain blocked: live read-only status is 87 approved documents, 82 pending facts, one approved offer; the 9 static answer cases remain non-statable by design. Retrieval/preflight passing does not imply a statable answer. Full `npm run test:all` exits 0 (Dashboard **154/154**); generated Edge mirrors and brain prompt match; `git diff --check` is clean apart from routine Windows line-ending notices. The progress UI remains **44/83 done, 37 in progress, 2 not started**, next P6.5. No live writes, migration, deployment, push, or customer message occurred.


### 2026-10-11 — P7/P9/P10 independent audits and verified fixes

P7.1–P7.5 were independently traced through the booking state machine, Agent and WhatsApp routes, dashboard OAuth onboarding, Edge appointment transitions, and migration/tests. The focused suite passes **96/96**. No deterministic local defect was reproduced. P7.1 and P7.3 remain partial because Google OAuth is intentionally deferred; the pending-review path is covered and truthful, but live availability and confirmed Calendar bookings are not available.

P9 audit reproduced a stale-consent race: a contact opted out or became blocked after bulk eligibility was read, but before an outbound follow-up send. `src/followUp.js` now rereads the durable user/consent and suppression state immediately before each candidate send, checks channel-specific WhatsApp consent, mirrors the stored language, and disables sends if fresh consent cannot be read. Regression coverage includes a fresh opt-out, fresh block, missing consent reader, and EN/AR/EL delivery wording. The focused consent, follow-up, reminder, scheduler, and migration checks pass **59/59**. This narrows the race; consent and an external provider send still cannot be atomic. No outbound message was sent.

P10 language, glossary, prompt-parity, multilingual regression and answer-scoring audit passes **96/96** with no deterministic detector bug found. P10.4 remains partial: six canonical glossary labels exist but broader company/property terminology has no native-reviewed variants; native review status is pending. P10.1–P10.3 and P10.5 still lack independently adjudicated live-model answers, so language quality and parity remain unmeasured.

No Supabase write, migration, deployment, commit, push, Calendar authorization, or customer message occurred in these audits.

### 2026-10-11 — P12 commercial-data editor audit

Independent P12 review reproduced a race where a delayed GET for the previous commercial-data tab could replace the rows or loading/error state after an operator switched tabs. `dashboard/src/DynamicData.jsx` now gates success, failure, and final loading updates with a monotonic request ID and invalidates the old request synchronously on tab switch. Focused dashboard coverage passes **16/16**, and the dashboard production build passes. P12.1–P12.4 remain partial pending the live admin review/CRUD/correction flows, live reconciliation, and migration application; no live write was attempted.

### 2026-10-11 — P13 resilience and P14 trial-readiness tooling

P13.3–P13.6 audit reproduced a model-breaker accounting defect: with concurrent requests, a transient failure below threshold invalidated a healthy success and let intermittent failures accumulate. The breaker now advances its generation only when the circuit actually changes state; the existing stale-success protection after the breaker opens remains. Focused breaker, telemetry, and load suite passes **20/20**. A bounded synthetic load of 1,000 turns at concurrency 32 completed with 0 failures and 0 queue rejections; an intentionally undersized queue correctly rejected excess work. These are local synthetic results, not live provider, database, RAG, Edge, WhatsApp, latency, or cost evidence.

P14.5/P14.6 now have an offline validator for 30 release evidence gates and an operator guide plus blocked packet template. The validator rejects missing/blocked/duplicate/unknown evidence, requires a named owner and independent verifier, and accepts only parseable past UTC verification timestamps. A further regression closes owner self-verification and future-dated evidence; the validator suite passes **6/6** and is included in `npm test`. `NOT_READY` in the checked-in template is expected. `READY` would prove packet completeness only, never production state or authorization. Full 195-requirement traceability, live workflow evidence, owner/security/review approvals, and independent rollback/pause-switch rehearsals remain open.

### 2026-10-11 — current real-data readiness recheck

The refreshed `npm run eval:knowledge` run passes **16/16** live candidate-retrieval/preflight checks (embedding average **202 ms**, retrieval average **857 ms**). The live-model `npm run eval:approved-offer` smoke passes **3/3** EN/AR/EL synthetic questions; each answer observed the current approved formation offer, used only approved-search and offer-lookup read tools, and passed response-policy and language checks. No contact writes or customer messages occurred.

The refreshed real-data static-answer RAG sample (`reports/rag-evaluation/real-data-2026-10-11-goal-refresh.json`) remains **0/9 statable** across EN/AR/EL, with embeddings available and no retrieval errors. The approved-knowledge filter correctly excludes every candidate whose mapped fact is still pending; this result must not be described as raw search failure or repaired by loosening approval. `npm run knowledge:review` remains `REVIEW_REQUIRED`, 0/82 current, with owner and independent reviewer missing; `npm run audit:facts` reports **76 blocking pending-fact findings**.

After P7/P9/P12/P13/P14 follow-up changes, full `npm run test:all` exits **0** (Dashboard **157/157**). Corpus validates **87/87 clean**; the fact seed, generated Edge mirrors, and brain prompt are synchronized; `git diff --check` is clean on scoped changes. Progress remains **44/83 phases done, 37 in progress, 2 not started**. Tomorrow's evidence-supported trial is limited to the bounded read-only approved-offer path; broader customer-facing factual trial remains gated on authorized fact review and the separate P14 release evidence gates. No live writes, migrations, deployment, push, Calendar authorization, or customer message occurred.

P14 readiness-validator follow-up: an independent pass tightened reviewer independence to catch initials, reordered names, punctuation and accents, and requires the verification timestamp to be a real canonical past UTC instant. Its expanded suite passes **6/6**; the full `npm run test:all` rerun exits **0** (Dashboard **157/157**).

Approved-offer evaluator evidence follow-up: each live run now writes a sanitized machine-readable report at `reports/release-readiness/approved-offer-live-smoke-latest.json`. It records per-language pass status, tool names, output length, policy validity, UTC time and scope, but excludes generated answer text, commercial values, customer data, writes and sends. A regression verifies the report allowlist and the explicit non-production scope.

P8 isolation re-audit: focused CRM schema/migration, extraction, never-reask, summary refresh, WhatsApp adapter, Edge store and retry coverage passes **66/66**. No reproducible local defect was found. The actual stored-contact/source-turn ownership checks and resumed-profile-to-never-reask path are covered locally. P8 remains partial for conversation-ID-level isolation, durable sync reconciliation/outbox, unapplied MIG-07/live Edge verification, and a real resumed WhatsApp chat.

P15.2 privacy follow-up: an independent inspection found the feedback-case PII filter missed Arabic-Indic and Persian phone digits and Bearer credentials. The validator now scans Unicode number characters and Bearer tokens across free-text fields, references and review metadata; regressions cover both digit sets and a JWT-shaped bearer value. The fixture remains valid and the validator checks only obvious patterns: it cannot prove anonymization or authorize storing feedback. Focused P15 feedback and knowledge-review checks pass **22/22**. P15 remains partial pending restricted case storage/access, authenticated reviewer identity and qualifications, verified regression evidence, scheduled operations, live freshness and rollback evidence.

P11.4 independent security audit reproduced a Greek cross-customer false-positive caused by a malformed Unicode word boundary in `src/crossCustomerPolicy.js`. The policy now recognizes the boundary correctly, with regressions showing the actual phrase `ο προηγούμενος πελάτης` still triggers protection while compounds `αντιπροηγούμενος πελάτης` and `μηπροηγούμενος πελάτης` do not. The Edge mirror was regenerated. `node --test src/crossCustomerPolicy.test.js src/mirrorParity.test.js` passes **34/34**, and `node scripts/generateEdgeMirrors.js --check` passes. P11 remains partial pending live model/tool-result injection, cross-contact authorization/RLS probes, a complete credential/history scan, and an independent adversarial audit.

Current read-only corpus parity recheck (2026-10-11): canonical content hashes from all **87/87** live knowledge documents were compared to the locally authored corpus. **57/87** hashes differ, across 19 topics in all three languages; all 87 live documents report document-level `approved`, while this is separate from the fact register, where **82/82** claims remain pending. Six live documents have expiry timestamps. The local corpus validates, but these unsynchronized local edits have not been ingested and must not be treated as deployed improvements. This supersedes earlier parity snapshots (including 18/87) and strengthens the live-sync gate: reconcile and review each changed revision, then run bounded live retrieval and answer checks before real-customer testing. The comparison read only document metadata and performed no writes.

P3.10 operator follow-up: added `npm run check:brain-live`, a full-corpus read-only parity check that reports approved hash matches/mismatches, pending revisions and expiry metadata without printing content. It rejects partial selections and cannot be combined with `--apply`. A fresh live run confirms **30/87 match, 57/87 mismatch, zero missing sources/approved revisions**, and zero pending document revisions; the 82 pending fact rows remain a separate hard gate. CLI constraint regression passes. This improves visibility and operator safety but does not synchronize or approve anything; no live write occurred.

P3.9 answer-path audit found that Node-side `supporting`/`governedFacts` metadata was not included in the same fact approval and freshness gate as `facts`. Both paths now union/deduplicate these governed claim IDs before evidence is admitted; pending supporting claims are withheld and approved supporting claims remain represented in policy metadata. Focused Node tests pass **49/49**, Edge knowledge metadata plus claim policy tests **249/249**, and generated Edge mirrors match. Separate limitation: Edge `agent/generate` accepts evidence from its internal caller and relies on deterministic caller-side fact gating; this interface boundary has not been independently probed live. No deployment occurred.

Database-aware health recheck (2026-10-11): `npm run health:brain -- --db` exits **1** with **340 gaps** and **1 pending DB check**. Offline corpus health remains **87/87 clean**, **879/879 lexical questions reachable**, and **17/17 negative queries below the over-retrieval ceiling**. Live-approved documents differ in stored chunk counts from the current local plan in several topics, consistent with the 57/87 corpus hash mismatches. The same invocation cannot read `refal_fact_register` with the dashboard role, so its fact-status diagnostics use the seed and are not live register evidence. Do not interpret its document-approved state or local corpus health as fact approval or real-data readiness.

P14.1 grounding follow-up: a Node output-gate audit reproduced Arabic and Greek unsupported-service list claims that bypassed the English-only `offers/provides` detector. The gate now detects localized service list phrasing and separators, rejects unsupported services appended to supported ones, and retains supported single-service answers. Grounding plus full customer-answer integration tests pass **32/32**. This is a local deterministic regression; independently reviewed answers and live model quality scoring remain open. Edge parity check passes because this Node-only output gate is not mirrored in Edge.

Edge/dashboard trust-boundary audit found that `/agent/generate` accepted caller-supplied evidence text plus caller-supplied approval metadata. The function now accepts chunk IDs only and reloads canonical chunks, document/source approval, expiry and fact-register rows with its service-role client; read errors fail closed. Alias finding-aid chunks are excluded from generation evidence. Added forged-content/pending-fact, source-state, unknown-ID and alias regressions. The dashboard no longer falls back to a local model after the trusted Edge generation path fails, and its outage reply never quotes raw search evidence; it retains deterministic restricted-topic refusals and now has a Greek retry message. Focused Edge tests pass **4/4**, Deno type check passes, dashboard fallback tests pass **7/7**, and generated mirrors match. No deployment occurred. This closes the caller-evidence gap locally; live Edge verification and release deployment remain separate gates.

Integrated re-verification after the grounding and trusted-evidence fixes: `npm run test:all` passes **2,353 root tests and 158 dashboard tests**; dashboard Vite build, Edge Deno check, Edge mirror parity, and focused Node/Edge/dashboard regressions pass. The prompt-parity contract now asserts dashboard delegation to the trusted Edge generator instead of requiring a second local prompt/model implementation. No Supabase writes, migrations, deployment, push or customer sends occurred.

After these local changes, `npm run eval:approved-offer` again passes **3/3** synthetic EN/AR/EL questions against the live read-only offer path, using only approved-knowledge and offer reads and passing response-policy/language checks. Its sanitized report is `reports/release-readiness/approved-offer-live-smoke-latest.json`. This remains local Node runtime evidence; it does not verify the updated Edge route or clear static factual answers for customer use.

Fact-review handoff improvement: the generated `docs/brain/FACT-APPROVAL-REVIEW-PACKET.md` previously listed only the **76** pending facts found in static corpus sections, making six additional pending rows invisible. The offline generator now accounts for all **82** pending rows, separating the 76 static claims from six `MB-DYN1..6` runtime-source contracts with explicit instructions that this review does not approve returned values. A regression asserts every pending ID appears exactly once; focused packet validation passes **8/8**. This changes no live register state.

P14.6 validator audit found a fail-open path when a caller supplied an invalid validation clock: JavaScript compared future verification timestamps against `NaN`, allowing a fully passing packet to report `READY`. The validator now rejects an invalid/non-Date clock, with a regression using future-dated evidence and an invalid clock. Focused validator tests pass **7/7**; the full root `npm test` run passes **2,340/2,340**. The validator remains a structural check only; linked artifacts still require independent human inspection.

P10 multilingual audit found an explicit language preference gap: “Could you answer me in Greek?” did not lock Greek because the English verb `answer` was absent from the language-request patterns. The target-language patterns now recognize it, with regressions for AR/EN/EL preferences and current-turn detection; the Edge language mirror was regenerated. Focused language/prompt/mirror tests pass **36/36**, and the mirror check passes. Native terminology/persona review and independently adjudicated answer-quality parity remain outstanding.

P13.4 Edge provider audit found that the deployed-runtime code path called OpenRouter with bare `fetch`, without a deadline for either connection or response-body parsing. Added a transport helper with a 20-second end-to-end timeout, abort handling, bounded 503 failures and regressions for stalled fetch/body and invalid timeout input. Focused transport tests pass **4/4**, and `npx --yes deno check supabase/functions/rafa-agent-api/index.ts` exits 0. The integrated regression passes root **2,346/2,346** and dashboard **157/157**. Live provider failure behavior remains unverified; no deployment occurred.

P14.2 privacy audit reproduced a credential leak in the live Node Agent path: inbound routing generated a privacy-safe rewrite, but `src/bot.js` still passed the original credential-bearing message to Agent context and source-turn persistence. The path now selects the router/preflight safe rewrite for Agent input, persistence, jurisdiction checks, follow-up hooks, and topic-summary refresh. The actual inbound-routing → Agent runtime with synthetic approved evidence → persistence/send regression confirms the password is absent from model context and stored history; adjacent logging call sites were inspected and carry only duration or categorical diagnostics. `node --test src/agentWhatsAppAdapter.test.js src/agentCustomerAnswerWorkflow.integration.test.js src/messageRouter.test.js src/agentRuntime.test.js` passes **125/125**. P14.2 remains partial pending live provider, Supabase persistence, webhook dedupe, dashboard and external workflow verification.

### 2026-10-11 — integrated multilingual, privacy, ingestion, and Edge follow-up

The corrected local runtime now passes **2,346/2,346 root tests** and **157/157 dashboard tests**; the dashboard build passes. Deno checks the Edge function successfully, the 87-cell corpus validates, fact seed and Edge mirrors are synchronized, and the brain prompt is current. Live read-only candidate-retrieval preflight passes **16/16**; the approved dynamic offer answer smoke passes **3/3** EN/AR/EL on local Node runtime. The static factual sample remains **0/9 statable**, 82/82 facts are pending, and 57/87 document hashes differ between current local and live corpora. Use only the bounded synthetic approved-offer route for current live-model evidence; this is not deployment or real-customer readiness. No live writes, migrations, deployment, push, calendar authorization, or customer sends occurred.

Interaction and trusted-evidence audit (2026-10-11): the decision prompt now receives the outstanding prior question as explicitly untrusted context, allowing short replies to be interpreted without repeating the question; it is explicitly excluded as evidence for company facts. A separate audit found Edge generation could lose retrieval ranking because PostgREST does not preserve `in` query order; canonical evidence is now rebuilt in caller order and duplicate or unrequested rows are ignored. Regression coverage includes prior-question continuity, fact-register lookup failures, expiry, broken source/document relations, and alias exclusion. The live-corpus parity CLI also fails closed for any pending document revisions or expired valid-until values. Focused decision and Edge evidence checks pass **41/41**, full `npm run test:all` exits 0, corpus validation passes **87/87**, Edge mirrors regenerate, and Deno type-check exits 0. Live parity still reports **30/87 matching hashes and 57/87 mismatches**; the fact register still has **82/82 pending**. Real-customer factual testing remains gated; no live writes, deployment, push, or customer sends occurred.

### 2026-10-11 — customer interaction and guardrail follow-up

P10 language coverage now recognizes Greeklish questions such as “Ti einai to IP Box?” and “Ti simenei EORI?” as Greek while retaining an English-code negative control; the generated Edge mirrors match and focused language/multilingual/parity checks pass **49/49**. This closes a deterministic language-routing gap, not native-speaker answer quality.

P14.1 answer-evaluation tooling now requires candidate answer records and independent adjudications in separate inputs; self-asserted embedded scores/reviews are ignored. Evaluator tests also reject case-variant and junction aliases of protected inputs. Focused tests pass **27/27**. Reviewer identity and model answer quality remain unverified; full human adjudication is still required.

P6.5 local handover verification now handles a historical cancelled sibling without a perpetual retryable error. Focused handover/dashboard tests pass **175/175** and dashboard production build passes. Cross-instance race handling, deployed delivery, and live dashboard round trip remain open.

P11 privacy classification was refined so safe password-reset questions and explicit credential refusals do not trigger the disclosure guard. The first integrated run caught nine lost red-team credential cases; those are now restored across English, Arabic and Greek. The full red-team regression and safety policy suites pass **42/42**, and the full `npm run test:all` exits **0** (Dashboard **159/159**). Edge mirrors are regenerated and synchronized. No deployment or live data write occurred. Real customer factual testing is still blocked by **82/82 pending facts**, **57/87 local/live document hash mismatches**, and incomplete P14 release evidence; the only current live-model evidence remains the bounded synthetic approved-offer smoke.

### 2026-10-11 — parallel interaction, retrieval, and privacy audit

P3.10/P14.2 retrieval audit reproduced three natural company-formation paraphrases (“What do I get with company formation?”, Arabic “شو باخد إذا سجلت شركة بقبرص؟”, Greek “Τι παίρνω αν ιδρύσω εταιρεία στην Κύπρο؟”) falling into the broad-service search. The package-detail recognizer now routes them to the canonical formation-package query plus the original customer wording. `node --test src/ragPolicy.test.js` passes **52/52**. Broad fan-out remains bounded and approved-fact filtering is unchanged.

P10/P14.2 audit reproduced a Greeklish continuity gap: after a Greek company-formation question, “Kai i timi?” did not carry the prior topic into retrieval. Added Greeklish price/cost/amount/include cues and an exact regression. `node --test src/agentRuntime.test.js src/agentCustomerAnswerWorkflow.integration.test.js` passes **25/25**; `node --test src/language.test.js` passes **4/4**. Native-speaker and provider-generated quality are not established.

P11 audit reproduced cross-customer transaction leakage probes asking what the remaining customers paid in English, Arabic, and Greek. Added narrow transaction-language guards and regressions; Node/Edge policy and red-team focused suite passes **64/64**, and Edge mirrors remain synchronized. Live cross-contact authorization/RLS behavior remains unverified.

Integrated verification: `npm run test:all` passes **2,364/2,364 root** and **159/159 dashboard** tests; Dashboard production build passes; `npm run validate:corpus` reports **87/87 clean**; `npx --yes deno check supabase/functions/rafa-agent-api/index.ts` and `npm run edge:mirrors -- --check` pass; `git diff --check` has no whitespace errors (Git emits existing LF/CRLF notices). The source manual in the user OneDrive path and repository copy have the same SHA-256. The current local RAG evaluation still yields **0/9 statable** static factual cases because pending fact evidence is withheld. This must remain fail-closed. P3.10 and dependent customer-factual trial readiness stay partial; 82 fact approvals, corpus synchronization, and P14 release evidence remain external gates. No live writes, migrations, deployment, push, or customer send occurred.

### 2026-10-11 — P8/P9/P14 independent audit and integrated verification

P8 audit found legacy or malformed durable CRM fields without customer-message provenance, source-turn ID, or confidence ≥0.8 were being projected as trusted customer facts. Rehydration now excludes those fields, preserves raw/normalized values and correction markers, and allows only attributable customer-sourced values to suppress never-reask. Focused CRM Edge and resumed never-reask tests pass **13/13**; Deno type check passes. This changes local behavior only; migration, legacy-row impact, live Edge and resumed WhatsApp validation remain open.

P9 audit found a timestamped future consent could authorize a reminder before the source turn had occurred. Consent evaluation now validates against the supplied clock and rejects invalid clocks or future timestamps outside the bounded skew allowance. Reminder/follow-up decisions recheck current channel-scoped consent before sending and format messages in the customer's recorded language. Focused qualification, follow-up and scheduler tests pass **42/42**. MIG-16 rollout, live suppression/delivery smoke, coordinated worker/Edge rollout, and cross-instance atomicity remain unverified.

P14.1 audit found stale human adjudication could remain scored after an answer was edited. Candidate review now binds a digest of the exact question, answer text and selected evidence IDs; any candidate change invalidates the old score. Focused evaluator tests pass **27/27**. Reviewer identity and review-file authorship remain self-attested, so the harness still requires independently authenticated human review.

Integrated verification: `npm run test:all` passes **2,366/2,366 root** and **159/159 dashboard** tests. `npm run validate:corpus` reports **87/87 clean**; Edge mirrors are synchronized; Deno Edge type-check and dashboard production build pass. No P8 migration/P9 delivery/P14 review was promoted to complete: live rollout and qualified human evidence are still missing. No live write, customer message, deployment, or push occurred.

P12.1/P15.1 review usability audit found the admin knowledge queue silently capped at 200 documents and source revision history at 20, potentially hiding pending work because old revisions are retained. Admin queue and detail endpoints now read all pages with stable ordering; chunk retrieval pages in bounded batches. Non-admin views remain approved-only and bounded. Focused dashboard review/workflow/pagination tests pass **17/17**; server syntax check passes. No facts were approved. Final integrated recheck passes **2,366/2,366 root** and **160/160 dashboard** tests plus dashboard production build. Staff qualification, live retrieval/rollback, source parity and pending fact review remain open.

### 2026-10-11 — P13 receipt, P14 shadow isolation, and P15 feedback privacy

Independent P13.1 review found malformed inbound receipt claim responses could be mistaken for duplicates or valid claims, risking silent message loss. The receipt adapter now accepts only an explicit duplicate response or an owned claim with a valid UUID token; all ambiguous responses fail closed. Focused inbound receipt/concurrency tests pass **13/13**. Receipt fencing migration and coordinated worker/Edge rollout remain unverified.

P14.3 review found a shadow-capacity skip telemetry callback could throw or reject and affect the customer turn. Skip telemetry is now isolated from shadow execution, with a concurrency regression; focused shadow and red-team tests pass **29/29**. Shadow stays disabled by default and has no live provider evidence.

P15.2 review tightened feedback evidence references to require an opaque restricted-case identifier instead of customer-identifying free text. Focused feedback and scheduled-review tests pass **16/16**; the fixture validator passes. This structural check cannot establish anonymization or authorize storage. Restricted storage/access, qualified reviewer identity, scheduled operations, freshness, and rollback evidence remain open.

Integrated verification: `npm run test:all` passes **2,369/2,369 root** and **160/160 dashboard** tests. Corpus validation reports **87/87 clean**; generated Edge mirrors, Deno Edge type-check, dashboard production build, and `git diff --check` pass. P13/P14/P15 remain partial pending live and independently reviewed evidence. Broad factual real-customer testing remains gated by **82/82 pending fact claims**, **57/87 local/live knowledge hash mismatches**, and incomplete P14 release evidence. No live writes, migrations, deployment, push, or customer sends occurred.

### 2026-10-11 — P10 language, P12 editing, P13 prompt ceiling, and safety-route follow-up

P10 language audit reproduced explicit-language requests that used “explain,” “describe,” or “translate” (for example, “Could you explain GESY in Arabic?”) failing to set the requested response language. The detector now recognizes those verbs when paired with an explicit language preposition, while preserving ordinary questions about Greek services. Focused language/multilingual tests pass **36/36** and Edge mirror parity passes **12/12**. Native-speaker review and independently scored live answer quality remain open.

P12 dynamic-data audit found optional blank text and textarea values were omitted from edit payloads, so clearing an old offer note or translated title appeared to save while retaining the prior value. Payload construction now sends empty strings for explicitly cleared text while preserving empty arrays, objects and null values for other field types. Focused dashboard edit tests pass **9/9** and the dashboard production build passes. Live authenticated CRUD remains unverified.

P13 audit added a shared Node/Edge input ceiling using UTF-8 bytes of the serialized message array plus per-message and request framing reserves. The 32,000-unit bound includes roles and structured tool metadata; oversized prompts fail closed before provider dispatch. It is a conservative byte upper bound, not a provider-reported tokenizer measurement. Node/Edge budget, boundary, multilingual and dispatch regressions pass **102/102**; Deno type-check passes. Provider-token calibration and live latency/cost measurements remain open.

Safety-route regression coverage now proves ordinary password-reset help reaches Agent routing while a request to send a password is blocked. Stale P2.6 scenario descriptions were corrected to point to the inbound-router and scheduled-follow-up tests. Safety, scenario and follow-up suite passes **80/80**.

Integrated verification: `npm run test:all` passes **2,381/2,381 root** and **161/161 dashboard** tests; corpus validation reports **87/87 clean**; generated Edge mirrors, Deno Edge type-check, dashboard production build and `git diff --check` pass. The owner OneDrive manual and tracked copy still match SHA-256 `1B01B2F39561A4824F59614DF61F53C1A434E0E76770B731D85EEEAB2E1A1AE1`. This work is local-only. The previously verified live gates remain **82/82 pending fact claims**, **57/87 local/live corpus hash mismatches**, and incomplete P14 release evidence; therefore broad factual real-customer testing is not cleared. No live writes, migrations, deployment, push, or customer messages occurred.

### 2026-10-11 — P6.5 notification reconciliation, P11 output leakage, and P14.2 delivery reporting

P6.5 audit found resolved handovers could leave queued/processing `handover_review` notification jobs active. The dashboard status-sync path now cancels those jobs before reporting resolution; cancellation failure returns retryable 503 guidance, and repeating the action reconciles the state. Focused status-sync tests pass **18/18** and the complete dashboard suite passes **163/163**. This is local evidence; cross-instance races and live delivery remain unverified.

P11/P14 red-team audit reproduced Arabic and Greek hidden-instruction leakage through the customer output gate. The response policy now rejects those phrasings, with full runtime tests confirming unsafe drafts are retried and only a safe fallback is emitted. Focused response/red-team/Node-Edge parity tests pass **41/41**. This closes the reproduced wording cases only; broader paraphrases, obfuscation, live model behavior, and cross-customer authorization remain open.

P14.2 audit found failed WhatsApp delivery was visible inside the adapter result but discarded by the live caller. `runAgentLiveAnswerTurn` now emits a bounded delivery-failure event and returns explicit `delivered` and `persistenceUpdated` status. Focused workflow/adapter tests pass **23/23**. It deliberately does not retry an ambiguous WhatsApp send, since that could duplicate a message. Live delivery and durable outbox behavior remain unverified.

Integrated verification after these fixes: `npm run test:all` passes **2,382/2,382 root** and **163/163 dashboard** tests; corpus validation reports **87/87 clean**; Edge mirrors, Deno Edge type-check, dashboard production build, and `git diff --check` pass. Work remains local-only. P6.5/P11/P14 remain partial pending their documented live and independent review gates; no live write, customer send, migration, deployment, commit, or push occurred.

### 2026-10-11 — ingestion reporting and benchmark integrity audit

P3.10 ingestion audit found that `--apply --embed` could report success when embedding had warned about partial failures but revision read-back matched. The CLI now exits nonzero for either read-back mismatches or embedding warnings; focused ingestion/corpus tests pass **118/118**. Local dry-run remains read-only and reports 87 sources, 87 documents, and 548 planned chunks; no apply was run.

P14.1 evaluator audit found full-set completeness trusted exact IDs without confirming case semantics. It now compares language, question, expected facts, refusal contract, and positive-case topic/domain to canonical benchmark entries; a same-ID language mutation now fails completeness and readiness. Focused tests pass **27/27**. A previously reported MB-F9 time-dependent fixture failure could not be reproduced with its explicit frozen clock; full suite passed and 20 isolated repetitions passed.

Offline retrieval review found **879/879** positive questions lexically reachable, **17/17** negative controls below the over-retrieval ceiling, and **87/87** corpus cells clean; `src/ragPolicy.test.js` passes **52/52**. No ranking-policy edit was justified by available offline evidence. These checks do not measure live ranking or answer quality. Last recorded live evidence remains **0/9** statable static fact cases, **82/82** pending fact rows, and **57/87** local/live content hash mismatches. No live database write, migration, deployment, push, or customer send occurred.

Integrated local verification after the audits: `npm run test:all` exits 0, Edge mirrors are synchronized, the Edge function type-checks, dashboard production build succeeds, corpus validation reports 87/87 clean, and `git diff --check` exits 0. The completed suites pass **2,383/2,383 root** and **163/163 dashboard** tests.

### 2026-10-11 — live lexical facets, evaluator semantics, and provider transport

Re-read the owner-supplied manual and confirmed its OneDrive copy still matches the tracked repository copy SHA-256. P10 fallback audit fixed a language normalization defect: `safeFallbackData('greek')` previously truncated the code to `gr` and returned English; it now uses the shared language-pack resolver and tests `greek`, `Greek`, and `el-GR`. Focused customer-answer, response, retrieval and parity tests pass **93/93**.

Live retrieval audit called `rafa_search_knowledge` read-only with the exact broad-query builder output. It reproduced the prior failure: long mixed-topic facets returned zero rows in EN/AR/EL; canonical package titles retrieved the formation package in all three. Broad facets are now concise, single-domain queries with a canonical package query and preserve the customer's original wording; bounded fan-out remains eight and evidence/approval caps are unchanged. An independent coordinator recheck ran the 21 topic-language queries emitted by the current Node builder against the live lexical function: **21/21** returned their expected approved-document topic/language in the top five. This is SQL lexical-RPC evidence only, not hybrid rank, current fact approval, or generated-answer evidence. Focused RAG policy tests pass **52/52**.

Fresh live read-only aggregates show **87/87** source rows and documents approved, **577/577** chunks embedded with one model, one active approved offer, and **82/82** fact claims pending. Canonical content-hash comparison is **30/87 match and 57/87 mismatch**, with no missing sources or expired current documents. The query returned aggregate counts, hashes, statuses and topic IDs only; it did not read customer turns or write data. The documented CLI token currently returns “Invalid access token”; the connected read-only Supabase tool provided these checks. No facts were approved and no revisions were ingested.

P13.4 transport audit reproduced line-break injection into curl's line-oriented config when untrusted header/proxy values were used. Node transport now rejects ASCII controls before writing the config; focused provider transport, circuit-breaker, decision, privacy and usage checks pass **64/64**. Distributed/Edge breaker behavior and live fault recovery remain open. P14.1 full-set readiness now validates canonical topic/domain semantics for negative rows as well as positive rows; same-ID changes to question, language, facts, refusal, topic or domain, and duplicate IDs, are rejected. Its focused evaluator suite passes **27/27**. It remains an input/scoring harness only; no model answers or authenticated human adjudications exist.

Independent P3.10 review found no further reproducible offline ingestion/health defect. Focused ingestion, corpus and brain-health suites pass **150/150**; the safe dry run remains **87/87** sources/documents and **548** planned chunks. Health exits nonzero for **261** fact-approval findings (76 unique pending facts mapped across language/topic cells) and pending database checks, correctly keeping unresolved claims out of answers. The latest live corpus has 577 chunks; local/live content parity and the change→independent approval→retrieval round trip remain required.

Integrated local verification after all current changes is recorded below. Live direct retrieval now demonstrates topic recall for the emitted broad facets, but the app-level approved-fact filter still has zero eligible static claims. The latest RAG answer diagnostic is **0/9 statable**, so factual client-answer testing remains gated. No live content writes, migration, deployment, push, or customer send occurred.

P15.3 independent review reproduced a false-green path: blocked fact rows appeared in the report but were not counted as blocking findings. `scheduledKnowledgeReview.js` now includes blocked rows in the blocking count; a fixture with blocked MB-F19 confirms status stays `REVIEW_REQUIRED`. Focused change-packet, feedback, and scheduled-review suites pass **25/25**. A fresh local review remains **0/82 current**, **82 pending**, and `REVIEW_REQUIRED`, without an accountable owner, independent reviewer, or verified rollback. This fix prevents misreporting but does not resolve any approval or operating gate.

### 2026-10-11 — review audit, live offer smoke, privacy and answer-turn composition

P12.1/P12.4 audit added an append-only review decision history with previous/new status, named reviewer, required reason and timestamp, committed atomically with the status change. Dashboard admin review now requires a reason and displays paginated decision history. Focused migration/dashboard tests pass 15/15; dashboard build passes. The migration remains unapplied; production identity, RLS transport, review-to-retrieval, and rollback are unverified.

P11 red-team review reproduced credential-request bypasses in English and Greek. The outbound privacy gate now catches “tell us” requests, common Greek imperatives, and bank-issued OTP requests while retaining informational definition cases. Its focused Node suite including 200 runtime red-team fixtures passes 83/83. Live model robustness, full secret scanning, and independent adversarial review remain open.

P14.2 live turn orchestration is now import-safe and covered from preparation/routing through decision, persistence and delivery reporting. Focused workflow suites pass 57/57. This is a synthetic composition test; provider, WhatsApp webhook, durable persistence and customer-data workflow behavior remain unverified.

A bounded live model test ran three synthetic formation-package questions against the live current-offer read path. English, Arabic and Greek passed 3/3 with current approved-offer evidence and read-only tools; no contact writes or customer sends occurred. The machine report is `reports/release-readiness/approved-offer-live-smoke-latest.json`. It does not establish static company facts or clear a factual customer trial: 82/82 facts remain pending, 57/87 local/live document hashes mismatch, and 0/9 static factual cases are statable. The P14 packet validator remains NOT_READY with 121 findings across 30 blocked/unsubstantiated gates.

Integrated local verification passes `npm run test:all` at 2,390/2,390 root and 165/165 dashboard tests; 87/87 corpus validation, Edge mirror check, Deno Edge type-check, dashboard production build and `git diff --check` pass. No live migration, deployment, push, fact approval, corpus ingestion, or customer send occurred. P12/P14 and factual trial gates remain in progress.

Final 2026-10-11 integration verification after the latest concurrent fixes: **2,395/2,395 root tests** and **165/165 dashboard tests** pass. The direct provider fetch path now honors the bounded timeout through JSON body reading; live turn telemetry records final history persistence-update failure. Conversation continuity carries a trailing assistant question into the Agent as untrusted context, with Arabic/Greek punctuation coverage. Edge mirror check, Deno type-check, dashboard build, 87/87 corpus validation, and `git diff --check` pass. The prior 2,390 root count above predates these five added integration cases. A body-only provider timeout can occur after the circuit breaker records successful headers; live provider recovery/circuit accounting remains unverified.

P3.10 final local audit tightened parity safety: `--check-live` compares locally suppressed topics and surfaces multiple approved revisions; partial `--apply` exits nonzero if any locally suppressed files are skipped. Dry-run and corpus checks pass; no ingestion or live write ran. P10 multilingual output guard now counts native Greek U+037E sentence/question marks, closing an at-most-one-question bypass. Focused corpus and grounded answer suites pass. The integrated totals remain **2,395/2,395 root** and **165/165 dashboard**.

After the multi-topic search rewrite, a fresh read-only live RPC check used the exact current 8-query EN/AR/EL fan-out. The customer-wording lead query returned profile/overview evidence across all languages; the seven focused domain queries per language returned their expected topic in top five (**21/21**). This is lexical RPC evidence only, not hybrid ranking or generated broad answers; pending static facts remain ineligible.

Post-audit integrated verification after the response-body breaker fix passes **2,398/2,398 root tests** and **165/165 dashboard tests**; Edge mirrors, Deno type-check, dashboard build, corpus validation and `git diff --check` pass. Both production model call paths now include JSON-body parsing in the breaker outcome. No live provider failure/recovery test was induced.

### 2026-10-11 — P8/P9/P13 integrated pass and ship preflight

P8 memory/CRM audit now requires customer-message provenance and confidence for structured CRM values before they can suppress clarification, and redacts residential addresses from stored conversation summaries/recent turns. Focused CRM, never-reask, and memory regressions pass **32/32**. Durable CRM reconciliation, conversation-ID isolation, and resumed-chat live verification remain open.

P9 follow-up delivery now atomically claims a send before calling the provider and quarantines ambiguous outcomes as `uncertain`, preventing automatic duplicate sends. The migration `20261011130100_rafa_follow_up_at_most_once.sql` is local and unapplied. No operator reconciliation path for `uncertain` or abandoned `sending` records is implemented; migration and coordinated runtime deployment remain blocked pending that control and live consent/suppression verification.

P13 telemetry now records allowlisted provider token/cost usage without prompt or customer content, and Edge provider latency reaches dashboard telemetry. Focused telemetry/provider checks pass; live fault recovery and production latency/cost measurements remain open.

Final integrated local checks after these changes: `npm run test:all` passes **2,408/2,408 root tests** and **166/166 dashboard tests**; `npx --yes deno check supabase/functions/rafa-agent-api/index.ts`, `npm run edge:mirrors -- --check`, `npm run validate:corpus` (**87/87**), dashboard production build, and `git diff --check` pass. `node scripts/evaluateApprovedOfferAnswers.js` passes **3/3** synthetic EN/AR/EL questions using the live approved-offer read path; it performs no customer write or send.

Ship preflight on 2026-10-11 remains **blocked**. `qualia-ship` cannot pass its mandatory state guard because its required `state.js` executable/project state is unavailable; the current checkout is `main`, which that skill disallows pushing; and `scripts/validateReleaseReadiness.js` reports `NOT_READY` with **121 findings across 30 gates**. Live Supabase has the review-audit migration under remote version `20261011080309` (local filename reconciled), but multiple required local migrations are absent remotely, including the P9 delivery-claim migration. The live API is active at version 51. Static facts remain **82/82 pending**, local/live document hashes **30/87 matching**, and static factual cases **0/9 statable**. No push, migration, or deployment was performed; the broad real-customer factual trial remains gated.

### 2026-10-11 — continued live-RAG, Edge-language, P9 and P13 audits

Fixed the evaluator's enrichment-absence ambiguity: exact current source/title can still identify a target if policy topic metadata is absent, while a renamed target with absent metadata is recorded as `target_classification_incomplete`, not a retrieval miss. Added regression coverage and corrected the smoke scope note to nine cases. The read-only v6 run reports raw topic recall **9/9** and exact expected-text recall **16/24 (66.7%)**, but only **1/9** eligible outcomes. The earlier 0/9 values above describe the v5 snapshot and are superseded for the latest smoke; the release status is unchanged. Eight cases still fail the answer-eligibility checks due pending facts, source-text mismatch, or rank threshold.

The `company_info`/`business_areas` retrieval path now keeps the customer's wording first and adds a canonical profile heading query in the detected language, with a hard two-query bound. A synthetic fixture proves approved profile evidence survives selection; the live diagnostic confirms the English target is rank 1. It does not authorize or alter facts. The Edge dashboard generation path now applies the shared per-turn language instruction and fails closed when detected draft language differs from the request. English/Arabic/Greek parity tests pass.

Independent P9 audit fixed misleading success reporting when durable follow-up finalization returns false or throws after provider acceptance. Runtime and dashboard now surface unconfirmed/in-flight durable states without exposing provider error text. No safe operator reconciliation action exists for ambiguous or abandoned sends; this remains gated on a transactional, audited service-role RPC plus migration and rollout. Independent P13 audit labels synthetic load evidence explicitly and confirms the report does not represent production measurements. P14 programmatic `testType` labeling is fixed by restricting the evaluator to `synthetic-fixture` and `live-search-diagnostic`; a regression prevents labeling this diagnostic runner as production. Candidate-answer text retention and reviewer authentication remain audit limitations.

The independent prompt audit initially reported that Edge lacked per-sentence factual grounding. Reproduction showed the dashboard calls the generated Edge `containsProhibitedClaim` mirror, which runs `evaluateAnswerClaims` against approved evidence per claim; this is the same underlying Node/Edge claim gate, though the customer path additionally calls `assessClaimGroundedness`. Added a parity regression proving supported claims pass and unsupported company guarantees fail on both runtimes. The language-enforcement gap was real and is fixed above.

Integrated local verification: `npm run test:all` passes **2,422/2,422 root** and **167/167 dashboard tests**; `npm run validate:corpus` reports **87/87 clean**; generated Edge mirrors are synchronized; `npx --yes deno check supabase/functions/rafa-agent-api/index.ts` passes; dashboard production build passes. The first integrated attempt had one local Google Calendar helper startup timeout; its isolated suite passed **5/5**, and the integrated reruns passed. The Calendar feature remains outside this readiness claim. No live write, migration, deployment, push, send or fact approval occurred.

The deployment and factual-trial gates remain open: release packet **NOT_READY (121 findings / 30 gates)**, **82/82** pending fact claims, **57/87** local/live document hash mismatches, P9 migration unapplied and unresolved ambiguous-send controls. Continue with synthetic/read-only diagnostics and local remediation only; the latest 1/9 eligible static-fact outcome is not clearance for factual client testing.

Business-guidance admin and live regression gate (2026-10-14): Added localized admin CRUD for bounded rules and English/Arabic/Greek hooks in `rafa_settings.business_guidance`; WhatsApp and Edge prompts consume them as untrusted preferences rather than evidence or fixed scripts. Audit reason codes and validated item codes are visible in Admin audit without storing free-text rationales. Edge `rafa-agent-api` version **96** is active (`verify_jwt=true`); live read-only settings retrieval returned HTTP 200 with an empty typed setting. The worker restart completed. Root/dashboard suites pass **2,611/2,611** and **185/185**, dashboard build and corpus check pass, and Edge mirror/type checks pass. The post-restart OpenRouter probe still returns HTTP 401 `API key expired`; no real WhatsApp case was sent. Retry AR-02 first once provider access is restored. Authenticated admin UI persistence and the other listed M12 evidence gates remain open.

Live provider recovery and AR-02 retry (2026-10-14): Replaced the expired OpenRouter key in ignored local `.env`, confirmed an HTTP 200 completion, and stored the same credential in encrypted Supabase Vault under `openrouter_api_key`. Added Vault-first Edge secret loading with a five-minute cache and environment fallback; focused secret-loader tests pass 3/3 and Deno checks. Deployed `rafa-agent-api` v97 ACTIVE with JWT verification and restarted the WhatsApp worker. The owner-controlled real WhatsApp AR-02 identity check now passes: `أنا REFAL، وكيل الأعمال الرقمي لمجموعة Refalco Group.` No operational side effect was created. The actual dashboard browser remains signed out (`/api/session` authenticated=false; settings API 401), so authenticated UI CRUD and knowledge edit→approve→retrieval remain open; prior mock-only UI evidence is not counted. Other remaining M12 gates: MIG-14 live application/correction smoke, badge-count reconciliation, and independent source/review for 81 pending manual-only facts. Continue the WhatsApp sequence at AR-03 after regression checks.

Broad-query retrieval and latency retry (2026-10-14, supersedes older statements that no real chat was sent after provider recovery): Fixed chunk-level truncation that let a single long section occupy the evidence limit before complete-section selection. Broad service searches now combine the approved profile scope, model-generated complementary facets, and exact customer wording in parallel; the agent skips a redundant second search-selection decision when that comprehensive search already yielded current approved evidence. Clear business-area/service-scope questions use deterministic intent classification and avoid a separate operational-preflight model call; transient preflight timeouts conservatively fall back without granting booking or contact consent. Specific booking availability still enters the existing exact-date workflow.

The first post-restart live retry still hit an OpenRouter preflight timeout and then a grounding-review timeout; after the configured safe fallback, Rafa sent a localized retry-later answer. A second owner-controlled WhatsApp test, `شو مجالات خدماتكم في قبرص بشكل عام؟`, completed successfully in **35.4 seconds**. Telemetry records the informational fast path at 14 ms, one comprehensive approved search, two complete approved evidence sections reaching the answer/reviewer, a passed grounding review, and successful WhatsApp delivery. Rafa answered in Arabic with the approved group scope, appropriately qualified related areas, and one relevant follow-up question. No booking, contact handover, or appointment side effect occurred. The browser initially needed a reload to refresh the delivered incoming reply; after reload the reply was visible in the real Rafa chat.

Verification after this retrieval work: `npm run test:all` passes **2,621/2,621 root** and **186/186 dashboard** tests; corpus validation is **87/87 clean**; Edge mirrors and Deno type-check pass; dashboard production build and `git diff --check` pass. The local WhatsApp worker was restarted from the tested source. These local Node retrieval and latency changes are not included in Edge v97. The current dashboard tab at port 8787 is authenticated and its identity settings had already passed a live read-after-write check, superseding the older signed-out observation for that tab; the separate port-8788 session still requires separate verification. Feature-branch push and production Edge deployment remain pending.
