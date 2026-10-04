drop function if exists public.rafa_search_agent_memories(extensions.halfvec, text, integer);
drop index if exists public.rafa_agent_memories_embedding_idx;
alter table public.rafa_agent_memories
  drop column if exists embedding,
  drop column if exists embedding_model,
  drop column if exists embedded_at,
  add column if not exists search_vector tsvector generated always as (
    to_tsvector('simple', coalesce(label, '') || ' ' || coalesce(content, ''))
  ) stored;

create index if not exists rafa_agent_memories_search_idx
  on public.rafa_agent_memories using gin (search_vector);

create or replace function public.rafa_search_agent_memories(p_query text, p_match_count integer default 5)
returns table(id uuid, label text, content text, pinned boolean, rank real)
language sql stable security invoker set search_path = '' as $$
  with query as (select websearch_to_tsquery('simple', left(coalesce(p_query, ''), 1000)) as value)
  select m.id, m.label, m.content, m.pinned, ts_rank_cd(m.search_vector, q.value)::real
  from public.rafa_agent_memories m cross join query q
  where length(trim(coalesce(p_query, ''))) > 0 and m.search_vector @@ q.value
  order by m.pinned desc, ts_rank_cd(m.search_vector, q.value) desc, m.updated_at desc
  limit least(greatest(coalesce(p_match_count, 5), 1), 20);
$$;

revoke all on function public.rafa_search_agent_memories(text, integer) from public, authenticated;
grant execute on function public.rafa_search_agent_memories(text, integer) to anon;
