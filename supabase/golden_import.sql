-- ============================================================================
-- Golden Technologies commission-import enrichment.
-- Adds the columns the rebuilt importer writes: true order dates, the physical
-- vs. drop-ship channel, the configured SKU, credit detail, ship-to ZIP, and the
-- per-line commission rate. All additive & idempotent — safe to run anytime.
-- Run this in the Supabase SQL editor BEFORE deploying the new importer code.
-- ============================================================================

alter table monthly_sales add column if not exists order_date      date;     -- SOOrderDate (when the order was placed)
alter table monthly_sales add column if not exists channel         text;     -- 'physical' (matched a branch/corporate) | 'dropship'
alter table monthly_sales add column if not exists item_no         text;     -- configured SKU / variant (Golden ItemNo)
alter table monthly_sales add column if not exists line_type       text;     -- 'I' invoice | 'C' credit
alter table monthly_sales add column if not exists credit_reason   text;     -- reason on a credit line
alter table monthly_sales add column if not exists invoice_no      text;     -- invoice / credit-memo #
alter table monthly_sales add column if not exists ship_zip        text;     -- ship-to ZIP (5-digit, leading zeros preserved)
alter table monthly_sales add column if not exists commission_rate numeric;  -- CommissionRate

create index if not exists monthly_sales_channel_idx   on monthly_sales(manufacturer, channel);
create index if not exists monthly_sales_orderdate_idx on monthly_sales(order_date);
create index if not exists monthly_sales_zip_idx       on monthly_sales(manufacturer, ship_zip);
