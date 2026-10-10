-- FIX-35 / CF-08. Never compare ts_rank_cd values computed from different
-- tsqueries. A complete query match is measured against the AND query while
-- an allowed partial match is measured against its OR query; those scores can
-- be on different scales and a stopword-heavy partial match can outrank the
-- exact fact. Rank every candidate with the same OR query and put distinct
-- query-term coverage first. The lexical position is then encoded as a single
-- reciprocal-rank score, which is also the scale consumed by hybrid fusion.
-- Eligibility, expiry, approved-source filters, sibling expansion and grants
-- remain the same as the current live functions.

begin;

create or replace function public.rafa_search_knowledge(p_query text,p_match_count integer default 6)
returns table(
  source_id uuid, document_id uuid, chunk_id uuid, source_name text, source_url text,
  document_title text, heading text, content text, rank real,
  fetched_at timestamptz, valid_until timestamptz, review_status text, approved_at timestamptz,
  chunk_index integer, chunk_kind text
)
language sql stable security invoker set search_path = '' as $$
with query_terms as (
 select distinct plainto_tsquery('simple',token.value) term
 from regexp_split_to_table(left(coalesce(p_query,''),1000),'[^[:alnum:]_]+') token(value)
 where token.value<>''
), q as (
 select websearch_to_tsquery('simple',left(coalesce(p_query,''),1000)) required,
 (left(coalesce(p_query,''),1000) !~* '"|(^|[[:space:]])-|[[:space:]]or[[:space:]]') partial_allowed,
 coalesce((select string_agg(term::text,' | ')::tsquery from query_terms where numnode(term)>0),''::tsquery) broad,
 coalesce((select array_agg(term) from query_terms where numnode(term)>0),array[]::tsquery[]) terms
), eligible as (
 select c.id,c.document_id,c.chunk_index,c.heading,c.content,c.search_vector,
        coalesce(c.metadata->>'kind','') chunk_kind,
        d.fetched_at,d.valid_until,d.review_status,d.approved_at,d.source_id
 from public.rafa_knowledge_chunks c
 join public.rafa_knowledge_documents d on d.id=c.document_id
 join public.rafa_knowledge_sources s on s.id=d.source_id
 where s.enabled and s.approved and d.review_status='approved'
   and (d.valid_until is null or d.valid_until>now())
   and (
     d.canonical_content !~* '(?:[$€£][[:space:]]*[0-9٠-٩]|(?:EUR|USD|GBP)[[:space:]]*[0-9٠-٩]|[0-9٠-٩][0-9٠-٩.,[:space:]]*(?:EUR|USD|GBP|euros?|dollars?|pounds?|يورو|دولار|جنيه|ευρώ))'
     or (d.valid_until is not null and d.valid_until>now())
   )
   and length(trim(coalesce(p_query,'')))>0
), scored as (
 select e.id,e.document_id,e.chunk_kind,e.chunk_index,
   coalesce((select count(*)::numeric/nullif(cardinality(q.terms),0)
     from unnest(q.terms) term(value) where e.search_vector @@ term.value),0)::real coverage,
   ts_rank_cd(e.search_vector,q.broad)::real broad_rank,
   (e.search_vector @@ q.required) required_match
 from eligible e cross join q
 where e.search_vector @@ q.required or (q.partial_allowed and e.search_vector @@ q.broad and
   (select count(*)::numeric/nullif(cardinality(q.terms),0) from unnest(q.terms) term(value) where e.search_vector @@ term.value)>=0.6 and
   (select count(*) from unnest(q.terms) term(value) where e.search_vector @@ term.value)>=2)
), ranked as (
 select scored.*,
 row_number() over(order by coverage desc,broad_rank desc,required_match desc,chunk_index,id) position
 from scored
), matched as (
 select id,document_id,chunk_kind,chunk_index,
   (1.0/(60+position))::real score
 from ranked
 where position<=30
), expanded as (
 select m.id,m.score,0 sibling_rank
 from matched m
 where m.chunk_kind<>'aliases'
 union all
 select sib.id,m.score-1e-6::real,
   row_number() over (partition by m.id order by (sib.chunk_kind='fact') desc,sib.chunk_index)
 from matched m
 join eligible sib on sib.document_id=m.document_id and sib.chunk_kind<>'aliases'
 where m.chunk_kind='aliases'
), pruned as (
 select x.id,max(x.score) score from expanded x where x.sibling_rank<=3 group by x.id
)
select s.id,d.id,c.id,s.display_name,s.canonical_url,d.title,c.heading,c.content,p.score,
 d.fetched_at,d.valid_until,d.review_status,d.approved_at,
 c.chunk_index,coalesce(c.metadata->>'kind','')
from pruned p
join public.rafa_knowledge_chunks c on c.id=p.id
join public.rafa_knowledge_documents d on d.id=c.document_id
join public.rafa_knowledge_sources s on s.id=d.source_id
order by p.score desc,d.fetched_at desc,c.chunk_index,c.id
limit least(greatest(coalesce(p_match_count,6),1),20);
$$;

