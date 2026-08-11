-- ============================================================================
-- Access4u importer support. Access4u reports are a QuickBooks "Transaction List
-- by Client" ledger: each dealer is a group, each line is an Invoice (billed,
-- awaiting payment) or a Payment (commission earned). We store realized (payment)
-- rows as sales/commission and invoice rows as the outstanding backlog.
--   billed_amount = the invoiced order value (invoice rows only; awaiting payment)
--   memo          = the QuickBooks Memo/Description (carries the Med Mart PO drop-ship signal)
-- Additive & idempotent. Run before deploying the updated importer code.
-- ============================================================================
alter table monthly_sales add column if not exists billed_amount numeric;  -- invoice rows: value billed, not yet paid
alter table monthly_sales add column if not exists memo          text;     -- QuickBooks memo/description

create index if not exists monthly_sales_linetype_idx on monthly_sales(manufacturer, line_type);
create index if not exists monthly_sales_invno_idx     on monthly_sales(manufacturer, invoice_no);

-- NOTE: Access4u has no numeric account — the report's COMPANY NAME is the account number, shared
-- across a dealer's whole family (HQ + branches). The importer now stores that automatically on commit.
-- To backfill account numbers for reports already loaded, run supabase/access4u_accounts.sql.
