-- M7.2 extends the durable appointment status constraint. Existing code keeps
-- unfinished conversational drafts on contact state; these states are added
-- here so appointment rows can represent the complete workflow as it moves to
-- the durable state machine. Legacy admin-review statuses remain supported.
alter table public.rafa_appointments
  drop constraint if exists rafa_appointments_status_check;

alter table public.rafa_appointments
  add constraint rafa_appointments_status_check
  check (status in (
    'draft', 'awaiting_customer_confirmation', 'creating',
    'pending_calendar', 'pending_review', 'confirmed', 'failed', 'cancelled',
    'rejected', 'rescheduled', 'completed'
  ));

drop index if exists public.rafa_appointments_status_start_idx;
create index rafa_appointments_status_start_idx
  on public.rafa_appointments (status, starts_at)
  where status in (
    'draft', 'awaiting_customer_confirmation', 'creating',
    'pending_calendar', 'pending_review', 'confirmed', 'rescheduled'
  );

-- Durable, owner-overridable defaults for M7.1. Settings are service-role
-- only (RLS enabled and anon/authenticated revoked in MIG-1); the Edge API
-- reads/writes them through its service-role client. Never overwrite owner
-- configuration on a re-run or upgrade.
insert into public.rafa_settings (key, value)
values (
  'booking_policy',
  '{"timezone":"Europe/Nicosia","calendarId":"primary","weekdays":[1,2,3,4,5],"startTime":"10:00","endTime":"15:00","durationMinutes":60,"durationOwnerConfirmed":true,"minimumNoticeHours":24,"reminderHours":[24,1],"createMeetLink":true}'::jsonb
)
on conflict (key) do nothing;
