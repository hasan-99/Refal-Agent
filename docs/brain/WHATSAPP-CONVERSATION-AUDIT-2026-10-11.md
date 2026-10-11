# REFAL WhatsApp conversation audit — 11 October 2026

## Scope and result

This report records the actual Playwright conversation with the WhatsApp contact labelled **Rafa**, the bot identified by the owner. Testing stopped at the owner's request after the banking question. No further messages were sent. Account names, phone numbers, private contact identifiers, credentials and hidden model reasoning are excluded.

**Six turns were tested: one greeting and five substantive questions. Three of the five substantive questions received the generic retry fallback (60%).** The services follow-up received a partial answer; the banking answer was useful and explicitly avoided a guarantee. The greeting failed the requested company identification check.

The workflow remains unreliable. This audit does not establish completion of the broader repair goal, despite the earlier goal record being marked complete. A successful direct-runtime smoke test did not establish that the complete WhatsApp conversation worked.

Repository HEAD at inspection: `321ed3ea685c27fbf4e4025cdeed1151bffced77`.

## Exact conversation

### 0. Greeting — identity failure

**Client:** مرحبا

**Rafa:** أهلاً! أنا مساعدك الرقمي. كيف فيني ساعدك؟

Natural Arabic, but neither REFAL nor Refalco Group was named. Company identity is permitted without knowledge evidence under the repository constitution.

### 1. Services overview — failed

**Client:** مرحبا، ممكن أعرف شو بتقدّموا خدمات بقبرص؟

**Rafa:** ما فيني أكّد هالشي هلأ. جرّب مرة تانية لاحقًا.

No services were explained. This was a generation/validation failure, not proof that the knowledge base had no service information.

### 2. Additional services — partial

**Client:** هدول كل خدماتكن، ولا في مجالات تانية كمان؟

**Rafa:** المجالات المؤكدة هي تأسيس الشركات وهيكلتها، ملفات الضريبة والمحاسبة، الملفات الاستثمارية، والعقار. كمان شغلنا متعدد القطاعات، بس ما عندي حالياً معلومات معتمدة بتحدد مجالات إضافية بعينها.

This gives a readable overview and does not claim exhaustiveness. However, the statement about no approved information identifying additional fields needs scrutiny: approved documents concerning trademarks, shareholder agreements, contracts, GDPR, banking and relocation existed during inspection. Their existence alone does not establish that every item is a company service or that the relevant passages reached this answer model. The narrow overview is observable; the precise cause of its coverage gap is not yet proven.

### 3. Company formation without investment/property — failed

**Client:** طيب أنا بدي أسّس شركة بس، مو مهتم بالاستثمار أو العقارات. بتساعدوني؟

**Rafa:** ما فيني أكّد هالشي هلأ. جرّب مرة تانية لاحقًا.

The bot did not answer a basic service-scope question or acknowledge the client's preference. An approved Arabic company-formation package document existed.

### 4. Support after formation — failed

**Client:** وشو بتقدروا تساعدوني فيه بعد ما تتأسس؟

**Rafa:** ما فيني أكّد هالشي هلأ. جرّب مرة تانية لاحقًا.

The contextual follow-up failed. Approved company life-cycle and related operating-support documents existed, but stored content does not prove retrieval coverage.

### 5. Banking assistance and guarantee — useful

**Client:** وبالنسبة للحساب البنكي، كيف بتساعدوني؟ وهل فتحه مضمون؟

**Rafa:** منساعدكم بتجهيز ملف الشركة والمستندات المطلوبة، وبنوجّه الطلب للجهة المالية المناسبة، سواء بنك أو مؤسسة نقود إلكترونية أو مزوّد خدمات دفع. بس فتح الحساب مش مضمون، القرار النهائي للجهة نفسها بعد مراجعة الامتثال، وبيعتمد على نشاط الشركة وإقامتك وسياسة الجهة وقت التقديم.

Answers both parts, explains assistance, preserves the financial institution's decision and avoids promising approval. This is a positive conversational result. A complete claim-by-claim comparison with the evidence passed on this turn was not completed before stopping.

## Live failure trace

The timestamps below are UTC, from `rafa_events` in project `anhharmjtmqndhzenicb`. The browser conversation occurred in Cyprus local time, UTC+3.

