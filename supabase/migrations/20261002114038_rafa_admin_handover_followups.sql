alter table public.rafa_notification_jobs
  drop constraint if exists rafa_notification_jobs_kind_check,
  add constraint rafa_notification_jobs_kind_check
    check (kind in ('owner_review', 'customer_message', 'handover_review', 'admin_followup')),
  drop constraint if exists rafa_notification_jobs_status_check,
  add constraint rafa_notification_jobs_status_check
    check (status in ('draft', 'queued', 'processing', 'sent', 'failed', 'dead', 'cancelled')),
  add column if not exists handover_id uuid references public.rafa_handovers(id) on delete set null;

create index if not exists rafa_notification_jobs_handover_idx
  on public.rafa_notification_jobs (handover_id, created_at desc)
  where handover_id is not null;
