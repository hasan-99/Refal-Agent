# REFAL Agent Refactor

Branch: `feature/agentic-orchestration` (off `main`). This document is the running
record of the refactor from a mostly deterministic, single-shot generation
pipeline into a bounded, tool-using conversational agent, while keeping every
safety/privacy/consent/authorization/knowledge-approval/audit boundary
deterministic and outside model control.

Evidence basis: every claim below was produced by reading the current source
directly (not the project's `.planning/*.md` history, which documents prior
work but is not treated as proof of present behavior) and, where noted, by
running the actual functions. Four parallel read-only trace agents covering
the full message pipeline, plus a prior independent bug-hunt pass, fed this
document.

## Goal

Move from:

```
message -> deterministic classifiers -> one evidence bundle -> one model call -> one validator -> reply
```

to:

```
message -> trusted context -> Agent decides goal/tools needed -> bounded tool loop
  (deterministic tools: knowledge search, customer context, booking, handover)
  -> Agent composes concise answer -> deterministic output validation -> persist -> deliver
```

Core rule: **Agent decides. Code authorizes. Approved knowledge grounds facts.
Database stores state and audit.**

## Current architecture (as traced, 2026-10-05)

### Runtime flow today

```
socket.ev.on("messages.upsert")            [src/bot.js:952]
  -> handleMessage(socket, message)        [src/bot.js:656]
       -> dedup: in-memory Set + DB claim  [src/bot.js:672, 694; supabaseStore.js claimInboundMessage]
       -> rememberWhatsAppContact()        [src/bot.js:166] -> store.updateUser (1st contact load/write)
       -> blocklist check, rate limiter
       -> answerMessage()                  [src/bot.js:255]
            -> store.ensureUser()          [src/bot.js:272]  (2nd contact/history load)
            -> handleBookingMessage()      [src/bot.js:280 -> booking.js] -- own independent text parser;
               short-circuits everything below if it returns a result
            -> prepareInboundMessage()     [src/messageRouter.js:242]
                 -> classifySafety()                 [src/safetyPolicy.js]
                 -> extractSafeRequestFromPrivacyMessage() [src/privacyIntent.js] (privacy-risk only)
                 -> detectIntent(routingText)         [src/intent.js]
                 -> assessPriority(), redFlagRules
                 -> name extraction + up to 2 store.updateUser writes
                 -> qualifyLead()                     [src/leadQualification.js] + store.updateUser
                 -> updateIntake()                    [src/opportunityIntake.js] + store.updateUser
            -> routeMessageResult()        [src/messageRouter.js:499-873] -- ~25 sequential
               special-case branches (complaint, existing-client, booking-adjacent,
               correction, objection, consent/handover, specialist offer, etc.),
               each building its own 3-language reply and calling recordHistory()
            -> if no deterministic route matched and routed.shouldUseAi:
                 -> embedText() + store.searchKnowledge()     [RAG, src/ai.js + Edge Function]
                 -> askOpenRouter()                            [src/ai.js:80] single-shot,
                    one pre-assembled evidence bundle, one free-text answer,
                    output validated inline (language/claims/price/length/etc.)
                 -> on any failure: keep the already-computed deterministic
                    fallback (localRecap / answerFromEvidence / noApprovedEvidenceReply)
            -> recordHistory()             [src/messageRouter.js:39] -> validateResponse() again,
               writes rafa_conversation_turns + conditional workflow tables
       -> sendStoredTextReply()            [src/bot.js:518] -> socket.sendMessage (Baileys)
       -> mark DB receipt complete (finally block)
```

Benchmark (`scripts/runConversationBenchmark.js`) calls the **same** deterministic/model
functions (`prepareInboundMessage`, `routeMessageResult`, `recordHistory`, `handleBookingMessage`,
`askOpenRouter`) against a mocked `BenchmarkStore`, but owns its **own copy** of the top-level
sequencing (`processTurn`) separate from `bot.js`'s `answerMessage`. Business logic is shared;
turn orchestration is duplicated.

### Pipeline trace table

