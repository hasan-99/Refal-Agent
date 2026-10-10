begin;

-- CF-04 / P10.2 — SIBLING-CHUNK EXPANSION ON RETRIEVAL
--
-- THE DEFECT
-- ----------
-- Every knowledge document is ingested with a finding aid at chunk_index 0:
-- the title, every section heading, and the author's alias phrases (the ways a
-- customer might actually ask the question). It is tagged metadata.kind =
-- 'aliases'. Its entire job is to make a dialect question FINDABLE -- it is a
-- card catalogue, not content.
--
-- But it is a chunk like any other, so it competes in the ranking and it WINS,
-- because a customer's question matches a list of customer questions almost
-- perfectly. The caller then receives a block of question phrases carrying no
-- facts, hands it to the model as evidence, and the model -- which is forbidden
-- by the M2 claim gate from stating any number not present in its evidence --
-- has nothing it is allowed to say and recites the alias list back.
--
-- Measured live, 2026-10-10, against the real corpus:
--   rafa_search_knowledge('انت مين وشو عندكم خدمات', 6) returned 3 rows:
--     1. chunk_index 0, kind 'aliases',   rank 0.70   <- the finding aid
--     2. chunk_index 3, kind 'example',   rank 0.50   <- a different document
--     3. chunk_index 4, kind 'discovery', rank 0.40   <- IP Box, irrelevant
--   NOT ONE kind='fact' chunk. src/corpusIngest.js:185 predicted exactly this.
--
-- THE FIX
-- -------
-- Keep the finding aid in the INDEX (removing it would break dialect matching,
-- which is what it is for and what Arabic leans on hardest) but never let it
-- leave as EVIDENCE. When a finding aid matches, it is replaced by its own
-- document's real chunks, inheriting its rank so the document keeps the
-- position its match earned.
--
-- This is deliberately done in the RPC and not in JS. There are four callers
-- (src/bot.js, src/agentTools.js, and dashboard/server.js twice) and this repo
-- has repeatedly been bitten by a rule fixed on one surface and missed on
-- another (see the M1 close: four prompt surfaces, and the drifted edge
-- mirrors). Fixing it here fixes every caller at once and cannot drift.
--
-- Two columns are added to the return shape, chunk_index and chunk_kind, so a
-- caller can assert defensively that no finding aid ever reached it. Nothing
-- about the answer is hardcoded: this changes WHICH PAGES are retrieved, never
-- what the model says about them.
--
-- SIBLINGS_PER_ALIAS = 3. Enough to carry a document's core facts (for
-- company-profile that is exactly MB-C1..MB-C5) without one expansion
-- crowding out every other document at the default match count of 6.
-- Fact-bearing sections are preferred over example/boundary/discovery ones,
-- then document order.

-- PostgreSQL cannot change a function's RETURNS TABLE row type with CREATE OR
-- REPLACE, so the signatures are dropped first. Idempotent: safe to re-run.
drop function if exists public.rafa_search_knowledge(text,integer);
drop function if exists public.rafa_hybrid_search_knowledge(text,extensions.halfvec,text,integer);

create function public.rafa_search_knowledge(p_query text,p_match_count integer default 6)
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
 coalesce((select string_agg(term::text,' | ')::tsquery from query_terms where numnode(term)>0),''::tsquery) broad,
 coalesce((select array_agg(term) from query_terms where numnode(term)>0),array[]::tsquery[]) terms
), eligible as (
 -- Identical eligibility filters to the previous revision of this function.
 -- Unchanged on purpose: this migration changes WHICH chunk leaves, never
 -- which document is allowed to be searched.
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
), matched as (
 select e.id,e.document_id,e.chunk_kind,e.chunk_index,
   case when e.search_vector @@ q.required then ts_rank_cd(e.search_vector,q.required)::real
        else ts_rank_cd(e.search_vector,q.broad)::real end score
 from eligible e cross join q
 where e.search_vector @@ q.required or (e.search_vector @@ q.broad and
   (select count(*)::numeric/nullif(cardinality(q.terms),0) from unnest(q.terms) term(value) where e.search_vector @@ term.value)>=0.6 and
   (select count(*) from unnest(q.terms) term(value) where e.search_vector @@ term.value)>=2)
 order by score desc,e.chunk_index
 limit 30
), expanded as (
 -- A real chunk passes straight through.
 select m.id,m.score,0 sibling_rank
 from matched m
 where m.chunk_kind<>'aliases'
 union all
 -- A finding aid is replaced by its own document's real chunks. It inherits
 -- the aid's score minus an epsilon so it sorts immediately below an equally
 -- ranked direct hit rather than above it.
 select sib.id,m.score-1e-6::real,
   row_number() over (partition by m.id order by (sib.chunk_kind='fact') desc,sib.chunk_index)
 from matched m
 join eligible sib on sib.document_id=m.document_id and sib.chunk_kind<>'aliases'
 where m.chunk_kind='aliases'
), pruned as (
 -- A chunk reachable both directly and as a sibling keeps its better score.
 select x.id,max(x.score) score from expanded x where x.sibling_rank<=3 group by x.id
)
select s.id,d.id,c.id,s.display_name,s.canonical_url,d.title,c.heading,c.content,p.score,
 d.fetched_at,d.valid_until,d.review_status,d.approved_at,
 c.chunk_index,coalesce(c.metadata->>'kind','')
