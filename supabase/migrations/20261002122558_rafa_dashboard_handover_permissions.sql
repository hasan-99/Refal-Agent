-- The dashboard backend calls PostgREST with the publishable key and a
-- server-only secret. Keep these tables behind that secret-gated RLS policy.
grant select on public.rafa_contacts to anon;

grant select on public.rafa_handovers to anon;
grant update (status, resolved_at) on public.rafa_handovers to anon;

drop policy if exists rafa_dashboard_handover_read on public.rafa_handovers;
create policy rafa_dashboard_handover_read
  on public.rafa_handovers for select to anon
  using (public.rafa_dashboard_secret_matches());

drop policy if exists rafa_dashboard_handover_status_update on public.rafa_handovers;
create policy rafa_dashboard_handover_status_update
  on public.rafa_handovers for update to anon
  using (public.rafa_dashboard_secret_matches())
  with check (public.rafa_dashboard_secret_matches());

grant select on public.rafa_notification_jobs to anon;
drop policy if exists rafa_dashboard_notification_read on public.rafa_notification_jobs;
create policy rafa_dashboard_notification_read
  on public.rafa_notification_jobs for select to anon
  using (public.rafa_dashboard_secret_matches());
