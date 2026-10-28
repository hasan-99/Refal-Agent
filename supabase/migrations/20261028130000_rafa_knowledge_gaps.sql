-- Knowledge Gaps: questions REFAL could not answer from approved knowledge,
-- grouped by meaning, triaged by an administrator, and verified against real
-- retrieval before they count as resolved.
--
-- Written for review. NOT applied by the author. Additive only: no existing
-- table, function or policy is altered.
--
-- Privacy: only redacted question text is stored (src/ai.js redactPersonalData
-- plus knowledgeGapPolicy.mjs redactGapText, applied on the worker AND again on
-- the Edge function). Contacts are referenced by rafa_contacts.id, never by
-- phone number or WhatsApp id. Embeddings are 384-dim e5 vectors of the
-- redacted text, stored as real[] so the grouping math stays portable.
--
-- Access: the Edge function (service_role) records events; the dashboard
-- reaches these tables with anon + x-rafa-dashboard-secret exactly like the
-- knowledge and fact-register tables, and changes state only through the
-- audited RPCs below.
--
-- ROLLBACK (run in this order; destroys all recorded gaps):
--   drop function if exists public.rafa_record_knowledge_gap_verification(uuid, text, jsonb, text, text, text);
--   drop function if exists public.rafa_link_knowledge_gap(uuid, text, jsonb, jsonb, text, text, text, jsonb);
--   drop function if exists public.rafa_apply_knowledge_gap_action(uuid, text, text, text, text, jsonb, jsonb);
--   drop function if exists public.rafa_record_knowledge_gap_event(uuid, jsonb, jsonb, real[], integer);
--   drop function if exists public.rafa_match_knowledge_gap_groups(real[], integer);
--   drop function if exists public.rafa_knowledge_gap_expired_matches(text, integer);
--   drop view if exists public.rafa_knowledge_gap_group_stats;
--   drop table if exists public.rafa_knowledge_gap_audit;
--   drop table if exists public.rafa_knowledge_gap_regression_tests;
--   drop table if exists public.rafa_knowledge_gap_links;
--   drop table if exists public.rafa_knowledge_gap_events;
--   drop table if exists public.rafa_knowledge_gap_groups;

-- ------------------------------------------------------------------ tables

create table if not exists public.rafa_knowledge_gap_groups (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(trim(title)) between 1 and 200),
  summary text not null default '' check (length(summary) <= 1000),
  category text not null default 'general' check (category ~ '^[a-z_]{1,40}$'),
  intent text not null default '' check (length(intent) <= 60),
  reason text not null check (reason in ('missing_knowledge','weak_retrieval','partial_knowledge','conflicting_knowledge',
    'expired_knowledge','unsupported_request','agent_failure','system_failure','needs_review')),
  reason_locked boolean not null default false,
  reason_counts jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open','reviewing','needs_knowledge','needs_retrieval_fix',
    'needs_agent_fix','resolved','verified','ignored')),
  priority_override text check (priority_override in ('critical','high','medium','low')),
  owner text check (owner is null or length(trim(owner)) between 1 and 320),
  occurrence_count integer not null default 0 check (occurrence_count >= 0),
  suppressed_count integer not null default 0 check (suppressed_count >= 0),
  no_safe_answer_count integer not null default 0 check (no_safe_answer_count >= 0),
  languages text[] not null default '{}',
  example_questions jsonb not null default '[]'::jsonb check (jsonb_typeof(example_questions) = 'array'),
  facets text[] not null default '{}',
  objects text[] not null default '{}',
  sensitive_topics text[] not null default '{}',
  blocking boolean not null default false,
  analytics_only boolean not null default false,
  centroid real[] check (centroid is null or array_length(centroid, 1) = 384),
  centroid_count integer not null default 0 check (centroid_count >= 0),
  embedding_model text not null default '',
  resolution jsonb not null default '{}'::jsonb,
  resolved_at timestamptz,
  resolved_by text,
  verified_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.rafa_knowledge_gap_events (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.rafa_knowledge_gap_groups(id) on delete cascade,
  occurred_at timestamptz not null default now(),
  contact_id uuid,
  source_turn_id uuid,
  trace_id text check (trace_id is null or length(trace_id) <= 80),
  question_redacted text not null check (length(trim(question_redacted)) between 1 and 500),
  search_query_redacted text not null default '' check (length(search_query_redacted) <= 500),
  question_fingerprint text not null check (question_fingerprint ~ '^[0-9a-f]{16}$'),
  language text not null default 'und' check (language in ('en','ar','el','und')),
  intent text not null default '' check (length(intent) <= 60),
  category text not null default 'general' check (category ~ '^[a-z_]{1,40}$'),
  outcome text not null default 'unknown' check (length(outcome) <= 40),
  reason_code text not null default '' check (length(reason_code) <= 120),
  reason text not null check (reason in ('missing_knowledge','weak_retrieval','partial_knowledge','conflicting_knowledge',
    'expired_knowledge','unsupported_request','agent_failure','system_failure','needs_review')),
  suspected_reason text not null default '' check (length(suspected_reason) <= 40),
  confidence text not null default 'low' check (confidence in ('high','medium','low')),
  search_ran boolean not null default false,
  search_queries jsonb not null default '[]'::jsonb check (jsonb_typeof(search_queries) = 'array'),
  top_chunks jsonb not null default '[]'::jsonb check (jsonb_typeof(top_chunks) = 'array'),
  candidate_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(candidate_ids) = 'array'),
  candidate_count integer not null default 0 check (candidate_count >= 0),
  rerank jsonb not null default '{}'::jsonb,
  grounding_rejected boolean not null default false,
  rejection_reasons text[] not null default '{}',
  response_type text not null default 'unknown' check (length(response_type) <= 40),
  no_safe_answer boolean not null default false,
  model text not null default '' check (length(model) <= 120),
  prompt_version text not null default '' check (length(prompt_version) <= 40),
  agent_version text not null default '' check (length(agent_version) <= 40),
  signals jsonb not null default '{}'::jsonb,
  embedding real[] check (embedding is null or array_length(embedding, 1) = 384),
  created_at timestamptz not null default now()
);

