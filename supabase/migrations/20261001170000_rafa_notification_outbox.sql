create table if not exists public.rafa_notification_jobs (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid references public.rafa_appointments(id) on delete set null,
  channel text not null check (channel in ('whatsapp', 'email')),
  kind text not null check (kind in ('owner_review', 'customer_message')),
  recipient text not null check (length(btrim(recipient)) between 1 and 320),
  payload jsonb not null default '{}'::jsonb,
  expected_appointment_status text,
  status text not null default 'queued' check (status in ('queued', 'processing', 'sent', 'failed', 'dead', 'cancelled')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  sent_at timestamptz,
  provider_message_id text,
  last_error text,
  idempotency_key text not null unique check (length(btrim(idempotency_key)) between 1 and 240),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint rafa_notification_payload_size check (pg_column_size(payload) <= 12000)
);

create index if not exists rafa_notification_jobs_due_idx
  on public.rafa_notification_jobs (next_attempt_at, created_at)
  where status in ('queued', 'failed');
create index if not exists rafa_notification_jobs_lease_idx
  on public.rafa_notification_jobs (locked_at, created_at)
  where status = 'processing';
create index if not exists rafa_notification_jobs_appointment_idx
  on public.rafa_notification_jobs (appointment_id, created_at desc);

create trigger set_rafa_notification_jobs_updated_at
before update on public.rafa_notification_jobs
for each row execute function public.set_rafa_updated_at();

alter table public.rafa_notification_jobs enable row level security;
revoke all on table public.rafa_notification_jobs from anon, authenticated;
grant select, insert, update on table public.rafa_notification_jobs to service_role;

create or replace function public.rafa_claim_due_notifications(p_limit integer default 25)
returns setof public.rafa_notification_jobs
language sql
security definer
set search_path = ''
as $$
  with due as (
    select id
    from public.rafa_notification_jobs
    where (status in ('queued', 'failed') and next_attempt_at <= now())
       or (status = 'processing' and locked_at < now() - interval '2 minutes')
    order by next_attempt_at, created_at
    for update skip locked
    limit least(greatest(coalesce(p_limit, 25), 1), 100)
  )
  update public.rafa_notification_jobs jobs
  set status = 'processing', attempts = jobs.attempts + 1, locked_at = now(), updated_at = now()
  from due
  where jobs.id = due.id
  returning jobs.*;
$$;

revoke all on function public.rafa_claim_due_notifications(integer) from public, anon, authenticated;
grant execute on function public.rafa_claim_due_notifications(integer) to service_role;
