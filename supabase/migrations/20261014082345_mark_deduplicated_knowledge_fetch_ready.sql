create or replace function public.rafa_store_knowledge_revision(
  p_source_id uuid,
  p_title text,
  p_content text,
  p_content_sha256 text,
  p_language_code text,
  p_chunks jsonb,
  p_metadata jsonb default '{}'::jsonb,
  -- The default is the whole point of CR-014: a save now lands in the queue
  -- unless the caller explicitly asks for something else. Passing 'approved'
  -- stays possible, because the M3 corpus ingestion is a reviewed, generated
  -- artifact and re-approving 87 documents by hand after every regeneration
  -- would be ceremony, not governance. What changes is that approving is now a
  -- DECISION the caller states, not something the function does behind its back.
  p_review_status text default 'pending',
  p_approved_by text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_revision integer;
  v_document_id uuid;
  v_existing_id uuid;
  v_existing_revision integer;
  v_existing_status text;
  v_unchanged boolean := false;
  v_metadata jsonb := case when jsonb_typeof(p_metadata) = 'object' then p_metadata else '{}'::jsonb end;
  v_status text := coalesce(nullif(trim(p_review_status), ''), 'pending');
  v_approver text := coalesce(nullif(trim(p_approved_by), ''), 'dashboard-operator');
begin
  if length(trim(coalesce(p_title, ''))) = 0
     or length(trim(coalesce(p_content, ''))) = 0
     or length(p_content) > 1000000
     or p_content_sha256 !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(p_chunks) <> 'array'
     or jsonb_array_length(p_chunks) < 1
     or jsonb_array_length(p_chunks) > 500 then
    raise exception 'Invalid knowledge revision payload';
  end if;
  if v_status not in ('pending', 'approved') then
    raise exception 'A save may only land as pending or approved, not %', v_status;
  end if;

  perform 1 from public.rafa_knowledge_sources where id = p_source_id for update;
  if not found then raise exception 'Knowledge source not found'; end if;

  -- Identical content already stored for this source is a no-op, whatever its
  -- review state. This is what keeps re-running the ingestion cheap, and it is
  -- the one place the old `unchanged` contract is preserved.
  select id, revision, review_status
    into v_existing_id, v_existing_revision, v_existing_status
  from public.rafa_knowledge_documents
  where source_id = p_source_id
    and content_sha256 = p_content_sha256
  order by (review_status = 'approved') desc, revision desc
  limit 1
  for update;

  if found then
    -- Promote in place if the caller is now approving something that was queued.
    -- The lifecycle trigger supersedes the previous approved row, so CR-010 holds.
    if v_status = 'approved' then
      update public.rafa_knowledge_documents
      set review_status = 'approved',
          approved_at = now(),
          approved_by = v_approver
      where id = v_existing_id and review_status <> 'approved';
    end if;
    v_unchanged := true;
    -- Fetch success must clear the transient fetching state even when the content is unchanged.
    -- Preserve enabled/approved flags so an archived source stays archived.
    update public.rafa_knowledge_sources
    set last_content_hash = p_content_sha256,
        last_success_at = now(),
        last_fetched_at = now(),
        last_status = 'ready',
        last_error = '',
        updated_at = now()
    where id = p_source_id;
    if v_status = 'approved' then v_existing_status := 'approved'; end if;
    return jsonb_build_object(
      'document_id', v_existing_id, 'revision', v_existing_revision,
      'deduplicated', true, 'unchanged', true, 'review_status', v_existing_status);
  end if;

  -- NOT deleting the siblings is the CR-014 fix. A superseded or rejected
  -- revision is now evidence of what was reviewed and when, which is exactly
  -- what Rule 2 needs and what the old delete destroyed. Revisions therefore
  -- increment again instead of being pinned to 1.
  select coalesce(max(revision), 0) + 1 into v_revision
  from public.rafa_knowledge_documents where source_id = p_source_id;

  insert into public.rafa_knowledge_documents (
    source_id, revision, title, canonical_content, content_sha256, language_code,
    review_status, approved_at, approved_by, metadata
  ) values (
    p_source_id, v_revision, left(trim(p_title), 500), p_content,
    p_content_sha256, coalesce(nullif(p_language_code, ''), 'en'),
    v_status,
    case when v_status = 'approved' then now() else null end,
    case when v_status = 'approved' then v_approver else null end,
    v_metadata
  ) returning id into v_document_id;

  insert into public.rafa_knowledge_chunks (document_id, chunk_index, heading, content, metadata)
  select v_document_id, c.chunk_index, coalesce(c.heading, ''), c.content, coalesce(c.metadata, '{}'::jsonb)
  from jsonb_to_recordset(p_chunks) as c(chunk_index integer, heading text, content text, metadata jsonb);

  -- The source row still tracks the latest fetch. `approved` on the SOURCE means
  -- the operator trusts the origin; it is not a statement about this revision,
  -- which is what review_status is for.
  update public.rafa_knowledge_sources
  set display_name = left(trim(p_title), 160),
      last_content_hash = p_content_sha256,
      last_success_at = now(),
      last_fetched_at = now(),
      last_status = 'ready',
      last_error = '',
      enabled = true,
      approved = true,
      updated_at = now()
  where id = p_source_id;

  return jsonb_build_object(
    'document_id', v_document_id, 'revision', v_revision,
    'deduplicated', false, 'unchanged', false, 'review_status', v_status);
end;
$$;


revoke all on function public.rafa_store_knowledge_revision(uuid, text, text, text, text, jsonb, jsonb, text, text) from public, authenticated;
grant execute on function public.rafa_store_knowledge_revision(uuid, text, text, text, text, jsonb, jsonb, text, text) to anon;
