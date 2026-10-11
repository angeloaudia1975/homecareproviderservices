-- HCPS · READ-ONLY preview for commission_sept2026_cleanup.sql — writes nothing. Shows the 7 rows, every guard the
-- cleanup checks, and the before/after the cleanup would produce.
with q as (
  select m.* from public.monthly_sales m
  where m.id::text in ('3e58af95-bf1b-4510-a35a-dc4b3bf8f2bb','5f214540-71ab-4f29-a5f1-6247dda3192f',
                       '5ffe8cd4-fa59-48ee-88a7-5f035e158cd5','7e90d782-5cbc-42c8-a20b-0534f1338c5e',
                       '842c2dc5-b219-481e-ac0c-e7ee0bc00f5d','b01196d7-90f5-4ade-9283-e94fb493943a',
                       'c7158ea2-d2da-42ef-a0bf-24361ebdcbc3')
    and m.manufacturer = 'strongback-mobility' and m.period = date '2026-09-01' and m.source = 'commission'
    and m.source_file = 'Strongback Sept Commission Report 2026.csv'
    and m.amount is null and m.commission is null and m.billed_amount is null),
all_ms as (select count(*) n, sum(amount) sales, sum(commission) comm from public.monthly_sales)
select json_build_object(
  'guard_rows_match',        (select count(*) from q),                                                   -- must be 7
  'guard_fingerprint',       (select md5(string_agg(to_jsonb(q)::text, '|' order by q.id::text)) from q), -- must be c7b81f69…
  'guard_other_sept_lane',   (select count(*) from public.monthly_sales m where m.manufacturer='strongback-mobility'
                               and m.period=date '2026-09-01' and (m.source='commission' or (m.source is null and m.external_ref is null))
                               and m.id::text not in (select id::text from q)),                         -- must be 0
  'guard_quarantine_exists', (select count(*) from pg_class where relname='monthly_sales_quarantine'),     -- 0 before
  'rows', (select json_agg(json_build_object('id', q.id, 'customer', q.customer_name, 'product', q.product_code, 'qty', q.qty,
            'ship', concat_ws(' ', q.ship_city, q.ship_state, q.ship_zip), 'dealer', d.business_name, 'channel', q.channel,
            'amount', q.amount, 'commission', q.commission) order by q.customer_name, q.product_code)
           from q left join public.dealers d on d.id = q.dealer_id),
  'before', (select json_build_object('rows', n, 'sales', sales, 'commission', comm) from all_ms),
  'after',  (select json_build_object('rows', n - (select count(*) from q), 'sales', sales, 'commission', comm) from all_ms),
  'strongback_sept_after', (select count(*) from public.monthly_sales m where m.manufacturer='strongback-mobility'
                             and m.period=date '2026-09-01' and m.id::text not in (select id::text from q))
) as preview;
