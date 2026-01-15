-- Privnode 支持（最小可用）Schema
-- 说明：
-- - 本项目当前以服务端（service role）访问 Supabase 为主，因此开启 RLS 并默认拒绝 anon/authenticated。
-- - 附件容量限制（单文件 <= 2MB、单用户总量 <= 500MB）在 DB 侧做硬约束（触发器）。

create schema if not exists app;

-- Enums
do $$ begin
  create type app.ticket_status as enum (
    'pending_assign',
    'assigned',
    'replied_by_staff',
    'replied_by_customer',
    'closed'
  );
exception
  when duplicate_object then null;
end $$;

do $$ begin
  create type app.ticket_message_actor as enum (
    'customer',-- Privnode 支持（最小可用）Schema
-- 说明：
-- - 本项目当前以服务端（service role）访问 Supabase 为主，因此开启 RLS 并默认拒绝 anon/authenticated。
-- - 附件容量限制（单文件 <= 2MB、单用户总量 <= 500MB）在 DB 侧做硬约束（触发器）。

create schema if not exists app;

-- Enums
do $$ begin
  create type app.ticket_status as enum (
    'pending_assign',
    'assigned',
    'replied_by_staff',
    'replied_by_customer',
    'closed'
  );
exception
  when duplicate_object then null;
end $$;

do $$ begin
  create type app.ticket_message_actor as enum (
    'customer',
    'staff',
    'system',
    'anonymous'
  );
exception
  when duplicate_object then null;
end $$;

-- Helpers
create or replace function app.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Users (映射 Privnode SSO uid)
create table if not exists app.users (
  uid bigint primary key,
  username text not null,
  display_name text,
  is_admin boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_login_at timestamptz
);

drop trigger if exists trg_users_updated_at on app.users;
create trigger trg_users_updated_at
before update on app.users
for each row execute function app.set_updated_at();

-- Categories (带可选表单定义)
create table if not exists app.ticket_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text,
  enabled boolean not null default true,
  sort_order int not null default 0,
  -- 表单定义：建议存数组，例如 [{"key":"order_id","label":"订单号","type":"text","required":false}]
  form_schema jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_ticket_categories_updated_at on app.ticket_categories;
create trigger trg_ticket_categories_updated_at
before update on app.ticket_categories
for each row execute function app.set_updated_at();

-- Tickets
create table if not exists app.tickets (
  id uuid primary key default gen_random_uuid(),
  creator_uid bigint not null references app.users(uid) on delete restrict,
  category_id uuid not null references app.ticket_categories(id) on delete restrict,
  subject text not null,
  form_data jsonb not null default '{}'::jsonb,
  status app.ticket_status not null default 'pending_assign',
  assigned_to_uid bigint references app.users(uid) on delete set null,
  closed_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz
);

create index if not exists idx_tickets_creator_created_at on app.tickets (creator_uid, created_at desc);
create index if not exists idx_tickets_status_updated_at on app.tickets (status, updated_at desc);

drop trigger if exists trg_tickets_updated_at on app.tickets;
create trigger trg_tickets_updated_at
before update on app.tickets
for each row execute function app.set_updated_at();

-- Ticket messages
create table if not exists app.ticket_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references app.tickets(id) on delete cascade,
  actor app.ticket_message_actor not null,
  author_uid bigint references app.users(uid) on delete set null,
  author_display_name text,
  body_markdown text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_ticket_messages_ticket_created_at on app.ticket_messages (ticket_id, created_at);

-- Attachment usage (per-user quota tracking)
create table if not exists app.user_attachment_usage (
  uid bigint primary key references app.users(uid) on delete cascade,
  total_bytes bigint not null default 0
);

-- Attachments metadata. Storage object is stored separately (bucket: ticket-attachments)
create table if not exists app.ticket_attachments (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references app.tickets(id) on delete cascade,
  message_id uuid references app.ticket_messages(id) on delete set null,
  uploader_uid bigint not null references app.users(uid) on delete restrict,
  object_path text not null unique,
  filename text not null,
  content_type text,
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 2097152),
  created_at timestamptz not null default now()
);

create index if not exists idx_ticket_attachments_uploader on app.ticket_attachments (uploader_uid);

create or replace function app.enforce_attachment_quota()
returns trigger
language plpgsql
as $$
declare
  current_bytes bigint;
  limit_bytes constant bigint := 500 * 1024 * 1024;
