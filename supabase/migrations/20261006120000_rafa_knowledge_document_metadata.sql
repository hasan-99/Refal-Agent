-- REFAL-ADMIN-KB — lets an uploaded document's revision carry its own
-- metadata (e.g. sourceFileType/sourceFileName for a PDF/DOCX/TXT upload)
-- into rafa_knowledge_documents.metadata, which already exists and is
-- already selected/returned by the dashboard today. The new parameter has a
-- default, so every existing caller of rafa_store_knowledge_revision (the
-- URL-fetch and paste-import paths) keeps working unchanged and keeps
-- storing an empty metadata object exactly as before.
--
-- A new parameter changes this function's signature (its identifying
-- argument-type list), so CREATE OR REPLACE alone would create a second,
-- overloaded function instead of replacing this one — the same reasoning
-- already documented in 20261003224701's own drop-before-create for the
-- search RPCs. Drop the old 6-argument signature first so only one
-- rafa_store_knowledge_revision exists afterward.
drop function if exists public.rafa_store_knowledge_revision(uuid, text, text, text, text, jsonb);

create function public.rafa_store_knowledge_revision(
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
  v_revision integer;
  v_document_id uuid;
  v_metadata jsonb := case when jsonb_typeof(p_metadata) = 'object' then p_metadata else '{}'::jsonb end;
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

  perform 1 from public.rafa_knowledge_sources where id = p_source_id for update;
  if not found then raise exception 'Knowledge source not found'; end if;

  select id into v_document_id from public.rafa_knowledge_documents
  where source_id = p_source_id and content_sha256 = p_content_sha256;
  if found then
    return jsonb_build_object('document_id', v_document_id, 'deduplicated', true);
  end if;

  select coalesce(max(revision), 0) + 1 into v_revision
  from public.rafa_knowledge_documents where source_id = p_source_id;

  insert into public.rafa_knowledge_documents (
    source_id, revision, title, canonical_content, content_sha256, language_code, review_status, metadata
  ) values (
    p_source_id, v_revision, left(trim(p_title), 500), p_content,
    p_content_sha256, coalesce(nullif(p_language_code, ''), 'en'), 'pending', v_metadata
  ) returning id into v_document_id;

  insert into public.rafa_knowledge_chunks (document_id, chunk_index, heading, content, metadata)
  select v_document_id, c.chunk_index, coalesce(c.heading, ''), c.content, coalesce(c.metadata, '{}'::jsonb)
  from jsonb_to_recordset(p_chunks) as c(chunk_index integer, heading text, content text, metadata jsonb);

  update public.rafa_knowledge_sources
  set last_content_hash = p_content_sha256, last_success_at = now(), last_fetched_at = now(),
      last_status = 'ready', last_error = ''
  where id = p_source_id;

  return jsonb_build_object('document_id', v_document_id, 'revision', v_revision, 'deduplicated', false);
end;
$$;

revoke all on function public.rafa_store_knowledge_revision(uuid, text, text, text, text, jsonb, jsonb) from public, authenticated;
grant execute on function public.rafa_store_knowledge_revision(uuid, text, text, text, text, jsonb, jsonb) to anon;
