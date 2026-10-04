# REFAL agent deep conversation review and remediation plan

Updated: 2026-10-04  
Scope: synthetic WhatsApp conversations, current approved RAG retrieval, customer-facing language and sales flow, persistence/consent boundaries, and dashboard/Edge prompt alignment.

## Evidence and limits

- A response-aware baseline completed **3,000 conversations**, **24,000 synthetic customer turns**, 1,000 per locale (English, Arabic, Greek), across 51 scenario families. Five later customer turns per conversation were model-simulated from prior agent replies; scripted fallback was used 38 times after simulator errors.
- Baseline summary: 13,249 agent model calls, 2,049 rejected drafts/model errors (15.5%), 235 deterministic turns, 15,533 approved-knowledge retrieval calls, zero retrieval errors, zero conversation runtime errors, one built-in response finding, and about $3.81 total provider-reported model cost (agent + simulator). Elapsed time: 11,552 seconds.
- Model draft rejection breakdown: 1,687 restricted legal/financial drafts, 176 wrong-language drafts, 81 unsolicited price/package claims, 65 unfinished sentences, 30 overlong replies, 8 multiple-question replies, 1 internal-reasoning draft, and 1 too-many-sentences draft. These were rejected before delivery; a rejection is not necessarily a customer-visible error.
- Separate transcript signals: 579 generic fallback turns, including 128 conversations with repeated fallback; 10 emotional-statements-as-name responses; 31 current-turn language mismatches; 3,071 recap requests without the auditor’s explicit recap markers; 81 contact/meeting offer phrases; and 77 matches for the contact-commitment detector. Contact detector samples include permission-seeking “I can arrange … if you’d like” language, so its count overstates unconditional commitments and is a review signal, not a confirmed violation count.
- No synthetic sensitive test value was echoed in a response. The benchmark recorded zero external writes and zero appointment writes; it used live, read-only approved-knowledge search. Contact/workflow persistence, WhatsApp delivery, calendar writes, and notifications were mocked. Its 2,080 handover records are in-memory simulated workflow state, not real staff/customer messages.
- The built-in `findingTurns` score is not a helpfulness score. The response-aware test corpus shares templates and the same configured model family for the agent and simulator. It does not establish real-customer conversion, trust, or production reliability.
- Detailed evidence: `reports/client-conversation-benchmark/2026-10-04-deep-3000-response-aware/summary.json`, `conversations.jsonl`, and `quality-audit.json`; prior 300-case human/team review at `reports/client-conversation-benchmark/2026-10-04-deep-300-verified/`.

## External conversation-design review

- Google's Dialogflow CX guidance recommends task-specific responses and questions, acknowledgment of information already provided, and explicit handling for no-match and webhook failures. Its playbook guidance recommends grounding answers in tool results and saying the agent does not know when required data is absent ([agent design](https://docs.cloud.google.com/dialogflow/cx/docs/concept/agent-design), [playbook best practices](https://docs.cloud.google.com/dialogflow/cx/docs/concept/playbook/best-practices)).
- HubSpot's sales discovery guidance emphasizes listening to the buyer, not over-explaining, and shaping follow-up questions from what the prospect actually said ([discovery call mistakes](https://blog.hubspot.com/sales/discovery-call-mistakes), [discovery questions](https://blog.hubspot.com/sales/discovery-call-questions)). This supports progressive qualification but does not override REFAL's approved-knowledge, privacy, consent, or no-pressure rules.
- Applied here: answer the current question first, use only the next useful follow-up, preserve corrections and opt-outs, and fail transparently when retrieval/provider calls fail. The generic suggestion to end every turn with a question is intentionally not applied because it conflicts with the product requirement to avoid unnecessary nudges.

## Priority 0 — protect trust and preserve useful answers

### 1. Keep safe fallback answers when model drafts are rejected

**Evidence:** 2,049/13,249 agent drafts failed generation/output checks. The prior 300-case audit found that replacing a relevant deterministic evidence answer with a generic fallback was a recurring customer-visible failure.

**Change:** Keep the prevalidated approved-evidence answer (or a specific “not confirmed” answer) when model drafting fails. Do not replace it with a broad generic answer. Track each draft rejection reason independently from answer quality.

**Status:** Implemented in WhatsApp and benchmark paths; targeted regressions included. Compare the post-fix 300-case fallback count before closing.

