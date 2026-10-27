# REFAL real-data trial evidence packet

Use `scripts/validateReleaseReadiness.js` before any staged activation. It validates that every P14.5/P14.6 gate has a passing status, a concrete evidence reference, an independent verifier, and a parseable verification timestamp. It does not query production, verify the evidence, authorize a release, or change any feature flag. A `READY` result is paperwork completeness only; the release owner must review the linked evidence and approve activation separately.

## Trial scope available now

The currently verified live path is a bounded, read-only approved formation-offer answer smoke. Its three EN/AR/EL queries are synthetic, and it makes no customer write or send. It is suitable for operator review of read behavior, not for concluding that the general service corpus or customer workflows are release-ready. Static service facts remain gated until approved. Do not include real customer identifiers in the test packet.

### Live state snapshot (2026-10-11)

- Live metadata contains 87 approved knowledge documents. A read-only canonical-content hash comparison found 57/87 differ from the current local corpus (19 topics across EN/AR/EL); local revisions have not been ingested.
- The fact register has 82/82 claims pending. Document review status does not make those claims statable.
- The generated owner-review packet now accounts for all 82 pending rows: 76 static corpus claims and 6 dynamic-source contracts. The latter require runtime source/fail-closed review; they do not approve values.
- The static-fact RAG sample returned 0/9 statable cases across the three languages, with no retrieval transport errors. Do not use those cases as factual customer tests until the claim evidence and corpus revisions have been reviewed and synchronized.
- The approved formation offer smoke passed 3/3 synthetic EN/AR/EL questions using live read-only offer lookup on the local Node runtime. It did not test deployed Edge, real customer data, persistence, or sends.
- Six knowledge documents have expiry timestamps and need their normal expiry review before relying on them.

### Latest read-only static-fact diagnostic (2026-10-11)

`reports/rag-evaluation/2026-10-11-goal-continuation-v6.json` supersedes the earlier 0/9 smoke snapshots above: **1/9** cases pass the current customer-eligibility, expected-fact, metadata and rank checks. Raw target-topic retrieval is **9/9**, while exact expected-text recall is **16/24 (66.7%)**. Raw candidate presence is only a retrieval proxy; it does not mean the facts are approved or that generated answers are correct. Formation and bank claims remain withheld by the fact register; Arabic profile wording does not match the expected approved text, and Greek profile evidence is below the current top-1 threshold. Keep factual customer testing gated.

This is a dated snapshot, not a release approval. Re-run the read-only checks immediately before any trial and record the resulting artifacts.

### Local remediation status (2026-10-11)

- A trust-boundary defect was fixed locally in the Edge dashboard generation route: it now treats request evidence as chunk-ID hints, reloads canonical content plus document/source and fact-register state, and excludes alias finding-aid chunks. Caller-supplied approval metadata cannot authorize a claim. The dashboard local-model fallback was removed so an Edge verification failure cannot reuse unchecked search evidence.
- These changes are **not deployed**. The deployed Edge runtime and dashboard host have not been verified against them; do not use this code change as evidence that live dashboard answers are protected by the new gate.
- Local output-gate regressions now reject unsupported Arabic and Greek service lists. Full local verification passes **2,353 root / 158 dashboard tests**, Edge type-check, mirror parity, dashboard build, and 87/87 corpus validation.
- A fresh `npm run health:brain -- --db` still exits 1 with 340 gaps and cannot read the live fact register from the dashboard role. Its document chunk-count comparisons differ from the current local plan. This is separate from the read-only corpus hash check and the independent live fact status: **82/82 facts pending**.
- Re-ran `npm run eval:approved-offer` after the local changes: **3/3** synthetic EN/AR/EL answers passed with the live approved offer observed, only read-only knowledge/offer tools, and response-policy checks passing. The sanitized report is `reports/release-readiness/approved-offer-live-smoke-latest.json`. It exercises the local Node runtime, not the changed deployed Edge route or a customer workflow.

The full change set still requires the project release gates, Edge deployment and live verification before any real-customer factual trial. The currently demonstrated live-model path remains the bounded synthetic read-only offer smoke.

### Latest local integration and behavior fixes (2026-10-11)

