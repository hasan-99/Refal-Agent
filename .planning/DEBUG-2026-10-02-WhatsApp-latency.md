# Debug Report — 2026-10-02

**Symptom:** WhatsApp replies take approximately 8.45–13.91 seconds.
**Mode:** performance

## Investigation

- Traced the live worker from `messages.upsert`/`handleMessage` through inbound receipt, contact refresh, user load, intent preparation, booking gate, routing, knowledge retrieval, model generation, workflow persistence, derived profile updates, and WhatsApp send.
- Existing historical telemetry identified 8.45–13.91 seconds total (mean 11.83 seconds), with the old `normalize_classify_route` timer at 2.55–2.78 seconds. That timer included contact load/preparation and its name did not accurately describe its scope.
- `src/messageRouter.js` previously awaited independent workflow persistence calls sequentially after `addHistory`; each is a separate Edge Function round-trip.

## Root Cause

`src/messageRouter.js:43-106` — independent workflow saves (`saveQualification`, `saveIntents`, handover/alert and other side records) were sequential awaits, so their round-trip costs accumulated on the customer response path after the history turn was created.

## Fix Applied

- Files: `src/messageRouter.js`, `src/bot.js`, `src/messageRouter.test.js`.
- Turn-dependent writes still wait for the history turn ID; then independent writes run concurrently with `Promise.all`.
- Added correlated, operational stage timing from inbound processing to delivery using a random trace ID. Telemetry includes durations and coarse outcomes/counts, not message bodies or customer IDs.
- Controlled local simulation (4 independent 120ms round-trip stand-ins): sequential baseline 514.4ms; concurrent implementation 128.3ms (75.1% lower for that persistence slice). This is a synthetic persistence measurement, not a post-fix WhatsApp E2E result.
- Verification: `node --test src/messageRouter.test.js` passed 16/16; `node --check src/bot.js` passed; `git diff --check` passed. Full `npm test` had unrelated concurrent-worktree failures in booking and RAG policy tests (95/97 at that run).

## Remaining Verification

- Restart the worker and send a real WhatsApp test to collect the new correlated post-fix total and stage timings. Historical E2E timings cannot be compared to the synthetic persistence simulation.
- Other latency may remain in sequential profile updates, provider latency, or other Supabase/API calls; attribute those only after the newly instrumented trace is collected.
