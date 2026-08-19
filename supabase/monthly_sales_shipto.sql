-- ============================================================================
-- Branch-aware commission imports (GCE / Ohio Medical and any line with ship-to data).
-- Reports carry a ship-to consignee name and street address per order line. We store them so
-- Review & Correct can show Corporate → Branch/Location → Ship-To → Order, match a sale to the
-- actual branch by address (not just ZIP), and surface never-seen branch locations for creation.
-- Run once in the Supabase SQL editor. Safe to re-run.
-- ============================================================================
alter table monthly_sales add column if not exists ship_name    text;   -- ship-to consignee (branch or patient)
alter table monthly_sales add column if not exists ship_address text;   -- ship-to street address
