-- Remove the seeded Refalco knowledge, saved chat transcripts/summaries, and
-- dashboard-agent chats that reference the company. Keep contacts and bookings.
do $$
declare
  target_sessions uuid[];
begin
  delete from public.rafa_knowledge_chunks;
  delete from public.rafa_knowledge_documents;
  delete from public.rafa_knowledge_sources;
  delete from public.rafa_conversation_turns;

  select array_agg(distinct s.id)
    into target_sessions
    from public.rafa_agent_sessions s
    left join public.rafa_agent_messages m on m.session_id = s.id
   where s.title ilike '%refalco%' or s.title ilike '%ريفالكو%'
      or m.content ilike '%refalco%' or m.content ilike '%ريفالكو%';

  if target_sessions is not null then
    delete from public.rafa_agent_memories where source_session_id = any(target_sessions);
    delete from public.rafa_agent_messages where session_id = any(target_sessions);
    delete from public.rafa_agent_sessions where id = any(target_sessions);
  end if;

  update public.rafa_contacts
     set profile = profile - 'conversationSummary' - 'conversationSummaryUpdatedAt'
   where profile ? 'conversationSummary' or profile ? 'conversationSummaryUpdatedAt';
end $$;
