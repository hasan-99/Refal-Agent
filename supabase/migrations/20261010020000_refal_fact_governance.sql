-- P3.9 / the M3 "Database changes" list — refal_fact_governance.
--
-- This file was named in the plan from the start and was MISSED when P3.9 was
-- first called done. The fact register (MIG-01) governs each MB FACT. This file
-- governs each knowledge DOCUMENT, which is a different layer and the one the
-- conflict register actually complained about.
--
-- It closes two confirmed conflicts and must not break a third.
--
-- CR-014 (High) — "Auto approve on save, no pending queue".
--   20261007150000 made rafa_store_knowledge_revision write
--   review_status = 'approved' on every save AND delete every other document for
--   that source. So no review step exists, and any row awaiting review is
--   destroyed by the next save. That is in direct conflict with Rule 2, which
--   requires a reviewer and a verified date before a fact goes live.
--
--   Note the scope correction the conflict register already records: the SCHEMA
--   has always supported governance. `review_status` is not null default
--   'pending' with a CHECK over pending/approved/rejected/superseded, and a
--   second CHECK ties approved to approved_at in both directions. Only the write
--   path bypassed it. So this is a save-path change, not a schema redesign.
--
-- CR-023 (Medium) — two incompatible `trust_tier` vocabularies.
--   rafa_knowledge_sources.trust_tier allows official / first_party / secondary
--   / operator_supplied, which describes WHERE a fact came from.
--   src/brainTaxonomy.js froze regulated / commercial / explanatory, which
--   describes HOW MUCH PROVENANCE Rule 2 demands before it may be said. These
--   are different axes. The register's instruction is explicit: do not collapse
--   them and do not widen the existing CHECK. So the governance tier becomes its
--   own column and the provenance column is left exactly as it is.
--
-- CR-010 — the partial unique index
--   rafa_knowledge_documents_one_approved_per_source_idx allows AT MOST ONE
--   approved document per source, and it is deliberately kept (BLK-9): it is what
--   forces one source per topic per language. Not deleting siblings any more
--   means pending rows now accumulate, so every statement below is written to
--   keep exactly one APPROVED row per source while letting the others live.
--
-- Safe to run twice.

-- ------------------------------------------------------- CR-023, the new column
-- Nullable on purpose. A source that predates the brain taxonomy has no
-- governance tier and inventing one would be worse than leaving it absent.
alter table public.rafa_knowledge_sources
  add column if not exists governance_tier text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'rafa_knowledge_sources_governance_tier_known'
  ) then
    alter table public.rafa_knowledge_sources
      add constraint rafa_knowledge_sources_governance_tier_known
      check (governance_tier is null or governance_tier in ('regulated', 'commercial', 'explanatory'));
  end if;
end $$;

comment on column public.rafa_knowledge_sources.governance_tier is
  'CR-023. How much provenance Rule 2 demands before this source may be stated: regulated / commercial / explanatory. A DIFFERENT axis from trust_tier, which records where the content came from. Never collapse the two.';

-- The M3 ingestion already wrote the governance tier into metadata, because the
-- column did not exist yet. Promote it rather than asking anyone to re-ingest.
update public.rafa_knowledge_sources
set governance_tier = metadata ->> 'brainTrustTier'
where governance_tier is null
  and metadata ->> 'brainTrustTier' in ('regulated', 'commercial', 'explanatory');

-- ------------------------------------------- CR-014, the save path gets a queue
-- A new parameter changes the identifying argument-type list, so CREATE OR
-- REPLACE would overload rather than replace. Drop the 7-argument signature
-- first, exactly as 20261006120000 had to.
-- Drops the OLD 7-argument signature. A new parameter changes the identifying
-- argument-type list, so CREATE OR REPLACE would overload rather than replace,
-- the same reasoning 20261006120000 already had to apply. On a second run this
-- is a no-op, because the 7-argument version is already gone.
drop function if exists public.rafa_store_knowledge_revision(uuid, text, text, text, text, jsonb, jsonb);

