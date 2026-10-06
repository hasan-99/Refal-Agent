begin;

-- Superseded documents must clear approval timestamps to satisfy
-- rafa_knowledge_documents_check1, which requires timestamps only for rows
-- whose current review_status is approved.
create or replace function public.rafa_apply_knowledge_approval_lifecycle()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_apply_approval boolean := false;
begin
  if new.review_status = 'approved' then
    if tg_op = 'INSERT' then
      v_apply_approval := true;
    elsif old.review_status is distinct from 'approved'
       or new.approved_at is distinct from old.approved_at then
      v_apply_approval := true;
    end if;
  end if;

  if v_apply_approval then
    perform 1
    from public.rafa_knowledge_sources s
    where s.id = new.source_id
    for update;

    update public.rafa_knowledge_documents d
    set review_status = 'superseded',
        approved_at = null,
        approved_by = null
    where d.source_id = new.source_id
      and d.id is distinct from new.id
      and d.review_status = 'approved';

    if new.canonical_content ~* '(?:[$€£][[:space:]]*[0-9٠-٩]|(?:EUR|USD|GBP)[[:space:]]*[0-9٠-٩]|[0-9٠-٩][0-9٠-٩.,[:space:]]*(?:EUR|USD|GBP|euros?|dollars?|pounds?|يورو|دولار|جنيه|ευρώ))' then
      if new.valid_until is null or new.valid_until <= now() then
        new.valid_until := now() + interval '30 days';
      else
        new.valid_until := least(new.valid_until, now() + interval '30 days');
      end if;
    end if;
  end if;

  return new;
end;
$$;

commit;