begin
  -- Lock row for update if exists
  select total_bytes into current_bytes
  from app.user_attachment_usage
  where uid = new.uploader_uid
  for update;

  if not found then
    insert into app.user_attachment_usage(uid, total_bytes) values (new.uploader_uid, 0);
    current_bytes := 0;
  end if;

  if current_bytes + new.size_bytes > limit_bytes then
    raise exception '附件容量超限（每位用户 500MB）';
  end if;

  update app.user_attachment_usage
  set total_bytes = current_bytes + new.size_bytes
  where uid = new.uploader_uid;

  return new;
end;
$$;

create or replace function app.decrement_attachment_usage()
returns trigger
language plpgsql
as $$
begin
  update app.user_attachment_usage
  set total_bytes = greatest(total_bytes - old.size_bytes, 0)
  where uid = old.uploader_uid;
  return old;
end;
$$;

drop trigger if exists trg_ticket_attachments_quota on app.ticket_attachments;
create trigger trg_ticket_attachments_quota
before insert on app.ticket_attachments
for each row execute function app.enforce_attachment_quota();

drop trigger if exists trg_ticket_attachments_decrement on app.ticket_attachments;
create trigger trg_ticket_attachments_decrement
after delete on app.ticket_attachments
for each row execute function app.decrement_attachment_usage();

-- Storage bucket (run once; might require elevated privileges in some setups)
insert into storage.buckets (id, name, public)
values ('ticket-attachments', 'ticket-attachments', false)
on conflict (id) do nothing;

-- Permissions
-- Supabase 的 PostgREST 会以 JWT 的 role（anon/authenticated/service_role）访问数据库。
-- 本项目服务端使用 service_role key，因此需要确保 service_role 拥有 app schema 的权限。
grant usage on schema app to service_role;
grant all privileges on all tables in schema app to service_role;
grant all privileges on all sequences in schema app to service_role;
grant execute on all functions in schema app to service_role;

-- Future-proof default privileges (run as postgres/supabase_admin)
alter default privileges in schema app grant all on tables to service_role;
alter default privileges in schema app grant all on sequences to service_role;
alter default privileges in schema app grant execute on functions to service_role;

-- RLS: deny by default (service role bypasses RLS)
alter table app.users enable row level security;
alter table app.ticket_categories enable row level security;
alter table app.tickets enable row level security;
alter table app.ticket_messages enable row level security;
alter table app.ticket_attachments enable row level security;
alter table app.user_attachment_usage enable row level security;

do $$ begin
  create policy deny_all_users on app.users for all using (false);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy deny_all_ticket_categories on app.ticket_categories for all using (false);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy deny_all_tickets on app.tickets for all using (false);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy deny_all_ticket_messages on app.ticket_messages for all using (false);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy deny_all_ticket_attachments on app.ticket_attachments for all using (false);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy deny_all_user_attachment_usage on app.user_attachment_usage for all using (false);
exception when duplicate_object then null; end $$;

-- Seed: a default category
insert into app.ticket_categories (name, description, sort_order, enabled, form_schema)
values (
  '一般问题',
  '默认类别，可在后台编辑/新增。',
  0,
  true,
  '[]'::jsonb
)
on conflict do nothing;

    'staff',
    'system',
    'anonymous'
  );
exception
  when duplicate_object then null;
end $$;

-- Helpers
create or replace function app.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Users (映射 Privnode SSO uid)
create table if not exists app.users (
  uid bigint primary key,
  username text not null,
  display_name text,
  is_admin boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_login_at timestamptz
);

drop trigger if exists trg_users_updated_at on app.users;
create trigger trg_users_updated_at
before update on app.users
for each row execute function app.set_updated_at();

-- Categories (带可选表单定义)
create table if not exists app.ticket_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text,
  enabled boolean not null default true,
  sort_order int not null default 0,
  -- 表单定义：建议存数组，例如 [{"key":"order_id","label":"订单号","type":"text","required":false}]
  form_schema jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_ticket_categories_updated_at on app.ticket_categories;
create trigger trg_ticket_categories_updated_at
before update on app.ticket_categories
for each row execute function app.set_updated_at();

-- Tickets
create table if not exists app.tickets (
  id uuid primary key default gen_random_uuid(),
  creator_uid bigint not null references app.users(uid) on delete restrict,
  category_id uuid not null references app.ticket_categories(id) on delete restrict,
  subject text not null,
  form_data jsonb not null default '{}'::jsonb,
  status app.ticket_status not null default 'pending_assign',
  assigned_to_uid bigint references app.users(uid) on delete set null,
  closed_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz
);

create index if not exists idx_tickets_creator_created_at on app.tickets (creator_uid, created_at desc);
create index if not exists idx_tickets_status_updated_at on app.tickets (status, updated_at desc);

