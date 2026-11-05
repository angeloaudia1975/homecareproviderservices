-- ============================================================================
-- Yuwell — preview access for the ONE designated TEST dealer only: "TEST — Golden Sandbox" (Batesville, IN)
-- 3f7d87a2-7fbc-47e1-a34a-aaaacf4c4c7b, the dealer Connect 360 → Catalog Preview opens. DRAFT — NOT RUN.
-- Requires: yuwell_manufacturer_register.sql. Kept SEPARATE from real-dealer activation (owner C3-05).
-- Refuses unless that dealer exists and is marked TEST, and unless no real dealer has Yuwell afterwards.
-- Undo: update dealer_manufacturers set active = false
--        where manufacturer = 'yuwell' and dealer_id = '3f7d87a2-7fbc-47e1-a34a-aaaacf4c4c7b';
-- ============================================================================
begin;
do $t$
declare tid constant uuid := '3f7d87a2-7fbc-47e1-a34a-aaaacf4c4c7b'; n int;
begin
  if not exists (select 1 from dealers where id = tid and is_test = true) then
    raise exception 'the designated TEST dealer is missing or not marked TEST — nothing written'; end if;
  insert into dealer_manufacturers (dealer_id, manufacturer, active) values (tid, 'yuwell', true)
  on conflict (dealer_id, manufacturer) do update set active = true;
  select count(*) into n from dealer_manufacturers where manufacturer = 'yuwell' and active and dealer_id <> tid;
  if n <> 0 then raise exception '% other dealer(s) already have Yuwell — rolled back, nothing written', n; end if;
end $t$;
commit;
select d.business_name, d.is_test, dm.active
  from dealer_manufacturers dm join dealers d on d.id = dm.dealer_id where dm.manufacturer = 'yuwell';
