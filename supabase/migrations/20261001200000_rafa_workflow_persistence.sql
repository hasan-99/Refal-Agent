-- Durable, normalized state for REFAL qualification and escalation workflows.
-- Customer data is written through the protected service-role Edge API only.

create table if not exists public.rafa_lead_qualifications (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.rafa_contacts(id) on delete cascade,
  need smallint not null check (need between 0 and 5),
  value smallint not null check (value between 0 and 5),
  timing smallint not null check (timing between 0 and 5),
  authority smallint not null check (authority between 0 and 5),
  readiness smallint not null check (readiness between 0 and 5),
  fit smallint not null check (fit between 0 and 5),
  total smallint generated always as (need + value + timing + authority + readiness + fit) stored check (total between 0 and 30),
  status text not null check (status in ('unclassified', 'cold', 'warm', 'hot', 'priority')),
  priority_reason text,
  thresholds jsonb not null default '{}'::jsonb,
  source_turn_id uuid references public.rafa_conversation_turns(id) on delete set null,
  assessed_at timestamptz not null default now(),
  constraint rafa_lead_qualifications_reason_size check (priority_reason is null or length(priority_reason) <= 120),
  constraint rafa_lead_qualifications_thresholds_object check (jsonb_typeof(thresholds) = 'object'),
  constraint rafa_lead_qualifications_thresholds_size check (pg_column_size(thresholds) <= 2000)
);
create unique index if not exists rafa_lead_qualifications_current_idx on public.rafa_lead_qualifications (contact_id);
create index if not exists rafa_lead_qualifications_status_idx on public.rafa_lead_qualifications (status, assessed_at desc);

create table if not exists public.rafa_contact_intents (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.rafa_contacts(id) on delete cascade,
  intent text not null check (intent in ('real_estate','development','construction','land','investment','partnership','corporate_services','customer_service','appointment','complaint','existing_client','prompt_injection','unknown')),
  confidence numeric(4,3) check (confidence is null or confidence between 0 and 1),
  source text not null default 'deterministic' check (source in ('deterministic','operator','system')),
  source_turn_id uuid references public.rafa_conversation_turns(id) on delete set null,
  detected_at timestamptz not null default now(),
  unique (contact_id, intent)
);
create index if not exists rafa_contact_intents_contact_idx on public.rafa_contact_intents (contact_id, detected_at desc);

create table if not exists public.rafa_contact_consents (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.rafa_contacts(id) on delete cascade,
  consent_type text not null check (consent_type in ('follow_up')),
  state text not null check (state in ('unknown','granted','denied','revoked')),
  source_turn_id uuid references public.rafa_conversation_turns(id) on delete set null,
  observed_at timestamptz not null default now(),
  unique (contact_id, consent_type)
);
create index if not exists rafa_contact_consents_state_idx on public.rafa_contact_consents (state, observed_at desc);

create table if not exists public.rafa_follow_up_states (
  contact_id uuid primary key references public.rafa_contacts(id) on delete cascade,
  consent_state text not null default 'unknown' check (consent_state in ('unknown','granted','denied','revoked')),
  status text not null default 'idle' check (status in ('idle','eligible','scheduled','sent','suppressed')),
  next_due_at timestamptz,
  last_sent_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint rafa_follow_up_state_dates check (last_sent_at is null or next_due_at is null or next_due_at >= last_sent_at)
);
create index if not exists rafa_follow_up_states_due_idx on public.rafa_follow_up_states (next_due_at, contact_id) where status in ('eligible','scheduled');

create table if not exists public.rafa_handovers (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.rafa_contacts(id) on delete cascade,
  department text not null check (department in ('customer_service','corporate_services','real_estate','development_construction','investment','partnerships','complaints','existing_client','appointments','general')),
  priority text not null default 'normal' check (priority in ('normal','high','urgent')),
  status text not null default 'open' check (status in ('open','acknowledged','resolved','cancelled')),
  summary jsonb not null default '{}'::jsonb,
  source_turn_id uuid references public.rafa_conversation_turns(id) on delete set null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  constraint rafa_handovers_summary_object check (jsonb_typeof(summary) = 'object'),
  constraint rafa_handovers_summary_size check (pg_column_size(summary) <= 12000)
);
create index if not exists rafa_handovers_queue_idx on public.rafa_handovers (status, priority, created_at desc);
create index if not exists rafa_handovers_contact_idx on public.rafa_handovers (contact_id, created_at desc);

