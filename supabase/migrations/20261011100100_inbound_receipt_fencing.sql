-- Keep inbound duplicate claims durable while fencing stale workers after
-- lease expiry. Edge handlers must use these RPCs; do not restore REST
-- read-then-write receipt claims/completions.
alter table public.rafa_inbound_message_receipts
  add column if not exists lease_token uuid,
  add column if not exists lease_expires_at timestamptz;

-- Preserve the existing ten-minute stale-processing recovery window while
-- assigning a fence to outstanding rows during the one-time transition.
update public.rafa_inbound_message_receipts
set lease_token = coalesce(lease_token, gen_random_uuid()),
    lease_expires_at = coalesce(lease_expires_at, last_attempt_at + interval '10 minutes')
where status = 'processing';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.rafa_inbound_message_receipts'::regclass
      and conname = 'rafa_inbound_receipts_lease_state_check'
  ) then
    alter table public.rafa_inbound_message_receipts
      add constraint rafa_inbound_receipts_lease_state_check
      check (
        (status = 'processing' and lease_token is not null and lease_expires_at is not null)
        or (status = 'processed' and lease_token is null and lease_expires_at is null)
      );
  end if;
end;
$$;

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

  insert into public.rafa_inbound_message_receipts as current_receipt
    (whatsapp_jid, message_id, status, first_seen_at, last_attempt_at, lease_token, lease_expires_at)
  values
    (p_whatsapp_jid, btrim(p_message_id), 'processing', clock_timestamp(), clock_timestamp(), p_lease_token, clock_timestamp() + interval '10 minutes')
  on conflict (whatsapp_jid, message_id) do update
    set last_attempt_at = clock_timestamp(),
        lease_token = excluded.lease_token,
        lease_expires_at = clock_timestamp() + interval '10 minutes'
    where current_receipt.status = 'processing'
      and current_receipt.lease_expires_at <= clock_timestamp()
  returning lease_token into v_lease_token;

  if v_lease_token is null then
    return jsonb_build_object('claimed', false, 'duplicate', true);
  end if;
  return jsonb_build_object('claimed', true, 'duplicate', false, 'lease_token', v_lease_token);
end;
$$;

create or replace function public.refal_complete_inbound_message(
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
  v_processed boolean := false;
begin
  if p_whatsapp_jid is null
    or p_whatsapp_jid !~ '^(?:[0-9]+|[A-Za-z0-9._-]+)@(s\.whatsapp\.net|c\.us|lid)$'
    or p_message_id is null
    or length(btrim(p_message_id)) not between 1 and 200
    or p_lease_token is null then
    raise exception 'invalid inbound receipt completion';
  end if;

  update public.rafa_inbound_message_receipts
  set status = 'processed',
      processed_at = clock_timestamp(),
      lease_token = null,
      lease_expires_at = null
  where whatsapp_jid = p_whatsapp_jid
    and message_id = btrim(p_message_id)
    and status = 'processing'
    and lease_token = p_lease_token
    and lease_expires_at > clock_timestamp()
  returning true into v_processed;

  return jsonb_build_object('processed', coalesce(v_processed, false));
end;
$$;

revoke all on function public.refal_claim_inbound_message(text, text, uuid) from public, anon, authenticated;
revoke all on function public.refal_complete_inbound_message(text, text, uuid) from public, anon, authenticated;
grant execute on function public.refal_claim_inbound_message(text, text, uuid) to service_role;
grant execute on function public.refal_complete_inbound_message(text, text, uuid) to service_role;

-- ROLLBACK:
-- revoke all on function public.refal_claim_inbound_message(text, text, uuid) from public, anon, authenticated, service_role;
-- revoke all on function public.refal_complete_inbound_message(text, text, uuid) from public, anon, authenticated, service_role;
-- drop function if exists public.refal_claim_inbound_message(text, text, uuid);
-- drop function if exists public.refal_complete_inbound_message(text, text, uuid);
-- alter table public.rafa_inbound_message_receipts drop constraint if exists rafa_inbound_receipts_lease_state_check;
-- alter table public.rafa_inbound_message_receipts drop column if exists lease_expires_at, drop column if exists lease_token;
