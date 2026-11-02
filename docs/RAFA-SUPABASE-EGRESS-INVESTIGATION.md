# RAFA Supabase Egress Investigation

**Investigation date:** 2026-11-02  
**Supabase project:** `RAFAist` (`anhharmjtmqndhzenicb`), organization `hasan-99`  
**Scope:** read-only source and telemetry investigation. No application code, schema, workers, or deployment changed.

## 1. Executive summary

The strongest confirmed bandwidth source is the dashboard conversation list refresh. While the `Conversations` view is visible, it refreshes both `/api/conversations` and `/api/leads` every 15 seconds, and again on focus/visibility changes. Both server routes call `readUsers()`, which requests the entire contact set with `includeHistory=true`. The Edge Function then loads workflow metadata and complete conversation histories before returning a full snapshot.

Supabase logs for **2026-11-01 00:00:00–21:59:12 UTC** show:

| Supabase Edge Function response | Requests | Mean declared response | Maximum | Total declared response bytes |
| --- | ---: | ---: | ---: | ---: |
| `/contacts?includeHistory=true` | 10,545 | 223,904 B | 223,904 B | 2,361,067,680 B (2.36 GB) |
| `/events?limit=5000` | 3,924 | 67,935 B | 68,649 B | 266,576,332 B (0.267 GB) |
| All function responses with a logged `content-length` | 14,471 of 19,762 | — | 223,904 B | 2,627,871,367 B (2.63 GB) |

The contacts response accounts for about **89.8%** and the events response about **10.1%** of the declared response bytes logged for the Edge Function. The contacts endpoint returned the same declared body length in all 10,545 calls; that confirms repeated same-size payloads, not byte-for-byte identical content.

This log window does **not** establish the precise contribution to Supabase’s reported 15.47 GB billing usage. It covers less than one day, response `content-length` is not a billing meter, and 5,291 function responses had no logged content length. Compressed wire bytes, other billing-period days, other services, and the Usage Dashboard’s accounting are not available in the logs reviewed. Still, this is direct evidence that repeated full-history contact snapshots are a major avoidable transfer stream.

The worker pollers are real and run about twice per minute. Their underlying claim RPC responses were logged as 2 B, but the Edge Function claim response lengths are absent, so their total endpoint bandwidth is unknown. They are not the measured source of most *content-length-bearing* function bytes. Authentication checks also occur frequently: `/auth/v1/user` and `rafa_dashboard_users` each had about 21,000 requests in this window. The code shows both the 30-second session poll and per-request protected-route validation; the endpoint counts do not indicate an auth refresh loop inside a Supabase client.

## 2. Evidence and limits

### Sources inspected

- Dashboard browser code and server routes, including polling, focus/visibility triggers, auth middleware, and API caching.
- WhatsApp worker, notification and reminder schedulers, and the shared Supabase Edge API store.
- `rafa-agent-api` Edge Function routes and its database query helpers.
- Supabase unified logs for the active `RAFAist` project, from Nov 1 00:00 UTC to Nov 1 21:59:12 UTC. Queries were read-only and used the Supabase access flow documented in `SUPABASE-ACCESS-GUIDE.md`.
- A current local process snapshot. It showed the dashboard server and one `dashboardManagedWorker.js` process; it did not show evidence of duplicate managed worker processes at the time of inspection.

### Important limits

- Supabase logs identify the shared `node` client and project request, but do not identify a browser tab, UI component, local process ID, or initiating route for each Edge request. The component attribution below is established by source call paths and cadence matching; the individual request-to-tab link is not directly logged.
- The repository working tree already had many unrelated modifications before this investigation, including changes to some relevant files. Findings describe the source currently present in the working tree. Deployed Edge Function version observed in logs was 106; local/deployed source parity was not verified.
- Supabase tools available here expose unified logs but not the Usage Dashboard’s billing breakdown. User-provided 15.47 GB and 5.5 GB plan values are treated as the alert’s stated figures, not independently verified usage metrics.
- `response.headers.content_length` measures declared response-body length when present. It does not prove the billed, compressed wire-byte total. A missing header is **unknown**, not a zero-byte response.

