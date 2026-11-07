-- HCPS — propagate_org_account_numbers() v2 (owner directive 2026-11-06 20:55 CT, §3: imports and syncs never grant ordering)
-- The v1 function (propagate_org_account_numbers.sql) inserted branch rows with active = true and set active = true on
-- conflict, so filling an organization's account number into a branch also turned ordering on. v2 fills the NUMBER only:
--   · an existing row keeps its `active` exactly as Dealer Manager set it;
--   · a branch with no row for the line gets one with active = false (ordering stays off until Dealer Manager).
-- No code calls this function any more (zoho-api fills blanks itself with _accountorg.propagateAccountRef); v2 removes the
-- latent grant in case anything calls it later. Same name, same signature, same privileges (CREATE OR REPLACE keeps grants).
-- Rollback: re-run supabase/propagate_org_account_numbers.sql (restores v1 — not recommended).
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
    select f.dealer_id, o.manufacturer, o.org_ref, false
    from fam f
    join org o on o.root = f.root
    left join dealer_manufacturers dm
           on dm.dealer_id = f.dealer_id and dm.manufacturer = o.manufacturer
    where o.org_ref is not null
      and (dm.dealer_id is null or nullif(trim(dm.account_ref), '') is null)
    on conflict (dealer_id, manufacturer)
      do update set account_ref = excluded.account_ref          -- the number only; `active` is never touched
    returning 1
  )
  select count(*) into filled from ins;
  return filled;
end
$$;

-- check: the installed body no longer sets active = true
select position('active = true' in pg_get_functiondef('public.propagate_org_account_numbers()'::regprocedure)) = 0 as no_longer_grants;
