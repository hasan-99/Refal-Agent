create or replace function public.rafa_search_knowledge(p_query text,p_match_count integer default 6)
returns table(source_id uuid,document_id uuid,source_name text,source_url text,document_title text,heading text,content text,rank real)
language sql stable security invoker set search_path = '' as $$
with query_terms as (
 select distinct plainto_tsquery('simple',token.value) term from regexp_split_to_table(left(coalesce(p_query,''),1000),'[^[:alnum:]_]+') token(value) where token.value<>''
), q as (
 select websearch_to_tsquery('simple',left(coalesce(p_query,''),1000)) required,
 coalesce((select string_agg(term::text,' | ')::tsquery from query_terms where numnode(term)>0),''::tsquery) broad,
 coalesce((select array_agg(term) from query_terms where numnode(term)>0),array[]::tsquery[]) terms
)
select s.id,d.id,s.display_name,s.canonical_url,d.title,c.heading,c.content,
 case when c.search_vector @@ q.required then ts_rank_cd(c.search_vector,q.required)::real else ts_rank_cd(c.search_vector,q.broad)::real end
from public.rafa_knowledge_chunks c join public.rafa_knowledge_documents d on d.id=c.document_id join public.rafa_knowledge_sources s on s.id=d.source_id cross join q
where length(trim(coalesce(p_query,'')))>0 and s.enabled and s.approved and d.review_status='approved' and (d.valid_until is null or d.valid_until>now())
and (c.search_vector @@ q.required or (c.search_vector @@ q.broad and (select count(*) from unnest(q.terms) term(value) where c.search_vector @@ term.value)>=2))
order by case when c.search_vector @@ q.required then ts_rank_cd(c.search_vector,q.required) else ts_rank_cd(c.search_vector,q.broad) end desc,d.fetched_at desc,c.chunk_index
limit least(greatest(coalesce(p_match_count,6),1),20);
$$;

create or replace function public.rafa_hybrid_search_knowledge(p_query text,p_embedding extensions.halfvec(2048),p_embedding_model text,p_match_count integer default 6)
returns table(source_id uuid,document_id uuid,chunk_id uuid,source_name text,source_url text,document_title text,heading text,content text,rank real)
language sql stable security invoker set search_path = '' as $$
with query_terms as (
 select distinct plainto_tsquery('simple',token.value) term from regexp_split_to_table(left(coalesce(p_query,''),1000),'[^[:alnum:]_]+') token(value) where token.value<>''
), q as (
 select websearch_to_tsquery('simple',left(coalesce(p_query,''),1000)) required,
 coalesce((select string_agg(term::text,' | ')::tsquery from query_terms where numnode(term)>0),''::tsquery) broad,
 coalesce((select array_agg(term) from query_terms where numnode(term)>0),array[]::tsquery[]) terms
), eligible as (
 select c.id,c.document_id,c.chunk_index,c.heading,c.content,c.search_vector,c.embedding,c.embedding_model
 from public.rafa_knowledge_chunks c join public.rafa_knowledge_documents d on d.id=c.document_id join public.rafa_knowledge_sources s on s.id=d.source_id
 where s.enabled and s.approved and d.review_status='approved' and (d.valid_until is null or d.valid_until>now()) and length(trim(coalesce(p_query,'')))>0
), lexical as (
 select e.id,row_number() over(order by case when e.search_vector @@ q.required then ts_rank_cd(e.search_vector,q.required) else ts_rank_cd(e.search_vector,q.broad) end desc,e.chunk_index) position
 from eligible e cross join q
 where e.search_vector @@ q.required or (e.search_vector @@ q.broad and (select count(*) from unnest(q.terms) term(value) where e.search_vector @@ term.value)>=2)
 order by case when e.search_vector @@ q.required then ts_rank_cd(e.search_vector,q.required) else ts_rank_cd(e.search_vector,q.broad) end desc,e.chunk_index limit 30
), semantic as (
 select e.id,row_number() over(order by e.embedding OPERATOR(extensions.<=>) p_embedding) position from eligible e
 where p_embedding is not null and e.embedding is not null and e.embedding_model=p_embedding_model and (e.embedding OPERATOR(extensions.<=>) p_embedding)<=0.65
 order by e.embedding OPERATOR(extensions.<=>) p_embedding limit 30
), fused as (
 select x.id,sum(x.score)::real score from (select l.id,1.0/(60+l.position) score from lexical l union all select a.id,1.0/(60+a.position) score from semantic a) x group by x.id
)
select s.id,d.id,c.id,s.display_name,s.canonical_url,d.title,c.heading,c.content,f.score from fused f
join public.rafa_knowledge_chunks c on c.id=f.id join public.rafa_knowledge_documents d on d.id=c.document_id join public.rafa_knowledge_sources s on s.id=d.source_id
order by f.score desc,d.fetched_at desc,c.chunk_index limit least(greatest(coalesce(p_match_count,6),1),20);
$$;

revoke all on function public.rafa_search_knowledge(text,integer) from public,authenticated;
grant execute on function public.rafa_search_knowledge(text,integer) to anon;
revoke all on function public.rafa_hybrid_search_knowledge(text,extensions.halfvec,text,integer) from public,authenticated;
grant execute on function public.rafa_hybrid_search_knowledge(text,extensions.halfvec,text,integer) to anon;
