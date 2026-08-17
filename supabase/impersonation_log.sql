-- HCPS — "View as Rep" audit log.
--
-- Every time a President starts (or exits) a View-as-Rep session, staff-auth writes a row here
-- with the service-role key. This is the accountability record the admin impersonation feature is
-- built around: who viewed as whom, and when. No password is ever involved or stored.
--
-- Safe to run repeatedly.

create table if not exists impersonation_log (
  id           bigint generated always as identity primary key,
  admin_email  text,
  admin_name   text,
  target_email text,
  target_name  text,
  action       text default 'start',   -- 'start' | 'end'
  user_agent   text,
  created_at   timestamptz default now()
);

create index if not exists impersonation_log_created_idx on impersonation_log (created_at desc);
create index if not exists impersonation_log_target_idx  on impersonation_log (target_email);

-- Staff-only data: lock it down. The function reaches it with the service-role key (which bypasses
-- RLS), so enabling RLS with no public policy simply keeps it invisible to the anon/public key.
alter table impersonation_log enable row level security;
