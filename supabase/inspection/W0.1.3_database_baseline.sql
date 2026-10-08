-- =============================================================================
-- W0.1.3 — DATABASE BASELINE  (P0.1, milestone M0)
-- =============================================================================
-- READ ONLY. Contains no INSERT, UPDATE, DELETE, DDL or DO block.
-- Every statement is a SELECT. Running this cannot change anything.
--
-- WHY THIS FILE EXISTS
--   Per BOSS's protocol of 2026-10-08, the agent session does not open a live
--   Supabase connection. The baseline is written here, BOSS runs it, and the
--   output is pasted back and recorded in section 16 of the master plan.
--
-- HOW TO RUN
--   Paste into the Supabase SQL editor and run. Send back all 10 result blocks;
--   each carries a `check_name` column so the blocks stay identifiable.
--
-- SCHEMA NOTES (verified against supabase/migrations, 2026-10-08)
--   rafa_knowledge_sources   : canonical_url (unique), trust_tier, approved, enabled
--   rafa_knowledge_documents : source_id FK, language_code, review_status,
--                              valid_until, approved_at, revision
--   canonical_url lives on SOURCES, not on DOCUMENTS.
--   The language column is language_code, not lang.
--
-- SAFETY
--   to_regclass() guards every table reference, so a missing table yields no
--   rows rather than an error. The script runs to completion either way.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Which of the expected tables actually exist?
--    BLK-12 claims "no dynamic commercial tables exist at all". This confirms
--    or refutes it, and tells M4 what it is starting from.
-- -----------------------------------------------------------------------------
select
  '01_table_presence' as check_name,
  t.expected_table,
  to_regclass('public.' || t.expected_table) is not null as exists_now
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
order by exists_now desc, t.expected_table;


-- -----------------------------------------------------------------------------
-- 2. Corpus size against the P0.4 target of 87 sources (29 topics x 3 languages).
-- -----------------------------------------------------------------------------
select
  '02_corpus_size' as check_name,
  (select count(*) from public.rafa_knowledge_sources)                                   as total_sources,
  (select count(*) from public.rafa_knowledge_sources where approved)                    as approved_sources,
  (select count(*) from public.rafa_knowledge_sources where enabled)                     as enabled_sources,
  (select count(*) from public.rafa_knowledge_documents)                                 as total_documents,
  (select count(*) from public.rafa_knowledge_documents where review_status = 'approved') as approved_documents,
  (select count(*) from public.rafa_knowledge_chunks)                                    as total_chunks,
  87                                                                                      as target_sources
where to_regclass('public.rafa_knowledge_sources') is not null
  and to_regclass('public.rafa_knowledge_documents') is not null
  and to_regclass('public.rafa_knowledge_chunks') is not null;


-- -----------------------------------------------------------------------------
-- 3. review_status distribution.
--    The CHECK constraint allows pending / approved / rejected / superseded, so
--    the SCHEMA supports a review workflow. CR-014 says the save path writes
--    'approved' directly and DELETEs everything else. If this returns only
--    'approved', the code is bypassing a governance capability the schema
--    already has, which makes P3.9 a smaller job than it looks.
-- -----------------------------------------------------------------------------
select
  '03_review_status' as check_name,
  review_status,
  count(*) as row_count
from public.rafa_knowledge_documents
where to_regclass('public.rafa_knowledge_documents') is not null
group by review_status
order by row_count desc;


-- -----------------------------------------------------------------------------
-- 4. Freshness and expiry.
--    CR-011 / BLK-10: price-bearing approved revisions auto-expire after 30
--    days. Rows already expired mean REFAL cannot confirm the EUR 999 offer
--    right now.
-- -----------------------------------------------------------------------------
select
  '04_expiry_state' as check_name,
  count(*)                                     as total_documents,
  count(*) filter (where valid_until is null)  as no_expiry,
  count(*) filter (where valid_until <= now()) as already_expired,
  count(*) filter (where valid_until > now())  as still_valid,
  min(valid_until)                             as earliest_expiry,
  max(valid_until)                             as latest_expiry
