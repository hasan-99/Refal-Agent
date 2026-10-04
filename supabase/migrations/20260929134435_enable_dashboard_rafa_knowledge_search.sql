grant select, insert, update, delete on table public.rafa_knowledge_sources to anon;
grant select, insert, update, delete on table public.rafa_knowledge_documents to anon;
grant select, insert, update, delete on table public.rafa_knowledge_chunks to anon;

drop policy if exists rafa_dashboard_knowledge_sources on public.rafa_knowledge_sources;
create policy rafa_dashboard_knowledge_sources
  on public.rafa_knowledge_sources for all to anon
  using (public.rafa_dashboard_secret_matches())
  with check (public.rafa_dashboard_secret_matches());

drop policy if exists rafa_dashboard_knowledge_documents on public.rafa_knowledge_documents;
create policy rafa_dashboard_knowledge_documents
  on public.rafa_knowledge_documents for all to anon
  using (public.rafa_dashboard_secret_matches())
  with check (public.rafa_dashboard_secret_matches());

drop policy if exists rafa_dashboard_knowledge_chunks on public.rafa_knowledge_chunks;
create policy rafa_dashboard_knowledge_chunks
  on public.rafa_knowledge_chunks for all to anon
  using (public.rafa_dashboard_secret_matches())
  with check (public.rafa_dashboard_secret_matches());

create or replace function public.rafa_search_knowledge(p_query text, p_match_count integer default 6)
returns table (
  source_id uuid,
  document_id uuid,
  source_name text,
  source_url text,
  document_title text,
  heading text,
  content text,
  rank real
)
language sql
stable
security invoker
set search_path = ''
as $$
  with query as (
    select websearch_to_tsquery('simple', left(coalesce(p_query, ''), 1000)) as value
  )
  select s.id, d.id, s.display_name, s.canonical_url, d.title, c.heading,
         c.content, ts_rank_cd(c.search_vector, q.value)::real
  from public.rafa_knowledge_chunks c
  join public.rafa_knowledge_documents d on d.id = c.document_id
  join public.rafa_knowledge_sources s on s.id = d.source_id
  cross join query q
  where length(trim(coalesce(p_query, ''))) > 0
    and s.enabled and s.approved
    and d.review_status = 'approved'
    and (d.valid_until is null or d.valid_until > now())
    and c.search_vector @@ q.value
  order by ts_rank_cd(c.search_vector, q.value) desc, d.fetched_at desc, c.chunk_index
  limit least(greatest(coalesce(p_match_count, 6), 1), 20);
$$;

revoke all on function public.rafa_search_knowledge(text, integer) from public, authenticated;
grant execute on function public.rafa_search_knowledge(text, integer) to anon;
