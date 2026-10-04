alter table public.rafa_agent_memories
  add column if not exists embedding extensions.halfvec(2048),
  add column if not exists embedding_model text,
  add column if not exists embedded_at timestamptz;

create index if not exists rafa_agent_memories_embedding_idx
  on public.rafa_agent_memories using hnsw (embedding extensions.halfvec_cosine_ops)
  where embedding is not null;

create or replace function public.rafa_search_agent_memories(
  p_embedding extensions.halfvec(2048),
  p_embedding_model text,
  p_match_count integer default 5
)
returns table(id uuid, label text, content text, pinned boolean, score real)
language sql stable security invoker set search_path = '' as $$
  select m.id, m.label, m.content, m.pinned,
         (1 - (m.embedding OPERATOR(extensions.<=>) p_embedding))::real as score
  from public.rafa_agent_memories m
  where p_embedding is not null and m.embedding is not null
    and m.embedding_model = p_embedding_model
    and (m.embedding OPERATOR(extensions.<=>) p_embedding) <= 0.65
  order by m.embedding OPERATOR(extensions.<=>) p_embedding
  limit least(greatest(coalesce(p_match_count, 5), 1), 20);
$$;

revoke all on function public.rafa_search_agent_memories(extensions.halfvec, text, integer) from public, authenticated;
grant execute on function public.rafa_search_agent_memories(extensions.halfvec, text, integer) to anon;
