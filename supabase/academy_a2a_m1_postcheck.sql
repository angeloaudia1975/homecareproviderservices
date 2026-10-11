-- =============================================================================================
-- HCPS Academy — A2A M1 rev 2 POST-MIGRATION CHECK (READ-ONLY)   supabase/academy_a2a_m1_postcheck.sql
-- Changes nothing. Run right after the migration, and again after the tests. Expected (rev 2, sha256 7253ff80…a864):
--   m1_code_fingerprint 130e45fa36f768e032a89da43b645f8a when installed with the file's own (Unix) line endings, or
--                       e70543ba23d96ca7c5aec8eeff0ea341 when pasted into the SQL editor from Windows (every line ending \r\n).
--                       Both are the approved file byte for byte apart from line endings (verified 10 Oct 2026: the CRLF copy
--                       reproduces e70543ba exactly and passes all 28 + 43 + 27 + 11 tests). Any other value = stop.
--   functions 19 · operations_server_only 11 · helpers_callable_by_server 0 · guard_triggers_on the 6 tables
--   academy_tables_rls_on "18 / 18" · academy_switches {} (or every value false) · academy_rows 0
-- =============================================================================================
select jsonb_build_object(
  'm1_code_fingerprint', (select md5(string_agg(p.proname || ':' || pg_get_function_identity_arguments(p.oid) || ':' || p.prosecdef || ':' ||
                              coalesce(array_to_string(p.proconfig, ','), '') || ':' || p.prosrc, '|' order by p.proname))
                          from pg_proc p where p.pronamespace = 'public'::regnamespace
                            and (p.proname like 'academy\_op\_%' or p.proname = 'academy_audited_guard')),
  'functions', (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and (proname like 'academy\_op\_%' or proname = 'academy_audited_guard')),
  'operations_server_only', (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like 'academy\_op\_%' and prosecdef
                               and has_function_privilege('service_role', oid, 'EXECUTE') and not has_function_privilege('anon', oid, 'EXECUTE')
                               and not has_function_privilege('authenticated', oid, 'EXECUTE')),
  'helpers_callable_by_server', (select count(*) from pg_proc where pronamespace = 'public'::regnamespace
                               and (proname like 'academy\_op\_%' or proname = 'academy_audited_guard') and not prosecdef
                               and has_function_privilege('service_role', oid, 'EXECUTE')),
  'guard_triggers_on', (select jsonb_agg(c.relname order by c.relname) from pg_trigger t join pg_class c on c.oid = t.tgrelid where t.tgname = 'academy_audited_guard'),
  'academy_tables_rls_on', (select count(*) filter (where relrowsecurity) || ' / ' || count(*) from pg_class
                             where relnamespace = 'public'::regnamespace and relkind = 'r' and (relname like 'academy\_%' or relname = 'product_facts')),
  'academy_switches', coalesce((select jsonb_object_agg(k, v) from app_settings, jsonb_each(value) e(k, v) where key = 'phase2_flags' and k like 'academy\_%'), '{}'),
  'academy_rows', (select count(*) from academy_learners) + (select count(*) from academy_memberships) + (select count(*) from academy_invites)
                + (select count(*) from academy_handoff_codes) + (select count(*) from academy_courses) + (select count(*) from academy_course_versions)
                + (select count(*) from academy_modules) + (select count(*) from academy_lessons) + (select count(*) from academy_questions)
                + (select count(*) from academy_media) + (select count(*) from product_facts) + (select count(*) from academy_content_refs)
                + (select count(*) from academy_enrollments) + (select count(*) from academy_progress) + (select count(*) from academy_attempts)
                + (select count(*) from academy_certificates) + (select count(*) from academy_external_certs) + (select count(*) from academy_events)
) as m1_post_check;
