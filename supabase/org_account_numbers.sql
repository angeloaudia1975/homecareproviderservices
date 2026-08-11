-- ============================================================================
-- Make manufacturer account numbers ORGANIZATION-level (backfill for existing data).
--
-- For every dealer family (root = coalesce(parent_id, id)) and every manufacturer
-- that already has an account number somewhere in the family, fill that number
-- into the branches that have NONE yet -- preferring the parent/root's number as
-- the organization's primary. Branches that already hold their own (possibly
-- different) number are NEVER overwritten -- e.g. a "Med Mart KY" location keeps
-- its own distinct Access4U account, while blank Med Mart branches inherit the
-- shared "Queen City Med Mart" number from Med Mart HQ.
--
-- Going forward the app does this automatically (manual save, add-branch, and the
-- commission importer). Run this once to bring already-loaded dealers into line.
-- Safe & idempotent. Run in the Supabase SQL editor.
-- ============================================================================
with fam as (
  select d.id as dealer_id, coalesce(d.parent_id, d.id) as root
  from dealers d
),
org as (
  -- The organization's primary number per (family, manufacturer): the root's own
  -- number if it has one, otherwise any one number present in the family.
  select f.root,
         dm.manufacturer,
         coalesce(
           max(nullif(trim(dm.account_ref), '')) filter (where dm.dealer_id = f.root),
           min(nullif(trim(dm.account_ref), ''))
         ) as org_ref
  from fam f
  join dealer_manufacturers dm on dm.dealer_id = f.dealer_id
  where nullif(trim(dm.account_ref), '') is not null
  group by f.root, dm.manufacturer
)
insert into dealer_manufacturers (dealer_id, manufacturer, account_ref, active)
select f.dealer_id, o.manufacturer, o.org_ref, true
from fam f
join org o on o.root = f.root
left join dealer_manufacturers dm
       on dm.dealer_id = f.dealer_id and dm.manufacturer = o.manufacturer
where o.org_ref is not null
  and (dm.dealer_id is null or nullif(trim(dm.account_ref), '') is null)  -- blanks only
on conflict (dealer_id, manufacturer)
  do update set account_ref = excluded.account_ref, active = true;

-- Verify (optional): every branch of a group shows the shared number, except any
-- branch that carries its own distinct one.
-- select coalesce(d.parent_id, d.id) as root, d.business_name, dm.manufacturer, dm.account_ref
-- from dealers d
-- join dealer_manufacturers dm on dm.dealer_id = d.id
-- where nullif(trim(dm.account_ref), '') is not null
-- order by root, dm.manufacturer, d.business_name;
