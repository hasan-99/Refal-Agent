# Pending booking state intercepts WhatsApp conversation

Date: 2026-10-02

## Investigation

- Read-only inspection of the admin dashboard, turn records, and runtime stage events showed one normal English greeting followed by a company question and two appointment-declining replies.
- The first greeting took the deterministic identity route. The later three turns exited through `handleBookingMessage` before knowledge retrieval or model generation.
- The selected contact had an `awaiting_details` booking draft created more than two hours before the inspected turns. The draft had no appointment ID; no appointment or handover was created during these turns.
- Stage events contained no retrieval evidence, provider call, retry, or model fallback for the intercepted turns. The recorded deterministic reply passed response validation.
- Unrelated turns also re-emitted an old `company_formation` intake in their metadata.

## Root cause

The active booking handler allowed broad contextual-name matching (up to four words) to qualify arbitrary input as a booking-detail reply. With a pre-existing booking draft, a company question or refusal was therefore parsed as incomplete booking details and received a date/time prompt instead of reaching the conversation router, retrieval, and AI. Booking refusals were not handled as a distinct state transition. Separately, inbound preparation advanced an existing opportunity intake even when current intents had no matching intake type.

## Fix

- Require an explicit name cue or a short, plausible name only when no saved name exists; reject question-shaped and common non-name replies.
- Let unrelated messages leave the pending-booking handler. A natural refusal clears only the unfinished booking draft and confirms that no appointment request will continue.
- Advance and emit opportunity-intake state only when the current message matches an intake intent.

## Verification

- `npm test`: 95 passed, 0 failed.
- `npm run eval:conversation`: 5 live retrieval/provider scenarios passed using the WhatsApp conversation stages. No customer transport message was sent. The Arabic services request did not book or hand over; the Cyprus company setup query used the approved LAMAR entry; Greek output remained Greek.
- Following the REFALCO owner's clarification, an approved revision now records that LAMAR is part of REFALCO GROUP. The outdated revision was rejected, not deleted; the replacement revision was embedded successfully.
- Before: logged route preparation 2.47–2.83 s, then a 0.62–0.65 s booking gate for intercepted turns. Total was not instrumented on those early-return turns; send-time estimates are approximately 10.8–11.4 s and include downstream processing/delivery. The first greeting recorded 8.43 s total.
- After the corrected knowledge revision: live evaluation average 2.62 s (n=5); warm responses 1.47–1.76 s. Stage averages: route 8 ms, booking gate 1 ms, embedding 392 ms, retrieval 722 ms, model 1.50 s. First cold embedding initialization was 1.94 s; other embedding calls were 4–5 ms. The cold run also had a 3.82 s model call. These figures are not a strict same-turn comparison because the prior bad path bypassed retrieval and generation.

## Limitations

- The selected transcript does not contain the separately reported Arabic name-capture failure; tests cover the Arabic full-greeting pattern, but its historical capture event is not evidenced by these four turns.
- The WhatsApp worker was stopped and restarted at the owner's request; the dashboard reports it reconnected. No customer message was sent.
- LAMAR's published €999 + VAT package is now attributed to LAMAR within REFALCO GROUP, based on the owner's confirmation. The posted price and scope may change, so current applicability still needs confirmation.
