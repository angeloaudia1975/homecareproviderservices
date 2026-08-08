-- ============================================================================
-- HCPS cross-sell ("bought this -> look at this") — per-dealer line recommendations
-- computed nightly by the engine from manufacturer-line co-purchase patterns. Retired
-- lines are never recommended. Powers the cross-sell email template and the Dealer 360
-- "Cross-sell" card. Run once in Supabase. Safe to re-run.
-- ============================================================================
create table if not exists cross_sell (
  dealer_id   uuid not null,
  rank        int,
  rec_slug    text not null,
  rec_name    text,
  basis_slug  text,
  basis_name  text,
  score       numeric,
  support     int,
  computed_at timestamptz not null default now(),
  primary key (dealer_id, rec_slug)
);
alter table cross_sell enable row level security;   -- service_role only
create index if not exists cross_sell_dealer_idx on cross_sell(dealer_id, rank);

-- Turn on the cross-sell email template in the automation config (leaves the master
-- email switch and every other flag as-is; only adds templates_enabled.crosssell=true).
update app_settings
set value = jsonb_set(value, '{templates_enabled,crosssell}', 'true'::jsonb, true),
    updated_at = now()
where key = 'automation_config';
