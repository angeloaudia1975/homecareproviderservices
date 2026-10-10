-- ============================================================================
-- MI-1a · Part 2 of 2 — ONE-TIME RE-KEY of Strongback sales_report rows.
-- Run only after: Part 1 is installed, the dry run is reviewed, and Angelo approves.
-- Changes ONLY external_ref / order_key / line_key / line_hash on Strongback sales_report rows,
-- then ENROLS Strongback's sales_report lane (from then on only the MI-1a functions may write it).
-- No amount, commission, dealer, rep, period or row count changes — the assertions below
-- abort the whole transaction (nothing written) if any of those move.
-- ============================================================================
begin;
select set_config('hcps.ms_writer', 'mi1a', true);
-- Write freeze: no other session can insert, update or delete monthly_sales until this commits
-- (reads continue). Waits at most 10 s for a running import to finish, then stops with nothing changed.
set local lock_timeout = '10s';
lock table public.monthly_sales in share row exclusive mode;

-- Refuse if Strongback has not passed the identity audit (no semantic collisions in D8).
do $$ begin
  if exists (
    select 1 from public.monthly_sales
    where manufacturer = 'strongback-mobility' and source = 'sales_report'
      and nullif(btrim(coalesce(invoice_no,'')),'') is not null
    group by hcps_ms_order_part(invoice_no, order_date, period, customer_name)
    having count(distinct upper(btrim(customer_ref))) filter (where customer_ref is not null) > 1
        or max(order_date) - min(order_date) > 31) then
    raise exception 'MI-1a re-key refused: Strongback has invoice numbers shared by different orders (run D8)';
  end if;
end $$;

-- Keep the old keys so the re-key can be undone exactly (see rollback file).
create table if not exists public.mi1a_rekey_backup (
  sales_row_id text primary key, manufacturer text not null, old_external_ref text,
  old_order_key text, old_line_key text, old_line_hash text, backed_up_at timestamptz not null default now());
-- Same protection as the other MI-1a tables: no privileges for ordinary app users; owner + service_role only.
alter table public.mi1a_rekey_backup enable row level security;
revoke all on table public.mi1a_rekey_backup from public, anon, authenticated;
grant select, insert, update, delete on table public.mi1a_rekey_backup to service_role;
insert into public.mi1a_rekey_backup(sales_row_id, manufacturer, old_external_ref, old_order_key, old_line_key, old_line_hash)
select id::text, manufacturer, external_ref, order_key, line_key, line_hash
from public.monthly_sales where manufacturer = 'strongback-mobility' and source = 'sales_report'
on conflict (sales_row_id) do nothing;

-- Before-snapshot of everything that must not move (whole table, every manufacturer).
create temp table mi1a_before on commit drop as
select manufacturer, coalesce(source,'') src, period, coalesce(dealer_id::text,'') dealer, coalesce(rep_name,'') rep,
       count(*) n, coalesce(sum(amount),0) amt, coalesce(sum(commission),0) com
from public.monthly_sales group by 1,2,3,4,5;

-- The re-key: shared identity functions + the same ordinal rule the importer uses.
with k as (
  select id,
         hcps_ms_order_part(invoice_no, order_date, period, customer_name) k_order,
         hcps_ms_sku_part(product_code, product_name) k_sku,
         hcps_ms_line_hash(qty, amount, commission_rate, order_date) k_hash,
         qty, amount, product_name, order_date
  from public.monthly_sales where manufacturer = 'strongback-mobility' and source = 'sales_report'
), n as (
  select k.*, row_number() over (partition by k_order, k_sku
            order by qty asc nulls first, amount asc nulls first, coalesce(product_name,''), order_date nulls first, id) k_n
  from k
)
update public.monthly_sales m
set order_key    = 'strongback-mobility|' || n.k_order,
    line_key     = n.k_order || '|' || n.k_sku || '|' || n.k_n,
    line_hash    = n.k_hash,
    external_ref = 'strongback-mobility|v2|' || n.k_order || '|' || n.k_sku || '|' || n.k_n
from n where m.id = n.id;

-- Assertions. Any failure raises -> the transaction rolls back -> nothing changed.
do $$
declare v_bad int; v_unkeyed int; v_dupe int;
begin
  select count(*) into v_bad from (
    select manufacturer, coalesce(source,'') src, period, coalesce(dealer_id::text,'') dealer, coalesce(rep_name,'') rep,
           count(*) n, coalesce(sum(amount),0) amt, coalesce(sum(commission),0) com
    from public.monthly_sales group by 1,2,3,4,5) a
  full join mi1a_before b using (manufacturer, src, period, dealer, rep)
  where a.n is distinct from b.n or a.amt is distinct from b.amt or a.com is distinct from b.com;
  if v_bad > 0 then raise exception 'MI-1a re-key aborted: % total group(s) changed', v_bad; end if;

  select count(*) into v_unkeyed from public.monthly_sales
  where manufacturer = 'strongback-mobility' and source = 'sales_report'
    and (order_key is null or line_key is null or line_hash is null or external_ref not like 'strongback-mobility|v2|%');
  if v_unkeyed > 0 then raise exception 'MI-1a re-key aborted: % row(s) not keyed', v_unkeyed; end if;

  select count(*) into v_dupe from (select manufacturer, external_ref from public.monthly_sales
    where external_ref is not null group by 1,2 having count(*) > 1) d;
  if v_dupe > 0 then raise exception 'MI-1a re-key aborted: % duplicate key(s)', v_dupe; end if;

  if (select count(*) from public.mi1a_rekey_backup where manufacturer = 'strongback-mobility')
     <> (select count(*) from public.monthly_sales where manufacturer = 'strongback-mobility' and source = 'sales_report') then
    raise exception 'MI-1a re-key aborted: backup row count does not match';
  end if;
end $$;

-- Enrol Strongback's sales-report lane: the new identity applies, the write guard protects it.
insert into public.mi1a_enrollment(manufacturer, lane, enrolled_by, audit_note)
values ('strongback-mobility', 'sales_report', 'angelo', 'identity audit D1-D8 passed; re-keyed')
on conflict (manufacturer, lane) do nothing;

commit;

-- After commit: expect 143 rows / $43,021.50 unchanged.
select count(*) as rows, sum(amount) as sales, sum(commission) as commission,
       count(*) filter (where external_ref like 'strongback-mobility|v2|%') as rekeyed
from public.monthly_sales where manufacturer = 'strongback-mobility' and source = 'sales_report';
