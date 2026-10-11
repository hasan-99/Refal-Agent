-- Unified knowledge retrieval: broad search, parent sections, health diagnostics.
--
-- WHY THIS EXISTS
-- ---------------
-- The agent was answering "I have no confirmed information" for questions whose
-- answer is in the corpus. Three causes live in SQL:
--
-- 1. THE LEXICAL GATE IS UNREACHABLE FOR A REAL SENTENCE.
--    `search_vector` is to_tsvector('simple', ...), and 'simple' removes no
--    stopwords. A customer question is tokenized whole, so "what", "is", "in",
--    "شو", "هل" all become required terms. The live gate demands either a full
--    websearch_to_tsquery AND-match or >= 0.6 distinct-term coverage AND >= 2
--    matched terms. "What is included in the Cyprus company formation package?"
--    is 10 terms; a section has to carry 6 of them, including the stopwords, to
--    be considered at all. Keyword-shaped queries pass, sentences do not, and a
--    colloquial Arabic sentence almost never does.
--
--    v2 keeps coverage as the PRIMARY SORT (a full match still wins) but makes
--    the admission floor a parameter: match at least `p_min_terms` distinct
--    query terms and `p_min_coverage` of them. Ranking, not admission, is what
--    should decide which of 30 candidates survives.
--
-- 2. THE SEMANTIC ARM HAS A HARD 0.65 COSINE CUTOFF.
--    Fine for same-language paraphrase, too tight for cross-language retrieval
--    (Arabic question against an English section) where multilingual-e5
--    legitimately lands further out. A miss here is indistinguishable from
--    "no knowledge" upstream. v2 takes the cutoff as a parameter.
--
-- 3. NOTHING EVER RETRIEVES THE CONDITIONS.
--    A chunk IS a `##` section (src/corpusIngest.js), and every corpus document
--    is REQUIRED to carry at least one `kind: boundary` section -- the
--    limitations, conditions and exceptions (src/corpusFile.js:392). Sibling
--    expansion currently fires only for `aliases` chunks, so a question that
--    matches the fact section gets the claim and never the condition attached
--    to it. rafa_fetch_knowledge_sections closes that: given the matched chunk
--    ids it returns their COMPLETE parent documents' sections in original
--    chunk_index order, boundary sections prioritised when the budget is tight.
--
-- WHAT IS DELIBERATELY NOT CHANGED
-- --------------------------------
-- Every eligibility filter is copied verbatim: source enabled + approved,
-- document review_status = 'approved', valid_until, and the price-expiry clause
-- from migration 20261003224701. This migration widens RECALL inside the
-- approved set; it never widens the approved set itself. The existing v1
-- functions are left in place and still granted, so the deployed Edge Function
-- keeps working unchanged until it is redeployed.

begin;

-- ---------------------------------------------------------------- lexical v2
create or replace function public.rafa_search_knowledge_v2(
  p_query text,
  p_match_count integer default 12,
  p_min_coverage real default 0.2,
  p_min_terms integer default 1
)
returns table(
  source_id uuid, document_id uuid, chunk_id uuid, source_name text, source_url text,
  document_title text, heading text, content text, rank real,
  fetched_at timestamptz, valid_until timestamptz, review_status text, approved_at timestamptz,
  chunk_index integer, chunk_kind text,
  lexical_rank integer, semantic_rank integer, semantic_distance real, matched_terms integer, term_coverage real
)
language sql stable security invoker set search_path = '' as $$
with query_terms as (
 select distinct plainto_tsquery('simple',token.value) term
 from regexp_split_to_table(left(coalesce(p_query,''),1000),'[^[:alnum:]_]+') token(value)
 where token.value<>''
), q as (
 select websearch_to_tsquery('simple',left(coalesce(p_query,''),1000)) required,
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
   (select count(*) from unnest(q.terms) term(value) where e.search_vector @@ term.value)::integer hits,
   coalesce((select count(*)::numeric/nullif(cardinality(q.terms),0)
     from unnest(q.terms) term(value) where e.search_vector @@ term.value),0)::real coverage,
   ts_rank_cd(e.search_vector,q.broad)::real broad_rank,
   (e.search_vector @@ q.required) required_match
 from eligible e cross join q
 where e.search_vector @@ q.broad
), admitted as (
 select * from scored
 where required_match
    or (hits >= greatest(1, least(coalesce(p_min_terms,1), 8)) and coverage >= greatest(0::real, coalesce(p_min_coverage,0.2)))
), ranked as (
 select admitted.*,
 row_number() over(order by required_match desc,coverage desc,broad_rank desc,chunk_index,id) position
 from admitted
), matched as (
 select id,document_id,chunk_kind,chunk_index,hits,coverage,position,
   (1.0/(60+position))::real score
 from ranked
 where position<=40
), expanded as (
 select m.id,m.score,m.position,m.hits,m.coverage,0 sibling_rank
 from matched m
 where m.chunk_kind<>'aliases'
 union all
 select sib.id,m.score-1e-6::real,m.position,m.hits,m.coverage,
   row_number() over (partition by m.id order by (sib.chunk_kind='fact') desc,sib.chunk_index)
 from matched m
 join eligible sib on sib.document_id=m.document_id and sib.chunk_kind<>'aliases'
 where m.chunk_kind='aliases'
), pruned as (
 select x.id,max(x.score) score,min(x.position)::integer position,max(x.hits)::integer hits,max(x.coverage) coverage
 from expanded x where x.sibling_rank<=3 group by x.id
)
select s.id,d.id,c.id,s.display_name,s.canonical_url,d.title,c.heading,c.content,p.score,
 d.fetched_at,d.valid_until,d.review_status,d.approved_at,
 c.chunk_index,coalesce(c.metadata->>'kind',''),
 p.position,null::integer,null::real,p.hits,p.coverage
