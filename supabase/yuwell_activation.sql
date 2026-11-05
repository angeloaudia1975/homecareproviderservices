-- ============================================================================
-- Yuwell — ACTIVATION for real dealers. DRAFT — NOT RUN; each part needs Angelo's approval.
-- Owner (2026-11-04 22:30 CT): Yuwell is a NEW manufacturer that ALL dealers may review and shop on Partner 360,
-- with no account needed — exactly like the other new lines. It shows under "Available to you — open a new
-- account" until HCPS records the dealer's Yuwell account number after their dealer application. This file sets
-- NO account number. Ohio Medical is a different (retired) line and is not involved.
--
-- Who gets a grant row here: every active, non-TEST dealer whose account class is blank or "dealer" and that has an
-- ordering-access grid (at least one active dealer_manufacturers row other than Golden and Yuwell itself — retired lines and
-- odd-spelled slugs included, because the access engine counts them as a grid). Dealers WITHOUT a grid (none, or
-- Golden only) already see Yuwell from the territory defaults in _access.js; a grant row would turn their full
-- default line-up into "Yuwell only", so they are deliberately left alone. A branch is judged on its own rows.
-- Run PART 1 (read-only) first and send the numbers back; PART 2 only after approval.
-- ============================================================================

-- PART 1 — read-only: how every dealer will see Yuwell
with base as (
  select d.id, upper(coalesce(d.state,'')) st, coalesce(d.active,true) act, coalesce(d.is_test,false) tst,
         lower(trim(coalesce(d.account_class,''))) cls, lower(trim(coalesce(d.status,''))) sts,
         exists (select 1 from dealer_manufacturers x where x.dealer_id = d.id and x.active
                   and lower(trim(x.manufacturer)) not in ('golden','golden-technologies','yuwell')) as has_grid,
         exists (select 1 from dealer_manufacturers x where x.dealer_id = d.id and x.active and lower(trim(x.manufacturer)) = 'yuwell') as has_yuwell
  from dealers d)
select case
         when tst then 'not granted: TEST dealer (preview handled separately)'
         when not act then 'not granted: inactive dealer'
         when cls not in ('', 'dealer') then 'not granted: account class ' || cls
         when has_grid then 'GRANT ROW: dealer with an access grid'
         else 'no row needed: sees Yuwell from territory defaults (no grid / Golden only)'
       end as verdict,
       count(*) as dealers, count(*) filter (where has_yuwell) as already_have_yuwell,
       count(*) filter (where sts = 'prospect') as of_which_status_prospect,
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
--      and exists (select 1 from dealer_manufacturers x where x.dealer_id = d.id and x.active
--                    and lower(trim(x.manufacturer)) not in ('golden','golden-technologies','yuwell'));
--   -- a Yuwell row spelled any other way would hide from the checks below: refuse to guess
--   select count(*) into odd from dealer_manufacturers where lower(trim(manufacturer)) = 'yuwell' and manufacturer <> 'yuwell';
--   if odd <> 0 then raise exception '% Yuwell row(s) with an odd spelling — fix them first, nothing written', odd; end if;
--   insert into dealer_manufacturers (dealer_id, manufacturer, active)
--   select id, 'yuwell', true from yw_eligible
--   on conflict (dealer_id, manufacturer) do update set active = true;   -- account_ref untouched: no account yet
--   -- every eligible dealer has Yuwell
--   select count(*) into missing from yw_eligible e
--    where not exists (select 1 from dealer_manufacturers y where y.dealer_id = e.id and y.manufacturer = 'yuwell' and y.active);
--   -- no one else has a row (the designated TEST dealer is the only allowed exception)
--   select count(*) into extra from dealer_manufacturers y
--    where y.manufacturer = 'yuwell' and y.active and y.dealer_id <> '3f7d87a2-7fbc-47e1-a34a-aaaacf4c4c7b'
--      and y.dealer_id not in (select id from yw_eligible);
--   if missing <> 0 or extra <> 0 then
--     raise exception 'verification failed: % eligible without Yuwell, % ineligible with Yuwell — rolled back', missing, extra; end if;
-- end $a$;
-- commit;
