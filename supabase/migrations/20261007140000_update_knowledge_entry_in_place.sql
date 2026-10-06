begin;

create or replace function public.rafa_update_knowledge_document(
  p_document_id uuid,
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
  v_source_id uuid;
  v_revision integer;
  v_old_title text;
  v_old_hash text;
  v_metadata jsonb;
  v_clean_metadata jsonb := case when jsonb_typeof(p_metadata) = 'object' then p_metadata else '{}'::jsonb end;
begin
  if length(trim(coalesce(p_title, ''))) = 0
     or length(trim(coalesce(p_content, ''))) = 0
     or length(p_content) > 250000
     or p_content_sha256 is null
     or p_content_sha256 !~ '^[0-9a-f]{64}$'
     or p_chunks is null
     or jsonb_typeof(p_chunks) <> 'array'
     or jsonb_array_length(p_chunks) < 1
     or jsonb_array_length(p_chunks) > 500 then
    raise exception 'Invalid knowledge entry payload';
  end if;

  select source_id into v_source_id
  from public.rafa_knowledge_documents
  where id = p_document_id;
  if not found then raise exception 'Knowledge entry not found'; end if;

  perform 1 from public.rafa_knowledge_sources where id = v_source_id for update;
  if not found then raise exception 'Knowledge source not found'; end if;

  select revision, title, content_sha256, metadata
  into v_revision, v_old_title, v_old_hash, v_metadata
  from public.rafa_knowledge_documents
  where id = p_document_id
  for update;

  if v_old_hash = p_content_sha256 and v_old_title = left(trim(p_title), 500) then
    return jsonb_build_object('document_id', p_document_id, 'revision', v_revision, 'unchanged', true);
  end if;

  v_metadata := coalesce(v_metadata, '{}'::jsonb) || v_clean_metadata;

  update public.rafa_knowledge_documents
  set title = left(trim(p_title), 500),
      canonical_content = p_content,
      content_sha256 = p_content_sha256,
      language_code = coalesce(nullif(p_language_code, ''), language_code, 'en'),
      review_status = 'approved',
      approved_at = now(),
      approved_by = 'dashboard-operator',
      fetched_at = now(),
      metadata = v_metadata
  where id = p_document_id;

  delete from public.rafa_knowledge_chunks where document_id = p_document_id;
  insert into public.rafa_knowledge_chunks (document_id, chunk_index, heading, content, metadata)
  select p_document_id, c.chunk_index, coalesce(c.heading, ''), c.content, coalesce(c.metadata, '{}'::jsonb)
  from jsonb_to_recordset(p_chunks) as c(chunk_index integer, heading text, content text, metadata jsonb);

  update public.rafa_knowledge_sources
  set last_content_hash = p_content_sha256,
      last_success_at = now(),
      last_fetched_at = now(),
      last_status = 'ready',
      last_error = ''
  where id = v_source_id;

  return jsonb_build_object('document_id', p_document_id, 'revision', v_revision, 'unchanged', false);
end;
$$;

revoke all on function public.rafa_update_knowledge_document(uuid, text, text, text, text, jsonb, jsonb) from public, authenticated;
grant execute on function public.rafa_update_knowledge_document(uuid, text, text, text, text, jsonb, jsonb) to anon;

commit;
