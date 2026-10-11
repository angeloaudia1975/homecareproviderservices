-- ============================================================================================
-- ROLLBACK of supabase/mi1b_report_register.sql — NOT RUN. Run only on Angelo's approval.
-- Order: (1) remove the Report History page / mfr-reports-api from the deploy FIRST (revert the code),
--        (2) then run this file.
-- Refuses (writes nothing) while ANY report record or audit event exists: those are the history of real
-- manufacturer files and are never dropped by a rollback. (Files in the mfr-sources bucket are not touched.)
-- Restores mfr_sources exactly to its Manufacturer Center Phase 1 shape and proves the catalog rows are
-- unchanged. pg-safeupdate: no UPDATE / DELETE here.
-- ============================================================================================
begin;
do $$ begin
  if to_regclass('public.mfr_source_events') is not null and exists (select 1 from public.mfr_source_events) then
    raise exception 'mi1b_rollback: audit events exist — manufacturer report history is never dropped; nothing written'; end if;
  if exists (select 1 from public.mfr_sources where kind in ('sales_export','commission_statement','dealer_report')) then
    raise exception 'mi1b_rollback: report records exist — nothing written'; end if;
end $$;
create temp table _mi1b_rb_before on commit drop as
select count(*) n, md5(coalesce(string_agg(concat_ws('|', id, manufacturer, kind, title, file_name, file_sha256, storage_path, received_date, legacy,
         manufacturer_effective_date, effective_date_status, supersedes_id, status, accepted_by, accepted_at, note, created_at, created_by), ';' order by id), '')) fp
from public.mfr_sources;

drop trigger if exists mfr_report_guard on public.mfr_sources;
drop function if exists public.hcps_mfr_report_register(jsonb);
drop function if exists public.hcps_mfr_report_decide(jsonb);
drop function if exists public.hcps_mfr_report_publication(jsonb);
drop function if exists public.hcps_mfr_report_link_batch(jsonb);
drop function if exists public.hcps_mfr_report_guard();
drop table if exists public.mfr_source_events;
drop function if exists public.hcps_mfr_source_events_append_only();
drop index if exists public.mfr_sources_report_period_uk;
drop index if exists public.mfr_sources_open_correction_uk;
drop index if exists public.mfr_sources_batch_uk;
drop index if exists public.mfr_sources_report_idx;
alter table public.mfr_sources drop constraint if exists mfr_sources_catalog_shape;
alter table public.mfr_sources drop constraint if exists mfr_sources_report_shape;
alter table public.mfr_sources drop constraint if exists mfr_sources_publication;
alter table public.mfr_sources drop constraint if exists mfr_sources_batch_link;
alter table public.mfr_sources
  drop column if exists report_period_start, drop column if exists report_period_end, drop column if exists prepared_date,
  drop column if exists prepared_date_status, drop column if exists file_size, drop column if exists content_type,
  drop column if exists supersede_reason, drop column if exists publication_status, drop column if exists published_at,
  drop column if exists published_by, drop column if exists import_batch_id, drop column if exists decided_reason;
alter table public.mfr_sources drop constraint if exists mfr_sources_kind_check;
alter table public.mfr_sources add constraint mfr_sources_kind_check check (kind in ('price_list','terms','catalog','images','cross_reference','status_list','other'));
drop function if exists public.hcps_mfr_is_report_kind(text);

do $$ declare b record; a record; begin
  select * into b from _mi1b_rb_before;
  select count(*) n, md5(coalesce(string_agg(concat_ws('|', id, manufacturer, kind, title, file_name, file_sha256, storage_path, received_date, legacy,
           manufacturer_effective_date, effective_date_status, supersedes_id, status, accepted_by, accepted_at, note, created_at, created_by), ';' order by id), '')) fp
    into a from public.mfr_sources;
  if a.n <> b.n or a.fp <> b.fp then raise exception 'mi1b_rollback: source records changed'; end if;
end $$;
commit;

select 'mi1b rolled back' as result, count(*) as source_records,
       (select pg_get_constraintdef(oid) from pg_constraint where conname = 'mfr_sources_kind_check') as kind_check
from public.mfr_sources;
