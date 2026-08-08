-- ============================================================================
-- HCPS automation engine (Phase 3) — the data layer for the behavior-triggered
-- follow-up + email machine. Separates DECIDING (tasks + eligibility, runs hourly)
-- from DELIVERY (windowed, capped email sends).
--   * email_queue     — emails the engine wants to send, with a send window + status
--   * email_sends     — ledger of what actually went out (powers the frequency cap)
--   * dealer_engagement — nightly cache of status/score/cadence per dealer
--   * app_settings 'automation_config' — every tunable parameter, editable in one place
-- Run once in the Supabase SQL editor. Safe to re-run.
-- ============================================================================

-- Emails the engine has decided to send. Draining happens only in send windows.
create table if not exists email_queue (
  id           uuid primary key default gen_random_uuid(),
  dealer_id    uuid,
  contact_email text,
  template     text not null,          -- overdue | dormant | cart | new | crosssell | campaign
  reason       text,                   -- signal key, e.g. overdue:golden
  priority     text default 'normal',  -- high | normal
  send_window  text default 'behavior',-- primary | behavior | remaining
  payload      jsonb default '{}'::jsonb,
  status       text default 'queued',  -- queued | sent | skipped | failed | expired | canceled
  detail       text,                   -- human summary for the admin queue view
  send_after   timestamptz not null default now(),
  enqueued_at  timestamptz not null default now(),
  sent_at      timestamptz,
  error        text
);
alter table email_queue enable row level security;   -- service_role only
create index if not exists email_queue_status_idx on email_queue(status, send_after);
create index if not exists email_queue_dealer_idx on email_queue(dealer_id);
-- One live queued email per dealer+template at a time (no piling up duplicates).
create unique index if not exists email_queue_live_uniq
  on email_queue(dealer_id, template) where status='queued';

-- What actually got sent. This is the source of truth for the frequency cap.
create table if not exists email_sends (
  id           uuid primary key default gen_random_uuid(),
  dealer_id    uuid,
  contact_email text,
  template     text,
  sent_at      timestamptz not null default now()
);
alter table email_sends enable row level security;   -- service_role only
create index if not exists email_sends_dealer_idx on email_sends(dealer_id, sent_at desc);

-- Nightly cache: engagement status/score/cadence per dealer (fast reads, dormant status).
create table if not exists dealer_engagement (
  dealer_id     uuid primary key,
  status        text,                  -- active | slipping | overdue | dormant | new | inactive
  score         numeric,               -- 0..100 recency/frequency/value blend
  months_since  int,
  last_period   text,                  -- YYYY-MM of last order
  dormant_since date,
  cycle_json    jsonb default '{}'::jsonb,   -- per-line typical cadence
  computed_at   timestamptz not null default now()
);
alter table dealer_engagement enable row level security;   -- service_role only

-- Seed the single config row that holds every tunable parameter. Created only if
-- absent, so re-running never clobbers values you've tuned in the admin panel.
insert into app_settings (key, value, updated_at)
values ('automation_config', jsonb_build_object(
  'engine_enabled', true,
  'email_enabled', false,               -- DRY-RUN until you flip this on
  'cap_per_7d', 2,
  'min_gap_hours', 48,
  'dormant_months', 3,
  'overdue_mult', 0.5,
  'overdue_min_gap_months', 1,
  'quiet_weekends', true,
  'business_hours', jsonb_build_array(7,19),
  'timezone', 'America/New_York',
  'windows', jsonb_build_object(
     'primary',  jsonb_build_array(9,10),
     'behavior', jsonb_build_array(12,13),
     'remaining',jsonb_build_array(15,16)),
  'templates_enabled', jsonb_build_object(
     'overdue', true, 'dormant', true, 'cart', true, 'new', true),
  'queue_ttl_hours', 72
), now())
on conflict (key) do nothing;
