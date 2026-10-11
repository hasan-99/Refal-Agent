-- MIG-07 / P8.1 — bounded CRM field groups on the existing one-row-per-contact table.
-- The earlier M4 table remains the storage and authorization boundary. Existing
-- profile/provenance JSON is retained during the P8.2 transition; these grouped
-- objects are the explicit MB 5.1 schema contract for progressive CRM capture.

alter table public.refal_lead_profile
  add column if not exists identity_fields jsonb not null default '{}'::jsonb,
  add column if not exists opportunity_fields jsonb not null default '{}'::jsonb,
  add column if not exists property_residency_fields jsonb not null default '{}'::jsonb,
  add column if not exists qualification_fields jsonb not null default '{}'::jsonb,
  add column if not exists crm_correction_needed jsonb not null default '{}'::jsonb;

alter table public.refal_lead_profile
  drop constraint if exists refal_lead_profile_identity_fields_valid,
  drop constraint if exists refal_lead_profile_opportunity_fields_valid,
  drop constraint if exists refal_lead_profile_property_residency_fields_valid,
  drop constraint if exists refal_lead_profile_qualification_fields_valid,
  drop constraint if exists refal_lead_profile_crm_correction_valid;

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
  ),
  add constraint refal_lead_profile_crm_correction_valid check (
    jsonb_typeof(crm_correction_needed) = 'object'
    and pg_column_size(crm_correction_needed) <= 1000
    and (crm_correction_needed = '{}'::jsonb or crm_correction_needed ?& array['field','source_turn_id','recorded_at']::text[])
    and (crm_correction_needed = '{}'::jsonb or (crm_correction_needed - array['field','source_turn_id','recorded_at']::text[] = '{}'::jsonb and crm_correction_needed->>'field' in (
      'name','phone','email','preferredLanguage','nationality','countryOfResidence','primaryIntent','targetService','businessActivity','businessStatus','targetMarkets','bankingNeed','residencyInterest','investmentBudget','preferredCity','propertyPurpose','familyMembers','sourceOfFundsStatus','sourceOfWealthOverview','timeline','mainMotivation','mainObjection','decisionAuthority','leadScore','leadTier','nextAction','appointmentStatus'
    )))
  );

comment on column public.refal_lead_profile.identity_fields is
  'MB-CRM1. Values are redacted by the application before persistence; never store identity credentials or raw documents.';
comment on column public.refal_lead_profile.opportunity_fields is
  'MB-CRM2. Supported opportunity fields only; values must retain customer-turn provenance in field_provenance.';
comment on column public.refal_lead_profile.property_residency_fields is
  'MB-CRM3. Sensitive details remain subject to the existing redaction rules and minimum-necessary capture.';
comment on column public.refal_lead_profile.qualification_fields is
  'MB-CRM4. Qualification state is CRM continuity data, not company-fact evidence or customer-facing scoring.';
comment on column public.refal_lead_profile.crm_correction_needed is
  'Field-only clarification marker. Conflicting values are never stored here or exposed to the customer.';

-- Reassert the existing private-table boundary at the point the CRM schema expands.
alter table public.refal_lead_profile enable row level security;
revoke all on table public.refal_lead_profile from public, anon, authenticated;
grant select, insert, update, delete on table public.refal_lead_profile to service_role;

-- Atomic field-level merge. The gateway verifies the customer text; this RPC
-- binds every persisted value to that same contact-owned source turn and
-- serializes updates so parallel turns cannot clobber other CRM fields.
create or replace function public.refal_save_lead_profile_field(
  p_contact_id uuid,
  p_field text,
  p_value text,
  p_source_turn_id uuid,
  p_captured_at timestamptz,
  p_explicit_correction boolean default false
) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  current_row public.refal_lead_profile%rowtype;
  group_name text;
  existing_value jsonb;
  next_group jsonb;
