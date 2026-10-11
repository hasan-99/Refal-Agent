-- M9: keep specialist contact and automated reminders as separate consent scopes.
-- The existing follow_up scope remains the specialist_contact scope for compatibility.

begin;

alter table public.rafa_contact_consents
  drop constraint if exists rafa_contact_consents_consent_type_check;
alter table public.rafa_contact_consents
  drop constraint if exists rafa_contact_consents_purpose_scope_check,
  drop constraint if exists rafa_contact_consents_language_check,
  drop constraint if exists rafa_contact_consents_channel_check,
  drop constraint if exists rafa_contact_consents_automated_grant_provenance_check;

alter table public.rafa_contact_consents
  add constraint rafa_contact_consents_consent_type_check
  check (consent_type in ('follow_up', 'automated_reminder'));

alter table public.rafa_contact_consents
  add column if not exists purpose text,
  add column if not exists language text not null default 'unknown',
  add column if not exists channel text not null default 'whatsapp',
  add column if not exists offer_source_turn_id uuid references public.rafa_conversation_turns(id) on delete set null;

update public.rafa_contact_consents
set purpose = case when consent_type = 'follow_up' then 'specialist_contact' else 'automated_reminder' end
where purpose is null;

alter table public.rafa_contact_consents
  alter column purpose set not null,
  add constraint rafa_contact_consents_purpose_scope_check
    check ((consent_type = 'follow_up' and purpose = 'specialist_contact') or
           (consent_type = 'automated_reminder' and purpose = 'automated_reminder')),
  add constraint rafa_contact_consents_language_check check (language in ('unknown', 'ar', 'en', 'el')),
  add constraint rafa_contact_consents_channel_check check (channel in ('whatsapp')),
  add constraint rafa_contact_consents_automated_grant_provenance_check
    check (consent_type <> 'automated_reminder' or state <> 'granted' or
      (source_turn_id is not null and offer_source_turn_id is not null and language <> 'unknown'));

create index if not exists rafa_contact_consents_scope_state_idx
  on public.rafa_contact_consents (consent_type, state, observed_at desc);

create or replace function public.refal_guard_automated_reminder_regrant()
returns trigger
language plpgsql
set search_path = ''
as $$
declare offer_at timestamptz;
begin
  if tg_op = 'UPDATE'
     and new.consent_type = 'automated_reminder'
     and old.state in ('denied', 'revoked')
     and new.state = 'granted' then
    select turn.at into offer_at
    from public.rafa_conversation_turns as turn
    where turn.id = new.offer_source_turn_id
      and turn.contact_id = new.contact_id;
    if offer_at is null or offer_at <= old.observed_at then
      raise exception 'A fresh automated reminder offer is required after opt-out.'
        using errcode = '23514', constraint = 'rafa_contact_consents_regrant_after_opt_out_check';
    end if;
  end if;
  new.observed_at := now();
  return new;
end;
$$;

revoke all on function public.refal_guard_automated_reminder_regrant() from public, anon, authenticated;
grant execute on function public.refal_guard_automated_reminder_regrant() to service_role;

drop trigger if exists rafa_contact_consents_regrant_guard on public.rafa_contact_consents;
create trigger rafa_contact_consents_regrant_guard
  before update on public.rafa_contact_consents
  for each row execute function public.refal_guard_automated_reminder_regrant();

commit;