### Services overview: all four steps

| Step | Recorded events | Finding |
| --- | --- | --- |
| 1 | Model call 13:14:37.781; knowledge tool 13:14:39.350 | Search status `found`, resultCount 16, accumulated evidenceCount 6, evidenceChars 5,403. Query: ما الخدمات التي تقدمها Refalco Group في قبرص؟ نظرة عامة على الخدمات ومجالات العمل |
| 2 | Model call 13:14:42.101; knowledge tool 13:14:43.914 | A reformulated overview search returned `no_new_evidence`, `NO_NEW_RELEVANT_SECTIONS`; accumulated evidence remained 6 items / 5,403 characters. |
| 3 | Model call 13:14:47.041; rejection 13:14:47.118 | A `respond` draft was rejected. Detailed validationReasons persisted as an empty array. |
| 4 | Rejection 13:14:50.507; model-call event 13:14:50.574 | Final `respond` draft rejected. Event persistence order is not necessarily execution order. |
| End | 13:14:51.168 | `agent_turn_not_clean`: outcome `response_rejected`, stepCount 4, reasonCode `prohibited_claim`. Customer received generic fallback. |

Four model-call durations were 2,362, 1,964, 2,494 and 2,736 ms. The trace proves searches and rejected drafts, rather than four repeated tool calls. It does **not** preserve the rejected draft text or the specific claim that triggered rejection. A policy false positive is a hypothesis, not an established cause.

### Other failed turns

- **Company-only formation:** search at 13:17:49.583; answer rejection at step 2; another search at step 3 returned `NO_NEW_RELEVANT_SECTIONS`; final rejection at step 4. Termination at 13:18:02.090: `response_rejected` / `prohibited_claim`.
- **Post-formation support:** search at 13:18:55.033; rejection at step 2; step-3 search returned `NO_NEW_RELEVANT_SECTIONS`; final rejection at step 4. Termination at 13:19:08.346: `response_rejected` / `prohibited_claim`.

These are independent observed failures of substantive questions. Merely increasing the step limit would not address the rejected claims, inadequate coverage or lost diagnostics.

## Five confirmed implementation/workflow gaps

### G1 — Canned greeting bypasses company identity

`src/messageRouter.js:893` handles GREETING or AGENT_IDENTITY with literal language-specific answers. Its Arabic string exactly matches the observed greeting. `src/agentLiveAnswerTurn.js:34` prepares/classifies the input and calls `routeMessageResult` before the agent workflow. Thus a prompt containing company identity cannot repair this short-circuited response.

Conversational regex classification remains in `src/intent.js`, including identity and greeting rules; a literal greeting list also remains in `src/messageRouter.js:1153`. Earlier removal of conversational mechanisms from `agentRuntime.js` did not remove this preflight layer.

### G2 — Three ordinary questions terminate after rejected drafts

The live events above prove `prohibited_claim` rejection as the final failure point. The responsible validation chain includes `responsePolicy.js`, `refalcoAnswer.js` and `claimPolicy.js`, invoked from `agentLoop.js`. Without the exact rejected draft and specific code, we cannot establish whether the model invented something, retrieval failed to support its wording, or a deterministic validator misclassified a safe claim.

### G3 — Edge sanitizer deletes specific rejection codes

`supabase/functions/rafa-agent-api/auditEventPrivacy.mjs:32` applies the same UUID-shaped-value filter to array keys ending in `Ids` **or `Reasons`**. Normal codes such as `prohibited_claim` do not match that filter. The live rejection events have `validationReasons: []` despite a final rejection reason being recorded.

The Edge allowlist also omits `knowledgeStatus` and `toolsUsed`, although the Node composition emits them. Node and Edge diagnostic contracts differ.

### G4 — Worker replaces detailed model diagnostics

`src/agentLiveAnswerTurn.js` supplies a detailed model measurement callback, then spreads `agentOptions`. `src/bot.js:642` passes an overriding callback that retains only `durationMs`. Live `agent_model_call` events consequently lack step, decision outcome, evidence IDs and provider-error detail.