The company-profile RAG path now preserves the customer's query and adds one canonical EN/AR/EL profile-heading query, limited to two targeted searches. Only evidence that passes the existing approval and language filters reaches the answer context. The live read-only v6 smoke improved English profile retrieval; it did not clear the Arabic phrasing mismatch, Greek rank threshold, or any pending fact approvals. Edge dashboard generation now detects the request language, passes the shared language instruction and rejects a draft detected in another language; Node/Edge parity tests cover English, Arabic and Greek.

The P9 send finalizer now reports an unconfirmed durable state if provider acceptance is followed by a false or throwing finalization, and the dashboard derives operator status from the durable state. `sending`/`uncertain` records still have no safe reconciliation action; that needs a transactional, audited service-role RPC and rollout. P13 synthetic load reports now declare `evidenceClass: synthetic` and `productionMeasurements: false`.

The P14.1 retrieval evaluator now rejects unsupported `testType` labels such as `production`; this diagnostic runner cannot claim to measure production answers. Its focused regression passes. Integrated local verification passes **2,422/2,422 root tests** and **167/167 dashboard tests**, Edge mirror check, Deno Edge type-check via `npx --yes deno check`, dashboard production build, and **87/87** corpus validation. One first full-suite attempt had a local OAuth-helper startup timeout; the isolated test passed 5/5 and the integrated reruns passed. These results are local evidence only. No migration, deployment, push, customer send, or fact approval occurred.

### Latest local answer and ingestion safeguards (2026-10-11)

The corpus ingestion CLI now exits nonzero if any embedding operation warns, even when document revision read-back matched; regression and ingestion tests pass **118/118**. The P14.1 evaluator now checks semantic fields against canonical benchmark cases, so caller-supplied rows cannot preserve IDs while changing language, question, expected facts, refusal contract, topic, or domain to qualify for full-set scoring. Its focused suite passes **27/27**. The previously reported MB-F9 clock mismatch did not reproduce with an explicit frozen clock (20/20 isolated repetitions).

Offline health reports **87/87** corpus cells clean, **879/879** positive questions lexically reachable, and **17/17** negative controls below the over-retrieval ceiling. Those are lexical proxies, not live ranking or answer-quality evidence. The live approved-fact gate still yields **0/9** statable static-fact cases; approved claims, local/live corpus parity, and independently reviewed P14 evidence remain unresolved. No live data, migration, deployment, push, or customer send occurred.

## Evidence rules

- Record one gate object for every ID exported by `REQUIRED_GATES` in `scripts/validateReleaseReadiness.js`.
- `status` must be `pass`; unmet gates stay `blocked` and the packet must remain `NOT_READY`.
- `evidence` should be a path or durable report identifier that names the exact command, environment, and exit/result. Do not paste secrets, tokens, customer messages, or raw customer data into the packet.
- `verifiedBy` must identify the person who independently inspected the evidence. `verifiedAt` must be an ISO timestamp.
- A test against mocks does not prove live provider behavior. Mark the corresponding live gate blocked unless it has a live, bounded, privacy-reviewed evidence record.
- Do not use this validator to bypass the migration, privacy, consent, security, or release approval gates in the master plan.

## Minimal review sequence

1. Produce and review the complete P14.5 evidence set, including the 195-requirement traceability audit and required FIX regression results.
2. Keep Calendar, customer persistence, handover, and follow-up stages disabled until their specific live prerequisites and rollback controls are verified. The project currently has incomplete external prerequisites; do not infer readiness from local test success.
3. For an authorized read-only trial, record a bounded cohort, exact test prompts in synthetic form, languages, response-policy results, latency, error counts, stop conditions, and the operator watching the trial.
4. Validate the evidence packet and manually inspect every referenced artifact before any separate activation decision.
5. Exercise each rollback in a disposable environment first. Record the resulting restored version/state and a post-rollback smoke; a documented command alone is not rehearsal evidence.

### Local interaction and safety update (2026-10-11)

Greeklish topic questions now route as Greek with English-code negative control; the focused language/parity suite passes **49/49**. The answer-quality evaluator now separates candidate outputs from independent adjudications and rejects path aliases; its focused suite passes **27/27**, but it has no human-scored answer set yet. P6.5 handover/dashboard regressions pass **175/175** and dashboard build succeeds, while deployment and live delivery remain unverified.

