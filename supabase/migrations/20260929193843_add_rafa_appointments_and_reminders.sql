create table public.rafa_appointments (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.rafa_contacts(id) on delete cascade,
  whatsapp_jid text not null,
  status text not null default 'pending_calendar'
    check (status in ('pending_calendar', 'confirmed', 'cancelled', 'completed', 'failed')),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  timezone text not null default 'Europe/Nicosia',
  duration_minutes integer not null check (duration_minutes between 1 and 240),
  purpose text not null check (length(btrim(purpose)) between 1 and 1000),
  idempotency_key text not null unique check (length(btrim(idempotency_key)) between 1 and 200),
  calendar_id text not null,
  google_event_id text,
  google_event_url text,
  created_at timestamptz not null default now(),
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  constraint rafa_appointments_valid_time check (ends_at > starts_at),
  constraint rafa_appointments_event_identity unique (calendar_id, google_event_id)
);

create index rafa_appointments_contact_created_idx
  on public.rafa_appointments (contact_id, created_at desc);
create index rafa_appointments_status_start_idx
  on public.rafa_appointments (status, starts_at)
  where status in ('pending_calendar', 'confirmed');
create index rafa_appointments_whatsapp_start_idx
  on public.rafa_appointments (whatsapp_jid, starts_at desc);

create table public.rafa_reminder_jobs (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references public.rafa_appointments(id) on delete cascade,
  reminder_kind text not null check (length(btrim(reminder_kind)) between 1 and 80),
  channel text not null check (channel in ('whatsapp', 'email')),
  recipient text not null check (length(btrim(recipient)) between 1 and 320),
  due_at timestamptz not null,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'sent', 'failed', 'cancelled')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null,
  sent_at timestamptz,
  provider_message_id text,
  last_error text,
  idempotency_key text not null unique check (length(btrim(idempotency_key)) between 1 and 240),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create index rafa_reminder_jobs_due_idx
  on public.rafa_reminder_jobs (next_attempt_at, id)
  where status in ('queued', 'failed');
create index rafa_reminder_jobs_appointment_idx
  on public.rafa_reminder_jobs (appointment_id, due_at);

create trigger set_rafa_reminder_jobs_updated_at
before update on public.rafa_reminder_jobs
for each row execute function public.set_rafa_updated_at();

alter table public.rafa_appointments enable row level security;
alter table public.rafa_reminder_jobs enable row level security;

revoke all on table public.rafa_appointments from anon, authenticated;
revoke all on table public.rafa_reminder_jobs from anon, authenticated;
grant select, insert, update, delete on table public.rafa_appointments to service_role;
grant select, insert, update, delete on table public.rafa_reminder_jobs to service_role;
