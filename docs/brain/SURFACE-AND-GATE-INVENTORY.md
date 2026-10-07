# P0.1 — Surface, Gate and Reusable Asset Inventory

**Phase:** M0 / P0.1 (waves W0.1.1, W0.1.2)
**Date:** 2026-10-07
**Method:** direct read of the repository. Every line reference was verified in this session.

---

## 1. HEADLINE: much of the brain's skeleton already exists

The repo is in far better shape than a blank start. Three MB modules are **already partially implemented** with the exact values MB specifies. These phases shrink from "build" to "extend".

| MB requirement | Already in the repo | Evidence | Plan impact |
| --- | --- | --- | --- |
| **MB-D1..D6** the six qualification dimensions | `DIMENSIONS = ["need","value","timing","authority","readiness","fit"]` | `src/leadQualification.js:135` | **P6.1 becomes an extension, not a build.** The dimension set is already exactly MB 4.1. |
| **MB-T3,T4,T5** tier thresholds | `DEFAULT_THRESHOLDS = { warm: 14, hot: 20, strategic: 25 }` with the comment *"Owner rules: 14–19 warm, 20–24 hot, 25–30 strategic/priority"* | `src/leadQualification.js` | **P6.2 inherits the exact MB 4.2 boundaries.** Only Informational (0-7) and Cold (8-13) need adding, plus the action protocols. |
| **MB-HO1..HO3** executive handoff | A `REFAL LEAD SUMMARY` builder and formatter already exist | `src/handover.js:137,186,188` (`buildRefalLeadSummary`, `formatRefalLeadSummary`) | **P6.5 becomes a format upgrade** to the exact MB 5.2 block, not a new subsystem. |
| **MB-HO routing** departments | 10 departments + an intent→department route table | `src/handover.js` `DEPARTMENTS`, `INTENT_ROUTES` | Needs one addition: a **`tax`** department (MB 5.2 lists Corporate / **Tax** / Real Estate / Residency / Construction). |
| **MB-R1..R10** role coverage | 40+ intent taxonomy already covering formation, VAT, accounting, residency, real estate purchase/investment, land owner, property development, construction tender, investment partnership, strategic partnership | `src/intent.js` `INTENTS` | **P1.2 role selection can map straight onto the existing taxonomy.** No new classifier needed. |
| **MB-DYN** tool calling | A live tool registry with 6 tools already wired into the agent loop | `src/agentTools.js` `TOOL_REGISTRY`, `searchApprovedKnowledge`, `getCustomerContext`, `saveCustomerFact`, `proposeHandover`, `getBookingAvailability`, `requestBookingAction` | **P4.2 adds 6 more tools to an existing registry.** The hard part (registry, result contract, loop integration) is done. |
| **MB-CRM5** consent machinery | `CONSENT_STATES`, `OPT_IN_RE`, `OPT_OUT_RE`, `DENY_RE`, all trilingual | `src/leadQualification.js` | Reusable as is for the P5.4 suppression rules. |
| **AR-A3** RAG | Full hybrid lexical + vector retrieval with RRF fusion, multilingual local embeddings | `rafa_hybrid_search_knowledge`, `src/ai.js:30-90` | **Production grade. M3 is content work, not infrastructure work.** |
| **MB-A2** live calendar | `getBookingAvailability` / `suggestAvailableTimes` already exist | `src/agentTools.js`, `src/booking.js` | `LIVE_CALENDAR_SLOTS` (MB-DYN4) is wiring, not building. |

**Revised effort read.** The genuinely new work is: the knowledge corpus (M3), the dynamic commercial tables (M4), the humour engine (P1.3), the hooks and objection matrices (M5), and the guardrail rewrite (M2). Everything else is extension.

---

## 2. W0.1.1 — Customer facing surfaces

Every place a string can reach a customer. All must stay in sync (P1.6 adds a drift test).