### 2. Make recap requests deterministic and evidence-bounded

**Evidence:** The 3,000-case baseline produced 579 generic fallback turns and 128 repeated-fallback conversations. A built-in finding showed a recap adding an unapproved “may be regulated” claim and approval timelines. The baseline also repeatedly missed explicit summary requests.

**Change:** Summarize only recent customer-stated facts, in the requested language; omit privacy-risk and prompt-injection turns; do not add legal/regulatory conclusions or timelines. Add company facts only from relevant, approved evidence and keep citations in internal turn metadata. Normalize punctuation in quoted questions so response-policy checks do not discard a valid recap.

**Status:** Implemented locally with English, Syrian Arabic, and Greek regressions; citation provenance is carried into turn metadata. The 300-case post-fix sample is the closure check.

### 3. Make follow-up consent explicit and truthful

**Evidence:** The baseline had 81 offer-like phrases and 77 contact-commitment detector matches. Manual review shows the detector conflates permission-seeking offers with promises. The prior audit also found unsupported “they will contact you” language.

**Change:** Allow concise permission questions when individual review is useful, but do not introduce meetings/contact during ordinary information gathering. Require affirmative, purpose-bound consent linked to an offer turn before outbound follow-up. Never claim a person will contact the client until a system-confirmed action exists. Do not treat an internal priority/handover as customer contact consent.

**Status:** Prompt/rules aligned across WhatsApp, dashboard, Edge, and canonical rules; response validators distinguish a conditional English offer from a future-contact promise; Edge persistence tests cover source-turn consent. Refine the auditor to report confirmed future promises separately from optional offers.

## Priority 1 — improve understanding and conversation flow

### 4. Ask progressively and stop unnecessary sales pushes

**Evidence:** The baseline includes premature specialist offers after ordinary company-formation facts. The customer explicitly wanted information first and control over the next step.

**Change:** Answer first, ask one useful next question, do not request a company name before the customer chooses name reservation, and offer a specialist only when the customer asks or the case needs individual review. Keep helping after a decline and do not repeat the offer.

**Status:** WhatsApp/dashboard/Edge prompts and canonical rules updated; verify examples in the post-fix sample.

### 5. Route complaints and existing clients without misreading their words

**Evidence:** Prior 300-case review found “my case” triggered account verification for generic questions and “I am still upset” was captured as a name. The 3,000-case baseline repeated 10 emotional-name greetings.

**Change:** Use explicit existing-client support/status markers rather than broad “my case” phrases; do not let stale verification state block unrelated help. Treat emotional statements as complaint context, never a name.

**Status:** Intent/router/name parsing and complaint behavior fixed with EN/AR/EL tests.

### 6. Respect explicit language switches

**Evidence:** The 3,000-case baseline had 31 replies that did not follow the language of the current customer turn, including explicit English-to-Greek and English-to-Arabic requests that received a generic English fallback.

**Change:** Treat explicit “continue in Greek/Arabic/English” requests as instructions for the response language. Acknowledge the switch directly without a knowledge lookup, unless safety/privacy rules take priority.

**Status:** Implemented in the shared language detector and WhatsApp route; all prompt surfaces now say to honor explicit requested reply language. Focused tests pass.

### 7. Handle credential refusal statements cleanly

**Evidence:** Prior review showed a customer saying “I won’t share a password” was treated like credential disclosure, and surrounding prose was redacted.

**Change:** Distinguish refusal-to-share from disclosure. Still redact and secure-route actual labeled credentials, payment data, identity numbers, and account secrets.

**Status:** Safety classification and redaction regressions pass in EN/AR/EL.

## Priority 1 — improve verification quality

### 8. Keep distinct quality dimensions instead of one pass/fail number

**Evidence:** The baseline’s built-in check reported one finding, while transcript checks found fallback repetition, missed recaps, emotional-name greetings, language mismatches, and offer wording. “No runtime error” was not “good sales handling.”

**Change:** Keep separate metrics for model draft rejection, customer-visible fallback, answer language, recap fidelity, correction recovery, one-question behavior, consent wording, sensitive-value echoes, RAG errors/relevance, and mocked side effects. Human-review a stratified set of flagged and clean examples in each language before calling a metric reliable.

**Status:** `scripts/auditDeepConversationBenchmark.js` creates trace-linked signals and samples. Its current phrase-based offer/recap detectors are explicitly heuristic and need human calibration; do not treat their counts as confirmed violations.

