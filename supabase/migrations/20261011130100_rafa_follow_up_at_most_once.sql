-- Generic consent-based follow-ups need the same no-retry boundary as
-- appointment reminders: provider I/O cannot be part of a database transaction.
begin;
set local lock_timeout = '5s';

alter table public.rafa_follow_up_states
  drop constraint if exists rafa_follow_up_states_status_check;
alter table public.rafa_follow_up_states
  add constraint rafa_follow_up_states_status_check
  check (status in ('idle', 'eligible', 'scheduled', 'sending', 'sent', 'uncertain', 'suppressed'));

alter table public.rafa_follow_up_states
  add column if not exists delivery_state text not null default 'idle',
  add column if not exists delivery_claim_id uuid,
  add column if not exists delivery_consent_turn_id uuid references public.rafa_conversation_turns(id) on delete set null,
  add column if not exists delivery_trigger_turn_id uuid references public.rafa_conversation_turns(id) on delete set null,
  add column if not exists delivery_claimed_at timestamptz,
  add column if not exists delivery_error text,
  add column if not exists provider_message_id text;

alter table public.rafa_follow_up_states
  drop constraint if exists rafa_follow_up_states_delivery_state_check,
  add constraint rafa_follow_up_states_delivery_state_check
    check (delivery_state in ('idle', 'sending', 'retryable', 'sent', 'uncertain')),
  drop constraint if exists rafa_follow_up_states_delivery_claim_check,
  add constraint rafa_follow_up_states_delivery_claim_check
    check ((delivery_state = 'idle' and delivery_claim_id is null)
      or (delivery_state <> 'idle' and delivery_claim_id is not null)),
  drop constraint if exists rafa_follow_up_states_delivery_error_size_check,
  add constraint rafa_follow_up_states_delivery_error_size_check
    check (delivery_error is null or length(delivery_error) <= 1000),
  drop constraint if exists rafa_follow_up_states_provider_message_id_size_check,
  add constraint rafa_follow_up_states_provider_message_id_size_check
    check (provider_message_id is null or length(provider_message_id) <= 500);

-- Legacy `sent` rows have no source-turn claim provenance. Quarantine them so
-- this migration cannot accidentally resend a contact on its existing grant.
update public.rafa_follow_up_states
set status = 'uncertain',
    delivery_state = 'uncertain',
    delivery_claim_id = coalesce(delivery_claim_id, gen_random_uuid()),
    delivery_error = coalesce(delivery_error, 'Pre-upgrade follow-up has no delivery provenance; outcome may be ambiguous.')
where status = 'sent' and delivery_state = 'idle';

drop index if exists public.rafa_follow_up_states_due_idx;
create index rafa_follow_up_states_due_idx
  on public.rafa_follow_up_states (next_due_at, contact_id)
  where status in ('eligible', 'scheduled');