begin
  group_name := case
    when p_field in ('name','phone','email','preferredLanguage','nationality','countryOfResidence') then 'identity_fields'
    when p_field in ('primaryIntent','targetService','businessActivity','businessStatus','targetMarkets','bankingNeed') then 'opportunity_fields'
    when p_field in ('residencyInterest','investmentBudget','preferredCity','propertyPurpose','familyMembers','sourceOfFundsStatus','sourceOfWealthOverview') then 'property_residency_fields'
    when p_field in ('timeline','mainMotivation','mainObjection','decisionAuthority','leadScore','leadTier','nextAction','appointmentStatus') then 'qualification_fields'
    else null
  end;
  if p_contact_id is null or group_name is null or nullif(btrim(p_value),'') is null or length(p_value) > 500 or p_captured_at is null then
    raise exception 'Invalid CRM field update';
  end if;
  if not exists (select 1 from public.rafa_conversation_turns t where t.id=p_source_turn_id and t.contact_id=p_contact_id) then
    raise exception 'CRM source turn does not belong to contact' using errcode='23503';
  end if;
  insert into public.refal_lead_profile(contact_id) values (p_contact_id) on conflict (contact_id) do nothing;
  select * into current_row from public.refal_lead_profile where contact_id=p_contact_id for update;
  existing_value := case group_name
    when 'identity_fields' then current_row.identity_fields->p_field
    when 'opportunity_fields' then current_row.opportunity_fields->p_field
    when 'property_residency_fields' then current_row.property_residency_fields->p_field
    else current_row.qualification_fields->p_field
  end;
  if existing_value is not null and existing_value #>> '{}' <> p_value
    and not (coalesce(p_explicit_correction,false) and current_row.crm_correction_needed->>'field'=p_field) then
    update public.refal_lead_profile set
      crm_correction_needed=case when crm_correction_needed='{}'::jsonb or crm_correction_needed->>'field'=p_field
        then jsonb_build_object('field',p_field,'source_turn_id',p_source_turn_id::text,'recorded_at',p_captured_at)
        else crm_correction_needed end,
      source_turn_id=p_source_turn_id
    where contact_id=p_contact_id;
    return jsonb_build_object('status','correction_needed','field',lower(coalesce(current_row.crm_correction_needed->>'field',p_field)),
      'correction_field',lower(coalesce(current_row.crm_correction_needed->>'field',p_field)));
  end if;
  next_group := jsonb_build_object(p_field,p_value);
  update public.refal_lead_profile set
    identity_fields=case when group_name='identity_fields' then identity_fields || next_group else identity_fields end,
    opportunity_fields=case when group_name='opportunity_fields' then opportunity_fields || next_group else opportunity_fields end,
    property_residency_fields=case when group_name='property_residency_fields' then property_residency_fields || next_group else property_residency_fields end,
    qualification_fields=case when group_name='qualification_fields' then qualification_fields || next_group else qualification_fields end,
    field_provenance=field_provenance || jsonb_build_object(p_field,jsonb_build_object('source','customer_message','source_turn_id',p_source_turn_id::text,'captured_at',p_captured_at)),
    source_turn_id=p_source_turn_id,
    crm_correction_needed=case when crm_correction_needed->>'field'=p_field then '{}'::jsonb else crm_correction_needed end
  where contact_id=p_contact_id;
  return jsonb_build_object('status','saved','field',lower(p_field),
    'correction_field',case when current_row.crm_correction_needed->>'field'=p_field then null
      else nullif(lower(current_row.crm_correction_needed->>'field'),'') end);
end $$;
revoke all on function public.refal_save_lead_profile_field(uuid,text,text,uuid,timestamptz,boolean) from public,anon,authenticated;
grant execute on function public.refal_save_lead_profile_field(uuid,text,text,uuid,timestamptz,boolean) to service_role;

-- ROLLBACK:
-- drop function if exists public.refal_save_lead_profile_field(uuid,text,text,uuid,timestamptz,boolean);
-- alter table public.refal_lead_profile
--   drop constraint if exists refal_lead_profile_identity_fields_valid,
--   drop constraint if exists refal_lead_profile_opportunity_fields_valid,
--   drop constraint if exists refal_lead_profile_property_residency_fields_valid,
--   drop constraint if exists refal_lead_profile_qualification_fields_valid,
--   drop constraint if exists refal_lead_profile_crm_correction_valid;
-- alter table public.refal_lead_profile
--   drop column if exists identity_fields,
--   drop column if exists opportunity_fields,
--   drop column if exists property_residency_fields,
--   drop column if exists qualification_fields,
--   drop column if exists crm_correction_needed;