create or replace function public.rafa_hybrid_search_knowledge(
  p_query text,
  p_embedding extensions.halfvec(2048),
  p_embedding_model text,
  p_match_count integer default 6
)
returns table(
  source_id uuid, document_id uuid, chunk_id uuid, source_name text, source_url text,
  document_title text, heading text, content text, rank real,
  fetched_at timestamptz, valid_until timestamptz, review_status text, approved_at timestamptz,
  chunk_index integer, chunk_kind text
)
language sql stable security invoker set search_path = '' as $$
with query_terms as (
 select distinct plainto_tsquery('simple',token.value) term
 from regexp_split_to_table(left(coalesce(p_query,''),1000),'[^[:alnum:]_]+') token(value)
 where token.value<>''
), q as (
 select websearch_to_tsquery('simple',left(coalesce(p_query,''),1000)) required,
 (left(coalesce(p_query,''),1000) !~* '"|(^|[[:space:]])-|[[:space:]]or[[:space:]]') partial_allowed,
 coalesce((select string_agg(term::text,' | ')::tsquery from query_terms where numnode(term)>0),''::tsquery) broad,
 coalesce((select array_agg(term) from query_terms where numnode(term)>0),array[]::tsquery[]) terms
), eligible as (
 select c.id,c.document_id,c.chunk_index,c.heading,c.content,c.search_vector,c.embedding,c.embedding_model,
        coalesce(c.metadata->>'kind','') chunk_kind,
        d.fetched_at,d.valid_until,d.review_status,d.approved_at
 from public.rafa_knowledge_chunks c
 join public.rafa_knowledge_documents d on d.id=c.document_id
 join public.rafa_knowledge_sources s on s.id=d.source_id
 where s.enabled and s.approved and d.review_status='approved'
   and (d.valid_until is null or d.valid_until>now())
   and (
     d.canonical_content !~* '(?:[$€£][[:space:]]*[0-9٠-٩]|(?:EUR|USD|GBP)[[:space:]]*[0-9٠-٩]|[0-9٠-٩][0-9٠-٩.,[:space:]]*(?:EUR|USD|GBP|euros?|dollars?|pounds?|يورو|دولار|جنيه|ευρώ))'
     or (d.valid_until is not null and d.valid_until>now())
   )
   and length(trim(coalesce(p_query,'')))>0
), lexical_scored as (
 select e.id,e.chunk_index,
   coalesce((select count(*)::numeric/nullif(cardinality(q.terms),0)
     from unnest(q.terms) term(value) where e.search_vector @@ term.value),0)::real coverage,
   ts_rank_cd(e.search_vector,q.broad)::real broad_rank,
   (e.search_vector @@ q.required) required_match
 from eligible e cross join q
 where e.search_vector @@ q.required or (q.partial_allowed and e.search_vector @@ q.broad and
   (select count(*)::numeric/nullif(cardinality(q.terms),0) from unnest(q.terms) term(value) where e.search_vector @@ term.value)>=0.6 and
   (select count(*) from unnest(q.terms) term(value) where e.search_vector @@ term.value)>=2)
), lexical as (
 select id,row_number() over(order by coverage desc,broad_rank desc,required_match desc,chunk_index,id) position
 from lexical_scored
 order by coverage desc,broad_rank desc,required_match desc,chunk_index,id
 limit 30
), semantic as (
 select e.id,row_number() over(order by e.embedding OPERATOR(extensions.<=>) p_embedding,e.id) position
 from eligible e
 where p_embedding is not null and e.embedding is not null and e.embedding_model=p_embedding_model
   and (e.embedding OPERATOR(extensions.<=>) p_embedding)<=0.65
 order by e.embedding OPERATOR(extensions.<=>) p_embedding,e.id
 limit 30
), fused as (
 select x.id,sum(x.score)::real score
 from (
   select l.id,1.0/(60+l.position) score from lexical l
   union all
   select a.id,1.0/(60+a.position) score from semantic a
 ) x group by x.id
), expanded as (
 select f.id,f.score,0 sibling_rank
 from fused f join eligible e on e.id=f.id
 where e.chunk_kind<>'aliases'
 union all
 select sib.id,f.score-1e-6::real,
   row_number() over (partition by f.id order by (sib.chunk_kind='fact') desc,sib.chunk_index)
 from fused f
 join eligible e on e.id=f.id and e.chunk_kind='aliases'
 join eligible sib on sib.document_id=e.document_id and sib.chunk_kind<>'aliases'
), pruned as (
 select x.id,max(x.score) score from expanded x where x.sibling_rank<=3 group by x.id
)
select s.id,d.id,c.id,s.display_name,s.canonical_url,d.title,c.heading,c.content,p.score,
       d.fetched_at,d.valid_until,d.review_status,d.approved_at,
       c.chunk_index,coalesce(c.metadata->>'kind','')
from pruned p
join public.rafa_knowledge_chunks c on c.id=p.id
join public.rafa_knowledge_documents d on d.id=c.document_id
join public.rafa_knowledge_sources s on s.id=d.source_id
order by p.score desc,d.fetched_at desc,c.chunk_index,c.id
limit least(greatest(coalesce(p_match_count,6),1),20);
$$;

revoke all on function public.rafa_search_knowledge(text,integer) from public,authenticated;
grant execute on function public.rafa_search_knowledge(text,integer) to anon;
revoke all on function public.rafa_hybrid_search_knowledge(text,extensions.halfvec,text,integer) from public,authenticated;
grant execute on function public.rafa_hybrid_search_knowledge(text,extensions.halfvec,text,integer) to anon;

commit;
