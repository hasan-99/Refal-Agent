-- MIG-01 / P3.9 — refal_fact_register.
--
-- Rule 2 in schema form. Every fact REFAL may assert carries its provenance,
-- and its STATUS drives behaviour with no code change and no redeploy:
--
--   approved  -> statable, with its evidence
--   expired   -> REFAL says the figure is not currently confirmed and offers a
--                specialist follow up. It never guesses and never goes silent.
--   blocked   -> not retrievable at all, by any search path
--   pending   -> authored, not approved, treated as not statable
--
-- W3.9.4 (Rule 1): MB manual facts are seeded APPROVED, reviewer BOSS,
-- verified_at 2026-10-07. They are live from day one, not parked waiting for an
-- external reviewer. W3.9.5 (Rule 2) is what makes that safe: every row carries
-- expiry_or_review_at, so a stale figure stops being asserted on its own.
--
-- The seed rows are NOT in this file. They are generated from
-- src/factCatalogue.js by scripts/generateFactRegisterSeed.js into a companion
-- migration, so the database and the code can never drift into two different
-- opinions about what a fact says.
--
-- Mirrors src/factRegister.js exactly. If you change a constraint here, change
-- it there, and src/factRegister.test.js will tell you if you did not.
--
-- Safe to run twice.

-- ---------------------------------------------------------------- the register
create table if not exists public.refal_fact_register (
  fact_id text primary key check (fact_id ~ '^MB-(F([1-9]|[1-5][0-9]|6[0-6])|C[1-5]|J[0-4]|DYN[1-6])$'),
  claim_text text not null check (length(claim_text) between 25 and 1000),
  topics text[] not null default '{}'::text[],
  source_type text not null check (source_type in ('mb-manual','refalco-commercial','cy-authority','foreign-authority')),
  source_url_or_document text not null check (length(source_url_or_document) between 1 and 500),
  source_ref text not null default '',
  jurisdiction text not null check (jurisdiction in ('CY','EU','AE','EE','MT','BG','US','GLOBAL')),
  numbers jsonb not null default '[]'::jsonb,
  volatility text not null check (volatility in ('STABLE','VOLATILE')),
  trust_tier text not null check (trust_tier in ('regulated','commercial','explanatory')),
  high_risk boolean not null default false,
  reviewer text not null check (length(trim(reviewer)) > 0),
  verified_at date not null,
  effective_from date,
  expiry_or_review_at date not null,
  review_cadence_days integer not null check (review_cadence_days between 1 and 365),
  approved_languages text[] not null default array['ar','en','el']::text[],
  status text not null default 'approved' check (status in ('approved','expired','blocked','pending')),
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint refal_fact_register_numbers_array check (jsonb_typeof(numbers) = 'array'),
  constraint refal_fact_register_numbers_size check (pg_column_size(numbers) <= 4000),
  -- Rule 2 is only a safety net if the date is actually after the verification.
  constraint refal_fact_register_expiry_after_verified check (expiry_or_review_at > verified_at),
  -- W3.9.2: a high risk fact never gets a lazy cadence. 90 days is the cap, and
  -- it is enforced in the database as well as in src/factRegister.js, because
  -- the dashboard writes here directly.
  constraint refal_fact_register_high_risk_cadence check (not high_risk or review_cadence_days <= 90),
  constraint refal_fact_register_languages_known check (approved_languages <@ array['ar','en','el']::text[])
);

create index if not exists refal_fact_register_review_idx
  on public.refal_fact_register (expiry_or_review_at, fact_id) where status = 'approved';
create index if not exists refal_fact_register_status_idx
  on public.refal_fact_register (status, fact_id);
create index if not exists refal_fact_register_topics_idx
  on public.refal_fact_register using gin (topics);

comment on table public.refal_fact_register is
  'P3.9 Rule 2. One row per MB fact. Status drives whether REFAL may state it; expiry_or_review_at retires it automatically.';

-- ------------------------------------------------------------------- the audit
-- W3.9.7: a full audit of who changed which fact. Append only, and it feeds the
-- M12 dashboard audit view.
create table if not exists public.refal_fact_register_audit (
  id uuid primary key default gen_random_uuid(),
  fact_id text not null references public.refal_fact_register(fact_id) on delete cascade,
  action text not null check (action in ('seed','reapprove','block','unblock','expire','edit')),
  actor text not null check (length(trim(actor)) > 0),
  previous jsonb not null default '{}'::jsonb,
  next jsonb not null default '{}'::jsonb,
  reason text not null default '' check (length(reason) <= 500),
  created_at timestamptz not null default now(),
  constraint refal_fact_register_audit_previous_object check (jsonb_typeof(previous) = 'object'),
  constraint refal_fact_register_audit_next_object check (jsonb_typeof(next) = 'object')
);
create index if not exists refal_fact_register_audit_fact_idx
  on public.refal_fact_register_audit (fact_id, created_at desc);
