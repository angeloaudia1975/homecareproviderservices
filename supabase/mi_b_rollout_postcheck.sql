-- MI Inbox Automation Phase B — post-install metadata check (READ-ONLY). Nothing here writes.
select * from (
  select 1 n, 'installed capture code fingerprint (12 functions; expect LF / CRLF value from the rollout proposal)' k,
         (select count(*)||' / '||md5(string_agg(proname||':'||md5(prosrc), ',' order by proname)) from pg_proc
           where pronamespace='public'::regnamespace and proname like 'hcps_mfr_capture_%') v
  union all select 2, 'profiles: code | status | auto_register (md5 of rules)',
         (select string_agg(code||' | '||status||' | '||auto_register||' | '||left(md5(rules::text),8), '; ' order by id) from public.mfr_report_profiles)
  union all select 3, 'captured mailbox / checkpoint / overlap / lease', (select string_agg(mailbox||' / '||checkpoint_at||' / '||overlap_minutes||' / '||coalesce(lock_until::text,'free'), '; ') from public.mfr_report_capture_state)
  union all select 4, 'mi_report_capture switch (expect absent until Angelo turns it on)', (select coalesce(value->>'mi_report_capture','absent') from public.app_settings where key='phase2_flags')
  union all select 5, 'rows: runs / messages / items / events (expect 0 / 0 / 0 / 0 before the switch)',
         (select (select count(*) from public.mfr_report_capture_runs)||' / '||(select count(*) from public.mfr_report_messages)||' / '||(select count(*) from public.mfr_report_items)||' / '||(select count(*) from public.mfr_report_capture_events))
  union all select 6, 'privileges: anon/authenticated/PUBLIC grants on capture tables; service_role privilege types',
         (select (select count(*) from information_schema.role_table_grants where table_schema='public' and table_name like 'mfr_report_%' and table_name <> 'mfr_report_batches' and grantee in ('anon','authenticated','PUBLIC'))
            ||' / '||(select string_agg(distinct privilege_type, ',') from information_schema.role_table_grants where table_schema='public' and table_name like 'mfr_report_%' and table_name <> 'mfr_report_batches' and grantee='service_role'))
  union all select 7, 'functions executable by anon / authenticated / service_role (capture ops expect 0 / 0 / 7)',
         (select count(*) filter (where has_function_privilege('anon',oid,'execute'))||' / '||count(*) filter (where has_function_privilege('authenticated',oid,'execute'))||' / '||count(*) filter (where has_function_privilege('service_role',oid,'execute'))
            from pg_proc where pronamespace='public'::regnamespace and proname like 'hcps_mfr_capture_%')
  union all select 8, 'security definer + pinned search_path on the capture functions (expect 10 of 12: the guard and the settled helper run as the caller)',
         (select count(*) filter (where prosecdef and array_to_string(proconfig,';') like 'search_path=%')||' of '||count(*) from pg_proc where pronamespace='public'::regnamespace and proname like 'hcps_mfr_capture_%')
  union all select 9, 'RLS on the 6 capture tables / policies', (select count(*) filter (where relrowsecurity)||' of '||count(*)||' / '||(select count(*) from pg_policy p join pg_class c on c.oid=p.polrelid where c.relnamespace='public'::regnamespace and c.relname like 'mfr_report_%' and c.relname <> 'mfr_report_batches')
            from pg_class where relnamespace='public'::regnamespace and relkind='r' and relname like 'mfr_report_%' and relname <> 'mfr_report_batches')
  union all select 10, 'guard triggers (row + truncate)', (select count(*)::text from pg_trigger where tgname in ('mfr_capture_guard','mfr_capture_guard_truncate'))
  union all select 11, 'capture-registered report records (expect 0 before the switch)', (select count(*)::text from public.mfr_sources where created_by = 'system:report-capture')
) x order by n;
