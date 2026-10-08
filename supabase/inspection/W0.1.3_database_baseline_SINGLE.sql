-- =============================================================================
-- W0.1.3 — DATABASE BASELINE, SINGLE STATEMENT EDITION  (P0.1, milestone M0)
-- =============================================================================
-- READ ONLY. One SELECT. No INSERT, UPDATE, DELETE, DDL or DO block.
--
-- WHY THIS FILE EXISTS, ON TOP OF W0.1.3_database_baseline.sql
--   The original file is ten separate SELECT statements. The Supabase SQL
--   editor returns only the result of the LAST statement in a batch, so a run
--   on 2026-10-08 came back with block 10 alone and blocks 01..09 were
--   discarded by the editor, not by the database.
--   This edition folds all ten checks into ONE statement, so a single run
--   returns every check in one table.
--
--   The original file is kept and is still correct. Use it when running the
--   blocks one at a time; use this one for a single paste-and-run.
--
-- HOW TO RUN
--   Paste into the Supabase SQL editor, run, and send back the whole grid.
--   Output shape is uniform: check_name | item | detail (jsonb).
--
-- ASSUMPTION, EVIDENCED
--   rafa_knowledge_sources, rafa_knowledge_documents and rafa_knowledge_chunks
--   are referenced directly rather than behind to_regclass(), because a
--   to_regclass() guard in a WHERE clause does not prevent a PARSE-time error
--   for a missing table. The 2026-10-08 run executed the whole batch through to
--   statement 10 without error, which proves all three tables exist. If that
--   ever stops being true this statement will error instead of returning no
--   rows, and the original ten-block file should be used instead.
--
-- SCHEMA NOTES (verified against supabase/migrations, 2026-10-08)
--   rafa_knowledge_sources   : canonical_url (unique), trust_tier, source_kind,
--                              approved, enabled
--   rafa_knowledge_documents : source_id FK, language_code, review_status,
--                              valid_until, approved_at, revision
--   canonical_url lives on SOURCES, not on DOCUMENTS.
--   The language column is language_code, not lang.
-- =============================================================================

with

-- 1. Which of the expected tables actually exist?
--    BLK-12 claims "no dynamic commercial tables exist at all". This confirms
--    or refutes it, and tells M4 what it is starting from.
t01 as (
  select
    '01_table_presence'                                      as check_name,
    t.expected_table                                         as item,
    jsonb_build_object(
      'exists_now', to_regclass('public.' || t.expected_table) is not null
    )                                                        as detail
  from (values
    -- knowledge corpus (M3)
    ('rafa_knowledge_sources'),
    ('rafa_knowledge_documents'),
    ('rafa_knowledge_chunks'),
    -- conversation / CRM (M8). Verified names, 2026-10-08: an earlier version of
    -- this list guessed 'rafa_agent_chat', which does not exist. These three do.
    ('rafa_agent_sessions'),
    ('rafa_agent_messages'),
    ('rafa_agent_memories'),
    -- the six dynamic commercial tables MB-DYN1..6 requires (M4, BLK-12)
    ('refal_offers_and_pricing'),
    ('refal_company_profile'),
    ('refal_service_catalogue'),
    ('refal_jurisdiction_benchmarks'),
    ('refal_property_inventory'),
    ('refal_team_and_contacts')
  ) as t(expected_table)
),

-- 2. Corpus size against the P0.4 target of 87 sources (29 topics x 3 languages).
t02 as (
  select
    '02_corpus_size'                                         as check_name,
    'counts'                                                 as item,
    jsonb_build_object(
      'total_sources',       (select count(*) from public.rafa_knowledge_sources),
      'approved_sources',    (select count(*) from public.rafa_knowledge_sources where approved),
      'enabled_sources',     (select count(*) from public.rafa_knowledge_sources where enabled),
      'total_documents',     (select count(*) from public.rafa_knowledge_documents),
      'approved_documents',  (select count(*) from public.rafa_knowledge_documents where review_status = 'approved'),
      'total_chunks',        (select count(*) from public.rafa_knowledge_chunks),
      'target_sources',      87
    )                                                        as detail
),

-- 3. review_status distribution.
--    The CHECK constraint allows pending / approved / rejected / superseded, so
--    the SCHEMA supports a review workflow. CR-014 says the save path writes
--    'approved' directly and DELETEs everything else. If this returns only
--    'approved', the code is bypassing a governance capability the schema
--    already has, which makes P3.9 a smaller job than it looks.
t03 as (
  select
    '03_review_status'                                       as check_name,
    coalesce(review_status, '(null)')                        as item,
    jsonb_build_object('row_count', count(*))                as detail
  from public.rafa_knowledge_documents
  group by review_status
),

