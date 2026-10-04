# Rafa optimization pass — 2026-10-01

## Work completed

- Split dashboard Conversations, Performance, and QR-code code into lazy-loaded chunks. The initial route bundle decreased from 467.23 kB (135.08 kB gzip) to 395.54 kB (114.20 kB gzip); feature chunks load only when needed.
- Added a bounded per-user dashboard-agent chat rate limiter (30 requests per 10 minutes; bounded in-memory key map).
- Kept normal conversation responsive during an unfinished booking flow and expire abandoned booking state after 24 hours.
- Serialized concurrent appointment approvals within one dashboard process and added a regression test against duplicate slot booking.
- Added a last-moment appointment status/time check before sending a claimed reminder.
- Kept confirmation successful if reminder queue setup fails, while making the missing reminder explicit to the admin/customer response path.
- Made AI name prompts match the customer's language; tightened outbound answer validation and prompt-injection-safe fallback behavior.

## Remaining scaling considerations

Rate limiting and approval serialization are process-local. If Rafa is horizontally scaled, move both coordination mechanisms to shared Postgres/Redis primitives (and make calendar slot reservation atomic) before adding multiple app workers.

The dashboard mark is a 598 kB PNG; image conversion utilities were unavailable, so it remains a possible asset optimization.
