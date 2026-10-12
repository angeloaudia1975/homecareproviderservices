-- =============================================================================================
-- HCPS Academy — A2D M3 POST-MIGRATION CHECK (READ-ONLY)      supabase/academy_a2d_m3_postcheck.sql
-- Changes nothing. Run right after the migration, and again after the tests. Expected:
--   m3_code_fingerprint  e48e4c2758dae2be0e679c3b9cbe97e8 when installed with the file's own (Unix) line endings, or
--                        9f41ee27d9ea6b271b35ea5ec1a25c7e when pasted into the SQL editor from Windows (every line ending \r\n).
--   start_attempt_fingerprint  c433af0a852d208e9a6047d9e654e612 (Unix) or 4ab3615ae6825feac9ac27feaa09dbe2 (Windows paste): M1's start-attempt, now drawing through M3.
--   m1_except_start_attempt  unchanged: e05951fca31652f7289b1be904cc079a (Unix) or 30a6a689fca7ed63c0c24ce774d514be (the
--                        Windows-pasted M1 that production runs) — the other 18 M1 functions exactly as approved.
--   m2_code_fingerprint  unchanged: f24e4f888c8ed7a4e0765382737dfe35 (or, Windows paste, 794f3c3e007bf3cc6d72b574aac614e3)
--   functions 24 · operations_server_only 12 · helpers_callable_by_server 0 · callable_by_public_keys 0
--   guard_triggers_on and truncate_guard_on: academy_content_refs, academy_media, academy_questions
--   publish_check_on: academy_course_versions · start_attempt server_only true · exam_quota_column true
--   m1_functions 19 · m1_guard_triggers 6 · m2_functions 15 · m2_guard_triggers 8
--   academy_switches: academy_admin true (the President-only pilot), every other one off · rows as in the preflight
-- Any other value = stop and investigate (never roll back on suspicion).
-- =============================================================================================
select jsonb_build_object(
  'm3_code_fingerprint', (select md5(string_agg(p.proname || ':' || pg_get_function_identity_arguments(p.oid) || ':' || p.prosecdef || ':' ||
                              coalesce(array_to_string(p.proconfig, ','), '') || ':' || p.prosrc, '|' order by p.proname))
                          from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_author\_%'),
  'start_attempt_fingerprint', (select md5(p.proname || ':' || pg_get_function_identity_arguments(p.oid) || ':' || p.prosecdef || ':' ||
                              coalesce(array_to_string(p.proconfig, ','), '') || ':' || p.prosrc)
                          from pg_proc p where p.oid = to_regprocedure('public.academy_op_start_attempt(text,uuid)')),
  'm1_except_start_attempt', (select md5(string_agg(p.proname || ':' || pg_get_function_identity_arguments(p.oid) || ':' || p.prosecdef || ':' ||
                              coalesce(array_to_string(p.proconfig, ','), '') || ':' || p.prosrc, '|' order by p.proname))
                          from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname <> 'academy_op_start_attempt'
                            and (p.proname like 'academy\_op\_%' or p.proname = 'academy_audited_guard')),
  'm2_code_fingerprint', (select md5(string_agg(p.proname || ':' || pg_get_function_identity_arguments(p.oid) || ':' || p.prosecdef || ':' ||
                              coalesce(array_to_string(p.proconfig, ','), '') || ':' || p.prosrc, '|' order by p.proname))
                          from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_content\_%'),
  'functions', (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like 'academy\_author\_%'),
  'operations_server_only', (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like 'academy\_author\_op\_%' and prosecdef
                               and has_function_privilege('service_role', oid, 'EXECUTE') and not has_function_privilege('anon', oid, 'EXECUTE')
                               and not has_function_privilege('authenticated', oid, 'EXECUTE')),
  'helpers_callable_by_server', (select count(*) from pg_proc where pronamespace = 'public'::regnamespace
                               and proname like 'academy\_author\_%' and proname not like 'academy\_author\_op\_%'
                               and has_function_privilege('service_role', oid, 'EXECUTE')),
  'callable_by_public_keys', (select count(*) from pg_proc p, unnest(array['anon','authenticated']) r
                               where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_author\_%'
                                 and has_function_privilege(r, p.oid, 'EXECUTE')),
  'guard_triggers_on', (select jsonb_agg(c.relname order by c.relname) from pg_trigger t join pg_class c on c.oid = t.tgrelid where t.tgname = 'academy_author_guard'),
  'truncate_guard_on', (select jsonb_agg(c.relname order by c.relname) from pg_trigger t join pg_class c on c.oid = t.tgrelid where t.tgname = 'academy_author_guard_truncate'),
  'publish_check_on', (select jsonb_agg(c.relname order by c.relname) from pg_trigger t join pg_class c on c.oid = t.tgrelid where t.tgname = 'academy_author_publish_check'),
  'start_attempt', (select jsonb_build_object('draws_through_m3', p.prosrc like '%academy_author_exam_draw(%',
                              'server_only', p.prosecdef and has_function_privilege('service_role', p.oid, 'EXECUTE')
                                and not has_function_privilege('anon', p.oid, 'EXECUTE') and not has_function_privilege('authenticated', p.oid, 'EXECUTE'))
                    from pg_proc p where p.oid = to_regprocedure('public.academy_op_start_attempt(text,uuid)')),
  'exam_quota_column', exists (select 1 from information_schema.columns where table_schema = 'public'
                                 and table_name = 'academy_modules' and column_name = 'exam_quota'),
  'm1_functions', (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and (proname like 'academy\_op\_%' or proname = 'academy_audited_guard')),
  'm1_guard_triggers', (select count(*) from pg_trigger where tgname = 'academy_audited_guard' and not tgisinternal),
  'm2_functions', (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like 'academy\_content\_%'),
  'm2_guard_triggers', (select count(*) from pg_trigger where tgname in ('academy_content_guard', 'academy_content_guard_truncate') and not tgisinternal),
  'academy_switches', coalesce((select jsonb_object_agg(k, v) from app_settings, jsonb_each(value) e(k, v) where key = 'phase2_flags' and k like 'academy\_%'), '{}'),
  'content_rows', jsonb_build_object('academy_courses', (select count(*) from academy_courses), 'academy_course_versions', (select count(*) from academy_course_versions),
                                     'academy_modules', (select count(*) from academy_modules), 'academy_lessons', (select count(*) from academy_lessons),
                                     'academy_questions', (select count(*) from academy_questions), 'academy_media', (select count(*) from academy_media),
                                     'academy_content_refs', (select count(*) from academy_content_refs), 'product_facts', (select count(*) from product_facts)),
  'audit_rows', (select count(*) from academy_events)
) as m3_post_check;
