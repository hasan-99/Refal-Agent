-- M4 P4.1: private live commercial data, auditable edits and durable action receipts.
-- Prerequisites: rafa_contacts, rafa_conversation_turns, rafa_audit_events,
-- set_rafa_updated_at from existing migrations. No production execution implied.
begin;

-- Pending M4 writes need an operator-visible queue item as well as an audit
-- event. Reconciliation alerts are idempotent per contact while unresolved.
alter table public.rafa_priority_alerts
  drop constraint if exists rafa_priority_alerts_trigger_check;
alter table public.rafa_priority_alerts
  add constraint rafa_priority_alerts_trigger_check check (trigger in (
    'major_development','institutional_investment','strategic_partnership',
    'complaint','severe_complaint','existing_client','safety_or_threat',
    'material_business_opportunity','action_reconciliation'
  ));

create or replace function public.refal_upsert_dynamic_action_alert(
  p_contact_id uuid, p_source_turn_id uuid, p_details jsonb
) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare alert public.rafa_priority_alerts;
begin
  insert into public.rafa_priority_alerts(contact_id,level,trigger,status,details,source_turn_id)
  values (p_contact_id,'high','action_reconciliation','open',p_details || jsonb_build_object('pending_receipts',jsonb_build_array(p_details->>'receipt_id')),p_source_turn_id)
  on conflict (contact_id,trigger) where status in ('open','acknowledged')
  do update set details=public.rafa_priority_alerts.details || excluded.details || jsonb_build_object(
                  'pending_receipts',(
                    select coalesce(jsonb_agg(to_jsonb(receipt_id)),'[]'::jsonb) from (
                      select distinct receipt_id from (
                        select value as receipt_id from jsonb_array_elements_text(coalesce(public.rafa_priority_alerts.details->'pending_receipts','[]'::jsonb))
                        union all select value as receipt_id from jsonb_array_elements_text(excluded.details->'pending_receipts')
                      ) pending where receipt_id is not null
                    ) all_pending
                  )),
                source_turn_id=excluded.source_turn_id,
                status='open', resolved_at=null
  returning * into alert;
  return jsonb_build_object('id',alert.id,'contact_id',alert.contact_id,'trigger',alert.trigger,'status',alert.status);
