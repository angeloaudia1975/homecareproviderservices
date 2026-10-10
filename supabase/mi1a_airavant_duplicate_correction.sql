-- ============================================================================
-- AirAvant/BongoRx June 2026 duplicate — CORRECTION. DO NOT RUN until Angelo approves it.
-- Requires MI-1a Part 1 (monthly_sales_superseded). Archives the PDF sales-report row whole,
-- then removes it from monthly_sales, in one transaction. The Excel statement row is untouched.
-- Expected: AirAvant 3 → 2 rows, $4,960.00 → $3,670.00 sales, $744.00 → $550.50 commission.
-- ============================================================================
begin;
do $$
declare v_keep record; v_drop record;
begin
  if to_regclass('public.monthly_sales_superseded') is null then
    raise exception 'Install MI-1a Part 1 first (monthly_sales_superseded is needed to keep the evidence)';
  end if;
  select * into v_keep from public.monthly_sales where id = 'f6b9b070-e8fb-4cd5-9144-6d7fa9fa42f5';
  select * into v_drop from public.monthly_sales where id = 'b09d0e04-232e-4fd1-bb38-14235ad58a91';
  -- Refuse unless both rows are still exactly what was reviewed.
  if v_keep.id is null or v_keep.source <> 'commission' or v_keep.amount <> 1290 or v_keep.commission <> 193.50
     or v_keep.manufacturer <> 'airavant-bongorx' or v_keep.period <> '2026-06-01' then
    raise exception 'Statement row is missing or has changed since review — nothing done';
  end if;
  if v_drop.id is null or v_drop.source <> 'sales_report' or v_drop.amount <> 1290 or v_drop.commission <> 193.50
     or v_drop.manufacturer <> 'airavant-bongorx' or v_drop.period <> '2026-06-01'
     or v_drop.dealer_id is distinct from v_keep.dealer_id or v_drop.qty is distinct from v_keep.qty then
    raise exception 'Sales-report row is missing or no longer matches the statement row — nothing done';
  end if;
  if (select count(*) from public.monthly_sales where manufacturer = 'airavant-bongorx') <> 3
     or (select sum(commission) from public.monthly_sales where manufacturer = 'airavant-bongorx') <> 744.00 then
    raise exception 'AirAvant totals changed since review — re-run the preview first';
  end if;
end $$;
insert into public.monthly_sales_superseded(sales_row_id, manufacturer, period, order_key, reason, actor, row_data)
select id::text, manufacturer, period, null, 'duplicate_removed', 'angelo', to_jsonb(m) || jsonb_build_object(
         'mi1a_note', 'Same sale as statement row f6b9b070-e8fb-4cd5-9144-6d7fa9fa42f5 (BongoRx_Commission_Report_June_2026.xlsx); statement kept as financial authority, approved by Angelo')
from public.monthly_sales m where id = 'b09d0e04-232e-4fd1-bb38-14235ad58a91';
delete from public.monthly_sales where id = 'b09d0e04-232e-4fd1-bb38-14235ad58a91';
do $$ begin
  if (select count(*) from public.monthly_sales where manufacturer = 'airavant-bongorx') <> 2
     or (select sum(amount) from public.monthly_sales where manufacturer = 'airavant-bongorx') <> 3670.00
     or (select sum(commission) from public.monthly_sales where manufacturer = 'airavant-bongorx') <> 550.50 then
    raise exception 'Correction did not produce the reviewed totals — rolled back';
  end if;
end $$;
commit;