| # | Step | File : Function | Deterministic / Model | State read | State written |
|---|------|------------------|------------------------|-------------|----------------|
| 1 | WhatsApp reception | bot.js: `messages.upsert` handler -> `handleMessage` | Deterministic | module flags | - |
| 2 | Dedup | bot.js (in-memory Set) + supabaseStore.js `claimInboundMessage` | Deterministic | in-proc Set; `rafa_inbound_message_receipts` | claims receipt row before any side effect |
| 3 | Contact loading | bot.js `rememberWhatsAppContact` (1st) + `answerMessage`'s `store.ensureUser` (2nd, duplicate) | Deterministic | `rafa_contacts` row | blind whole-row PUT, twice |
| 4 | History loading | embedded in `ensureUser` response, no separate call | Deterministic | `user.history` | - |
| 5 | Language detection | src/language.js `detectMessageLanguage`, embedded in `detectIntent`, **also re-called independently 3 more times later in bot.js** | Deterministic | message text | `classification.language` |
| 6 | Intent detection | src/intent.js `detectIntent` | Deterministic | normalized text | `classification.intents/primary` |
| 7 | Qualification/intake | messageRouter.js `prepareInboundMessage` -> leadQualification.js `qualifyLead`, opportunityIntake.js `updateIntake` | Deterministic | history, profile | `profile.leadQualification`, `profile.opportunityIntake(s)` |
| 8 | Open-question state | messageRouter.js `pendingIntakeAnswer`, `wasNameRequested`, `isFreshSpecialistOffer` | Deterministic, regex-matched against the bot's **own last rendered reply text** | `lastTurn.response` text | none persisted — re-derived every turn |
| 9 | Privacy handling | safetyPolicy.js `classifySafety` + privacyIntent.js `extractSafeRequestFromPrivacyMessage` | Deterministic | incoming text | `metadata.safety`, redacted stored history |
| 10 | Consent handling | leadQualification.js `consentFromText`, `getConsentState` | Deterministic, fail-closed, 24h offer expiry | full history, `user.consent` | `user.consent` via `store.saveConsent` |
| 11 | Booking routing | bot.js -> booking.js `handleBookingMessage` | Deterministic | text, user | appointment state; **independent of `classification.intents`** |
| 12 | Handover routing | messageRouter.js consent-gated block -> handover.js `createHandover` (pure builder, no persistence) | Deterministic | `classification.intents`, consent state | `store.createHandover` only if consent confirmed at write time (double-gated) |
| 13 | Knowledge/RAG retrieval | ai.js `embedText` -> supabaseStore.js `searchKnowledge` -> Edge Function `/knowledge/search` (ranking/approval/freshness enforced server-side, out of `src/`) | Deterministic | redacted question | none (read-only) |
| 14 | Model invocation | ai.js `askOpenRouter` | Model-driven, wrapped in deterministic retry | evidence, recent turns, summary | transient answer string |
| 15 | Prompt construction | inline in `askOpenRouter` (one large system prompt encoding ~35 behavioral rules in prose) | Deterministic assembly | evidence, turns, summary | - |
| 16 | Model response parsing | inline in `askOpenRouter` | Deterministic | HTTP response | usage telemetry |
| 17 | Response validation | inline checks in `askOpenRouter` **and** responsePolicy.js `validateResponse` (called again, with different thresholds, from messageRouter.js) | Deterministic | answer text | throws on failure |
| 18 | Fallback handling | bot.js: deterministic candidate pre-computed before the model call; kept unchanged if the model call throws | Deterministic | precomputed candidate | `response` variable |
| 19 | DB persistence | messageRouter.js `recordHistory` -> supabaseStore.js `addHistory`/`persistWorkflow` | Deterministic | computed metadata | `rafa_conversation_turns` + conditional workflow tables |
| 20 | WhatsApp delivery | bot.js `sendStoredTextReply`/`sendTextReply` | Deterministic | `turn.id` | `socket.sendMessage`; best-effort delivery marker patch |
| 21 | Benchmark runtime | scripts/runConversationBenchmark.js `processTurn` | Hybrid (real model + real deterministic modules, mocked store) | `BenchmarkStore` | mocked, zero real writes |

### Supabase tables confirmed in code

`rafa_contacts`, `rafa_conversation_turns`, `rafa_inbound_message_receipts`,
`rafa_contact_intents`, `rafa_lead_qualifications`, `rafa_opportunity_intakes`,
`rafa_contact_consents`, `rafa_handovers`, `rafa_priority_alerts`, `rafa_events`,
`rafa_audit_events`, `rafa_appointments`, `rafa_complaints`,
`rafa_existing_client_verifications`, `rafa_follow_up_states`,
`rafa_contact_blocks`, `rafa_reminder_jobs`, `rafa_notification_jobs`.
`rafa_agent_sessions/messages/memories` exist but belong to the **dashboard
operator AI assistant**, a separate feature from the customer WhatsApp bot.
No literal `rafa_knowledge_sources/documents/chunks` tables were found by
that name in `src/`/Edge code — retrieval goes through RPC functions
(`rafa_hybrid_search_knowledge` / `rafa_search_knowledge`); underlying table
names may differ from the docs' aspirational names. Not yet confirmed against
the Supabase migrations directly — flagged as open verification, not fixed.

### Today's tool/capability model

**There is no tool-calling concept today.** The model receives one
pre-assembled evidence bundle (already retrieved, already price-filtered)
and produces exactly one free-text answer in a single request/response
round trip. It cannot request more evidence, trigger booking, or propose a
handover — all of that already happens in deterministic code in
`messageRouter.js`/`booking.js`, before or instead of the model being
invoked. OpenRouter is called with a vanilla chat-completions body (no
`tools`/`functions` field). This confirms the refactor's premise: a bounded
agent loop with explicit tool calls is a genuine addition, not a refinement
of an existing mechanism.

## Known problems (Phase 2 catalogue)

Carried in from the independent pre-refactor bug audit (`Downloads/refal-agent-findings.html`)
plus this session's trace agents. Grouped by theme; file:line evidence is in
the ticket that addresses each one.

**State & concurrency**
- No single `conversationState` object — scattered across at least 7
  independently-written profile fields (`leadQualification`, `opportunityIntake(s)`,
  `existingClientState`, `handover`, `specialistFollowUp`,
  `conversationPreferences.noProactiveBookingOrContact`, `consent`).
