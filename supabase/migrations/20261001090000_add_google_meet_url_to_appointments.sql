alter table public.rafa_appointments
  add column if not exists google_meet_url text;
