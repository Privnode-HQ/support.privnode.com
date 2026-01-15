-- Add short_id column to tickets table
-- short_id is the first 8 lowercase characters of SHA1 hash of the ticket UUID

-- Enable pgcrypto extension if not already enabled (for sha1 function)
create extension if not exists pgcrypto;

-- Add short_id column to tickets table
alter table app.tickets
  add column short_id text;

-- Create a function to generate short_id from UUID
create or replace function app.generate_short_id(ticket_uuid uuid)
returns text
language plpgsql
immutable
as $$
begin
  return lower(substring(encode(digest(ticket_uuid::text, 'sha1'), 'hex'), 1, 8));
end;
$$;

-- Generate short_id for existing tickets
update app.tickets
set short_id = app.generate_short_id(id);

-- Make short_id NOT NULL now that all existing records have values
alter table app.tickets
  alter column short_id set not null;

-- Add unique index on short_id for fast lookups
create unique index tickets_short_id_idx on app.tickets(short_id);

-- Create a trigger to automatically generate short_id for new tickets
create or replace function app.set_ticket_short_id()
returns trigger
language plpgsql
as $$
begin
  new.short_id := app.generate_short_id(new.id);
  return new;
end;
$$;

create trigger set_ticket_short_id_trigger
  before insert on app.tickets
  for each row
  execute function app.set_ticket_short_id();

-- Grant execute permission on the function to authenticated users
grant execute on function app.generate_short_id(uuid) to authenticated;
grant execute on function app.set_ticket_short_id() to authenticated;
