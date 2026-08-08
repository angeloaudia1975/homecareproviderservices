-- ============================================================================
-- HCPS re-engagement email (Phase 3 marketing) — an unsubscribe/opt-out list so we
-- never email a contact who has opted out. Sends are logged in dealer_activity
-- (kind='campaign'). Run once in the Supabase SQL editor. Safe to re-run.
-- ============================================================================

create table if not exists email_optout (
  email      text primary key,
  dealer_id  uuid,
  reason     text,
  created_at timestamptz not null default now()
);
alter table email_optout enable row level security;   -- service_role only
