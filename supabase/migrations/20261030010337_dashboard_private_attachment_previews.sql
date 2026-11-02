-- Dashboard previews use short-lived Storage signed URLs, never public files.

create or replace function rafa_private.dashboard_can_sign_linked_attachment(p_storage_path text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select rafa_private.dashboard_user_is_admin()
    and exists (
      select 1
      from public.rafa_attachments as attachment
      where attachment.storage_path = p_storage_path
        and attachment.tenant_id = 'refalco'
        and attachment.status = 'linked'
    );
$$;

revoke all on function rafa_private.dashboard_can_sign_linked_attachment(text) from public, anon;
grant execute on function rafa_private.dashboard_can_sign_linked_attachment(text) to authenticated;

drop policy if exists "Dashboard admins can sign linked Rafa attachments" on storage.objects;
create policy "Dashboard admins can sign linked Rafa attachments"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'rafa-private-attachments'
    and storage.allow_only_operation('storage.object.sign')
    and rafa_private.dashboard_can_sign_linked_attachment(name)
  );

create or replace function public.rafa_dashboard_attachment_preview_metadata(
  p_attachment_id uuid,
  p_conversation_turn_id uuid,
  p_provider_message_id text
)
returns table(storage_path text, content_type text, size_bytes bigint)
language sql
stable
security definer
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