Privacy false-positive refinement preserves ordinary password-reset help and credential refusals while the full credential-phishing red-team plus safety suite passes **42/42**. `npm run test:all` exits **0** (Dashboard **159/159**) and generated Edge mirrors are synchronized. This is local evidence only. Do not start factual testing with real customer data: the live fact register remains **82/82 pending**, **57/87** corpus documents differ from local, and P14 release evidence is incomplete. The bounded synthetic approved-offer route remains the only current live-model path demonstrated.

### Parallel local readiness pass (2026-10-11)

Interaction and retrieval changes now cover natural formation-package paraphrases in EN/AR/EL (**52/52** RAG-policy tests) and Greeklish price follow-up after a Greek company question (**25/25** runtime/workflow tests). A privacy audit added EN/AR/EL guards for probes asking what remaining customers paid; focused guardrail/Edge parity suite passes **64/64**. The full suite passes **2,364 root / 159 dashboard tests**; dashboard build, Edge mirror check, Deno type check, and 87/87 corpus validation pass. The owner-provided manual and tracked copy have matching hashes.

The live/static answer evaluator remains **0/9 statable**. Pending fact rows are intentionally withheld, so do not use this as permission to expose those claims or to test factual customer answers. Corpus parity and release-evidence gates remain open; this pass changed no live data, migration, or deployment state.

### CRM, consent and answer-scoring audit (2026-10-11)

CRM rehydration now ignores durable values without customer-message provenance, source-turn attribution and confidence ≥0.8; focused CRM/Edge/never-reask tests pass **13/13**. Consent checks reject materially future-dated or invalid timestamps and recheck channel-scoped permission before follow-up/reminder sends; focused consent/follow-up/scheduler tests pass **42/42**. Reminder text follows the stored consent language. The answer evaluator binds adjudications to the exact question, answer and evidence IDs, preventing score reuse after candidate edits; evaluator suite passes **27/27**. These remain local changes: CRM migration and Edge rollout, live consent/delivery behavior, and authenticated human reviewers are unverified.

Integrated local verification passes **2,366 root / 159 dashboard tests**, dashboard build, Edge mirror check, Deno type-check and 87/87 corpus validation. The static company-fact answer path remains gated by pending approvals and corpus parity; these local fixes do not clear real-customer factual trial approval.

Knowledge-review usability follow-up: admin list and revision-detail reads now paginate through all rows instead of silently truncating at 200 documents/20 revisions; chunk rows are read in bounded batches. Focused review/workflow/pagination tests pass **17/17**. Final full local verification passes **2,366 root / 160 dashboard tests** and the dashboard production build. This makes review work visible but does not qualify reviewers, approve pending facts, synchronize the live corpus, or clear the real-data trial gate.

### Local interaction and request-bound follow-up (2026-10-11)

The explicit-language detector now handles “explain/describe/translate this in Arabic/Greek” without treating ordinary Greek-service questions as a language switch; focused language/multilingual checks pass **36/36**, Edge language parity **12/12**. Dynamic-data edits now transmit cleared optional text fields, preventing stale notes or translated titles from remaining after an apparent save; focused dashboard checks pass **9/9** and the dashboard build passes. Node customer answering, Node Agent decisions, and the Edge Agent now share a fail-closed 32,000-unit UTF-8 serialized-request ceiling that includes structured tool fields and framing; oversize prompts are rejected before provider dispatch, and the Node/Edge tests pass **102/102**. This is a conservative byte bound, not an observed model-token count. A direct inbound-route test also confirms safe password-reset questions reach the Agent while credential requests are refused.

Integrated verification passes **2,381 root / 161 dashboard tests**, 87/87 corpus validation, Edge mirror check, Deno type-check, dashboard build, and `git diff --check`. These checks are local. The last live snapshot still has 82/82 pending facts and 57/87 local/live corpus hash mismatches; independently reviewed P14 release evidence is incomplete. The bounded synthetic approved-offer smoke remains the only previously demonstrated live-model path. Broad factual customer testing is not cleared by these local fixes.

### Delivery and output-policy regression follow-up (2026-10-11)

