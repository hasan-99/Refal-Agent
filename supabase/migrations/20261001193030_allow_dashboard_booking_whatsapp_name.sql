-- The dashboard reads WhatsApp display names only through the existing
-- dashboard-secret RLS policy; keep the grant limited to this JSON column.
grant select (whatsapp) on table public.rafa_contacts to anon;
