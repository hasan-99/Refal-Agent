# REFAL AI — Master Implementation Roadmap

**Document purpose:** The authoritative, phase-by-phase delivery plan for turning the REFAL Master Brain & Operating Rules Manual and its accompanying implementation plan into a reliable multilingual customer-facing agent.

**Status:** Planning baseline — all implementation phases are `PLANNED` until verified against the current repository and runtime.

**Primary source documents:**
1. `Master Brain & Operating Rules Manual - REFAL AI.txt` — business identity, service knowledge, sales guidance, qualification, data model, compliance, and dynamic-data requirements.
2. `plan.txt` — initial proposed architecture, Supabase data, language strategy, hooks, scoring, and developer action plan.
3. Prior REFAL project decisions captured below — WhatsApp worker, Supabase/API/dashboard, booking policy, privacy, model routing, and known audit findings.

**Timezone for business operations:** `Europe/Nicosia`.

---

## 1. Outcome and definition of done

REFAL is complete when a customer can contact it through the supported channel, receive an accurate and natural answer in Arabic, English, or Greek, and be handled through the correct next step without losing context or inventing facts. REFAL must use approved, current business knowledge; distinguish stable knowledge from live values; remember relevant information within the authorized customer/conversation scope; and use working, permission-checked tools for CRM, handover, follow-up, and bookings.

“Big brain” means a maintainable system made from versioned instructions, reviewed knowledge, live data sources, customer/conversation state, and deterministic workflows. It does **not** mean pasting the whole manual into one prompt or relying on model memory alone.

### Definition of done

- Every requirement in the traceability matrix (Section 4) has an owner component, an acceptance test, and evidence of passing.
- Each supported language has retrieval tests and end-to-end conversation tests across the service areas.
- No unapproved, outdated, or contradictory fact is presented as certain.
- Tool actions are only claimed after the tool confirms success; failures produce truthful customer messaging and internal visibility.
- Customer context is scoped, durable where appropriate, editable, and not repeatedly requested.
- Lead scores, routing, permissions, booking states, follow-up consent, and audit events are reproducible and testable.
- All phase gates have passed, open defects are either fixed and retested or explicitly accepted by the owner, and release/rollback evidence is recorded.

---

## 2. Planning rules and delivery control

### 2.1 One phase at a time

Work proceeds in order. A phase is not marked complete because code was written or unit tests passed. It is complete only after all its exit criteria and verification evidence are recorded in this file.

### 2.2 Required closeout loop for every phase

At the end of **every** phase, before starting the next one:

1. Update the phase status, date, commits/files changed, tests run, and evidence in this roadmap.
2. Run the phase-specific tests and the relevant regression suite.
3. Run a requirement-to-implementation gap scan against Section 4 and the source-document references.
4. Review logs, failed cases, retrieval traces, database side effects, and user-visible responses relevant to that phase.
5. Classify findings as blocker, high, medium, or low; add each to the defect log with reproduction steps.
6. Automatically fix safe, in-scope defects in the working branch; do not advance while a blocker or high-severity defect remains.
7. Rerun the failing test, the phase suite, and regression tests. Record before/after results.
8. If a defect requires a policy decision, external credentials, an unapproved data source, or a production-side effect, mark it `OWNER DECISION / EXTERNAL DEPENDENCY` and keep the affected capability safely disabled. Do not silently invent the answer.
9. Set the phase to `COMPLETE` only when the gate passes; otherwise leave it `IN PROGRESS` or `BLOCKED`.

### 2.3 Safe automation boundary

“Auto-fix” means make and verify safe code, prompt, schema, test, or knowledge-pipeline changes within the development branch. It does not mean silently send customer messages, create real appointments, change external account settings, expose credentials, or deploy/restart production. Preserve the prior project constraint: do not restart or deploy until specialist-offer persistence, investment-intake routing, and retrieval-fallback leak checks pass, in addition to the release gates in Phase 16.

### 2.4 Evidence standard

Every pass claim must name the command/test or observable evidence and the result. Synthetic tests must be labeled synthetic. A successful build is not evidence that a workflow works. A passing old test count is historical until rerun against the current code and current requirements.

---

## 3. Target architecture

| Layer | Responsibility | Examples | Must not be used for |
|---|---|---|---|
| Operating rules | Identity, language behavior, safety hierarchy, response style, refusal/escalation rules | System/developer prompt, versioned policy config | Large catalogues, volatile prices, appointments |
| Reviewed knowledge | Stable service explanations, approved FAQs, lifecycle guidance, cross-sell context, objection guidance | Supabase knowledge records + searchable chunks + metadata | Live availability, current fees, individualized legal/tax advice |
| Dynamic data | Facts that can change and must be checked at answer time | Offers/pricing, annual fees, property inventory/deposits, regulatory fees, calendar slots | Prompt text or stale vector chunks |
| Conversation/customer state | Facts the customer stated, language preference, active intent, consent, lead state, corrections | Scoped Supabase records and event history | Unbounded transcript replay or inferred identity treated as verified |
| Deterministic workflows/tools | Actions requiring exactness, authorization, or external side effects | Validation, scoring, routing, booking, CRM upsert, alerts, opt-out | Model-only “I booked/sent/saved it” claims |
| Evaluation and operations | Quality, safety, reliability, cost, latency, auditability | Test corpus, traces, dashboards, alerts, rollback | Unreviewed live experiments |

### Existing project context to confirm in Phase 0

Prior project notes identify Supabase, a `rafa-agent-api` Edge Function/API, a WhatsApp worker at local port `8792`, a dashboard at local port `8787`, and `deepseek/deepseek-v4.1-flash` through OpenRouter as the selected model. They also record `data_collection: deny` / ZDR routing as an important constraint. These are **baseline leads, not proof of current configuration**; Phase 0 must inspect the repository and deployed settings without printing secrets. Do not change the model or data-routing policy as part of this plan unless the owner directs it.

---

## 4. Requirement traceability matrix

Use IDs below in PRs, tests, and phase closeouts. A requirement is not complete until its acceptance evidence is linked in the phase record.

