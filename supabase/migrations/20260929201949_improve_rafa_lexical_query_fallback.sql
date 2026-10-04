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
    select
      websearch_to_tsquery('simple', left(coalesce(p_query, ''), 1000)) as required_query,
      coalesce((
        select string_agg(terms.value::text, ' | ')::tsquery
        from (
          select distinct plainto_tsquery('simple', token.value) as value
          from regexp_split_to_table(left(coalesce(p_query, ''), 1000), '[^[:alnum:]_]+') as token(value)
          where token.value <> ''
        ) as terms
        where numnode(terms.value) > 0
      ), ''::tsquery) as fallback_query
  )
  select s.id, d.id, s.display_name, s.canonical_url, d.title, c.heading,
         c.content,
         case when c.search_vector @@ q.required_query
           then ts_rank_cd(c.search_vector, q.required_query)::real
           else ts_rank_cd(c.search_vector, q.fallback_query)::real
         end
  from public.rafa_knowledge_chunks c
  join public.rafa_knowledge_documents d on d.id = c.document_id
  join public.rafa_knowledge_sources s on s.id = d.source_id
  cross join query q
  where length(trim(coalesce(p_query, ''))) > 0
    and s.enabled and s.approved
    and d.review_status = 'approved'
    and (d.valid_until is null or d.valid_until > now())
    and (c.search_vector @@ q.required_query or c.search_vector @@ q.fallback_query)
  order by
    case when c.search_vector @@ q.required_query
      then ts_rank_cd(c.search_vector, q.required_query)
      else ts_rank_cd(c.search_vector, q.fallback_query)
    end desc,
    d.fetched_at desc,
    c.chunk_index
  limit least(greatest(coalesce(p_match_count, 6), 1), 20);
$$;

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
    select
      websearch_to_tsquery('simple', left(coalesce(p_query, ''), 1000)) as required_query,
      coalesce((
        select string_agg(terms.value::text, ' | ')::tsquery
        from (
          select distinct plainto_tsquery('simple', token.value) as value
          from regexp_split_to_table(left(coalesce(p_query, ''), 1000), '[^[:alnum:]_]+') as token(value)
          where token.value <> ''
        ) as terms
        where numnode(terms.value) > 0
      ), ''::tsquery) as fallback_query
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
    select e.id,
      row_number() over (
        order by case when e.search_vector @@ q.required_query
          then ts_rank_cd(e.search_vector, q.required_query)
          else ts_rank_cd(e.search_vector, q.fallback_query)
        end desc, e.chunk_index
      ) as position
    from eligible e cross join query q
    where e.search_vector @@ q.required_query or e.search_vector @@ q.fallback_query
    order by case when e.search_vector @@ q.required_query
      then ts_rank_cd(e.search_vector, q.required_query)
      else ts_rank_cd(e.search_vector, q.fallback_query)
    end desc, e.chunk_index
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

revoke all on function public.rafa_search_knowledge(text, integer) from public, authenticated;
grant execute on function public.rafa_search_knowledge(text, integer) to anon;
revoke all on function public.rafa_hybrid_search_knowledge(text, extensions.halfvec, text, integer) from public, authenticated;
grant execute on function public.rafa_hybrid_search_knowledge(text, extensions.halfvec, text, integer) to anon;
