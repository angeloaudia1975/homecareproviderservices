-- ============================================================================
-- Campaign conversions — the "did the dealer actually DO the thing" ledger.
-- Campaign Studio goals measure COMPLETED ACTIONS (first Golden login, HCPS
-- online-ordering registration, first order, …), not just email opens/clicks.
-- Milestone goals fire ONCE per dealer (unique dealer_id+goal); repeatable
-- behaviors (product views, reorders) are measured by joining intent_events, not
-- stored here. Campaign attribution (campaign_id) is filled when a conversion can
-- be tied to a specific campaign's frozen recipient set within its window.
-- Run once in the Supabase SQL editor. Safe to re-run.
-- ============================================================================
create table if not exists campaign_conversions (
  id          uuid primary key default gen_random_uuid(),
  dealer_id   uuid,
  account_no  text,                       -- account-number anchor (Golden customer_no / hcps_account)
  goal        text not null,              -- golden_first_login | hcps_registration | first_order | ...
  event_type  text,                       -- the underlying signal (login, registration, order_created…)
  campaign_id uuid,                        -- attributed campaign, when known
  source      text,                        -- golden | hcps | portal
  value       numeric,                     -- revenue conversions (first order $)
  env         text default 'development',
  meta        jsonb default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  created_at  timestamptz not null default now()
);
-- One milestone conversion per dealer per goal (idempotent first-login / registration).
create unique index if not exists campaign_conversions_dealer_goal_uidx
  on campaign_conversions(dealer_id, goal) where dealer_id is not null;
create index if not exists campaign_conversions_goal_idx on campaign_conversions(goal, occurred_at desc);
create index if not exists campaign_conversions_campaign_idx on campaign_conversions(campaign_id);
alter table campaign_conversions enable row level security;   -- service_role only