| # | Surface | File | What it emits |
| --- | --- | --- | --- |
| S1 | **WhatsApp model prompt** | `src/ai.js:184-231` | The main system prompt, ~40 directives, assembled inline. **Target of P1.6 extraction.** |
| S2 | **Dashboard operator prompt** | `dashboard/server.js:1882-1912` | Operator facing assistant, overlapping rule set |
| S3 | **Edge function prompt** | `supabase/functions/rafa-agent-api/index.ts` + `responsePolicy.mjs` | Worker API path |
| S4 | **Canonical rules document** | `config/refal-agent-rules.md` (53 lines) | Human readable source of S1-S3 |
| S5 | **Deterministic evidence answer** | `src/refalcoAnswer.js:4-49` `answerFromEvidence` | Extracts a grounded excerpt when the model is unavailable |
| S6 | **No evidence replies** | `src/refalcoAnswer.js:143-150` `noApprovedEvidenceReply` | 6 hardcoded strings, AR/EN/EL × pricing/general |
| S7 | **Restricted topic replies** | `src/refalcoAnswer.js:181-196` `restrictedRefalcoReply` | **BLK-2/BLK-8.** Flat refusals for investment and legal status, AR/EN/EL |
| S8 | **Safety fallbacks** | `src/safetyPolicy.js` `safeLocalizedFallback`, `FALLBACKS` | Localized safe replies per risk category |
| S9 | **Language instruction** | `src/language.js:40-50` `languageInstruction` | Per language prompt directive |
| S10 | **Workflow replies** | `src/complaintWorkflow.js`, `objectionWorkflow.js`, `existingClientWorkflow.js`, `correctionWorkflow.js`, `opportunityIntake.js`, `followUp.js`, `reminderScheduler.js`, `notificationScheduler.js` | Deterministic workflow messages |
| S11 | **Booking messages** | `src/booking.js`, `src/appointmentDetails.js`, `src/calendarReadiness.js` | Slot offers, confirmations, readiness errors |
| S12 | **Handover summary** | `src/handover.js` `formatRefalLeadSummary` | Internal only, must never reach the customer |
| S13 | **Agent loop output** | `src/agentLoop.js`, `src/agentRuntime.js`, `src/agentDecision.js` | Agentic path final answer |
| S14 | **Router** | `src/messageRouter.js`, `src/turnRouting.js` | Decides which surface answers |

---

## 3. W0.1.2 — Policy gates between a draft and the customer

| # | Gate | File | What it blocks | MB verdict |
| --- | --- | --- | --- | --- |
| G1 | `containsProhibitedClaim` | `src/refalcoAnswer.js:152-157` | Investment returns, ROI, financial/legal/tax/immigration advice, legal registration & status, **visa, residency, bank approval, loan, mortgage, permit, licence, government approval**, AR + EL equivalents | **BLK-1. REPLACE.** Kills MB-F19..F55 |
| G2 | `restrictedRefalcoReply` | `src/refalcoAnswer.js:181-196` | Returns a flat refusal for any investment or legal status mention | **BLK-2 / BLK-8. REPLACE.** Kills MB-R5, MB-F40 |
| G3 | `removeSafeDisclaimerClauses` | `src/refalcoAnswer.js:162-179` | Whitelists ~13 exact disclaimer phrasings so they escape G1 | Keep as the exemption mechanism; the new claim policy supersedes the need for it |
| G4 | `containsPromptInjection` | via `safetyPolicy.classifySafety` | Injection in retrieved evidence | **KEEP.** Required |
| G5 | `containsPriceClaim` / `withoutPriceFacts` | `src/groundingPolicy.js` | Price in an answer without a price question or without price evidence | **KEEP but relax.** MB-G1's ✅ example volunteers the package benefit; MB-X1..X6 hooks need adjacency |
| G6 | `containsUnsupportedPackageInclusion` | `src/groundingPolicy.js` | Linking separately described services into a priced package | **KEEP.** Directly supports MB-F2..F8 accuracy |
| G7 | `containsLegacyBrandHistory` | `src/groundingPolicy.js` | Unrequested former brand history | **KEEP.** No MB conflict |
| G8 | `containsRawUrlClaim` | `src/groundingPolicy.js` | Unverified citations | **KEEP** |
| G9 | `validateResponse` | `src/responsePolicy.js` | Length, sentence count, question count, internal reasoning leakage | **MODIFY.** `MODEL_DRAFT_THRESHOLDS` caps at 3 sentences / 500 chars → BLK-4, raise to 5 / 700 |
| G10 | Language lock | `src/ai.js:258`, `src/refalcoAnswer.js:35` | Answer language ≠ customer language | **KEEP.** Critical for AR/EN/EL parity |
| G11 | `suppressRepeatedSpecialistOffer` | `src/ai.js:302-315` | Repeated specialist offers | **KEEP.** Becomes part of P5.4 suppression |
| G12 | `redactPersonalData` / `redactSensitiveData` | `src/ai.js:342-349`, `src/sensitiveData.js` | PII and credentials before the model sees them | **KEEP.** Required by MB-SEC4 |
| G13 | `assessRedFlags` | `src/redFlagRules.js` | Red flag routing | **EXTEND** for MB-SEC2 sanctions |
| G14 | `evaluatePriority` | `src/priorityRules.js` | Priority classification (internal) | **EXTEND** for MB-T5 Strategic |
| G15 | Terminal punctuation check | `src/ai.js:281` | Unfinished sentences | **KEEP** |
| G16 | Evidence provenance strip | `src/ai.js:148-151` | Owner confirmations, internal review language, raw URLs removed before the model sees evidence | **KEEP.** Supports MB's "keep internal verification private" |