- `store.updateUser` is a blind whole-row read-modify-write with no
  version/merge guard (`src/supabaseStore.js:91-107`, Edge
  `index.ts:804-821`) — concurrent writes silently drop each other
  (lost-update race). Confirmed exact server-side line.
- Contact + history are loaded **twice** per inbound message
  (`rememberWhatsAppContact` then `answerMessage`'s own `ensureUser`),
  doubling the race window and the Edge Function round trips.
- Inbound dedup claim (`claimInboundMessage`) is itself solid (atomic
  insert + unique constraint + stale-reclaim window) — a model for how
  `updateUser` should work, not something to "fix."
- If the handler throws between the dedup claim and `receiptShouldComplete`,
  the DB receipt is left permanently claimed with no reply ever sent —
  a genuine retried customer message is silently dropped forever.
- A reply is written to `rafa_conversation_turns` **before** the WhatsApp
  send is attempted, with no `send_failed`/delivery-status marker if the
  send then throws — history can show an "undelivered" reply as if it were
  real.

**Routing & classification**
- `intent.js`'s `APPOINTMENT` pattern matches bare substrings "book"/"call"
  with no word boundary (`bookkeeping`, `recall`, `textbook` false-positive).
- `priorityRules.js` regex alternation is unscoped: bare "media", "press",
  "land", "my account" force false urgent/high escalations, confirmed live.
- Booking routing (`handleBookingMessage`, its own text parser) and the rest
  of the router (`classification.intents.includes(APPOINTMENT)`) are two
  independent, unsynchronized definitions of "is this a booking message."
- Over a dozen real taxonomy intents (career, media, real estate
  sub-types, investment, partnership, etc.) are missing from `intent.js`'s
  `PRIORITY` array, so `primary` silently becomes `"unknown"` even when a
  real intent was detected.
- Priority alerts fire independent of handover consent — an ordinary
  message with a false-positive priority trigger creates a visible internal
  alert even though the customer-facing handover correctly requires consent;
  the two systems disagree on what needs permission.

**Open-question / conversation-state fragility**
- Open-question tracking is re-derived every turn by regex-matching the
  bot's own last rendered reply text (`pendingIntakeAnswer`,
  `wasNameRequested`) rather than a structured flag set when the question
  was asked. Covers exactly two fields (company activity, specialist offer);
  any other question the model asks has no tracked state, so an indirect
  answer to it can't be captured.
- Once `handover.required` is true, there is no code path in the traced
  slice that ever clears it — a customer who asked for a specialist once,
  then changed topics weeks later, still has name-like messages routed
  through "I've added your name to the specialist request."
- `existingClientWorkflow.js` authentication state never expires (no
  timestamp/TTL), unlike specialist-offer consent which correctly expires
  after 24h.

**Generation / validation**
- Content-policy rejections (wrong language, unsupported claim, unfinished
  sentence, etc.) never retry on the configured fallback model — only
  network/5xx/429 errors are treated as retryable (`src/ai.js:238-240`,
  `isRetryableModelError`). This is a direct, confirmed contributor to the
  project's own measured ~15% draft-rejection rate becoming a generic
  fallback instead of a second attempt.
- Two independently-tuned calls to the same `validateResponse` function
  with different thresholds for the same job (model path vs. deterministic
  path).
- RAG fires unconditionally whenever `shouldUseAi` is true, with no check
  for whether the current message actually needs factual grounding (a
  plain "ok thanks" still triggers an embedding + knowledge search).
- A bare mention of "password" (no actual value) is misclassified as a
  privacy risk and blocks an ordinary support question
  (`src/safetyPolicy.js:17`); refusal phrases like "I won't share my
  access token" are misread as disclosure (`src/safetyPolicy.js:33`) — a
  more correct generic check already exists in `src/sensitiveData.js` and
  wasn't reused.
- Every complaint recap inserts the same hardcoded fake backstory
  regardless of the real complaint (`src/conversationRecap.js:115`).
- The automated re-engagement follow-up is hardcoded in Arabic for every
  customer regardless of their language (`src/followUp.js:5`).

**Orchestration shape**
- `messageRouter.js`'s `routeMessageResult` is one ~890-line function with
  ~25 sequential special-case branches, each duplicating its own
  3-language reply object and its own `recordHistory` call.
- `prepareInboundMessage` does 5 distinct concerns (safety, intent,
  priority, name capture, qualification/intake) with up to 4 separate
  database writes inside one function.
- Booking never actually got wired to a business-hours notice
  (`businessHours.js` is fully built, tested, and never called from the
  live path).

These are the concrete instances the refactor's later phases (tool
registry, single conversation-state object, bounded agent loop) are
designed to resolve — see ticket list below for what has actually been
changed so far (not all of the above are fixed yet; this is the catalogue,
not a changelog).

## Target architecture

```
onMessage(message)
  -> prepareInboundMessage()        [existing, kept]
  -> runAgentTurn(agentContext)     [NEW — src/agent/]
       loop (max 4 steps):
         decision = decideNextStep(context, observations)   [model proposes]
         if decision.tool: validate + execute via toolRegistry (deterministic) -> observe -> continue
         if decision.respond: validate via responsePolicy -> finish
         if decision.clarify: validate (max 1 question) -> finish
  -> recordHistory() / deliverAgentResult()   [existing persistence/delivery, kept]
```

