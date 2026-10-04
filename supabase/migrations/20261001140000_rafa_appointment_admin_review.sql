alter table public.rafa_appointments
  drop constraint if exists rafa_appointments_status_check;

alter table public.rafa_appointments
  add constraint rafa_appointments_status_check
  check (status in ('pending_review', 'pending_calendar', 'confirmed', 'rejected', 'rescheduled', 'cancelled', 'completed', 'failed'));

alter table public.rafa_appointments
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewed_by text,
  add column if not exists review_reason text;

alter table public.rafa_appointments
  drop constraint if exists rafa_appointments_review_reason_length;
alter table public.rafa_appointments
  add constraint rafa_appointments_review_reason_length
  check (review_reason is null or length(btrim(review_reason)) between 1 and 500);

drop index if exists public.rafa_appointments_status_start_idx;
create index rafa_appointments_status_start_idx
  on public.rafa_appointments (status, starts_at)
  where status in ('pending_review', 'pending_calendar', 'confirmed', 'rescheduled');
