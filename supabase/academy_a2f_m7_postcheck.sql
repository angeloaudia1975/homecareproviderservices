-- =============================================================================================
-- HCPS Academy — A2F M7 POST-MIGRATION CHECK (READ-ONLY)    supabase/academy_a2f_m7_postcheck.sql
-- Changes nothing. Expected after M7:
--   m7_code_fingerprint  see docs/academy/A2F_CERTIFICATES.md (Unix and Windows-paste forms, both precomputed)
--   m7_functions 5 · m7_server_callable 3 · m7_public_callable 0 · m1_issue_revoke_server false / false
--   certificates_server_writes false · certificates 0 · m1_fingerprint = the preflight value (M1 untouched)
--   academy_switches exactly as in the preflight (academy_certificates NOT on)
-- Any other value = stop and investigate (never roll back on suspicion).
-- =============================================================================================
select jsonb_build_object(
  'm7_code_fingerprint', (select md5(string_agg(p.proname || ':' || pg_get_function_identity_arguments(p.oid) || ':' || p.prosecdef || ':' ||
                              coalesce(array_to_string(p.proconfig, ','), '') || ':' || p.prosrc, '|' order by p.proname))
                          from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_cert\_%'),
  'm7_functions', (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like 'academy\_cert\_%'),
  'm7_server_callable', (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like 'academy\_cert\_%'
                          and has_function_privilege('service_role', oid, 'EXECUTE')),
  'm7_public_callable', (select count(*) from pg_proc p, unnest(array['anon','authenticated']) r where p.pronamespace = 'public'::regnamespace
                          and p.proname like 'academy\_cert\_%' and has_function_privilege(r, p.oid, 'EXECUTE')),
  'm1_issue_revoke_server', jsonb_build_array(
       has_function_privilege('service_role', 'public.academy_op_issue_certificate(text,uuid,text)', 'EXECUTE'),
       has_function_privilege('service_role', 'public.academy_op_revoke_certificate(text,uuid,text)', 'EXECUTE')),
  'certificates_server_writes', has_table_privilege('service_role', 'public.academy_certificates', 'insert')
                          or has_table_privilege('service_role', 'public.academy_certificates', 'update')
                          or has_table_privilege('service_role', 'public.academy_certificates', 'delete'),
  'certificates', (select count(*) from academy_certificates),
  'm1_fingerprint', (select md5(string_agg(p.proname || ':' || pg_get_function_identity_arguments(p.oid) || ':' || p.prosrc, '|' order by p.proname))
                     from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('academy_op_issue_certificate','academy_op_revoke_certificate')),
  'academy_switches', coalesce((select jsonb_object_agg(k, v) from app_settings, jsonb_each(value) e(k, v) where key = 'phase2_flags' and k like 'academy\_%'), '{}')
) as m7_post_check;
