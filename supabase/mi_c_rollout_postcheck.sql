-- MI Phase C (Ship-To review) — post-install metadata check (READ-ONLY). Nothing here writes.
-- Expected installed-code fingerprint (3 functions): ca3e97ff96ae2455b4041c8707750755 (LF) / bdbd7982b108c34886753f7bfa119196
-- (the file pasted into the SQL editor from Windows, CRLF).
select * from (
  select 1 n, 'installed Ship-To code fingerprint (3 functions)' k,
         (select count(*)||' / '||md5(string_agg(proname||':'||md5(prosrc), ',' order by proname)) from pg_proc
           where pronamespace='public'::regnamespace and proname like 'hcps_mfr_shipto_%') v
  union all select 2, 'tables / RLS / policies', (select count(*)||' tables, '||count(*) filter (where relrowsecurity)||' RLS' from pg_class
           where relnamespace='public'::regnamespace and relname in ('mfr_shipto_corrections','mfr_shipto_mappings','mfr_shipto_events'))
           ||', '||(select count(*) from pg_policies where tablename like 'mfr_shipto_%')||' policies'
  union all select 3, 'grants anon / authenticated / PUBLIC (expect 0)', (select count(*)::text from information_schema.role_table_grants
           where table_schema='public' and table_name like 'mfr_shipto_%' and grantee in ('anon','authenticated','PUBLIC'))
  union all select 4, 'mapping account_ref blank refused', (select string_agg(pg_get_constraintdef(oid), '; ') from pg_constraint
           where conrelid='public.mfr_shipto_mappings'::regclass and pg_get_constraintdef(oid) like '%account_ref%')
  union all select 5, 'rows: corrections / mappings / events (expect 0 / 0 / 0)', (select count(*) from public.mfr_shipto_corrections)||' / '||
           (select count(*) from public.mfr_shipto_mappings)||' / '||(select count(*) from public.mfr_shipto_events)
  union all select 6, 'monthly_sales rows / amount / commission (unchanged)', (select count(*)||' / '||sum(amount)||' / '||sum(commission) from public.monthly_sales)
) x order by n;
