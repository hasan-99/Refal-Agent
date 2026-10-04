create or replace function public.rafa_dashboard_secret_matches()
returns boolean
language sql
stable
as $$
  select false;
$$;

revoke execute on function public.rafa_dashboard_secret_matches() from public;
grant execute on function public.rafa_dashboard_secret_matches() to anon;

grant select, insert, update, delete on table public.rafa_agent_sessions to anon;
grant select, insert, update, delete on table public.rafa_agent_messages to anon;
grant select, insert, update, delete on table public.rafa_agent_memories to anon;

drop policy if exists "Dashboard secret can manage RAFA agent sessions" on public.rafa_agent_sessions;
drop policy if exists "Dashboard secret can manage RAFA agent messages" on public.rafa_agent_messages;
drop policy if exists "Dashboard secret can manage RAFA agent memories" on public.rafa_agent_memories;

create policy "Dashboard secret can manage RAFA agent sessions"
on public.rafa_agent_sessions
for all
to anon
using (public.rafa_dashboard_secret_matches())
with check (public.rafa_dashboard_secret_matches());

create policy "Dashboard secret can manage RAFA agent messages"
on public.rafa_agent_messages
for all
to anon
using (public.rafa_dashboard_secret_matches())
with check (public.rafa_dashboard_secret_matches());

create policy "Dashboard secret can manage RAFA agent memories"
on public.rafa_agent_memories
for all
to anon
using (public.rafa_dashboard_secret_matches())
with check (public.rafa_dashboard_secret_matches());
