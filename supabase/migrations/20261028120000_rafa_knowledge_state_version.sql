-- Knowledge version stamp for the worker's short-lived search cache
-- (RAFA_SEARCH_CACHE). A fingerprint of every field the search RPCs use to
-- decide what is approved, current and unexpired, plus content hashes, so any
-- approval, import, supersede, disable, expiry edit or content edit changes it.
-- Time-only expiry (valid_until passing) needs no stamp change: cached entries
-- never outlive the earliest valid_until among their rows.
-- Read-only, additive. Measured at ~64 ms over 74 chunks on 2026-10-28.
-- Rollback:
--   drop function if exists public.rafa_knowledge_state_version();
create or replace function public.rafa_knowledge_state_version()
returns text
language sql
stable
set search_path = public
as $function$
  select md5(concat_ws('|',
    (select coalesce(string_agg(concat_ws(',', s.id, s.enabled, s.approved, s.updated_at, s.trust_tier, s.governance_tier,
        md5(coalesce(s.metadata::text, ''))), ';' order by s.id), '') from public.rafa_knowledge_sources s),
    (select coalesce(string_agg(concat_ws(',', d.id, d.source_id, d.revision, d.review_status, d.valid_until, d.approved_at,
        d.published_at, d.content_sha256, md5(coalesce(d.metadata::text, ''))), ';' order by d.id), '') from public.rafa_knowledge_documents d),
    (select coalesce(string_agg(concat_ws(',', c.id, c.document_id, c.chunk_index, md5(coalesce(c.heading, '')), md5(c.content),
        md5(coalesce(c.metadata::text, '')), c.embedding_model, c.embedded_at), ';' order by c.id), '') from public.rafa_knowledge_chunks c),
    (select coalesce(string_agg(concat_ws(',', f.fact_id, f.status, f.updated_at, f.expiry_or_review_at, f.approved_languages::text),
        ';' order by f.fact_id), '') from public.refal_fact_register f)
  ));
$function$;

revoke all on function public.rafa_knowledge_state_version() from public;
revoke all on function public.rafa_knowledge_state_version() from anon, authenticated;
grant execute on function public.rafa_knowledge_state_version() to service_role;