-- 4. Freshness and expiry.
--    CR-011 / BLK-10: price-bearing approved revisions auto-expire after 30
--    days. Rows already expired mean REFAL cannot confirm the EUR 999 offer
--    right now.
t04 as (
  select
    '04_expiry_state'                                        as check_name,
    'expiry'                                                 as item,
    jsonb_build_object(
      'total_documents',  count(*),
      'no_expiry',        count(*) filter (where valid_until is null),
      'already_expired',  count(*) filter (where valid_until <= now()),
      'still_valid',      count(*) filter (where valid_until >  now()),
      'earliest_expiry',  min(valid_until),
      'latest_expiry',    max(valid_until)
    )                                                        as detail
  from public.rafa_knowledge_documents
),

-- 5. Language coverage.
--    Directly relevant to FIX-7 (Arabic retrieval returns zero) and FIX-8
--    (Greek coverage gaps). If ar/el rows are simply absent, those are a
--    CONTENT gap, not a retrieval-quality gap, and M3 should be sequenced
--    before any retrieval tuning. See the hypothesis in KNOWN-DEFECTS.md.
t05 as (
  select
    '05_language_coverage'                                   as check_name,
    coalesce(language_code, '(null)')                        as item,
    jsonb_build_object(
      'documents',          count(*),
      'approved_documents', count(*) filter (where review_status = 'approved')
    )                                                        as detail
  from public.rafa_knowledge_documents
  group by language_code
),

-- 6. canonical_url shape on SOURCES.
--    P0.4 froze the scheme refal://kb/<domain>/<slug>/<lang>. canonical_url is
--    UNIQUE NOT NULL, so a pre-existing collision would break ingestion.
t06 as (
  select
    '06_canonical_url_scheme'                                as check_name,
    case
      when canonical_url like 'refal://kb/%' then 'matches new refal://kb scheme'
      when canonical_url like 'http%'        then 'http(s) url'
      else 'other'
    end                                                      as item,
    jsonb_build_object(
      'row_count', count(*),
      'example',   min(canonical_url)
    )                                                        as detail
  from public.rafa_knowledge_sources
  group by 2
),

-- 7. Existing trust_tier values on SOURCES.
--    CONFLICT TO RESOLVE (CR-023). The database already constrains trust_tier to
--    ('official', 'first_party', 'secondary', 'operator_supplied').
--    P0.4 froze a DIFFERENT set in src/brainTaxonomy.js:
--    ('regulated', 'commercial', 'explanatory').
--    These describe different things: the DB tier describes WHERE a fact came
--    from, the taxonomy tier describes HOW MUCH provenance Rule 2 demands.
--    P3.9 must decide whether to map, extend the CHECK, or keep both as
--    separate columns. This block measures which DB values are actually in use.
t07 as (
  select
    '07_trust_tier_usage'                                    as check_name,
    coalesce(trust_tier, '(null)') || ' / ' || coalesce(source_kind, '(null)') as item,
    jsonb_build_object('row_count', count(*))                as detail
  from public.rafa_knowledge_sources
  group by trust_tier, source_kind
),

-- 8. Indexes on the knowledge tables.
--    CR-010 expects the partial unique index
--    rafa_knowledge_documents_one_approved_per_source_idx to be present.
t08 as (
  select
    '08_indexes'                                             as check_name,
    tablename || '.' || indexname                            as item,
    jsonb_build_object('indexdef', indexdef)                 as detail
  from pg_indexes
  where schemaname = 'public'
    and (tablename like 'rafa_%' or tablename like 'refal_%')
),

-- 9. Row level security posture.
--    Needed before M13, and before any new table is added in M4.
t09 as (
  select
    '09_rls'                                                 as check_name,
    c.relname                                                as item,
    jsonb_build_object(
      'rls_enabled',  c.relrowsecurity,
      'rls_forced',   c.relforcerowsecurity,
      'policy_count', (select count(*) from pg_policies p
                        where p.schemaname = 'public' and p.tablename = c.relname)
    )                                                        as detail
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
),

-- 10. Environment: version and extensions.
--     pgvector presence decides whether the M3 embedding pipeline needs any
--     extension work at all.
t10 as (
  select
    '10_environment'                                         as check_name,
    'environment'                                            as item,
    jsonb_build_object(
      'pg_version',    version(),
      'database_name', current_database(),
      'extensions',    (select string_agg(extname || ' ' || extversion, ', ' order by extname)
                          from pg_extension)
    )                                                        as detail
)

select check_name, item, detail
from (
  select * from t01
  union all select * from t02
  union all select * from t03
  union all select * from t04
  union all select * from t05
  union all select * from t06
  union all select * from t07
  union all select * from t08
  union all select * from t09
  union all select * from t10
) all_checks
order by check_name, item;

-- =============================================================================
-- END. No ROLLBACK block is required: this file performs no writes.
-- =============================================================================