| ID | Requirement | Source | Planned implementation / proof |
|---|---|---|---|
| R-01 | REFAL is Refalco’s customer-facing business assistant and covers the ten contextual roles: relationship, business development, qualification, corporate, investment, real estate, construction, service, appointments, and routing. | Manual 1.0–1.1 | Intent map + role-routing tests; no contradictory agent identity. |
| R-02 | Detect and answer in Arabic, English, or Greek; follow the customer’s latest language and explicit switch request. | Manual language/persona; plan §2 | Language classifier/fallback + multilingual E2E matrix. Arabic should be warm, clear, and simple; English business-casual; Greek professional. |
| R-03 | Match formality and humor to context; serious for complaints, distress, legal disputes, immigration problems, AML/KYC, sanctions, losses, illness/death; warm for complex/high-value matters; playful only in suitable ordinary conversations. | Manual 1.2; plan §2 | Tone policy tests for each sensitive class and positive/negative examples. |
| R-04 | Answer the customer’s actual question first; be concise by default; do not force qualification, booking, or sales into informational answers. | Manual 1.3; prior owner decisions | Golden-answer policy tests; informational leads remain informational. |
| R-05 | Ask at most one useful question in a response by default; questions are optional when a direct answer is enough. | Manual 1.3; sample responses conflict | Output validator/eval; correct examples that contain multiple questions. |
| R-06 | Never promise bank, payment-gateway, government, residency, visa, or investment outcomes; avoid invented urgency and ROI guarantees. | Manual 1.3, 2.3, 2.5, 5.3 | Deterministic safeguards + multilingual adversarial tests. |
| R-07 | Knowledge covers company formation and lifecycle, changes, branch/subsidiary/new company, shareholders/directors, addresses, dormant/closure, tax/accounting/compliance, banking/payments, residency/Non-Dom, property journey/cities/VAT, legal/IP, landowners, construction, objections, comparisons, and cross-sell triggers. | Manual 2–3 | Reviewed topic taxonomy, coverage inventory, retrieval tests for every topic. |
| R-08 | Dynamic values come from live sources, never stale prompt/RAG values: inventory, deposits, annual renewals, slots, government/third-party fees, active promotions. | Manual 5.3 | Typed tool/API contracts, staleness and unavailable-source tests, provenance/freshness shown internally. |
| R-09 | Do not activate unverified amounts, dates, legal/tax/residency claims, eligibility rules, or company experience metrics as approved facts. | Manual contains figures; prior decision | Fact approval register with source, reviewer, effective date, expiry/review date, and status. Unapproved content is blocked. |
| R-10 | Persist customer and conversation state; retain useful facts and corrections; never re-ask for already provided details without a reason. | Manual 5.1; plan §3 | Scoped memory tests, field extraction tests, correction-event tests, retention rules. |
| R-11 | Never save a greeting or unrelated phrase as a person’s name; phone/WhatsApp metadata is not user-provided consent for unrelated follow-up. | Prior REFAL bug reports | Name self-introduction/validation tests, explicit source fields, contact upsert tests. |
| R-12 | Capture CRM fields progressively and only when relevant; avoid collecting unnecessary sensitive data; do not ask for passwords, card details, or public-chat bank statements. | Manual 5.1, 5.3; plan §3 | Schema/data-minimization checks, consent and redaction tests. |
| R-13 | Score leads across six dimensions 0–5 (need, value, timing, authority, readiness, fit) to 0–30; classify exact score tiers; keep score internal. | Manual 4.1–4.2; plan §5 | Deterministic scoring with persisted reasons/evidence; boundary tests 7/8, 13/14, 19/20, 24/25. |
| R-14 | Informational/Cold/Warm/Hot/Strategic tiers get suitable, non-coercive actions; Hot means stop over-selling; Strategic opportunities get fast human escalation. | Manual 4.2 | Tier action tests, no forced meeting for informational request, high-value alerts. |
| R-15 | Hooks identify relevant secondary services (IP Box, residency, relocation, property, offices/substance, trademark, etc.) without making false eligibility promises or derailing the request. | Manual 3.1; plan §4 | Trigger/anti-trigger tests; at most one contextual hook at a time; customer can decline. |
| R-16 | Handle objections empathetically and accurately; avoid manipulative assumptions, shaming, fear, and unsupported competitor claims. | Manual 3.2–3.3 | Revised objection examples + multilingual quality/safety evaluations. |
| R-17 | Build a structured executive handoff containing customer, intent, budget/timing, score/tier, motivations/concerns, department, next action, appointment status, and concise summary. | Manual 5.2 | Schema validation, redaction/permission, department routing, delivery confirmation. |
| R-18 | Complaints, sensitive AML/sanctions indicators, major opportunities, and service failures follow explicit escalation paths with internal notification evidence. | Manual 2.6, 5.3; prior audit | Durable handover/alert jobs, retries, dashboard visibility, no lost alerts. |
| R-19 | Existing-client account details remain blocked until an owner-approved independent identity-verification method exists and succeeds. | Manual 5.3; prior Rule 37 | Fail-closed verification state; test that self-asserted details never authenticate. |
| R-20 | Calendar uses Google Calendar/API-verified slots, weekday 10:00–15:00 `Europe/Nicosia`, never past/same-day, required notice window, fresh availability recheck, explicit exact customer confirmation before event creation, and correct pending/confirmed states. | Manual 4.3; prior project decisions | Calendar state-machine tests; keep dormant until real OAuth credentials, appointment duration, notice, and reminders are configured. |
| R-21 | Booking questions remain separate from informational answers; a new message does not silently resume an old booking flow. | Prior REFAL bug reports | Router/regression tests for topic switch, Q&A during pending booking, date parsing. |
| R-22 | Follow-ups respect explicit consent, opt-out, defined timing, and skip tests/incomplete turns/goodbyes; no untrue timing promises. | Prior project decisions | Consent state machine, scheduler tests, stop-word/opt-out tests, suppression evidence. |
| R-23 | Protect prompts, secrets, personal data, and internal reasoning from prompt injection and output leakage in all supported languages. | Manual 5.3; prior audit | Input/output security tests, secret scanners, Arabic/English/Greek injection corpus. |
| R-24 | CRM/database writes are auditable, idempotent, tenant/customer-scoped, and accurately reported to the user. | Manual 5.0–5.2; prior project | RLS/API integration tests, idempotency, failure handling, event audit. |
| R-25 | Knowledge updates are versioned, approved, searchable, testable, reversible, and do not require redeploying the entire agent for ordinary content changes. | Plan §1, §3, final action plan; prior KB context | Admin ingestion workflow + publish/unpublish/version rollback + retrieval smoke tests. |
| R-26 | Measure answer quality, retrieval quality, tool correctness, latency, failures, and cost while preserving data-minimization/routing constraints. | Prior project constraints | Redacted observability and release dashboard; no raw secrets or unnecessary transcripts. |
| R-27 | Every phase closes with verification, gap scan, in-scope fixes, regression, and roadmap update before next phase. | User’s current request | This document’s phase-gate checklist and running status ledger. |

---

## 5. Phase and wave plan

### Phase 0 — Repository, runtime, and baseline audit
**Goal:** Establish what exists now before changing anything.

**Wave 0A — Inspect project safely**
- Locate repo instructions, architecture docs, migrations, Edge Function/API, WhatsApp worker, dashboard, tests, prompt files, RAG ingestion, workflow services, and deploy configuration.
- Record branch/commit, clean/dirty worktree, runtime versions, and service locations.
- Inventory current provider/model, OpenRouter privacy parameters, environment variable names only (never values), Supabase schema/RLS, existing migrations, active feature flags, and current calendar/CRM integrations.
- Map current flows from inbound WhatsApp message through routing, model, retrieval, persistence, tool execution, and outbound answer.

