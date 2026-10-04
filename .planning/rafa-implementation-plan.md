# Rafa WhatsApp Assistant — Implementation Plan

**Goal:** Deliver a natural bilingual Refalco WhatsApp assistant with contact-scoped memory, safely reviewed appointments, dependable calendar/email/WhatsApp updates, and clear admin controls.

**Approach:** Keep Baileys as the WhatsApp transport, the existing `rafa-agent-api` as the worker's Supabase boundary, approved knowledge retrieval for Refalco facts, Google Calendar OAuth for availability/events, and the current dashboard/Auth model. Make Supabase the durable source of truth. Ship in the stages below; do not mark an appointment confirmed until admin approval and Google Calendar persistence both succeed.

## Existing foundation and gaps

- Present: English/Arabic detection, approved Supabase knowledge retrieval, legal/financial refusals, conversation turns and contact profiles, admin dashboard/Auth, Google Calendar FreeBusy/event creation, Meet generation, configurable Cyprus hours, idempotent appointments, durable reminder queue, event logging, and customer booking confirmation.
- Missing or incomplete: WhatsApp model calls omit prior turns and saved contact context; durable summaries and admin memory correction are not implemented as a dedicated workflow; customer confirmation currently creates and confirms the calendar event without an admin review; no reject/reschedule review flow or secure email actions exist; the dashboard cannot approve/reject appointments; the scheduler's generic reminder does not guarantee the Meet link is delivered one hour before the appointment; the booking window can allow same-day appointments when policy notice permits; no customer blocklist/reason/unblock UI exists.
- Runtime limits from the existing project notes: the WhatsApp worker has been unpaired/offline at times, OpenRouter quota has failed before, and calendar booking still requires a controlled end-to-end test. Code completion alone must not be reported as live readiness.

## Stage 0 — Baseline, contracts, and setup inventory

1. Record current migrations, RLS/grants, deployed Edge Function contract, dashboard API, worker environment requirements, Google OAuth scopes, SMTP settings, and active local test/build commands.
2. Preserve the existing approved-source boundary and legal/financial exclusions. Treat WhatsApp messages, retrieved text, memory, and model output as untrusted.
3. Add a release checklist separating local checks from actions requiring Supabase migration/deployment, Google OAuth, SMTP, WhatsApp pairing, or admin live testing.

**Acceptance:** the plan and code agree on appointment states, ownership boundaries, timezone policy, and deployment requirements; no secret is copied into source, logs, or dashboard output.

**Progress:** local architecture, current migration/API/dashboard contracts, and known live setup limits inspected. Supabase CLI is not installed in this workspace, so the schema change below was authored as a local migration and must be reviewed/applied through the project's normal migration deployment path.

## Stage 1 — Natural conversation and client-scoped memory

1. Pass a bounded recent history window and the matching contact's saved details/summary to WhatsApp generation. Never load another contact's data. Keep retrieval evidence as the sole source of company facts.
2. Make the conversation prompt friendly and concise in Arabic/English, focused on Refalco. Handle greetings/small talk naturally; redirect unrelated questions politely; ask one clarifying question for unclear messages; abstain and offer a person when company evidence is missing.
3. Capture a name and service interest only when clearly provided. Store useful client-specific facts separately from approved Refalco knowledge.
4. Add a bounded summary refresh (recent turns plus prior summary), summarize decisions/preferences/interest/appointment context, and prevent the summary from asserting company facts. Add dashboard admin correction/removal controls for client details and summary with audit entries.
5. Ensure duplicate inbound messages are idempotent across process restarts (provider message key persisted), while preserving the current in-memory fast-path.

**Edge cases:** empty/short/ambiguous replies, customer returns days later, contradictory client details, summary failure, prompt injection in history, privacy-sensitive content, duplicate/replayed WhatsApp IDs, database unavailable, and Arabic dialect/code-switching.

**Acceptance:** two contacts never share memory; a returning contact receives contextually coherent replies; approved knowledge still grounds every Refalco fact; corrections affect only that client's memory unless an admin separately approves a knowledge revision.

**Progress:** WhatsApp model requests now receive only that contact's bounded recent turns and summary, explicitly marked untrusted and separate from approved evidence. Summaries redact contact data and URLs; dashboard admins can edit/clear contact details and summary. `كيفك` receives natural Arabic small talk; common English/Arabic self-introductions and explicit service interest are captured. WhatsApp answers omit sources/URLs. Persistent provider-message receipts use a stale-processing lease; summaries remain bounded rather than rolling semantic summaries.