Tools exposed to the Agent (deterministic, narrow, validated):
`searchApprovedKnowledge`, `getCustomerContext`, `saveCustomerFact`,
`proposeHandover`, (booking tools deferred — see Remaining work).

The Agent proposes; deterministic code in each tool enforces consent,
authorization, and data validity exactly as today. No non-negotiable
boundary (privacy detection, redaction, consent validity, handover/booking
authorization, knowledge approval, output policy, dedup, audit, secrets)
moves into the model/prompt.

## Implementation roadmap

Ticket numbers are permanent once assigned; the architecture trace itself is
not a numbered ticket (it is the Phase 1/2 research this roadmap is built
on). Full ticket bodies (problem / before-after / tests executed) are posted
in the working conversation when each ticket completes; this table is the
index of record — status here is the source of truth if the two ever drift.

### REFAL-AGENT-001 — Agent tool contracts
- Depends on: none
- Status: **DONE**
- Acceptance criteria: a small, explicit tool registry exists
  (`searchApprovedKnowledge`, `getCustomerContext`, `saveCustomerFact`,
  `proposeHandover`); no tool trusts a model-generated id, every tool
  distinguishes not-found/no-evidence from a system error, `saveCustomerFact`
  refuses any provenance other than `customer_message` and normalizes field
  names to a canonical case before use as a storage key, `proposeHandover`
  never persists (authorization check only — the existing consent-gated
  persistence path is untouched).
- Required tests: `src/agentTools.test.js`
- Files: `src/agentTools.js`, `src/agentTools.test.js`

### REFAL-AGENT-002 — Trusted agent context
- Depends on: none
- Status: **DONE**
- Acceptance criteria: `buildAgentContext` copies only an explicit allowlist
  of fields (never a raw pass-through of caller state), caps string/array
  sizes, returns a frozen object, and defaults safely on missing input.
- Required tests: `src/agentContext.test.js`
- Files: `src/agentContext.js`, `src/agentContext.test.js`

### REFAL-AGENT-003 — Bounded agent loop
- Depends on: 001, 002
- Status: **DONE**
- Acceptance criteria: `runAgentTurn` never calls an unregistered tool name,
  never loops past `MAX_AGENT_STEPS` (4), validates every `respond`/`clarify`
  draft through the existing deterministic `responsePolicy.validateResponse`
  before it can leave the function, a thrown tool error becomes a structured
  failed observation (never an uncaught exception), a thrown decision error
  ends the turn with a localized deterministic fallback, and the fallback
  text is localized to the conversation's locale.
- Required tests: `src/agentLoop.test.js`
- Files: `src/agentLoop.js`, `src/agentLoop.test.js`

### REFAL-AGENT-004 — Model decision schema
- Depends on: 001, 002, 003
- Status: **DONE**
- Acceptance criteria: a real `decideNextStep` implementation calls the model
  requesting a strict JSON decision (`tool` / `respond` / `clarify`); any
  unparseable or malformed response produces a deterministic invalid-decision
  outcome (handled by the existing Ticket 003 loop), never a crash and never
  raw text treated as an authorization; the model never sees a tool name
  that isn't in the real registry (tool list is generated from
  `TOOL_REGISTRY`, not hand-duplicated in the prompt).
- Required tests: unit tests mocking `global.fetch`, matching the existing
  `src/ragPolicy.test.js` convention for OpenRouter call mocking.
- Files (planned): `src/agentDecision.js`, `src/agentDecision.test.js`

### REFAL-AGENT-005 — Response/clarification handling
- Depends on: 003, 004
- Status: **DONE**
- Acceptance criteria: when a `respond`/`clarify` draft is rejected by policy,
  prefer a targeted deterministic correction or one bounded re-decision
  attempt over immediately returning the generic localized fallback (Phase 11:
  "do not replace every rejected response with the same generic fallback").
- Required tests: new cases in `src/agentLoop.test.js` or a dedicated file
  covering "rejected then corrected" vs. "rejected then safe fallback."

### REFAL-AGENT-006 — Conversation state normalization
- Depends on: none (can proceed in parallel with 004/005)
- Status: **DONE (scoped as a wrap, not a write-path migration — see decision log)**
- Acceptance criteria: a single `conversationState` shape wraps the ~7
  independently-written profile fields; existing consumers
  (`messageRouter.js`, `leadQualification.js`, `existingClientWorkflow.js`)
  keep passing their current tests after the change (they are untouched).
- Required tests: `src/conversationState.test.js`; full `npm test` re-run
  to confirm zero regression to any existing suite.
- Risk: touches live, well-tested orchestration code — **mitigated by not
  touching it**: this ticket is additive/read-only (see decision log).

### REFAL-AGENT-007 — RAG tool integration
- Depends on: 001, 003, 004
- Status: **DONE**
- Acceptance criteria: `searchApprovedKnowledge` is reachable from a real
  (flagged, non-live) `runAgentTurn` path using the actual `embedText` +
  `store.searchKnowledge`; RAG is only invoked when the Agent's decision
  calls it, not unconditionally (fixes the "RAG fires even on 'ok thanks'"
  gap from the trace).
