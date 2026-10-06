begin;

-- Keep the source row shown by the dashboard in sync with the title of the
-- active knowledge document saved beneath it.
create or replace function public.rafa_store_knowledge_revision(
  p_source_id uuid,
  p_title text,
  p_content text,
  p_content_sha256 text,
  p_language_code text,
  p_chunks jsonb,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_document_id uuid;
  v_revision integer;
  v_old_title text;
  v_old_hash text;
  v_old_status text;
  v_chunks jsonb := case when jsonb_typeof(p_chunks) = 'array' then p_chunks else '[]'::jsonb end;
  v_metadata jsonb := case when jsonb_typeof(p_metadata) = 'object' then p_metadata else '{}'::jsonb end;
  v_unchanged boolean := false;
begin
  if length(trim(coalesce(p_title, ''))) = 0
     or length(trim(coalesce(p_content, ''))) = 0
     or length(p_content) > 1000000
     or p_content_sha256 is null
     or p_content_sha256 !~ '^[0-9a-f]{64}$'
     or jsonb_array_length(v_chunks) < 1
     or jsonb_array_length(v_chunks) > 500 then
    raise exception 'Invalid knowledge entry payload';
  end if;

  perform 1 from public.rafa_knowledge_sources where id = p_source_id for update;
  if not found then raise exception 'Knowledge source not found'; end if;

  select id, revision, title, content_sha256, review_status
  into v_document_id, v_revision, v_old_title, v_old_hash, v_old_status
  from public.rafa_knowledge_documents
  where source_id = p_source_id
  order by (review_status = 'approved') desc, revision desc, fetched_at desc, id desc
  limit 1
  for update;

  if found then
    delete from public.rafa_knowledge_documents where source_id = p_source_id and id <> v_document_id;
    v_unchanged := v_old_status = 'approved'
      and v_old_hash = p_content_sha256
      and v_old_title = left(trim(p_title), 500);

    if not v_unchanged then
      update public.rafa_knowledge_documents
      set revision = 1,
          title = left(trim(p_title), 500),
          canonical_content = p_content,
          content_sha256 = p_content_sha256,
          language_code = coalesce(nullif(p_language_code, ''), 'en'),
          review_status = 'approved',
          approved_at = now(),
          approved_by = 'dashboard-operator',
          fetched_at = now(),
          valid_until = null,
          metadata = v_metadata
      where id = v_document_id;

      delete from public.rafa_knowledge_chunks where document_id = v_document_id;
      insert into public.rafa_knowledge_chunks (document_id, chunk_index, heading, content, metadata)
      select v_document_id, c.chunk_index, coalesce(c.heading, ''), c.content, coalesce(c.metadata, '{}'::jsonb)
      from jsonb_to_recordset(v_chunks) as c(chunk_index integer, heading text, content text, metadata jsonb);
    end if;
    if v_revision <> 1 then
      update public.rafa_knowledge_documents set revision = 1 where id = v_document_id;
      v_revision := 1;
    end if;
  else
    insert into public.rafa_knowledge_documents (
      source_id, revision, title, canonical_content, content_sha256,
      language_code, review_status, approved_at, approved_by, metadata
    ) values (
      p_source_id, 1, left(trim(p_title), 500), p_content, p_content_sha256,
      coalesce(nullif(p_language_code, ''), 'en'), 'approved', now(), 'dashboard-operator', v_metadata
    ) returning id, revision into v_document_id, v_revision;

    insert into public.rafa_knowledge_chunks (document_id, chunk_index, heading, content, metadata)
    select v_document_id, c.chunk_index, coalesce(c.heading, ''), c.content, coalesce(c.metadata, '{}'::jsonb)
    from jsonb_to_recordset(v_chunks) as c(chunk_index integer, heading text, content text, metadata jsonb);
  end if;

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
    'document_id', v_document_id,
    'revision', v_revision,
    'deduplicated', v_unchanged,
    'unchanged', v_unchanged
  );
end;
$$;

commit;
