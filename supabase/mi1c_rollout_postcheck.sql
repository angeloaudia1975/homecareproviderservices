-- MI-1c post-install metadata check (READ-ONLY): publication gate + Wyatt's hold + installed code, without writing anything.
select * from (
  select 1 n, 'MI-1c installed code fingerprint (6 functions; expect 618a4139… LF or 887809bd… CRLF)' k,
         (select count(*)||' / '||md5(string_agg(proname||':'||md5(prosrc), ',' order by proname)) from pg_proc
           where pronamespace='public'::regnamespace and (proname like 'hcps_mfr_intel_%' or proname='hcps_mfr_publication_gate')) v
  union all select 2, 'publication gate trigger: enabled, BEFORE INSERT/UPDATE, row-level, on mfr_sources',
         (select string_agg(tgname||' enabled='||tgenabled::text||' type='||tgtype, ', ') from pg_trigger where tgrelid='public.mfr_sources'::regclass and tgname='mfr_sources_publication_gate')
  union all select 3, 'gate function: SECURITY DEFINER, pinned search_path, callable by anon/authenticated/service_role?',
         (select prosecdef||' / '||coalesce(array_to_string(proconfig, ';'),'-')||' / '||has_function_privilege('anon',oid,'execute')||','||has_function_privilege('authenticated',oid,'execute')||','||has_function_privilege('service_role',oid,'execute')
            from pg_proc where proname='hcps_mfr_publication_gate' and pronamespace='public'::regnamespace)
  union all select 4, 'gate refuses unless phase2_flags.mi_intel_publish is exactly true (source contains the check)',
         (select (prosrc like '%(value->''mi_intel_publish'') = ''true''::jsonb%')::text||' / '||(prosrc like '%mi1b_publication_not_authorized%')::text from pg_proc where proname='hcps_mfr_publication_gate')
  union all select 5, 'mi_intel_publish switch now', (select coalesce(value->>'mi_intel_publish','absent') from public.app_settings where key='phase2_flags')
  union all select 6, 'dealer reports published (expect 0)', (select count(*)::text from public.mfr_sources where kind='dealer_report' and publication_status='published')
  union all select 7, 'recorded holds', (select string_agg(manufacturer||' | '||printed_name||' | key '||name_key||' | '||decided_by||' | '||decided_on, '; ') from public.mfr_intel_holds)
  union all select 8, 'hold key of variants (expect WYATTS PHARMACY x3)',
         (select string_agg(public.hcps_mfr_intel_name_key(x), ' / ') from unnest(array['Wyatt''s Pharmacy Inc','Wyatts Pharmacy','WYATT’S PHARMACY, INC.']) x)
  union all select 9, 'hold guard triggers on mfr_intel_holds', (select string_agg(tgname||' enabled='||tgenabled::text, ', ' order by tgname) from pg_trigger where tgrelid='public.mfr_intel_holds'::regclass and not tgisinternal)
  union all select 10, 'match function refuses held names (source contains the lock)', (select (prosrc like '%mi1c_held_locked%' and prosrc like '%mfr_intel_holds%')::text from pg_proc where proname='hcps_mfr_intel_match')
  union all select 11, 'import function enforces holds + prepared date', (select (prosrc like '%mi1c_hold_violated%' and prosrc like '%mi1c_hold_unknown%' and prosrc like '%mi1c_prepared_date_mismatch%')::text from pg_proc where proname='hcps_mfr_intel_import')
  union all select 12, 'MI-1c rows (reports / snapshots / observations / events)', (select (select count(*) from public.mfr_intel_reports)||' / '||(select count(*) from public.mfr_dealer_snapshots)||' / '||(select count(*) from public.mfr_dealer_observations)||' / '||(select count(*) from public.mfr_intel_events))
  union all select 13, 'privileges: anon/authenticated on the 5 tables; service_role privileges',
         (select (select count(*) from information_schema.role_table_grants where table_schema='public' and table_name in ('mfr_intel_reports','mfr_dealer_snapshots','mfr_dealer_observations','mfr_intel_events','mfr_intel_holds') and grantee in ('anon','authenticated','PUBLIC'))
            ||' / '||(select string_agg(distinct privilege_type, ',') from information_schema.role_table_grants where table_schema='public' and table_name in ('mfr_intel_reports','mfr_dealer_snapshots','mfr_dealer_observations','mfr_intel_events','mfr_intel_holds') and grantee='service_role'))
  union all select 14, 'RLS on the 5 tables / policies', (select count(*) filter (where relrowsecurity)||' of '||count(*)||' / '||(select count(*) from pg_policy where polrelid in (select oid from pg_class where relname in ('mfr_intel_reports','mfr_dealer_snapshots','mfr_dealer_observations','mfr_intel_events','mfr_intel_holds') and relnamespace='public'::regnamespace))
            from pg_class where relnamespace='public'::regnamespace and relname in ('mfr_intel_reports','mfr_dealer_snapshots','mfr_dealer_observations','mfr_intel_events','mfr_intel_holds'))
) x order by n;
