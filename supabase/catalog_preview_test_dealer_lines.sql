-- HCPS CATALOG PREVIEW — give the TEST sandbox dealer every preview line (TEST dealer only; no real dealer is touched).
-- Lets you open the preview "as" the TEST dealer (Connect 360 → Catalog Preview) and see every catalog with its prices.
-- Refuses (writes nothing) unless exactly one active TEST dealer named "TEST — Golden Sandbox" exists.
do $pv$
declare d uuid; n int;
begin
  select count(*) into n from public.dealers where is_test = true and business_name ilike 'TEST%Golden Sandbox%';
  if n <> 1 then raise exception 'expected exactly one TEST Golden Sandbox dealer, found % — nothing written', n; end if;
  select id into d from public.dealers where is_test = true and business_name ilike 'TEST%Golden Sandbox%';
  insert into public.dealer_manufacturers (dealer_id, manufacturer, active)
  select d, m.slug, true
    from (values ('access4u'),('dalton'),('pedifix'),('corsicana'),('abm-respiratory-care'),('airavant-bongorx'),
                 ('strongback-mobility'),('climbing-steps'),('ovation-medical'),('bemis')) m(slug)
   where exists (select 1 from public.manufacturers x where x.slug = m.slug)
  on conflict (dealer_id, manufacturer) do update set active = true;
end $pv$;
select d.business_name, dm.manufacturer, dm.active
  from public.dealer_manufacturers dm join public.dealers d on d.id = dm.dealer_id
 where d.is_test = true and d.business_name ilike 'TEST%Golden Sandbox%' order by 2;
