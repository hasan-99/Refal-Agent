begin;
set local lock_timeout = '5s';

-- Stop the legacy reminder worker before applying this migration. Existing
-- `processing` and `failed` rows may already have reached the provider under
-- the legacy worker, so quarantine them instead of allowing another send.
alter table public.rafa_reminder_jobs
  drop constraint rafa_reminder_jobs_status_check;
alter table public.rafa_reminder_jobs
  add constraint rafa_reminder_jobs_status_check
  check (status in ('queued', 'processing', 'sending', 'sent', 'failed', 'dead', 'uncertain', 'cancelled'));

update public.rafa_reminder_jobs
set status = 'uncertain',
    last_error = concat_ws('; ', nullif(btrim(last_error), ''), 'Pre-upgrade reminder state quarantined; provider outcome may be ambiguous.')
where status in ('processing', 'failed');

drop index if exists public.rafa_reminder_jobs_due_idx;
create index rafa_reminder_jobs_due_idx
  on public.rafa_reminder_jobs (next_attempt_at, id)
  where status in ('queued', 'failed');

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
    where status in ('queued', 'failed')
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

commit;

-- ROLLBACK:
-- Stop all reminder workers first. Do not automatically restore quarantined
-- `uncertain` rows to `failed` or `processing`: their provider outcome may be
-- ambiguous and retrying could send a duplicate. Resolve those rows manually
-- with provider evidence. Then restore the prior claim function/index/status
-- constraint from the migration immediately before this one. Preserve the
-- `sending` and `uncertain` states until all rows are reconciled.
