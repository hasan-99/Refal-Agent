-- MIG-08 / P6.1 — immutable, reproducible qualification score history.
-- Score snapshots contain bounded scores and references, never copied message text.

create table if not exists public.refal_lead_score (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.rafa_contacts(id) on delete cascade,
  need smallint not null check (need between 0 and 5),
  value smallint not null check (value between 0 and 5),
  timing smallint not null check (timing between 0 and 5),
  authority smallint not null check (authority between 0 and 5),
  readiness smallint not null check (readiness between 0 and 5),
  fit smallint not null check (fit between 0 and 5),
  total smallint generated always as (need + value + timing + authority + readiness + fit) stored check (total between 0 and 30),
  score_floor smallint not null default 0 check (score_floor between 0 and 30),
  effective_total smallint generated always as (greatest(need + value + timing + authority + readiness + fit, score_floor)) stored check (effective_total between 0 and 30),
  tier text not null check (tier in ('informational', 'cold', 'warm', 'hot', 'strategic')),
  evidence_refs jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence_refs) = 'object'),
  scorer_version text not null check (length(btrim(scorer_version)) between 1 and 80),
  evidence_fingerprint text not null check (evidence_fingerprint ~ '^[a-f0-9]{64}$'),
  source_turn_id uuid references public.rafa_conversation_turns(id) on delete set null,
  assessed_at timestamptz not null default now(),
  constraint refal_lead_score_evidence_refs_size check (pg_column_size(evidence_refs) <= 6000),
  constraint refal_lead_score_tier_matches_total check (tier = case
    when greatest(need + value + timing + authority + readiness + fit, score_floor) <= 7 then 'informational'
    when greatest(need + value + timing + authority + readiness + fit, score_floor) <= 13 then 'cold'
    when greatest(need + value + timing + authority + readiness + fit, score_floor) <= 19 then 'warm'
    when greatest(need + value + timing + authority + readiness + fit, score_floor) <= 24 then 'hot'
    else 'strategic' end),
  constraint refal_lead_score_fingerprint_once unique (contact_id, evidence_fingerprint)
);

create index if not exists refal_lead_score_contact_history_idx
  on public.refal_lead_score (contact_id, assessed_at desc, id desc);
create index if not exists refal_lead_score_tier_history_idx
  on public.refal_lead_score (tier, assessed_at desc);

alter table public.refal_lead_score enable row level security;
revoke all on table public.refal_lead_score from public, anon, authenticated;
grant select, insert on table public.refal_lead_score to service_role;

-- ROLLBACK:
-- drop index if exists public.refal_lead_score_tier_history_idx;
-- drop index if exists public.refal_lead_score_contact_history_idx;
-- drop table if exists public.refal_lead_score;