---

## 4. The `"the business"` placeholder (BLK-3) — full sweep target

Literal occurrences that P1.1 must replace with the Refalco profile:

| File | Lines |
| --- | --- |
| `src/ai.js` | 153, 188, 190, 194, 198, 199, 217 |
| `src/refalcoAnswer.js` | 188, 189, 192, 193 |
| `config/refal-agent-rules.md` | 5, 35 |
| `AGENTS.md` | 3 |
| `README.md` | 3, 28, 84 and the architecture table |
| `dashboard/server.js` | 1882, 1906 |
| `supabase/functions/rafa-agent-api/index.ts` | to confirm during P1.1 |

---

## 5. Open items carried into P0.2

1. Run the candidate sentence audit (`scripts/auditClaimGates.js`) to produce the exact BLOCK list for every MB-F fact in three languages.
2. Confirm the edge function's prompt text, which was not read line by line in this phase.
3. Record the live database baseline (W0.1.3) once Supabase connectivity is confirmed. Note from memory: the McAfee proxy 407s Supabase, so `HTTP_PROXY` must be unset for that check.
4. Capture the test baseline exit code (W0.1.4) — run in progress at the time of writing.

---

## 6. Status

| Wave | Status |
| --- | --- |
| W0.1.1 surface inventory | **COMPLETE** (14 surfaces) |
| W0.1.2 gate inventory | **COMPLETE** (16 gates) |
| W0.1.3 database baseline | **PENDING** (needs proxy-free Supabase access) |
| W0.1.4 test baseline | **COMPLETE** |

### W0.1.4 — Test baseline, captured 2026-10-07

```
npm test > /tmp/baseline-test.log 2>&1
exit=0
# tests 670
# pass  670
# fail  0
# cancelled 0 | skipped 0 | todo 0
# duration_ms 483524.9  (8 min 3 s)
```

**Interpretation.** The suite is fully green on `main` before any brain work starts. Therefore **any red test appearing during M1 to M10 is caused by this project**, never pre existing. There is no inherited failure to argue about.

**Cost note.** 8 minutes per full run. Phases should run targeted subsets during development (`node --test src/<module>.test.js`) and reserve the full suite for the G2 gate.

**Not yet run** (deferred to the next G2, stated as unrun rather than assumed green):
- `npm --prefix dashboard test`
- `npm --prefix dashboard run build`