### 9. Measure grounding and retrieval relevance, not only RAG uptime

**Evidence:** The baseline made 15,533 RAG calls without retrieval errors, but zero retrieval errors does not prove that each returned chunk supports its answer. Existing retrieval traces record source/revision/chunk/rank/freshness, not answer-level groundedness judgments.

**Change:** Build a reviewed query-to-chunk set from the 51 scenario families; score recall/relevance and claim support per answer. Preserve source approval, document revision/expiry, and citations in the internal audit record. Keep owner/review labels out of customer-facing prose.

**Status:** RAG approval/freshness/relevance gates exist; expand human-verified retrieval evaluation separately from the conversation roleplay score.

## Priority 2 — runtime rollout and monitoring

1. Keep WhatsApp, dashboard, and Supabase Edge prompts aligned; retain the canonical rules file as the source of truth.
2. Alert on rising model-rejection rates by rejection reason and locale; confirm the safe deterministic response was delivered and recorded.
3. Monitor repeated fallback, language mismatch, unwanted specialist offers, complaints, and recap requests from a privacy-reviewed sample of real conversations before making conversion claims.
4. Validate real WhatsApp delivery, staff notification, calendar behavior, Supabase RLS/service roles, and external follow-up consent separately; none was exercised by the synthetic run.
5. Re-run focused EN/AR/EL tests after prompt changes and a balanced response-aware sample after release; do not use elapsed/cost/provider success as a substitute for client experience.

## Completion record

Post-fix sample, final test totals, Edge version, worker/UI restart status, and browser review of the system map are recorded after those steps complete.

### Third-pass correction — 2026-10-04

- A fresh synthetic run was stopped after 37 conversations when D025 volunteered former LAMAR service history in response to a general Greeklish company-setup question, and treated `Poso kostizei?` as if no approved price had been requested. The saved artifact is `reports/client-conversation-benchmark/2026-10-04-partial-legacy-brand-37/`; it is excluded from final totals.
- The customer-facing model prompt now keeps legacy-brand history out unless the customer asked about it in the current or recent customer messages. A response gate rejects unrequested legacy/former-brand text. The rule is aligned across WhatsApp, dashboard, Edge and canonical instructions.
- Greeklish price phrases such as `Poso kostizei?` now map to the pricing intent so current approved price evidence can be used. Focused regression tests cover intent, response gating and prompt alignment; rerun the full suites and a clean benchmark before reporting the remediation as verified.
- Independent audits confirmed benchmark contacts/workflow state is in-memory, while approved knowledge search is read-only. Audit traces remain synthetic; no real WhatsApp conversation data was used.
- Review also found that “I’ll ask if I need anything” did not persist as a no-proactive-contact preference, a question about what the published price represented was being treated as unknown, and an exact echo of the prior assistant message fell into a legal-status fallback. These now have Greeklish-aware persistence, an explicit package-versus-case/VAT instruction aligned across prompts, and an exact recent-assistant-echo acknowledgement with regressions.
- The subsequent 38-case partial at `reports/client-conversation-benchmark/2026-10-04-partial-price-echo-38/` is also excluded. It was stopped before these latest corrections and cannot validate them.
- A 63-case partial at `reports/client-conversation-benchmark/2026-10-04-partial-action-promise-63/` found that model prose could promise “you will be notified” or say a specialist request had been made even when the customer withheld contact permission and no handover was recorded. The WhatsApp and Edge output guards now reject unbacked action claims in English, Arabic and Greek, with targeted tests. This partial is excluded from final totals.
- A later 39-case partial, `reports/client-conversation-benchmark/2026-10-04-partial-price-followup-39/`, confirmed that action promises are now blocked and surfaced a Greeklish intent gap: questions about what a numeric package includes were not tagged as pricing, so approved evidence was stripped from generation and generic fallbacks repeated. Greeklish cost, price, amount-in-package, and inclusion wording is now included in pricing classification. Prompt rules also prohibit inferring package inclusion from adjacent service descriptions. Recheck in the next clean run.

### Completion record — 2026-10-04

