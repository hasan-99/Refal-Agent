-- Admin editing for fact evidence and review settings.
-- Claim wording and numbers remain owned by src/factCatalogue.js and the
-- multilingual knowledge corpus; this function only edits register metadata.

create or replace function public.refal_edit_fact_review(
  p_fact_id text,
  p_source_url_or_document text,
  p_source_ref text,
  p_notes text,
  p_review_cadence_days integer,
  p_approved_languages text[],
  p_actor text,
  p_reason text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_before public.refal_fact_register;
  v_after public.refal_fact_register;
  v_evidence_changed boolean;
begin
  if length(trim(coalesce(p_actor, ''))) = 0 then
    raise exception 'A fact edit needs a named administrator';
  end if;
  if length(trim(coalesce(p_reason, ''))) = 0 then
    raise exception 'A fact edit needs a reason';
  end if;
  if length(coalesce(p_reason, '')) > 500 then
    raise exception 'The edit reason cannot exceed 500 characters';
  end if;
  if length(trim(coalesce(p_source_url_or_document, ''))) not between 1 and 500 then
    raise exception 'Evidence source must be between 1 and 500 characters';
  end if;
  if length(coalesce(p_source_ref, '')) > 500 then
    raise exception 'Evidence citation cannot exceed 500 characters';
  end if;
  if length(coalesce(p_notes, '')) > 2000 then
    raise exception 'Fact notes cannot exceed 2000 characters';
  end if;
  if p_review_cadence_days not between 1 and 365 then
    raise exception 'Review cadence must be between 1 and 365 days';
  end if;
  if coalesce(cardinality(p_approved_languages), 0) = 0
     or not (p_approved_languages <@ array['ar','en','el']::text[]) then
    raise exception 'Choose one or more supported languages: Arabic, English, or Greek';
  end if;

  select * into v_before
  from public.refal_fact_register
  where fact_id = p_fact_id
  for update;
  if not found then
    raise exception 'Unknown fact %', p_fact_id;
  end if;
  if v_before.high_risk and p_review_cadence_days > 90 then
    raise exception '% is high risk and cannot be given a % day cadence', p_fact_id, p_review_cadence_days;
  end if;

  v_evidence_changed := v_before.source_url_or_document is distinct from trim(coalesce(p_source_url_or_document, ''))
    or v_before.source_ref is distinct from trim(coalesce(p_source_ref, ''));

  update public.refal_fact_register
  set source_url_or_document = trim(coalesce(p_source_url_or_document, '')),
      source_ref = trim(coalesce(p_source_ref, '')),
      notes = trim(coalesce(p_notes, '')),
      review_cadence_days = p_review_cadence_days,
      approved_languages = p_approved_languages,
      status = case when v_evidence_changed and status = 'approved' then 'pending' else status end
  where fact_id = p_fact_id
  returning * into v_after;

  insert into public.refal_fact_register_audit (fact_id, action, actor, previous, next, reason)
  values (
    p_fact_id,
    'edit',
    trim(p_actor),
    jsonb_build_object(
      'source_url_or_document', v_before.source_url_or_document,
      'source_ref', v_before.source_ref,
      'notes', v_before.notes,
      'review_cadence_days', v_before.review_cadence_days,
      'approved_languages', v_before.approved_languages,
      'status', v_before.status
    ),
    jsonb_build_object(
      'source_url_or_document', v_after.source_url_or_document,
      'source_ref', v_after.source_ref,
      'notes', v_after.notes,
      'review_cadence_days', v_after.review_cadence_days,
      'approved_languages', v_after.approved_languages,
      'status', v_after.status
    ),
    trim(p_reason)
  );

  return jsonb_build_object(
    'fact_id', v_after.fact_id,
    'status', v_after.status,
    'evidence_changed', v_evidence_changed,
    'updated_at', v_after.updated_at
  );
end;
$$;

revoke all on function public.refal_edit_fact_review(text,text,text,text,integer,text[],text,text)
  from public, anon, authenticated;
grant execute on function public.refal_edit_fact_review(text,text,text,text,integer,text[],text,text)
  to service_role;

-- Re-approval must cite evidence outside the owner manual and explain the
-- review decision. The dashboard derives p_reviewer from the signed-in admin.
create or replace function public.refal_reapprove_fact(
  p_fact_id text,
  p_reviewer text,
  p_cadence_days integer default null,
  p_reason text default ''
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_before public.refal_fact_register;
  v_after public.refal_fact_register;
  v_cadence integer;
begin
  if length(trim(coalesce(p_reviewer, ''))) = 0 then
    raise exception 'A re-approval needs a named reviewer';
  end if;
  if length(trim(coalesce(p_reason, ''))) = 0 then
    raise exception 'A re-approval needs the evidence checked and a reason';
  end if;

  select * into v_before from public.refal_fact_register where fact_id = p_fact_id for update;
  if not found then
    raise exception 'Unknown fact %', p_fact_id;
  end if;
  if v_before.source_type = 'mb-manual'
     or v_before.source_url_or_document ilike '%Master Brain & Operating Rules Manual%'
     or length(trim(v_before.source_ref)) = 0 then
    raise exception 'Approval requires a current evidence source and exact citation; the owner manual alone is not evidence';
  end if;

  v_cadence := coalesce(p_cadence_days, v_before.review_cadence_days);
  if v_before.high_risk and v_cadence > 90 then
    raise exception '% is high risk and cannot be given a % day cadence', p_fact_id, v_cadence;
  end if;

  update public.refal_fact_register
  set reviewer = p_reviewer,
      verified_at = current_date,
      status = 'approved',
      review_cadence_days = v_cadence,
      expiry_or_review_at = current_date + v_cadence
  where fact_id = p_fact_id
  returning * into v_after;

  insert into public.refal_fact_register_audit (fact_id, action, actor, previous, next, reason)
  values (
    p_fact_id, 'reapprove', p_reviewer,
    jsonb_build_object('status', v_before.status, 'verified_at', v_before.verified_at,
                       'expiry_or_review_at', v_before.expiry_or_review_at,
                       'review_cadence_days', v_before.review_cadence_days),
    jsonb_build_object('status', v_after.status, 'verified_at', v_after.verified_at,
                       'expiry_or_review_at', v_after.expiry_or_review_at,
                       'review_cadence_days', v_after.review_cadence_days),
    left(trim(p_reason), 500)
  );

  return jsonb_build_object(
    'fact_id', v_after.fact_id,
    'status', v_after.status,
    'verified_at', v_after.verified_at,
    'expiry_or_review_at', v_after.expiry_or_review_at
  );
end;
$$;

revoke all on function public.refal_reapprove_fact(text,text,integer,text) from public, anon, authenticated;
grant execute on function public.refal_reapprove_fact(text,text,integer,text) to service_role;
