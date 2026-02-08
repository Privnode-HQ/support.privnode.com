-- Ticket participants + merges + global tickets
-- 说明：
-- - ticket_participants：用于“共同工单”，允许一个工单关联多个用户。
-- - tickets.is_global：用于“全体用户共同工单”（无需写入大量参与者行）。
-- - tickets.merged_*：用于工单合并（重复工单合并到主工单）。

create table if not exists app.ticket_participants (
  ticket_id uuid not null references app.tickets(id) on delete cascade,
  uid bigint not null references app.users(uid) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (ticket_id, uid)
);

create index if not exists idx_ticket_participants_uid
  on app.ticket_participants (uid);

create index if not exists idx_ticket_participants_ticket_id
  on app.ticket_participants (ticket_id);

-- Global audience (all users)
alter table app.tickets
  add column if not exists is_global boolean not null default false;

-- Merge fields
alter table app.tickets
  add column if not exists merged_into_ticket_id uuid references app.tickets(id) on delete set null;

alter table app.tickets
  add column if not exists merged_at timestamptz;

alter table app.tickets
  add column if not exists merged_by_uid bigint references app.users(uid) on delete set null;

alter table app.tickets
  add column if not exists merged_reason text;

do $$ begin
  alter table app.tickets
    add constraint tickets_merged_into_not_self
    check (merged_into_ticket_id is null or merged_into_ticket_id <> id);
exception
  when duplicate_object then null;
end $$;

grant all privileges on table app.ticket_participants to service_role;

alter table app.ticket_participants enable row level security;

do $$ begin
  create policy deny_all_ticket_participants on app.ticket_participants for all using (false);
exception when duplicate_object then null; end $$;

