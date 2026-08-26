-- ============================================================================
-- PediFix — READ-ONLY state check. Changes nothing. Run in the Supabase SQL
-- editor and send me the results; they tell us whether the PediFix accounts can
-- be rebuilt from data still in the database, or need re-uploading.
--
-- (Assumes the manufacturer slug is 'pedifix' — the id used on the website. If
-- these all come back empty but you know PediFix data existed, the slug may
-- differ; run the last query to list every manufacturer slug that has sales.)
-- ============================================================================

-- 1) How much PediFix sales/commission data still exists, and of what kind.
select source,
       count(*)                              as rows,
       count(distinct dealer_id)             as linked_dealers,
       count(*) filter (where dealer_id is null) as unlinked_rows,
       round(sum(amount)::numeric, 2)        as total_amount,
       min(period)                           as first_period,
       max(period)                           as last_period
from monthly_sales
where manufacturer = 'pedifix'
group by source
order by rows desc;

-- 2) The distinct account list still recoverable FROM those sales rows
--    (this is effectively the PediFix account roster, if the rows survived).
select customer_ref,
       customer_name,
       count(*)                       as lines,
       round(sum(amount)::numeric,2)  as sales,
       max(ship_state)                as state
from monthly_sales
where manufacturer = 'pedifix'
group by customer_ref, customer_name
order by sales desc nulls last;

-- 3) PediFix account numbers currently on dealer accounts (the account grid).
select count(*) as pedifix_account_rows,
       count(*) filter (where account_ref is not null and btrim(account_ref) <> '') as with_number
from dealer_manufacturers
where manufacturer = 'pedifix';

-- 4) Dealers that currently carry a PediFix line, with their number.
select d.business_name, d.city, d.state, dm.account_ref, dm.active
from dealer_manufacturers dm
join dealers d on d.id = dm.dealer_id
where dm.manufacturer = 'pedifix'
order by d.business_name;

-- 5) Safety net — if 1–4 are empty, list every manufacturer slug that HAS sales,
--    so we can confirm what slug PediFix data was stored under.
select manufacturer, count(*) as rows, round(sum(amount)::numeric,2) as total
from monthly_sales
group by manufacturer
order by rows desc;
