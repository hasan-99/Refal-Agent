-- MIG-07 / P8.1 — bounded CRM field groups on the existing one-row-per-contact table.
-- The earlier M4 table remains the storage and authorization boundary. Existing
-- profile/provenance JSON is retained during the P8.2 transition; these grouped
-- objects are the explicit MB 5.1 schema contract for progressive CRM capture.

alter table public.refal_lead_profile
  add column if not exists identity_fields jsonb not null default '{}'::jsonb,
  add column if not exists opportunity_fields jsonb not null default '{}'::jsonb,
  add column if not exists property_residency_fields jsonb not null default '{}'::jsonb,
  add column if not exists qualification_fields jsonb not null default '{}'::jsonb;

alter table public.refal_lead_profile
  drop constraint if exists refal_lead_profile_identity_fields_valid,
  drop constraint if exists refal_lead_profile_opportunity_fields_valid,
  drop constraint if exists refal_lead_profile_property_residency_fields_valid,
  drop constraint if exists refal_lead_profile_qualification_fields_valid;

alter table public.refal_lead_profile
  add constraint refal_lead_profile_identity_fields_valid check (
    jsonb_typeof(identity_fields) = 'object'
    and pg_column_size(identity_fields) <= 3000
    and identity_fields - array['name','phone','email','preferredLanguage','nationality','countryOfResidence']::text[] = '{}'::jsonb
  ),
  add constraint refal_lead_profile_opportunity_fields_valid check (
    jsonb_typeof(opportunity_fields) = 'object'
    and pg_column_size(opportunity_fields) <= 3000
    and opportunity_fields - array['primaryIntent','targetService','businessActivity','businessStatus','targetMarkets','bankingNeed']::text[] = '{}'::jsonb
  ),
  add constraint refal_lead_profile_property_residency_fields_valid check (
    jsonb_typeof(property_residency_fields) = 'object'
    and pg_column_size(property_residency_fields) <= 3000
    and property_residency_fields - array['residencyInterest','investmentBudget','preferredCity','propertyPurpose','familyMembers','sourceOfFundsStatus','sourceOfWealthOverview']::text[] = '{}'::jsonb
  ),
  add constraint refal_lead_profile_qualification_fields_valid check (
    jsonb_typeof(qualification_fields) = 'object'
    and pg_column_size(qualification_fields) <= 3000
    and qualification_fields - array['timeline','mainMotivation','mainObjection','decisionAuthority','leadScore','leadTier','nextAction','appointmentStatus']::text[] = '{}'::jsonb
  );

comment on column public.refal_lead_profile.identity_fields is
  'MB-CRM1. Values are redacted by the application before persistence; never store identity credentials or raw documents.';
comment on column public.refal_lead_profile.opportunity_fields is
  'MB-CRM2. Supported opportunity fields only; values must retain customer-turn provenance in field_provenance.';
comment on column public.refal_lead_profile.property_residency_fields is
  'MB-CRM3. Sensitive details remain subject to the existing redaction rules and minimum-necessary capture.';
comment on column public.refal_lead_profile.qualification_fields is
  'MB-CRM4. Qualification state is CRM continuity data, not company-fact evidence or customer-facing scoring.';

-- Reassert the existing private-table boundary at the point the CRM schema expands.
alter table public.refal_lead_profile enable row level security;
revoke all on table public.refal_lead_profile from public, anon, authenticated;
grant select, insert, update, delete on table public.refal_lead_profile to service_role;

-- ROLLBACK:
-- alter table public.refal_lead_profile
--   drop constraint if exists refal_lead_profile_identity_fields_valid,
--   drop constraint if exists refal_lead_profile_opportunity_fields_valid,
--   drop constraint if exists refal_lead_profile_property_residency_fields_valid,
--   drop constraint if exists refal_lead_profile_qualification_fields_valid;
-- alter table public.refal_lead_profile
--   drop column if exists identity_fields,
--   drop column if exists opportunity_fields,
--   drop column if exists property_residency_fields,
--   drop column if exists qualification_fields;
