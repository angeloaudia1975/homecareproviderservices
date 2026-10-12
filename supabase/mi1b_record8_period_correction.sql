-- MI-1b — one-time, audited period correction of report record #8 ONLY (approved by Angelo 2026-10-11 20:53 CT).
--
-- Record #8 = Strongback "Angelo Sep Orders.csv" (sales_export), registered by Phase B capture on 2026-10-11 with the
-- WRONG period 2026-09-01..2026-10-31: capture read every column with "date" in its name, including "Payment Due Date".
-- The orders were created 2026-09-04..2026-09-25 ("Created Date"). Corrected period: 2026-09-01..2026-09-30.
-- The capture defect itself is fixed in code (branch mi-b-capture-fixes, b86078f).
--
-- What this changes — on record #8 only:
--   report_period_end 2026-10-31 → 2026-09-30, and the period in its title ("… 2026-09 to 2026-10" → "… 2026-09").
--   One new audit event (action 'period_corrected') with the original AND corrected period and title.
--   The event action list gains 'period_corrected' (additive; every existing event stays valid).
-- What it never changes: the stored file, file name, SHA-256, size, storage path, received date, status, creator,
--   the registration event, any other record, any financial record (monthly_sales, batches), the capture item's own
--   period (kept as history of what capture proposed).
--
-- How the general safeguard is kept: mfr_report_guard is NOT disabled and NOT weakened for anyone. Inside this one
-- transaction the guard is replaced by a copy that adds ONE exception (row id 8, this exact file hash, only the period
-- end and title, only when this script's own setting is on), the single row is corrected, and the ORIGINAL guard
-- definition is put back — verified byte-for-byte (same prosrc md5) before the transaction can commit. Other sessions
-- only ever see the original guard (they see the catalog as of commit, when the original is already back).
-- Every precondition is checked first; any difference → an exception and NOTHING is written (second run = refused).
--
-- Run in the Supabase SQL editor (as postgres, the table owner) with this file pasted verbatim. The last statement
-- shows the result.

do $$
declare
  c_id        constant bigint := 8;
  c_sha       constant text   := '42509f6bfa59c0368697ae53c016f5fe2d01c4b68f3cdefbf002ec5e6a1d98dc';
  c_old_end   constant date   := '2026-10-31';
  c_new_end   constant date   := '2026-09-30';
  c_old_title constant text   := 'Strongback Mobility — order / sales export 2026-09 to 2026-10';
  c_new_title constant text   := 'Strongback Mobility — order / sales export 2026-09';
  v_row   public.mfr_sources%rowtype;
  v_after public.mfr_sources%rowtype;
  v_owner text;
  v_def   text; v_md5 text; v_tmp text; v_chk text;
  v_inject constant text := $inj$begin
  -- TEMPORARY (mi1b_record8_period_correction.sql): exists only inside that one transaction.
  if tg_op = 'UPDATE' and old.id = 8 and new.id = 8
     and coalesce(current_setting('hcps.mfr_record8_period_fix', true), '') = '42509f6bfa59c0368697ae53c016f5fe2d01c4b68f3cdefbf002ec5e6a1d98dc'
     and coalesce(current_setting('hcps.mfr_report_op', true), '') = 'on'
     and old.file_sha256 = '42509f6bfa59c0368697ae53c016f5fe2d01c4b68f3cdefbf002ec5e6a1d98dc' then
    if (to_jsonb(new) - 'report_period_end' - 'title') is distinct from (to_jsonb(old) - 'report_period_end' - 'title') then
      raise exception 'record8_period_fix: only the period end and title of record 8 may change';
    end if;
    return new;
  end if;
$inj$;
begin
  -- 0. Who is running it: the table owner (the SQL editor's postgres), nobody else.
  select tableowner into v_owner from pg_tables where schemaname = 'public' and tablename = 'mfr_sources';
  if current_user <> v_owner then raise exception 'record8_period_fix: run as the table owner (%), not %', v_owner, current_user; end if;

  -- 1. Preconditions — the exact record, unchanged since capture registered it.
  select * into v_row from public.mfr_sources where id = c_id for update;
  if not found then raise exception 'record8_period_fix: record 8 not found — nothing written'; end if;
  if v_row.manufacturer <> 'strongback-mobility' or v_row.kind <> 'sales_export' or v_row.file_name <> 'Angelo Sep Orders.csv'
     or v_row.file_sha256 <> c_sha or v_row.file_size <> 4155 or v_row.received_date <> date '2026-10-02'
     or v_row.report_period_start <> date '2026-09-01' or v_row.report_period_end <> c_old_end or v_row.title <> c_old_title
     or v_row.status <> 'received' or v_row.created_by <> 'system:report-capture'
     or v_row.supersedes_id is not null or v_row.import_batch_id is not null or v_row.publication_status is not null then
    raise exception 'record8_period_fix: record 8 is not in the expected state (period %..%, status %, title %) — nothing written',
      v_row.report_period_start, v_row.report_period_end, v_row.status, v_row.title;
  end if;
  if exists (select 1 from public.mfr_sources where supersedes_id = c_id) then
    raise exception 'record8_period_fix: another record supersedes record 8 — nothing written';
  end if;
  if (select count(*) from public.mfr_source_events where source_id = c_id) <> 1
     or not exists (select 1 from public.mfr_source_events where source_id = c_id and action = 'registered') then
    raise exception 'record8_period_fix: record 8 has events other than its registration — nothing written';
  end if;

  -- 2. Keep the original guard definition and fingerprint.
  select pg_get_functiondef(p.oid), md5(p.prosrc) into v_def, v_md5
    from pg_proc p where p.oid = 'public.hcps_mfr_report_guard()'::regprocedure;
  if position('never change' in v_def) = 0 or position('hcps.mfr_report_op' in v_def) = 0 then
    raise exception 'record8_period_fix: the installed guard is not the MI-1b guard — nothing written';
  end if;

  -- 3. Temporary guard = the original + the single record-8 exception at the top of its body.
  v_tmp := regexp_replace(v_def, '\mbegin\M', v_inject);
  if v_tmp = v_def or position('record8_period_fix' in v_tmp) = 0 then raise exception 'record8_period_fix: could not prepare the guard copy'; end if;
  execute v_tmp;

  -- 4. The one-row correction.
  perform set_config('hcps.mfr_report_op', 'on', true);
  perform set_config('hcps.mfr_record8_period_fix', c_sha, true);
  update public.mfr_sources set report_period_end = c_new_end, title = c_new_title
   where id = c_id and file_sha256 = c_sha and report_period_end = c_old_end and title = c_old_title;
  if not found then raise exception 'record8_period_fix: the update changed no row'; end if;
  perform set_config('hcps.mfr_record8_period_fix', '', true);
  perform set_config('hcps.mfr_report_op', 'off', true);

  -- 5. Put the original guard back, byte-for-byte.
  execute v_def;
  select md5(p.prosrc) into v_chk from pg_proc p where p.oid = 'public.hcps_mfr_report_guard()'::regprocedure;
  if v_chk is distinct from v_md5 or pg_get_functiondef('public.hcps_mfr_report_guard()'::regprocedure) <> v_def then
    raise exception 'record8_period_fix: the original guard could not be restored exactly — nothing written';
  end if;

  -- 6. Audit: 'period_corrected' joins the event actions (additive), then the event itself.
  alter table public.mfr_source_events drop constraint mfr_source_events_action_check;
  alter table public.mfr_source_events add constraint mfr_source_events_action_check
    check (action in ('registered','accepted','rejected','superseded','published','withdrawn','batch_linked','period_corrected'));
  insert into public.mfr_source_events (source_id, action, actor, reason, detail)
  values (c_id, 'period_corrected', 'owner:sql-editor (Angelo, approved 2026-10-11 20:53 CT)',
    'Capture read the period from every date column, including "Payment Due Date"; the orders were created 2026-09-04..2026-09-25 ("Created Date"). Capture defect fixed in mi-b-capture-fixes (b86078f).',
    jsonb_build_object('original_period', jsonb_build_array('2026-09-01', c_old_end), 'corrected_period', jsonb_build_array('2026-09-01', c_new_end),
      'original_title', c_old_title, 'corrected_title', c_new_title, 'file_sha256', c_sha, 'received_date', '2026-10-02',
      'unchanged', 'file, file name, SHA-256, size, storage path, received date, status, creator, registration event; no financial record',
      'script', 'supabase/mi1b_record8_period_correction.sql'));

  -- 7. Post-checks: only the two fields moved; the guard refuses a plain change again.
  select * into v_after from public.mfr_sources where id = c_id;
  if (to_jsonb(v_after) - 'report_period_end' - 'title') is distinct from (to_jsonb(v_row) - 'report_period_end' - 'title')
     or v_after.report_period_end <> c_new_end or v_after.title <> c_new_title then
    raise exception 'record8_period_fix: post-check failed — nothing written';
  end if;
  begin
    perform set_config('hcps.mfr_report_op', 'on', true);
    update public.mfr_sources set report_period_end = c_old_end where id = c_id;
    raise exception 'record8_period_fix: GUARD_OPEN';
  exception when others then
    if sqlerrm like '%GUARD_OPEN%' then raise exception 'record8_period_fix: the guard no longer protects the period — nothing written'; end if;
  end;
  perform set_config('hcps.mfr_report_op', 'off', true);
end $$;

select jsonb_pretty(jsonb_build_object(
  'record_8', (select jsonb_build_object('title', title, 'period', report_period_start || '..' || report_period_end, 'status', status,
               'file_name', file_name, 'file_sha256', file_sha256, 'received_date', received_date) from public.mfr_sources where id = 8),
  'events_record_8', (select jsonb_agg(jsonb_build_object('id', id, 'action', action, 'actor', actor, 'at', at) order by id) from public.mfr_source_events where source_id = 8),
  'guard_prosrc_md5', (select md5(prosrc) from pg_proc where oid = 'public.hcps_mfr_report_guard()'::regprocedure),
  'report_records', (select count(*) from public.mfr_sources where kind in ('sales_export','commission_statement','dealer_report')),
  'monthly_sales', (select count(*) || ' / ' || sum(amount) || ' / ' || sum(commission) from public.monthly_sales)
)) as result;
