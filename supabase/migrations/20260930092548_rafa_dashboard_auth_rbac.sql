create table if not exists public.rafa_dashboard_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'user' check (role in ('admin', 'user')),
  is_active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists rafa_dashboard_users_role_active_idx
  on public.rafa_dashboard_users (role, is_active);

alter table public.rafa_dashboard_users enable row level security;
revoke all on table public.rafa_dashboard_users from public, anon, authenticated;
grant all on table public.rafa_dashboard_users to service_role;
grant select on table public.rafa_dashboard_users to anon;
create policy "Dashboard backend validates role by protected secret"
  on public.rafa_dashboard_users for select to anon
  using (rafa_private.dashboard_secret_matches());
grant usage on schema public to supabase_auth_admin;
grant select on table public.rafa_dashboard_users to supabase_auth_admin;
create policy "Auth hook reads dashboard roles"
  on public.rafa_dashboard_users for select to supabase_auth_admin using (true);

create or replace function public.rafa_dashboard_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  claims jsonb := event -> 'claims';
  dashboard_role text;
  dashboard_active boolean;
begin
  select u.role, u.is_active
    into dashboard_role, dashboard_active
    from public.rafa_dashboard_users as u
   where u.user_id = (event ->> 'user_id')::uuid;

  claims := jsonb_set(claims, '{dashboard_role}', to_jsonb(coalesce(dashboard_role, 'pending')), true);
  claims := jsonb_set(claims, '{dashboard_active}', to_jsonb(coalesce(dashboard_active, false)), true);
  return jsonb_set(event, '{claims}', claims, true);
end;
$$;

revoke all on function public.rafa_dashboard_access_token_hook(jsonb) from public, anon, authenticated;
grant execute on function public.rafa_dashboard_access_token_hook(jsonb) to supabase_auth_admin;

alter table public.rafa_agent_sessions
  add column if not exists owner_user_id uuid references auth.users(id) on delete set null;
create index if not exists rafa_agent_sessions_owner_updated_idx
  on public.rafa_agent_sessions (owner_user_id, updated_at desc);

grant select, insert, update, delete on public.rafa_agent_sessions to authenticated;
grant select, insert, update, delete on public.rafa_agent_messages to authenticated;
grant select, insert, update, delete on public.rafa_agent_memories to authenticated;

create or replace function rafa_private.dashboard_user_is_active()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select u.is_active from public.rafa_dashboard_users as u where u.user_id = (select auth.uid())),
    false
  );
$$;

create or replace function rafa_private.dashboard_user_is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select u.is_active and u.role = 'admin' from public.rafa_dashboard_users as u where u.user_id = (select auth.uid())),
    false
  );
$$;

revoke all on function rafa_private.dashboard_user_is_active() from public, anon;
revoke all on function rafa_private.dashboard_user_is_admin() from public, anon;
grant execute on function rafa_private.dashboard_user_is_active() to authenticated;
grant execute on function rafa_private.dashboard_user_is_admin() to authenticated;
grant usage on schema rafa_private to authenticated;

create or replace function public.rafa_bootstrap_dashboard_admin(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  lock table public.rafa_dashboard_users in exclusive mode;
  if exists (select 1 from public.rafa_dashboard_users where role = 'admin' and is_active) then
    raise exception using errcode = '23505', message = 'An active administrator already exists.';
  end if;
  insert into public.rafa_dashboard_users (user_id, role, is_active, created_by)
  values (p_user_id, 'admin', true, p_user_id);
end;
$$;

create or replace function public.rafa_update_dashboard_user(
  p_user_id uuid,
  p_role text,
  p_is_active boolean,
  p_actor_id uuid
)
returns table (user_id uuid, role text, is_active boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_role text;
  current_active boolean;
begin
  lock table public.rafa_dashboard_users in exclusive mode;
  if not exists (
    select 1 from public.rafa_dashboard_users
     where user_id = p_actor_id and role = 'admin' and is_active
  ) then
    raise exception using errcode = '42501', message = 'Administrator access is required.';
  end if;
  if p_role not in ('admin', 'user') then
    raise exception using errcode = '22023', message = 'Role must be admin or user.';
  end if;
  select u.role, u.is_active into current_role, current_active
    from public.rafa_dashboard_users as u where u.user_id = p_user_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'Dashboard account not found.';
  end if;
  if current_role = 'admin' and current_active and (p_role <> 'admin' or not p_is_active)
     and (select count(*) from public.rafa_dashboard_users where role = 'admin' and is_active) <= 1 then
    raise exception using errcode = '23514', message = 'The last active administrator cannot be demoted or disabled.';
  end if;
  return query
    update public.rafa_dashboard_users as u
       set role = p_role, is_active = p_is_active, updated_at = now()
     where u.user_id = p_user_id
     returning u.user_id, u.role, u.is_active;
end;
$$;

revoke all on function public.rafa_bootstrap_dashboard_admin(uuid) from public, anon, authenticated;
revoke all on function public.rafa_update_dashboard_user(uuid, text, boolean, uuid) from public, anon, authenticated;
grant execute on function public.rafa_bootstrap_dashboard_admin(uuid) to service_role;
grant execute on function public.rafa_update_dashboard_user(uuid, text, boolean, uuid) to service_role;

create policy "Users manage own RAFA sessions"
  on public.rafa_agent_sessions for all to authenticated
  using (
    rafa_private.dashboard_user_is_active()
    and (
      owner_user_id = (select auth.uid())
      or (owner_user_id is null and rafa_private.dashboard_user_is_admin())
    )
  )
  with check (
    rafa_private.dashboard_user_is_active()
    and (
      owner_user_id = (select auth.uid())
      or (owner_user_id is null and rafa_private.dashboard_user_is_admin())
    )
  );

create policy "Users access messages in permitted sessions"
  on public.rafa_agent_messages for all to authenticated
  using (
    exists (
      select 1 from public.rafa_agent_sessions as s
       where s.id = session_id
         and (s.owner_user_id = (select auth.uid())
           or (s.owner_user_id is null and rafa_private.dashboard_user_is_admin()))
         and rafa_private.dashboard_user_is_active()
    )
  )
  with check (
    exists (
      select 1 from public.rafa_agent_sessions as s
       where s.id = session_id
         and (s.owner_user_id = (select auth.uid())
           or (s.owner_user_id is null and rafa_private.dashboard_user_is_admin()))
         and rafa_private.dashboard_user_is_active()
    )
  );

create policy "Only active admins manage shared RAFA memory"
  on public.rafa_agent_memories for all to authenticated
  using (
    rafa_private.dashboard_user_is_admin()
  )
  with check (
    rafa_private.dashboard_user_is_admin()
  );
