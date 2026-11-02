create table if not exists public.rafa_attachments (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default 'refalco' check (tenant_id = 'refalco'),
  contact_id uuid not null references public.rafa_contacts(id) on delete cascade,
  provider_message_id text not null,
  conversation_turn_id uuid references public.rafa_conversation_turns(id) on delete set null,
  storage_path text not null unique,
  file_name text not null,
  content_type text not null,
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 10485760),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending' check (status in ('pending', 'uploaded', 'linked')),
  created_at timestamptz not null default now(),
  unique (contact_id, provider_message_id)
);

create index if not exists rafa_attachments_contact_created_idx
  on public.rafa_attachments (tenant_id, contact_id, created_at desc);

alter table public.rafa_attachments enable row level security;
revoke all on table public.rafa_attachments from public, anon, authenticated;
