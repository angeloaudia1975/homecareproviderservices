-- ============================================================================
-- HCPS Activation / Go-Live Control — platform operating state.
-- One master switch with three modes, an official go-live date, and an env
-- stamp on every piece of BEHAVIORAL data so test/development activity never
-- contaminates production intelligence once the platform is Live.
--
--   modes:  development | sandbox | live
--   go_live_at: set ONCE, the first time the platform is switched to live.
--   env stamp:  written on each behavioral row = 'test' for flagged test
--               accounts, otherwise the current platform mode. When Live, the
--               intelligence engine scores ONLY env='live' rows.
--
-- Historical SALES data (monthly_sales) and imported order history are NOT
-- env-gated — they remain fully usable for revenue reporting at all times.
-- Run once in the Supabase SQL editor, BEFORE deploying the matching code.
-- Safe to re-run.
-- ============================================================================

-- Master platform state (single config row). Created only if absent so re-running
-- never resets a mode you've already set.
insert into app_settings (key, value, updated_at)
values ('platform_state', jsonb_build_object(
  'mode',        'development',   -- development | sandbox | live
  'go_live_at',  null,            -- ISO timestamp, stamped once on first go-live
  'mode_since',  now(),           -- when the current mode began
  'changed_by',  null,            -- staff email of the last change
  'history',     jsonb_build_array()   -- [{mode, at, by}] audit trail of mode changes
), now())
on conflict (key) do nothing;

-- Env stamp on behavioral tables. Default 'development' means every row that
-- already exists (all pre-launch) is correctly treated as non-production.
alter table intent_events add column if not exists env text default 'development';
alter table email_queue   add column if not exists env text default 'development';
alter table email_sends   add column if not exists env text default 'development';
alter table dealer_tasks  add column if not exists env text default 'development';
alter table orders        add column if not exists env text default 'development';

create index if not exists intent_events_env_idx on intent_events(env, occurred_at);
create index if not exists email_sends_env_idx    on email_sends(env, sent_at);
create index if not exists dealer_tasks_env_idx   on dealer_tasks(env);

-- Test-account flag. Activity by a flagged dealer is stamped env='test' and is
-- always excluded from production intelligence, in any mode.
alter table dealers add column if not exists is_test boolean default false;
