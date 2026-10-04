set lock_timeout = '5s';

-- Keep one canonical active handover per contact. Existing request rows remain
-- in the table as cancelled history, and their notification jobs move to the
-- canonical row so no drafts or delivery records are orphaned.
with ranked as (
  select
    id,
    contact_id,
    row_number() over (
      partition by contact_id
      order by
        case priority when 'urgent' then 3 when 'high' then 2 else 1 end desc,
        created_at desc,
        id
    ) as position,
    count(*) over (partition by contact_id) as active_count
  from public.rafa_handovers
  where contact_id is not null
    and status in ('open', 'acknowledged')
), canonical as (
  select contact_id, id as canonical_id
  from ranked
  where position = 1 and active_count > 1
), merged_requests as (
  select
    c.canonical_id,
    jsonb_agg(
      jsonb_build_object(
        'handoverId', h.id,
        'sourceTurnId', h.source_turn_id,
        'createdAt', h.created_at,
        'department', h.department,
        'priority', h.priority,
        'status', h.status,
        'summary', coalesce(h.summary, '{}'::jsonb)
      ) order by h.created_at desc, h.id
    ) as requests
  from canonical c
  join public.rafa_handovers h on h.contact_id = c.contact_id
  where h.status in ('open', 'acknowledged')
  group by c.canonical_id
)
update public.rafa_handovers h
set summary = coalesce(h.summary, '{}'::jsonb) || jsonb_build_object('relatedRequests', m.requests)
from merged_requests m
where h.id = m.canonical_id;

with ranked as (
  select
    id,
    contact_id,
    first_value(id) over (
      partition by contact_id
      order by
        case priority when 'urgent' then 3 when 'high' then 2 else 1 end desc,
        created_at desc,
        id
    ) as canonical_id,
    row_number() over (
      partition by contact_id
      order by
        case priority when 'urgent' then 3 when 'high' then 2 else 1 end desc,
        created_at desc,
        id
    ) as position
  from public.rafa_handovers
  where contact_id is not null
    and status in ('open', 'acknowledged')
)
update public.rafa_notification_jobs j
set handover_id = r.canonical_id
from ranked r
where r.position > 1
  and j.handover_id = r.id;

with ranked as (
  select
    id,
    row_number() over (
      partition by contact_id
      order by
        case priority when 'urgent' then 3 when 'high' then 2 else 1 end desc,
        created_at desc,
        id
    ) as position
  from public.rafa_handovers
  where contact_id is not null
    and status in ('open', 'acknowledged')
)
update public.rafa_handovers h
set status = 'cancelled', resolved_at = coalesce(h.resolved_at, now())
from ranked r
where h.id = r.id and r.position > 1;

create unique index if not exists rafa_handovers_one_active_per_contact_idx
  on public.rafa_handovers (contact_id)
  where contact_id is not null and status in ('open', 'acknowledged');
