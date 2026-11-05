-- ============================================================================
-- Yuwell — ACTIVATION for real dealers. DRAFT — NOT RUN; each part needs Angelo's approval.
-- Owner (C3-05, 2026-11-04): Yuwell is available to ALL authorized HCPS dealers with Partner 360 ordering access,
-- across all territories HCPS represents, with no further geographic or dealer-specific restriction.
--
-- "Authorized ordering dealer" = the platform's own definition of who can order: an active, non-TEST dealer
-- (account class blank or "dealer") that already holds at least one ACTIVE ordering line in its access grid
-- (dealer_manufacturers) other than Golden (ordered on Golden's own portal) and the retired lines.
-- Nothing geographic is added. Dealers with no ordering line are NOT granted: they cannot order today, and a
-- single Yuwell row would turn their territory default into "Yuwell only".
-- Run PART 1 (read-only) first and send the numbers back; PART 2 only after approval.
-- ============================================================================

-- PART 1 — read-only: who would get Yuwell, and every group that would not (with the reason)
with base as (
  select d.id, d.business_name, upper(coalesce(d.state,'')) st, coalesce(d.active,true) act, coalesce(d.is_test,false) tst,
         coalesce(d.account_class,'') cls,
         exists (select 1 from dealer_manufacturers x where x.dealer_id = d.id and x.active
                   and x.manufacturer not in ('golden','golden-technologies','ohio-medical','gce','complete-medical-supplies','yuwell')) as orders_hcps,
         exists (select 1 from dealer_manufacturers x where x.dealer_id = d.id and x.active and x.manufacturer in ('golden','golden-technologies')) as golden,
         exists (select 1 from dealer_manufacturers x where x.dealer_id = d.id and x.manufacturer = 'yuwell' and x.active) as has_yuwell
  from dealers d)
select case
         when tst then 'excluded: TEST dealer (preview only)'
         when not act then 'excluded: inactive dealer'
         when cls not in ('', 'dealer') then 'excluded: account class ' || cls
         when orders_hcps then 'ELIGIBLE: authorized ordering dealer'
         when golden then 'excluded: Golden-only (no HCPS ordering line)'
         else 'excluded: no ordering access'
       end as verdict,
       count(*) as dealers, count(*) filter (where has_yuwell) as already_have_yuwell,
       string_agg(distinct st, ',' order by st) as states
from base group by 1 order by 1;

-- PART 2 — the grant, with its own proof (run only after PART 1 is approved). Uncomment to use.
-- begin;
-- do $a$
-- declare missing int; extra int;
-- begin
--   insert into dealer_manufacturers (dealer_id, manufacturer, active)
--   select d.id, 'yuwell', true from dealers d
--    where coalesce(d.active,true) and coalesce(d.is_test,false) = false and coalesce(d.account_class,'') in ('','dealer')
--      and exists (select 1 from dealer_manufacturers x where x.dealer_id = d.id and x.active
--                    and x.manufacturer not in ('golden','golden-technologies','ohio-medical','gce','complete-medical-supplies','yuwell'))
--   on conflict (dealer_id, manufacturer) do update set active = true;
--   -- every eligible dealer has Yuwell
--   select count(*) into missing from dealers d
--    where coalesce(d.active,true) and coalesce(d.is_test,false) = false and coalesce(d.account_class,'') in ('','dealer')
--      and exists (select 1 from dealer_manufacturers x where x.dealer_id = d.id and x.active
--                    and x.manufacturer not in ('golden','golden-technologies','ohio-medical','gce','complete-medical-supplies','yuwell'))
--      and not exists (select 1 from dealer_manufacturers y where y.dealer_id = d.id and y.manufacturer = 'yuwell' and y.active);
--   -- no one else has it (the designated TEST dealer is the only allowed exception)
--   select count(*) into extra from dealer_manufacturers y join dealers d on d.id = y.dealer_id
--    where y.manufacturer = 'yuwell' and y.active and d.id <> '3f7d87a2-7fbc-47e1-a34a-aaaacf4c4c7b'
--      and not (coalesce(d.active,true) and coalesce(d.is_test,false) = false and coalesce(d.account_class,'') in ('','dealer')
--               and exists (select 1 from dealer_manufacturers x where x.dealer_id = d.id and x.active
--                             and x.manufacturer not in ('golden','golden-technologies','ohio-medical','gce','complete-medical-supplies','yuwell')));
--   if missing <> 0 or extra <> 0 then
--     raise exception 'verification failed: % eligible without Yuwell, % ineligible with Yuwell — rolled back', missing, extra; end if;
-- end $a$;
-- commit;
