-- AirAvant/BongoRx duplicate correction — ROLLBACK. Puts the archived PDF sales-report row back exactly
-- (same id, every column) and removes its archive entry, in one transaction.
begin;
do $$ begin
  if exists (select 1 from public.monthly_sales where id = 'b09d0e04-232e-4fd1-bb38-14235ad58a91') then
    raise exception 'The row is already present — nothing to roll back';
  end if;
  if not exists (select 1 from public.monthly_sales_superseded where sales_row_id = 'b09d0e04-232e-4fd1-bb38-14235ad58a91' and reason = 'duplicate_removed') then
    raise exception 'No archived copy found — nothing to roll back';
  end if;
end $$;
insert into public.monthly_sales
select r.* from public.monthly_sales_superseded s, jsonb_populate_record(null::public.monthly_sales, s.row_data) r
where s.sales_row_id = 'b09d0e04-232e-4fd1-bb38-14235ad58a91' and s.reason = 'duplicate_removed';
delete from public.monthly_sales_superseded where sales_row_id = 'b09d0e04-232e-4fd1-bb38-14235ad58a91' and reason = 'duplicate_removed';
commit;
