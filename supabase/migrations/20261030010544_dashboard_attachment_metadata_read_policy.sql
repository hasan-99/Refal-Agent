-- The dashboard RPC reads only the minimum attachment fields while the
-- backend secret policy keeps the linked-file metadata inaccessible to clients.

grant select (
  id, tenant_id, provider_message_id, conversation_turn_id,
  storage_path, content_type, size_bytes, status
) on public.rafa_attachments to anon;

drop policy if exists "Dashboard backend can read linked attachment metadata" on public.rafa_attachments;
create policy "Dashboard backend can read linked attachment metadata"
  on public.rafa_attachments
  for select
  to anon
  using (
    tenant_id = 'refalco'
    and status = 'linked'
    and public.rafa_dashboard_secret_matches()
  );

create or replace function public.rafa_dashboard_attachment_preview_metadata(
  p_attachment_id uuid,
  p_conversation_turn_id uuid,
  p_provider_message_id text
)
returns table(storage_path text, content_type text, size_bytes bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  select attachment.storage_path, attachment.content_type, attachment.size_bytes
  from public.rafa_attachments as attachment
  where public.rafa_dashboard_secret_matches()
    and attachment.id = p_attachment_id
    and attachment.conversation_turn_id = p_conversation_turn_id
    and attachment.provider_message_id = p_provider_message_id
    and attachment.tenant_id = 'refalco'
    and attachment.status = 'linked';
$$;

revoke all on function public.rafa_dashboard_attachment_preview_metadata(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.rafa_dashboard_attachment_preview_metadata(uuid, uuid, text) to anon;
