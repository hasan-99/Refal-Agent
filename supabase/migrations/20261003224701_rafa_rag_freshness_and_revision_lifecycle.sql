begin;

-- A source URL is a revision stream, so only one approved revision may be
-- eligible at a time (the approved revision may contain several languages).
-- Keep the most recently approved row if the
-- database already contains duplicate approvals.
with ranked as (
  select id,
         row_number() over (
           partition by source_id
           order by approved_at desc nulls last, revision desc, created_at desc, id desc
         ) as approval_rank
  from public.rafa_knowledge_documents
  where review_status = 'approved'
)
update public.rafa_knowledge_documents d
set review_status = 'superseded'
from ranked r
where d.id = r.id and r.approval_rank > 1;

create unique index if not exists rafa_knowledge_documents_one_approved_per_source_idx
  on public.rafa_knowledge_documents (source_id)
  where review_status = 'approved';

-- Pricing is mutable and must not remain available indefinitely just because
-- valid_until was omitted. A human approval refreshes a price-bearing revision
-- for 30 days. Existing approved price-bearing rows get a bounded validity
-- window based on their approval time; an already old approval therefore
-- expires immediately instead of being silently renewed by this migration.
update public.rafa_knowledge_documents d
set valid_until = least(
  coalesce(d.valid_until, greatest(d.approved_at, d.fetched_at) + interval '30 days'),
  greatest(d.approved_at, d.fetched_at) + interval '30 days'
)
where d.review_status = 'approved'
  and (d.valid_until is null or d.valid_until > greatest(d.approved_at, d.fetched_at) + interval '30 days')
  and d.canonical_content ~* '(?:[$€£][[:space:]]*[0-9٠-٩]|(?:EUR|USD|GBP)[[:space:]]*[0-9٠-٩]|[0-9٠-٩][0-9٠-٩.,[:space:]]*(?:EUR|USD|GBP|euros?|dollars?|pounds?|يورو|دولار|جنيه|ευρώ))';

create or replace function public.rafa_apply_knowledge_approval_lifecycle()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_apply_approval boolean := false;
begin
  if new.review_status = 'approved' then
    if tg_op = 'INSERT' then
      v_apply_approval := true;
    elsif old.review_status is distinct from 'approved'
       or new.approved_at is distinct from old.approved_at then
      v_apply_approval := true;
    end if;
  end if;

  if v_apply_approval then
    -- Serialize approval changes for the same source. This is a BEFORE trigger,
    -- so superseding the previous row frees the partial unique index before the
    -- newly approved row is written.
    perform 1
    from public.rafa_knowledge_sources s
    where s.id = new.source_id
    for update;

    update public.rafa_knowledge_documents d
    set review_status = 'superseded'
    where d.source_id = new.source_id
      and d.id is distinct from new.id
      and d.review_status = 'approved';

    if new.canonical_content ~* '(?:[$€£][[:space:]]*[0-9٠-٩]|(?:EUR|USD|GBP)[[:space:]]*[0-9٠-٩]|[0-9٠-٩][0-9٠-٩.,[:space:]]*(?:EUR|USD|GBP|euros?|dollars?|pounds?|يورو|دولار|جنيه|ευρώ))' then
      -- Approval is the explicit review point for a mutable fee. Never leave a
      -- current price without a finite expiry, and preserve intentionally
      -- shorter validity windows.
      if new.valid_until is null or new.valid_until <= now() then
        new.valid_until := now() + interval '30 days';
      else
        new.valid_until := least(new.valid_until, now() + interval '30 days');
      end if;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists rafa_knowledge_approval_lifecycle on public.rafa_knowledge_documents;
create trigger rafa_knowledge_approval_lifecycle
before insert or update of review_status, approved_at on public.rafa_knowledge_documents
for each row execute function public.rafa_apply_knowledge_approval_lifecycle();

-- PostgreSQL cannot change a function's OUT/RETURNS TABLE row type with
-- CREATE OR REPLACE, so drop the RPC signatures before recreating them.
drop function if exists public.rafa_search_knowledge(text,integer);
drop function if exists public.rafa_hybrid_search_knowledge(text,extensions.halfvec,text,integer);

create function public.rafa_search_knowledge(p_query text,p_match_count integer default 6)
returns table(
  source_id uuid, document_id uuid, chunk_id uuid, source_name text, source_url text,
  document_title text, heading text, content text, rank real,
  fetched_at timestamptz, valid_until timestamptz, review_status text, approved_at timestamptz
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
)
select s.id,d.id,c.id,s.display_name,s.canonical_url,d.title,c.heading,c.content,
 case when c.search_vector @@ q.required then ts_rank_cd(c.search_vector,q.required)::real else ts_rank_cd(c.search_vector,q.broad)::real end,
 d.fetched_at,d.valid_until,d.review_status,d.approved_at
from public.rafa_knowledge_chunks c
join public.rafa_knowledge_documents d on d.id=c.document_id
join public.rafa_knowledge_sources s on s.id=d.source_id
cross join q
where length(trim(coalesce(p_query,'')))>0
  and s.enabled and s.approved and d.review_status='approved'
  and (d.valid_until is null or d.valid_until>now())
  and (
    d.canonical_content !~* '(?:[$€£][[:space:]]*[0-9٠-٩]|(?:EUR|USD|GBP)[[:space:]]*[0-9٠-٩]|[0-9٠-٩][0-9٠-٩.,[:space:]]*(?:EUR|USD|GBP|euros?|dollars?|pounds?|يورو|دولار|جنيه|ευρώ))'
    or (d.valid_until is not null and d.valid_until>now())
  )
  and (c.search_vector @@ q.required or (c.search_vector @@ q.broad and
    (select count(*)::numeric/nullif(cardinality(q.terms),0) from unnest(q.terms) term(value) where c.search_vector @@ term.value)>=0.6 and
    (select count(*) from unnest(q.terms) term(value) where c.search_vector @@ term.value)>=2))
order by case when c.search_vector @@ q.required then ts_rank_cd(c.search_vector,q.required) else ts_rank_cd(c.search_vector,q.broad) end desc,
         d.fetched_at desc,c.chunk_index
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
  fetched_at timestamptz, valid_until timestamptz, review_status text, approved_at timestamptz
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
)
select s.id,d.id,c.id,s.display_name,s.canonical_url,d.title,c.heading,c.content,f.score,
       d.fetched_at,d.valid_until,d.review_status,d.approved_at
from fused f
join public.rafa_knowledge_chunks c on c.id=f.id
join public.rafa_knowledge_documents d on d.id=c.document_id
join public.rafa_knowledge_sources s on s.id=d.source_id
order by f.score desc,d.fetched_at desc,c.chunk_index
limit least(greatest(coalesce(p_match_count,6),1),20);
$$;

revoke all on function public.rafa_apply_knowledge_approval_lifecycle() from public, anon, authenticated;
revoke all on function public.rafa_search_knowledge(text,integer) from public,authenticated;
grant execute on function public.rafa_search_knowledge(text,integer) to anon;
revoke all on function public.rafa_hybrid_search_knowledge(text,extensions.halfvec,text,integer) from public,authenticated;
grant execute on function public.rafa_hybrid_search_knowledge(text,extensions.halfvec,text,integer) to anon;

commit;

