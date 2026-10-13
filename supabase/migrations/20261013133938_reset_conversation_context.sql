-- Delete one WhatsApp conversation and the personal memory derived from it.
-- Appointments, handovers, complaints, audit history and contact blocking stay
-- available for the operational and legal workflows that own them.
begin;
set local lock_timeout = '5s';

create or replace function public.refal_reset_conversation_context(p_whatsapp_jid text)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_contact public.rafa_contacts%rowtype;
  v_deleted_turns integer := 0;
  v_safe_profile jsonb := '{}'::jsonb;
begin
  if p_whatsapp_jid is null
    or p_whatsapp_jid !~ '^(?:[0-9]+|[A-Za-z0-9._-]+)@(s\.whatsapp\.net|c\.us|lid)$' then
    raise exception 'Invalid WhatsApp conversation ID.' using errcode = '22023';
  end if;

  -- Claims take the same lock before they create a receipt. A claim which
  -- starts first will be seen below; a claim which starts later waits until
  -- this reset commits, then begins against the fresh contact state.
  perform pg_catalog.pg_advisory_xact_lock(20891213, pg_catalog.hashtext(p_whatsapp_jid));
  select * into v_contact
    from public.rafa_contacts
    where whatsapp_jid = p_whatsapp_jid
    for update;

  -- Refuse to erase data while any claimed inbound reply may still be using
  -- it. Even an expired receipt can belong to a slow live worker.
  if exists (
    select 1 from public.rafa_inbound_message_receipts
    where whatsapp_jid = p_whatsapp_jid and status = 'processing'
  ) then
    raise exception 'Conversation has a message in progress. Retry after it completes.'
      using errcode = '55006';
  end if;

  if v_contact.id is not null then
    -- Keep only explicit safety gates used by controlled tests and contact
    -- suppression. A prior no-contact preference also remains protective.
    if v_contact.profile->>'followUpBlocked' = 'true' then
      v_safe_profile := v_safe_profile || '{"followUpBlocked":true}'::jsonb;
    end if;
    if v_contact.profile->>'qaControlledDiagnostics' = 'true' then
      v_safe_profile := v_safe_profile || '{"qaControlledDiagnostics":true}'::jsonb;
      v_safe_profile := v_safe_profile || (
        select coalesce(pg_catalog.jsonb_object_agg(key, value), '{}'::jsonb)
        from pg_catalog.jsonb_each(coalesce(v_contact.profile, '{}'::jsonb))
        where key in ('qaSessionStartedAt', 'qaInitialVerificationStartedAt')
      );
    end if;
    if v_contact.profile->'conversationPreferences'->>'noProactiveBookingOrContact' = 'true' then
      v_safe_profile := v_safe_profile || '{"conversationPreferences":{"noProactiveBookingOrContact":true}}'::jsonb;
    end if;

    -- Prevent a previously granted consent from authorizing a future
    -- follow-up after its source conversation disappears. Denial and
    -- revocation remain protective. The next genuine grant needs a new turn.
    update public.rafa_contact_consents
       set state = 'revoked', observed_at = pg_catalog.clock_timestamp()
     where contact_id = v_contact.id and state = 'granted';
    update public.rafa_follow_up_states
       set consent_state = case when consent_state in ('denied', 'revoked') then consent_state else 'revoked' end,
           status = 'suppressed', next_due_at = null,
           updated_at = pg_catalog.clock_timestamp()
     where contact_id = v_contact.id
       and delivery_state <> 'sending';
    if exists (
      select 1 from public.rafa_follow_up_states
      where contact_id = v_contact.id and delivery_state = 'sending'
    ) then
      raise exception 'A follow-up is being sent. Retry after it completes.'
        using errcode = '55006';
    end if;

    delete from public.refal_lead_profile where contact_id = v_contact.id;
    delete from public.refal_lead_score where contact_id = v_contact.id;
    delete from public.rafa_lead_qualifications where contact_id = v_contact.id;
    delete from public.rafa_contact_intents where contact_id = v_contact.id;
    delete from public.rafa_opportunity_intakes where contact_id = v_contact.id;
    delete from public.rafa_existing_client_verifications where contact_id = v_contact.id;

    update public.rafa_contacts
       set profile = v_safe_profile, step = 'name', booking = null
     where id = v_contact.id;
  end if;

  delete from public.rafa_conversation_turns
   where user_id = p_whatsapp_jid
      or (v_contact.id is not null and contact_id = v_contact.id);
  get diagnostics v_deleted_turns = row_count;

  if v_contact.id is not null then
    insert into public.rafa_audit_events (contact_id, event, actor_type, source, details)
    values (v_contact.id, 'conversation_context_reset', 'admin', 'rafa-agent-api',
      pg_catalog.jsonb_build_object('deleted_turns', v_deleted_turns));
  end if;

  return pg_catalog.jsonb_build_object(
    'deleted', v_contact.id is not null or v_deleted_turns > 0,
    'deletedTurns', v_deleted_turns
  );
end;
$$;

-- The service-role Edge API is the only caller. The dashboard route still
-- requires an authenticated administrator before it can reach this RPC.
revoke all on function public.refal_reset_conversation_context(text) from public, anon, authenticated;
grant execute on function public.refal_reset_conversation_context(text) to service_role;

-- Serialize inbound receipt creation with a conversation reset. Preserve the
-- durable duplicate and lease-token semantics from the previous function.
create or replace function public.refal_claim_inbound_message(
  p_whatsapp_jid text,
  p_message_id text,
  p_lease_token uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_lease_token uuid;
begin
  if p_whatsapp_jid is null
    or p_whatsapp_jid !~ '^(?:[0-9]+|[A-Za-z0-9._-]+)@(s\.whatsapp\.net|c\.us|lid)$'
    or p_message_id is null
    or length(btrim(p_message_id)) not between 1 and 200
    or p_lease_token is null then
    raise exception 'invalid inbound receipt claim';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(20891213, pg_catalog.hashtext(p_whatsapp_jid));
  insert into public.rafa_inbound_message_receipts as current_receipt
    (whatsapp_jid, message_id, status, first_seen_at, last_attempt_at, lease_token, lease_expires_at)
  values
    (p_whatsapp_jid, btrim(p_message_id), 'processing', pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(), p_lease_token, pg_catalog.clock_timestamp() + interval '10 minutes')
  on conflict (whatsapp_jid, message_id) do update
    set last_attempt_at = pg_catalog.clock_timestamp(),
        lease_token = excluded.lease_token,
        lease_expires_at = pg_catalog.clock_timestamp() + interval '10 minutes'
    where current_receipt.status = 'processing'
      and current_receipt.lease_expires_at <= pg_catalog.clock_timestamp()
  returning lease_token into v_lease_token;

  if v_lease_token is null then
    return pg_catalog.jsonb_build_object('claimed', false, 'duplicate', true);
  end if;
  return pg_catalog.jsonb_build_object('claimed', true, 'duplicate', false, 'lease_token', v_lease_token);
end;
$$;

revoke all on function public.refal_claim_inbound_message(text, text, uuid) from public, anon, authenticated;
grant execute on function public.refal_claim_inbound_message(text, text, uuid) to service_role;
commit;