Resolved handovers now cancel active review-notification jobs in the local dashboard status flow; focused reconciliation tests pass **18/18**. The customer response gate blocks reproduced hidden-instruction leakage in Arabic and Greek; runtime retry/fallback and Node/Edge parity tests pass **41/41**. WhatsApp Agent delivery failures are now returned to the caller and logged with bounded metadata instead of appearing as normal completion; focused workflow tests pass **23/23**, with no automatic retry on ambiguous send outcomes.

Integrated verification passes **2,382 root / 163 dashboard tests**, 87/87 corpus validation, Edge mirror check, Deno type-check, dashboard production build, and `git diff --check`. This remains local evidence. It does not verify live WhatsApp delivery, the dashboard host, live model robustness, or customer data access. The fact approvals, corpus synchronization, and P14 release gates recorded above remain outstanding; do not treat this update as clearance for a factual customer trial.

### Live retrieval and answer-path audit (2026-10-11)

The owner manual at the supplied OneDrive path and its tracked repository copy still match SHA-256 `1B01B2F39561A4824F59614DF61F53C1A434E0E76770B731D85EEEAB2E1A1AE1`.

A fresh read-only Supabase check confirmed **87 approved source rows, 87 approved documents, 577/577 embedded chunks using one model, one active approved offer, and 82 pending fact claims**. Comparing only canonical URLs and content hashes found **30/87 local/live matches and 57 mismatches**; no source was missing and none of the current approved documents was expired. The query read no customer messages or records and made no writes. The documented Windows CLI credential returned “Invalid access token”; the connected Supabase read-only tool was used for the aggregate and search checks instead.

The live lexical search RPC was exercised with all **21** short service-domain queries emitted by the current Node broad-query builder (seven topics across EN/AR/EL). Each returned its expected topic and language in the top five. Before the query rewrite, long mixed-domain facet queries returned zero live results in all languages; natural company-formation wording also missed the formation package in Arabic and Greek. The canonical package query now retrieves the expected package topic in all three languages. This tests lexical database retrieval only: it does not test hybrid ranking, the fact-register eligibility gate, or generated answers. Static factual responses remain unavailable while their facts are pending, and the prior live answer sample remains **0/9 statable**.

Local safeguards added in this pass: Greek fallback language aliases now resolve correctly; curl config values containing control characters are rejected before transport; and P14.1 full-set scoring rejects semantic mutations to positive and negative benchmark rows even when IDs remain unchanged. Focused suites passed **93/93** for answer/retrieval/parity, **64/64** for transport/breaker/privacy/decision/usage, **27/27** for answer evaluation, **52/52** for retrieval policy, and **150/150** for ingestion/corpus/brain health. The full integrated counts are recorded after the final run below.

No live content was ingested, no fact was approved, and no model answer was generated in these live SQL checks. This improves confidence in the retrieval wiring but does not clear factual real-customer testing.

P15 freshness audit follow-up: the scheduled review previously reported `REVIEW_REQUIRED` in current data but omitted blocked facts from its blocking-finding count, creating a possible false green for another complete packet. The report now counts blocked rows as blockers; a regression with blocked MB-F19 proves it remains `REVIEW_REQUIRED`. Focused P15 validators pass **25/25**. Current local review remains **0/82 current**, **82 pending**, no named owner or independent reviewer, and no verified rollback. No facts were approved.

### Bounded live answer test (2026-10-11)

Ran `node scripts/evaluateApprovedOfferAnswers.js` against the current live Supabase offer read and live model provider using three synthetic formation-package questions. English, Arabic, and Greek all passed (**3/3**): the Agent responded in the expected language, observed current approved offer metadata, used only the approved knowledge and offer read tools, and passed the customer response policy. The report is `reports/release-readiness/approved-offer-live-smoke-latest.json`. Scope is live runtime with synthetic questions and read-only tools; it made no contact writes and sent no customer messages. This qualifies only the active approved-offer path, not static company facts, deployed Edge behavior, WhatsApp delivery, or customer-data workflows.

The P14 packet validator still returns `NOT_READY` (121 findings across 30 blocked/unsubstantiated gates). Current factual trial blockers remain 82/82 pending claims, 57/87 local/live document hash mismatches, and 0/9 statable static factual cases. Independent release ownership, production workflow evidence, and rehearsed rollback/pause controls remain unsubstantiated. No factual real-customer testing is cleared.

