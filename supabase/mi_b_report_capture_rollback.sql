-- ============================================================================================
-- ROLLBACK of supabase/mi_b_report_capture.sql — NOT RUN. Run only on Angelo's approval.
-- Step 1 of any rollback is the switch, not this file:
--   update app_settings set value = value || '{"mi_report_capture": false}' where key = 'phase2_flags';
-- (the cron and "Capture now" then do nothing, and the database refuses every capture write).
-- Then (2) revert the code (report-capture-cron, the Inbox / Needs attention actions), and only then (3) this file.
-- Refuses (writes nothing) while ANY captured email, item or capture event exists: they are the provenance of the
-- report files registered from email. Register records created by the capture (mfr_sources, created_by
-- 'system:report-capture') are MI-1b records and are never touched here — they are reviewed / rejected in Report History.
-- pg-safeupdate: no UPDATE / DELETE here.
-- ============================================================================================
begin;
do $$ begin
  if to_regclass('public.mfr_report_capture_events') is not null and exists (select 1 from public.mfr_report_capture_events) then
    raise exception 'mi_b_rollback: capture events exist — captured provenance is never dropped; nothing written'; end if;
  if to_regclass('public.mfr_report_items') is not null and exists (select 1 from public.mfr_report_items) then
    raise exception 'mi_b_rollback: captured items exist — nothing written'; end if;
  if to_regclass('public.mfr_report_messages') is not null and exists (select 1 from public.mfr_report_messages) then
    raise exception 'mi_b_rollback: captured emails exist — nothing written'; end if;
end $$;
drop function if exists public.hcps_mfr_capture_begin(jsonb);
drop function if exists public.hcps_mfr_capture_record(jsonb);
drop function if exists public.hcps_mfr_capture_classify(jsonb);
drop function if exists public.hcps_mfr_capture_fail(jsonb);
drop function if exists public.hcps_mfr_capture_register(jsonb);
drop function if exists public.hcps_mfr_capture_finish(jsonb);
drop function if exists public.hcps_mfr_capture_resolve(jsonb);
drop function if exists public.hcps_mfr_capture_lease(text, text, boolean);
drop function if exists public.hcps_mfr_capture_event(bigint, bigint, text, text, text, jsonb);
drop function if exists public.hcps_mfr_capture_settled(text);
drop function if exists public.hcps_mfr_capture_switch_on();
drop table if exists public.mfr_report_capture_events;
drop table if exists public.mfr_report_items;
drop table if exists public.mfr_report_messages;
drop table if exists public.mfr_report_capture_runs;
drop table if exists public.mfr_report_capture_state;
drop table if exists public.mfr_report_profiles;
drop function if exists public.hcps_mfr_capture_guard();
commit;

select 'mi_b capture rolled back' as result,
       (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and relname in ('mfr_report_profiles','mfr_report_capture_state','mfr_report_capture_runs','mfr_report_messages','mfr_report_items','mfr_report_capture_events')) as capture_tables_left,
       (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like 'hcps_mfr_capture_%') as capture_functions_left;
