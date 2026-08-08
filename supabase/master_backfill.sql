-- ============================================================================
-- HCPS master-list backfill — adds the dealer website column.
-- Run once in the Supabase SQL editor BEFORE running the "Backfill master list"
-- job in the admin. Safe to re-run.
-- ============================================================================

-- Websites come from the master dealer list (the same source that populated Zoho).
-- The platform is the source of truth, so it stores them here on the dealer record.
alter table dealers add column if not exists website text;
