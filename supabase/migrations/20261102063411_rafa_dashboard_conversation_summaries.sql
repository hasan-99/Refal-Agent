-- Compact, dashboard-only conversation metadata. List APIs need accurate counts,
-- latest-message fields, and reply filters, but should not transfer full histories.
create or replace function public.rafa_dashboard_conversation_summaries()
returns table (
  user_id text,
  conversation_count bigint,
  message_count bigint,
  has_agent_reply boolean,
  has_customer_message boolean,
  last_message_at timestamptz,
  last_message_preview text,
  last_message text,
  last_message_direction text,
  needs_reply boolean
)
language sql
stable
security invoker
set search_path = ''
as $function$
  with turn_counts as (
    select
      turns.user_id,
      count(*) as conversation_count,
      count(*) filter (where turns.message <> '')
        + count(*) filter (where turns.response <> '') as message_count,
      bool_or(turns.response <> '') as has_agent_reply,
      bool_or(turns.message <> '') as has_customer_message
    from public.rafa_conversation_turns as turns
    group by turns.user_id
  ), latest_turn as (
    select distinct on (turns.user_id)
      turns.user_id,
      turns.at,
      turns.message,
      turns.response
    from public.rafa_conversation_turns as turns
    order by turns.user_id, turns.at desc, turns.id desc
  )
  select
    counts.user_id,
    counts.conversation_count,
    counts.message_count,
    counts.has_agent_reply,
    counts.has_customer_message,
    latest.at,
    left(coalesce(nullif(latest.message, ''), nullif(latest.response, ''), ''), 160),
    coalesce(nullif(latest.response, ''), nullif(latest.message, ''), ''),
    case when latest.response <> '' then 'outgoing' else 'incoming' end,
    latest.message <> '' and latest.response = ''
  from turn_counts as counts
  join latest_turn as latest using (user_id);
$function$;

revoke all on function public.rafa_dashboard_conversation_summaries() from public, anon, authenticated;
grant execute on function public.rafa_dashboard_conversation_summaries() to service_role;