- **Post-fix response-aware sample:** `reports/client-conversation-benchmark/2026-10-04-postfix-300-response-aware-final/`; 300 conversations (100 per EN/AR/EL), 2,400 customer turns, 51 scenario families. The run recorded 1,135 agent calls, 166 rejected/error drafts, 1,616 read-only RAG calls, 0 RAG errors, 0 conversation errors, and 1 built-in response-policy finding. Mocked integrations remained non-writing. Reported total model cost was about $0.188; run time was 1,111 seconds.
- **Finding disposition:** The sole finding was an Arabic local recap quoting a customer's licensing question; the policy checker mistook quoted customer text for a REFAL claim. `src/conversationRecap.js` now paraphrases claim-sensitive questions without giving an answer and preserves a clear no-contact preference. The exact transcript is covered by a regression test; the recap validates cleanly. The benchmark itself predates this last targeted fix, so its count remains one.
- **Post-fix heuristic audit:** 54 generic-fallback phrase flags (15 conversations with repeated flags) and 44 recap phrase flags. These are review signals, not confirmed failures. No language-mismatch, emotional-name, contact-promise, or sensitive-echo signal was found in this 300-case sample. The baseline heuristic counts and limitations remain as documented above.
- **Verification:** Root suite 247/247 passed; dashboard suite 69/69 passed and production build succeeded; Edge policy/persistence suite 5/5 passed. `docs/refal-agent-system-map.html` was opened at `http://127.0.0.1:8788/refal-agent-system-map.html`; browser console had zero errors.
- **Deployment state:** Supabase Edge Function version 37 is active with JWT verification. The final WhatsApp worker restart and dashboard process restart commands were rejected by automatic command review. The dashboard endpoint returned HTTP 200, but the running worker may not have the newest in-memory prompt/code. Do not describe the runtime as fully refreshed until restarted and checked.

## Second-pass audit — 2026-10-04

### Evidence and method corrections

- The completed 3,000-conversation run is synthetic, not real-client evidence. Its first three turns are scripted; the remaining five were model-roleplayed with a prompt that forced planned concerns to remain present, and the customer model matched the agent model. Treat it as broad scenario coverage, not a realistic customer-satisfaction result.
- A new full post-fix run was started, then stopped at 30/3,000 after reviewers found high-priority gaps and the roleplay harness limitations. Its partial artifact is `reports/client-conversation-benchmark/2026-10-04-postfix-3000-full-audit/`; it is not a result report.
- The completed 300-case sample is synthetic and balanced (100/language, 51 families) but is too small for reliability claims. Independent transcript review confirmed real customer-visible failures below.

### Newly confirmed findings and remediation state

1. **Consent and escalation (P0):** restricted-topic, complaint, and existing-client routes created formal handovers without a consent source turn; restricted fallbacks also implied staff follow-up. Changed to preserve internal complaint/priority/verification records while consent-gating customer handovers, suppress optional offers after persisted denial/revocation, and use neutral EN/AR/EL uncertainty replies. Focused tests passed; final full suite pending.
2. **Refusal of credentials (P1):** plural credential refusal wording (e.g. “I won’t send passwords or credentials”) was mistaken for disclosure. Expanded multilingual non-disclosure parsing and added regression coverage. Focused tests passed.
3. **Safe request mixed with secrets (P1):** a credential-bearing sentence could suppress an unrelated company-setup question. Added safe-clause extraction and routing; WhatsApp RAG/model calls use only the non-sensitive remainder, history remains redacted, and a localized privacy reminder is appended. Focused routing/redaction tests passed; full bot-path validation pending.
4. **Conversation recap (P1):** the prior recap echoed only the last two statements. It now synthesizes the overall goal/activity, user boundaries, unresolved regulated/account/timing questions, and avoids claims about actions that are not confirmed in recorded state. English/Arabic/Greek and long-context privacy tests pass.
5. **Handover scope (P1):** trace `D050-review_channel-ar` showed the customer narrowing disclosure to a project summary, which received a generic greeting. Data minimization and scope acknowledgement are under implementation; verify the resulting handover payload and consent source turn.
6. **Benchmark fidelity (P1):** roleplay harness now uses deterministic case seeds, varied localized personas, and conditional response cues; it should not repeat concerns the agent already answered. It can simulate correction, refusal, pressure, and related topic shifts without forced injection. Harness tests passed 9/9. A separately configured customer model is supported; current runs still use synthetic roleplay.
7. **Stale specialist consent (P0):** an explicit “yes” could accept an expired offer, and persisted revocation could be bypassed if a stale offer remained in retained history. Tracked offers now expire after 24 hours, and a stored denial/revocation blocks acceptance unless the offer was made after that state. A fresh direct request remains valid. Regression tests cover both cases.
8. **Legacy recap credential exposure (P0):** a recap could echo a credential from older history when the turn lacked privacy metadata. Recap candidates are now checked for privacy risks directly before summarization; a legacy-history regression covers plural credential labels.
9. **Benchmark switch-language/fallback attribution:** roleplay now follows an explicit customer language switch when validating later synthetic replies. Each turn records whether it was model-generated or a scripted fallback, with only a bounded failure category (never raw provider error text). Targeted harness tests pass 11/11.