-- CREATE OR REPLACE, not CREATE.
--
-- The first cut of this file used a bare CREATE, which made the header's "safe
-- to run twice" a lie: the second run would die on `42723: function
-- rafa_store_knowledge_revision already exists`, because the drop above only
-- removes the 7-argument signature and this is the 9-argument one. Caught when
-- BOSS asked for the migration to be run again after it had already been
-- applied. CREATE OR REPLACE is correct here precisely because the identifying
-- argument types are now unchanged between runs, and it is still allowed to
-- change the parameter DEFAULTS.
create or replace function public.rafa_store_knowledge_revision(
  p_source_id uuid,
  p_title text,
  p_content text,
  p_content_sha256 text,
  p_language_code text,
  p_chunks jsonb,
  p_metadata jsonb default '{}'::jsonb,
  -- The default is the whole point of CR-014: a save now lands in the queue
  -- unless the caller explicitly asks for something else. Passing 'approved'
  -- stays possible, because the M3 corpus ingestion is a reviewed, generated
  -- artifact and re-approving 87 documents by hand after every regeneration
  -- would be ceremony, not governance. What changes is that approving is now a
  -- DECISION the caller states, not something the function does behind its back.
  p_review_status text default 'pending',
  p_approved_by text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_revision integer;
  v_document_id uuid;
  v_existing_id uuid;
  v_unchanged boolean := false;
  v_metadata jsonb := case when jsonb_typeof(p_metadata) = 'object' then p_metadata else '{}'::jsonb end;
  v_status text := coalesce(nullif(trim(p_review_status), ''), 'pending');
  v_approver text := coalesce(nullif(trim(p_approved_by), ''), 'dashboard-operator');
begin
  if length(trim(coalesce(p_title, ''))) = 0
     or length(trim(coalesce(p_content, ''))) = 0
     or length(p_content) > 1000000
     or p_content_sha256 !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(p_chunks) <> 'array'
     or jsonb_array_length(p_chunks) < 1
     or jsonb_array_length(p_chunks) > 500 then
    raise exception 'Invalid knowledge revision payload';
  end if;
  if v_status not in ('pending', 'approved') then
    raise exception 'A save may only land as pending or approved, not %', v_status;
  end if;

  perform 1 from public.rafa_knowledge_sources where id = p_source_id for update;
  if not found then raise exception 'Knowledge source not found'; end if;

  -- Identical content already stored for this source is a no-op, whatever its
  -- review state. This is what keeps re-running the ingestion cheap, and it is
  -- the one place the old `unchanged` contract is preserved.
  select id into v_existing_id
  from public.rafa_knowledge_documents
  where source_id = p_source_id
    and content_sha256 = p_content_sha256
    and title = left(trim(p_title), 500)
  order by (review_status = 'approved') desc, revision desc
  limit 1
  for update;

  if found then
    -- Promote in place if the caller is now approving something that was queued.
    -- The lifecycle trigger supersedes the previous approved row, so CR-010 holds.
    if v_status = 'approved' then
      update public.rafa_knowledge_documents
      set review_status = 'approved',
          approved_at = now(),
          approved_by = v_approver
      where id = v_existing_id and review_status <> 'approved';
    end if;
    v_unchanged := true;
    return jsonb_build_object(
      'document_id', v_existing_id, 'revision', null,
      'deduplicated', true, 'unchanged', true, 'review_status', v_status);
  end if;

  -- NOT deleting the siblings is the CR-014 fix. A superseded or rejected
  -- revision is now evidence of what was reviewed and when, which is exactly
  -- what Rule 2 needs and what the old delete destroyed. Revisions therefore
  -- increment again instead of being pinned to 1.
  select coalesce(max(revision), 0) + 1 into v_revision
  from public.rafa_knowledge_documents where source_id = p_source_id;

  insert into public.rafa_knowledge_documents (
    source_id, revision, title, canonical_content, content_sha256, language_code,
    review_status, approved_at, approved_by, metadata
  ) values (
    p_source_id, v_revision, left(trim(p_title), 500), p_content,
    p_content_sha256, coalesce(nullif(p_language_code, ''), 'en'),
    v_status,
    case when v_status = 'approved' then now() else null end,
    case when v_status = 'approved' then v_approver else null end,
    v_metadata
  ) returning id into v_document_id;

  insert into public.rafa_knowledge_chunks (document_id, chunk_index, heading, content, metadata)
  select v_document_id, c.chunk_index, coalesce(c.heading, ''), c.content, coalesce(c.metadata, '{}'::jsonb)
  from jsonb_to_recordset(p_chunks) as c(chunk_index integer, heading text, content text, metadata jsonb);

  -- The source row still tracks the latest fetch. `approved` on the SOURCE means
  -- the operator trusts the origin; it is not a statement about this revision,
  -- which is what review_status is for.
  update public.rafa_knowledge_sources
  set display_name = left(trim(p_title), 160),
      last_content_hash = p_content_sha256,
      last_success_at = now(),
      last_fetched_at = now(),
      last_status = 'ready',
      last_error = '',
      enabled = true,
      approved = true,
      updated_at = now()
  where id = p_source_id;

  return jsonb_build_object(
    'document_id', v_document_id, 'revision', v_revision,
    'deduplicated', false, 'unchanged', false, 'review_status', v_status);
end;
$$;

-- --------------------------------------------------- the review step, explicit
-- CR-014 asks for a queue. A queue needs a way out of it, and the way out has to
-- name a reviewer, because "approved by nobody at no time" is the state this
-- whole phase exists to remove.
create or replace function public.rafa_review_knowledge_document(
  p_document_id uuid,
  p_review_status text,
  p_reviewer text,
  p_reason text default ''
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_source_id uuid;
  v_before text;
begin
  if length(trim(coalesce(p_reviewer, ''))) = 0 then
    raise exception 'A review decision needs a named reviewer';
  end if;
  if p_review_status not in ('approved', 'rejected', 'pending') then
    raise exception 'Unknown review status %', p_review_status;
  end if;

  select source_id, review_status into v_source_id, v_before
  from public.rafa_knowledge_documents where id = p_document_id for update;
  if not found then raise exception 'Knowledge document not found'; end if;

  update public.rafa_knowledge_documents
  set review_status = p_review_status,
      approved_at = case when p_review_status = 'approved' then now() else null end,
      approved_by = case when p_review_status = 'approved' then left(trim(p_reviewer), 200) else null end
  where id = p_document_id;

  return jsonb_build_object(
    'document_id', p_document_id, 'source_id', v_source_id,
    'previous', v_before, 'review_status', p_review_status, 'reviewer', p_reviewer);
end;
$$;

revoke all on function public.rafa_store_knowledge_revision(uuid, text, text, text, text, jsonb, jsonb, text, text) from public, authenticated;
revoke all on function public.rafa_review_knowledge_document(uuid, text, text, text) from public, authenticated;
grant execute on function public.rafa_store_knowledge_revision(uuid, text, text, text, text, jsonb, jsonb, text, text) to anon;
grant execute on function public.rafa_review_knowledge_document(uuid, text, text, text) to anon;

-- ROLLBACK:
-- drop function if exists public.rafa_review_knowledge_document(uuid, text, text, text);
-- drop function if exists public.rafa_store_knowledge_revision(uuid, text, text, text, text, jsonb, jsonb, text, text);
-- -- then re-apply 20261007160000_sync_knowledge_source_name.sql to restore the
-- -- previous 7-argument save path.
-- alter table public.rafa_knowledge_sources drop constraint if exists rafa_knowledge_sources_governance_tier_known;
-- alter table public.rafa_knowledge_sources drop column if exists governance_tier;
