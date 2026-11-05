-- supabase/golden_b7_shipto_rollback.sql — undo golden_b7_shipto.sql. Turn phase2_flags.golden_p360_hcps_shipto OFF
-- first. Refuses while any saved address or default exists (those are dealers' records — export them before deciding).
do $$
begin
  if (select count(*) from public.golden_ship_addresses) > 0 or (select count(*) from public.golden_ship_defaults) > 0 then
    raise exception 'golden ship-to records exist — nothing dropped';
  end if;
  drop table public.golden_ship_defaults;
  drop table public.golden_ship_addresses;
end $$;
select to_regclass('public.golden_ship_addresses') is null and to_regclass('public.golden_ship_defaults') is null as removed;
