-- ============================================================================
-- HCPS — propagate_org_account_numbers()
-- Wraps the org-level account-number fill (from org_account_numbers.sql) in a
-- callable function so the Zoho reverse-sync can run it after each pull.
--
-- For every dealer family (root = coalesce(parent_id, id)) and manufacturer, it
-- takes the organization's number (the root's own if present, else any one in the
-- family) and fills it into the branches that still have NONE. A branch that
-- carries its own distinct number is never overwritten. Returns the number of
-- (dealer, line) rows it filled. Idempotent & safe to re-run.
--
-- Run this ONCE in the Supabase SQL editor to create the function. After that the
-- "Pull account #s" button in the admin Zoho sync calls it automatically.
-- ============================================================================
create or replace function propagate_org_account_numbers()
  returns integer
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  filled integer;
begin
  with fam as (
    select d.id as dealer_id, coalesce(d.parent_id, d.id) as root
    from dealers d
  ),
  org as (
    select f.root, dm.manufacturer,
           coalesce(
             max(nullif(trim(dm.account_ref), '')) filter (where dm.dealer_id = f.root),
             min(nullif(trim(dm.account_ref), ''))
           ) as org_ref
    from fam f
    join dealer_manufacturers dm on dm.dealer_id = f.dealer_id
    where nullif(trim(dm.account_ref), '') is not null
    group by f.root, dm.manufacturer
  ),
  ins as (
    insert into dealer_manufacturers (dealer_id, manufacturer, account_ref, active)
    select f.dealer_id, o.manufacturer, o.org_ref, true
    from fam f
    join org o on o.root = f.root
    left join dealer_manufacturers dm
           on dm.dealer_id = f.dealer_id and dm.manufacturer = o.manufacturer
    where o.org_ref is not null
      and (dm.dealer_id is null or nullif(trim(dm.account_ref), '') is null)
    on conflict (dealer_id, manufacturer)
      do update set account_ref = excluded.account_ref, active = true
    returning 1
  )
  select count(*) into filled from ins;
  return filled;
end
$$;