create table if not exists public.rafa_knowledge_gap_links (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.rafa_knowledge_gap_groups(id) on delete cascade,
  -- Opaque references to existing knowledge. No content is copied here, so
  -- linking can never create a second copy of a knowledge entry.
  chunk_id uuid,
  document_id uuid,
  source_id uuid,
  link_type text not null check (link_type in ('existing','improved','created')),
  weak_retrieval boolean not null default false,
  label text not null default '' check (length(label) <= 200),
  linked_by text not null check (length(trim(linked_by)) between 1 and 320),
  note text not null default '' check (length(note) <= 500),
  created_at timestamptz not null default now(),
  check (chunk_id is not null or document_id is not null)
);

create table if not exists public.rafa_knowledge_gap_regression_tests (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.rafa_knowledge_gap_groups(id) on delete cascade,
  query text not null check (length(trim(query)) between 1 and 500),
  query_fingerprint text not null check (query_fingerprint ~ '^[0-9a-f]{16}$'),
  language text not null default 'und' check (language in ('en','ar','el','und')),
  expected_chunk_ids uuid[] not null default '{}',
  expected_document_ids uuid[] not null default '{}',
  expected_source_ids uuid[] not null default '{}',
  expected_min_rank integer not null default 5 check (expected_min_rank between 1 and 16),
  expected_behavior text not null default 'grounded_answer' check (expected_behavior in ('grounded_answer','safe_unsupported','clarify')),
  active boolean not null default true,
  last_result text not null default 'not_run' check (last_result in ('pass','fail','error','not_run')),
  last_rank integer,
  last_run_at timestamptz,
  last_details jsonb not null default '{}'::jsonb,
  created_by text not null check (length(trim(created_by)) between 1 and 320),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (group_id, query_fingerprint),
  check (cardinality(expected_chunk_ids) + cardinality(expected_document_ids) + cardinality(expected_source_ids) > 0)
);

