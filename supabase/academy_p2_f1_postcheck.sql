-- HCPS Academy — Phase 2 / F1 POSTCHECK (read-only). Run after academy_p2_f1_free_access.sql; every row must read ok = true.
-- The code fingerprint covers the 4 F1 operations, the no-checkout trigger function and the two M8 functions F1 replaces.
-- Expected fingerprint: see docs/academy/P2_F1_FREE_LAUNCH.md (Unix and Windows-paste forms).
select 'code fingerprint' as check,
       (select md5(string_agg(p.proname || ':' || p.prosrc, '|' order by p.proname)) from pg_proc p
         where p.pronamespace = 'public'::regnamespace
           and (p.proname like 'academy\_free\_%' or p.proname in ('academy_purchase_dealer_eligible', 'academy_purchase_member_guard'))) as value,
       (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_free\_%') = 5 as ok
union all
select 'tables private (RLS on, no policies, server SELECT only, public none)',
       null,
       (select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname in ('academy_course_access','academy_free_registrations')
          and c.relrowsecurity and not exists (select 1 from pg_policy where polrelid = c.oid)
          and has_table_privilege('service_role', c.oid, 'select') and not has_table_privilege('service_role', c.oid, 'insert')
          and not has_table_privilege('anon', c.oid, 'select') and not has_table_privilege('authenticated', c.oid, 'select')) = 2
union all
select 'operations: server only', null,
       (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_free\_op\_%'
          and has_function_privilege('service_role', p.oid, 'execute')
          and not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('authenticated', p.oid, 'execute')) = 4
union all
select 'eligibility helper not callable by the server or public', null,
       not has_function_privilege('service_role', 'public.academy_purchase_dealer_eligible(uuid)', 'execute')
   and not has_function_privilege('anon', 'public.academy_purchase_dealer_eligible(uuid)', 'execute')
union all
select 'no-checkout trigger enabled on academy_purchases', null,
       exists (select 1 from pg_trigger where tgname = 'academy_free_no_checkout' and tgenabled = 'O' and tgrelid = 'public.academy_purchases'::regclass)
union all
select 'access policies (expect 0 before the President sets one)', (select count(*)::text from academy_course_access), true
union all
select 'free enrollments', (select count(*)::text from academy_enrollments where access_source = 'free'), true
union all
select 'M8 purchases unchanged (count by status)', (select string_agg(status || '=' || n, ', ' order by status) from (select status, count(*) n from academy_purchases group by status) s), true;
