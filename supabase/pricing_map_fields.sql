-- ============================================================================
-- HCPS Partner 360 — pricing audit fields (MAP + derived-MSRP flag)
--
-- The pricing model per catalog code:
--   base_price  — the DEALER price (what the dealer pays). The anchor; required.
--   msrp        — manufacturer suggested retail, when the manufacturer publishes one.
--   map         — Minimum Advertised Price, when the manufacturer enforces one (NEW).
--   msrp_auto   — true when MSRP was DERIVED from the dealer price (base_price × markup)
--                 because the manufacturer didn't publish one, so the audit can show it as
--                 "auto" vs a real manufacturer MSRP (NEW).
--
-- Base-catalog products (from data/<slug>.json) carry map/msrp_auto inside their
-- product_overrides.patch JSON, which needs no schema change — only custom_products
-- gets real columns. Safe to run more than once. Shared Supabase project.
-- ============================================================================

alter table public.custom_products add column if not exists map       numeric;
alter table public.custom_products add column if not exists msrp_auto boolean default false;