create table if not exists public.rafa_knowledge_gap_audit (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.rafa_knowledge_gap_groups(id) on delete cascade,
  action text not null check (action ~ '^[a-z_]{1,40}$'),
  actor text not null check (length(trim(actor)) between 1 and 320),
  reason text not null default '' check (length(reason) <= 500),
  previous_status text,
  new_status text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- ----------------------------------------------------------------- indexes

create index if not exists rafa_knowledge_gap_groups_status_seen_idx on public.rafa_knowledge_gap_groups (status, last_seen_at desc);
create index if not exists rafa_knowledge_gap_groups_category_idx on public.rafa_knowledge_gap_groups (category, status);
create index if not exists rafa_knowledge_gap_groups_reason_idx on public.rafa_knowledge_gap_groups (reason, status);
create index if not exists rafa_knowledge_gap_groups_owner_idx on public.rafa_knowledge_gap_groups (owner) where owner is not null;
create index if not exists rafa_knowledge_gap_groups_seen_idx on public.rafa_knowledge_gap_groups (last_seen_at desc);
create index if not exists rafa_knowledge_gap_events_group_idx on public.rafa_knowledge_gap_events (group_id, occurred_at desc);
create index if not exists rafa_knowledge_gap_events_rate_idx on public.rafa_knowledge_gap_events (contact_id, question_fingerprint, occurred_at desc) where contact_id is not null;
create index if not exists rafa_knowledge_gap_events_time_idx on public.rafa_knowledge_gap_events (occurred_at desc);
create unique index if not exists rafa_knowledge_gap_links_chunk_uidx on public.rafa_knowledge_gap_links (group_id, chunk_id) where chunk_id is not null;
create unique index if not exists rafa_knowledge_gap_links_document_uidx on public.rafa_knowledge_gap_links (group_id, document_id) where chunk_id is null;
create index if not exists rafa_knowledge_gap_links_chunk_idx on public.rafa_knowledge_gap_links (chunk_id) where chunk_id is not null;
create index if not exists rafa_knowledge_gap_tests_active_idx on public.rafa_knowledge_gap_regression_tests (active, group_id);
create index if not exists rafa_knowledge_gap_audit_group_idx on public.rafa_knowledge_gap_audit (group_id, created_at desc);

-- ---------------------------------------------------------------- security

do $$
declare t text;
begin
  foreach t in array array['rafa_knowledge_gap_groups','rafa_knowledge_gap_events','rafa_knowledge_gap_links',
    'rafa_knowledge_gap_regression_tests','rafa_knowledge_gap_audit'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    execute format('grant select, insert, update, delete on table public.%I to service_role', t);
    execute format('drop policy if exists rafa_dashboard_%I_read on public.%I', t, t);
    execute format('create policy rafa_dashboard_%I_read on public.%I for select to anon using (public.rafa_dashboard_secret_matches())', t, t);
  end loop;
end $$;

-- Dashboard writes: narrow per table. Events are never written or edited from
-- the dashboard; audit rows are append-only; nothing is deletable by anon.
grant select, update on table public.rafa_knowledge_gap_groups to anon;
grant select on table public.rafa_knowledge_gap_events to anon;
grant select, insert on table public.rafa_knowledge_gap_links to anon;
grant select, insert, update on table public.rafa_knowledge_gap_regression_tests to anon;
grant select, insert on table public.rafa_knowledge_gap_audit to anon;

drop policy if exists rafa_dashboard_rafa_knowledge_gap_groups_update on public.rafa_knowledge_gap_groups;
create policy rafa_dashboard_rafa_knowledge_gap_groups_update on public.rafa_knowledge_gap_groups
  for update to anon using (public.rafa_dashboard_secret_matches()) with check (public.rafa_dashboard_secret_matches());
drop policy if exists rafa_dashboard_rafa_knowledge_gap_links_insert on public.rafa_knowledge_gap_links;
create policy rafa_dashboard_rafa_knowledge_gap_links_insert on public.rafa_knowledge_gap_links
  for insert to anon with check (public.rafa_dashboard_secret_matches());
drop policy if exists rafa_dashboard_rafa_knowledge_gap_regression_tests_insert on public.rafa_knowledge_gap_regression_tests;
create policy rafa_dashboard_rafa_knowledge_gap_regression_tests_insert on public.rafa_knowledge_gap_regression_tests
  for insert to anon with check (public.rafa_dashboard_secret_matches());
drop policy if exists rafa_dashboard_rafa_knowledge_gap_regression_tests_update on public.rafa_knowledge_gap_regression_tests;
create policy rafa_dashboard_rafa_knowledge_gap_regression_tests_update on public.rafa_knowledge_gap_regression_tests
  for update to anon using (public.rafa_dashboard_secret_matches()) with check (public.rafa_dashboard_secret_matches());
drop policy if exists rafa_dashboard_rafa_knowledge_gap_audit_insert on public.rafa_knowledge_gap_audit;
create policy rafa_dashboard_rafa_knowledge_gap_audit_insert on public.rafa_knowledge_gap_audit
  for insert to anon with check (public.rafa_dashboard_secret_matches());

-- ------------------------------------------------------------ stats view
-- security_invoker keeps the RLS above in force (PostgreSQL 15+, the same
-- requirement and check as refal_facts_due_for_review).
do $$
begin
  if current_setting('server_version_num')::integer < 150000 then
    raise exception 'rafa_knowledge_gap_group_stats needs PostgreSQL 15 or newer for security_invoker views; this server reports %', current_setting('server_version');
  end if;
end $$;

create or replace view public.rafa_knowledge_gap_group_stats with (security_invoker = true) as
  select e.group_id,
         count(*) filter (where e.occurred_at >= now() - interval '7 days')::integer as last_7_days,
         count(*) filter (where e.occurred_at < now() - interval '7 days' and e.occurred_at >= now() - interval '14 days')::integer as previous_7_days,
         count(distinct e.contact_id)::integer as distinct_contacts,
         count(*) filter (where e.no_safe_answer)::integer as no_safe_answer_events
  from public.rafa_knowledge_gap_events e
  group by e.group_id;

revoke all on public.rafa_knowledge_gap_group_stats from public, anon, authenticated;
grant select on public.rafa_knowledge_gap_group_stats to anon, service_role;

-- --------------------------------------------------------- Edge functions

-- Candidate groups for a new event: cosine against each group centroid. Both
-- sides are unit vectors, so the dot product is the cosine. Bounded to groups
-- seen in the last 180 days. If this ever scans tens of thousands of groups,
-- move centroids to extensions.halfvec(384) with an HNSW index.
create or replace function public.rafa_match_knowledge_gap_groups(p_embedding real[], p_limit integer default 8)
returns table (id uuid, category text, intent text, reason text, status text, facets text[], objects text[], similarity double precision)
language sql
stable
security invoker
set search_path = ''
as $$
  select g.id, g.category, g.intent, g.reason, g.status, g.facets, g.objects,
         (select sum(a::double precision * b::double precision) from unnest(g.centroid, p_embedding) as t(a, b)) as similarity
  from public.rafa_knowledge_gap_groups g
  where g.centroid is not null
    and array_length(p_embedding, 1) = 384
    and g.last_seen_at >= now() - interval '180 days'
  order by similarity desc nulls last
  limit least(greatest(coalesce(p_limit, 8), 1), 20);
$$;

-- Lexical probe for expired knowledge: approved revisions past valid_until
-- whose source has no current approved revision, matching most of the
-- question's terms. Used only to label a gap, never to answer a customer.
create or replace function public.rafa_knowledge_gap_expired_matches(p_query text, p_limit integer default 5)
returns table (chunk_id uuid, document_id uuid, source_id uuid, valid_until timestamptz, matched_terms integer)
language sql
stable
security invoker
set search_path = ''
as $$
  with terms as (
    select distinct t as term
    from regexp_split_to_table(lower(regexp_replace(coalesce(p_query, ''), '[[:punct:]؟،؛]+', ' ', 'g')), '\s+') as t
    where char_length(t) >= 3
    limit 12
  ), term_count as (select count(*)::integer as n from terms)
  select c.id, d.id, d.source_id, d.valid_until, count(*)::integer
  from public.rafa_knowledge_chunks c
  join public.rafa_knowledge_documents d on d.id = c.document_id
  join terms on c.search_vector @@ plainto_tsquery('simple', terms.term)
  where d.review_status = 'approved'
    and d.valid_until is not null and d.valid_until <= now()
    and not exists (
      select 1 from public.rafa_knowledge_documents cur
      where cur.source_id = d.source_id and cur.review_status = 'approved'
        and (cur.valid_until is null or cur.valid_until > now()))
  group by c.id, d.id, d.source_id, d.valid_until
  having count(*) >= greatest(2, ceil((select n from term_count) * 0.6))
  order by count(*) desc, d.valid_until desc
  limit least(greatest(coalesce(p_limit, 5), 1), 10);
$$;

-- Records one gap event atomically: per-conversation rate limit, join or
-- create the group, running-mean centroid update (mirrors updateCentroid in
-- knowledgeGapPolicy.mjs), bounded examples, reason tally, auto-reopen of a
-- resolved group when the same question fails again. The grouping DECISION is
-- made by the caller (decideGapGroup); this function only applies it.
create or replace function public.rafa_record_knowledge_gap_event(
  p_group_id uuid,
  p_new_group jsonb,
  p_event jsonb,
  p_embedding real[],
  p_rate_limit_seconds integer default 600
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_contact uuid := nullif(p_event->>'contact_id', '')::uuid;
  v_fingerprint text := p_event->>'question_fingerprint';
  v_reason text := p_event->>'reason';
  v_language text := coalesce(nullif(p_event->>'language', ''), 'und');
  v_no_safe boolean := coalesce((p_event->>'no_safe_answer')::boolean, false);
  v_embedding real[] := case when array_length(p_embedding, 1) = 384 then p_embedding else null end;
  v_existing record;
  v_group public.rafa_knowledge_gap_groups%rowtype;
  v_created boolean := false;
  v_reopened boolean := false;
  v_centroid real[];
  v_counts jsonb;
  v_event_id uuid;
  v_example jsonb;
begin
  if v_fingerprint is null or v_fingerprint !~ '^[0-9a-f]{16}$' then raise exception 'A knowledge gap event needs a question fingerprint'; end if;
  if v_reason is null then raise exception 'A knowledge gap event needs a reason'; end if;

  if v_contact is not null and coalesce(p_rate_limit_seconds, 0) > 0 then
    select e.group_id into v_existing from public.rafa_knowledge_gap_events e
    where e.contact_id = v_contact and e.question_fingerprint = v_fingerprint
      and e.occurred_at > now() - make_interval(secs => p_rate_limit_seconds)
    order by e.occurred_at desc limit 1;
    if found then
      update public.rafa_knowledge_gap_groups set suppressed_count = suppressed_count + 1, updated_at = now() where id = v_existing.group_id;
      return jsonb_build_object('suppressed', true, 'groupId', v_existing.group_id, 'created', false);
    end if;
  end if;

  if v_embedding is not null then
    select array_agg(x / nullif(n, 0) order by i)::real[] into v_embedding
    from (select i, x, sqrt(sum(x * x) over ()) as n
          from unnest(v_embedding) with ordinality as t(x, i)) s;
  end if;
  v_example := jsonb_build_object('question', left(p_event->>'question_redacted', 300), 'language', v_language,
    'fingerprint', v_fingerprint, 'at', now());

  if p_group_id is not null then
    select * into v_group from public.rafa_knowledge_gap_groups where id = p_group_id for update;
  end if;

  if v_group.id is null then
    insert into public.rafa_knowledge_gap_groups (title, category, intent, reason, status, occurrence_count, no_safe_answer_count,
      languages, example_questions, facets, objects, sensitive_topics, blocking, analytics_only, centroid, centroid_count,
      embedding_model, reason_counts, first_seen_at, last_seen_at)
    values (
      left(coalesce(nullif(p_new_group->>'title', ''), p_event->>'question_redacted'), 200),
      coalesce(nullif(p_new_group->>'category', ''), 'general'),
      left(coalesce(p_new_group->>'intent', ''), 60),
      v_reason, 'open', 1, case when v_no_safe then 1 else 0 end,
      array[v_language], jsonb_build_array(v_example),
      coalesce(array(select jsonb_array_elements_text(coalesce(p_new_group->'facets', '[]'::jsonb))), '{}'),
      coalesce(array(select jsonb_array_elements_text(coalesce(p_new_group->'objects', '[]'::jsonb))), '{}'),
      coalesce(array(select jsonb_array_elements_text(coalesce(p_new_group->'sensitive_topics', '[]'::jsonb))), '{}'),
      coalesce((p_new_group->>'blocking')::boolean, false),
      coalesce((p_new_group->>'analytics_only')::boolean, false),
      v_embedding, case when v_embedding is null then 0 else 1 end,
      left(coalesce(p_new_group->>'embedding_model', ''), 160),
      jsonb_build_object(v_reason, 1), now(), now())
    returning * into v_group;
    v_created := true;
  else
    if v_embedding is not null and v_group.centroid is not null and v_group.centroid_count > 0 then
      select array_agg(x / nullif(n, 0) order by i)::real[] into v_centroid
      from (select i, x, sqrt(sum(x * x) over ()) as n
            from (select t.i, (t.c * v_group.centroid_count + t.e)::double precision as x
                  from unnest(v_group.centroid, v_embedding) with ordinality as t(c, e, i)) raw) s;
    else
      v_centroid := coalesce(v_group.centroid, v_embedding);
    end if;
    v_counts := jsonb_set(v_group.reason_counts, array[v_reason], to_jsonb(coalesce((v_group.reason_counts->>v_reason)::integer, 0) + 1));
    update public.rafa_knowledge_gap_groups g set
      occurrence_count = g.occurrence_count + 1,
      no_safe_answer_count = g.no_safe_answer_count + case when v_no_safe then 1 else 0 end,
      last_seen_at = now(),
      languages = array(select distinct unnest(g.languages || array[v_language]) order by 1),
      example_questions = case
        when exists (select 1 from jsonb_array_elements(g.example_questions) x where x->>'fingerprint' = v_fingerprint) then g.example_questions
        else (select coalesce(jsonb_agg(x order by ord), '[]'::jsonb) from (
                select x, ord from jsonb_array_elements(g.example_questions || jsonb_build_array(v_example)) with ordinality as e(x, ord)
                order by ord desc limit 8) recent)
      end,
      sensitive_topics = array(select distinct unnest(g.sensitive_topics || coalesce(array(select jsonb_array_elements_text(coalesce(p_new_group->'sensitive_topics', '[]'::jsonb))), '{}')) order by 1),
      blocking = g.blocking or coalesce((p_new_group->>'blocking')::boolean, false),
      centroid = v_centroid,
      centroid_count = case when v_embedding is null then g.centroid_count else g.centroid_count + 1 end,
      reason_counts = v_counts,
      reason = case when g.reason_locked then g.reason
                    else (select key from jsonb_each_text(v_counts) order by value::integer desc, key limit 1) end,
      status = case when g.status in ('resolved', 'verified') then 'open' else g.status end,
      updated_at = now()
    where g.id = v_group.id;
    if v_group.status in ('resolved', 'verified') then
      v_reopened := true;
      insert into public.rafa_knowledge_gap_audit (group_id, action, actor, reason, previous_status, new_status, details)
      values (v_group.id, 'auto_reopened', 'system', 'The same question failed again after resolution.', v_group.status, 'open',
        jsonb_build_object('reason', v_reason));
    end if;
  end if;

  insert into public.rafa_knowledge_gap_events (group_id, contact_id, source_turn_id, trace_id, question_redacted, search_query_redacted,
    question_fingerprint, language, intent, category, outcome, reason_code, reason, suspected_reason, confidence, search_ran,
    search_queries, top_chunks, candidate_ids, candidate_count, rerank, grounding_rejected, rejection_reasons, response_type,
    no_safe_answer, model, prompt_version, agent_version, signals, embedding)
  values (v_group.id, v_contact, nullif(p_event->>'source_turn_id', '')::uuid, left(p_event->>'trace_id', 80),
    left(p_event->>'question_redacted', 500), left(coalesce(p_event->>'search_query_redacted', ''), 500), v_fingerprint, v_language,
    left(coalesce(p_event->>'intent', ''), 60), coalesce(nullif(p_event->>'category', ''), 'general'),
    left(coalesce(p_event->>'outcome', 'unknown'), 40), left(coalesce(p_event->>'reason_code', ''), 120), v_reason,
    left(coalesce(p_event->>'suspected_reason', ''), 40), coalesce(nullif(p_event->>'confidence', ''), 'low'),
    coalesce((p_event->>'search_ran')::boolean, false), coalesce(p_event->'search_queries', '[]'::jsonb),
    coalesce(p_event->'top_chunks', '[]'::jsonb), coalesce(p_event->'candidate_ids', '[]'::jsonb),
    coalesce((p_event->>'candidate_count')::integer, 0), coalesce(p_event->'rerank', '{}'::jsonb),
    coalesce((p_event->>'grounding_rejected')::boolean, false),
    coalesce(array(select jsonb_array_elements_text(coalesce(p_event->'rejection_reasons', '[]'::jsonb))), '{}'),
    left(coalesce(p_event->>'response_type', 'unknown'), 40), v_no_safe, left(coalesce(p_event->>'model', ''), 120),
    left(coalesce(p_event->>'prompt_version', ''), 40), left(coalesce(p_event->>'agent_version', ''), 40),
    coalesce(p_event->'signals', '{}'::jsonb), v_embedding)
  returning id into v_event_id;

  return jsonb_build_object('suppressed', false, 'groupId', v_group.id, 'created', v_created, 'reopened', v_reopened, 'eventId', v_event_id);
end;
$$;

-- ------------------------------------------------------- dashboard RPCs
-- security invoker: they run as anon and therefore stay inside the dashboard
-- secret RLS above. Every state change writes its audit row in the same
-- transaction; a failed audit insert rolls the change back.

create or replace function public.rafa_apply_knowledge_gap_action(
  p_group_id uuid,
  p_expected_status text,
  p_action text,
  p_actor text,
  p_reason text,
  p_patch jsonb default '{}'::jsonb,
  p_details jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_group public.rafa_knowledge_gap_groups%rowtype;
  v_actor text := left(trim(coalesce(p_actor, '')), 320);
  v_status text;
  v_patch jsonb := coalesce(p_patch, '{}'::jsonb);
begin
  if length(v_actor) = 0 then raise exception 'A knowledge gap action needs a named actor'; end if;
  if p_action is null or p_action !~ '^[a-z_]{1,40}$' then raise exception 'Unknown knowledge gap action'; end if;
  select * into v_group from public.rafa_knowledge_gap_groups where id = p_group_id for update;
  if not found then raise exception 'Knowledge gap not found'; end if;
  if p_expected_status is not null and v_group.status <> p_expected_status then
    raise exception 'Knowledge gap status changed from % to %; reload and retry', p_expected_status, v_group.status;
  end if;
  v_status := coalesce(nullif(v_patch->>'status', ''), v_group.status);

  update public.rafa_knowledge_gap_groups g set
    status = v_status,
    reason = coalesce(nullif(v_patch->>'reason', ''), g.reason),
    reason_locked = g.reason_locked or nullif(v_patch->>'reason', '') is not null,
    owner = case when v_patch ? 'owner' then nullif(trim(v_patch->>'owner'), '') else g.owner end,
    priority_override = case when v_patch ? 'priority_override' then nullif(v_patch->>'priority_override', '') else g.priority_override end,
    resolution = case when v_patch ? 'resolution' then v_patch->'resolution' else g.resolution end,
    resolved_at = case when v_status in ('resolved', 'verified') and g.status not in ('resolved', 'verified') then now()
                       when v_status not in ('resolved', 'verified') then null else g.resolved_at end,
    resolved_by = case when v_status in ('resolved', 'verified') and g.status not in ('resolved', 'verified') then v_actor
                       when v_status not in ('resolved', 'verified') then null else g.resolved_by end,
    verified_at = case when v_status = 'verified' then now() when v_status <> 'verified' then null else g.verified_at end,
    updated_at = now()
  where g.id = p_group_id;

  insert into public.rafa_knowledge_gap_audit (group_id, action, actor, reason, previous_status, new_status, details)
  values (p_group_id, p_action, v_actor, left(coalesce(p_reason, ''), 500), v_group.status, v_status, coalesce(p_details, '{}'::jsonb));

  return jsonb_build_object('groupId', p_group_id, 'previous', v_group.status, 'status', v_status);
end;
$$;

-- Links existing (or newly drafted) knowledge to a gap by reference and turns
-- the gap's questions into regression tests, in one transaction.
create or replace function public.rafa_link_knowledge_gap(
  p_group_id uuid,
  p_expected_status text,
  p_links jsonb,
  p_tests jsonb,
  p_action text,
  p_actor text,
  p_reason text,
  p_patch jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_actor text := left(trim(coalesce(p_actor, '')), 320);
  v_link jsonb;
  v_test jsonb;
  v_added integer := 0;
  v_existing integer := 0;
  v_tests integer := 0;
  v_rows integer;
  v_result jsonb;
begin
  if length(v_actor) = 0 then raise exception 'A knowledge gap link needs a named actor'; end if;
  if jsonb_typeof(coalesce(p_links, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_links, '[]'::jsonb)) = 0 then
    raise exception 'Choose at least one knowledge entry to link';
  end if;
  v_result := public.rafa_apply_knowledge_gap_action(p_group_id, p_expected_status, p_action, v_actor, p_reason, p_patch,
    jsonb_build_object('links', p_links));

  for v_link in select * from jsonb_array_elements(p_links) loop
    insert into public.rafa_knowledge_gap_links (group_id, chunk_id, document_id, source_id, link_type, weak_retrieval, label, linked_by, note)
    values (p_group_id, nullif(v_link->>'chunk_id', '')::uuid, nullif(v_link->>'document_id', '')::uuid, nullif(v_link->>'source_id', '')::uuid,
      coalesce(nullif(v_link->>'link_type', ''), 'existing'), coalesce((v_link->>'weak_retrieval')::boolean, false),
      left(coalesce(v_link->>'label', ''), 200), v_actor, left(coalesce(p_reason, ''), 500))
    on conflict do nothing;
    get diagnostics v_rows = row_count;
    if v_rows > 0 then v_added := v_added + 1; else v_existing := v_existing + 1; end if;
  end loop;

  for v_test in select * from jsonb_array_elements(coalesce(p_tests, '[]'::jsonb)) loop
    insert into public.rafa_knowledge_gap_regression_tests (group_id, query, query_fingerprint, language, expected_chunk_ids,
      expected_document_ids, expected_source_ids, expected_min_rank, expected_behavior, created_by)
    values (p_group_id, left(v_test->>'query', 500), v_test->>'query_fingerprint', coalesce(nullif(v_test->>'language', ''), 'und'),
      coalesce(array(select jsonb_array_elements_text(coalesce(v_test->'expected_chunk_ids', '[]'::jsonb))::uuid), '{}'),
      coalesce(array(select jsonb_array_elements_text(coalesce(v_test->'expected_document_ids', '[]'::jsonb))::uuid), '{}'),
      coalesce(array(select jsonb_array_elements_text(coalesce(v_test->'expected_source_ids', '[]'::jsonb))::uuid), '{}'),
      coalesce((v_test->>'expected_min_rank')::integer, 5), coalesce(nullif(v_test->>'expected_behavior', ''), 'grounded_answer'), v_actor)
    on conflict (group_id, query_fingerprint) do update set
      expected_chunk_ids = array(select distinct unnest(public.rafa_knowledge_gap_regression_tests.expected_chunk_ids || excluded.expected_chunk_ids)),
      expected_document_ids = array(select distinct unnest(public.rafa_knowledge_gap_regression_tests.expected_document_ids || excluded.expected_document_ids)),
      expected_source_ids = array(select distinct unnest(public.rafa_knowledge_gap_regression_tests.expected_source_ids || excluded.expected_source_ids)),
      expected_min_rank = least(public.rafa_knowledge_gap_regression_tests.expected_min_rank, excluded.expected_min_rank),
      active = true,
      updated_at = now();
    v_tests := v_tests + 1;
  end loop;

  return v_result || jsonb_build_object('linksAdded', v_added, 'linksAlreadyPresent', v_existing, 'testsUpserted', v_tests);
end;
$$;

-- Stores a verification run (real retrieval through searchApprovedKnowledge,
-- executed by the dashboard API) and, when requested, applies the resulting
-- status with its audit row.
create or replace function public.rafa_record_knowledge_gap_verification(
  p_group_id uuid,
  p_expected_status text,
  p_results jsonb,
  p_actor text,
  p_reason text,
  p_new_status text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_result jsonb;
  v_summary jsonb;
  v_failed integer;
  v_total integer;
begin
  if jsonb_typeof(coalesce(p_results, '[]'::jsonb)) <> 'array' then raise exception 'Verification results must be an array'; end if;
  update public.rafa_knowledge_gap_regression_tests t set
    last_result = r.result, last_rank = r.rank, last_run_at = now(), last_details = r.details, updated_at = now()
  from (select (x->>'id')::uuid as id, x->>'result' as result, nullif(x->>'rank', '')::integer as rank,
               coalesce(x->'details', '{}'::jsonb) as details
        from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) x) r
  where t.id = r.id and t.group_id = p_group_id;
  v_total := jsonb_array_length(coalesce(p_results, '[]'::jsonb));
  select count(*) into v_failed from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) x where x->>'result' <> 'pass';
  v_summary := jsonb_build_object('lastRunAt', now(), 'total', v_total, 'failed', v_failed, 'passed', v_total - v_failed);
  v_result := public.rafa_apply_knowledge_gap_action(p_group_id, p_expected_status, 'verify', p_actor, p_reason,
    jsonb_strip_nulls(jsonb_build_object('status', p_new_status, 'resolution', v_summary)), jsonb_build_object('results', p_results));
  return v_result || jsonb_build_object('summary', v_summary);
end;
$$;

-- ---------------------------------------------------------------- grants

revoke all on function public.rafa_match_knowledge_gap_groups(real[], integer) from public, anon, authenticated;
revoke all on function public.rafa_knowledge_gap_expired_matches(text, integer) from public, anon, authenticated;
revoke all on function public.rafa_record_knowledge_gap_event(uuid, jsonb, jsonb, real[], integer) from public, anon, authenticated;
revoke all on function public.rafa_apply_knowledge_gap_action(uuid, text, text, text, text, jsonb, jsonb) from public, authenticated;
revoke all on function public.rafa_link_knowledge_gap(uuid, text, jsonb, jsonb, text, text, text, jsonb) from public, authenticated;
revoke all on function public.rafa_record_knowledge_gap_verification(uuid, text, jsonb, text, text, text) from public, authenticated;
grant execute on function public.rafa_match_knowledge_gap_groups(real[], integer) to service_role;
grant execute on function public.rafa_knowledge_gap_expired_matches(text, integer) to service_role;
grant execute on function public.rafa_record_knowledge_gap_event(uuid, jsonb, jsonb, real[], integer) to service_role;
grant execute on function public.rafa_apply_knowledge_gap_action(uuid, text, text, text, text, jsonb, jsonb) to anon, service_role;
grant execute on function public.rafa_link_knowledge_gap(uuid, text, jsonb, jsonb, text, text, text, jsonb) to anon, service_role;
grant execute on function public.rafa_record_knowledge_gap_verification(uuid, text, jsonb, text, text, text) to anon, service_role;