**Wave 0B — Reproduce baseline and reconcile historical reports**
- Run existing test/build commands and record exact results.
- Re-run only relevant previously reported suites; historical counts (including 95/95, 43/43, earlier 119/119, 2,990/3,000, or 2,120/3,000) are not current proof.
- Reproduce known gaps: formation/investment misclassification, Arabic colloquial formation, greeting/name capture, handover notification, Q&A blocked by booking, identity intent, Arabic retrieval, Greek coverage, output leaks, and persistence/routing concerns.
- Identify any currently disabled or dormant behavior and why.

**Exit gate**
- A component map, test baseline, known-defect register, and evidence directory are recorded.
- No secret values were copied into logs or this roadmap.
- All work can be made in an isolated working branch; no production restart/deploy occurred.

**Verification and gap scan**
- Check that every known historical bug is either reproduced, shown fixed by current evidence, or listed as unresolved with reproduction attempt.
- Auto-fix only trivial test harness issues if needed; do not alter behavior before requirements are reconciled.

**Status:** `PLANNED`

---

### Phase 1 — Requirements normalization, conflict resolution, and source-of-truth register
**Goal:** Convert the two documents and prior owner decisions into one unambiguous specification.

**Wave 1A — Build the complete content inventory**
- Extract every service, rule, fact, dynamic variable, hook, objection, role, workflow, data field, refusal/escalation, and example from Manual sections 1–5.
- Map each item to Section 4 requirement IDs and an eventual test ID.
- Mark content as `approved stable`, `approved but dated`, `needs subject-matter approval`, `dynamic/API`, `example only`, `conflicting`, or `blocked`.

**Wave 1B — Resolve contradictions safely**
- Reconcile the “golden answer formula” with the owner’s requirement to answer informational questions without pushing a meeting: answer first; a question or hook is optional and only useful.
- Enforce one question by default. The manual’s multi-question objection examples must be rewritten; they are examples, not stronger rules.
- Define that customer language preference overrides default Arabic preference when the customer explicitly switches language; Arabic input should normally receive Arabic.
- Clarify no automatic meeting push based solely on score. Customer request/consent and verified availability are required.
- Define progressive data capture, consent, opt-out, sensitive-data minimization, and correction handling.
- Treat all time-sensitive legal/tax/immigration claims, package inclusions/prices, company-history metrics, and eligibility thresholds as blocked until approved with dated authoritative source and reviewer.
- Preserve intentional existing-client verification boundary until independent verification is configured.

**Wave 1C — Write policy precedence**
1. Privacy/security and fail-closed tool rules.
2. Owner-approved business policies and service facts.
3. Current live data returned from trusted APIs.
4. Conversation facts explicitly supplied by the customer.
5. Approved retrieved knowledge.
6. General model knowledge only for harmless general explanations, never as REFALCO-specific claims.

**Exit gate**
- Requirements matrix has no unowned or untestable item.
- Conflict register contains decision, owner, rationale, and effective date.
- A source-of-truth register exists for every numeric/legal/company-specific claim.

**Verification and gap scan**
- Compare headings, tables, examples, and lists in both source files against mapped requirements.
- Automatically add omitted mappings/tests; block progression for unresolved policy conflicts that affect customer-facing behavior.

**Status:** `PLANNED`

---

### Phase 2 — Canonical business knowledge and fact governance
**Goal:** Turn the manual into reviewed content instead of blindly indexing the document.

**Wave 2A — Normalize knowledge by service domain**
Create versioned records for:
- REFALCO identity, approved company history and proof points.
- Company formation, package inclusions, timeline, company lifecycle, branch/subsidiary/new-company choices, shareholder/director distinction, later changes, registered vs physical/virtual office, dormant company, and closure.
- Tax, accounting, VAT, IP Box, dividends vs salary, holding vs trading, payroll, EORI, and compliance — only approved general explanations.
- Banking, Stripe/PayPal/Amazon/Shopify and approval limitations.
- Residency/permanent residency, investment categories, family relocation, schools, healthcare/GESY, Non-Dom, source of funds vs source of wealth.
- Property purchase journey, off-plan vs completed, city profiles, VAT caveats, rental/ROI limits, deposit rules, and live inventory boundary.
- Legal contracts, trademarks, shareholder agreements, service/employment agreements, T&Cs/GDPR advisory, landowner partnerships, and construction tender intake.
- Sales hooks, objections, and fair jurisdiction comparisons.

**Wave 2B — Fact approval and expiry**
- For every number or claim, capture: exact claim, source URL/document, source type, jurisdiction, reviewer, verified-at date, effective-from date, expiry/review date, approved language variants, and approval status.
- Keep unverified examples (e.g., quoted fees, 15% tax, IP Box ~2.5–3%, residency thresholds/income, 17-year Non-Dom, company timelines, experience/project counts) marked `BLOCKED` until approved. Do not let these leak through semantic search.
- Store service terms and boundaries separately from sales copy so a persuasive example cannot override a limitation.

**Wave 2C — Translate and review**
- Prepare Arabic, English, and Greek canonical summaries for high-frequency/critical topics.
- Preserve exact legal meaning across translations; mark missing reviewed translations as fallback-required, not as facts to invent.
- Use bilingual/trilingual glossary for company/legal/property terms and consistent transliteration.

**Exit gate**
- Every Manual section is represented in the inventory.
- Every active fact has approval metadata; blocked items are excluded from customer retrieval.
- Greek coverage includes every critical category or an explicit safe handover/fallback.

**Verification and gap scan**
- Check for duplicated, stale, contradictory, unsourced, or overly promotional content.
- Test that blocked phrases cannot be retrieved or surfaced.
- Auto-fix content metadata/translation omissions in scope; route factual legal approval to a qualified reviewer.

**Status:** `PLANNED`

---

### Phase 3 — Data model, authorization, migrations, and auditability
**Goal:** Implement durable storage without turning every concern into one oversized table.

**Wave 3A — Model the bounded data domains**
Confirm existing schema first; adapt rather than duplicate. Required logical records include:
- `knowledge_documents`, `knowledge_chunks`, versions, approvals, source metadata, language, tags, effective dates, and publish status.
- `offers_and_pricing` / approved pricing records; `real_estate_inventory` / projects and unit availability; deposit terms; annual renewal costs; government/third-party fee schedules; active promotions.
- `leads` / contacts with verified source, normalized fields, consent, language, and correction history.
- `conversations`, messages/events, extracted customer facts, current intent, active workflow, and summaries.
- Qualification score dimensions, score evidence, lead tier, next action.
- Appointments and booking state transitions.
- Handover cases, department/assignee, priority, delivery attempts, and acknowledgment.
- Follow-up consent, opt-out/suppression, scheduled jobs, attempts, and cancellation.
- Complaints, identity-verification state, compliance events, and audit events.

These are logical domains, not a requirement to create exactly one physical table per bullet. Reuse existing workflow tables when they meet correctness, RLS, and migration requirements.

