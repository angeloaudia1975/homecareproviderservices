-- ============================================================================
-- HCPS Order Review & Fulfillment (Phase 3) — admin-side fields on the existing
-- orders table so staff can confirm, ship (with tracking), and complete dealer orders.
-- Run once in the Supabase SQL editor. Safe to re-run.
-- ============================================================================

alter table orders add column if not exists tracking_number text;
alter table orders add column if not exists admin_notes     text;
alter table orders add column if not exists updated_at       timestamptz;
