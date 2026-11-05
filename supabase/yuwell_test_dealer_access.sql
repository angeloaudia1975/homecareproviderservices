-- ============================================================================
-- Yuwell — give ONLY the TEST dealer(s) access, so the line can be reviewed in the Catalog Review Sandbox
-- (PR #26) and through staff preview before any real dealer sees it.  DRAFT — NOT RUN; Angelo runs it.
-- Requires: yuwell_manufacturer_register.sql. Real dealers are untouched (dealers.is_test = true only).
-- Idempotent. Undo: update dealer_manufacturers set active=false where manufacturer='yuwell'
--                   and dealer_id in (select id from dealers where is_test = true);
-- ============================================================================
insert into dealer_manufacturers (dealer_id, manufacturer, active)
select d.id, 'yuwell', true
from dealers d
where d.is_test = true
on conflict (dealer_id, manufacturer) do update set active = true;

-- Verify: TEST dealers with Yuwell, and real dealers with Yuwell (must be 0)
select
  (select count(*) from dealer_manufacturers dm join dealers d on d.id = dm.dealer_id
    where dm.manufacturer = 'yuwell' and dm.active and d.is_test = true)                     as test_dealers_with_yuwell,
  (select count(*) from dealer_manufacturers dm join dealers d on d.id = dm.dealer_id
    where dm.manufacturer = 'yuwell' and dm.active and coalesce(d.is_test,false) = false)     as real_dealers_with_yuwell;
