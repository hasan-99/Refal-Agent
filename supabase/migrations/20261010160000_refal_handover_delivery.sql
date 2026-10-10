-- P6.5 durable handover delivery ledger. Customer content remains in
-- rafa_handovers; this table records only delivery state and bounded errors.
create unique index if not exists rafa_handovers_id_department_idx on public.rafa_handovers (id, department);
create table if not exists public.refal_handover_delivery (
  id uuid primary key default gen_random_uuid(),
  handover_id uuid not null,
  department text not null check (department in ('customer_service','corporate_services','tax','residency','real_estate','development_construction','investment','partnerships','complaints','existing_client','appointments','general')),
  recipient_lane text not null default 'sandbox' check (recipient_lane = 'sandbox'),
  status text not null default 'queued' check (status in ('queued','sending','retry','delivered','failed','acknowledged','closed')),
  attempt_count integer not null default 0 check (attempt_count between 0 and 100),
  next_attempt_at timestamptz,
  last_attempt_at timestamptz,
  delivered_at timestamptz,
  acknowledged_at timestamptz,
  closed_at timestamptz,
  closure_reason text check (closure_reason is null or length(closure_reason) <= 200),
  last_error_code text check (last_error_code is null or length(last_error_code) <= 80),
  assigned_to text check (assigned_to is null or length(assigned_to) <= 120),
  updated_at timestamptz not null default now(),
  constraint refal_handover_delivery_handover_department_fk foreign key (handover_id, department) references public.rafa_handovers(id, department) on delete cascade,
  constraint refal_handover_delivery_dates check (
    (delivered_at is null or delivered_at >= last_attempt_at)
    and (closed_at is null or closure_reason is not null)
  ),
  unique (handover_id)
);
alter table public.rafa_handovers drop constraint if exists rafa_handovers_department_check;
alter table public.rafa_handovers add constraint rafa_handovers_department_check check (department in ('customer_service','corporate_services','tax','residency','real_estate','development_construction','investment','partnerships','complaints','existing_client','appointments','general'));
create index if not exists refal_handover_delivery_retry_idx on public.refal_handover_delivery (next_attempt_at, updated_at) where status in ('queued','retry');
create index if not exists refal_handover_delivery_status_idx on public.refal_handover_delivery (status, updated_at desc);
-- Reconcile existing open handovers created before MIG-11. Acknowledged and
-- resolved work is not re-notified; open items enter the sandbox lane only.
insert into public.refal_handover_delivery (handover_id, department, recipient_lane, status, next_attempt_at)
select id, department, 'sandbox', 'queued', now()
from public.rafa_handovers
where status = 'open'
on conflict (handover_id) do nothing;
alter table public.refal_handover_delivery enable row level security;
revoke all on table public.refal_handover_delivery from public, anon, authenticated;
grant select, insert, update on table public.refal_handover_delivery to service_role;

-- Rollback:
-- drop table if exists public.refal_handover_delivery;
-- alter table public.rafa_handovers drop constraint if exists rafa_handovers_department_check;
-- alter table public.rafa_handovers add constraint rafa_handovers_department_check check (department in ('customer_service','corporate_services','real_estate','development_construction','investment','partnerships','complaints','existing_client','appointments','general'));
-- drop index if exists public.rafa_handovers_id_department_idx;