**Wave 3B — Security and integrity**
- Define Supabase RLS/service-role boundaries; public chat cannot read other leads or account data.
- Use stable channel/contact identifiers and tenant scoping; prevent duplicate lead creation; protect PII in logs.
- Add constraints/enums for status machines and idempotency keys for incoming messages, CRM writes, alerts, and booking calls.
- Create append-only audit events for consent, score changes, human corrections, booking confirmations, and sensitive access.
- Define retention, deletion, export, and correction policy with owner approval.

**Wave 3C — Migration and rollback**
- Write forward/backward-compatible migrations with preflight and rollback notes.
- Keep migration fixtures for old rows and null/partial data.
- Do not apply production migrations as part of local test verification.

**Exit gate**
- Schema diagram/data dictionary and ownership map approved.
- RLS/integration tests demonstrate isolation and idempotency.
- Migration and rollback have been exercised in a disposable environment.

**Verification and gap scan**
- Test cross-contact reads/writes, duplicate events, malformed phone/name data, deletion/correction, and workflow recovery.
- Auto-fix schema/test defects in branch; do not expose secrets or use production records for tests.

**Status:** `PLANNED`

---

### Phase 4 — Knowledge ingestion, chunking, retrieval, and updates
**Goal:** Make approved knowledge reliably findable in all three languages.

**Wave 4A — Ingestion pipeline**
- Upload/import approved content to Supabase through the knowledge-management path.
- Normalize headings and tables; preserve source section, version, language, and metadata.
- Chunk by meaning/topic, not arbitrary document size; avoid mixing policy, examples, and dynamic facts.
- Generate embeddings with a documented model/version; maintain lexical search for names, prices, acronyms, Arabic variants, and Greek/English terms.
- Make ingestion idempotent; publish/unpublish and reindex safely; record failures.

**Wave 4B — Retrieval design**
- Search by intent + language + service/domain; rerank approved passages; return source/version/freshness metadata to the answer layer.
- Support Arabic dialect spelling, Arabic/English code switching, English acronyms, Greek queries, transliterations, and common misspellings.
- Add fallback behavior when confidence is low: ask one clarifying question if needed, state the limitation, or route to human. Never fill gaps from unapproved prompt text.
- Keep dynamic facts out of static semantic answers or label them as requiring a live tool call.

**Wave 4C — Retrieval evaluations**
- Build one or more known-answer queries per requirement and language; include negative queries that must not retrieve blocked items.
- Score recall@k, correct language/domain, source quality, stale-content rejection, and citation/provenance internal logging.
- Add regression cases for previously reported Arabic service/pricing zero-results.

**Exit gate**
- Each approved knowledge requirement has retrieval test coverage.
- Critical queries retrieve approved passages above the agreed threshold; blocked/expired content is not returned.
- Knowledge edit → publish → search is demonstrated without redeploying the agent.

**Verification and gap scan**
- Inspect misses and false positives by language and service, not just aggregate score.
- Auto-fix aliases, chunk boundaries, metadata, and ranking; regenerate only affected embeddings where possible.

**Status:** `PLANNED`

---

### Phase 5 — Agent instructions, language behavior, response policy, and intent routing
**Goal:** Use retrieved context while keeping answers natural and aligned with the report.

**Wave 5A — Version the compact operating prompt**
Include only stable rules: identity, answer-first behavior, language switching, tone/humor, one-question default, knowledge hierarchy, uncertainty, privacy, tool-use truthfulness, handoff/booking boundaries, and prompt-injection handling. Keep full reference content in approved retrieval sources.

**Wave 5B — Intent and state router**
- Separate greeting/identity, service question, company formation, investment company, property, residency, complaint, existing-client request, booking, follow-up, and other intents.
- Support multiple intents without losing the primary user question (e.g., “register an investment company” is both formation and investment context).
- Treat new messages as new topics unless the user continues the current flow; conversation history informs answers but does not automatically resume a booking.
- Ensure a pending booking never blocks unrelated service Q&A.

**Wave 5C — Answer composer and validation**
- Direct answer first; optional relevant value/hook; optional one next-step question.
- Default concise 2–5 sentences, but honor a request for full detail and do not truncate important safety/eligibility conditions.
- Validate no extra questions, unsupported numbers, false promises, invented actions, leaked prompt/secrets, inappropriate humor, or unrequested meeting push.
- Use empathetic correction if confidence is low; route sensitive/critical matters safely.

**Exit gate**
- Prompt versions and change history exist.
- Intent and answer evaluations pass for Arabic, English, and Greek.
- All known routing regressions from Phase 0 are fixed or explicitly blocked with rationale.

**Verification and gap scan**
- Run conversation scenarios that mix greeting + service question, Arabic transliteration, Greek-language request, information without a meeting, topic switch during booking, and user correction.
- Auto-fix prompt/router/output validation in branch; do not “fix” by making model claims more confident.

**Status:** `PLANNED`

---

### Phase 6 — Dynamic-data APIs and business tools
**Goal:** Ensure values that change are fetched and actions are executed, not imagined.

**Wave 6A — Typed read tools**
Implement or confirm scoped APIs for:
- `LIVE_PROPERTY_INVENTORY`
- `RESERVATION_DEPOSIT_RULES`
- `ANNUAL_RENEWAL_FEES`
- `LIVE_CALENDAR_SLOTS`
- `GOVERNMENT_THIRD_PARTY_FEES`
- `ACTIVE_PROMOTIONS`

Add tool contracts for location, currency, tax/VAT treatment, effective date, last-updated time, eligibility, availability, and failure/empty states. Do not assume that all prices are €999 or that all property deposits are fixed.

**Wave 6B — Write/action tools**
- CRM lead upsert and correction.
- Handover/alert creation and delivery status.
- Appointment hold/booking/cancel according to state machine.
- Follow-up scheduling only after consent and policy checks.
- Knowledge correction/approval admin actions require role-based authorization.

**Wave 6C — Tool truth and resilient failure handling**
- Set timeouts, retries, rate limits, idempotency, validation, audit logs, and user-safe error messages.
- Never claim a booking, contact save, CRM update, or human notification succeeded until confirmed.
- If a tool fails, retain a safe pending state and surface an internal alert; do not silently fall back to invented data.

**Exit gate**
- Every dynamic variable is backed by a source/tool or marked unavailable and safely blocked.
- Contract tests cover success, empty, stale, error, timeout, duplicate, unauthorized, and partial result.
- Customer-facing messages distinguish “pending”, “confirmed”, and “failed”.

**Verification and gap scan**
- Inject stale timestamps and tool failures; verify no static answer leaks as a substitute.
- Auto-fix retry/idempotency/validation defects before next phase.

**Status:** `PLANNED`

---

### Phase 7 — Conversation memory, customer facts, contact capture, and CRM correctness
**Goal:** Remember useful context accurately without intrusive collection.

**Wave 7A — Extract and normalize facts**
- Extract only supported fields explicitly stated or safely derived, with provenance and confidence.
- Store name only after clear self-identification; preserve raw customer spelling and normalized form separately.
- Avoid asking again for country, budget, family, activity, target market, or timeline already provided.
- Record conflicts as a correction/clarification need instead of overwriting silently.
- Mark inferred facts separately from customer-stated facts.