## Stage 2 — Appointment rules and review state machine

1. Enforce `Europe/Nicosia`, configured weekdays/hours, valid future dates, and a strict next-local-day minimum regardless of a smaller minimum-notice setting. Check FreeBusy before proposing slots and again on approval.
2. Require explicit customer agreement to a specific proposed time. Create a durable `pending_review` appointment, but do not tell the customer it is confirmed and do not create a confirmed Calendar event yet.
3. Add validated state transitions: `pending_review → confirmed | rejected`; `confirmed → rescheduled | cancelled | completed`; rescheduling returns to `pending_review`. Keep calendar-sync and notification delivery status distinct from business status so provider failures remain visible without falsely confirming.
4. Make transitions idempotent and concurrency-safe. Persist actor, timestamps, prior/new status, and safe reason in an audit trail. Prevent duplicate events and stale approval links.
5. On rejection, notify the customer politely and offer newly checked alternatives. A new selected time goes through the same review process.

**Edge cases:** DST gaps/folds, same-day and past dates, calendar busy between proposal and approval, two admins acting at once, duplicate WhatsApp confirmations, retry after event creation but before database update, calendar outage, and invalid state transitions.

**Acceptance:** no event is presented as confirmed before both admin approval and successful Calendar write; failed writes stay pending and are retryable without duplicates; every status change is auditable.

**Progress:** enforced next-Cyprus-local-day booking; customer-agreed selections create `pending_review`, not calendar events or confirmations. Dashboard approval rechecks FreeBusy and creates an idempotent Calendar event; rejected requests now offer alternatives only after a live FreeBusy check. Migrations and compare-and-set transitions are implemented. A multi-provider Calendar/database transaction is not possible; partial sync failures are logged for reconciliation.

## Stage 3 — Secure admin approval, email, and dashboard notifications

1. Add durable dashboard notification/outbox records for appointments awaiting review and delivery state for email.
2. Notify `hasan.cy99@gmail.com` with appointment details and dashboard link. Implement expiring, single-use approval/rejection actions using cryptographically random tokens stored only as hashes, constant-time verification, explicit confirmation before mutation, and an atomic consume/transition operation. Link scanners/GET requests must not approve or reject.
3. Add admin-only dashboard actions for approve/reject with a required rejection reason, clear current state, and safe retry feedback. Keep the email route independent of dashboard cookies but bound to the signed one-use action.
4. Retry transient email failures with bounded backoff; keep notification failure visible and never roll back a valid appointment state because email delivery failed.

**Edge cases:** expired/replayed/tampered links, email scanning, duplicate admin clicks, concurrent dashboard/email actions, email provider timeout, inaccessible calendar, and PII minimization in notification content.

**Acceptance:** only an authorized admin can transition an appointment; each action succeeds once; dashboard/email show consistent status; failed email is visible and retryable.

**Progress:** dashboard approvals are admin-only and state updates use compare-and-set status checks. Added a leased Supabase notification outbox for admin review email and customer WhatsApp notices, bounded retries/dead-lettering, stale-status suppression, admin visibility, and manual retry for dead jobs. Email contains a dashboard route; state-changing email links are not used.

## Stage 4 — Calendar lifecycle and one-hour WhatsApp meeting delivery

1. On approval, recheck FreeBusy and create/update the Calendar event idempotently. Record event ID/URL and state only after provider success.
2. Generate a Meet link for approved appointments. Do not send the link at booking time; queue a WhatsApp delivery for one hour before start. If approval occurs inside that one-hour window, send promptly after approval. Keep the existing policy reminders distinct from the Meet-link delivery.
3. On reschedule/cancel, update or cancel the Calendar event, cancel stale reminder/link jobs, recheck availability for new time, and return the new time to admin review before confirmation.
4. Use a durable outbox/claim lease with retry/dead-letter state and provider message IDs to handle worker restarts, WhatsApp outages, and duplicate scheduler runs.

**Edge cases:** no Meet URL returned, approval late, event update partially succeeds, cancellation after reminder claim, DST/timezone changes, contact number changes, retry after send succeeds but acknowledgement fails, and WhatsApp account offline.