from public.rafa_knowledge_documents
where to_regclass('public.rafa_knowledge_documents') is not null;


-- -----------------------------------------------------------------------------
-- 5. Language coverage.
--    Directly relevant to FIX-7 (Arabic retrieval returns zero) and FIX-8
--    (Greek coverage gaps). If ar/el rows are simply absent, those are a
--    CONTENT gap, not a retrieval-quality gap, and M3 should be sequenced
--    before any retrieval tuning. See the hypothesis in KNOWN-DEFECTS.md.
-- -----------------------------------------------------------------------------
select
  '05_language_coverage' as check_name,
  coalesce(language_code, '(null)') as language_code,
  count(*)                          as documents,
  count(*) filter (where review_status = 'approved') as approved_documents
from public.rafa_knowledge_documents
where to_regclass('public.rafa_knowledge_documents') is not null
group by language_code
order by documents desc;


-- -----------------------------------------------------------------------------
-- 6. canonical_url shape on SOURCES.
--    P0.4 froze the scheme refal://kb/<domain>/<slug>/<lang>. canonical_url is
--    UNIQUE NOT NULL, so a pre-existing collision would break ingestion.
-- -----------------------------------------------------------------------------
select
  '06_canonical_url_scheme' as check_name,
  case
    when canonical_url like 'refal://kb/%' then 'matches new refal://kb scheme'
    when canonical_url like 'http%'        then 'http(s) url'
    else 'other'
  end                as url_shape,
  count(*)           as row_count,
  min(canonical_url) as example
from public.rafa_knowledge_sources
where to_regclass('public.rafa_knowledge_sources') is not null
group by url_shape
order by row_count desc;


-- -----------------------------------------------------------------------------
-- 7. Existing trust_tier values on SOURCES.
--    ⚠ CONFLICT TO RESOLVE. The database already constrains trust_tier to
--    ('official', 'first_party', 'secondary', 'operator_supplied').
--    P0.4 froze a DIFFERENT set in src/brainTaxonomy.js:
--    ('regulated', 'commercial', 'explanatory').
--    These describe different things: the DB tier describes WHERE a fact came
--    from, the taxonomy tier describes HOW MUCH provenance Rule 2 demands.
--    P3.9 must decide whether to map, extend the CHECK, or keep both as
--    separate columns. This block measures which DB values are actually in use.
-- -----------------------------------------------------------------------------
select
  '07_trust_tier_usage' as check_name,
  trust_tier,
  source_kind,
  count(*) as row_count
from public.rafa_knowledge_sources
where to_regclass('public.rafa_knowledge_sources') is not null
group by trust_tier, source_kind
order by row_count desc;


-- -----------------------------------------------------------------------------
-- 8. Indexes on the knowledge tables.
--    CR-010 expects the partial unique index
--    rafa_knowledge_documents_one_approved_per_source_idx to be present.
-- -----------------------------------------------------------------------------
select
  '08_indexes' as check_name,
  tablename,
  indexname,
  indexdef
from pg_indexes
where schemaname = 'public'
  and (tablename like 'rafa_%' or tablename like 'refal_%')
order by tablename, indexname;


-- -----------------------------------------------------------------------------
-- 9. Row level security posture.
--    Needed before M13, and before any new table is added in M4.
-- -----------------------------------------------------------------------------
select
  '09_rls' as check_name,
  c.relname             as table_name,
  c.relrowsecurity      as rls_enabled,
  c.relforcerowsecurity as rls_forced,
  (select count(*) from pg_policies p
    where p.schemaname = 'public' and p.tablename = c.relname) as policy_count
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
order by c.relname;


-- -----------------------------------------------------------------------------
-- 10. Environment: version and extensions.
--     pgvector presence decides whether the M3 embedding pipeline needs any
--     extension work at all.
-- -----------------------------------------------------------------------------
select
  '10_environment' as check_name,
  version()          as pg_version,
  current_database() as database_name,
  (select string_agg(extname || ' ' || extversion, ', ' order by extname)
     from pg_extension) as extensions;

-- =============================================================================
-- END. No ROLLBACK block is required: this file performs no writes.
-- =============================================================================
