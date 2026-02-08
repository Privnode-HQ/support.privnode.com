-- Ticket "purge" (彻底删除但保留数据库记录) + message soft delete
-- 说明：
-- - purged_at：彻底删除后，管理员端也不再展示，但记录保留在 DB 里。
-- - ticket_messages 支持 deleted_at（软删除，可恢复）与 purged_at（彻底删除但保留记录）。

alter table app.tickets
  add column if not exists purged_at timestamptz,
  add column if not exists purged_by_uid bigint references app.users(uid) on delete set null,
  add column if not exists purged_reason text;

create index if not exists idx_tickets_purged_at on app.tickets (purged_at);

alter table app.ticket_messages
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by_uid bigint references app.users(uid) on delete set null,
  add column if not exists deleted_reason text,
  add column if not exists purged_at timestamptz,
  add column if not exists purged_by_uid bigint references app.users(uid) on delete set null,
  add column if not exists purged_reason text;

create index if not exists idx_ticket_messages_deleted_at on app.ticket_messages (deleted_at);
create index if not exists idx_ticket_messages_purged_at on app.ticket_messages (purged_at);