**Wave 7B — Progressive collection and consent**
- Answer first, then ask for one relevant detail when needed.
- Do not request contact data just because a score tier was reached; explain why it is needed and request permission when appropriate.
- Use WhatsApp platform metadata only for the current conversation and only for the declared business purpose.
- Capture email/phone only when provided or asked for with a relevant next step; support correction and opt-out.
- Keep Source of Funds and Source of Wealth separate; collect only high-level status in public chat, never sensitive files/statements there.

**Wave 7C — Conversation summaries and CRM sync**
- Store concise summaries and lead fields tied to contact/conversation IDs.
- Sync reliably to existing Supabase workflow and, if configured, the selected CRM; record sync state and retry safely.
- Ensure summary excludes secrets and irrelevant sensitive details.

**Exit gate**
- Multi-turn scenarios prove memory works across turns and does not cross contacts.
- Greeting/name, duplicate lead, customer correction, known-phone, opt-out, and no-repeat-question tests pass.
- CRM failures remain visible and retryable without duplicate customer records.

**Verification and gap scan**
- Review extracted facts against transcript fixtures and data minimization policy.
- Auto-fix extraction/schema/sync defects and retest across all languages.

**Status:** `PLANNED`

---

### Phase 8 — Lead scoring, qualification, and sales hooks
**Goal:** Apply the manual’s sales engine without revealing scores or pressuring customers.

**Wave 8A — Deterministic scoring model**
- Define evidence anchors from 0–5 for need, value, timing, authority, readiness, and fit.
- Persist dimension scores, evidence text references, scorer version, timestamp, and total 0–30.
- Do not infer budget/authority/readiness from nationality, language, name, or protected traits.
- Recompute only when meaningful new evidence arrives; retain score history.

**Wave 8B — Tiers and allowed next actions**
- 0–7 Informational: answer; no booking push.
- 8–13 Cold: one relevant exploratory step; no forced follow-up.
- 14–19 Warm: continue useful qualification; offer contact/meeting only when appropriate and not repeatedly.
- 20–24 Hot: stop over-selling; offer a relevant next step or meeting, require consent and valid contact route.
- 25–30 Strategic: create high-priority human handoff; do not quote construction/project pricing without approved input.

**Wave 8C — Hooks and objections**
- Implement one best-fit hook at a time for software/IP Box, relocation, residency/property, substance/offices, trademarks, and adjacent services.
- Hooks never imply automatic eligibility or guarantee savings/residency.
- Rewrite objection examples to remove multiple questions, manipulative hidden-motive assumptions, pressure, and unsupported competitor accusations.
- Stop the hook if the customer declines, stays informational, complains, or is in a sensitive state.

**Exit gate**
- Score boundary tests pass at every tier transition.
- Same conversation produces reproducible score and rationale.
- Informational customers receive helpful answers without meeting pressure; strategic leads trigger durable alerts only once.

**Verification and gap scan**
- Test sparse evidence, contradictions, customer “just researching,” no budget disclosed, and score changes.
- Auto-fix deterministic scoring/routing; do not tune thresholds only to inflate hot leads.

**Status:** `PLANNED`

---

### Phase 9 — Human handoff, routing, complaints, and existing-client verification boundary
**Goal:** Make escalations operational, acknowledged, and privacy-safe.

**Wave 9A — Departments and ownership**
- Define routing for Corporate, Tax, Real Estate, Residency, Construction, Customer Service/Complaints, and Compliance.
- Define priority, assigned role, service-level target, backup recipient, and failure escalation for each.
- Construction tenders, landowner joint ventures, major investors, sanctions/AML flags, and serious complaints get their specified priority route.

**Wave 9B — Executive handoff summary**
- Implement the Section 5.2 schema, with explicit `UNKNOWN`/`NOT PROVIDED` values rather than invented details.
- Include contact, language, primary/secondary intent, project/activity, budget, timeline, decision authority, six-dimension score/tier, motivation/concern, department, assignee, recommended next action, appointment state/time, and 3–4 sentence conversation summary.
- Apply data minimization and role-based visibility; redact credentials and sensitive banking details.

**Wave 9C — Delivery and verification states**
- Create durable handover records, notification jobs, retries, dashboard badge/count reconciliation, acknowledgment, and closure reasons.
- Test external communication only in a sandbox/test recipient until explicitly enabled.
- Existing-client account-specific data stays unavailable unless independent approved verification succeeds; self-assertion or a matching phone number alone is insufficient.

**Exit gate**
- Handover persists, reaches the correct queue, shows status, retries on failure, and is not duplicated.
- The account-information boundary fails closed; user gets a safe human-verification route.
- Complaint/AML scenarios use serious tone and do not continue sales conversation.

**Verification and gap scan**
- Simulate notification outage, wrong department, empty contact details, duplicate escalation, and missing assignee.
- Auto-fix persistence/notification/dashboard defects; unresolved owner decisions keep the affected workflow blocked.

**Status:** `PLANNED`

---

### Phase 10 — Calendar, appointments, and reminders
**Goal:** Deliver the appointment policy safely, with correct time and state.

**Wave 10A — Calendar readiness prerequisites**
- Keep booking disabled until the worker’s real OAuth credentials are configured and tested, appointment duration is approved, notice period is approved, and reminder schedule is approved.
- Keep dashboard and worker secrets separate; never place OAuth tokens in code, chat, or logs.
- Validate calendar access before displaying slots.

**Wave 10B — Booking state machine**
- Use `Europe/Nicosia`; weekdays only, 10:00–15:00.
- Reject past dates and same-day requests; enforce configured notice window.
- Offer no more than two verified slots at a time; recheck availability immediately before booking.
- Require explicit exact customer confirmation (including the chosen time) before event creation.
- Record `draft → awaiting_customer_confirmation → creating → confirmed/pending_calendar/failed/cancelled` and explain each state truthfully.
- Do not claim event/Meet/reminders exist until the corresponding APIs confirm them.

**Wave 10C — Conversation-flow separation**
- Answer informational questions during a booking draft without losing the draft; do not make the draft capture every message.
- A new topic does not silently resume an old booking. Ask a short disambiguating question only if necessary.
- If calendar fails, create visible pending/error work for an admin and tell the customer accurately.

**Exit gate**
- Timezone, boundary, notice, stale-slot, explicit-confirmation, duplicate booking, cancellation, API failure, and topic-switch tests pass.
- Test calendar access is green in the authorized runtime before activation.

**Verification and gap scan**
- Test DST/timezone conversion and date-language parsing across Arabic, English, and Greek.
- Auto-fix parser/state bugs; keep live event creation disabled during tests.

**Status:** `PLANNED`

---

### Phase 11 — Follow-up consent, reminders, opt-out, and contact policy
**Goal:** Ensure promised follow-up is consent-based and operationally honest.