end $$;
revoke all on function public.refal_upsert_dynamic_action_alert(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.refal_upsert_dynamic_action_alert(uuid,uuid,jsonb) to service_role;

create table if not exists public.refal_offers_and_pricing (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (length(btrim(code)) between 1 and 120),
  title_en text not null, title_ar text not null default '', title_el text not null default '',
  amount numeric(14,2) not null check (amount >= 0),
  currency text not null default 'EUR' check (currency ~ '^[A-Z]{3}$'),
  vat_note text not null default '', inclusions jsonb not null default '[]'::jsonb check (jsonb_typeof(inclusions) = 'array'),
  valid_from timestamptz not null, effective_from timestamptz not null, valid_until timestamptz not null,
  active boolean not null default false, review_status text not null default 'draft' check (review_status in ('draft','approved','blocked')),
  location text not null default 'CY', eligibility jsonb not null default '{}'::jsonb check (jsonb_typeof(eligibility) = 'object'),
  source_note text not null check (length(btrim(source_note)) between 1 and 1000),
  reviewed_by text, verified_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint refal_offers_dates check (valid_from = effective_from and valid_until > effective_from),
  constraint refal_offers_approval check (review_status <> 'approved' or (nullif(btrim(reviewed_by),'') is not null and verified_at is not null)),
  constraint refal_offers_expiry check (verified_at is null or valid_until <= verified_at + interval '30 days')
);

create table if not exists public.refal_annual_renewal_fees (
  id uuid primary key default gen_random_uuid(),
  item text not null check (item in ('secretary','address','accounting','audit','tax')),
  amount numeric(14,2) not null check (amount >= 0),
  currency text not null default 'EUR' check (currency ~ '^[A-Z]{3}$'),
  period text not null default 'annual' check (length(btrim(period)) between 1 and 80),
  notes_en text not null default '', notes_ar text not null default '', notes_el text not null default '',
  effective_from timestamptz not null, valid_until timestamptz not null check (valid_until > effective_from),
  active boolean not null default false, review_status text not null default 'draft' check (review_status in ('draft','approved','blocked')),
  location text not null default 'CY', eligibility jsonb not null default '{}'::jsonb check (jsonb_typeof(eligibility) = 'object'),
  vat_note text not null default '', source_note text not null check (length(btrim(source_note)) between 1 and 1000),
  reviewed_by text, verified_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint refal_renewals_approval check (review_status <> 'approved' or (nullif(btrim(reviewed_by),'') is not null and verified_at is not null))
);

create table if not exists public.refal_property_inventory (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique check (length(btrim(reference)) between 1 and 120),
  city text not null check (length(btrim(city)) between 1 and 120), type text not null check (length(btrim(type)) between 1 and 120),
  status text not null check (status in ('offplan','completed')),
  price numeric(14,2) not null check (price >= 0), currency text not null default 'EUR' check (currency ~ '^[A-Z]{3}$'),
  vat_rate_note text not null default '', bedrooms smallint check (bedrooms between 0 and 100),
  first_sale boolean, pr_eligible boolean, available boolean not null default false,
  developer text not null default '', delivery_date date,
  effective_from timestamptz not null, valid_until timestamptz not null check (valid_until > effective_from),
  active boolean not null default false, review_status text not null default 'draft' check (review_status in ('draft','approved','blocked')),
  location text not null default 'CY', eligibility jsonb not null default '{}'::jsonb check (jsonb_typeof(eligibility) = 'object'),
  vat_note text not null default '', source_note text not null check (length(btrim(source_note)) between 1 and 1000),
  reviewed_by text, verified_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint refal_properties_approval check (review_status <> 'approved' or (nullif(btrim(reviewed_by),'') is not null and verified_at is not null))
);

create table if not exists public.refal_reservation_rules (
  id uuid primary key default gen_random_uuid(),
  project_or_property_id text not null unique check (length(btrim(project_or_property_id)) between 1 and 120),
  deposit_amount numeric(14,2) check (deposit_amount >= 0), deposit_percent numeric(7,4) check (deposit_percent > 0 and deposit_percent <= 100),
  currency text not null default 'EUR' check (currency ~ '^[A-Z]{3}$'), refundable boolean,
  conditions_en text not null default '', conditions_ar text not null default '', conditions_el text not null default '',
  effective_from timestamptz not null, valid_until timestamptz not null check (valid_until > effective_from),
  active boolean not null default false, review_status text not null default 'draft' check (review_status in ('draft','approved','blocked')),
  location text not null default 'CY', eligibility jsonb not null default '{}'::jsonb check (jsonb_typeof(eligibility) = 'object'),
  vat_note text not null default '', source_note text not null check (length(btrim(source_note)) between 1 and 1000),
  reviewed_by text, verified_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint refal_reservation_deposit_kind check ((deposit_amount is null) <> (deposit_percent is null)),
  constraint refal_reservations_approval check (review_status <> 'approved' or (nullif(btrim(reviewed_by),'') is not null and verified_at is not null))
);

create table if not exists public.refal_government_fees (
  id uuid primary key default gen_random_uuid(),
  fee_type text not null unique check (length(btrim(fee_type)) between 1 and 120),
  amount numeric(14,2) not null check (amount >= 0), currency text not null default 'EUR' check (currency ~ '^[A-Z]{3}$'),
  authority text not null check (length(btrim(authority)) between 1 and 200),
  effective_from timestamptz not null, valid_until timestamptz not null check (valid_until > effective_from),
  active boolean not null default false, review_status text not null default 'draft' check (review_status in ('draft','approved','blocked')),
  location text not null default 'CY', eligibility jsonb not null default '{}'::jsonb check (jsonb_typeof(eligibility) = 'object'),
  vat_note text not null default '', source_note text not null check (length(btrim(source_note)) between 1 and 1000),
  reviewed_by text, verified_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint refal_government_approval check (review_status <> 'approved' or (nullif(btrim(reviewed_by),'') is not null and verified_at is not null))
);

-- Minimal M4 write target. P8.1 adds the full CRM field groups and extraction.
create table if not exists public.refal_lead_profile (
  contact_id uuid primary key references public.rafa_contacts(id) on delete cascade,
  profile jsonb not null default '{}'::jsonb check (jsonb_typeof(profile) = 'object' and pg_column_size(profile) <= 12000),
  field_provenance jsonb not null default '{}'::jsonb check (jsonb_typeof(field_provenance) = 'object' and pg_column_size(field_provenance) <= 12000),
  source_turn_id uuid references public.rafa_conversation_turns(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists refal_lead_profile_source_turn_idx on public.refal_lead_profile(source_turn_id);
create index if not exists refal_property_inventory_search_idx on public.refal_property_inventory(city,type,price) where active and available and review_status = 'approved';

do $$
declare t text;
begin
  foreach t in array array['refal_offers_and_pricing','refal_annual_renewal_fees','refal_property_inventory','refal_reservation_rules','refal_government_fees','refal_lead_profile'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on table public.%I from public, anon, authenticated',t);
    execute format('grant select, insert, update, delete on table public.%I to service_role',t);
    execute format('drop trigger if exists %I on public.%I','set_' || t || '_updated_at',t);
    execute format('create trigger %I before update on public.%I for each row execute function public.set_rafa_updated_at()','set_' || t || '_updated_at',t);
    if t <> 'refal_lead_profile' then
      execute format('create index if not exists %I on public.%I(valid_until,effective_from) where active and review_status = ''approved''',t || '_current_idx',t);
    end if;
  end loop;
end $$;

-- Named trusted operator + atomic audit; caller gateway performs RBAC first.
create or replace function public.refal_mutate_dynamic_data(p_kind text,p_operation text,p_id uuid,p_data jsonb,p_actor text,p_reason text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  t text; k text; columns_sql text; values_sql text; assignments_sql text;
  previous_row jsonb; next_row jsonb;
begin
  t := case p_kind when 'offers' then 'refal_offers_and_pricing' when 'renewals' then 'refal_annual_renewal_fees'
    when 'properties' then 'refal_property_inventory' when 'reservations' then 'refal_reservation_rules'
    when 'governmentFees' then 'refal_government_fees' else null end;
  if t is null or p_operation is null or p_operation not in ('create','update','delete') then raise exception 'Invalid dynamic data operation'; end if;
  if nullif(btrim(p_actor),'') is null or length(p_actor) > 200 or nullif(btrim(p_reason),'') is null or length(p_reason) > 500 then raise exception 'Named actor and bounded reason required'; end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object' or pg_column_size(p_data) > 4000 then raise exception 'Bounded object data required'; end if;
  for k in select jsonb_object_keys(p_data) loop
    if k in ('id','created_at','updated_at') or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = t and column_name = k) then
      raise exception 'Invalid dynamic data column: %',k;
    end if;
  end loop;
  if p_operation = 'create' then
    if p_id is not null or p_data = '{}'::jsonb then raise exception 'Create requires new identity and data'; end if;
    select string_agg(format('%I',key),','),string_agg(format('r.%I',key),',') into columns_sql,values_sql from jsonb_object_keys(p_data) as keys(key);
    execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I,$1) r returning to_jsonb(%I.*)',t,columns_sql,values_sql,t,t) into next_row using p_data;
  else
    if p_id is null then raise exception 'Row identity required'; end if;
    execute format('select to_jsonb(r) from public.%I r where id=$1 for update',t) into previous_row using p_id;
    if previous_row is null then raise exception 'Dynamic data row not found' using errcode='P0002'; end if;
    if p_operation = 'delete' then
      if p_data <> '{}'::jsonb then raise exception 'Delete does not accept data'; end if;
      execute format('delete from public.%I where id=$1',t) using p_id;
    else
      if p_data = '{}'::jsonb then raise exception 'Update data required'; end if;
      select string_agg(format('%I=r.%I',key,key),',') into assignments_sql from jsonb_object_keys(p_data) as keys(key);
      execute format('update public.%I as dst set %s from jsonb_populate_record(null::public.%I,$1) r where dst.id=$2 returning to_jsonb(dst.*)',t,assignments_sql,t) into next_row using p_data,p_id;
    end if;
  end if;
  insert into public.rafa_audit_events(event,actor_type,source,details)
  values ('dynamic_data_' || p_operation,'operator','refal-dynamic-admin',jsonb_build_object('actor',p_actor,'reason',p_reason,'table',t,'previous',previous_row,'next',next_row));
  return coalesce(next_row,previous_row);
end $$;
revoke all on function public.refal_mutate_dynamic_data(text,text,uuid,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.refal_mutate_dynamic_data(text,text,uuid,jsonb,text,text) to service_role;

-- Receipts reuse the existing private audit table. An uncertain effect remains pending.
create unique index if not exists refal_dynamic_action_receipt_idx
  on public.rafa_audit_events(contact_id,event,(details->>'idempotency_key')) where source = 'refal-dynamic-tools';

create or replace function public.refal_claim_dynamic_action(p_contact_id uuid,p_tool text,p_idempotency_key text,p_request_hash text,p_source_turn_id uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare receipt public.rafa_audit_events%rowtype;
begin
  if p_contact_id is null or p_tool is null or p_tool not in ('upsertLead','createHandover','holdOrBookAppointment','scheduleFollowUp','recordComplianceEvent') then raise exception 'Invalid customer or action'; end if;
  if nullif(btrim(p_idempotency_key),'') is null or length(p_idempotency_key) > 200 or p_request_hash is null or p_request_hash !~ '^[a-f0-9]{64}$' then raise exception 'Invalid idempotency identity'; end if;
  if not exists(select 1 from public.rafa_conversation_turns where id=p_source_turn_id and contact_id=p_contact_id) then raise exception 'Verified source turn required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_contact_id::text || ':' || p_tool || ':' || p_idempotency_key,0));
  select * into receipt from public.rafa_audit_events where contact_id=p_contact_id and event=p_tool and source='refal-dynamic-tools' and details->>'idempotency_key'=p_idempotency_key for update;
  if found then
    if receipt.details->>'request_hash' is distinct from p_request_hash then raise exception 'Idempotency key belongs to a different request'; end if;
    if receipt.details->>'state'='pending' then
      perform public.refal_upsert_dynamic_action_alert(p_contact_id,p_source_turn_id,jsonb_build_object('tool',p_tool,'receipt_id',receipt.id,'reason','action_pending'));
    end if;
    return jsonb_build_object('claimed',false,'receipt_id',receipt.id,'state',receipt.details->>'state','result',receipt.details->'result');
  end if;
  -- One durable per-contact, per-tool sliding window. Serialize claims before
  -- counting so parallel requests cannot exceed the bound. Duplicate retries
  -- above return their existing receipt and do not consume another slot.
  perform pg_advisory_xact_lock(hashtextextended(p_contact_id::text || ':' || p_tool,0));
  if (select count(*) from public.rafa_audit_events where contact_id=p_contact_id and event=p_tool and source='refal-dynamic-tools' and created_at > now() - interval '1 minute') >= 12 then
    raise exception using errcode='P0001', message='M4 action rate limit exceeded';
  end if;
  insert into public.rafa_audit_events(contact_id,event,actor_type,source,details)
  values (p_contact_id,p_tool,'system','refal-dynamic-tools',jsonb_build_object('idempotency_key',p_idempotency_key,'request_hash',p_request_hash,'state','pending','result',null)) returning * into receipt;
  -- The operator alert commits atomically with the pending receipt and before
  -- the Edge handler can run the action's side effect.
  perform public.refal_upsert_dynamic_action_alert(p_contact_id,p_source_turn_id,jsonb_build_object('tool',p_tool,'receipt_id',receipt.id,'reason','action_pending'));
  return jsonb_build_object('claimed',true,'receipt_id',receipt.id,'state','pending','result',null);
end $$;
revoke all on function public.refal_claim_dynamic_action(uuid,text,text,text,uuid) from public,anon,authenticated;
grant execute on function public.refal_claim_dynamic_action(uuid,text,text,text,uuid) to service_role;

create or replace function public.refal_finish_dynamic_action(p_receipt_id uuid,p_contact_id uuid,p_request_hash text,p_state text,p_result jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare receipt public.rafa_audit_events%rowtype;
begin
  if p_state is null or p_state not in ('confirmed','failed') or p_result is null or jsonb_typeof(p_result) <> 'object' or pg_column_size(p_result) > 4000 then raise exception 'Invalid action result'; end if;
  select * into receipt from public.rafa_audit_events where id=p_receipt_id and contact_id=p_contact_id and source='refal-dynamic-tools' for update;
  if not found or receipt.details->>'request_hash' is distinct from p_request_hash then raise exception 'Action receipt not found'; end if;
  if receipt.details->>'state' <> 'pending' then
    if receipt.details->>'state' is distinct from p_state or receipt.details->'result' is distinct from p_result then raise exception 'Action already completed differently'; end if;
  else
    update public.rafa_audit_events set details=details || jsonb_build_object('state',p_state,'result',p_result,'completed_at',now()) where id=receipt.id returning * into receipt;
    update public.rafa_priority_alerts a set
      details=a.details || jsonb_build_object('pending_receipts',(
        select coalesce(jsonb_agg(to_jsonb(receipt_id)),'[]'::jsonb) from (
          select value as receipt_id from jsonb_array_elements_text(coalesce(a.details->'pending_receipts','[]'::jsonb))
          where value <> receipt.id::text
        ) remaining
      )),
      status=case when (select count(*) from jsonb_array_elements_text(coalesce(a.details->'pending_receipts','[]'::jsonb)) where value <> receipt.id::text)=0 then 'resolved' else 'open' end,
      resolved_at=case when (select count(*) from jsonb_array_elements_text(coalesce(a.details->'pending_receipts','[]'::jsonb)) where value <> receipt.id::text)=0 then now() else null end
      where a.contact_id=p_contact_id and a.trigger='action_reconciliation' and a.details->'pending_receipts' ? receipt.id::text and a.status in ('open','acknowledged');
  end if;
  return jsonb_build_object('receipt_id',receipt.id,'state',receipt.details->>'state','result',receipt.details->'result');
end $$;
revoke all on function public.refal_finish_dynamic_action(uuid,uuid,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.refal_finish_dynamic_action(uuid,uuid,text,text,jsonb) to service_role;

-- Owner source approval is fixed; migration replay must never extend freshness.
insert into public.refal_offers_and_pricing(code,title_en,title_ar,title_el,amount,currency,vat_note,inclusions,valid_from,effective_from,valid_until,active,review_status,location,source_note,reviewed_by,verified_at)
values ('formation-package','Cyprus company formation package','باقة تأسيس شركة قبرصية','Πακέτο σύστασης κυπριακής εταιρείας',999,'EUR','plus VAT',
  '["Company incorporation","Company name reservation","Memorandum and articles preparation","Certificate of incorporation","Company secretary for four months","Registered address for four months","Remote file management"]'::jsonb,
  '2026-10-07T00:00:00Z','2026-10-07T00:00:00Z','2026-11-06T00:00:00Z',true,'approved','CY',
  'Owner supplied Master Brain & Operating Rules Manual - REFAL AI, section 2.1, formation package; Authority Rule approved 2026-10-07','BOSS','2026-10-07T00:00:00Z')
on conflict (code) do nothing;
commit;

-- ROLLBACK:
-- begin;
-- drop function if exists public.refal_finish_dynamic_action(uuid,uuid,text,text,jsonb);
-- drop function if exists public.refal_claim_dynamic_action(uuid,text,text,text,uuid);
-- drop function if exists public.refal_mutate_dynamic_data(text,text,uuid,jsonb,text,text);
-- drop function if exists public.refal_upsert_dynamic_action_alert(uuid,uuid,jsonb);
-- alter table public.rafa_priority_alerts drop constraint if exists rafa_priority_alerts_trigger_check;
-- delete from public.rafa_priority_alerts where trigger='action_reconciliation';
-- alter table public.rafa_priority_alerts add constraint rafa_priority_alerts_trigger_check check (trigger in ('major_development','institutional_investment','strategic_partnership','complaint','severe_complaint','existing_client','safety_or_threat','material_business_opportunity'));
-- drop index if exists public.refal_dynamic_action_receipt_idx;
-- delete from public.rafa_audit_events where source in ('refal-dynamic-tools','refal-dynamic-admin');
-- drop table if exists public.refal_lead_profile;
-- drop table if exists public.refal_government_fees;
-- drop table if exists public.refal_reservation_rules;
-- drop table if exists public.refal_property_inventory;
-- drop table if exists public.refal_annual_renewal_fees;
-- drop table if exists public.refal_offers_and_pricing;
-- commit;
