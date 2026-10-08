# Database actions for BOSS — M0 handoff

**Produced:** 2026-10-08 at the end of M0 · **Blocks:** closing P0.1, and starting M1 cleanly.

## Short version

**M0 requires no schema change.** M0 is an audit milestone: it reads, measures and records. It does not alter the database.

There is exactly **one** file to run, and it is **read only**.

| # | File | Type | Risk | Why |
| --- | --- | --- | --- | --- |
| 1 | `W0.1.3_database_baseline.sql` | read-only inspection | **none** — all SELECT, no writes | Closes the last open wave of P0.1 |

No migration is pending. Nothing in M0 writes to the database.

## What to run

Paste `W0.1.3_database_baseline.sql` into the Supabase SQL editor and run it. Send back all **10 result blocks**; each row carries a `check_name` column so the blocks stay identifiable once pasted.

### Why it is safe

- Every statement is a `SELECT`. There is no `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `TRUNCATE` or `DO` block.
- Every table reference is guarded with `to_regclass(...)`, so a table that does not exist yields no rows instead of an error. The script runs to completion either way.
- No `-- ROLLBACK:` block is included because there is nothing to roll back.

### Before running, note

Two column assumptions were **wrong in the first draft** and were corrected against `supabase/migrations/*.sql` before this file shipped:

- `canonical_url` is on `rafa_knowledge_sources`, **not** `rafa_knowledge_documents`
- the language column is `language_code`, **not** `lang`

If the file still errors on a column name, that means the live schema has drifted from the migrations, which is itself a baseline finding worth sending back.

## What the output decides

| Block | Decides |
| --- | --- |
| 01 table presence | whether BLK-12 ("no dynamic commercial tables exist") is still true, and what M4 starts from |
| 02 corpus size | how far the corpus is from the 87 sources P0.4 froze |
| 03 review_status | whether CR-014 is a write-path fix or a schema redesign. The schema already allows `pending/approved/rejected/superseded` |
| 04 expiry state | whether REFAL can confirm the €999 offer **right now**, or whether rows have silently expired (BLK-10) |
| 05 language coverage | **the big one.** If ar/el rows are simply absent, FIX-7 and FIX-8 are a *content* gap, not a retrieval gap, and M3 must precede any retrieval tuning |
| 06 canonical_url shape | whether the new `refal://kb/...` scheme collides with anything already stored |
| 07 trust_tier usage | feeds CR-023, the two incompatible trust vocabularies |
| 08 indexes | confirms the partial unique index behind CR-010 |
| 09 RLS | security posture before M4 adds tables |
| 10 environment | whether pgvector is present for the M3 embedding pipeline |

## After you send the output back

1. The baseline is recorded in section 16 of `.planning/REFAL-BRAIN-MASTER-PLAN.md`.
2. W0.1.3 flips to covered, and **P0.1 is complete** once you sign off.
3. M0 is then fully closed: P0.2, P0.3 and P0.4 are already done and gate-verified.

## Changes that are NOT in this folder, and why

These were found during M0 but are **owned by later milestones**. They are deliberately not written as migrations yet, because writing a migration before its milestone designs the change is how a schema gets churned twice.

| Finding | Change it will need | Owner |
| --- | --- | --- |
| CR-014 auto-approve on save | the write path must stop forcing `review_status='approved'` and stop deleting non-approved rows | **P3.9** |
| CR-023 trust_tier conflict | a second column for the governance tier, keeping the existing provenance tier intact | **P3.9** |
| BLK-12 no dynamic tables | the six `refal_*` commercial tables | **P4.1** |
| BLK-11 in-process rate limiting | Supabase-backed shared limits | **P13.2** |
