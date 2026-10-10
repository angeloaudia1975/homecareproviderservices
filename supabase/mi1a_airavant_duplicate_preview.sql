-- ============================================================================
-- AirAvant/BongoRx June 2026 duplicate — PREVIEW ONLY (SELECT). Changes nothing.
-- The same sale (Williams Bros. Healthcare Pharmacy, BNG500 × 10, $1,290.00 sales, $193.50 commission)
-- is held twice: once from the official Excel commission statement, once from the PDF sales report.
-- Angelo's decision (10 Oct 2026): keep the Excel statement row as the financial authority;
-- archive the PDF sales-report row with its evidence. Correction NOT yet approved.
-- ============================================================================

-- P1. The two rows, side by side (exact ids).
select id, source, period, order_date, invoice_no, product_code, item_no, qty, amount, commission, commission_rate,
       customer_name, customer_ref, dealer_id, rep_name, channel, line_type, source_file, external_ref, imported_at
from monthly_sales
where id in ('f6b9b070-e8fb-4cd5-9144-6d7fa9fa42f5',   -- KEEP: commission statement (Excel)
             'b09d0e04-232e-4fd1-bb38-14235ad58a91')   -- ARCHIVE: sales report (PDF)
order by source;

-- P2. Before → after totals the correction would produce (nothing is changed by this query).
with t as (
  select 'airavant-bongorx all months' as scope, count(*) n, sum(amount) amt, sum(commission) com,
         count(*) filter (where id <> 'b09d0e04-232e-4fd1-bb38-14235ad58a91') n2,
         sum(amount) filter (where id <> 'b09d0e04-232e-4fd1-bb38-14235ad58a91') amt2,
         sum(commission) filter (where id <> 'b09d0e04-232e-4fd1-bb38-14235ad58a91') com2
  from monthly_sales where manufacturer = 'airavant-bongorx'
  union all
  select 'airavant-bongorx 2026-06', count(*), sum(amount), sum(commission),
         count(*) filter (where id <> 'b09d0e04-232e-4fd1-bb38-14235ad58a91'),
         sum(amount) filter (where id <> 'b09d0e04-232e-4fd1-bb38-14235ad58a91'),
         sum(commission) filter (where id <> 'b09d0e04-232e-4fd1-bb38-14235ad58a91')
  from monthly_sales where manufacturer = 'airavant-bongorx' and period = '2026-06-01'
  union all
  select 'Williams Brothers Washington HQ, all lines', count(*), sum(amount), sum(commission),
         count(*) filter (where id <> 'b09d0e04-232e-4fd1-bb38-14235ad58a91'),
         sum(amount) filter (where id <> 'b09d0e04-232e-4fd1-bb38-14235ad58a91'),
         sum(commission) filter (where id <> 'b09d0e04-232e-4fd1-bb38-14235ad58a91')
  from monthly_sales where dealer_id = '86baecc2-448f-4759-988d-bdc01c5123e6'
)
select scope, n as rows_before, amt as sales_before, com as commission_before,
       n2 as rows_after, amt2 as sales_after, com2 as commission_after from t;