### Remaining verification before closing this plan

- Finish handover scope implementation and verify excluded profile fields at persistence boundaries.
- Run `npm test`, dashboard tests/build, and Edge policy/persistence tests against the final worktree.
- Runs started before final roleplay-harness corrections were stopped at 53, 192, and 97 cases; `reports/client-conversation-benchmark/2026-10-04-partial-postfix-53/`, `reports/client-conversation-benchmark/2026-10-04-partial-audited-192/`, and `reports/client-conversation-benchmark/2026-10-04-partial-audit-97/` are partial evidence, not result reports. The harness now preserves high-confidence Arabic/Greek signals through Arabizi/Greeklish turns, supports later explicit language switches, and covers D022/D073/D124, D023/D125/D074, D024/D075/D126, and D025/D076/D127. Targeted harness tests pass 15/15 and the full root suite passes 271/271.
- A fourth run stopped at 74 cases (`reports/client-conversation-benchmark/2026-10-04-partial-recap-74/`) after D066 produced a recap that quoted the customer in first person, clipped an approved-information sentence and omitted the customer's speaker boundary. The exact recap issue is under fix; this partial trace is not a final result.
- D066 recap regression is now fixed: “I can only speak for myself,” joint ownership, limited property-detail sharing, no agreed project/representative, and unconfirmed REFALCO participation are summarized as customer facts. Generic “what remains unconfirmed?” recaps no longer append approved company evidence or raw first-person questions. Exact replay is 434 characters with no citations and validates without policy findings. Root suite passes 272/272.
- A 70-case run is partial at `reports/client-conversation-benchmark/2026-10-04-partial-audit-recap-locale-70/`. It exposed two additional confirmed issues: action-status recap could quote a credential refusal/contact question in first person, and an Arabic existing-client safe-channel question received an English verification fallback.
- **D063 recap fix:** Action-status recaps now summarize complaint, case-reference sufficiency, written-only/no-sharing/credential boundaries without quoting raw questions or asserting unverified actions. EN/AR/EL regressions pass; D063 replay is 436 characters and response-policy valid.
- **D064 language/security fix:** Arabic requests for safe profile-update channels now receive concise localized guidance without asking for account identifiers, clearing the verification state, or creating a handover. The ordinary Arabic existing-client verification prompt is also localized. Focused tests pass 3/3.
- Latest root suite passes 274/274 before the newest targeted harness/fallback changes. Those targeted suites now pass 16/16.
- A 115-case synthetic run was stopped after D075 reproduced Arabizi locale validation fallbacks and customer-facing issues. It is preserved at `reports/client-conversation-benchmark/2026-10-04-partial-language-fallback-115/`; it is not a full-run result. A second post-harness run stopped at 22/3,000 is preserved at `reports/client-conversation-benchmark/2026-10-04-partial-pre-product-fixes-22/`.
- D075 harness and product fixes: Arabic Arabizi markers now detect `shoghlha`, `mish`, `t2aked`, and fee questions; transliteration/Greeklish simulation validates against established locale unless explicitly switched. Regression tests cover exact transcript phrases.
- No-pressure correction: an explicit “do not pressure me to book or send contact details” persists both denied follow-up consent and a contact/booking preference in profile context. Future turns answer normally but avoid proactive booking, calls, contact capture, and specialist offers; a direct customer request remains valid. The timing and not-ready fallbacks in EN/AR/EL no longer push for action.
- Case-priority correction: “specific result for my case” no longer marks a new prospect as an existing client unless the message describes an existing account/case or status.
- Evidence/recap correction: recap recognizes the Arabizi company goal/activity, preserves cross-language contact and commitment boundaries, distinguishes the current approved published price from case applicability, and includes a source citation. Pricing evidence selection now picks the approved fresh price chunk even when a general chunk ranks first.
- A subsequent 40-case run exposed the parallel production gap for Greeklish messages. It is preserved at `reports/client-conversation-benchmark/2026-10-04-partial-greeklish-detection-40/` and excluded from result metrics.
- Greeklish correction: the shared production language detector now recognizes distinctive Greeklish business and conversational terms (including company setup, appointments, and price questions) while English-language regressions remain green. This also lets roleplay outputs in Greeklish validate as Greek.
- A 75-case run is preserved at `reports/client-conversation-benchmark/2026-10-04-partial-switch-validator-75/`. D025 showed a valid English current-turn switch in a scenario permitting language changes; the simulator validator incorrectly rejected it and fell back to the English scripted cue.
- Harness correction: scenarios marked `allowLanguageSwitch` now accept valid Arabic, English, or Greek roleplay turns. Transliteration identifies the current turn but no longer acts as a permanent language lock; explicit language requests remain locked until an explicit switch. Focused roleplay/language tests pass 15/15.
- Root `npm test` last passed 279/279 before these small harness-only changes. The next clean 3,000-case synthetic run will use a fresh output directory at `reports/client-conversation-benchmark/2026-10-04-final-deep-3000/`.
- Inspect true-positive fallback/recovery examples and a stratified clean/flagged transcript sample across EN/AR/EL. Add RAG answer-grounding checks and error injection beyond runtime success counters.
- Update and reopen `docs/refal-agent-system-map.html` with completed post-fix evidence; keep synthetic-vs-real limitations explicit.

