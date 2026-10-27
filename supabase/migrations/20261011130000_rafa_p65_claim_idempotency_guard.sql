-- Tighten the isolated P6.5 claim so the run marker and controlled recipient
-- must also be bound to the exact test idempotency key. This follow-up avoids
-- rewriting the already-applied claim-by-ID migration.
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
    and jobs.idempotency_key = 'p65-handover:' || p_test_run_id::text
    and jobs.recipient = p_expected_recipient
    and jobs.status = 'queued'
    and jobs.next_attempt_at <= now()
  returning jobs.*;
$$;

-- Rollback: restore the function body from
-- 20261010170000_rafa_notification_claim_by_id.sql.