- Required tests: integration test with a stubbed Supabase store.

### REFAL-AGENT-008 — Handover tool integration
- Depends on: 001, 003, 004
- Status: **DONE**
- Acceptance criteria: the Agent can call `proposeHandover`; a `not_authorized`
  result never becomes a customer-facing promise; an `authorized` result
  still flows through the existing `recordHistory` → `store.createHandover`
  persistence path unchanged (no second, less-audited write path).
- Required tests: covers consent-granted, consent-missing, and
  consent-revoked-after-offer cases.

### REFAL-AGENT-009 — Booking tool integration
- Depends on: 001, 003, 004, 006
- Status: **DONE**
- Acceptance criteria: `getBookingAvailability`/`requestBookingAction` wrap
  `booking.js` without duplicating its state machine; the Agent can never
  cause a confirmed-appointment claim without the booking tool reporting
  real success; the customer-self-confirmation race found in the earlier
  bug audit is fixed as part of wrapping this path, not deferred again.
- Required tests: concurrency test for two near-simultaneous confirmations.
- Files: `src/agentBookingTools.js`, `src/agentToolResult.js`,
  `src/agentBookingTools.test.js`, `src/agentBookingIntegration.test.js`,
  plus additive changes to `src/agentTools.js` (registry merge),
  `src/booking.js` (three missing exports), `src/responsePolicy.js`
  (`BOOKING_ACTION_CLAIM`), `src/agentRuntime.js` (`inboundMessageId`/`policy`
  in `buildToolContext`).
- Not in scope / deliberately unchanged: `handleBookingMessage` and the
  `calendarApprovalQueue` admin path (byte-for-byte untouched); the new tools
  are not wired to live traffic (Tickets 010/017); `src/bot.js`,
  `src/messageRouter.js` untouched, so the legacy path cannot yet mark a
  booking claim as verified (see risk below).

### REFAL-AGENT-010 — bot.js shadow integration
- Depends on: 004, 007, 008
- Status: **DONE**
- Acceptance criteria: `runAgentTurn` runs alongside the live deterministic
  path (e.g. behind an env flag, logging comparison output) **without**
  changing what any real customer sees. This is explicitly not the cutover.
- Required tests: shadow-mode unit/integration tests; no change to
  `bot.js`'s actual customer-visible behavior.
- Files: `src/agentShadow.js`, `src/agentShadow.test.js`; additive changes to
  `src/bot.js` (one `require` + one fire-and-forget call site) and
  `package.json`'s `test` script (registers the new test file).
- Design: five independent safety rails, each able to fail alone without the
  others being compromised.
  1. Gated behind `REFAL_AGENT_SHADOW_ENABLED` (default off) — a fully
     synchronous, zero-cost no-op until someone opts in.
  2. **Default-deny tool execution**, not an exclude-list: an explicit
     `READ_ONLY_TOOLS` allowlist (`searchApprovedKnowledge`,
     `getCustomerContext`, `getBookingAvailability`, `proposeHandover` — each
     independently re-confirmed read-only/non-persisting by its own
     file-level comment) is the only thing that keeps a tool's real `run`.
     Everything else — `saveCustomerFact`, `requestBookingAction`, and any
     tool added to `TOOL_REGISTRY` later and never revisited here — gets a
     dry-run stand-in (`shadow_skipped`) automatically. A forgotten
     allowlist entry therefore fails safe, not open (regression test:
     "dry-runs an unrecognized/future tool name by default").
  3. **Bounded concurrency**: `REFAL_AGENT_SHADOW_MAX_CONCURRENCY` (default
     3) caps real shadow turns in flight process-wide; a burst beyond the
     cap is SKIPPED (logged as `agent_shadow_turn_skipped`) rather than
     queued, so it cannot pile up unbounded OpenRouter/embedding calls or
     fire late against stale context.
  4. The shadow call is fire-and-forget by construction
     (`void runShadowAgentTurn(...).catch(() => {})` in `bot.js`, called
     right after `prepareInboundMessage`, before the booking short-circuit)
     and its result is never read by the caller — `response`/`routed` are
     declared and assigned entirely independently, so nothing the shadow
     turn does can alter the legacy reply or routing.
  5. **Logging carries no free-text content** — `agent_shadow_turn` logs
     only `outcome`, `stepCount`, `toolsUsed` (tool names only, not args),
     `responseLength` (a count, not the text), `corrected`, `reason`, and
     `durationMs`. The agent's drafted response text and the customer's
     message are never logged, matching the existing convention everywhere
     else in `bot.js` (e.g. the `ai`/`ai_usage` events never log response
     text either) — a `traceId` shared with the legacy path's
     `response_stage`/`request_total` events is what lets an offline job
     join a shadow outcome to the real turn for comparison, without a new
     place in the codebase logging conversational content. This is on top
     of, not instead of, `operationalTelemetry.js`'s own key-based
     redaction.
