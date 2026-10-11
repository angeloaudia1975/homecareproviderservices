-- =============================================================================================
-- HCPS Academy — A2C M2 POST-MIGRATION CHECK (READ-ONLY)     supabase/academy_a2c_m2_postcheck.sql
-- Changes nothing. Run right after the migration, and again after the tests. Expected:
--   m2_code_fingerprint  f24e4f888c8ed7a4e0765382737dfe35 when installed with the file's own (Unix) line endings, or
--                        794f3c3e007bf3cc6d72b574aac614e3 when pasted into the SQL editor from Windows (every line ending \r\n).
--                        Both are the approved file byte for byte apart from line endings. Any other value = stop.
--   m1_code_fingerprint  unchanged: 130e45fa36f768e032a89da43b645f8a (or e70543ba23d96ca7c5aec8eeff0ea341)
--   functions 15 · operations_server_only 11 · helpers_callable_by_server 0 · callable_by_public_keys 0
--   guard_triggers_on and truncate_guard_on: the 4 content tables · m1_functions 19 · m1_guard_triggers 6
--   academy_switches {} (or every value false) · content_rows and audit_rows as in the preflight
-- =============================================================================================
select jsonb_build_object(
  'm2_code_fingerprint', (select md5(string_agg(p.proname || ':' || pg_get_function_identity_arguments(p.oid) || ':' || p.prosecdef || ':' ||
                              coalesce(array_to_string(p.proconfig, ','), '') || ':' || p.prosrc, '|' order by p.proname))
                          from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_content\_%'),
  'm1_code_fingerprint', (select md5(string_agg(p.proname || ':' || pg_get_function_identity_arguments(p.oid) || ':' || p.prosecdef || ':' ||
                              coalesce(array_to_string(p.proconfig, ','), '') || ':' || p.prosrc, '|' order by p.proname))
                          from pg_proc p where p.pronamespace = 'public'::regnamespace
                            and (p.proname like 'academy\_op\_%' or p.proname = 'academy_audited_guard')),
  'functions', (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like 'academy\_content\_%'),
  'operations_server_only', (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like 'academy\_content\_op\_%' and prosecdef
                               and has_function_privilege('service_role', oid, 'EXECUTE') and not has_function_privilege('anon', oid, 'EXECUTE')
                               and not has_function_privilege('authenticated', oid, 'EXECUTE')),
  'helpers_callable_by_server', (select count(*) from pg_proc where pronamespace = 'public'::regnamespace
                               and proname like 'academy\_content\_%' and not prosecdef and has_function_privilege('service_role', oid, 'EXECUTE')),
  'callable_by_public_keys', (select count(*) from pg_proc p, unnest(array['anon','authenticated']) r
                               where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_content\_%'
                                 and has_function_privilege(r, p.oid, 'EXECUTE')),
  'guard_triggers_on', (select jsonb_agg(c.relname order by c.relname) from pg_trigger t join pg_class c on c.oid = t.tgrelid where t.tgname = 'academy_content_guard'),
  'truncate_guard_on', (select jsonb_agg(c.relname order by c.relname) from pg_trigger t join pg_class c on c.oid = t.tgrelid where t.tgname = 'academy_content_guard_truncate'),
  'm1_functions', (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and (proname like 'academy\_op\_%' or proname = 'academy_audited_guard')),
  'm1_guard_triggers', (select count(*) from pg_trigger where tgname = 'academy_audited_guard' and not tgisinternal),
  'academy_switches', coalesce((select jsonb_object_agg(k, v) from app_settings, jsonb_each(value) e(k, v) where key = 'phase2_flags' and k like 'academy\_%'), '{}'),
  'content_rows', jsonb_build_object('academy_courses', (select count(*) from academy_courses), 'academy_course_versions', (select count(*) from academy_course_versions),
                                     'academy_modules', (select count(*) from academy_modules), 'academy_lessons', (select count(*) from academy_lessons)),
  'audit_rows', (select count(*) from academy_events)
) as m2_post_check;
