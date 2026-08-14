-- ============================================================================
-- Manufacturer SALES-report import — make monthly_sales imports idempotent.
-- Adds a `source` tag (so sales-report rows are distinguishable from commission
-- imports) and an `external_ref` natural key (manufacturer|order|sku|line) with a
-- unique index, so re-importing the same report updates rows instead of
-- duplicating them. Run once in the Supabase SQL editor. Safe to re-run.
--
-- NOTE: the index must be a FULL unique index (not partial) — PostgREST's
-- on_conflict can only infer a full unique index as the conflict target. Rows with
-- a NULL external_ref (e.g. commission-report imports) are unaffected: NULLs are
-- distinct in a unique index, so any number of them coexist.
-- ============================================================================
alter table monthly_sales add column if not exists source       text;   -- 'sales_report' | 'commission' | ...
alter table monthly_sales add column if not exists external_ref text;   -- stable per imported line

-- Replace any earlier PARTIAL index of this name with a full unique index.
drop index if exists monthly_sales_extref_uniq;
create unique index if not exists monthly_sales_extref_uniq
  on monthly_sales(manufacturer, external_ref);
