-- =============================================================================================
-- HCPS Academy — A2D M3.1 POST-MIGRATION CHECK (READ-ONLY)    supabase/academy_a2d_m3_1_postcheck.sql
-- Changes nothing. Run right after the migration, and again after the acceptance tests. Expected:
--   m3_1_code_fingerprint  17088d8189f50faa7662f6cec4899825 when installed with the file's own (Unix) line endings, or
--                          1306b90bb29549c2c1e2aec0428cdb0f when pasted into the SQL editor from Windows (every line ending \r\n).
--   m3_code_fingerprint   unchanged: e48e4c2758dae2be0e679c3b9cbe97e8 (Unix) or 9f41ee27d9ea6b271b35ea5ec1a25c7e (Windows paste)
--   m1_code_fingerprint   unchanged: 2802eaad1697750470f840f4b90d68d9 (Unix) or a809004b8fe77dce69cfc555ff984bdb (Windows paste)
--   m2_code_fingerprint   unchanged: f24e4f888c8ed7a4e0765382737dfe35 (Unix) or 794f3c3e007bf3cc6d72b574aac614e3 (Windows paste)
--   functions 2 · operation_server_only true · helper_callable_by_server false · callable_by_public_keys 0
--   m1_functions 19 · m1_guard_triggers 6 · m2_functions 15 · m2_guard_triggers 8 · m3_functions 24 · m3_triggers 7
--   academy_switches: academy_admin true, every other one off · content rows, lessons_fingerprint and
--   content_refs_fingerprint exactly as in the preflight (the migration writes no row).
-- Any other value = stop and investigate (never roll back on suspicion).
-- =============================================================================================
select jsonb_build_object(
  'm3_1_code_fingerprint', (select md5(string_agg(p.proname || ':' || pg_get_function_identity_arguments(p.oid) || ':' || p.prosecdef || ':' ||
                              coalesce(array_to_string(p.proconfig, ','), '') || ':' || p.prosrc, '|' order by p.proname))
                          from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_save\_%'),
  'm3_code_fingerprint', (select md5(string_agg(p.proname || ':' || pg_get_function_identity_arguments(p.oid) || ':' || p.prosecdef || ':' ||
                              coalesce(array_to_string(p.proconfig, ','), '') || ':' || p.prosrc, '|' order by p.proname))
                          from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_author\_%'),
  'm1_code_fingerprint', (select md5(string_agg(p.proname || ':' || pg_get_function_identity_arguments(p.oid) || ':' || p.prosecdef || ':' ||
                              coalesce(array_to_string(p.proconfig, ','), '') || ':' || p.prosrc, '|' order by p.proname))
                          from pg_proc p where p.pronamespace = 'public'::regnamespace and (p.proname like 'academy\_op\_%' or p.proname = 'academy_audited_guard')),
  'm2_code_fingerprint', (select md5(string_agg(p.proname || ':' || pg_get_function_identity_arguments(p.oid) || ':' || p.prosecdef || ':' ||
                              coalesce(array_to_string(p.proconfig, ','), '') || ':' || p.prosrc, '|' order by p.proname))
                          from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_content\_%'),
  'functions', (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like 'academy\_save\_%'),
  'operation_server_only', (select prosecdef and has_function_privilege('service_role', oid, 'EXECUTE')
                               and not has_function_privilege('anon', oid, 'EXECUTE') and not has_function_privilege('authenticated', oid, 'EXECUTE')
                             from pg_proc where oid = to_regprocedure('public.academy_save_op_lesson(text,uuid,jsonb,jsonb)')),
  'helper_callable_by_server', (select has_function_privilege('service_role', oid, 'EXECUTE')
                             from pg_proc where oid = to_regprocedure('public.academy_save_lesson_links(jsonb)')),
  'callable_by_public_keys', (select count(*) from pg_proc p, unnest(array['anon','authenticated']) r
                               where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_save\_%'
                                 and has_function_privilege(r, p.oid, 'EXECUTE')),
  'm1_functions', (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and (proname like 'academy\_op\_%' or proname = 'academy_audited_guard')),
  'm1_guard_triggers', (select count(*) from pg_trigger where tgname = 'academy_audited_guard' and not tgisinternal),
  'm2_functions', (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like 'academy\_content\_%'),
  'm2_guard_triggers', (select count(*) from pg_trigger where tgname in ('academy_content_guard', 'academy_content_guard_truncate') and not tgisinternal),
  'm3_functions', (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like 'academy\_author\_%'),
  'm3_triggers', (select count(*) from pg_trigger where tgname like 'academy\_author\_%' and not tgisinternal),
  'academy_switches', coalesce((select jsonb_object_agg(k, v) from app_settings, jsonb_each(value) e(k, v) where key = 'phase2_flags' and k like 'academy\_%'), '{}'),
  'content_rows', jsonb_build_object('academy_courses', (select count(*) from academy_courses), 'academy_course_versions', (select count(*) from academy_course_versions),
                                     'academy_modules', (select count(*) from academy_modules), 'academy_lessons', (select count(*) from academy_lessons),
                                     'academy_questions', (select count(*) from academy_questions), 'academy_media', (select count(*) from academy_media),
                                     'academy_content_refs', (select count(*) from academy_content_refs), 'product_facts', (select count(*) from product_facts)),
  'lessons_fingerprint', (select md5(coalesce(string_agg(id::text || ':' || blocks::text, ',' order by id), '')) from academy_lessons),
  'content_refs_fingerprint', (select md5(coalesce(string_agg(id::text || ':' || coalesce(lesson_id::text, '-') || ':' || coalesce(question_id::text, '-') || ':' ||
                                manufacturer_slug || ':' || model_code || ':' || coalesce(field, '-'), ',' order by id), '')) from academy_content_refs),
  'audit_rows', (select count(*) from academy_events)
) as m3_1_post_check;
