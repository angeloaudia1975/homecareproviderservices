-- ============================================================================
-- Access4U account-number assignment (backfill for already-loaded data).
--
-- For Access4U the report's COMPANY NAME is the dealer's account number, and it is shared across the
-- whole dealer group. This assigns that name as the Access4U account_ref on every matched dealer AND
-- all of its family (HQ + branches, linked by dealers.parent_id) — so, e.g., every Med Mart location
-- carries the one shared "Queen City Med Mart" Access4U account number.
--
-- Going forward the importer does this automatically on commit; run this once to fix prior loads.
-- Idempotent & safe to re-run. Requires the branch grouping (parent_id) to reach branch records.
-- ============================================================================
with matched as (
  -- the report company name each dealer was matched under (most recent load wins)
  select distinct on (ms.dealer_id) ms.dealer_id, ms.customer_name as acct
  from monthly_sales ms
  where ms.manufacturer = 'access4u'
    and ms.dealer_id is not null
    and coalesce(ms.customer_name,'') <> ''
  order by ms.dealer_id, ms.imported_at desc
),
fam as (
  -- expand each matched dealer to its whole family: the HQ (root) and every branch under it
  select m.acct, fm.id as dealer_id
  from matched m
  join dealers d  on d.id  = m.dealer_id
  join dealers fm on coalesce(fm.parent_id, fm.id) = coalesce(d.parent_id, d.id)
)
insert into dealer_manufacturers (dealer_id, manufacturer, account_ref, active)
select distinct dealer_id, 'access4u', acct, true from fam
on conflict (dealer_id, manufacturer)
  do update set account_ref = excluded.account_ref, active = true;

-- Verify (optional):
-- select d.business_name, dm.account_ref
-- from dealer_manufacturers dm join dealers d on d.id = dm.dealer_id
-- where dm.manufacturer = 'access4u' order by dm.account_ref, d.business_name;
