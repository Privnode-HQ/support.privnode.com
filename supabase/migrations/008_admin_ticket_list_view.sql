-- Admin ticket list view
-- 目的：
-- - 避免 /admin/tickets 列表页在服务端产生 N+1 / 多段分块查询（ticket_nudges / ticket_messages / ticket_smart_scores）
-- - 将「最新催单时间」「是否待处理催单」「智能分数」合并到单次查询结果中

create or replace view app.admin_ticket_list as
select
  t.id,
  t.short_id,
  t.subject,
  t.status,
  t.creator_uid,
  t.is_global,
  t.merged_into_ticket_id,
  t.category_id,
  t.assigned_to_uid,
  t.deleted_at,
  t.deleted_by_uid,
  t.updated_at,
  t.created_at,
  n.nudge_last_at,
  (
    t.status <> 'closed'
    and n.nudge_last_at is not null
    and (sr.last_staff_reply_at is null or n.nudge_last_at > sr.last_staff_reply_at)
  ) as nudge_pending,
  case when t.status = 'closed' then null else sc.urgency_score end as smart_urgency_score,
  case when t.status = 'closed' then null else sc.time_score end as smart_time_score,
  case when t.status = 'closed' then null else sc.computed_at end as smart_computed_at
from app.tickets t
left join lateral (
  select n.created_at as nudge_last_at
  from app.ticket_nudges n
  where n.ticket_id = t.id
  order by n.created_at desc
  limit 1
) n on true
left join lateral (
  select m.created_at as last_staff_reply_at
  from app.ticket_messages m
  where m.ticket_id = t.id
    and m.actor in ('staff','anonymous')
    and m.deleted_at is null
    and m.purged_at is null
  order by m.created_at desc
  limit 1
) sr on true
left join app.ticket_smart_scores sc on sc.ticket_id = t.id
where t.purged_at is null;

grant select on table app.admin_ticket_list to service_role;

-- Speed up "latest staff/anonymous reply per ticket" lookup.
create index if not exists idx_ticket_messages_ticket_staff_latest
  on app.ticket_messages (ticket_id, created_at desc)
  where actor in ('staff','anonymous') and deleted_at is null and purged_at is null;

-- Speed up assigned filters in admin list.
create index if not exists idx_tickets_assigned_to_uid on app.tickets (assigned_to_uid);
