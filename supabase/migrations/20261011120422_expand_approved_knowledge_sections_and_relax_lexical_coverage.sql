-- Preserve approved/current source gates while allowing useful partial lexical
-- matches (especially inflected colloquial Arabic) to rank.
do $migration$
declare
  target regprocedure;
  definition text;
  updated text;
begin
  foreach target in array array[
    'public.rafa_search_knowledge(text,integer)'::regprocedure,
    'public.rafa_hybrid_search_knowledge(text,extensions.halfvec,text,integer)'::regprocedure
  ] loop
    definition := pg_get_functiondef(target);
    updated := replace(definition, ')>=0.6 and', ')>=0.15 and');
    updated := replace(updated, ')>=2)', ')>=1)');
    if updated = definition then
      raise exception 'Expected lexical coverage rule was not found in %', target;
    end if;
    execute updated;
  end loop;
end;
$migration$;

create index if not exists rafa_knowledge_chunks_document_section_order_idx
  on public.rafa_knowledge_chunks (document_id, (metadata->>'sectionIndex'), chunk_index)
  where metadata ? 'sectionIndex';

create or replace function public.rafa_expand_knowledge_sections(p_chunk_ids uuid[], p_max_chunks integer default 80)
returns table(
  source_id uuid, document_id uuid, chunk_id uuid, source_name text, source_url text,
  document_title text, heading text, content text, rank real,
  fetched_at timestamptz, valid_until timestamptz, review_status text,
  approved_at timestamptz, chunk_index integer, chunk_kind text, section_index text
)
language sql
stable
security invoker
set search_path = ''
as $function$
with anchors as (
  select distinct on (c.document_id, coalesce(c.metadata->>'sectionIndex', c.id::text))
    c.id anchor_id, c.document_id, c.metadata->>'sectionIndex' section_index,
    c.metadata->>'topicNumber' topic_number, u.ordinality anchor_order
  from unnest(coalesce(p_chunk_ids, array[]::uuid[])) with ordinality u(id, ordinality)
  join public.rafa_knowledge_chunks c on c.id = u.id
  where c.metadata->>'kind' <> 'aliases'
  order by c.document_id, coalesce(c.metadata->>'sectionIndex', c.id::text), u.ordinality
), expanded as (
  select a.anchor_order, c.document_id, c.id, c.chunk_index
  from anchors a
  join public.rafa_knowledge_chunks c on c.document_id = a.document_id
    and c.metadata->>'kind' <> 'aliases'
    and (
      (a.section_index is not null and c.metadata->>'sectionIndex' = a.section_index
        and coalesce(c.metadata->>'topicNumber','') = coalesce(a.topic_number,''))
      or (a.section_index is null and c.id = a.anchor_id)
    )
), bounded as (
  select e.*, row_number() over(order by e.anchor_order, e.chunk_index, e.id) position
  from expanded e
), eligible as (
  select b.id, b.chunk_index, b.anchor_order,
    c.heading, c.content, coalesce(c.metadata->>'kind','') chunk_kind, c.metadata->>'sectionIndex' section_index,
    d.id document_id, d.source_id, d.title document_title, d.fetched_at, d.valid_until,
    d.review_status, d.approved_at, s.display_name source_name, s.canonical_url source_url
  from bounded b
  join public.rafa_knowledge_chunks c on c.id=b.id
  join public.rafa_knowledge_documents d on d.id=c.document_id
  join public.rafa_knowledge_sources s on s.id=d.source_id
  where b.position <= least(greatest(coalesce(p_max_chunks,80),1),200)
    and s.enabled and s.approved and d.review_status='approved'
    and (d.valid_until is null or d.valid_until>now())
    and (d.canonical_content !~* '(?:[$€£][[:space:]]*[0-9٠-٩]|(?:EUR|USD|GBP)[[:space:]]*[0-9٠-٩]|[0-9٠-٩][0-9٠-٩.,[:space:]]*(?:EUR|USD|GBP|euros?|dollars?|pounds?|يورو|دولار|جنيه|ευρώ))'
      or (d.valid_until is not null and d.valid_until>now()))
)
select e.source_id,e.document_id,e.id,e.source_name,e.source_url,e.document_title,
  e.heading,e.content,(1.0/(60+e.anchor_order))::real,e.fetched_at,e.valid_until,
  e.review_status,e.approved_at,e.chunk_index,e.chunk_kind,e.section_index
from eligible e
order by e.anchor_order,e.chunk_index,e.id;
$function$;

revoke all on function public.rafa_expand_knowledge_sections(uuid[],integer) from public;
grant execute on function public.rafa_expand_knowledge_sections(uuid[],integer) to anon, authenticated, service_role;
