-- HCPS — propagate_org_account_numbers_v2() (owner directive 2026-11-06 20:55 CT, §3: imports and syncs never grant ordering)
-- v1 (propagate_org_account_numbers.sql) inserted branch rows with active = true and set active = true on conflict, so filling
-- an organization's account number into a branch also turned ordering on — and as a SECURITY DEFINER function with no REVOKE
-- it may be callable with the public key. This file:
--   1. creates propagate_org_account_numbers_v2(): fills branch BLANK numbers only; an existing row keeps `active` exactly as
--      Dealer Manager set it; a branch with no row for the line gets one with active = false;
--   2. makes v2 callable by the server (service_role) only;
--   3. closes v1 to everyone but the owner (no code calls it any more — zoho-api calls v2).
-- RULE 19: execute revoked from public, anon, authenticated. Additive; rollback: drop function propagate_org_account_numbers_v2();
-- and re-grant v1 to the roles it had (note them from the read-only check before running).
create or replace function public.propagate_org_account_numbers_v2()
  returns integer
  language plpgsql
  security definer
  set search_path = public, pg_temp
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

revoke all on function public.propagate_org_account_numbers_v2() from public, anon, authenticated;
grant execute on function public.propagate_org_account_numbers_v2() to service_role;
revoke all on function public.propagate_org_account_numbers() from public, anon, authenticated, service_role;

-- check (one row, all true)
select
  position('active = true' in pg_get_functiondef('public.propagate_org_account_numbers_v2()'::regprocedure)) = 0 as v2_never_grants,
  has_function_privilege('service_role', 'public.propagate_org_account_numbers_v2()', 'execute')            as v2_server_can_run,
  not has_function_privilege('anon', 'public.propagate_org_account_numbers_v2()', 'execute')                as v2_closed_to_public_key,
  not has_function_privilege('anon', 'public.propagate_org_account_numbers()', 'execute')                   as v1_closed_to_public_key,
  not has_function_privilege('authenticated', 'public.propagate_org_account_numbers()', 'execute')          as v1_closed_to_signed_in;