- Expected cost/load when enabled: each inbound message adds up to one
  OpenRouter decision call per agent step (max 4 steps) plus, when
  `searchApprovedKnowledge` is chosen, one local-embedding + Supabase
  knowledge-search round trip — bounded at any instant by the concurrency
  cap (default 3 concurrent turns process-wide). This is a real, non-trivial
  addition to per-message cost and local CPU (the embedding pipeline runs
  in-process); it is why the flag defaults off and is meant for a bounded
  comparison window, not left on indefinitely.
- Not in scope / deliberately unchanged: `bot.js`'s actual reply logic,
  `handleBookingMessage`, `routeMessageResult`; this is observation-only.
- Testing limitation (documented, not fixed by this ticket): `bot.js` has no
  direct test harness in this repo — requiring it establishes a live Baileys
  socket connection as a side effect, so it cannot be imported by the test
  runner. The one-line wiring change there (`require` + the fire-and-forget
  call site) was verified by code review only, not by executing `bot.js` in
  a test; everything it calls into (`agentShadow.js`) has full test coverage
  instead.
- Required tests run: `node --test src/agentShadow.test.js`: **10/10
  passed**, exit 0 — flag-off no-op, default-deny allowlist (including an
  unrecognized future tool name), real tool/store reach via a scripted
  decision with response-text-free logging confirmed, write-tool dry-run
  confirmation, the concurrency cap skipping a 3rd concurrent call under a
  cap of 2, and both the decision-step and setup error paths. Full `npm
  test` after adding `agentShadow.test.js` to the test script: **397/397
  passed**, exit 0 (up from the prior 387/387 baseline — no regressions).

### REFAL-AGENT-011 — Output policy consolidation
- Depends on: 003, 005
- Status: PLANNED
- Acceptance criteria: the two independently-tuned `validateResponse`
  call sites found in the trace (`ai.js` model path vs. `messageRouter.js`
  deterministic path) are consolidated into one policy call with
  mode-specific options, not two hand-maintained threshold sets.

### REFAL-AGENT-012 — Fallback/retry redesign
- Depends on: none (bug fix in the existing pipeline, independent of the
  agent scaffold — can land earlier if useful)
- Status: **DONE**
- Acceptance criteria: a content-policy draft rejection in `src/ai.js`
  (`isRetryableModelError`) gets one retry on the configured fallback model
  before falling through to the deterministic answer, fixing the confirmed
  gap where only network/5xx/429 errors are retried today.
- Required tests: `src/aiUsage.test.js` / `src/aiPrivacy.test.js` style,
  mocking `global.fetch` for a content-rejection-then-fallback-success case.

### REFAL-AGENT-013 — Observability
- Depends on: 003, 010
- Status: PLANNED
- Acceptance criteria: each turn records turn id, locale, interpreted goal,
  step count, tools requested/executed + result status, draft
  accepted/rejected + reason, deterministic fallback used, latency — with
  customer-visible content kept separate from internal audit metadata, and
  no secret ever logged.

### REFAL-AGENT-014 — Multilingual tests
- Depends on: 004, 007, 008
- Status: PLANNED
- Acceptance criteria: EN/AR/EL coverage across the new agent path for the
  same categories already covered for the legacy path (language mirroring,
  explicit switch requests, Arabizi/Greeklish detection).

### REFAL-AGENT-015 — 30-scenario test matrix
- Depends on: 004, 007, 008
- Status: PLANNED
- Acceptance criteria: all 30 scenarios listed in Phase 14 of the refactor
  brief are covered, asserting both the customer-visible response and the
  internal workflow side effect.

### REFAL-AGENT-016 — Benchmark comparison
- Depends on: 015
- Status: PLANNED
- Acceptance criteria: `scripts/runConversationBenchmark.js` calls the same
  `runAgentTurn` orchestrator instead of maintaining its own copy of the
  top-level turn sequencing (fixes the duplicated-orchestration risk found
  in the trace); `UNNECESSARY_QUESTION_RATE` and
  `CURRENT_REQUEST_ANSWERED_RATE` metrics are added; results are compared
  against the existing baseline (generic fallback frequency, draft-rejection
  rate, language mismatch, unwanted handover/contact behavior).

### REFAL-AGENT-017 — Live cutover
- Depends on: 010, 013, 015, 016
- Status: PLANNED — **requires its own explicit review/confirmation before
  starting; not authorized by completion of any earlier ticket.** This is
  the point where real customer traffic's behavior actually changes.
- Acceptance criteria: `bot.js` calls `runAgentTurn` for live traffic;
  rollback plan documented; all non-negotiable boundaries re-verified
  deterministic post-cutover.

### REFAL-AGENT-018 — Fix word-boundary substring matching in appointment intent detection
- Depends on: none
- Status: **DONE**
- Acceptance criteria: `\bbook(?:s|ing|ed)?\b` / `\bcall(?:s|ing|ed)?\b` /
  `\bvisit(?:s|ing|ed)?\b` replace the bare substrings in `intent.js`'s
  APPOINTMENT pattern; confirmed "bookkeeping"/"recall"/"textbook" no longer
  false-positive, confirmed real booking requests still match.
