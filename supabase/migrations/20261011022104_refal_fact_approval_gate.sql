-- Facts backed only by the owner manual are candidates, not approved customer-facing evidence.
-- Keep their provenance intact while making the runtime fail closed until each is
-- approved against a current source in the dashboard review workflow.

insert into public.refal_fact_register_audit (fact_id, action, actor, previous, next, reason)
select
  fact_id,
  'edit',
  'REFAL governance migration 20261011130000',
  jsonb_build_object('status', status, 'reviewer', reviewer, 'verified_at', verified_at,
                     'expiry_or_review_at', expiry_or_review_at),
  jsonb_build_object('status', 'pending', 'reviewer', reviewer, 'verified_at', verified_at,
                     'expiry_or_review_at', expiry_or_review_at),
  'Owner manual is source material, not approval for customer-facing facts.'
from public.refal_fact_register
where status = 'approved'
  and source_url_or_document = 'newplan/Master Brain & Operating Rules Manual - REFAL AI.txt'
  and not exists (
    select 1 from public.refal_fact_register_audit a
    where a.fact_id = refal_fact_register.fact_id
      and a.action = 'edit'
      and a.actor = 'REFAL governance migration 20261011130000'
  );

update public.refal_fact_register
set status = 'pending'
where status = 'approved'
  and source_url_or_document = 'newplan/Master Brain & Operating Rules Manual - REFAL AI.txt';