**Wave 11A — Consent model**
- Persist what was consented to, when, in which language/channel, purpose, and scope (specialist contact vs automated reminder).
- “Yes” is interpreted in its immediate conversational context; unrelated consent must not be inferred.
- Provide simple stop/opt-out handling in Arabic, English, and Greek; opt-out suppresses future outreach until renewed consent.

**Wave 11B — Scheduler**
- Reuse prior policy only after validating it: hourly checks and a minimum 24-hour silence window for eligible conversations; skip self-tests, incomplete turns, final thanks/goodbyes, unresolved failures, and opted-out contacts.
- Send only if the customer’s last turn and agent response meet the configured criteria and consent scope allows it.
- No “we will message you at X time” promise unless a durable job is scheduled and confirmed.

**Exit gate**
- Consent, denial, opt-out, resubscribe, duplicate scheduling, stale job, delivery failure, and timezone tests pass.
- Follow-up cannot run for test conversations or without eligible consent.

**Verification and gap scan**
- Inspect scheduler logs and suppression reasons; test in a sandbox channel first.
- Auto-fix state-machine defects; disable the sender if suppression checks fail.

**Status:** `PLANNED`

---

### Phase 12 — Security, privacy, prompt injection, and compliance safeguards
**Goal:** Make the agent and integrations fail safely under hostile or sensitive inputs.

**Wave 12A — Input and retrieval controls**
- Treat customer-provided documents/text and retrieved content as untrusted input, not system instructions.
- Resist prompt injection in Arabic, English, Greek, mixed-script text, and quoted documents.
- Use access-scoped retrieval; never let one customer’s data or internal handoff be retrieved for another.

**Wave 12B — Output and tool controls**
- Detect prompt/system leakage, credentials, API keys, access tokens, private lead data, and internal-only score/reasoning.
- Validate every tool call against allowlisted schema, required authorization, and user intent.
- Do not ask for passwords, payment card details, or sensitive bank statements in public chat.
- Refuse help concealing beneficial ownership or evading sanctions/AML; escalate relevant cases to Compliance without debating evasion.
- Separate Source of Funds (transaction path) from Source of Wealth (long-term origin) and explain the distinction neutrally.
- Keep legal/tax replies general; request specialist review for individualized determinations. Do not remove meaningful caveats just to make a sales reply sound confident.

**Wave 12C — Privacy and retention**
- Define least-privilege access, redacted observability, data retention/deletion/correction, PII in exports, and staff roles.
- Maintain OpenRouter privacy settings and ZDR routing confirmed in Phase 0 unless owner changes them.

**Exit gate**
- Multilingual adversarial test corpus passes; secret scans have no actionable findings.
- Unauthorized tool attempts and cross-contact access are blocked and audited.
- Compliance events create visible internal work without leaking account data in public chat.

**Verification and gap scan**
- Red-team by category and language, including obfuscated/mixed-script prompts and tool-result injection.
- Automatically fix in-scope input/output validation defects; block release on any secret leak or cross-customer data exposure.

**Status:** `PLANNED`

---

### Phase 13 — Dashboard and knowledge/admin operations
**Goal:** Let authorized staff maintain REFAL’s brain safely and see what it did.

**Wave 13A — Knowledge admin**
- Add/edit/review/approve/publish/unpublish/archive knowledge; show source, language, status, version, reviewer, effective date, and expiry.
- Preview retrieval results in Arabic/English/Greek before publish.
- Add confirmation/undo for destructive operations and audit who changed a fact.
- Dynamic offers/prices/property/fees have typed forms and effective dates; they are not edited as freeform prompt text.

**Wave 13B — Operations dashboard**
- Show open handovers/alerts, complaint status, lead summary, appointment progress, calendar pending/failures, follow-up consent/state, knowledge freshness, tool health, and delivery failures.
- Reconcile badges/counts with underlying unresolved records; prevent “3 open handovers” with no actionable notification path.
- Provide filters by department, priority, status, language, and date without exposing secrets.

**Wave 13C — Human corrections**
- Staff can correct names, intent, score evidence, routing, and knowledge facts; corrections are auditable and feed evaluation fixtures after review.

**Exit gate**
- Role-based access, CRUD, publish/rollback, status counts, and correction flow are tested.
- Dashboard displays real persisted workflow state and clear pending reasons.

**Verification and gap scan**
- Test a staff member without permissions, stale browser state, partial saves, and concurrent edits.
- Auto-fix UI/API integration defects; no staff-facing control should imply a change succeeded before save confirmation.

**Status:** `PLANNED`

---

### Phase 14 — End-to-end quality, multilingual evaluation, and regression suite
**Goal:** Prove the agent works across real business journeys rather than isolated unit tests.

**Wave 14A — Test corpus**
For each key scenario, include Arabic, English, Greek, transliteration/code-switching, short/noisy input, correction, topic-switch, and adversarial variants where relevant:
- greeting and “what do you do?” identity response;
- company formation, investment company classification, €999 offer only if approved, inclusions, timeline, partner changes, dormant/closure;
- shareholder vs director; branch vs subsidiary; registered vs physical/virtual office;
- tax/VAT/IP Box/dividend questions and individualized advice boundary;
- Stripe/banking approval question;
- permanent residency categories, family relocation, schools/GESY, Non-Dom;
- property inventory, off-plan/completed, deposits, fees, ROI, city selection;
- landowner, construction tender, HNW/strategic opportunities;
- objections and competitor comparisons;
- complaint, cancellation, angry user, AML/sanctions, identity-verification request;
- booking availability, chosen-time confirmation, failure/pending, follow-up consent/opt-out;
- CRM save, greeting-not-name, memory/no-repeat-question, correction, handover delivery.

**Wave 14B — Quality dimensions**
Measure answer correctness, source support, retrieval recall, intent accuracy, language match, tone, number/question compliance, no-pressure behavior, tool correctness, memory accuracy, handoff completeness, safety, latency, and cost. Track per-language/per-domain scores and error bars; aggregate scores cannot hide a Greek or Arabic failure.

**Wave 14C — Full workflow tests**
Run from inbound message → intent → retrieval/tool → answer → DB persistence → handoff/booking/follow-up state → dashboard view. Use fake services and isolated Supabase fixtures first; use sandbox accounts for external connectors.

**Exit gate**
- All critical scenarios pass; no blocker/high severity defect.
- Thresholds are written before evaluation; no scripted fallback is counted as a model success without disclosure.
- Test results identify test type and whether they are synthetic, sandbox, or live.

**Verification and gap scan**
- Review each failure, add a regression test, auto-fix safe defects, rerun until the gate is met.
- Keep failed/unsupported cases visible; do not improve aggregate score by excluding difficult cases without owner approval.

**Status:** `PLANNED`

---

### Phase 15 — Reliability, latency, cost, observability, and load
**Goal:** Keep response quality stable at expected traffic and make failures diagnosable.