## Current verification addendum — 2026-10-04

- **Existing broad baseline:** `reports/client-conversation-benchmark/2026-10-04-deep-3000-response-aware/` contains a completed 3,000-conversation, 51-family synthetic baseline. The 3,000 count is valid as baseline coverage, but the run recorded 2,049 agent model errors across 13,249 model calls and 38 scripted customer-simulator fallbacks. It is not a clean pass and does not represent real customer data.
- **Earlier post-fix sample:** `reports/client-conversation-benchmark/2026-10-04-postfix-300-response-aware-final/` contains 300 synthetic conversations, but its finish time precedes the latest recap, router, response-policy, and benchmark-runner changes. Treat it as an earlier sample, not verification of the current worktree.
- **Latest full-depth attempt:** `reports/client-conversation-benchmark/2026-10-04-final-deep-3000/partial-run-status.json` records `stopped_partial`: 295 of 3,000 requested, with 136 fully operational adaptive conversations. A one-token provider probe on 2026-10-04 returned HTTP 403. The clean post-fix 3,000 run remains pending restored provider quota; do not count fallback/degraded turns as clean evidence.
- **Provider availability recheck:** the latest one-token probe still returns HTTP 403, and no local inference API is listening on the standard Ollama/LM Studio ports 11434 or 1234. No alternative provider key is configured for the benchmark path.
- **Current code verification:** root `npm test` passed 303/303, dashboard `npm test` passed 69/69, and `npm run build` in `dashboard/` succeeded. Root tests include the Edge response-policy and handover-persistence suites. The current handover scope tests verify inquiry-only payloads and exclude unrelated stored company, email, position, country, qualification, budget, authority, and intake data.
- **Changes since the latest partial trace:** personal recap routing now distinguishes conversation recaps from service-summary and “to recap, is that right?” questions; action recaps report an open specialist request only when purpose-bound consent and persisted open handover state are present. Benchmark failures now stop new work and are labeled partial/degraded; agent operational errors do not count as fully adaptive.
- **System map:** `docs/refal-agent-system-map.html` was corrected to report the completed baseline, older 300-case sample, latest quota-stopped partial run, current test results, and outstanding work. It remains an interim status page; refresh it again after the current-tree 3,000 run, review, implementation, and final verification.
- **Trace error privacy:** benchmark traces now store provider failures as status/category codes instead of raw external error text. The latest partial trace had 443 provider-management URLs in failure events; those URLs have been redacted and all 295 JSONL rows were parsed successfully after the edit.
- **Still open:** restore provider quota and complete a current-tree 3,000-conversation adaptive run; review that complete run with independent specialists and implement any new findings; inspect stratified clean/flagged turns and grounded-answer quality; verify runtime rollout separately. Synthetic traces and mocked side effects cannot prove real WhatsApp delivery or production database/calendar behavior.
