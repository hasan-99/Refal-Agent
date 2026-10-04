create schema if not exists rafa_private;
revoke all on schema rafa_private from public, anon, authenticated;
grant usage on schema rafa_private to anon, service_role;

create table if not exists rafa_private.api_secret_hashes (
  name text primary key check (name in ('dashboard', 'rafa_api')),
  secret_sha256 bytea not null check (octet_length(secret_sha256) = 32),
  updated_at timestamptz not null default now()
);

alter table rafa_private.api_secret_hashes enable row level security;
revoke all on table rafa_private.api_secret_hashes from public, anon, authenticated, service_role;

create or replace function rafa_private.secret_matches(secret_name text, supplied_secret text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select secret_sha256 = extensions.digest(convert_to(supplied_secret, 'UTF8'), 'sha256')
     from rafa_private.api_secret_hashes
     where name = secret_name),
    false
  );
$$;

revoke all on function rafa_private.secret_matches(text, text) from public, authenticated;
grant execute on function rafa_private.secret_matches(text, text) to anon, service_role;

create or replace function rafa_private.dashboard_secret_matches()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select rafa_private.secret_matches(
    'dashboard',
    coalesce(nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-rafa-dashboard-secret', '')
  );
$$;

revoke all on function rafa_private.dashboard_secret_matches() from public, authenticated;
grant execute on function rafa_private.dashboard_secret_matches() to anon, service_role;

create or replace function public.rafa_dashboard_secret_matches()
returns boolean
language sql
stable
set search_path = ''
as $$
  select rafa_private.dashboard_secret_matches();
$$;

revoke all on function public.rafa_dashboard_secret_matches() from public, authenticated;
grant execute on function public.rafa_dashboard_secret_matches() to anon;

create or replace function public.rafa_validate_api_secret(p_secret text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select rafa_private.secret_matches('rafa_api', coalesce(p_secret, ''));
$$;

revoke all on function public.rafa_validate_api_secret(text) from public, anon, authenticated;
grant execute on function public.rafa_validate_api_secret(text) to service_role;
