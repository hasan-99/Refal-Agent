# Rafa security and reliability review — 2026-10-01

## Fixed in this pass

- Removed a hardcoded historical dashboard credential from an old migration (the active deployment already uses hash-backed validation).
- Enabled deny-data-collection/ZDR provider routing for dashboard agent calls; validated request event payload bounds and sanitized unexpected Edge API failures with request IDs.
- Added per-user dashboard agent chat throttling and an input-size bound.
- Sanitized dashboard admin API unexpected errors and sensitive upstream operation details.
- Prevented deterministic company-answer fallbacks from quoting prompt-injection text in retrieved evidence.
- Prevented inbound message receipts from being marked processed when outbound delivery fails, preserving retry behavior.
- Prevented stale reminder content from being sent after an appointment time/status change during job preparation.
- Kept appointment customer confirmation from failing solely because reminder setup failed.
- Added concurrency protection for simultaneous approvals in the single-process deployment.

## Verification

- Bot suite: 61 passed.
- Dashboard suite: 41 passed.
- Dashboard production build: passed. Entry bundle 395.54 kB (114.20 kB gzip), down from 467.23 kB (135.08 kB gzip).
- Root and dashboard dependency audits: zero vulnerabilities.
- `git diff --check`: passed; only line-ending normalization warnings were emitted.
- Supabase `rafa-agent-api` v19 and `rafa-admin-api` v4 deployed ACTIVE with JWT verification enabled.

## Follow-up / residual risk

- Supabase Security Advisor previously reported Auth leaked-password protection disabled. This project setting was not exposed by the connected safe management operations; enable it in Supabase Auth settings.
- Because a credential was present in a historical migration, rotate any still-active credential that may have been derived from it. No secret was exposed in this report.
- The rate limiter and booking approval queue are in-process only, so multi-instance deployments need shared coordination.
- A final status check narrows but cannot eliminate the race between database recheck and WhatsApp send; fully atomic delivery would require an outbox/send protocol.
- The Dashboard logo asset is 598 kB and could be recompressed when an image tool is available.
