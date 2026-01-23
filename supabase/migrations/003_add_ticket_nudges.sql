-- Ticket nudges (催单记录)
-- 说明：
-- - 客户侧可对工单发起“催单”，用于提醒操作员处理。
-- - 该表仅用于记录催单行为；不应直接更新 tickets.updated_at，以避免影响列表排序。

create table if not exists app.ticket_nudges (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references app.tickets(id) on delete cascade,
  requester_uid bigint not null references app.users(uid) on delete restrict,
  created_at timestamptz not null default now()
);

create index if not exists idx_ticket_nudges_ticket_created_at
  on app.ticket_nudges (ticket_id, created_at desc);

create index if not exists idx_ticket_nudges_requester_created_at
  on app.ticket_nudges (requester_uid, created_at desc);

grant all privileges on table app.ticket_nudges to service_role;

alter table app.ticket_nudges enable row level security;

do $$ begin
  create policy deny_all_ticket_nudges on app.ticket_nudges for all using (false);
exception when duplicate_object then null; end $$;