## 3. Confirmed root causes

### 3.1 Full contact histories are repeatedly downloaded for list pages

The dashboard’s `Conversations` component calls `fetchConversationLists()` initially and on every visible 15-second refresh. That helper performs two uncached requests in parallel: `/api/conversations` and `/api/leads`. It also refreshes on browser focus and `visibilitychange` while visible. See [Conversations.jsx](../dashboard/src/Conversations.jsx#L35), [conversationListRefresh.js](../dashboard/src/conversationListRefresh.js#L1), and [conversationListRefresh.js](../dashboard/src/conversationListRefresh.js#L17).

Both API routes read the full snapshot: `/api/leads` at [server.js](../dashboard/server.js#L714) and `/api/conversations` at [server.js](../dashboard/server.js#L740). `readUsers()` calls `store.toJsonData({ includeHistory: true })` at [server.js](../dashboard/server.js#L1708), and the store requests `/contacts?includeHistory=true` at [supabaseStore.js](../src/supabaseStore.js#L194).

The Edge Function’s `listUsers(true)` selects all contact columns, attaches CRM/workflow state, and reads conversation turns for all users without a history cap. See [index.ts](../supabase/functions/rafa-agent-api/index.ts#L1082), [index.ts](../supabase/functions/rafa-agent-api/index.ts#L1101), and [index.ts](../supabase/functions/rafa-agent-api/index.ts#L1114). It selects `rafa_contacts.*` and the complete history fields from `rafa_conversation_turns`.

The 15-second conversation refresh makes two whole-snapshot requests per refresh, or **8 requests/minute per continuously visible Conversations tab** before focus-triggered refreshes. The observed rate was approximately **480 contacts responses/hour**, matching that source cadence. This is a strong source-and-cadence match. Logs cannot prove how many tabs or other list endpoints contributed to each hour.

### 3.2 A single snapshot fans out into many database reads

For each contact in the full-list response, `attachWorkflowState()` runs two consent queries plus one each for follow-up state, qualification, and existing-client verification. `listUsers()` separately loads CRM rows and history. See [index.ts](../supabase/functions/rafa-agent-api/index.ts#L1091) and [index.ts](../supabase/functions/rafa-agent-api/index.ts#L2467).

The Nov 1 PostgREST request counts fit this fan-out: approximately six `rafa_contact_consents` reads and three reads each of `rafa_follow_up_states`, `rafa_lead_qualifications`, and `rafa_existing_client_verifications` per full contacts request. The ratio implies about three contacts processed per full snapshot during this period; this is an inference from request counts, not a direct row-count query. These table responses are small where `content-length` is logged, so this fan-out is a high query/CPU cost, while the 223.9 KB aggregate Edge response is the measured large transfer.

### 3.3 Event history is repeatedly fetched at a fixed limit

The same dashboard overview data route reads up to 5,000 events using `/events?limit=5000`: [server.js](../dashboard/server.js#L649) and [server.js](../dashboard/server.js#L1712). The Edge Function selects event records and returns them: [index.ts](../supabase/functions/rafa-agent-api/index.ts#L1067) and [index.ts](../supabase/functions/rafa-agent-api/index.ts#L2399). The observed responses averaged about 67.9 KB and totaled 266.6 MB in the log window. The response is materially smaller than contacts, but still a repeated history-sized read for overview/status summaries.

### 3.4 Dashboard authentication is checked on every protected API request

`/api/session` calls `resolveDashboardIdentity()`, which calls `client.auth.getUser()` and then queries `rafa_dashboard_users`: [server.js](../dashboard/server.js#L2183) and [server.js](../dashboard/server.js#L2190). The browser separately calls `/api/session` every 30 seconds while authenticated: [main.jsx](../dashboard/src/main.jsx#L206).

Every `/api` request also passes `requireAuth`, which repeats `resolveDashboardIdentity()` rather than sharing the periodic session result: [server.js](../dashboard/server.js#L189), [server.js](../dashboard/server.js#L2200), and [server.js](../dashboard/server.js#L2216). Nov 1 logs show 21,066 `/auth/v1/user` and 21,076 `rafa_dashboard_users` requests, nearly one-for-one as this code predicts. `rafa_dashboard_users` responses were 84 B each (about 1.77 MB total); Auth response lengths were absent, so their transfer is unknown. This is a significant request-volume source, but not a demonstrated large-egress source.

This repeated verification preserves an important security boundary. A safe optimization should reduce redundant *background checks* or consolidate dashboard data requests without bypassing authorization on protected routes.

### 3.5 Notification and reminder workers poll every 30 seconds

The notification scheduler starts at bot startup outside the WhatsApp connection callback, unless pairing-only/test-chat mode is enabled. It calls the claim route immediately and every 30 seconds by default (`RAFA_NOTIFICATION_POLL_MS`, minimum 15 seconds), with a per-process `running` guard: [bot.js](../src/bot.js#L1045) and [notificationScheduler.js](../src/notificationScheduler.js#L157).

The reminder scheduler starts when WhatsApp connects, stops on connection close, and also runs immediately and every 30 seconds by default (`BOOKING_REMINDER_POLL_MS`, minimum 15 seconds), with a `running` guard: [bot.js](../src/bot.js#L937), [bot.js](../src/bot.js#L947), and [reminderScheduler.js](../src/reminderScheduler.js#L117).

Nov 1 logs show 2,634 `/notifications/claim` and 2,632 `/reminders/claim` Edge Function calls over about 22 hours—approximately 120/hour each, consistent with one 30-second loop. Their corresponding RPCs are `rafa_claim_due_notifications` and `rafa_claim_due_reminders`. Claim response lengths were absent in the function logs, so their body sizes are unknown; these are operationally useful queue checks, and they should not be disabled based on request counts alone. Their small/empty claim payload pattern is suggested by logged PostgREST responses, but exact function-response bytes are unavailable.

The code prevents overlapping checks within one process. It does not provide a cross-process singleton lock; duplicate deployed/local workers remain possible in general. The current local process snapshot showed one managed worker, and Nov 1 claim counts match one 30-second loop. Historical duplicate instances cannot be ruled out from logs without worker identity telemetry.

### 3.6 The Edge API validates its API secret on every request

Before routing, `rafa-agent-api` calls `rafa_validate_api_secret` for each request: [index.ts](../supabase/functions/rafa-agent-api/index.ts#L176). Nov 1 showed 19,780 RPC calls, close to 19,762 function requests. The validation response is 4 B in the sampled logs, about 79 KB total. This is expected gateway authorization work and is not a material measured bandwidth source. Do not remove it as an egress shortcut.

## 4. Request provenance map

The table separates **direct REST/PostgREST query counts** from **external function-response bytes**. REST response bytes are only reported where logs contained `content-length`; missing entries mean unknown.

| Endpoint / DB object | Source and caller | Trigger / frequency evidence | Payload evidence | Impact |
| --- | --- | --- | --- | --- |
| `rafa_contacts` → `/contacts?includeHistory=true` | `Conversations` → `fetchConversationLists()` → `/api/conversations` + `/api/leads` → `readUsers()` → `EdgeApiStore.allUsers()` → Edge `listUsers(true)` | Visible-tab refresh every 15 s, plus focus/visibility refresh; 10,545 full responses, about 480/hour | Each function response exactly 223,904 B; 2,361,067,680 B total | **Largest confirmed source; ~89.8% of logged function response bytes.** Full histories and all contacts are unnecessary for both list summaries. |
| `rafa_conversation_turns` | Same full-list `listUsers(true)` path; queries all history for selected user IDs | 10,557 direct reads in the window; one history batch per list request is consistent with counts | Direct REST content-length absent; its data is included in 223,904 B full-list responses | Large query/work fan-out and source of full-history payload. |
| `refal_lead_profile` | Same full-list path; batched query in `listUsers()` | 10,558 reads | REST response length absent; included in full-list payload | Repeated unchanged profile read; data transfer not independently measured. |
| `rafa_contact_consents` | `attachWorkflowState()` called from full-list path; two consent types per contact | 63,385 reads, about 6 per full-list response by count ratio | Logged mean 13.17 B, max 69 B, about 0.835 MB declared in total | High request count/query overhead, small measured response bytes. Additional consent checks exist in workflow routes. |
| `rafa_follow_up_states` | `attachWorkflowState()` in full-list path | 31,692 reads, about 3 per full-list response | Mean 1.33 B, max 2 B; about 42 KB declared | High request count, negligible measured bytes. |
| `rafa_lead_qualifications` | `attachWorkflowState()` in full-list path | 31,677 reads, about 3 per full-list response | Mean 0.67 B, max 2 B; about 21 KB declared | High request count, negligible measured bytes. |
| `rafa_existing_client_verifications` | `attachWorkflowState()` in full-list path | 31,683 reads, about 3 per full-list response | 2 B max/mean; about 63 KB declared | High request count, negligible measured bytes. |
| `rafa_events` → `/events?limit=5000` | `/api/overview` (`Overview` or `AgentStatus`) → `readEvents()` → `store.listEvents()` → Edge `listEvents()` | UI polls at 30 s. Logs: 3,924 limit-5000 function responses, ~178.5/hour | Mean 67,935 B; max 68,649 B; 266,576,332 B total | **Second-largest measured source; ~10.1% of logged function bytes.** Summary consumers repeatedly load event rows. |
| `auth/v1/user` | Dashboard `resolveDashboardIdentity()` through `/api/session` and global `requireAuth` middleware | 21,066 reads; periodic session poll is every 30 s, plus every `/api` call | Response content-length absent | High request volume; transfer unknown. Do not weaken protected-route auth. |
| `rafa_dashboard_users` | `dashboardAccount()` after `auth.getUser()` in the same paths | 21,076 reads, nearly one-for-one with Auth requests | 84 B each; 1,770,384 B total | High request volume, about 1.77 MB declared; small measured transfer. |
| `rafa_validate_api_secret` | Edge Function pre-router gate, one RPC for each API request | 19,780 reads vs 19,762 function requests | 4 B each; 79,120 B total | Expected security check, low bandwidth contribution. |
| `rafa_appointments` | Dashboard `/api/bookings` → `readBookingRows()` with contact and reminder joins | 5,255 reads; `Bookings` component polls every 15 s | Content-length absent; query selects up to 500 appointments and related contact/reminder fields | Request-heavy and potentially sizeable; byte contribution cannot be ranked from available headers. |
| `rafa_handovers` | `/api/handovers/summary` and notification reconciliation/claim routes | 2,631 Node reads plus Edge-function reads | Node response lengths logged as 2 B each on this path; related rows/paths vary | Operational reads. Counts suggest repeated dashboard summary checks and worker reconciliation; exact payload bytes are small where logged. |
| `refal_handover_delivery` | `/api/handovers/summary` and Edge notification close/reconciliation paths | 2,635 Node reads and 2,632 Edge-function reads | Node responses: 47 B each, ~124 KB total; Edge responses 2 B each, ~5 KB | Low measured transfer; legitimate delivery-state coordination. |
| `rafa_notification_jobs` | Notification claim reconciliation and dashboard notification routes | 2,629 reads in Edge-function logs | 2 B each, about 5 KB declared | Worker operation; not a material measured bandwidth source. |
| `rafa_claim_due_notifications` | `notificationScheduler` → Edge `/notifications/claim` → database RPC | 2,629 RPC calls in direct DB logs; 2,634 function claim calls | RPC responses 2 B in direct DB logs; function response length absent | 30-second worker polling is confirmed; small response evidence, useful queue semantics. |
| `rafa_claim_due_reminders` | `reminderScheduler` → Edge `/reminders/claim` → database RPC | 2,627 RPC calls; 2,632 function claim calls | RPC responses 2 B in direct DB logs; function response length absent | 30-second worker polling is confirmed; do not disable legitimate reminder delivery. |

### Endpoint call sites outside the highest-volume list

- `backfillLeadTemperatures()` calls `allUsers({ includeHistory: true })` once when the WhatsApp connection opens. It is a startup/connection backfill, not a 30-second loop: [bot.js](../src/bot.js#L506) and [bot.js](../src/bot.js#L937).
- `runFollowUpCheck()` calls `allUsers({ includeHistory: true })` on the configured hourly cron (default `0 * * * *`, `Europe/Nicosia`) and then checks eligible contacts before sending: [followUp.js](../src/followUp.js#L101) and [followUp.js](../src/followUp.js#L203). This is legitimate hourly work, not the 480/hour source.
- The Supabase store retries GETs up to three total attempts on network errors, 429s, or server errors; it does not retry successful responses: [supabaseStore.js](../src/supabaseStore.js#L45). Logs do not establish retry amplification as a cause.
- No frontend `supabase-js` client, browser Realtime subscription, or browser `onAuthStateChange` loop was found in the dashboard source. The dashboard uses server routes and `@supabase/ssr` auth helpers.

## 5. Polling and worker timeline

| Process/component | Startup and cadence | Can run with dashboard browser closed? | Observed Nov 1 evidence |
| --- | --- | --- | --- |
| Dashboard session check | Initial `/api/session`, then every 30 s while signed in | No browser calls after tabs close; the local server alone does not poll | About 21k each of Auth user and dashboard account checks, including middleware for every protected API route |
| Conversations list | Initial load; then every 15 s while visible; immediate refresh on focus/visibility change; two API calls per refresh | No, requires an open/visible dashboard tab | 10,545 full snapshots ≈ 480/hour; exactly matches two list endpoints × four 15-second intervals per minute |
| Overview / Agent Status | `/api/overview` on mount and nominally every 30 s; 30-second API cache can satisfy some same-key refreshes | No, requires a dashboard tab | 3,924 event history responses (plus possible status fallback), about 178.5/hour |
| Bookings | `/api/bookings` on mount and every 15 s | No, requires a dashboard tab | 5,255 appointment reads, about 239/hour |
| Notification worker | Starts from bot startup (except pairing/test mode); immediate claim, then every 30 s; per-process overlap guard | **Yes**, while the local bot/managed worker remains running | 2,634 claim calls over ~22 h ≈ 2/min |
| Reminder worker | Starts when WhatsApp connects; immediate claim, then every 30 s; stops on disconnect; per-process overlap guard | **Yes**, while the local bot is connected | 2,632 claim calls over ~22 h ≈ 2/min |
| Follow-up scheduler | Hourly cron in Europe/Nicosia after WhatsApp connects | **Yes**, while the local worker runs | Source confirms hourly cadence; not responsible for sustained full-list polling rate |

The `dashboardManagedWorker.js` process loads `src/bot.js`; the live process snapshot contained one dashboard server and one managed worker process. The worker’s two 30-second claim streams continued independently of the browser UI by design. Current evidence does not show a duplicated worker instance, but logs lack instance IDs and cannot disprove historical or remote duplicates.

## 6. Egress contribution and ranking

### Measured/estimated from logs

The 19,762 function requests during the 22-hour window had a logged `content-length` on 14,471 responses. Their declared response-body total was **2.628 GB decimal**. The contacts and events routes account for 2.628 GB of that total; remaining content-length-bearing function responses add about 0.227 MB.

| Rank | Source | Declared bytes in window | Share of logged function response bytes | Confidence |
| ---: | --- | ---: | ---: | --- |
| 1 | Full contacts plus all conversation history | 2.361 GB | 89.8% | High for declared bytes; actual billed/wire bytes may differ |
| 2 | Event history, limit 5,000 | 0.267 GB | 10.1% | High for declared bytes; actual billed/wire bytes may differ |
| 3 | All other content-length-bearing Edge Function responses | 0.00023 GB | <0.1% | Incomplete where headers were absent |
| Not rankable | Dashboard Auth responses, appointment reads, other missing-length responses, internal direct PostgREST reads, storage/other billing-period traffic | Unknown | Unknown | Insufficient response-byte telemetry |

No `/storage` object requests were present in the queried Nov 1 edge log window. That does not rule out Storage or other egress during other days in the billing period. The REST/PostgREST response headers for the repeated small workflow lookups show only tens to hundreds of KB combined where logged; many endpoints have no response length, so do not use these partial figures as total database egress.

### Direct response measurements for the highest-volume PostgREST paths

Where headers were present, the high-count metadata lookups were very small: `rafa_contact_consents` 0.835 MB total, `rafa_follow_up_states` 0.042 MB, `rafa_lead_qualifications` 0.021 MB, `rafa_existing_client_verifications` 0.063 MB, `rafa_dashboard_users` 1.77 MB, and `rafa_validate_api_secret` 0.079 MB. These values are declared response bytes, not a comprehensive billing total. The much larger complete contact and event responses are measured at the external Edge Function boundary above.

## 7. Ranked optimization recommendations

1. **Stop full-history reads for list summaries.** Change `/api/conversations` and `/api/leads` to use compact, paginated summary data (last turn, counts, profile summary) and load transcript history only for the selected conversation. This removes the principal 2.36 GB/day-shaped stream while keeping the same operator workflow. Preserve role-based filtering and customer privacy.
2. **Coalesce the two conversation-list requests.** The current refresh makes `/api/conversations` and `/api/leads` independently load the same contact snapshot. A shared server-side snapshot/read path or a single list endpoint can avoid duplicate full reads per refresh. Keep both data shapes and authorization semantics until UI consumers are migrated.
3. **Cache stable snapshot inputs briefly with explicit invalidation.** If summary APIs still need repeated database reads, share a short-lived server-side cache/in-flight request across dashboard routes. Invalidate on contact/history writes and make staleness explicit. Avoid a cache that can serve one customer’s data to another role or tenant.
4. **Return event summaries instead of thousands of event rows.** For overview/status counters, query or cache only fields and time ranges needed by the UI. Use pagination for audit/history screens. Do not silently truncate administrator audit data.
5. **Reduce background refresh duplication.** Retain the existing visibility-aware conversation refresh, but avoid focus/visibility events causing an extra refresh when one has just completed. Add single-flight behavior to polling routes that currently allow overlap. Keep freshness targets appropriate for live inbox work.
6. **Keep request authentication; reduce only redundant background verification.** The 30-second `/api/session` poll duplicates route checks when the user is actively making API calls. Consider a slower/visibility-aware heartbeat while preserving `requireAuth` and administrator authorization on every protected server route. Validate account-disable and token-expiry behavior before changing cadence.
7. **Keep worker claims reliable; improve measurement and coordination.** Existing `running` guards prevent overlap within one process. Add instance/iteration identifiers and report claimed counts, duration, and retry state so duplicate workers are detectable. Only adjust 30-second cadence after confirming the maximum delivery delay and queue retry behavior. Do not disable either worker.
8. **Project only needed columns and paginate where remaining list reads are necessary.** `listUsers()` selects all contact columns and complete history; dashboard list APIs need far less. Keep complete history access available for the selected thread, not the whole list. Ensure deterministic ordering and pagination so rows are not skipped.
9. **Use Realtime only for verified event-driven views.** The source contains no current dashboard Realtime subscription. Realtime may suit the inbox after an appropriate compact initial snapshot and lifecycle/reconnect handling exist; it is not a drop-in replacement for authorization or initial data loading.

## 8. Proposed implementation plan

1. Capture a baseline for active dashboard views: per-route request counts, response sizes, freshness target, and user-visible list fields.
2. Build one compact server-side conversation/lead summary query with cursor pagination and a separate selected-conversation transcript route. Preserve existing filters, roles, and all three supported UI languages.
3. Change the Conversations view to consume one summary response per refresh, with a single in-flight refresh and no duplicate focus refresh inside the active interval.
4. Replace `/api/overview`’s full contacts/events reads with compact aggregates and a bounded recent-event summary. Keep full audit history in its dedicated paginated screen.
5. Review global API auth counts after UI request reduction. Keep per-request authorization unchanged; tune only the standalone session heartbeat after security behavior is documented.
6. Add safe worker instance/cycle telemetry, then compare one-day function and PostgREST logs with the same aggregation query used here. Confirm queue delay, no missed sends, and that one worker instance is active.
7. Verify the Usage Dashboard’s daily egress line falls after deployment and reconcile project-wide usage with function response bytes, PostgREST, Auth, Storage, and any other service. Deploy only after the code changes and checks are separately authorized.

## 9. Risks and regression considerations

- Smaller list payloads must retain the latest-message direction, timestamps, counts, unread/reply flags, CRM summaries, appointment status, and lead filters used by current dashboard views.
- Caching or coalescing must not cross user/role boundaries, return stale authorization state, or retain personal conversation content longer than needed.
- Transcript pagination must preserve chronological ordering, edits, attachment metadata, and correct oldest/newest cursor behavior.
- Less frequent session heartbeat can delay display of a disabled/expired session; protected API routes must continue to reject unauthorized requests immediately.
- Slower worker polling increases notification/reminder latency; any cadence change needs explicit queue freshness and retry checks.
- Realtime adds reconnection, duplicate-event, authorization, and initial-snapshot complexity. It should follow compact-query work, not replace it blindly.
- Report findings are based on uncommitted working-tree code and a deployed Edge Function whose local parity is unknown. Confirm which code revision is actually deployed before using this report as a change specification.

## 10. Remaining unknowns requiring Supabase telemetry

- Usage Dashboard’s exact measurement period and whether 15.47 GB is month-to-date, rolling, or another billing window.
- Daily egress split by Data API, Edge Function responses, Auth, Storage, and other services for that same period.
- Compressed/transferred response bytes and byte counts for responses without logged `content-length`.
- Whether any traffic came from additional remote workers or clients outside the current local process snapshot.
- Per-route and per-tab correlation. Add a non-sensitive request/worker instance identifier if future attribution needs to distinguish browser tabs and worker processes.
- Current row counts and whether histories/contact payloads have changed since the Nov 1 log window; the fixed 223,904 B body length is a point-in-time measurement.
- Exact amount of Nov 1 logged response bytes counted in the 15.47 GB Usage Dashboard figure. The available logs support an estimate of repeated payload contribution, not an exact billing reconciliation.

## 11. Implementation follow-up (2026-11-02)

The repository now has an additive `rafa_dashboard_conversation_summaries()` database function and a `GET /contacts/summaries` Edge API route. The function returns exact turn/message counts, latest-message fields, and reply-filter flags without returning full history rows. It runs as `SECURITY INVOKER`; execute access is revoked from `PUBLIC`, `anon`, and `authenticated`, and granted only to `service_role`.

`/api/leads` and `/api/conversations` now use this compact data. The Conversations refresh sends one request and receives both list payloads. Opening a conversation still uses the existing full-transcript endpoint. If the deployed Edge Function returns 404 because the new route is not deployed yet, the dashboard logs a warning and temporarily falls back to the existing full-history reads so the lists continue to work.

The migration has **not** been applied to Supabase and the Edge Function has **not** been deployed. Apply the migration first, deploy the Edge Function second, then restart the local dashboard server; until that rollout completes, the 404 compatibility fallback preserves the dashboard but does not reduce its list-refresh egress. The fallback is not used for other errors.

Verification completed locally: dashboard tests (213 passed), Supabase store regression tests (14 passed), dashboard production build, JavaScript syntax checks, and a PGlite execution of the migration function confirming the summary fields and service-role-only execute grant. No live Supabase objects were changed.