**Wave 15A — Measure actual costs and latency**
- Recalculate against current provider prices and actual token usage; historical assumptions of 100 conversations/day, six replies each, and 2,000 input/200 output tokens per reply are planning estimates, not current usage.
- Measure p50/p95 response time across WhatsApp, API, RAG, Supabase writes, tools, and model calls.
- Compare sequential vs parallel non-dependent writes; preserve transaction and idempotency correctness.

**Wave 15B — Resilience**
- Timeouts, bounded retries, circuit breakers, rate limiting, queue recovery, webhook deduplication, and provider quota handling.
- If model/provider or RAG is unavailable, use a safe short fallback or queue for human support; no fabricated answer.
- Add health checks for WhatsApp connection, Edge Function, Supabase, vector search, calendar, CRM, alerts, and scheduler.

**Wave 15C — Observability**
- Redacted trace IDs link message, retrieval, tool result, and DB outcome.
- Track fallback rate, no-result retrieval, language mismatch, handoff delivery, booking errors, opt-out suppression, provider failures, and cost.
- Do not log chain-of-thought/private reasoning; log concise decision labels and evidence IDs only.

**Exit gate**
- Load and failure tests meet agreed latency/reliability targets and do not duplicate actions.
- Alert thresholds, runbooks, and ownership exist.

**Verification and gap scan**
- Test provider rate limit, slow database, vector timeout, WhatsApp disconnect, repeated webhook, and queue restart.
- Auto-fix resilience defects; update plan with measured results and remaining capacity limits.

**Status:** `PLANNED`

---

### Phase 16 — Release readiness, controlled activation, rollback, and operations
**Goal:** Release only verified behavior and preserve a safe rollback path.

**Wave 16A — Pre-release checklist**
- All prior phase gates complete; migrations reviewed; security and leak checks pass.
- Specialist-offer persistence, investment intake routing, and retrieval-fallback leak checks pass (previous owner constraint).
- Calendar remains disabled unless OAuth, availability, appointment duration, notice window, and reminders are verified.
- Existing-client account details remain blocked unless approved independent verification is active.
- Handover recipient/department routing, complaint route, alert delivery, follow-up suppression, and dashboard state are confirmed.
- Confirm OpenRouter data policy/ZDR settings, Supabase RLS, secrets, backup/rollback, and release owner.

**Wave 16B — Staged activation**
- Start in test/staging with no real customer writes or outbound messages.
- Enable read-only FAQ/RAG first, then CRM persistence, then handoffs, then appointments/follow-ups only after each dependency is verified.
- Use a limited monitored cohort/feature flags where available; monitor language and safety metrics.

**Wave 16C — Rollback and incident handling**
- Rollback prompt/knowledge version, code release, migration, and feature flags independently where possible.
- Document how to pause WhatsApp replies, calendar creation, follow-ups, and CRM writes separately.
- Define incident owner, severity, customer correction, data correction, and post-incident regression test.

**Exit gate**
- Written release evidence, rollback rehearsal, and operational runbook exist.
- No high/blocking defect; owner approves only external production activation steps that need business authorization.

**Verification and gap scan**
- Perform final traceability audit R-01 through R-27 and source section coverage audit 1.0–5.3.
- If a requirement has no proof, reopen its implementation phase; do not claim completion based on a previous summary.

**Status:** `PLANNED`

---

### Phase 17 — Continuous improvement and knowledge maintenance
**Goal:** Keep the brain accurate after initial release.

**Wave 17A — New knowledge workflow**
1. Staff submits a fact/change with source, owner, service domain, language, effective date, and expiry/review date.
2. REFAL marks it draft and does not use it yet.
3. A qualified reviewer approves it; sensitive legal/tax/immigration claims require the designated subject expert.
4. Publish a new version to Supabase, reindex, run retrieval and multilingual smoke tests, and expose the version in audit history.
5. Roll back if tests fail; notify the knowledge owner that the update is blocked.

**Wave 17B — Feedback loop**
- Capture customer corrections, unanswered questions, retrieval misses, tool failures, complaints, and staff edits as review tasks.
- Promote reviewed fixes into test cases before knowledge/prompt updates.
- Re-evaluate each release against the full regression suite.

**Wave 17C — Scheduled review**
- Review legal/tax/immigration and dynamic business facts at their expiry date or earlier source change.
- Review dormant knowledge, duplicated chunks, model/provider changes, language quality, and cost at an agreed cadence.
- Maintain change log and phase/incident history in this roadmap.

**Exit gate**
- There is a named knowledge owner and reviewer, tested rollback, and measurable freshness status.

**Status:** `PLANNED`

---

## 6. Cross-phase reusable checklists

### 6.1 Before coding a phase
- [ ] Confirm scope, requirement IDs, source sections, and expected tests.
- [ ] Inspect existing implementation and reuse correct components.
- [ ] Confirm branch/worktree and protect secrets/customer data.
- [ ] List dependencies and decide which capabilities stay disabled while blocked.

### 6.2 Before marking a phase complete
- [ ] Update this file’s phase status/date/commit/evidence.
- [ ] Run focused unit and integration tests.
- [ ] Run relevant regression tests and multilingual cases.
- [ ] Run traceability/gap scan against mapped requirements and source sections.
- [ ] Review actual DB effects, tool results, dashboard status, and response text.
- [ ] Fix all blocker/high defects in scope and rerun tests.
- [ ] Record unresolved owner decisions/external dependencies with safe disabled state.
- [ ] Confirm no secrets, private customer details, or fabricated successes in logs/reports.
- [ ] Only then start the next phase.

### 6.3 Automatic gap/bug fix loop

```text
Implement scoped work
  → run phase tests
  → scan source-to-requirement traceability
  → inspect failures and side effects
  → add regression case for each real defect
  → fix in branch
  → rerun focused + regression tests
  → update this roadmap with evidence
  → pass gate or remain blocked
```

A repeated test pass without coverage of the requirement does not close the gap. A policy uncertainty is not a coding defect; keep the relevant response/action blocked until its owner resolves it.

---

## 7. Source coverage checklist

Track each item during the source-to-implementation audit:

- [ ] Manual 1.0 REFAL strategic identity and business outcomes.
- [ ] Manual 1.1 all ten contextual roles.
- [ ] Manual 1.2 adaptive mirroring and humor levels 0–3; prohibited contexts.
- [ ] Manual 1.3 answer formula, concision, one-question rule, anti-patterns, no false promises, no fear-selling.
- [ ] Manual 2.0 company proof points and organizational positioning (proof points require approval).
- [ ] Manual 2.1 company lifecycle, €999 package facts/inclusions (approval required), branch/subsidiary/new company, shareholder/director, changes, registered/physical office, dormant and liquidation.
- [ ] Manual 2.2 company tax, IP Box, salary/dividends, holding/trading, VAT/EORI/payroll (legal/tax approval required).
- [ ] Manual 2.3 banking and payment-gateway boundaries.
- [ ] Manual 2.4 residency categories, thresholds, dependents, Non-Dom, Source of Funds/Wealth, relocation checklist (verify current law).
- [ ] Manual 2.5 purchase journey, off-plan/completed, VAT, deposits, cities, ROI and no-guarantee boundary.
- [ ] Manual 2.6 trademarks/contracts/GDPR, landowners, joint ventures, construction tenders, priority escalation.
- [ ] Manual 3.1 every cross-sell trigger and hook.
- [ ] Manual 3.2 every objection scenario, rewritten for one question/no manipulation.
- [ ] Manual 3.3 every jurisdiction comparison, fact-checked and balanced.
- [ ] Manual 4.1 six 0–5 lead dimensions.
- [ ] Manual 4.2 all tier ranges and actions.
- [ ] Manual 4.3 buying signals and two-choice verified appointment flow.
- [ ] Manual 5.0 system/data architecture purpose.
- [ ] Manual 5.1 all CRM fields, progressive capture, no repeat questions, conversation memory.
- [ ] Manual 5.2 full executive handoff schema.
- [ ] Manual 5.3 AML/sanctions, privacy, legal/tax limits, dynamic API list.
- [ ] Plan §1 three layers: rules, RAG, dynamic tables.
- [ ] Plan §2 Arabic/English/Greek and humor calibration.
- [ ] Plan §3 leads/conversations/pricing/inventory storage; refine schema to current project.
- [ ] Plan §4 IP Box/residency/relocation hooks; verify trigger and phrasing.
- [ ] Plan §5 scoring tiers and handoff.
- [ ] Plan’s developer action sequence: reference doc, prompt, Supabase vector ingestion, and webhooks; expand into gated phases above.
- [ ] Prior REFAL constraints: OpenRouter privacy/ZDR, WhatsApp worker, Supabase/dashboard, exact booking policy, consent/opt-out, verification boundary, known bugs, and historic test claims revalidated.

---

## 8. Decision and dependency register

| ID | Decision/dependency | Safe default until resolved | Owner / status |
|---|---|---|---|
| D-01 | Official source/reviewer for Cyprus company tax, VAT, IP Box, residency, Non-Dom, government fees, and annual obligations | Keep numeric/eligibility claims blocked or clearly state no current approved figure | `OPEN` |
| D-02 | Confirmation that €999 + VAT package and inclusions are current REFALCO offer, not another provider’s offer | Do not present as REFALCO price until explicitly approved and sourced | `OPEN` |
| D-03 | Approved company-history proof points (founded/operating since, years, project/customer counts) | Omit from customer responses | `OPEN` |
| D-04 | Property inventory, deposit, annual fees, regulatory-rate, and promotion API owners | Do not guess; report unavailable or hand over | `OPEN` |
| D-05 | Independent verification method for existing clients | Fail closed; disclose no account-specific data | `OPEN` |
| D-06 | Calendar OAuth credentials, appointment duration, minimum notice, reminder schedule, admin owner | Booking remains dormant | `OPEN` |
| D-07 | Human department recipients, backup, escalation time targets, and alert channel | Persist handover as unresolved; do not promise a human has been notified | `OPEN` |
| D-08 | Consent and data-retention wording approved for WhatsApp/CRM | Minimize collection; do not run automated follow-up | `OPEN` |
| D-09 | Current model/provider and OpenRouter routing settings confirmed from runtime | Preserve current configuration; do not expose credentials | `VERIFY IN PHASE 0` |
| D-10 | Final test thresholds per language and quality dimension | Define before running Phase 14 evaluations | `OPEN` |

---

## 9. Defect and gap log

Add one row per finding. Every fixed bug gets a regression test ID and phase reference.

| Defect ID | Severity | Requirement ID | Reproduction / evidence | Root cause | Fix/owner | Regression test | Status |
|---|---|---|---|---|---|---|---|
| — | — | — | Baseline audit not yet run | — | Phase 0 | — | `OPEN` |

Severity: **Blocker** = safety/privacy/data integrity or false external action; **High** = core workflow fails or significant wrong answer; **Medium** = degraded but recoverable; **Low** = cosmetic/minor.

---

## 10. Phase status and evidence ledger

Update this table and the phase’s detailed section after every phase. Use ISO date/time and commit/hash where available.

| Phase | Status | Completed date | Commit/build | Tests and result | Gap scan/fixes | Remaining dependencies |
|---|---|---|---|---|---|---|
| 0 Baseline audit | `PLANNED` | — | — | — | — | — |
| 1 Requirements | `PLANNED` | — | — | — | — | — |
| 2 Knowledge governance | `PLANNED` | — | — | — | — | D-01 to D-03 |
| 3 Data/security | `PLANNED` | — | — | — | — | — |
| 4 RAG | `PLANNED` | — | — | — | — | — |
| 5 Agent/router | `PLANNED` | — | — | — | — | — |
| 6 Tools/dynamic data | `PLANNED` | — | — | — | — | D-04 |
| 7 Memory/CRM | `PLANNED` | — | — | — | — | D-08 |
| 8 Qualification/sales | `PLANNED` | — | — | — | — | D-10 |
| 9 Handoffs/compliance | `PLANNED` | — | — | — | — | D-05, D-07 |
| 10 Calendar | `PLANNED` | — | — | — | — | D-06 |
| 11 Follow-up | `PLANNED` | — | — | — | — | D-08 |
| 12 Security | `PLANNED` | — | — | — | — | — |
| 13 Dashboard/admin | `PLANNED` | — | — | — | — | — |
| 14 E2E quality | `PLANNED` | — | — | — | — | D-10 |
| 15 Reliability | `PLANNED` | — | — | — | — | — |
| 16 Release | `PLANNED` | — | — | — | — | Prior release gates |
| 17 Continuous improvement | `PLANNED` | — | — | — | — | Named owners |

### Phase closeout note template

```text
Phase: [number/name]
Status: [IN PROGRESS / COMPLETE / BLOCKED]
Date and commit:
Requirements covered:
Files/schema/services changed:
Tests run (exact command and result):
End-to-end evidence:
Gap scan findings:
Automatic fixes made:
Regression tests added:
Remaining blockers/owner decisions:
Why the next phase may start:
```

---

## 11. Recommended implementation order at a glance

1. Audit the current system and reproduce known failures.
2. Normalize every rule and fact; resolve conflicts and block unverified claims.
3. Secure and document schemas, memory, audit, and workflow state.
4. Build knowledge governance and multilingual retrieval.
5. Implement answer/routing behavior.
6. Connect dynamic data and verified tools.
7. Complete memory, CRM, lead scoring, and non-coercive hooks.
8. Complete handoffs, complaints, identity boundary, calendar, and consented follow-up.
9. Harden privacy and multilingual prompt-injection defenses.
10. Finish authorized dashboard operations, full E2E tests, reliability, and staged release.
11. Keep content and tests current with a controlled publish-and-rollback process.

**The plan is complete as a roadmap, not as an implementation claim.** REFAL should be described as fully ready only after the status ledger and evidence demonstrate every gate, and all unresolved external decisions are either resolved or remain safely disabled.
