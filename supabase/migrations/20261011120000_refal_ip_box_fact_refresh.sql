begin;
set local lock_timeout = '5s';

-- MIG-17 / P3.9 source correction. Preserve the register's audit trail while
-- replacing the stale 2.5%-3% effective-rate claim with the current Tax
-- Department's 80% nexus-based exemption and bounded arithmetic wording.
do $$
declare
  prior_row jsonb;
  revised_claim constant text := 'Cyprus''s IP Box regime exempts 80% of net qualifying profit calculated using the nexus fraction. Taxing the remaining 20% at the applicable headline corporate rate produces 3% arithmetic before case-specific rules; this is not a promised effective rate or a personalized tax outcome.';
  revised_numbers constant jsonb := '[{"value":"80%","kind":"exemption"},{"value":"20%","kind":"taxable share arithmetic"},{"value":"3%","kind":"illustrative arithmetic, not promised effective rate"}]'::jsonb;
  revised_notes constant text := 'The 80% exemption applies to net qualifying profit using the statutory nexus fraction; it is not a flat rate. 3% is arithmetic from the 2026 base rate and is not a personalized effective rate. Current tax adviser review is required for a specific case. Verified against the Cyprus Tax Department source on 2026-10-11.';
begin
  select to_jsonb(r) into prior_row
  from public.refal_fact_register r
  where r.fact_id = 'MB-F20'
  for update;
  if prior_row is null then
    raise exception 'MIG-17 requires existing MB-F20; seed the fact register first';
  end if;

  if prior_row->>'claim_text' = revised_claim
     and prior_row->>'source_url_or_document' = 'https://www.gov.cy/mof/en/documents/tax-incentives/' then
    return;
  end if;

  update public.refal_fact_register
  set claim_text = revised_claim,
      source_type = 'cy-authority',
      source_url_or_document = 'https://www.gov.cy/mof/en/documents/tax-incentives/',
      source_ref = 'Cyprus Tax Department, Tax Incentives, https://www.gov.cy/mof/en/documents/tax-incentives/ (checked 2026-10-11); 2026 base rate: MB-F19',
      numbers = revised_numbers,
      verified_at = '2026-10-11',
      expiry_or_review_at = '2027-01-09',
      review_cadence_days = 90,
      status = 'approved',
      reviewer = 'BOSS',
      notes = revised_notes,
      updated_at = now()
  where fact_id = 'MB-F20';

  insert into public.refal_fact_register_audit (fact_id, action, actor, previous, next, reason)
  values (
    'MB-F20', 'edit', 'BOSS', prior_row,
    jsonb_build_object('claim_text', revised_claim,
      'source_url_or_document', 'https://www.gov.cy/mof/en/documents/tax-incentives/',
      'numbers', revised_numbers, 'verified_at', '2026-10-11',
      'expiry_or_review_at', '2027-01-09', 'status', 'approved'),
    'Replace stale IP Box rate range using current Cyprus Tax Department source; qualify 3% as arithmetic, not a promised effective rate.'
  );
end $$;

commit;

-- ROLLBACK:
-- Do not restore the stale 2.5%-3% claim. If this change must be withdrawn,
-- first block MB-F20 in the register and retain this audit event. A corrected
-- replacement claim must be separately sourced and reviewed.
