-- ============================================================================
-- MI-1a · ROLLBACK (rev 2).
-- SAFE ORDER:
--   1. Switch mi_import_v2 off.
--   2. Revert the MI-1a code and confirm the deploy is Published.
--      From here the old import endpoints are LIVE but the database write guard refuses their
--      writes to every enrolled manufacturer/lane — imports are frozen, nothing can be doubled.
--   3. Roll back MI-1a batches newest first: select hcps_import_batch_rollback('{"batch_id":"…","actor":"angelo"}');
--   4. R1 — restores the old keys and removes the enrolment in ONE transaction. Only after this
--      commit can the old endpoints write again, and they then see the old key format.
--   5. R2 (optional) — remove the schema.
-- ============================================================================

-- R1. Restore old keys + un-enrol, atomically.
begin;
select set_config('hcps.ms_writer', 'mi1a', true);
-- Write freeze: no other session can insert, update or delete monthly_sales until this commits
-- (reads continue). Waits at most 10 s for a running import to finish, then stops with nothing changed.
set local lock_timeout = '10s';
lock table public.monthly_sales in share row exclusive mode;
do $$ begin
  if exists (select 1 from public.mfr_report_batches where status = 'imported') then
    raise exception 'MI-1a rollback refused: imported batches exist; roll them back first (newest first)';
  end if;
end $$;
update public.monthly_sales m
set external_ref = b.old_external_ref, order_key = b.old_order_key, line_key = b.old_line_key, line_hash = b.old_line_hash
from public.mi1a_rekey_backup b
where b.sales_row_id = m.id::text and m.manufacturer = 'strongback-mobility';
do $$ begin
  if exists (select 1 from public.monthly_sales where manufacturer='strongback-mobility' and source='sales_report'
             and external_ref like 'strongback-mobility|v2|%') then
    raise exception 'MI-1a rollback aborted: v2 keys remain';
  end if;
end $$;
delete from public.mi1a_enrollment;
commit;

-- R2. Remove the MI-1a schema (only after R1).
begin;
do $$ begin
  if exists (select 1 from public.mi1a_enrollment) then raise exception 'MI-1a schema rollback refused: run R1 first'; end if;
  if exists (select 1 from public.monthly_sales where batch_id is not null) then
    raise exception 'MI-1a schema rollback refused: rows still carry a batch id';
  end if;
end $$;
drop trigger  if exists hcps_ms_write_guard on public.monthly_sales;
drop function if exists public.hcps_ms_write_guard();
drop function if exists public.hcps_import_batch_rollback(jsonb);
drop function if exists public.hcps_commission_file_apply(jsonb);
drop function if exists public.hcps_commission_month_apply(jsonb);
drop function if exists public.hcps_sales_report_apply(jsonb);
drop function if exists public.hcps_ms_stmt_line(text, text, text, numeric, numeric, numeric);
drop function if exists public.hcps_ms_is_commission_lane(text, text);
drop function if exists public.hcps_ms_line_hash(numeric, numeric, numeric, date);
drop function if exists public.hcps_ms_sku_part(text, text);
drop function if exists public.hcps_ms_order_part(text, date, date, text);
drop index if exists public.monthly_sales_batch;
drop index if exists public.monthly_sales_order_key;
alter table public.monthly_sales drop column if exists line_hash;
alter table public.monthly_sales drop column if exists line_key;
alter table public.monthly_sales drop column if exists order_key;
alter table public.monthly_sales drop column if exists batch_id;
drop table if exists public.mi1a_enrollment;
drop table if exists public.monthly_sales_superseded;
drop table if exists public.commission_period_locks;
drop table if exists public.mfr_report_batches;
commit;
-- mi1a_rekey_backup is kept on purpose; drop it by hand once you are satisfied.
