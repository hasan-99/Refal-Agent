create extension if not exists pgcrypto;

create table if not exists public.rafa_contacts (
  id uuid primary key default gen_random_uuid(),
  whatsapp_jid text not null unique,
  phone text not null default '',
  profile jsonb not null default '{}'::jsonb,
  step text,
  whatsapp jsonb not null default '{}'::jsonb,
  booking jsonb,
  last_follow_up_sent timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.rafa_conversation_turns (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid references public.rafa_contacts(id) on delete cascade,
  user_id text not null,
  message text not null default '',
  response text not null default '',
  automated boolean not null default false,
  source text not null default 'whatsapp',
  metadata jsonb not null default '{}'::jsonb,
  at timestamptz not null default now()
);

create table if not exists public.rafa_events (
  id uuid primary key default gen_random_uuid(),
  event text not null,
  fields jsonb not null default '{}'::jsonb,
  at timestamptz not null default now()
);

create table if not exists public.rafa_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists rafa_contacts_whatsapp_jid_idx on public.rafa_contacts (whatsapp_jid);
create index if not exists rafa_contacts_updated_at_idx on public.rafa_contacts (updated_at desc);
create index if not exists rafa_contacts_lead_tier_idx on public.rafa_contacts ((profile->>'leadTier'));
create index if not exists rafa_contacts_lead_score_idx on public.rafa_contacts (((profile->>'leadScore')::int));
create index if not exists rafa_conversation_turns_user_at_idx on public.rafa_conversation_turns (user_id, at desc);
create index if not exists rafa_conversation_turns_contact_at_idx on public.rafa_conversation_turns (contact_id, at desc);
create index if not exists rafa_events_event_at_idx on public.rafa_events (event, at desc);

alter table public.rafa_contacts enable row level security;
alter table public.rafa_conversation_turns enable row level security;
alter table public.rafa_events enable row level security;
alter table public.rafa_settings enable row level security;

revoke all on table public.rafa_contacts from anon, authenticated;
revoke all on table public.rafa_conversation_turns from anon, authenticated;
revoke all on table public.rafa_events from anon, authenticated;
revoke all on table public.rafa_settings from anon, authenticated;

create or replace function public.set_rafa_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke execute on function public.set_rafa_updated_at() from public;

drop trigger if exists set_rafa_contacts_updated_at on public.rafa_contacts;
create trigger set_rafa_contacts_updated_at
before update on public.rafa_contacts
for each row execute function public.set_rafa_updated_at();

drop trigger if exists set_rafa_settings_updated_at on public.rafa_settings;
create trigger set_rafa_settings_updated_at
before update on public.rafa_settings
for each row execute function public.set_rafa_updated_at();