There is also a reader-contract pitfall: Edge `listEvents` in `index.ts:2083` flattens stored `fields` into each returned event. A client reading `event.fields` from that API sees no diagnostics even when the database contains them. Earlier inspection of empty `event.fields` must not be interpreted as proof that all historical diagnostics were erased.

### G5 — Additional searches consume steps without adding retained evidence

Each of the three failed substantive turns had a second search reported as `NO_NEW_RELEVANT_SECTIONS`. The loop then attempted a final answer, which still failed validation. Search reformulation did not repair these turns. The available trace does not prove whether retrieval returned no new relevant sections or the accumulated evidence budget excluded otherwise useful new sections.

## Retrieval evidence and remaining uncertainty

Approved, enabled documents were verified for Arabic company formation (`214930bd-0187-4f3c-b305-a9695918f047`), company life cycle (`0f24483a-8e25-452e-b886-8e6719ea9be8`), banking (`a285916f-303e-4a94-af02-5eafe598cd63`), partner changes (`572063c2-9709-4e1b-96eb-9e12156d50f6`), legal/commercial support (`eb79f884-9aa9-4d3c-8a61-fa0ed01082a0`) and family relocation (`845249d3-4b79-4589-b4fd-2d4206c08415`). These inspected documents had no document expiry date.

The first failed overview's persisted evidence IDs included:

- `8a716bd0-551b-4535-9c5f-1c7941503880`: personal tax residence / double-tax treaty section in the salary-versus-dividends document.
- `998c1067-b9fa-467a-b1e5-e7082cc389b7`: salary and dividend withdrawal methods.
- `daa5a390-17f5-4090-932e-c5a9838d61f5`: why the team does not choose a personal tax outcome for the client.
- `4b08a971-1381-4bd1-b2cc-b006f112d250`: national versus EU trademark registration.

Those passages are not a complete general services overview. Six evidence items were counted but only four IDs were preserved by the Edge array filter; this audit does not identify the two omitted items. Therefore it cannot claim the entire evidence set was irrelevant. It does establish that successful search status alone overstated what had been demonstrated about relevance and coverage.

The actual section identity mechanism uses document ID plus `section_index` / metadata `sectionIndex`. A null metadata `section_id` is not, by itself, proof of a broken parent link.

## Relevant execution limits in inspected code

| Limit | Value / behavior |
| --- | --- |
| Agent steps | Default 4; all three failed substantive turns reached step 4. Final step reserves a tool-free answer attempt. |
| Ordinary answer | 700 characters, 1–5 sentences, at most 1 question. No observed trace proves a length limit caused these failures. |
| Search variants | Up to 2: model query and current customer message. |
| Candidate window | Up to 20 per variant; model observation up to 16 items. |
| Tool observation content | Up to 12,000 characters per item / 18,000 total. |
| Accumulated loop evidence | 6,000 characters; first overview retained 5,403. Budget saturation is not proven for that turn. |
| Provider request timeout | 20 seconds. Recorded overview model calls completed well below it. |

The accumulated budget and ranking deserve further investigation because useful sections may be omitted. Do not increase limits until the retained evidence, excluded sections and actual validator failure have been compared.

## Untested questions and repair priorities

The partner-change question and all later questions were **not sent**. Residency scope, incorporation versus residency, English summary, return to Arabic, bullet formatting, explicit appointment refusal, cost and timing were not verified in this conversation. Greek and injected technical failures were also outside this interrupted run.

Required next repairs, subject to resuming work:

1. Remove conversational preflight shortcuts and route greetings/identity/service questions through model understanding, with company identity supplied from the validated profile. Retain deterministic privacy, authorization and booking safeguards.
2. Align safe diagnostic contracts end to end: preserve code enums separately from UUID identifiers, keep detailed model measurements, and correlate each turn without logging private content or hidden reasoning.
3. Reproduce the rejected drafts without sending WhatsApp messages; compare each failed claim against the evidence actually supplied. Fix demonstrated generation, grounding or validator defects while retaining business restrictions.
4. Verify retrieval ranking and section coverage against the approved documents, then repeat the interrupted conversation and unseen cases through the actual WhatsApp composition.

No runtime fixes, migrations, deployments or restarts were performed as part of this interrupted audit. This report is an evidence record, not a claim that the failures have been repaired.
