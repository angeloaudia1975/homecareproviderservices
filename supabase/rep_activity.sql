-- HCPS Connect 360 — Rep usage accountability (Phase 3 capture).
-- Two append/update tables that fill the one real gap: staff/rep app usage.
--   staff_sessions  — one row per sign-in session: login time, last-seen, real active seconds.
--   rep_activity    — append-only event log of tools/pages opened and dealer accounts viewed
--                     (meaningful CRM/route/task actions are already captured, attributed, in
--                      dealer_notes / dealer_activity / dealer_tasks / dealer_visits / rep_routes /
--                      opportunities — the admin dashboard aggregates those directly).
-- Written only by netlify/functions/activity-api.js with the service role. RLS on, no public policy.

create table if not exists staff_sessions (
  id            uuid primary key default gen_random_uuid(),
  email         text not null,
  rep_name      text,
  role          text,
  login_at      timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  active_seconds integer not null default 0,   -- real foreground time, counted only while the tab is visible
  user_agent    text,
  created_at    timestamptz not null default now()
);
create index if not exists staff_sessions_email_idx on staff_sessions (email);
create index if not exists staff_sessions_login_idx on staff_sessions (login_at desc);
alter table staff_sessions enable row level security;

create table if not exists rep_activity (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,
  rep_name    text,
  role        text,
  action      text not null,          -- 'view' (tool/page opened) | 'dealer_view' (account opened) | future action kinds
  tool        text,                   -- page/tool slug, e.g. 'dealer', 'map', 'call-list'
  dealer_id   uuid,
  meta        jsonb,
  occurred_at timestamptz not null default now()
);
create index if not exists rep_activity_email_idx  on rep_activity (email);
create index if not exists rep_activity_time_idx   on rep_activity (occurred_at desc);
create index if not exists rep_activity_action_idx on rep_activity (action);
create index if not exists rep_activity_dealer_idx on rep_activity (dealer_id);
alter table rep_activity enable row level security;
