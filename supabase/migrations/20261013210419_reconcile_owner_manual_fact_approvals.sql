-- The original owner-manual approval gate ran before the fact-register seed.
-- Reconcile rows inserted afterward without discarding their source or review history.
begin;

insert into public.refal_fact_register_audit
  (fact_id, action, actor, previous, next, reason)
select
  f.fact_id,
  'edit',
  'REFAL governance migration 20261013210332',
  jsonb_build_object(
    'status', f.status,
    'reviewer', f.reviewer,
    'verified_at', f.verified_at,
    'expiry_or_review_at', f.expiry_or_review_at
  ),
  jsonb_build_object(
    'status', 'pending',
    'reviewer', f.reviewer,
    'verified_at', f.verified_at,
    'expiry_or_review_at', f.expiry_or_review_at
  ),
  'The owner manual is reference material, not approval evidence for customer-facing facts.'
from public.refal_fact_register f
where f.status = 'approved'
  and f.source_url_or_document = 'newplan/Master Brain & Operating Rules Manual - REFAL AI.txt'
  and not exists (
    select 1
    from public.refal_fact_register_audit a
    where a.fact_id = f.fact_id
      and a.action = 'edit'
      and a.actor = 'REFAL governance migration 20261013210332'
  );

update public.refal_fact_register
set status = 'pending', updated_at = now()
where status = 'approved'
  and source_url_or_document = 'newplan/Master Brain & Operating Rules Manual - REFAL AI.txt';

commit;
