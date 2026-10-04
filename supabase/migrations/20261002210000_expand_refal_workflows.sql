-- Expand deterministic owner-file taxonomy and add progressive opportunity intake.
alter table public.rafa_contact_intents drop constraint if exists rafa_contact_intents_intent_check;
alter table public.rafa_contact_intents add constraint rafa_contact_intents_intent_check check (intent in (
  'real_estate','development','construction','land','investment','partnership','corporate_services','customer_service','appointment','complaint','existing_client','prompt_injection','unknown',
  'company_formation','accounting','vat','cyprus_business_expansion','business_relocation','residency_enquiry','real_estate_purchase','real_estate_investment','land_owner','property_development','construction_tender','project_management','investment_opportunity','investment_partnership','strategic_partnership','business_proposal','supplier','career','media','general_information','company_info','services','contact','legal','tax','immigration','banking','permit','approval','privacy','unrelated','greeting','small_talk'
));

create table if not exists public.rafa_opportunity_intakes (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.rafa_contacts(id) on delete cascade,
  intake_type text not null check (intake_type in ('company_formation','real_estate','land_development','construction','investment','partnership','appointment')),
  data jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object'),
  provenance jsonb not null default '{}'::jsonb check (jsonb_typeof(provenance) = 'object'),
  status text not null default 'in_progress' check (status in ('in_progress','ready_for_review','handed_over','completed')),
  source_turn_id uuid references public.rafa_conversation_turns(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (contact_id, intake_type),
  constraint rafa_opportunity_intakes_data_size check (pg_column_size(data) <= 12000),
  constraint rafa_opportunity_intakes_provenance_size check (pg_column_size(provenance) <= 6000)
);
create index if not exists rafa_opportunity_intakes_queue_idx on public.rafa_opportunity_intakes (status, updated_at desc);
create index if not exists rafa_opportunity_intakes_contact_idx on public.rafa_opportunity_intakes (contact_id, updated_at desc);
alter table public.rafa_opportunity_intakes enable row level security;
revoke all on table public.rafa_opportunity_intakes from public, anon, authenticated;
grant select, insert, update, delete on table public.rafa_opportunity_intakes to service_role;
drop trigger if exists set_rafa_opportunity_intakes_updated_at on public.rafa_opportunity_intakes;
create trigger set_rafa_opportunity_intakes_updated_at before update on public.rafa_opportunity_intakes for each row execute function public.set_rafa_updated_at();