drop trigger if exists trg_tickets_updated_at on app.tickets;
create trigger trg_tickets_updated_at
before update on app.tickets
for each row execute function app.set_updated_at();

-- Ticket messages
create table if not exists app.ticket_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references app.tickets(id) on delete cascade,
  actor app.ticket_message_actor not null,
  author_uid bigint references app.users(uid) on delete set null,
  author_display_name text,
  body_markdown text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_ticket_messages_ticket_created_at on app.ticket_messages (ticket_id, created_at);

-- Attachment usage (per-user quota tracking)
create table if not exists app.user_attachment_usage (
  uid bigint primary key references app.users(uid) on delete cascade,
  total_bytes bigint not null default 0
);

-- Attachments metadata. Storage object is stored separately (bucket: ticket-attachments)
create table if not exists app.ticket_attachments (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references app.tickets(id) on delete cascade,
  message_id uuid references app.ticket_messages(id) on delete set null,
  uploader_uid bigint not null references app.users(uid) on delete restrict,
  object_path text not null unique,
  filename text not null,
  content_type text,
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 2097152),
  created_at timestamptz not null default now()
);

create index if not exists idx_ticket_attachments_uploader on app.ticket_attachments (uploader_uid);

create or replace function app.enforce_attachment_quota()
returns trigger
language plpgsql
as $$
declare
  current_bytes bigint;
  limit_bytes constant bigint := 500 * 1024 * 1024;
begin
  -- Lock row for update if exists
  select total_bytes into current_bytes
  from app.user_attachment_usage
  where uid = new.uploader_uid
  for update;

  if not found then
    insert into app.user_attachment_usage(uid, total_bytes) values (new.uploader_uid, 0);
    current_bytes := 0;
  end if;

  if current_bytes + new.size_bytes > limit_bytes then
    raise exception '附件容量超限（每位用户 500MB）';
  end if;

  update app.user_attachment_usage
  set total_bytes = current_bytes + new.size_bytes
  where uid = new.uploader_uid;

  return new;
end;
$$;

create or replace function app.decrement_attachment_usage()
returns trigger
language plpgsql
as $$
begin
  update app.user_attachment_usage
  set total_bytes = greatest(total_bytes - old.size_bytes, 0)
  where uid = old.uploader_uid;
  return old;
end;
$$;

drop trigger if exists trg_ticket_attachments_quota on app.ticket_attachments;
create trigger trg_ticket_attachments_quota
before insert on app.ticket_attachments
for each row execute function app.enforce_attachment_quota();

drop trigger if exists trg_ticket_attachments_decrement on app.ticket_attachments;
create trigger trg_ticket_attachments_decrement
after delete on app.ticket_attachments
for each row execute function app.decrement_attachment_usage();

-- Storage bucket (run once; might require elevated privileges in some setups)
insert into storage.buckets (id, name, public)
values ('ticket-attachments', 'ticket-attachments', false)
on conflict (id) do nothing;

-- Permissions
-- Supabase 的 PostgREST 会以 JWT 的 role（anon/authenticated/service_role）访问数据库。
-- 本项目服务端使用 service_role key，因此需要确保 service_role 拥有 app schema 的权限。
grant usage on schema app to service_role;
grant all privileges on all tables in schema app to service_role;
grant all privileges on all sequences in schema app to service_role;
grant execute on all functions in schema app to service_role;

-- Future-proof default privileges (run as postgres/supabase_admin)
alter default privileges in schema app grant all on tables to service_role;
alter default privileges in schema app grant all on sequences to service_role;
alter default privileges in schema app grant execute on functions to service_role;

-- RLS: deny by default (service role bypasses RLS)
alter table app.users enable row level security;
alter table app.ticket_categories enable row level security;
alter table app.tickets enable row level security;
alter table app.ticket_messages enable row level security;
alter table app.ticket_attachments enable row level security;
alter table app.user_attachment_usage enable row level security;

do $$ begin
  create policy deny_all_users on app.users for all using (false);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy deny_all_ticket_categories on app.ticket_categories for all using (false);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy deny_all_tickets on app.tickets for all using (false);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy deny_all_ticket_messages on app.ticket_messages for all using (false);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy deny_all_ticket_attachments on app.ticket_attachments for all using (false);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy deny_all_user_attachment_usage on app.user_attachment_usage for all using (false);
exception when duplicate_object then null; end $$;

-- Seed: a default category
insert into app.ticket_categories (name, description, sort_order, enabled, form_schema)
values (
  '一般问题',
  '默认类别，可在后台编辑/新增。',
  0,
  true,
  '[]'::jsonb
)
on conflict do nothing;
