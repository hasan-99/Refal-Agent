create table if not exists public.rafa_contact_blocks (
  id uuid primary key default gen_random_uuid(),
  whatsapp_jid text not null,
  status text not null default 'active' check (status in ('active', 'unblocked')),
  reason text not null check (length(btrim(reason)) between 1 and 500),
  category text not null default 'harassment' check (category in ('harassment', 'spam', 'threat', 'other')),
  created_by text not null check (length(btrim(created_by)) between 1 and 200),
  created_at timestamptz not null default now(),
  reviewed_by text,
  reviewed_at timestamptz,
  unblock_reason text,
  constraint rafa_contact_blocks_jid_valid check (whatsapp_jid ~ '^(?:[0-9]+|[A-Za-z0-9._-]+)@(s\.whatsapp\.net|c\.us|lid)$')
);

create unique index if not exists rafa_contact_blocks_one_active_contact_idx
  on public.rafa_contact_blocks (whatsapp_jid) where status = 'active';
create index if not exists rafa_contact_blocks_status_created_idx
  on public.rafa_contact_blocks (status, created_at desc);

alter table public.rafa_contact_blocks enable row level security;
revoke all on table public.rafa_contact_blocks from anon, authenticated;
grant select, insert, update on table public.rafa_contact_blocks to service_role;
