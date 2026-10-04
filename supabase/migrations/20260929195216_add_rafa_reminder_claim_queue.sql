alter table public.rafa_reminder_jobs
  drop constraint rafa_reminder_jobs_status_check;
alter table public.rafa_reminder_jobs
  add constraint rafa_reminder_jobs_status_check
  check (status in ('queued', 'processing', 'sent', 'failed', 'dead', 'cancelled'));

create or replace function public.rafa_claim_due_reminders(p_limit integer default 25)
returns setof public.rafa_reminder_jobs
language sql
volatile
security invoker
set search_path = ''
as $$
  with ready as (
    select id
    from public.rafa_reminder_jobs
    where status in ('queued', 'failed', 'processing')
      and next_attempt_at <= statement_timestamp()
    order by next_attempt_at, id
    for update skip locked
    limit least(greatest(coalesce(p_limit, 25), 1), 100)
  )
  update public.rafa_reminder_jobs as jobs
  set status = 'processing',
      attempts = jobs.attempts + 1,
      next_attempt_at = statement_timestamp() + interval '5 minutes'
  from ready
  where jobs.id = ready.id
  returning jobs.*;
$$;

revoke all on function public.rafa_claim_due_reminders(integer) from public, anon, authenticated;
grant execute on function public.rafa_claim_due_reminders(integer) to service_role;
