create table if not exists public.rafa_inbound_message_receipts (
  whatsapp_jid text not null,
  message_id text not null check (length(btrim(message_id)) between 1 and 200),
  status text not null default 'processing' check (status in ('processing', 'processed')),
  first_seen_at timestamptz not null default now(),
  last_attempt_at timestamptz not null default now(),
  processed_at timestamptz,
  primary key (whatsapp_jid, message_id),
  constraint rafa_inbound_message_jid_valid check (whatsapp_jid ~ '^(?:[0-9]+|[A-Za-z0-9._-]+)@(s\.whatsapp\.net|c\.us|lid)$')
);

create index if not exists rafa_inbound_message_receipts_seen_idx
  on public.rafa_inbound_message_receipts (last_attempt_at);

alter table public.rafa_inbound_message_receipts enable row level security;
revoke all on table public.rafa_inbound_message_receipts from anon, authenticated;
grant select, insert, update, delete on table public.rafa_inbound_message_receipts to service_role;
