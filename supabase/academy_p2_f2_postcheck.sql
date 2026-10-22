-- HCPS Academy — Phase 2 / F2 POSTCHECK (read-only). Every ok must be true; compare the fingerprint with the runbook.
select 'code fingerprint (5 academy_ext_ functions)' as check,
       (select md5(string_agg(p.proname || ':' || p.prosrc, '|' order by p.proname)) from pg_proc p
         where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_ext\_%') as value,
       (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_ext\_%') = 5 as ok
union all
select 'program details private', null,
       (select c.relrowsecurity and not exists (select 1 from pg_policy where polrelid = c.oid)
               and not has_table_privilege('anon', c.oid, 'select') and not has_table_privilege('authenticated', c.oid, 'select')
          from pg_class c where c.oid = 'public.academy_program_details'::regclass)
union all
select 'operations server-only', null,
       (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_ext\_op\_%'
          and has_function_privilege('service_role', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')
          and not has_function_privilege('authenticated', p.oid, 'execute')) = 3
union all
select 'program pages saved', (select count(*)::text from academy_program_details), true
union all
select 'certificate uploads switch', (select coalesce(value->>'academy_external_uploads', 'absent') from app_settings where key = 'phase2_flags'), true;
