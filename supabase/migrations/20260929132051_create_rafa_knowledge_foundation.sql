create table if not exists public.rafa_knowledge_sources (
  id uuid primary key default gen_random_uuid(),
  canonical_url text not null unique,
  display_name text not null,
  source_kind text not null check (source_kind in (
    'first_party_website', 'first_party_social', 'official_registry', 'secondary_directory', 'manual'
  )),
  trust_tier text not null check (trust_tier in ('official', 'first_party', 'secondary', 'operator_supplied')),
  enabled boolean not null default false,
  approved boolean not null default false,
  approval_note text not null default '',
  refresh_interval_hours integer check (refresh_interval_hours is null or refresh_interval_hours between 1 and 8760),
  last_fetched_at timestamptz,
  last_success_at timestamptz,
  last_content_hash text,
  last_status text not null default 'pending' check (last_status in (
    'pending', 'ready', 'fetching', 'failed', 'blocked', 'stale', 'disabled'
  )),
  last_error text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.rafa_knowledge_documents (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.rafa_knowledge_sources(id) on delete cascade,
  revision integer not null check (revision > 0),
  title text not null,
  canonical_content text not null,
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  language_code text not null default 'en',
  review_status text not null default 'pending' check (review_status in ('pending', 'approved', 'rejected', 'superseded')),
  fetched_at timestamptz not null default now(),
  published_at timestamptz,
  valid_until timestamptz,
  approved_at timestamptz,
  approved_by text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (source_id, revision),
  unique (source_id, content_sha256),
  check (valid_until is null or valid_until > fetched_at),
  check ((review_status = 'approved') = (approved_at is not null))
);

create table if not exists public.rafa_knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.rafa_knowledge_documents(id) on delete cascade,
  chunk_index integer not null check (chunk_index >= 0),
  heading text not null default '',
  content text not null check (length(content) between 1 and 12000),
  search_vector tsvector generated always as (
    to_tsvector('simple', coalesce(heading, '') || ' ' || content)
  ) stored,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (document_id, chunk_index)
);

create index if not exists rafa_knowledge_sources_enabled_idx
  on public.rafa_knowledge_sources (last_success_at desc)
  where enabled and approved;
create index if not exists rafa_knowledge_documents_source_revision_idx
  on public.rafa_knowledge_documents (source_id, revision desc);
create index if not exists rafa_knowledge_documents_approved_idx
  on public.rafa_knowledge_documents (fetched_at desc)
  where review_status = 'approved';
create index if not exists rafa_knowledge_chunks_document_idx
  on public.rafa_knowledge_chunks (document_id, chunk_index);
create index if not exists rafa_knowledge_chunks_search_idx
  on public.rafa_knowledge_chunks using gin (search_vector);

alter table public.rafa_knowledge_sources enable row level security;
alter table public.rafa_knowledge_documents enable row level security;
alter table public.rafa_knowledge_chunks enable row level security;

revoke all on table public.rafa_knowledge_sources from public, anon, authenticated;
revoke all on table public.rafa_knowledge_documents from public, anon, authenticated;
revoke all on table public.rafa_knowledge_chunks from public, anon, authenticated;
grant all on table public.rafa_knowledge_sources to service_role;
grant all on table public.rafa_knowledge_documents to service_role;
grant all on table public.rafa_knowledge_chunks to service_role;

drop trigger if exists set_rafa_knowledge_sources_updated_at on public.rafa_knowledge_sources;
create trigger set_rafa_knowledge_sources_updated_at
before update on public.rafa_knowledge_sources
for each row execute function public.set_rafa_updated_at();

insert into public.rafa_knowledge_sources (canonical_url, display_name, source_kind, trust_tier, metadata)
values
  ('https://www.refalco.com/', 'Refalco Group home', 'first_party_website', 'first_party', '{"research_status":"reviewed","retrieved_on":"2026-09-29"}'),
  ('https://refalco.com/investment-portfolio', 'Refalco investment portfolio', 'first_party_website', 'first_party', '{"research_status":"reviewed_conflicting_sensitive_claims","retrieved_on":"2026-09-29"}'),
  ('https://refalco.com/contact', 'Refalco contact', 'first_party_website', 'first_party', '{"research_status":"contact_details_require_owner_confirmation","retrieved_on":"2026-09-29"}'),
  ('https://www.instagram.com/refalcogroup/', 'Refalco Instagram', 'first_party_social', 'first_party', '{"research_status":"not_fetched","reason":"automated_access_unavailable"}'),
  ('https://www.facebook.com/RefalcoGroup/', 'Refalco Facebook', 'first_party_social', 'first_party', '{"research_status":"not_fetched","reason":"automated_access_blocked"}'),
  ('https://refalco.com/about', 'Refalco about', 'first_party_website', 'first_party', '{"research_status":"reviewed_placeholder_metrics","retrieved_on":"2026-09-29"}'),
  ('https://refalco.com/team', 'Refalco leadership', 'first_party_website', 'first_party', '{"research_status":"reviewed_owner_approval_required","retrieved_on":"2026-09-29"}'),
  ('https://refalco.com/why-us', 'Refalco perspectives', 'first_party_website', 'first_party', '{"research_status":"reviewed_conflicting_sensitive_claims","retrieved_on":"2026-09-29"}'),
  ('https://www.northdata.com/Refalco%20ONE%20Ltd%C2%B7,%20%CE%9B%CE%B5%CF%85%CE%BA%CF%89%CF%83%CE%AF%CE%B1/MCIT%20%CE%97%CE%95%20382352', 'Northdata: Refalco ONE Ltd', 'secondary_directory', 'secondary', '{"research_status":"not_fetched","reason":"secondary_source_requires_official_verification"}'),
  ('https://www.companies.gov.cy/en/business-entities/2-company/10-understanding/company-search', 'Cyprus Registrar company search', 'official_registry', 'official', '{"research_status":"official_search_guidance_only","retrieved_on":"2026-09-29"}')
on conflict (canonical_url) do nothing;
