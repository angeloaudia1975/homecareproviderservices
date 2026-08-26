-- ============================================================================
-- OPTIONAL hygiene — tag legacy commission rows with source='commission'.
--
-- The commission importer now stamps source='commission' on new rows (the sales
-- importer stamps 'sales_report'). Rows loaded before that tag existed have a NULL
-- source; they came from the commission lane, so set them explicitly.
--
-- NOT required for the Commission Report Import coverage grid — that already counts
-- a month whenever it has commission data from either importer. This is only for
-- clean, explicit lane tags. Idempotent; safe to re-run.
-- ============================================================================
update monthly_sales
   set source = 'commission'
 where source is null;

-- Verify (optional): counts by lane
-- select coalesce(source,'(null)') as source, count(*) from monthly_sales group by 1 order by 2 desc;