**Acceptance:** correct contact receives exactly the current Meet link at the intended time; no stale link is sent after a change; Calendar, Supabase, dashboard, and WhatsApp outcomes are reconcilable.

**Progress:** Meet-link creation is required; approval queues a dedicated one-hour Meet notice and late approvals include the link immediately. Customer/admin cancel and reschedule remove the prior Calendar event, update appointment state, cancel stale reminders, request a new time, and send status-guarded outbox messages. Calendar/database partial failures are logged and are not yet exposed as a dedicated repair workflow.

## Stage 5 — Abuse policy and managed blocking

1. Define conservative abuse severity/rate rules: difficult questions, ordinary complaints, and criticism never trigger blocking; repeated clear harassment receives a warning before action where safe; only clearly severe or repeated abusive behavior may be blocked.
2. Add a durable block record with WhatsApp identity, reason/category, evidence turn IDs, actor/source, timestamps, active/released status, and review history. Avoid copying full message content into logs unnecessarily.
3. Check block state before AI/calendar work and before outbound follow-ups/reminders. Add dashboard search/reason/status/review/unblock controls restricted to admins. Audit every block/unblock.
4. Keep automated classification conservative and fail open for uncertain cases; allow the admin to review/override. Do not let customer text directly instruct Rafa to block another person.

**Acceptance:** blocked contacts receive no automated replies/outbound messages; all blocks show a reason; admins can unblock; criticism and difficult company questions remain serviceable.

**Progress:** added the reasoned block table/API, admin-only block/unblock dashboard, and inbound/follow-up/reminder suppression for active blocks. Blocking is admin-initiated; automated abuse warnings/severity rules and richer evidence review remain open.

## Stage 6 — Reliability, verification, rollout, and documentation

1. Add targeted tests for prompt/context isolation, Arabic/English, approval security/transitions, next-day scheduling, DST, idempotency, email retries, Calendar/Meet failures, one-hour delivery, blocking thresholds, and dashboard roles.
2. Add fault-injection coverage for WhatsApp/OpenRouter/Supabase/Calendar/SMTP outages and empty/invalid provider responses. Customer copy must be brief and honest; admin errors must be actionable and scrubbed.
3. Run root/dashboard suites, production build, migration review, RLS/security checks, and the approved-knowledge evaluator. Exercise a synthetic appointment end-to-end before live use.
4. Document required Supabase migration and Edge Function deployment, Google OAuth/calendar permissions, SMTP sender and public approval URL, WhatsApp pairing, model/quota setup, and rollback/recovery steps.
5. Perform a controlled live test only after code and local verification: one consenting test contact, next-day slot, admin reject, alternative slot, admin approve, Meet delivery, cancel/reschedule, and audit readback.

**Release gates:** Supabase migration/function deployed; calendar and SMTP credentials validated; dashboard approval origin configured; WhatsApp device paired and worker online; privacy-safe logs verified; end-to-end test passes. Do not report production-ready before these gates pass.

**Verification/deployment:** root tests pass (55); dashboard tests pass (38) and production build succeeds. On 2026-10-01, applied the five outstanding migrations to active Supabase project `anhharmjtmqndhzenicb`, deployed `rafa-agent-api` version 18 (JWT verification retained), and verified the migration history, new RLS tables, service-role-only grants, and function metadata through Supabase MCP. Remaining: WhatsApp worker/dashboard runtime restart or hosting deployment, Calendar/SMTP/WhatsApp end-to-end test, reconciliation after Calendar succeeds but the Supabase update fails, and automated severe/repeated abuse classification and warning. The standalone Supabase MCP endpoint asked to reconnect; deployment succeeded via the authenticated Supabase project tools.

## Open operational decisions (use defaults until a decision is required)

- Default approver remains `hasan.cy99@gmail.com` as requested.
- Default rejection policy: require a short admin reason; show that reason to the customer only after removing internal/private details.
- Default summary retention follows the existing contact/history retention and deletion controls; do not add a second copy of complete conversation text.
- Set `DASHBOARD_PUBLIC_URL` to the public dashboard origin used in review emails; local development can use a localhost origin. Email does not perform state-changing actions in this implementation.
- Confirm whether customer-facing appointment links should be sent alongside the in-chat scheduling flow or only as a fallback; the supplied Google appointment-schedule URL is already available in booking replies.
