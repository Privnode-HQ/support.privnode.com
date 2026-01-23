-- Smart sorting scores (智能排序分数)
-- 说明：
-- - 分数由服务端/定时任务写入，不应在每次访问列表时实时计算。
-- - 该表仅存储排序用分数，不应影响 tickets.updated_at。

create table if not exists app.ticket_smart_scores (
  ticket_id uuid primary key references app.tickets(id) on delete cascade,
  urgency_score double precision not null,
  time_score double precision not null,
  computed_at timestamptz not null default now()
);

create index if not exists idx_ticket_smart_scores_urgency_time
  on app.ticket_smart_scores (urgency_score desc, time_score desc);

grant all privileges on table app.ticket_smart_scores to service_role;

alter table app.ticket_smart_scores enable row level security;

do $$ begin
  create policy deny_all_ticket_smart_scores on app.ticket_smart_scores for all using (false);
exception when duplicate_object then null; end $$;

