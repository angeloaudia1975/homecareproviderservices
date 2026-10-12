-- ============================================================================================
-- ROLLBACK of supabase/mi_c_shipto.sql — NOT RUN. Run only on Angelo's approval, after the code is reverted
-- (shipto-review-api, the Ship-To Review page). Refuses (writes nothing) while ANY correction, mapping or event exists:
-- they are people's decisions and their audit trail, never dropped. pg-safeupdate: no UPDATE / DELETE here.
-- ============================================================================================
begin;
do $$ begin
  if to_regclass('public.mfr_shipto_events') is not null and exists (select 1 from public.mfr_shipto_events) then
    raise exception 'mi_c_rollback: Ship-To events exist — decisions are never dropped; nothing written'; end if;
  if to_regclass('public.mfr_shipto_mappings') is not null and exists (select 1 from public.mfr_shipto_mappings) then
    raise exception 'mi_c_rollback: verified mappings exist — nothing written'; end if;
  if to_regclass('public.mfr_shipto_corrections') is not null and exists (select 1 from public.mfr_shipto_corrections) then
    raise exception 'mi_c_rollback: corrections exist — nothing written'; end if;
end $$;
drop function if exists public.hcps_mfr_shipto_correct(jsonb);
drop function if exists public.hcps_mfr_shipto_retire(jsonb);
drop table if exists public.mfr_shipto_events;
drop table if exists public.mfr_shipto_mappings;
drop table if exists public.mfr_shipto_corrections;
drop function if exists public.hcps_mfr_shipto_guard();
commit;
select 'mi_c rolled back' as result;
