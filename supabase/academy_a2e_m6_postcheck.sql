-- =============================================================================================
-- HCPS Academy — A2E M6 POST-MIGRATION CHECK (READ-ONLY)    supabase/academy_a2e_m6_postcheck.sql
-- Changes nothing. Expected after M6:
--   m6_code_fingerprint  see docs/academy/A2E_EXAMS.md (Unix form and Windows-paste form, both precomputed)
--   m6_functions 11 · m6_server_callable 5 · m6_public_callable 0 · m1_start_submit_server false / false
--   attempts_server_writes false · attempts 0 · version limits present (45 / 60 / 3 defaults)
--   academy_switches exactly as in the preflight (only academy_admin on)
-- Any other value = stop and investigate (never roll back on suspicion).
-- =============================================================================================
select jsonb_build_object(
  'm6_code_fingerprint', (select md5(string_agg(p.proname || ':' || pg_get_function_identity_arguments(p.oid) || ':' || p.prosecdef || ':' ||
                              coalesce(array_to_string(p.proconfig, ','), '') || ':' || p.prosrc, '|' order by p.proname))
                          from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_exam\_%'),
  'm6_functions', (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like 'academy\_exam\_%'),
  'm6_server_callable', (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like 'academy\_exam\_%'
                          and has_function_privilege('service_role', oid, 'EXECUTE')),
  'm6_public_callable', (select count(*) from pg_proc p, unnest(array['anon','authenticated']) r where p.pronamespace = 'public'::regnamespace
                          and p.proname like 'academy\_exam\_%' and has_function_privilege(r, p.oid, 'EXECUTE')),
  'm1_start_submit_server', jsonb_build_array(
                          has_function_privilege('service_role', 'public.academy_op_start_attempt(text,uuid)', 'EXECUTE'),
                          has_function_privilege('service_role', 'public.academy_op_submit_attempt(text,uuid,jsonb)', 'EXECUTE')),
  'attempts_server_writes', has_table_privilege('service_role', 'public.academy_attempts', 'insert')
                          or has_table_privilege('service_role', 'public.academy_attempts', 'update')
                          or has_table_privilege('service_role', 'public.academy_attempts', 'delete'),
  'attempts', (select count(*) from academy_attempts),
  'version_limits', (select jsonb_agg(jsonb_build_object('version', id, 'status', status, 'time_limit', exam_time_limit_minutes,
                          'cooldown', exam_cooldown_minutes, 'daily', exam_daily_limit) order by created_at) from academy_course_versions),
  'trigger', (select count(*) from pg_trigger where tgname = 'academy_exam_attempt_defaults' and not tgisinternal),
  'academy_switches', coalesce((select jsonb_object_agg(k, v) from app_settings, jsonb_each(value) e(k, v) where key = 'phase2_flags' and k like 'academy\_%'), '{}')
) as m6_post_check;