- Required tests: `src/intent.test.js` (4 new false-positive + 4 new
  true-positive cases; 26/26 total with `priorityRules.test.js` run together)
- Files: `src/intent.js`, `src/intent.test.js`

### REFAL-AGENT-019 — Scope unqualified bare-word priority triggers
- Depends on: none
- Status: **DONE**
- Acceptance criteria: `media`/`press`/`my account`/`my contract`/`land` in
  `priorityRules.js` require their intended qualifying context (enquiry,
  problem, development deal) instead of matching as bare words; confirmed
  the three live false-positive examples from the bug audit no longer
  escalate, confirmed real complaint/account-problem/land-deal messages
  still do.
- Required tests: `src/priorityRules.test.js` (4 new false-positive + 3 new
  true-positive cases)
- Files: `src/priorityRules.js`, `src/priorityRules.test.js`

### REFAL-AGENT-020 — Remove dead greeting.js code
- Depends on: none
- Status: **DONE**
- Acceptance criteria: independently re-verified no live caller existed
  anywhere in the repo beyond its own test before deleting; smoke test
  updated to drop only the greeting-specific assertions.
- Required tests: `src/smoke.test.js`
- Files: `src/greeting.js` (deleted), `src/smoke.test.js`

### REFAL-AGENT-021 — businessHours.js wiring decision (remaining cleanup item)
- Depends on: none
- Status: PLANNED — deferred from the 018 batch since wiring it in touches
  `bot.js` (explicitly off-limits for now) and is a product decision
  (whether/what out-of-hours text to send in EN/AR/EL), not just a bug fix.
  Removing it instead (if the owner doesn't want the feature) is the other
  valid outcome — needs a decision, not just an implementation.

## Current runtime flow

Unchanged from "Current architecture" above until Ticket 017 explicitly
wires `runAgentTurn` into `bot.js`'s live path.

## Remaining work

Tracked entirely by ticket status in the roadmap above (004 onward). The
only hard ordering constraint restated here: **no work starts on Ticket 010
(shadow integration) before 004/007/008 are done, and no work starts on
Ticket 017 (live cutover) without a separate, explicit go-ahead** — both
per the agreed "parallel investigation, sequential implementation" approach
and because this is a live, customer-facing production system.

## Known risks

- This is a live, customer-facing production system (real WhatsApp traffic,
  real Supabase data). All work happens on `feature/agentic-orchestration`;
  nothing merges to `main` without explicit review.
- The lost-update race in `store.updateUser` is a pre-existing bug, not
  something this refactor introduces — but the new `saveCustomerFact` tool
  must not add a new write path through the same unguarded function without
  flagging the risk (see ticket when implemented).
- Switching the model-decision contract away from free text (today) to a
  structured JSON decision object is a real design change to `ai.js`'s
  call shape — recorded as a decision-log entry when implemented, not
  silently introduced.

## Test status

- Baseline (before any refactor code change), full `npm test`: **303/303 passed**, exit 0.
- After Tickets 001-003: new suite **27/27 passed**, exit 0 (isolated run).
- After Tickets 004, 012, 018, 019, 020 (implemented in parallel on disjoint
  files — `src/agentDecision.js`, `src/ai.js`, `src/intent.js`,
  `src/priorityRules.js`, `src/greeting.js` deletion — each verified
  individually by its own fork, then reconciled): full `npm test` run once
  against the combined working tree: **349/349 passed**, exit 0. No
  interaction effects between the five concurrent changes.
- After Ticket 005 (respond/clarify correction-and-retry in `agentLoop.js`):
  agent-layer suite **43/43 passed**, isolated run.
- After Ticket 006 (`src/conversationState.js`, additive/read-only projection):
  full `npm test` **356/356 passed**, exit 0 — zero regressions to any
  existing suite, confirming the wrap-not-migrate scoping decision held.
- After Tickets 007 (`src/agentRuntime.js`) and 008 (handover integration
  tests + a `responsePolicy.js` fix for a real gap the integration test
  found): full `npm test` **365/365 passed**, exit 0.
- After Ticket 009 (booking tools, `BOOKING_ACTION_CLAIM`): targeted run
  (`booking.test.js`, `calendarReadiness.test.js`, `responsePolicy.test.js`,
  `agentLoop.test.js`, `agentTools.test.js`, `agentHandoverIntegration.test.js`,
  `agentRuntime.test.js`, `agentBookingTools.test.js`,
  `agentBookingIntegration.test.js`) **92/92 passed**, exit 0, including
  `booking.test.js`'s existing 25/25 unaffected. Full `npm test` **387/387
  passed**, exit 0.
- After Ticket 009 (booking tools): full `npm test` **366/366 passed**, exit 0
  (the two new files are not in the `test` script yet, by request — they are
  run explicitly). The ticket's own run,
  `node --test src/booking.test.js src/calendarReadiness.test.js
  src/responsePolicy.test.js src/agentLoop.test.js src/agentTools.test.js
  src/agentHandoverIntegration.test.js src/agentRuntime.test.js
  src/agentBookingTools.test.js src/agentBookingIntegration.test.js`:
  **92/92 passed**, exit 0. `src/booking.test.js` alone: **25/25 passed**
  before and after, confirming the admin approval path and its
  `calendarApprovalQueue` lock were not affected.

## Benchmark status

Not yet re-run under this refactor. The existing benchmark harness
(`scripts/runConversationBenchmark.js`) duplicates `bot.js`'s top-level
turn sequencing rather than calling a shared orchestrator — once
`runAgentTurn` exists, the benchmark should be updated to call it too,
rather than maintaining a second copy of the sequencing logic.

## Decision log

### Decision: investigate in parallel, implement sequentially
**Reason:** the refactor brief asked for many parallel agents, but later
phases (tool registry, agent loop) depend on what earlier phases discover
about existing services, and this is a live production codebase. Read-only
Phase 1/2 tracing was fanned out across 4 parallel agents (safe, no shared
mutable state); all code changes from Phase 3 onward are implemented
sequentially, one ticketed vertical change at a time. Confirmed with the
repository owner before starting.

### Decision: do all work on a feature branch, not `main`
**Reason:** production bot with real customer traffic; `main` must stay
deployable. Confirmed with the repository owner before starting.

### Decision: saveCustomerFact normalizes field-name case before use as a key
**Reason:** validating a field name's character set but not its case still
lets the same logical fact fragment into multiple stored keys
(`companyActivity` vs. `COMPANYACTIVITY`). Normalized to lowercase at the one
point the key is written/read, with a regression test. Caught by a SkyOps
recall lesson (`20260919-allowlist-casing-not-normalized`) before this ever
reached a ticket — recorded here so the pattern isn't reintroduced by a
later tool.

### Decision: ticket numbering follows a pre-agreed 18-ticket roadmap
**Reason:** rather than numbering tickets as work happened to unfold, the
full sequence (001 tool contracts → 017 live cutover → 018 cleanup) was
fixed upfront with explicit dependencies, acceptance criteria, and required
tests per ticket (see "Implementation roadmap"). This makes the two hard
gates — no shadow integration before the tool/decision/RAG/handover work is
done, no live cutover without a separate go-ahead — visible as roadmap
positions (010, 017) rather than something that has to be remembered.

### Decision: Ticket 006 wraps the scattered state fields, it does not migrate their write sites
**Reason:** the roadmap entry for 006 allowed either "replaces (or explicitly
wraps)." `messageRouter.js`'s 25-branch, ~890-line `routeMessageResult` and
`existingClientWorkflow.js`'s state machine are live, heavily tested, and
the Agent's actual requirement (Phase 7: "a single trusted
conversation-state representation") only needs a consistent *read* view —
it does not require changing where today's deterministic router writes
`profile.leadQualification`, `profile.handover`, etc. Migrating those write
call sites is real, separable work with its own regression risk and is not
needed to unblock Tickets 007-009. `src/conversationState.js` is therefore a
pure, additive projection function with zero changes to any existing write
path; `agentTools.js`'s `getCustomerContext` was refactored to consume it
(removing its own duplicate ad hoc read), and the full test suite was run
to confirm zero regressions. If a future ticket genuinely needs the writes
themselves unified, it should be scoped and risk-assessed separately, not
assumed to be part of 006.