from pruned p
join public.rafa_knowledge_chunks c on c.id=p.id
join public.rafa_knowledge_documents d on d.id=c.document_id
join public.rafa_knowledge_sources s on s.id=d.source_id
order by p.score desc,d.fetched_at desc,c.chunk_index,c.id
limit least(greatest(coalesce(p_match_count,12),1),50);
$$;

-- ----------------------------------------------------------------- hybrid v2
create or replace function public.rafa_hybrid_search_knowledge_v2(
  p_query text,
  p_embedding extensions.halfvec(2048),
  p_embedding_model text,
  p_match_count integer default 12,
  p_min_coverage real default 0.2,
  p_min_terms integer default 1,
  p_max_distance real default 0.85
)
returns table(
  source_id uuid, document_id uuid, chunk_id uuid, source_name text, source_url text,
  document_title text, heading text, content text, rank real,
  fetched_at timestamptz, valid_until timestamptz, review_status text, approved_at timestamptz,
  chunk_index integer, chunk_kind text,
  lexical_rank integer, semantic_rank integer, semantic_distance real, matched_terms integer, term_coverage real
)
language sql stable security invoker set search_path = '' as $$
with query_terms as (
 select distinct plainto_tsquery('simple',token.value) term
 from regexp_split_to_table(left(coalesce(p_query,''),1000),'[^[:alnum:]_]+') token(value)
 where token.value<>''
), q as (
 select websearch_to_tsquery('simple',left(coalesce(p_query,''),1000)) required,
 coalesce((select string_agg(term::text,' | ')::tsquery from query_terms where numnode(term)>0),''::tsquery) broad,
 coalesce((select array_agg(term) from query_terms where numnode(term)>0),array[]::tsquery[]) terms
), eligible as (
 select c.id,c.document_id,c.chunk_index,c.heading,c.content,c.search_vector,c.embedding,c.embedding_model,
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
), lexical_scored as (
 select e.id,e.chunk_index,
   (select count(*) from unnest(q.terms) term(value) where e.search_vector @@ term.value)::integer hits,
   coalesce((select count(*)::numeric/nullif(cardinality(q.terms),0)
     from unnest(q.terms) term(value) where e.search_vector @@ term.value),0)::real coverage,
   ts_rank_cd(e.search_vector,q.broad)::real broad_rank,
   (e.search_vector @@ q.required) required_match
 from eligible e cross join q
 where e.search_vector @@ q.broad
), lexical as (
 select id,hits,coverage,
   row_number() over(order by required_match desc,coverage desc,broad_rank desc,chunk_index,id) position
 from lexical_scored
 where required_match
    or (hits >= greatest(1, least(coalesce(p_min_terms,1), 8)) and coverage >= greatest(0::real, coalesce(p_min_coverage,0.2)))
 order by required_match desc,coverage desc,broad_rank desc,chunk_index,id
 limit 40
), semantic as (
 select e.id,(e.embedding OPERATOR(extensions.<=>) p_embedding)::real distance,
   row_number() over(order by e.embedding OPERATOR(extensions.<=>) p_embedding,e.id) position
 from eligible e
 where p_embedding is not null and e.embedding is not null and e.embedding_model=p_embedding_model
   and (e.embedding OPERATOR(extensions.<=>) p_embedding)<=greatest(0::real,least(2::real,coalesce(p_max_distance,0.85)))
 order by e.embedding OPERATOR(extensions.<=>) p_embedding,e.id
 limit 40
), fused as (
 select x.id,sum(x.score)::real score,
   max(x.lexical_position) lexical_position,max(x.semantic_position) semantic_position,
   max(x.distance) distance,max(x.hits) hits,max(x.coverage) coverage
 from (
   select l.id,1.0/(60+l.position) score,l.position lexical_position,null::bigint semantic_position,null::real distance,l.hits,l.coverage from lexical l
   union all
   select a.id,1.0/(60+a.position) score,null::bigint,a.position,a.distance,null::integer,null::real from semantic a
 ) x group by x.id
), expanded as (
 select f.id,f.score,f.lexical_position,f.semantic_position,f.distance,f.hits,f.coverage,0 sibling_rank
 from fused f join eligible e on e.id=f.id
 where e.chunk_kind<>'aliases'
 union all
 select sib.id,f.score-1e-6::real,f.lexical_position,f.semantic_position,f.distance,f.hits,f.coverage,
   row_number() over (partition by f.id order by (sib.chunk_kind='fact') desc,sib.chunk_index)
 from fused f
 join eligible e on e.id=f.id and e.chunk_kind='aliases'
 join eligible sib on sib.document_id=e.document_id and sib.chunk_kind<>'aliases'
), pruned as (
 select x.id,max(x.score) score,min(x.lexical_position) lexical_position,min(x.semantic_position) semantic_position,
   min(x.distance) distance,max(x.hits) hits,max(x.coverage) coverage
 from expanded x where x.sibling_rank<=3 group by x.id
)
select s.id,d.id,c.id,s.display_name,s.canonical_url,d.title,c.heading,c.content,p.score,
       d.fetched_at,d.valid_until,d.review_status,d.approved_at,
       c.chunk_index,coalesce(c.metadata->>'kind',''),
       p.lexical_position::integer,p.semantic_position::integer,p.distance,p.hits,p.coverage
