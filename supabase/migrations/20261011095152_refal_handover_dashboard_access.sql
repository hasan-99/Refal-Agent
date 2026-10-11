-- Allow the secret-authenticated dashboard service to manage handover delivery metadata.
-- The delivery table contains operational state; customer conversation content remains in rafa_handovers.
grant select, insert, update on table public.refal_handover_delivery to anon;

drop policy if exists rafa_dashboard_handover_delivery_read on public.refal_handover_delivery;
drop policy if exists rafa_dashboard_handover_delivery_insert on public.refal_handover_delivery;
drop policy if exists rafa_dashboard_handover_delivery_update on public.refal_handover_delivery;

create policy rafa_dashboard_handover_delivery_read
  on public.refal_handover_delivery for select to anon
  using (public.rafa_dashboard_secret_matches());

create policy rafa_dashboard_handover_delivery_insert
  on public.refal_handover_delivery for insert to anon
  with check (public.rafa_dashboard_secret_matches());

create policy rafa_dashboard_handover_delivery_update
  on public.refal_handover_delivery for update to anon
  using (public.rafa_dashboard_secret_matches())
  with check (public.rafa_dashboard_secret_matches());
