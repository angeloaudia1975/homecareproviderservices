-- ============================================================================
-- HCPS sales attribution — store the ship-to location on each commission line so
-- a multi-location dealer's orders attach to the BRANCH that received them (not
-- just the sold-to / HQ). Run once in the Supabase SQL editor before re-importing
-- the commission reports. Safe to re-run.
-- ============================================================================

alter table monthly_sales add column if not exists ship_city  text;
alter table monthly_sales add column if not exists ship_state text;
