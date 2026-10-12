-- MI Inbox Automation Phase B — production baseline (READ-ONLY). Run before and after installing supabase/mi_b_report_capture.sql
-- (and again after the switch is turned on and the first capture run). Before → after install: every row identical except
-- row 21 (the capture objects) and row 22 is computed WITHOUT the capture tables. After the first capture run: rows 7, 9,
-- 10 and 24 may grow by exactly the registered files; everything else identical.
select * from (
  select 1 n, 'monthly_sales rows / sales / commission' k, (select count(*)||' / '||sum(amount)||' / '||sum(commission) from public.monthly_sales) v
  union all select 2, 'D7 fingerprint (Part 0 definition)', (select md5(string_agg(concat_ws('|',manufacturer,source,month,rows,sales,commission), ';' order by manufacturer,source,month))
          from (select manufacturer, coalesce(source,'(none)') as source, to_char(period,'YYYY-MM') as month, count(*) as rows, sum(amount) as sales, sum(commission) as commission
                from public.monthly_sales group by 1,2,3) m)
  union all select 3, 'monthly_sales full-row md5', (select md5(string_agg(t::text, ';' order by t.id::text)) from public.monthly_sales t)
  union all select 4, 'Strongback rows / sales / commission', (select count(*)||' / '||sum(amount)||' / '||sum(commission) from public.monthly_sales where manufacturer='strongback-mobility')
  union all select 5, 'import batches / superseded rows / quarantine', (select (select count(*) from public.mfr_report_batches)||' / '||(select count(*) from public.monthly_sales_superseded)||' / '||(select count(*) from public.monthly_sales_quarantine))
  union all select 6, 'mi1a_enrollment', (select coalesce(string_agg(manufacturer||':'||lane, ', ' order by manufacturer, lane),'none') from public.mi1a_enrollment)
  union all select 7, 'mfr_sources by kind', (select string_agg(kind||'='||n, ', ' order by kind) from (select kind, count(*) n from public.mfr_sources group by 1) x)
  union all select 8, 'catalog source records md5 (non-report kinds)', (select md5(string_agg(t::text, ';' order by t.id)) from public.mfr_sources t where kind not in ('sales_export','commission_statement','dealer_report'))
  union all select 9, 'report records / dealer reports published', (select (select count(*) from public.mfr_sources where kind in ('sales_export','commission_statement','dealer_report'))||' / '||(select count(*) from public.mfr_sources where kind='dealer_report' and publication_status='published'))
  union all select 10, 'mfr_source_events', (select count(*)::text from public.mfr_source_events)
  union all select 11, 'phase2_flags mi_import_v2 / mi_commission_v2 / mi_intel_publish', (select coalesce(value->>'mi_import_v2','absent')||' / '||coalesce(value->>'mi_commission_v2','absent')||' / '||coalesce(value->>'mi_intel_publish','absent') from public.app_settings where key='phase2_flags')
  union all select 12, 'phase2_flags md5', (select md5(value::text) from public.app_settings where key='phase2_flags')
  union all select 13, 'dealers count / md5', (select count(*)||' / '||md5(string_agg(t::text, ';' order by t.id::text)) from public.dealers t)
  union all select 14, 'dealer_aliases count / md5', (select count(*)||' / '||md5(string_agg(t::text, ';' order by t.alias_norm)) from public.dealer_aliases t)
  union all select 15, 'dealer_manufacturers count / md5', (select count(*)||' / '||md5(string_agg(t::text, ';' order by t::text)) from public.dealer_manufacturers t)
  union all select 16, 'dealer_contacts / opportunities / dealer_tasks', (select (select count(*) from public.dealer_contacts)||' / '||(select count(*) from public.opportunities)||' / '||(select count(*) from public.dealer_tasks))
  union all select 17, 'price_imports / mfr_decisions / mfr_verification_runs', (select (select count(*) from public.price_imports)||' / '||(select count(*) from public.mfr_decisions)||' / '||(select count(*) from public.mfr_verification_runs))
  union all select 18, 'MI-1b functions md5 (prosrc)', (select md5(string_agg(proname||':'||md5(prosrc), ',' order by proname)) from pg_proc where pronamespace='public'::regnamespace and proname like 'hcps_mfr_report_%')
  union all select 19, 'MI-1a functions md5 (prosrc)', (select count(*)||' / '||md5(string_agg(proname||':'||md5(prosrc), ',' order by proname)) from pg_proc where pronamespace='public'::regnamespace and (proname like 'hcps_ms_%' or proname in ('hcps_sales_report_apply','hcps_commission_file_apply','hcps_import_batch_rollback')))
  union all select 20, 'triggers on mfr_sources', (select string_agg(tgname, ', ' order by tgname) from pg_trigger where tgrelid='public.mfr_sources'::regclass and not tgisinternal)
  union all select 21, 'Phase B capture objects present (expect none before install)', (select coalesce(string_agg(relname, ', ' order by relname),'none') from pg_class where relnamespace='public'::regnamespace and relkind='r' and relname in ('mfr_report_profiles','mfr_report_capture_state','mfr_report_capture_runs','mfr_report_messages','mfr_report_items','mfr_report_capture_events'))
           || ' | functions: ' || (select count(*) from pg_proc where pronamespace='public'::regnamespace and proname like 'hcps_mfr_capture_%')
  union all select 22, 'grants on public tables except the capture tables (count / md5)', (select count(*)||' / '||md5(string_agg(grantee||':'||table_name||':'||privilege_type, ',' order by grantee, table_name, privilege_type)) from information_schema.role_table_grants where table_schema='public' and table_name not in ('mfr_report_profiles','mfr_report_capture_state','mfr_report_capture_runs','mfr_report_messages','mfr_report_items','mfr_report_capture_events'))
  union all select 23, 'policies (count / md5)', (select count(*)||' / '||md5(string_agg(schemaname||'.'||tablename||':'||policyname, ',' order by schemaname, tablename, policyname)) from pg_policies)
  union all select 24, 'storage mfr-sources objects / bucket public?', (select (select count(*) from storage.objects where bucket_id='mfr-sources')||' / '||(select public::text from storage.buckets where id='mfr-sources'))
  union all select 25, 'MI-1c functions md5 (prosrc) / intel reports / snapshots', (select md5(string_agg(proname||':'||md5(prosrc), ',' order by proname)) from pg_proc where pronamespace='public'::regnamespace and (proname like 'hcps_mfr_intel_%' or proname='hcps_mfr_publication_gate'))
           || ' / ' || (select count(*) from public.mfr_intel_reports) || ' / ' || (select count(*) from public.mfr_dealer_snapshots)
  union all select 26, 'record 7 (September dealer report) md5', (select md5(t::text) from public.mfr_sources t where id = 7)
  union all select 27, 'phase2_flags mi_report_capture', (select coalesce(value->>'mi_report_capture','absent') from public.app_settings where key='phase2_flags')
) x order by n;
