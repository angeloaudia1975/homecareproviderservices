-- =============================================================================================
-- HCPS Academy — A2B M5 POST-MIGRATION CHECK (READ-ONLY)    supabase/academy_a2b_m5_postcheck.sql
-- Changes nothing. Run before the migration (as a preflight: m5_functions 0) and right after it. Expected after:
--   m5_code_fingerprint  8ab570555eef51cd5220112e13655df3 when installed with the file's own (Unix) line endings, or
--                        cec33a5ea861887b077d78b0f545b50c when pasted into the SQL editor from Windows (every line ending \r\n)
--   m1 / m2 / m3 / m3_1 / m4 code fingerprints unchanged from the preflight
--   m5_functions 22 · m5_server_callable 15 · m5_public_callable 0 · new tables RLS on, 0 policies
--   learner_rows all 0 · academy_switches exactly as in the preflight (only academy_admin on; the six learner switches off)
-- Any other value = stop and investigate (never roll back on suspicion).
-- =============================================================================================
select jsonb_build_object(
  'm5_code_fingerprint', (select md5(string_agg(p.proname || ':' || pg_get_function_identity_arguments(p.oid) || ':' || p.prosecdef || ':' ||
                              coalesce(array_to_string(p.proconfig, ','), '') || ':' || p.prosrc, '|' order by p.proname))
                          from pg_proc p where p.pronamespace = 'public'::regnamespace
                           and (p.proname like 'academy\_access\_%' or p.proname like 'academy\_enroll\_op\_%' or p.proname like 'academy\_progress\_op\_%')),
  'm1_code_fingerprint', (select md5(string_agg(p.proname || ':' || pg_get_function_identity_arguments(p.oid) || ':' || p.prosecdef || ':' ||
                              coalesce(array_to_string(p.proconfig, ','), '') || ':' || p.prosrc, '|' order by p.proname))
                          from pg_proc p where p.pronamespace = 'public'::regnamespace and (p.proname like 'academy\_op\_%' or p.proname = 'academy_audited_guard')),
  'm2_code_fingerprint', (select md5(string_agg(p.proname || ':' || pg_get_function_identity_arguments(p.oid) || ':' || p.prosecdef || ':' ||
                              coalesce(array_to_string(p.proconfig, ','), '') || ':' || p.prosrc, '|' order by p.proname))
                          from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_content\_%'),
  'm3_code_fingerprint', (select md5(string_agg(p.proname || ':' || pg_get_function_identity_arguments(p.oid) || ':' || p.prosecdef || ':' ||
                              coalesce(array_to_string(p.proconfig, ','), '') || ':' || p.prosrc, '|' order by p.proname))
                          from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_author\_%'),
  'm3_1_code_fingerprint', (select md5(string_agg(p.proname || ':' || pg_get_function_identity_arguments(p.oid) || ':' || p.prosecdef || ':' ||
                              coalesce(array_to_string(p.proconfig, ','), '') || ':' || p.prosrc, '|' order by p.proname))
                          from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_save\_%'),
  'm4_code_fingerprint', (select md5(string_agg(p.proname || ':' || pg_get_function_identity_arguments(p.oid) || ':' || p.prosecdef || ':' ||
                              coalesce(array_to_string(p.proconfig, ','), '') || ':' || p.prosrc, '|' order by p.proname))
                          from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_publish\_%'),
  'm5_functions', (select count(*) from pg_proc where pronamespace = 'public'::regnamespace
                    and (proname like 'academy\_access\_%' or proname like 'academy\_enroll\_op\_%' or proname like 'academy\_progress\_op\_%')),
  'm5_server_callable', (select count(*) from pg_proc where pronamespace = 'public'::regnamespace
                    and (proname like 'academy\_access\_%' or proname like 'academy\_enroll\_op\_%' or proname like 'academy\_progress\_op\_%')
                    and has_function_privilege('service_role', oid, 'EXECUTE')),
  'm5_public_callable', (select count(*) from pg_proc p, unnest(array['anon','authenticated']) r where p.pronamespace = 'public'::regnamespace
                    and (p.proname like 'academy\_access\_%' or p.proname like 'academy\_enroll\_op\_%' or p.proname like 'academy\_progress\_op\_%')
                    and has_function_privilege(r, p.oid, 'EXECUTE')),
  'new_tables', (select jsonb_object_agg(c.relname, jsonb_build_object('rls', c.relrowsecurity,
                    'policies', (select count(*) from pg_policy where polrelid = c.oid),
                    'anon_or_authenticated', has_table_privilege('anon', c.oid, 'select') or has_table_privilege('authenticated', c.oid, 'select')))
                  from pg_class c where c.oid in (to_regclass('public.academy_login_codes'), to_regclass('public.academy_sessions'))),
  'server_writes_learner_tables', (select count(*) from unnest(array['academy_learners','academy_memberships','academy_invites','academy_handoff_codes',
                    'academy_enrollments','academy_progress','academy_login_codes','academy_sessions']) t
                  where to_regclass('public.' || t) is not null
                    and (has_table_privilege('service_role', 'public.' || t, 'insert') or has_table_privilege('service_role', 'public.' || t, 'update')
                         or has_table_privilege('service_role', 'public.' || t, 'delete'))),
  'learner_rows', jsonb_build_object('academy_learners', (select count(*) from academy_learners), 'academy_memberships', (select count(*) from academy_memberships),
                    'academy_invites', (select count(*) from academy_invites), 'academy_enrollments', (select count(*) from academy_enrollments),
                    'academy_progress', (select count(*) from academy_progress), 'academy_handoff_codes', (select count(*) from academy_handoff_codes)),
  'academy_switches', coalesce((select jsonb_object_agg(k, v) from app_settings, jsonb_each(value) e(k, v) where key = 'phase2_flags' and k like 'academy\_%'), '{}'),
  'golden_version_status', (select status from academy_course_versions where id = '34a4ed42-5c62-4f04-bffc-2a4341182bea'),
  'audit_rows', (select count(*) from academy_events)
) as m5_post_check;