from pruned p
join public.rafa_knowledge_chunks c on c.id=p.id
join public.rafa_knowledge_documents d on d.id=c.document_id
join public.rafa_knowledge_sources s on s.id=d.source_id
order by p.score desc,d.fetched_at desc,c.chunk_index,c.id
limit least(greatest(coalesce(p_match_count,12),1),50);
$$;

-- ------------------------------------------------------- parent section fetch
-- Step 4 of the workflow. Given the chunk ids a search returned, hand back the
-- COMPLETE sections of their parent documents, in original chunk_index order,
-- so a condition that lives in a different section than the claim still
-- reaches the answer model.
--
-- `priority` is the budget order, NOT the reading order: the matched sections
-- come first, then the `boundary` sections (the conditions and exceptions every
-- corpus document is required to carry), then the rest of the document. A
-- caller that can only afford N sections therefore keeps the claim and its
-- conditions and drops the background. Callers must order by
-- (document_id, chunk_index) for reading; `priority` is only for truncation.
create or replace function public.rafa_fetch_knowledge_sections(
  p_chunk_ids uuid[],
  p_max_sections integer default 24,
  p_include_siblings boolean default true
)
-- `metadata` is returned, not just `kind`. src/factRegister.js#chunkFactIds
-- reads `metadata.facts` to apply the blocked-fact gate at query time, and a
-- section fetched BY ID would otherwise arrive without it -- the gate would
-- then see an empty fact list and fail OPEN on exactly the sibling sections
-- this function exists to add.
returns table(
  document_id uuid, chunk_id uuid, source_name text, document_title text,
  heading text, content text, chunk_index integer, chunk_kind text,
  metadata jsonb, valid_until timestamptz, is_match boolean, priority integer
)
language sql stable security invoker set search_path = '' as $$
with eligible as (
 select c.id,c.document_id,c.chunk_index,c.heading,c.content,c.metadata,
        coalesce(c.metadata->>'kind','') chunk_kind,
        d.valid_until,d.title document_title,s.display_name source_name
 from public.rafa_knowledge_chunks c
 join public.rafa_knowledge_documents d on d.id=c.document_id
 join public.rafa_knowledge_sources s on s.id=d.source_id
 where s.enabled and s.approved and d.review_status='approved'
   and (d.valid_until is null or d.valid_until>now())
   and (
     d.canonical_content !~* '(?:[$€£][[:space:]]*[0-9٠-٩]|(?:EUR|USD|GBP)[[:space:]]*[0-9٠-٩]|[0-9٠-٩][0-9٠-٩.,[:space:]]*(?:EUR|USD|GBP|euros?|dollars?|pounds?|يورو|دولار|جنيه|ευρώ))'
     or (d.valid_until is not null and d.valid_until>now())
   )
), matched as (
 select e.* from eligible e
 where e.id = any(coalesce(p_chunk_ids,array[]::uuid[]))
), family as (
 select e.*, (e.id in (select id from matched)) is_match
 from eligible e
 where e.chunk_kind<>'aliases'
   and (
     e.id in (select id from matched)
     or (coalesce(p_include_siblings,true) and e.document_id in (select document_id from matched))
   )
), budgeted as (
 select f.*,
   row_number() over (
     order by f.is_match desc,
              (f.chunk_kind='boundary') desc,
              (select min(m.chunk_index) from matched m where m.document_id=f.document_id),
              abs(f.chunk_index - coalesce((select min(m.chunk_index) from matched m where m.document_id=f.document_id),0)),
              f.document_id, f.chunk_index
   ) priority
 from family f
)
select b.document_id,b.id,b.source_name,b.document_title,b.heading,b.content,
       b.chunk_index,b.chunk_kind,b.metadata,b.valid_until,b.is_match,b.priority::integer