create or replace function public.rafa_claim_follow_up_send(
  p_contact_id uuid,
  p_claim_id uuid,
  p_consent_turn_id uuid,
  p_trigger_turn_id uuid
)
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare claimed boolean := false;
begin
  if p_contact_id is null or p_claim_id is null or p_consent_turn_id is null or p_trigger_turn_id is null then
    return false;
  end if;

  with eligible as (
    select contact.id as contact_id, consent.source_turn_id as consent_turn_id,
      trigger_turn.id as trigger_turn_id
    from public.rafa_contacts as contact
    join public.rafa_contact_consents as consent on consent.contact_id = contact.id
    join public.rafa_conversation_turns as consent_turn
      on consent_turn.id = consent.source_turn_id and consent_turn.contact_id = contact.id
    join public.rafa_conversation_turns as trigger_turn
      on trigger_turn.id = p_trigger_turn_id and trigger_turn.contact_id = contact.id
    where contact.id = p_contact_id
      and consent.consent_type = 'automated_reminder'
      and consent.state = 'granted'
      and consent.purpose = 'automated_reminder'
      and consent.channel = 'whatsapp'
      and consent.source_turn_id = p_consent_turn_id
      and consent.language in ('en', 'ar', 'el')
      and trigger_turn.response <> ''
      and trigger_turn.at <= statement_timestamp() - interval '24 hours'
      and (contact.last_follow_up_sent is null or contact.last_follow_up_sent < trigger_turn.at)
      and not exists (
        select 1 from public.rafa_contact_blocks as block
        where block.whatsapp_jid = contact.whatsapp_jid and block.status = 'active'
      )
      and not exists (
        select 1 from public.rafa_conversation_turns as newer
        where newer.contact_id = contact.id
          and (newer.at, newer.id) > (trigger_turn.at, trigger_turn.id)
      )
  ), claimed_row as (
    insert into public.rafa_follow_up_states as state (
      contact_id, consent_state, status, next_due_at,
      delivery_state, delivery_claim_id, delivery_consent_turn_id,
      delivery_trigger_turn_id, delivery_claimed_at, delivery_error, provider_message_id
    )
    select eligible.contact_id, 'granted', 'sending', null,
      'sending', p_claim_id, eligible.consent_turn_id,
      eligible.trigger_turn_id, statement_timestamp(), null, null
    from eligible
    on conflict (contact_id) do update set
      consent_state = 'granted',
      status = 'sending',
      next_due_at = null,
      delivery_state = 'sending',
      delivery_claim_id = excluded.delivery_claim_id,
      delivery_consent_turn_id = excluded.delivery_consent_turn_id,
      delivery_trigger_turn_id = excluded.delivery_trigger_turn_id,
      delivery_claimed_at = statement_timestamp(),
      delivery_error = null,
      provider_message_id = null
    where (state.delivery_state in ('idle', 'retryable')
      and state.status in ('idle', 'eligible', 'scheduled', 'suppressed'))
      or (state.delivery_state = 'sent'
        and state.status = 'sent'
        and state.delivery_consent_turn_id is distinct from excluded.delivery_consent_turn_id)
    returning contact_id
  )
  select exists(select 1 from claimed_row) into claimed;

  return claimed;
end;
$$;

create or replace function public.rafa_finish_follow_up_send(
  p_contact_id uuid,
  p_claim_id uuid,
  p_outcome text,
  p_error text default null,
  p_provider_message_id text default null,
  p_finished_at timestamptz default statement_timestamp()
)
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare updated_contact uuid;
begin
  if p_contact_id is null or p_claim_id is null or p_outcome is null or p_outcome not in ('sent', 'retryable', 'uncertain') then
    return false;
  end if;
  if p_error is not null and length(p_error) > 1000 then
    p_error := left(p_error, 1000);
  end if;
  if p_provider_message_id is not null and length(p_provider_message_id) > 500 then
    p_provider_message_id := left(p_provider_message_id, 500);
  end if;

  update public.rafa_follow_up_states as state
  set delivery_state = p_outcome,
      status = case p_outcome when 'sent' then 'sent' when 'uncertain' then 'uncertain' else 'eligible' end,
      last_sent_at = case when p_outcome = 'sent' then p_finished_at else state.last_sent_at end,
      next_due_at = case when p_outcome = 'retryable' then p_finished_at else null end,
      delivery_error = case when p_outcome = 'sent' then null else coalesce(p_error, 'Delivery outcome could not be confirmed.') end,
      provider_message_id = case when p_outcome = 'sent' then nullif(p_provider_message_id, '') else state.provider_message_id end
  where state.contact_id = p_contact_id
    and state.status = 'sending'
    and state.delivery_state = 'sending'
    and state.delivery_claim_id = p_claim_id
  returning state.contact_id into updated_contact;

  if updated_contact is null then return false; end if;
  if p_outcome = 'sent' then
    update public.rafa_contacts as contact
    set last_follow_up_sent = p_finished_at
    where contact.id = p_contact_id;
  end if;
  return true;
end;
$$;

revoke all on function public.rafa_claim_follow_up_send(uuid, uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.rafa_finish_follow_up_send(uuid, uuid, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.rafa_claim_follow_up_send(uuid, uuid, uuid, uuid) to service_role;
grant execute on function public.rafa_finish_follow_up_send(uuid, uuid, text, text, text, timestamptz) to service_role;

commit;

-- Sending rows are never automatically reclaimed. If the worker disappears
-- after claim, inspect provider evidence and resolve manually before retrying.
-- ROLLBACK: stop every follow-up worker; reconcile sending/uncertain rows first,
-- then restore the prior status constraint and due index. Never reset these
-- claims automatically because the provider outcome can be ambiguous.
