-- ============================================================================
-- ABM Respiratory Care — create the Indiana territory accounts.
--
-- Two dealer organizations, each identified by ONE shared ABM customer number
-- across all of its Indiana branches (same family/branch model as Access4U):
--
--   Lincare        (CUS00079) — Bloomington, Columbus, New Albany, Madison, Vincennes
--   Adapt Health   (CUS00023) — Clarksville, Evansville
--
-- This script (all steps idempotent — safe to re-run):
--   1) creates an HQ dealer per organization (rollup parent, no address so it
--      never captures a branch's shipment),
--   2) creates each branch as a child dealer (parent_id) with its own address/ZIP,
--   3) stamps the shared ABM account_ref on the whole family, so the Sales Report
--      Import resolves every line to the right branch by shipping ZIP,
--   4) assigns Angelo Audia as the rep for the whole family (dealer_directory), so
--      imported sales are attributed to him automatically,
--   5) seeds each branch's primary address row (map pin).
--
-- PREREQUISITE: run supabase/abm_manufacturer_add.sql first (registers the
-- 'abm-respiratory-care' manufacturer). Run this in the Supabase SQL editor.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) HQ / rollup parents (no address -> never picked as a branch for a shipment)
-- ---------------------------------------------------------------------------
insert into dealers (business_name, state, active, status)
select 'Lincare', 'IN', true, null
where not exists (select 1 from dealers where business_name = 'Lincare' and parent_id is null);

insert into dealers (business_name, state, active, status)
select 'Adapt Health', 'IN', true, null
where not exists (select 1 from dealers where business_name = 'Adapt Health' and parent_id is null);

-- ---------------------------------------------------------------------------
-- 2) Branch locations (child dealers) — Lincare
-- ---------------------------------------------------------------------------
insert into dealers (business_name, parent_id, address, city, state, zip, phone, active)
select v.bn,
       (select id from dealers where business_name = 'Lincare' and parent_id is null limit 1),
       v.addr, v.city, 'IN', v.zip, v.phone, true
from (values
  ('Lincare Bloomington IN', '2160 S Yost Ave',    'Bloomington', '47403', '8123395579'),
  ('Lincare Columbus IN',    '1428 10th St',       'Columbus',    '47201', '8123784050'),
  ('Lincare New Albany',     '2618 Charlestown Rd','New Albany',  '47150', '8125421365'),
  ('Lincare Madison IN',     '2587 Cragmont St',   'Madison',     '47250', '8122654377'),
  ('Lincare Vincennes IN',   '1128 S 15th St',     'Vincennes',   '47591', '8128860367')
) as v(bn, addr, city, zip, phone)
where not exists (select 1 from dealers d where d.business_name = v.bn);

-- ---------------------------------------------------------------------------
-- 2b) Branch locations — Adapt Health
-- ---------------------------------------------------------------------------
insert into dealers (business_name, parent_id, address, city, state, zip, phone, active)
select v.bn,
       (select id from dealers where business_name = 'Adapt Health' and parent_id is null limit 1),
       v.addr, v.city, 'IN', v.zip, v.phone, true
from (values
  ('Adapt Health Clarksville IN', '1503 Lynch Ln',      'Clarksville', '47129', '8122825200'),
  ('Adapt Health Evansville IN',  '705 E. Sycamore St', 'Evansville',  '47713', null)
) as v(bn, addr, city, zip, phone)
where not exists (select 1 from dealers d where d.business_name = v.bn);

-- ---------------------------------------------------------------------------
-- 3) Shared ABM account numbers on each whole family (HQ + all branches).
--    The importer matches a report line to the family by this account_ref, then
--    picks the branch by shipping ZIP.
-- ---------------------------------------------------------------------------
insert into dealer_manufacturers (dealer_id, manufacturer, account_ref, active)
select d.id, 'abm-respiratory-care', 'CUS00079', true
from dealers d
where d.business_name = 'Lincare'
   or d.parent_id = (select id from dealers where business_name = 'Lincare' and parent_id is null limit 1)
on conflict (dealer_id, manufacturer) do update
  set account_ref = excluded.account_ref, active = true;

insert into dealer_manufacturers (dealer_id, manufacturer, account_ref, active)
select d.id, 'abm-respiratory-care', 'CUS00023', true
from dealers d
where d.business_name = 'Adapt Health'
   or d.parent_id = (select id from dealers where business_name = 'Adapt Health' and parent_id is null limit 1)
on conflict (dealer_id, manufacturer) do update
  set account_ref = excluded.account_ref, active = true;

-- ---------------------------------------------------------------------------
-- 4) Rep assignment (dealer_directory) — Angelo Audia for the whole territory.
--    The importer stamps monthly_sales.rep_name from this at commit time.
-- ---------------------------------------------------------------------------
insert into dealer_directory (dealer_name, rep_name)
select v.nm, 'Angelo Audia'
from (values
  ('Lincare'),
  ('Lincare Bloomington IN'), ('Lincare Columbus IN'), ('Lincare New Albany'),
  ('Lincare Madison IN'), ('Lincare Vincennes IN'),
  ('Adapt Health'),
  ('Adapt Health Clarksville IN'), ('Adapt Health Evansville IN'),
  -- the report spells this branch "Evensville"; map that raw name to Angelo too, harmless.
  ('Adapt Health Evensville IN')
) as v(nm)
where not exists (
  select 1 from dealer_directory dd
  where lower(btrim(dd.dealer_name)) = lower(btrim(v.nm))
);

-- ---------------------------------------------------------------------------
-- 5) Seed each branch's primary address row (for the map pin), mirroring what the
--    Dealer 360 "create dealer" flow does. Guarded so re-runs don't duplicate.
-- ---------------------------------------------------------------------------
insert into dealer_addresses (dealer_id, addr_key, label, pri, address, city, state, zip)
select d.id,
       coalesce(nullif(left(regexp_replace(lower(d.address), '[^a-z0-9]+', '', 'g'), 120), ''), 'primary'),
       'Primary', 3, d.address, d.city, d.state, d.zip
from dealers d
where d.address is not null
  and (d.business_name like 'Lincare %' or d.business_name like 'Adapt Health %')
  and not exists (
    select 1 from dealer_addresses a
    where a.dealer_id = d.id
      and a.address is not distinct from d.address
  );

-- ---- Verify (optional) -----------------------------------------------------
-- select d.business_name, dm.account_ref, dd.rep_name
--   from dealers d
--   left join dealer_manufacturers dm on dm.dealer_id = d.id and dm.manufacturer='abm-respiratory-care'
--   left join dealer_directory dd on lower(btrim(dd.dealer_name)) = lower(btrim(d.business_name))
--  where d.business_name in ('Lincare','Adapt Health')
--     or d.parent_id in (select id from dealers where business_name in ('Lincare','Adapt Health') and parent_id is null)
--  order by d.business_name;
