drop index if exists public.rafa_reminder_jobs_due_idx;

create index rafa_reminder_jobs_due_idx
  on public.rafa_reminder_jobs (next_attempt_at, id)
  where status in ('queued', 'failed', 'processing');
