-- Retention for the durable per-contact memory profile (RAFA_USER_PROFILE_MEMORY).
--
-- The profile lives inside the existing rafa_contacts.profile jsonb under the
-- key "memoryProfile" (no new column; the worker already writes profile via
-- PUT /contacts). The worker ignores entries older than
-- RAFA_USER_PROFILE_RETENTION_DAYS on read and drops them on its next write;
-- this function lets an operator (or a scheduled job, not created here)
-- physically remove profiles whose last update is older than the retention
-- window, for contacts who never come back.
--
-- Scope: removes ONLY profile->'memoryProfile'. It never touches any other
-- profile key, conversation turns, leads, consents or handovers. The existing
-- refal_reset_conversation_context() already drops memoryProfile, because it
-- rebuilds profile from a short allowlist.
--
-- Written for review only. NOT applied. Run manually after review:
--   select public.rafa_purge_expired_memory_profiles(180);
--
-- Rollback:
--   drop function if exists public.rafa_purge_expired_memory_profiles(integer);

create or replace function public.rafa_purge_expired_memory_profiles(p_retention_days integer default 180)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_removed integer := 0;
begin
  if p_retention_days is null or p_retention_days < 1 or p_retention_days > 730 then
    raise exception 'retention days must be between 1 and 730';
  end if;

  with expired as (
    select c.id
      from public.rafa_contacts c
     where c.profile ? 'memoryProfile'
       and (
         jsonb_typeof(c.profile->'memoryProfile') <> 'object'
         or coalesce(c.profile->'memoryProfile'->>'updatedAt', '') !~ '^\d{4}-\d{2}-\d{2}T'
         or (c.profile->'memoryProfile'->>'updatedAt')::timestamptz
              < pg_catalog.clock_timestamp() - pg_catalog.make_interval(days => p_retention_days)
       )
     for update
  )
  update public.rafa_contacts c
     set profile = c.profile - 'memoryProfile'
    from expired
   where c.id = expired.id;

  get diagnostics v_removed = row_count;
  return v_removed;
end;
$function$;

revoke all on function public.rafa_purge_expired_memory_profiles(integer) from public, anon, authenticated;
grant execute on function public.rafa_purge_expired_memory_profiles(integer) to service_role;
