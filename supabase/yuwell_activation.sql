-- ============================================================================
-- Yuwell — ACTIVATION for real dealers (owner 2026-11-04: "the Yuwell line in all territories that we cover —
-- southern Indiana, southwest Ohio, Kentucky, Tennessee and northern Georgia").  DRAFT — NOT RUN.
-- Run ONLY after: registration SQL, the private commercial record (prices), the sandbox review, and
-- Angelo's explicit go-ahead. Two parts; run PART 1 (read-only) first and send the numbers back.
--
-- Who gets Yuwell: every active, non-TEST dealer in IN / OH / KY / TN / GA whose account class is blank or
-- "dealer" AND who already orders at least one line on the platform (an active dealer_manufacturers row
-- other than Golden and the retired lines). Dealers with NO ordering rows are left alone: giving them a
-- single Yuwell row would switch their access grid from the territory rules to "Yuwell only".
-- Nothing else changes: no account numbers, no other line, no dealer record.
-- ============================================================================

-- PART 1 (read-only preview): how many dealers, by state
with eligible as (
  select distinct d.id, upper(d.state) as st
  from dealers d
  join dealer_manufacturers dm on dm.dealer_id = d.id and dm.active
   and dm.manufacturer not in ('golden', 'golden-technologies', 'ohio-medical', 'gce', 'complete-medical-supplies', 'yuwell')
  where coalesce(d.active, true) and coalesce(d.is_test, false) = false
    and upper(coalesce(d.state,'')) in ('IN','OH','KY','TN','GA')
    and coalesce(d.account_class,'') in ('', 'dealer')
)
select st, count(*) as dealers_to_grant,
       (select count(*) from dealer_manufacturers x where x.manufacturer='yuwell' and x.active) as already_with_yuwell
from eligible group by st order by st;

-- PART 2 (the write) — run only after Angelo approves the PART 1 numbers:
-- insert into dealer_manufacturers (dealer_id, manufacturer, active)
-- select distinct d.id, 'yuwell', true
-- from dealers d
-- join dealer_manufacturers dm on dm.dealer_id = d.id and dm.active
--  and dm.manufacturer not in ('golden', 'golden-technologies', 'ohio-medical', 'gce', 'complete-medical-supplies', 'yuwell')
-- where coalesce(d.active, true) and coalesce(d.is_test, false) = false
--   and upper(coalesce(d.state,'')) in ('IN','OH','KY','TN','GA')
--   and coalesce(d.account_class,'') in ('', 'dealer')
-- on conflict (dealer_id, manufacturer) do update set active = true;
