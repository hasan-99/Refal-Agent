grant select on table public.rafa_appointments to anon;
grant select on table public.rafa_reminder_jobs to anon;

create policy rafa_dashboard_appointments_read
  on public.rafa_appointments
  for select to anon
  using (public.rafa_dashboard_secret_matches());

create policy rafa_dashboard_reminders_read
  on public.rafa_reminder_jobs
  for select to anon
  using (public.rafa_dashboard_secret_matches());
