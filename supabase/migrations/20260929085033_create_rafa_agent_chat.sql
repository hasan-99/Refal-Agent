create table if not exists public.rafa_agent_sessions (
  id uuid primary key default gen_random_uuid(),
  title text not null default 'New chat',
  model text not null default 'openrouter/free',
  memory_enabled boolean not null default true,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create table if not exists public.rafa_agent_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.rafa_agent_sessions(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone not null default now()
);

create table if not exists public.rafa_agent_memories (
  id uuid primary key default gen_random_uuid(),
  label text not null default 'Memory',
  content text not null default '',
  source_session_id uuid references public.rafa_agent_sessions(id) on delete set null,
  pinned boolean not null default false,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create index if not exists rafa_agent_sessions_updated_at_idx on public.rafa_agent_sessions (updated_at desc);
create index if not exists rafa_agent_messages_session_created_idx on public.rafa_agent_messages (session_id, created_at);
create index if not exists rafa_agent_memories_pinned_created_idx on public.rafa_agent_memories (pinned desc, created_at desc);
create index if not exists rafa_agent_memories_source_session_idx on public.rafa_agent_memories (source_session_id);

alter table public.rafa_agent_sessions enable row level security;
alter table public.rafa_agent_messages enable row level security;
alter table public.rafa_agent_memories enable row level security;

revoke all on table public.rafa_agent_sessions from anon, authenticated;
revoke all on table public.rafa_agent_messages from anon, authenticated;
revoke all on table public.rafa_agent_memories from anon, authenticated;

grant all on table public.rafa_agent_sessions to service_role;
grant all on table public.rafa_agent_messages to service_role;
grant all on table public.rafa_agent_memories to service_role;
