-- One authorization predicate for search and complete-section expansion.
-- Pending register annotations do not impose a second approval requirement;
-- explicit owner blocks still exclude their linked sections.
create or replace function public.rafa_knowledge_revision_is_current(p_document_id uuid)
returns boolean language sql stable security invoker set search_path = '' as $function$
select exists (
  select 1 from public.rafa_knowledge_documents d
  join public.rafa_knowledge_sources s on s.id=d.source_id
  where d.id=p_document_id and s.enabled and s.approved and d.review_status='approved'
    and (d.valid_until is null or d.valid_until>now())
    and not exists (select 1 from public.rafa_knowledge_documents newer
      where newer.source_id=d.source_id and newer.review_status='approved' and newer.revision>d.revision)
    and (d.canonical_content !~* '(?:[$€£][[:space:]]*[0-9٠-٩]|(?:EUR|USD|GBP)[[:space:]]*[0-9٠-٩]|[0-9٠-٩][0-9٠-٩.,[:space:]]*(?:EUR|USD|GBP|euros?|dollars?|pounds?|يورو|دولار|جنيه|ευρώ))'
      or (d.valid_until is not null and d.valid_until>now()))
);
$function$;
revoke all on function public.rafa_knowledge_revision_is_current(uuid) from public;
grant execute on function public.rafa_knowledge_revision_is_current(uuid) to anon,authenticated,service_role;

create or replace function public.rafa_knowledge_chunk_is_allowed(p_chunk_id uuid)
returns boolean language sql stable security invoker set search_path = '' as $function$
select exists (
  select 1 from public.rafa_knowledge_chunks anchor
  where anchor.id=p_chunk_id and public.rafa_knowledge_revision_is_current(anchor.document_id)
    and not exists (
      select 1 from public.rafa_knowledge_chunks sibling
      cross join lateral jsonb_array_elements_text(
        (case when jsonb_typeof(sibling.metadata->'facts')='array' then sibling.metadata->'facts' else '[]'::jsonb end)
        || (case when jsonb_typeof(sibling.metadata->'supporting')='array' then sibling.metadata->'supporting' else '[]'::jsonb end)
      ) linked(fact_id)
      join public.refal_fact_register fact on fact.fact_id=linked.fact_id and fact.status='blocked'
      where sibling.document_id=anchor.document_id
        and (sibling.id=anchor.id or (anchor.metadata->>'sectionIndex' is not null
          and sibling.metadata->>'sectionIndex'=anchor.metadata->>'sectionIndex'))
    )
);
$function$;
revoke all on function public.rafa_knowledge_chunk_is_allowed(uuid) from public;
grant execute on function public.rafa_knowledge_chunk_is_allowed(uuid) to anon,authenticated,service_role;

do $migration$
declare target regprocedure; definition text; updated text;
begin
  foreach target in array array[
    'public.rafa_search_knowledge(text,integer)'::regprocedure,
    'public.rafa_hybrid_search_knowledge(text,extensions.halfvec,text,integer)'::regprocedure,
    'public.rafa_expand_knowledge_sections(uuid[],integer)'::regprocedure
  ] loop
    definition := pg_get_functiondef(target);
    updated := regexp_replace(definition,
      's[.]enabled and s[.]approved and d[.]review_status[[:space:]]*=[[:space:]]*''approved''',
      's.enabled and s.approved and d.review_status=''approved'' and public.rafa_knowledge_revision_is_current(d.id) and public.rafa_knowledge_chunk_is_allowed(c.id)', 'g');
    if updated=definition then raise exception 'Authorization predicate not found in %',target; end if;
    -- Alias similarity identifies a document, not a claim in its first section.
    -- Discount this discovery score so actual passage matches rank ahead of it.
    updated := replace(updated,'f.score-1e-6::real','f.score*0.35::real');
    updated := replace(updated,'m.score-1e-6::real','m.score*0.35::real');
    -- Apply current-revision gates before expansion's bounded window too.
    updated := replace(updated, 'where c.metadata->>''kind'' <> ''aliases''',
      'where coalesce(c.metadata->>''kind'','''') <> ''aliases'' and public.rafa_knowledge_chunk_is_allowed(c.id)');
    updated := replace(updated, 'and c.metadata->>''kind'' <> ''aliases''',
      'and coalesce(c.metadata->>''kind'','''') <> ''aliases''');
    execute updated;
  end loop;
end;
$migration$;
