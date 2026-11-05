-- ============================================================================
-- Yuwell — ACTIVATION for real dealers. DRAFT — NOT RUN; each part needs Angelo's approval.
-- Owner (C3-05, 2026-11-04): Yuwell is available to ALL authorized HCPS dealers with Partner 360 ordering access,
-- across all territories HCPS represents, with no further geographic or dealer-specific restriction.
--
-- Access to Yuwell comes ONLY from a dealer_manufacturers row written here (Yuwell is NOT a territory default in
-- _access.js — review 2026-11-04), so this file decides exactly who can order it.
-- "Authorized ordering dealer" = an active, non-TEST dealer (account class blank or "dealer", status not prospect /
-- closed / inactive / dormant) that already holds at least one ACTIVE ordering line in its access grid other than
-- Golden (ordered on Golden's own portal), the retired lines, BongoRx's old 'bongo' slug and Yuwell. The line's slug
-- must be stored exactly as the storefront reads it (lower case, no spaces): a row like ' PediFix ' gives no access
-- today, so it is reported apart ("grant slug needs cleanup") and never counts. A branch is judged on its own rows.
-- Run PART 1 (read-only) first and send the numbers back; PART 2 only after approval.
-- ============================================================================

-- PART 1 — read-only: who would get Yuwell, and every group that would not (with the reason)
with base as (
  select d.id, upper(coalesce(d.state,'')) st, coalesce(d.active,true) act, coalesce(d.is_test,false) tst,
         lower(trim(coalesce(d.account_class,''))) cls, lower(trim(coalesce(d.status,''))) sts,
         exists (select 1 from dealer_manufacturers x where x.dealer_id = d.id and x.active
                   and x.manufacturer = lower(trim(x.manufacturer)) and x.manufacturer not in ('golden','golden-technologies','ohio-medical','gce','complete-medical-supplies','yuwell','bongo')) as orders_hcps,
         exists (select 1 from dealer_manufacturers x where x.dealer_id = d.id and x.active
                   and x.manufacturer <> lower(trim(x.manufacturer))) as messy_slug,
         exists (select 1 from dealer_manufacturers x where x.dealer_id = d.id and x.active and lower(trim(x.manufacturer)) in ('golden','golden-technologies')) as golden,
         exists (select 1 from dealer_manufacturers x where x.dealer_id = d.id and x.active and lower(trim(x.manufacturer)) = 'yuwell') as has_yuwell
  from dealers d)
select case
         when tst then 'excluded: TEST dealer (preview only)'
         when not act then 'excluded: inactive dealer'
         when cls not in ('', 'dealer') then 'excluded: account class ' || cls
         when sts in ('prospect','closed','inactive','dormant') then 'excluded: dealer status ' || sts
         when orders_hcps then 'ELIGIBLE: authorized ordering dealer'
         when messy_slug then 'excluded: grant slug needs cleanup (no working ordering line)'
         when golden then 'excluded: Golden-only (no HCPS ordering line)'
         else 'excluded: no ordering access'
       end as verdict,
       count(*) as dealers, count(*) filter (where has_yuwell) as already_have_yuwell,
       string_agg(distinct st, ',' order by st) as states
from base group by 1 order by 1;

-- PART 2 — the grant, with its own proof (run only after PART 1 is approved). Uncomment to use.
-- begin;
-- do $a$
-- declare missing int; extra int; odd int;
-- begin
--   create temp table yw_eligible on commit drop as
--   select d.id from dealers d
--    where coalesce(d.active,true) and coalesce(d.is_test,false) = false
--      and lower(trim(coalesce(d.account_class,''))) in ('','dealer')
--      and lower(trim(coalesce(d.status,''))) not in ('prospect','closed','inactive','dormant')
--      and exists (select 1 from dealer_manufacturers x where x.dealer_id = d.id and x.active
--                    and x.manufacturer = lower(trim(x.manufacturer)) and x.manufacturer not in ('golden','golden-technologies','ohio-medical','gce','complete-medical-supplies','yuwell','bongo'));
--   -- a Yuwell row spelled any other way would hide from the checks below: refuse to guess
--   select count(*) into odd from dealer_manufacturers where lower(trim(manufacturer)) = 'yuwell' and manufacturer <> 'yuwell';
--   if odd <> 0 then raise exception '% Yuwell row(s) with an odd spelling — fix them first, nothing written', odd; end if;
--   insert into dealer_manufacturers (dealer_id, manufacturer, active)
--   select id, 'yuwell', true from yw_eligible
--   on conflict (dealer_id, manufacturer) do update set active = true;
--   -- every eligible dealer has Yuwell
--   select count(*) into missing from yw_eligible e
--    where not exists (select 1 from dealer_manufacturers y where y.dealer_id = e.id and lower(trim(y.manufacturer)) = 'yuwell' and y.active);
--   -- no one else has it (the designated TEST dealer is the only allowed exception)
--   select count(*) into extra from dealer_manufacturers y
--    where lower(trim(y.manufacturer)) = 'yuwell' and y.active and y.dealer_id <> '3f7d87a2-7fbc-47e1-a34a-aaaacf4c4c7b'
--      and y.dealer_id not in (select id from yw_eligible);
--   if missing <> 0 or extra <> 0 then
--     raise exception 'verification failed: % eligible without Yuwell, % ineligible with Yuwell — rolled back', missing, extra; end if;
-- end $a$;
-- commit;
