-- Claim one explicitly selected notification without scanning or mutating the
-- shared due queue. P6.5 is queued-only: SMTP can accept a message even if the
-- worker loses its response, so reclaiming a stale processing lease could
-- duplicate delivery. Normal batch claims retain their existing lease policy.
create or replace function public.rafa_claim_notification_by_id(
  p_notification_id uuid,
  p_test_run_id uuid,
  p_expected_recipient text
)
returns setof public.rafa_notification_jobs
language sql
security definer
set search_path = ''
as $$
  update public.rafa_notification_jobs jobs
  set status = 'processing',
      attempts = jobs.attempts + 1,
      locked_at = now(),
      updated_at = now()
  where jobs.id = p_notification_id
    and jobs.kind = 'handover_review'
    and jobs.payload ->> 'p65TestRunId' = p_test_run_id::text
    and jobs.recipient = p_expected_recipient
    and (
      jobs.status = 'queued'
      and jobs.next_attempt_at <= now()
    )
  returning jobs.*;
$$;

revoke all on function public.rafa_claim_notification_by_id(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.rafa_claim_notification_by_id(uuid, uuid, text) to service_role;

-- Keep P6.5-tagged rows out of the shared production batch. All existing
-- eligibility, ordering, bounded limit, and lease behavior remains unchanged.
-- Rollback: restore the original function body from
-- 20261001170000_rafa_notification_outbox.sql (remove the tagged-row predicate).
create or replace function public.rafa_claim_due_notifications(p_limit integer default 25)
returns setof public.rafa_notification_jobs
language sql
security definer
set search_path = ''
as $$
  with due as (
    select id
    from public.rafa_notification_jobs
    where ((status in ('queued', 'failed') and next_attempt_at <= now())
       or (status = 'processing' and locked_at < now() - interval '2 minutes'))
      and not (kind = 'handover_review' and payload ? 'p65TestRunId')
    order by next_attempt_at, created_at
    for update skip locked
    limit least(greatest(coalesce(p_limit, 25), 1), 100)
  )
  update public.rafa_notification_jobs jobs
  set status = 'processing', attempts = jobs.attempts + 1, locked_at = now(), updated_at = now()
  from due
  where jobs.id = due.id
  returning jobs.*;
$$;

revoke all on function public.rafa_claim_due_notifications(integer) from public, anon, authenticated;
grant execute on function public.rafa_claim_due_notifications(integer) to service_role;