create index if not exists refal_fact_register_audit_actor_idx
  on public.refal_fact_register_audit (actor, created_at desc);

-- ------------------------------------------------------------------- security
do $$
declare t text;
begin
  foreach t in array array['refal_fact_register','refal_fact_register_audit'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    execute format('grant select, insert, update, delete on table public.%I to service_role', t);
  end loop;
end $$;

-- The operator dashboard reaches Supabase with the anon key plus the
-- x-rafa-dashboard-secret header, exactly as it does for the knowledge tables
-- (20260929134435). Without this grant the W3.9.7 review screen and
-- scripts/brainHealth.js cannot read a single row, because no Node side
-- service_role credential exists anywhere in scripts/, src/ or dashboard/ --
-- only the Deno edge functions hold one.
--
-- The policy is the same gate the knowledge tables already use, so this widens
-- the credential surface by nothing: anyone who can read a knowledge chunk can
-- already read the claim it came from.
do $$
declare t text;
begin
  foreach t in array array['refal_fact_register','refal_fact_register_audit'] loop
    execute format('grant select, insert, update, delete on table public.%I to anon', t);
    execute format('drop policy if exists rafa_dashboard_%I on public.%I', t, t);
    execute format(
      'create policy rafa_dashboard_%I on public.%I for all to anon using (public.rafa_dashboard_secret_matches()) with check (public.rafa_dashboard_secret_matches())',
      t, t);
  end loop;
end $$;

grant execute on function public.refal_fact_effective_status(text, date, date, date) to anon;
grant execute on function public.refal_reapprove_fact(text, text, integer, text) to anon;
grant execute on function public.refal_set_fact_status(text, text, text, text) to anon;

drop trigger if exists set_refal_fact_register_updated_at on public.refal_fact_register;
create trigger set_refal_fact_register_updated_at
  before update on public.refal_fact_register
  for each row execute function public.set_rafa_updated_at();

-- ---------------------------------------------------------- effective status
-- The stored status is an intent. The EFFECTIVE status also accounts for the
-- clock and the effective date, which is the whole point of Rule 2: nobody has
-- to remember to flip a row to expired. Mirrors effectiveStatus() in
-- src/factRegister.js, including the "not yet in force is pending, not expired"
-- branch.
create or replace function public.refal_fact_effective_status(
  p_status text,
  p_expiry_or_review_at date,
  p_effective_from date,
  p_now date default null
)
returns text
language sql
immutable
security invoker
set search_path = ''
as $$
  select case
    when p_status = 'blocked' then 'blocked'
    when p_status = 'pending' then 'pending'
    when p_status = 'expired' then 'expired'
    when coalesce(p_now, current_date) > p_expiry_or_review_at then 'expired'
    when p_effective_from is not null and coalesce(p_now, current_date) < p_effective_from then 'pending'
    else 'approved'
  end;
$$;

-- ------------------------------------------------------------ dashboard views
-- W3.9.7: facts expiring in 7 days, plus everything already past its date.
--
-- `security_invoker` needs PostgreSQL 15 or newer. Without it the view would run
-- as its OWNER and quietly bypass the row level security above, which is the
-- single most common way an RLS protected table leaks through a convenience
-- view. This repo has no other view, so there is no precedent to lean on, and
-- the version cannot be checked from here: PostgREST exposes tables and RPCs,
-- not `select version()`. So the migration checks for itself and fails loudly
-- rather than silently creating a view that ignores the policy.
--
-- PG15 is a safe expectation for this project in any case: it already uses
-- `extensions.halfvec`, which needs pgvector 0.7, shipped only on PG15 and up.
do $$
begin
  if current_setting('server_version_num')::integer < 150000 then
    raise exception 'refal_facts_due_for_review needs PostgreSQL 15 or newer for security_invoker views; this server reports %', current_setting('server_version');
  end if;
end $$;

create or replace view public.refal_facts_due_for_review
with (security_invoker = true)
as
  select
    r.fact_id,
    r.claim_text,
    r.topics,
    r.jurisdiction,
    r.high_risk,
    r.numbers,
    r.reviewer,
    r.verified_at,
    r.effective_from,
    r.expiry_or_review_at,
    r.review_cadence_days,
    r.status,
    public.refal_fact_effective_status(r.status, r.expiry_or_review_at, r.effective_from) as effective_status,
    (r.expiry_or_review_at - current_date) as days_left
  from public.refal_fact_register r
  where r.status = 'approved'
    and r.expiry_or_review_at <= current_date + 7
  order by r.expiry_or_review_at asc, r.fact_id asc;

comment on view public.refal_facts_due_for_review is
  'W3.9.7 review soon list. days_left goes negative for a fact that has already stopped being stated.';

-- ----------------------------------------------------- one click re-approval
-- W3.9.7. Re-dating is from TODAY, not from the old expiry, so a row that sat
-- expired for a month does not come back already half spent. Writes its own
-- audit row, so there is no way to extend a fact without a named actor.
create or replace function public.refal_reapprove_fact(
  p_fact_id text,
  p_reviewer text,
  p_cadence_days integer default null,
  p_reason text default ''
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_before public.refal_fact_register;
  v_after public.refal_fact_register;
  v_cadence integer;
begin
  if length(trim(coalesce(p_reviewer, ''))) = 0 then
    raise exception 'A re-approval needs a named reviewer';
  end if;

  select * into v_before from public.refal_fact_register where fact_id = p_fact_id for update;
  if not found then
    raise exception 'Unknown fact %', p_fact_id;
  end if;

  v_cadence := coalesce(p_cadence_days, v_before.review_cadence_days);
  if v_before.high_risk and v_cadence > 90 then
    raise exception '% is high risk and cannot be given a % day cadence', p_fact_id, v_cadence;
  end if;

  update public.refal_fact_register
  set reviewer = p_reviewer,
      verified_at = current_date,
      status = 'approved',
      review_cadence_days = v_cadence,
      expiry_or_review_at = current_date + v_cadence
  where fact_id = p_fact_id
  returning * into v_after;

  insert into public.refal_fact_register_audit (fact_id, action, actor, previous, next, reason)
  values (
    p_fact_id, 'reapprove', p_reviewer,
    jsonb_build_object('status', v_before.status, 'verified_at', v_before.verified_at,
                       'expiry_or_review_at', v_before.expiry_or_review_at,
                       'review_cadence_days', v_before.review_cadence_days),
    jsonb_build_object('status', v_after.status, 'verified_at', v_after.verified_at,
                       'expiry_or_review_at', v_after.expiry_or_review_at,
                       'review_cadence_days', v_after.review_cadence_days),
    left(coalesce(p_reason, ''), 500)
  );

  return jsonb_build_object(
    'fact_id', v_after.fact_id,
    'status', v_after.status,
    'verified_at', v_after.verified_at,
    'expiry_or_review_at', v_after.expiry_or_review_at
  );
end;
$$;

-- --------------------------------------------------- status change, audited
-- Blocking a fact is the one change that must never happen silently, because a
-- blocked fact disappears from retrieval entirely.
create or replace function public.refal_set_fact_status(
  p_fact_id text,
  p_status text,
  p_actor text,
  p_reason text default ''
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_before public.refal_fact_register;
  v_action text;
begin
  if length(trim(coalesce(p_actor, ''))) = 0 then
    raise exception 'A status change needs a named actor';
  end if;
  if p_status not in ('approved','expired','blocked','pending') then
    raise exception 'Unknown status %', p_status;
  end if;

  select * into v_before from public.refal_fact_register where fact_id = p_fact_id for update;
  if not found then
    raise exception 'Unknown fact %', p_fact_id;
  end if;

  v_action := case
    when p_status = 'blocked' then 'block'
    when v_before.status = 'blocked' then 'unblock'
    when p_status = 'expired' then 'expire'
    else 'edit'
  end;

  update public.refal_fact_register set status = p_status where fact_id = p_fact_id;

  insert into public.refal_fact_register_audit (fact_id, action, actor, previous, next, reason)
  values (p_fact_id, v_action, p_actor,
          jsonb_build_object('status', v_before.status),
          jsonb_build_object('status', p_status),
          left(coalesce(p_reason, ''), 500));

  return jsonb_build_object('fact_id', p_fact_id, 'status', p_status, 'action', v_action);
end;
$$;

revoke all on function public.refal_fact_effective_status(text, date, date, date) from public, anon, authenticated;
revoke all on function public.refal_reapprove_fact(text, text, integer, text) from public, anon, authenticated;
revoke all on function public.refal_set_fact_status(text, text, text, text) from public, anon, authenticated;
grant execute on function public.refal_fact_effective_status(text, date, date, date) to service_role;
grant execute on function public.refal_reapprove_fact(text, text, integer, text) to service_role;
grant execute on function public.refal_set_fact_status(text, text, text, text) to service_role;

-- ROLLBACK:
-- drop policy if exists rafa_dashboard_refal_fact_register_audit on public.refal_fact_register_audit;
-- drop policy if exists rafa_dashboard_refal_fact_register on public.refal_fact_register;
-- drop function if exists public.refal_set_fact_status(text, text, text, text);
-- drop function if exists public.refal_reapprove_fact(text, text, integer, text);
-- drop view if exists public.refal_facts_due_for_review;
-- drop function if exists public.refal_fact_effective_status(text, date, date, date);
-- drop trigger if exists set_refal_fact_register_updated_at on public.refal_fact_register;
-- drop table if exists public.refal_fact_register_audit;
-- drop table if exists public.refal_fact_register;
