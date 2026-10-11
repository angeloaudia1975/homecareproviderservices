-- ============================================================================================
-- ROLLBACK of supabase/mi1c_dealer_intel.sql — NOT RUN. Run only on Angelo's approval.
-- Order: (1) remove the Dealer Intelligence page / mfr-intel-api from the deploy FIRST (revert the code),
--        (2) then run this file.
-- Refuses (writes nothing) while ANY imported report, snapshot, observation or audit event exists: those hold a
-- manufacturer report's content and every match decision a person made, and are never dropped by a rollback.
-- After an import, "undo" is not this file: it is MI-1b's own controls (withdraw publication, reject or supersede
-- the source) — no HCPS business table is touched by MI-1c, so nothing else needs reversing.
-- MI-1b (mfr_sources rows, mfr_source_events, its functions) is NOT touched. The MI-1c publication gate trigger on
-- mfr_sources is dropped; MI-1b's publish step then again finds no mfr_dealer_snapshots table and refuses every
-- publish, exactly as before MI-1c (so the gate is never removed while intelligence exists — this file refuses then).
-- The recorded-hold table (Wyatt's) is dropped with MI-1c; the rule itself stays in CLAUDE.md RULE 18.
-- pg-safeupdate: no UPDATE / DELETE here.
-- ============================================================================================
begin;
do $$ begin
  if to_regclass('public.mfr_intel_events') is not null and exists (select 1 from public.mfr_intel_events) then
    raise exception 'mi1c_rollback: audit events exist — imported manufacturer intelligence is never dropped; nothing written'; end if;
  if to_regclass('public.mfr_intel_reports') is not null and exists (select 1 from public.mfr_intel_reports) then
    raise exception 'mi1c_rollback: imported reports exist — nothing written'; end if;
  if to_regclass('public.mfr_dealer_snapshots') is not null and exists (select 1 from public.mfr_dealer_snapshots) then
    raise exception 'mi1c_rollback: dealer snapshots exist — nothing written'; end if;
  if to_regclass('public.mfr_dealer_observations') is not null and exists (select 1 from public.mfr_dealer_observations) then
    raise exception 'mi1c_rollback: observations exist — nothing written'; end if;
end $$;
drop function if exists public.hcps_mfr_intel_import(jsonb);
drop function if exists public.hcps_mfr_intel_match(jsonb);
drop table if exists public.mfr_intel_events;
drop table if exists public.mfr_dealer_observations;
drop table if exists public.mfr_dealer_snapshots;
drop table if exists public.mfr_intel_reports;
drop function if exists public.hcps_mfr_intel_guard();
drop table if exists public.mfr_intel_holds;
drop function if exists public.hcps_mfr_intel_holds_guard();
drop function if exists public.hcps_mfr_intel_name_key(text);
drop trigger if exists mfr_sources_publication_gate on public.mfr_sources;
drop function if exists public.hcps_mfr_publication_gate();
commit;

select 'mi1c rolled back' as result,
       (select count(*) from pg_class where relname in ('mfr_intel_reports','mfr_dealer_snapshots','mfr_dealer_observations','mfr_intel_events','mfr_intel_holds')) as tables_left,
       (select count(*) from pg_proc where proname like 'hcps_mfr_intel_%' or proname = 'hcps_mfr_publication_gate') as functions_left,
       (select count(*) from pg_trigger where tgname = 'mfr_sources_publication_gate') as gate_left,
       (select count(*) from public.mfr_sources) as mfr_sources_rows;
