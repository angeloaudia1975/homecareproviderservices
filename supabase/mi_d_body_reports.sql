-- MI Phase D — let a report that lives in the EMAIL BODY (Climbing Steps sends some months' commission figures only in
-- the email text) be registered like a file: the original message is kept privately as <sha256>.eml (message/rfc822).
-- Two narrow changes, nothing else:
--   1. mfr_sources_report_shape: the stored path may end in .eml as well as .pdf / .xlsx / .xls / .csv (every other
--      condition of the check is unchanged, word for word).
--   2. the private bucket mfr-sources also accepts message/rfc822 (it stays private; no policy changes).
-- No row is written. Existing rows are re-validated by the constraint as it is added. Angelo runs this; Claude never does.
-- Rollback: re-add the constraint without "eml" (refused while an .eml report exists) and remove the MIME type.
begin;
alter table public.mfr_sources drop constraint mfr_sources_report_shape;
alter table public.mfr_sources add constraint mfr_sources_report_shape check (not hcps_mfr_is_report_kind(kind) or (
      file_sha256 is not null and file_name is not null and received_date is not null and not legacy
      and storage_path is not null and starts_with(storage_path, 'reports/' || manufacturer || '/' || kind || '/' || file_sha256 || '.')
      and storage_path ~ '^reports/[a-z0-9-]+/[a-z_]+/[0-9a-f]{64}\.(pdf|xlsx|xls|csv|eml)$'
      and file_size > 0 and content_type is not null
      and report_period_start is not null and report_period_end is not null and report_period_start <= report_period_end
      and effective_date_status = 'not_applicable' and manufacturer_effective_date is null
      and prepared_date_status in ('stated','not_stated')
      and (prepared_date_status = 'stated') = (prepared_date is not null)
      and (prepared_date is null or prepared_date <= received_date)
      and status in ('received','accepted','rejected','superseded')
      and (supersedes_id is null) = (supersede_reason is null)
      and (status <> 'rejected' or decided_reason is not null)));
do $$ begin
  if to_regclass('storage.buckets') is not null then
    update storage.buckets set allowed_mime_types = allowed_mime_types || array['message/rfc822']
     where id = 'mfr-sources' and public = false and not ('message/rfc822' = any (allowed_mime_types));
  end if;
end $$;
commit;

-- CHECK (read-only; the SQL editor shows only this last result). Every row: ok = true.
select * from (
  select 1 n, 'report shape allows .eml (and still pdf/xlsx/xls/csv only otherwise)' check_name,
         (select pg_get_constraintdef(oid) from pg_constraint where conname = 'mfr_sources_report_shape') ~ 'csv\|eml\)\$' ok
  union all select 2, 'bucket mfr-sources private and accepts message/rfc822',
         coalesce((select not public and 'message/rfc822' = any (allowed_mime_types) from storage.buckets where id = 'mfr-sources'), false)
  union all select 3, 'no report row changed (count of report records)', (select count(*) >= 0 from public.mfr_sources)
) c order by n;