### Integrated local verification (2026-10-11)

After the latest privacy, answer-turn, and review-audit changes, `npm run test:all` passes **2,390/2,390 root tests** and **165/165 dashboard tests**. `npm run validate:corpus` reports 87/87 clean; `npm run edge:mirrors -- --check`, `npx --yes deno check supabase/functions/rafa-agent-api/index.ts`, dashboard production build, and `git diff --check` pass. This verifies local behavior only. The review-audit migration is not applied, and no deployment, push, fact approval, corpus ingestion, or customer send occurred.

Final integration correction for the 2026-10-11 pass: after the latest interactivity and transport changes, `npm run test:all` passes **2,395/2,395 root tests** and **165/165 dashboard tests** (the earlier 2,390 count predates these five added cases). Provider fetch and body reads now have bounded abort timeouts, and the live turn logs final persistence-update failures. The live turn also passes the prior assistant's trailing question as untrusted context; synthetic Arabic/English/Greek punctuation regressions are included. Full local validation still passes; provider timeout recovery and circuit-breaker accounting after a body-only timeout need live/targeted follow-up.

Additional final audit fixes (2026-10-11): the live parity checker now includes locally suppressed corpus files and flags multiple approved revisions per source; partial apply exits nonzero if suppressed files were skipped. It was verified with local dry-run/87-cell corpus checks only; no ingestion or live query was run. The answer output guard now recognizes native Greek U+037E punctuation for sentence and question counts, so the one-question limit applies to both Greek punctuation forms. Focused corpus and response-quality regressions passed; integrated test totals remain 2,395/2,395 root and 165/165 dashboard.

Live recheck after the multi-topic query-builder change (2026-10-11): ran the exact current 8-query broad-service fan-out for synthetic “what services do you offer?” questions in EN/AR/EL against the read-only lexical RPC. Each of the seven focused language-specific topic queries per language returned its expected topic in the top five (**21/21**); the customer-wording lead query returned company-profile/service-overview evidence in all three languages. This validates lexical retrieval for the current query set only; hybrid ranking, approved static fact eligibility, and generated broad service answers remain unverified.

Final post-circuit-breaker verification (2026-10-11): `npm run test:all` passes **2,398/2,398 root tests** and **165/165 dashboard tests**. Edge mirror generation check, Deno type-check, dashboard build, 87/87 corpus validation, and `git diff --check` also pass. The direct model provider now accounts for body-read timeouts inside the circuit breaker in both production Agent call paths. No live provider timeout was induced; provider recovery remains unverified.

### Ship preflight and latest integrated state (2026-10-11)

Latest integrated local verification passes **2,408/2,408 root tests** and **166/166 dashboard tests**. Deno Edge type-check, Edge mirror parity, corpus validation (**87/87**), dashboard production build, and `git diff --check` pass. A bounded live-model smoke passes **3/3** synthetic EN/AR/EL approved-offer questions on the local Node runtime with read-only knowledge/offer tools; no contact writes or customer sends occur.

The production release packet remains `NOT_READY` with **121 findings across 30 gates**. Facts remain **82/82 pending**, current local/live document hashes **30/87 matching**, and static factual answer cases **0/9 statable**. Do not run a broad factual real-customer trial.

Push/deploy preflight also fails the mandatory `qualia-ship` state guard: the required `state.js` executable/project state is unavailable, and this checkout is on `main`, which the skill prohibits pushing. The live Edge API is active at version 51. The live migration history lacks multiple local migrations needed by the current runtime, including `20261011130100_rafa_follow_up_at_most_once.sql`; deploying the runtime without its schema would be unsafe. P9's at-most-once delivery claim quarantines ambiguous/abandoned sends, but there is no operator reconciliation path yet. No push, migration, or deploy was performed.

The review-audit migration is already present in the live schema under remote version `20261011080309`; the local migration filename was aligned to that version. This does not clear the unrelated missing migration set or release gates. The approved-offer smoke is limited synthetic evidence and does not establish deployed Edge, WhatsApp delivery, persistence, or customer workflow readiness.