from pruned p
join public.rafa_knowledge_chunks c on c.id=p.id
join public.rafa_knowledge_documents d on d.id=c.document_id
join public.rafa_knowledge_sources s on s.id=d.source_id
order by p.score desc,d.fetched_at desc,c.chunk_index
limit least(greatest(coalesce(p_match_count,6),1),20);
$$;

create function public.rafa_hybrid_search_knowledge(
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
), lexical as (
 select e.id,row_number() over(order by case when e.search_vector @@ q.required then ts_rank_cd(e.search_vector,q.required) else ts_rank_cd(e.search_vector,q.broad) end desc,e.chunk_index) position
 from eligible e cross join q
 where e.search_vector @@ q.required or (e.search_vector @@ q.broad and
   (select count(*)::numeric/nullif(cardinality(q.terms),0) from unnest(q.terms) term(value) where e.search_vector @@ term.value)>=0.6 and
   (select count(*) from unnest(q.terms) term(value) where e.search_vector @@ term.value)>=2)
 order by case when e.search_vector @@ q.required then ts_rank_cd(e.search_vector,q.required) else ts_rank_cd(e.search_vector,q.broad) end desc,e.chunk_index
 limit 30
), semantic as (
 select e.id,row_number() over(order by e.embedding OPERATOR(extensions.<=>) p_embedding) position
 from eligible e
 where p_embedding is not null and e.embedding is not null and e.embedding_model=p_embedding_model
   and (e.embedding OPERATOR(extensions.<=>) p_embedding)<=0.65
 order by e.embedding OPERATOR(extensions.<=>) p_embedding
 limit 30
), fused as (
 select x.id,sum(x.score)::real score
 from (
   select l.id,1.0/(60+l.position) score from lexical l
   union all
   select a.id,1.0/(60+a.position) score from semantic a
 ) x group by x.id
), expanded as (
 -- Same rule as the lexical path. A finding aid never leaves as evidence; it
 -- is replaced by its own document's real chunks, inheriting its fused score.
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
order by p.score desc,d.fetched_at desc,c.chunk_index
limit least(greatest(coalesce(p_match_count,6),1),20);
$$;

-- Grants must follow the CREATEs. A table grant may precede its table in a
-- batch; a function grant may NOT precede its function -- that is FIX-32,
-- which aborted MIG-01 on its first apply. Kept at the bottom deliberately.
revoke all on function public.rafa_search_knowledge(text,integer) from public,authenticated;
grant execute on function public.rafa_search_knowledge(text,integer) to anon;
revoke all on function public.rafa_hybrid_search_knowledge(text,extensions.halfvec,text,integer) from public,authenticated;
grant execute on function public.rafa_hybrid_search_knowledge(text,extensions.halfvec,text,integer) to anon;

commit;

-- ROLLBACK:
-- begin;
-- drop function if exists public.rafa_search_knowledge(text,integer);
-- drop function if exists public.rafa_hybrid_search_knowledge(text,extensions.halfvec,text,integer);
-- -- then re-apply 20261003231041_rafa_rag_lexical_match_coverage.sql to
-- -- restore the previous 13-column return shape with no sibling expansion.
-- commit;