create table if not exists public.rafa_priority_alerts (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.rafa_contacts(id) on delete cascade,
  level text not null check (level in ('high','urgent')),
  trigger text not null check (trigger in ('major_development','institutional_investment','strategic_partnership','complaint','severe_complaint','existing_client','safety_or_threat','material_business_opportunity')),
  status text not null default 'open' check (status in ('open','acknowledged','resolved','dismissed')),
  details jsonb not null default '{}'::jsonb,
  source_turn_id uuid references public.rafa_conversation_turns(id) on delete set null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  constraint rafa_priority_alerts_details_object check (jsonb_typeof(details) = 'object'),
  constraint rafa_priority_alerts_details_size check (pg_column_size(details) <= 6000)
);
create unique index if not exists rafa_priority_alerts_open_unique_idx on public.rafa_priority_alerts (contact_id, trigger) where status in ('open','acknowledged');
create index if not exists rafa_priority_alerts_queue_idx on public.rafa_priority_alerts (status, level, created_at desc);

create table if not exists public.rafa_complaints (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.rafa_contacts(id) on delete cascade,
  severity text not null check (severity in ('high','urgent')),
  status text not null default 'open' check (status in ('open','acknowledged','resolved','closed')),
  summary text not null check (length(btrim(summary)) between 1 and 2000),
  source_turn_id uuid references public.rafa_conversation_turns(id) on delete set null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists rafa_complaints_queue_idx on public.rafa_complaints (status, severity, created_at desc);
create index if not exists rafa_complaints_contact_idx on public.rafa_complaints (contact_id, created_at desc);

create table if not exists public.rafa_existing_client_verifications (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.rafa_contacts(id) on delete cascade,
  state text not null check (state in ('unauthenticated','awaiting_identifier','awaiting_verification','authenticated','failed','locked')),
  attempts smallint not null default 0 check (attempts between 0 and 3),
  identifier_provided boolean not null default false,
  verified boolean not null default false,
  account_disclosure_allowed boolean not null default false,
  verified_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (contact_id),
  constraint rafa_existing_client_verified_consistency check ((verified and state = 'authenticated' and account_disclosure_allowed) or (not verified and not account_disclosure_allowed))
);
create index if not exists rafa_existing_client_verifications_state_idx on public.rafa_existing_client_verifications (state, updated_at desc);

create table if not exists public.rafa_audit_events (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid references public.rafa_contacts(id) on delete set null,
  event text not null check (length(btrim(event)) between 1 and 120),
  actor_type text not null check (actor_type in ('system','customer','operator','admin')),
  source text not null default 'rafa-agent-api' check (length(btrim(source)) between 1 and 120),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint rafa_audit_events_details_object check (jsonb_typeof(details) = 'object'),
  constraint rafa_audit_events_details_size check (pg_column_size(details) <= 6000)
);
create index if not exists rafa_audit_events_contact_created_idx on public.rafa_audit_events (contact_id, created_at desc);
create index if not exists rafa_audit_events_event_created_idx on public.rafa_audit_events (event, created_at desc);

do $$
declare table_name text;
begin
  foreach table_name in array array['rafa_lead_qualifications','rafa_contact_intents','rafa_contact_consents','rafa_follow_up_states','rafa_handovers','rafa_priority_alerts','rafa_complaints','rafa_existing_client_verifications','rafa_audit_events'] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on table public.%I from public, anon, authenticated', table_name);
    execute format('grant select, insert, update, delete on table public.%I to service_role', table_name);
  end loop;
end $$;

drop trigger if exists set_rafa_follow_up_states_updated_at on public.rafa_follow_up_states;
create trigger set_rafa_follow_up_states_updated_at before update on public.rafa_follow_up_states for each row execute function public.set_rafa_updated_at();
drop trigger if exists set_rafa_existing_client_verifications_updated_at on public.rafa_existing_client_verifications;
create trigger set_rafa_existing_client_verifications_updated_at before update on public.rafa_existing_client_verifications for each row execute function public.set_rafa_updated_at();
