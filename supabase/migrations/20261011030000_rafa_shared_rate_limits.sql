-- P13.2 / MIG-13 — shared, atomic per-contact rate limits.
-- Only keyed HMACs of contacts are stored. The service-role-only Edge gateway
-- is the sole caller; public clients cannot inspect or consume these counters.

create table if not exists public.refal_rate_limits (
  scope text not null check (scope in ('incoming_minute', 'ai_daily')),
  subject_hash text not null check (subject_hash ~ '^[a-f0-9]{64}$'),
  window_started_at timestamptz not null,
  request_count integer not null check (request_count > 0),
  updated_at timestamptz not null default now(),
  primary key (scope, subject_hash)
);

create index if not exists refal_rate_limits_updated_at_idx
  on public.refal_rate_limits (updated_at);

alter table public.refal_rate_limits enable row level security;
revoke all on table public.refal_rate_limits from public, anon, authenticated;
grant select, insert, update, delete on table public.refal_rate_limits to service_role;

create or replace function public.rafa_consume_rate_limit(
  p_scope text,
  p_subject_hash text,
  p_limit integer
)
returns table(allowed boolean, remaining integer, retry_after_seconds integer)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_window_start timestamptz;
  v_count integer;
  v_window_seconds integer;
begin
  if p_scope not in ('incoming_minute', 'ai_daily')
    or p_subject_hash is null
    or p_subject_hash !~ '^[a-f0-9]{64}$'
    or p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception 'invalid rate limit request' using errcode = '22023';
  end if;

  v_window_seconds := case when p_scope = 'incoming_minute' then 60 else 86400 end;

  insert into public.refal_rate_limits as current
    (scope, subject_hash, window_started_at, request_count, updated_at)
  values (
    p_scope,
    p_subject_hash,
    case when p_scope = 'ai_daily'
      then date_trunc('day', v_now at time zone 'UTC') at time zone 'UTC'
      else v_now
    end,
    1,
    v_now
  )
  on conflict (scope, subject_hash) do update set
    window_started_at = case
      when p_scope = 'ai_daily'
        and current.window_started_at < date_trunc('day', v_now at time zone 'UTC') at time zone 'UTC'
        then date_trunc('day', v_now at time zone 'UTC') at time zone 'UTC'
      when p_scope = 'incoming_minute'
        and current.window_started_at <= v_now - interval '60 seconds'
        then v_now
      else current.window_started_at
    end,
    request_count = case
      when p_scope = 'ai_daily'
        and current.window_started_at < date_trunc('day', v_now at time zone 'UTC') at time zone 'UTC'
        then 1
      when p_scope = 'incoming_minute'
        and current.window_started_at <= v_now - interval '60 seconds'
        then 1
      when current.request_count <= p_limit
        then current.request_count + 1
      else current.request_count
    end,
    updated_at = v_now
  returning current.window_started_at, current.request_count
  into v_window_start, v_count;

  return query select
    v_count <= p_limit,
    greatest(p_limit - v_count, 0),
    greatest(ceil(extract(epoch from (
      v_window_start + make_interval(secs => v_window_seconds) - v_now
    )))::integer, 0);
end;
$$;

revoke all on function public.rafa_consume_rate_limit(text, text, integer) from public, anon, authenticated;
grant execute on function public.rafa_consume_rate_limit(text, text, integer) to service_role;

comment on table public.refal_rate_limits is
  'Atomic shared contact limits. subject_hash is an HMAC from the API server; never store the raw contact ID here.';

-- ROLLBACK:
-- drop function if exists public.rafa_consume_rate_limit(text, text, integer);
-- drop table if exists public.refal_rate_limits;
