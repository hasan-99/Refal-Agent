grant select (phone, profile) on table public.rafa_contacts to anon;

create policy rafa_dashboard_booking_contact_read
  on public.rafa_contacts
  for select to anon
  using (public.rafa_dashboard_secret_matches());
