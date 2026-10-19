-- =============================================================================================
-- HCPS Academy — A2F M7 PREFLIGHT (READ-ONLY)    supabase/academy_a2f_m7_preflight.sql
-- Changes nothing. ready_for_m7 must be true: M1 issue/revoke present, M6 installed (13 functions), M7 absent,
-- no HCPS certificate written, academy_certificates switch not on, only academy_admin on among Academy switches.
-- =============================================================================================
select jsonb_build_object(
  'ready_for_m7',
       to_regprocedure('public.academy_op_issue_certificate(text,uuid,text)') is not null
   and to_regprocedure('public.academy_op_revoke_certificate(text,uuid,text)') is not null
   and (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like 'academy\_exam\_%') = 13
   and (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like 'academy\_cert\_%') = 0
   and not exists (select 1 from academy_certificates)
   and coalesce((select value->'academy_certificates' from app_settings where key = 'phase2_flags'), 'false'::jsonb) <> 'true'::jsonb,
  'm6_functions', (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like 'academy\_exam\_%'),
  'm7_functions', (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like 'academy\_cert\_%'),
  'certificates', (select count(*) from academy_certificates),
  'm1_issue_revoke_server', jsonb_build_array(
       has_function_privilege('service_role', 'public.academy_op_issue_certificate(text,uuid,text)', 'EXECUTE'),
       has_function_privilege('service_role', 'public.academy_op_revoke_certificate(text,uuid,text)', 'EXECUTE')),
  'm1_fingerprint', (select md5(string_agg(p.proname || ':' || pg_get_function_identity_arguments(p.oid) || ':' || p.prosrc, '|' order by p.proname))
                     from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('academy_op_issue_certificate','academy_op_revoke_certificate')),
  'presidents_active', (select count(*) from staff_users where coalesce(active, true) and lower(coalesce(role, '')) = 'president'),
  'academy_switches', coalesce((select jsonb_object_agg(k, v) from app_settings, jsonb_each(value) e(k, v) where key = 'phase2_flags' and k like 'academy\_%'), '{}')
) as m7_preflight;
