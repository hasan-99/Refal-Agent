-- P12.1/P12.4: append-only audit history for every knowledge review decision.
-- The dashboard still authenticates to PostgREST with anon + the existing
-- x-rafa-dashboard-secret boundary. The review and audit insert are atomic.

create table if not exists public.rafa_knowledge_review_audit (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.rafa_knowledge_documents(id) on delete restrict,
  previous_status text not null check (previous_status in ('approved','rejected','pending')),
  new_status text not null check (new_status in ('approved','rejected','pending')),
  reviewer text not null check (length(trim(reviewer)) between 1 and 200),
  reason text not null check (length(trim(reason)) between 1 and 500),
  created_at timestamptz not null default now()
);

create index if not exists rafa_knowledge_review_audit_document_idx
  on public.rafa_knowledge_review_audit (document_id, created_at desc, id desc);
create index if not exists rafa_knowledge_review_audit_reviewer_idx
  on public.rafa_knowledge_review_audit (reviewer, created_at desc, id desc);

alter table public.rafa_knowledge_review_audit enable row level security;
revoke all on table public.rafa_knowledge_review_audit from public, anon, authenticated, service_role;
grant select on table public.rafa_knowledge_review_audit to service_role;
grant select, insert on table public.rafa_knowledge_review_audit to anon;

drop policy if exists rafa_dashboard_knowledge_review_audit_read on public.rafa_knowledge_review_audit;
create policy rafa_dashboard_knowledge_review_audit_read
  on public.rafa_knowledge_review_audit for select to anon
  using (public.rafa_dashboard_secret_matches());
drop policy if exists rafa_dashboard_knowledge_review_audit_append on public.rafa_knowledge_review_audit;
create policy rafa_dashboard_knowledge_review_audit_append
  on public.rafa_knowledge_review_audit for insert to anon
  with check (public.rafa_dashboard_secret_matches());

-- The caller's named dashboard reviewer and reason are now recorded for
-- approve, reject, and return-to-pending decisions. Any audit write failure
-- aborts the surrounding status update in the same transaction.
create or replace function public.rafa_review_knowledge_document(
  p_document_id uuid,
  p_review_status text,
  p_reviewer text,
  p_reason text default ''
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_source_id uuid;
  v_before text;
  v_reviewer text := left(trim(coalesce(p_reviewer, '')), 200);
  v_reason text := left(trim(coalesce(p_reason, '')), 500);
begin
  if length(v_reviewer) = 0 then
    raise exception 'A review decision needs a named reviewer';
  end if;
  if length(v_reason) = 0 then
    raise exception 'A review decision needs a reason';
  end if;
  if p_review_status is null or p_review_status not in ('approved', 'rejected', 'pending') then
    raise exception 'Unknown review status %', p_review_status;
  end if;

  select source_id, review_status into v_source_id, v_before
  from public.rafa_knowledge_documents where id = p_document_id for update;
  if not found then raise exception 'Knowledge document not found'; end if;

  update public.rafa_knowledge_documents
  set review_status = p_review_status,
      approved_at = case when p_review_status = 'approved' then now() else null end,
      approved_by = case when p_review_status = 'approved' then v_reviewer else null end
  where id = p_document_id;

  insert into public.rafa_knowledge_review_audit
    (document_id, previous_status, new_status, reviewer, reason)
  values (p_document_id, v_before, p_review_status, v_reviewer, v_reason);

  return jsonb_build_object(
    'document_id', p_document_id, 'source_id', v_source_id,
    'previous', v_before, 'review_status', p_review_status,
    'reviewer', v_reviewer, 'reason', v_reason);
end;
$$;

revoke all on function public.rafa_review_knowledge_document(uuid, text, text, text) from public, authenticated;
grant execute on function public.rafa_review_knowledge_document(uuid, text, text, text) to anon;

-- ROLLBACK:
-- drop policy if exists rafa_dashboard_knowledge_review_audit_append on public.rafa_knowledge_review_audit;
-- drop policy if exists rafa_dashboard_knowledge_review_audit_read on public.rafa_knowledge_review_audit;
-- drop table if exists public.rafa_knowledge_review_audit;
-- Re-apply 20261010020000_refal_fact_governance.sql to restore the prior review RPC body.