from budgeted b
where b.priority <= least(greatest(coalesce(p_max_sections,24),1),120)
order by b.document_id,b.chunk_index;
$$;

-- ------------------------------------------------------------------- health
-- Step 8. Answers "is everything we think is searchable actually searchable?"
-- in one call, so a blackout is diagnosed as a blackout instead of being
-- reported to a customer as "no approved information".
create or replace function public.rafa_knowledge_health()
returns table(
  sources_total bigint, sources_enabled_approved bigint,
  documents_total bigint, documents_approved bigint,
  documents_expired bigint, documents_price_gated bigint,
  chunks_total bigint, chunks_eligible bigint,
  chunks_embedded bigint, chunks_missing_embedding bigint,
  embedding_models text[]
)
language sql stable security invoker set search_path = '' as $$
with price_regex as (
  select '(?:[$€£][[:space:]]*[0-9٠-٩]|(?:EUR|USD|GBP)[[:space:]]*[0-9٠-٩]|[0-9٠-٩][0-9٠-٩.,[:space:]]*(?:EUR|USD|GBP|euros?|dollars?|pounds?|يورو|دولار|جنيه|ευρώ))' rx
), doc as (
  select d.id,d.review_status,d.valid_until,
         (d.canonical_content ~* (select rx from price_regex)) has_price,
         (s.enabled and s.approved) source_ok
  from public.rafa_knowledge_documents d
  join public.rafa_knowledge_sources s on s.id=d.source_id
), eligible_doc as (
  select id from doc
  where source_ok and review_status='approved'
    and (valid_until is null or valid_until>now())
    and (not has_price or (valid_until is not null and valid_until>now()))
)
select
 (select count(*) from public.rafa_knowledge_sources),
 (select count(*) from public.rafa_knowledge_sources where enabled and approved),
 (select count(*) from doc),
 (select count(*) from doc where review_status='approved'),
 (select count(*) from doc where valid_until is not null and valid_until<=now()),
 (select count(*) from doc where has_price and (valid_until is null or valid_until<=now())),
 (select count(*) from public.rafa_knowledge_chunks),
 (select count(*) from public.rafa_knowledge_chunks c where c.document_id in (select id from eligible_doc)),
 (select count(*) from public.rafa_knowledge_chunks c where c.document_id in (select id from eligible_doc) and c.embedding is not null),
 (select count(*) from public.rafa_knowledge_chunks c where c.document_id in (select id from eligible_doc) and c.embedding is null),
 (select coalesce(array_agg(distinct c.embedding_model),array[]::text[]) from public.rafa_knowledge_chunks c where c.embedding_model is not null);
$$;

-- Same grant shape as the v1 functions: the Edge Function reaches these with
-- the service role; `anon` keeps execute so the dashboard path is unchanged.
revoke all on function public.rafa_search_knowledge_v2(text,integer,real,integer) from public,authenticated;
grant execute on function public.rafa_search_knowledge_v2(text,integer,real,integer) to anon;
revoke all on function public.rafa_hybrid_search_knowledge_v2(text,extensions.halfvec,text,integer,real,integer,real) from public,authenticated;
grant execute on function public.rafa_hybrid_search_knowledge_v2(text,extensions.halfvec,text,integer,real,integer,real) to anon;
revoke all on function public.rafa_fetch_knowledge_sections(uuid[],integer,boolean) from public,authenticated;
grant execute on function public.rafa_fetch_knowledge_sections(uuid[],integer,boolean) to anon;
revoke all on function public.rafa_knowledge_health() from public,authenticated;
grant execute on function public.rafa_knowledge_health() to anon;

commit;