### Decision: the booking tools get their OWN per-slot lock, not `calendarApprovalQueue`
**Reason:** the customer self-confirmation race is real (`booking.js`'s
`awaiting_confirmation` branch checks `isAvailable` and then writes with no
serialization at all), but `calendarApprovalQueue` is a single global queue
owned by `approvePendingAppointment` and covered by its own tests. Reusing it
would serialize every customer slot behind every admin approval and would
change the behavior of a live, tested path. Ticket 009 therefore adds a
separate `Map<slotKey, Promise>` in `src/agentBookingTools.js` using the same
promise-chaining pattern, keyed by calendar+start+end so unrelated slots still
run concurrently, and deletes each entry as its chain settles (the project's
own bug audit already flagged an unbounded in-memory map in `rateLimiter.js`).
`handleBookingMessage` itself is left exactly as it is: the legacy
deterministic router still reaches it, and rewriting it is a separate,
risk-assessed change — the new lock protects the new path only.

### Decision: the booking tool derives its idempotency key from the inbound WhatsApp message id
**Reason:** `store.createAppointment` has always accepted an `idempotencyKey`,
but the legacy flow falls back to `randomUUID()`, so nothing forces a retried
or duplicate-delivered message to reuse the same key. The new tool derives
`agent-booking:<sha256(messageId|slot)>` from the real provider message id —
the same id the dedup layer in `bot.js` already claims against — and fails
closed when the caller does not supply one. The additional in-process
`Map<key, result>` is a fast path only; it is explicitly not the correctness
guarantee, because a second instance would not share it (the same caveat the
project already documents for the in-memory rate limiter).

### Decision: `requestBookingAction` keeps the administrator-review gate
**Reason:** the live store files every customer-requested appointment as
`pending_review`, and the legacy customer path additionally coerces
`pending_calendar`/`failed`/`rejected`/`rescheduled` to `pending_review`
before replying. The new tool mirrors that coercion exactly and returns
`status: "pending_review"` with no customer-facing confirmation wording, so
the Agent path cannot become a way around admin approval.

(Further decisions appended here as they are made.)
