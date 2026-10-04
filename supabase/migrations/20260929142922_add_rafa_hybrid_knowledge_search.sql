create extension if not exists vector with schema extensions;

alter table public.rafa_knowledge_chunks
  add column if not exists embedding extensions.halfvec(2048),
  add column if not exists embedding_model text,
  add column if not exists embedded_at timestamptz;

create index if not exists rafa_knowledge_chunks_embedding_idx
  on public.rafa_knowledge_chunks using hnsw (embedding extensions.halfvec_cosine_ops)
  where embedding is not null;

create or replace function public.rafa_store_knowledge_embeddings(
  p_document_id uuid,
  p_model text,
  p_embeddings jsonb
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_expected integer;
  v_updated integer;
begin
  if jsonb_typeof(p_embeddings) <> 'array' or jsonb_array_length(p_embeddings) < 1 or jsonb_array_length(p_embeddings) > 500 then
    raise exception 'Invalid embedding batch';
  end if;

  perform 1 from public.rafa_knowledge_documents where id = p_document_id for update;
  if not found then raise exception 'Knowledge revision not found'; end if;

  select count(*) into v_expected from public.rafa_knowledge_chunks where document_id = p_document_id;
  if jsonb_array_length(p_embeddings) <> v_expected then raise exception 'Embedding count does not match revision chunk count'; end if;

  with values_to_store as (
    select e.chunk_index, e.embedding::text::extensions.halfvec(2048) as embedding
    from jsonb_to_recordset(p_embeddings) as e(chunk_index integer, embedding jsonb)
  )
  update public.rafa_knowledge_chunks c
  set embedding = v.embedding, embedding_model = left(p_model, 160), embedded_at = now()
  from values_to_store v
  where c.document_id = p_document_id and c.chunk_index = v.chunk_index;

  get diagnostics v_updated = row_count;
  if v_updated <> v_expected then raise exception 'Embedding chunk indexes do not match revision'; end if;
  return v_updated;
end;
$$;

revoke all on function public.rafa_store_knowledge_embeddings(uuid, text, jsonb) from public, authenticated;
grant execute on function public.rafa_store_knowledge_embeddings(uuid, text, jsonb) to anon;

create or replace function public.rafa_hybrid_search_knowledge(
  p_query text,
  p_embedding extensions.halfvec(2048),
  p_embedding_model text,
  p_match_count integer default 6
)
returns table (
  source_id uuid,
  document_id uuid,
  chunk_id uuid,
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
  ),
  eligible as (
    select c.id, c.document_id, c.chunk_index, c.heading, c.content, c.search_vector, c.embedding, c.embedding_model
    from public.rafa_knowledge_chunks c
    join public.rafa_knowledge_documents d on d.id = c.document_id
    join public.rafa_knowledge_sources s on s.id = d.source_id
    where s.enabled and s.approved and d.review_status = 'approved'
      and (d.valid_until is null or d.valid_until > now())
      and length(trim(coalesce(p_query, ''))) > 0
  ),
  lexical as (
    select e.id, row_number() over (order by ts_rank_cd(e.search_vector, q.value) desc, e.chunk_index) as position
    from eligible e cross join query q
    where e.search_vector @@ q.value
    order by ts_rank_cd(e.search_vector, q.value) desc, e.chunk_index
    limit 30
  ),
  semantic as (
    select e.id, row_number() over (order by e.embedding OPERATOR(extensions.<=>) p_embedding) as position
    from eligible e
    where p_embedding is not null and e.embedding is not null and e.embedding_model = p_embedding_model
      and (e.embedding OPERATOR(extensions.<=>) p_embedding) <= 0.65
    order by e.embedding OPERATOR(extensions.<=>) p_embedding
    limit 30
  ),
  fused as (
    select candidates.id, sum(candidates.score)::real as score
    from (
      select l.id, 1.0 / (60 + l.position) as score from lexical l
      union all
      select sem.id, 1.0 / (60 + sem.position) as score from semantic sem
    ) candidates
    group by candidates.id
  )
  select s.id, d.id, c.id, s.display_name, s.canonical_url, d.title, c.heading, c.content, f.score
  from fused f
  join public.rafa_knowledge_chunks c on c.id = f.id
  join public.rafa_knowledge_documents d on d.id = c.document_id
  join public.rafa_knowledge_sources s on s.id = d.source_id
  order by f.score desc, d.fetched_at desc, c.chunk_index
  limit least(greatest(coalesce(p_match_count, 6), 1), 20);
$$;

revoke all on function public.rafa_hybrid_search_knowledge(text, extensions.halfvec, text, integer) from public, authenticated;
grant execute on function public.rafa_hybrid_search_knowledge(text, extensions.halfvec, text, integer) to anon;
