-- ============================================================================
-- HCPS Email Automation — PHASE 1 data layer (intent + relationship).
-- Three tables that turn per-dealer behavior and order history into a live
-- "who is warm, and on what" signal, plus the manufacturer-relationship matrix.
--
--   * intent_events     — append-only log of per-dealer behavior (from the
--                         ordering portal and, later, ESP open/click webhooks)
--   * dealer_intent     — rolling, decayed intent score per dealer (+ per line)
--   * dealer_line_status— relationship matrix: active | prospect | dormant per
--                         dealer x manufacturer (complements the existing
--                         dealer_manufacturers ENTITLEMENT grid — this is the
--                         COMMERCIAL status derived from sales, not an account grant)
--
-- Keys match the rest of the schema: dealer_id uuid, manufacturer = slug (text,
-- same as monthly_sales.manufacturer). Cadence is in MONTHS to match the monthly
-- sales granularity the engine already uses.
-- Run once in the Supabase SQL editor. Safe to re-run.
-- ============================================================================

-- ---- 1. intent_events : raw behavioral log --------------------------------
-- One row per meaningful action. weight is written server-side from config so
-- the client can never inflate its own score. Only IDENTIFIED (signed-in)
-- dealers are logged — anonymous marketing-site traffic is out of scope here
-- (that is Cloudflare's aggregate world, which cannot name a dealer).
create table if not exists intent_events (
  id           uuid primary key default gen_random_uuid(),
  dealer_id    uuid not null,
  manufacturer text,                     -- slug, when the event is line-specific
  product_code text,                     -- catalog code, when product-specific
  event_type   text not null,            -- login | product_view | product_view_repeat |
                                         -- pricing_view | order_page | order_started |
                                         -- email_open | email_click
  weight       int  not null default 0,  -- points, assigned server-side from config
  source       text default 'ordering',  -- ordering | email | admin
  meta         jsonb default '{}'::jsonb,
  occurred_at  timestamptz not null default now()
);
alter table intent_events enable row level security;   -- service_role only
create index if not exists intent_events_dealer_idx on intent_events(dealer_id, occurred_at desc);
create index if not exists intent_events_time_idx   on intent_events(occurred_at);
create index if not exists intent_events_mfr_idx    on intent_events(dealer_id, manufacturer);

-- ---- 2. dealer_intent : rolling score cache -------------------------------
-- Recomputed by the engine (hourly for freshness, nightly for the full sweep).
-- score_total is the decayed sum over the rolling window; by_manufacturer keeps
-- the per-line breakdown so a rep alert can name the exact line/product.
create table if not exists dealer_intent (
  dealer_id       uuid primary key,
  score_total     numeric default 0,
  tier            text default 'normal', -- normal | interested | high | opportunity
  by_manufacturer jsonb default '{}'::jsonb,   -- { "golden": 22, "bemis": 8, ... }
  top_manufacturer text,
  top_product     text,
  last_event_at   timestamptz,
  computed_at     timestamptz not null default now()
);
alter table dealer_intent enable row level security;   -- service_role only
create index if not exists dealer_intent_tier_idx on dealer_intent(tier);

-- ---- 3. dealer_line_status : the relationship matrix ----------------------
-- One row per dealer x line that has a relationship worth tracking. Lines the
-- dealer has ordered get active/dormant; lines cross-sell flags as a fit get
-- prospect. "none" is implicit (no row). Derived nightly from monthly_sales +
-- cross_sell. This does NOT touch dealer_manufacturers (the live entitlement
-- grid the ordering portal reads) — it lives alongside it.
create table if not exists dealer_line_status (
  dealer_id     uuid not null,
  manufacturer  text not null,           -- slug
  relationship  text not null default 'none', -- active | prospect | dormant | none
  fit_flag      boolean default false,   -- cross-sell says this line fits the dealer
  first_order_period text,               -- YYYY-MM of first order (null for prospects)
  last_order_period  text,               -- YYYY-MM of most recent order
  reorder_months numeric,                -- typical months between orders (median gap)
  months_since  int,                     -- months since last order
  status_since  date,                    -- when it went dormant (dormant only)
  score         numeric,                 -- cross-sell fit score, when prospect
  notes         text,
  computed_at   timestamptz not null default now(),
  primary key (dealer_id, manufacturer)
);
alter table dealer_line_status enable row level security;   -- service_role only
create index if not exists dealer_line_status_rel_idx on dealer_line_status(relationship);
create index if not exists dealer_line_status_mfr_idx on dealer_line_status(manufacturer, relationship);

-- ---- 4. automation_config : add the intent tunables (non-destructive) ------
-- Adds the intent_* keys only where they are absent; existing tuned values win
-- because `defaults || value` gives the current value precedence. The row is
-- created by engine.sql; this UPDATE assumes it already exists.
update app_settings
set value = jsonb_build_object(
      'intent_enabled', true,
      'intent_window_days', 30,             -- rolling window for scoring
      'intent_decay_pct_per_week', 0.20,    -- 20% weekly decay on aging events
      'intent_weights', jsonb_build_object(
         'login', 2,
         'product_view', 3,
         'product_view_repeat', 5,
         'pricing_view', 8,
         'order_page', 10,
         'order_started', 15,
         'email_open', 1,
         'email_click', 4),
      'intent_tiers', jsonb_build_object(   -- lower bound of each tier
         'interested', 10,
         'high', 20,
         'opportunity', 30),
      'intent_task_threshold', 30,          -- create a rep "Call dealer" task at/above this
      'intent_task_cooldown_days', 7        -- suppress re-creating the same intent task
    ) || value,
    updated_at = now()
where key = 'automation_config';
