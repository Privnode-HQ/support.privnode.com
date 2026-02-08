-- Ticket soft delete (软删除)
-- 说明：
-- - 删除只标记 deleted_at/deleted_by_uid，不物理删除数据。
-- - 客户侧应隐藏已删除工单；管理员侧仍可查看。

alter table app.tickets
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by_uid bigint references app.users(uid) on delete set null,
  add column if not exists deleted_reason text;

create index if not exists idx_tickets_deleted_at on app.tickets (deleted_at);

