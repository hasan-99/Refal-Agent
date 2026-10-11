-- MIG-14 / P12.4: serialize admin profile corrections and their audit record
-- in one transaction so multiple dashboard instances cannot lose updates.
create or replace function public.refal_correct_contact_profile(
  p_whatsapp_jid text,
  p_expected jsonb,
  p_changes jsonb,
  p_actor text
) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  contact public.rafa_contacts%rowtype;
  allowed_fields text[] := array['nameOverride','phoneOverride','needOverride','conversationSummary']::text[];
  changed_fields text[];
  field_name text;
  next_profile jsonb;
begin
  if p_whatsapp_jid is null or length(p_whatsapp_jid) > 200
    or jsonb_typeof(p_expected) <> 'object' or jsonb_typeof(p_changes) <> 'object'
    or p_expected = '{}'::jsonb or p_changes = '{}'::jsonb
    or nullif(btrim(p_actor),'') is null or length(p_actor) > 200 then
    raise exception 'Invalid contact correction request';
  end if;
  if (p_expected - allowed_fields) <> '{}'::jsonb or (p_changes - allowed_fields) <> '{}'::jsonb then
    raise exception 'Unsupported contact correction field';
  end if;
  select * into contact from public.rafa_contacts where whatsapp_jid=p_whatsapp_jid for update;
  if not found then return jsonb_build_object('status','not_found'); end if;
  foreach field_name in array allowed_fields loop
    if p_expected ? field_name and coalesce(contact.profile->>field_name,'') <> coalesce(p_expected->>field_name,'') then
      return jsonb_build_object('status','stale');
    end if;
  end loop;
  next_profile := coalesce(contact.profile,'{}'::jsonb);
  select array_agg(key order by key) into changed_fields from jsonb_object_keys(p_changes) as keys(key);
  foreach field_name in array changed_fields loop
    if length(coalesce(p_changes->>field_name,'')) = 0 then
      next_profile := next_profile - field_name;
    else
      next_profile := jsonb_set(next_profile,array[field_name],p_changes->field_name,true);
    end if;
  end loop;
  if p_changes ? 'conversationSummary' then
    next_profile := jsonb_set(next_profile,'{conversationSummaryUpdatedAt}',to_jsonb(now()::text),true);
    changed_fields := array_append(changed_fields,'conversationSummaryUpdatedAt');
  end if;
  update public.rafa_contacts set profile=next_profile where id=contact.id;
  insert into public.rafa_audit_events(contact_id,event,actor_type,source,details)
  values(contact.id,'contact_memory_admin_updated','admin','refal-dashboard',jsonb_build_object(
    'actor',left(p_actor,200),'action','update_contact_memory','fields',to_jsonb(changed_fields)
  ));
  return jsonb_build_object('status','saved','profile',next_profile);
end $$;

revoke all on function public.refal_correct_contact_profile(text,jsonb,jsonb,text) from public,anon,authenticated;
grant execute on function public.refal_correct_contact_profile(text,jsonb,jsonb,text) to service_role;

-- ROLLBACK:
-- drop function if exists public.refal_correct_contact_profile(text,jsonb,jsonb,text);
