-- =============================================================================================
-- HCPS Academy — A2D M3.1 PRODUCTION PREFLIGHT (READ-ONLY)    supabase/academy_a2d_m3_1_preflight.sql
-- Changes nothing: one SELECT that returns one JSON row. Run it in the Supabase SQL editor BEFORE the M3.1 migration and
-- paste the result back; run it again AFTER M3.1 and after the acceptance tests — every value must be identical except
-- "m3_1_installed" (false -> true), "m3_1_objects" (gains academy_save_lesson_links and academy_save_op_lesson) and
-- "ready_for_m3_1" (true -> false, because M3.1 is then installed).
--   ready_for_m3_1 = true means: M1 as it stands after M3 (19 functions, 6 guard triggers, fingerprint 2802eaad… or
--   a809004b…), M2 as approved (15 functions, 8 guard triggers, f24e4f88… or 794f3c3e…), M3 as installed (24 functions,
--   7 triggers, e48e4c27… or 9f41ee27…), no M3.1 object yet, the content tables exist, an active President exists, and
--   every Academy switch except academy_admin (the President-only pilot) is off.
-- Real Academy content (the Golden draft) is expected: lessons_fingerprint and content_refs_fingerprint record it, and
-- the migration and the acceptance tests must leave both unchanged.
-- No emails or other personal details are returned (the President check is a count).
-- =============================================================================================
with
content_tables(t) as (values ('academy_courses'),('academy_course_versions'),('academy_modules'),('academy_lessons'),
  ('academy_questions'),('academy_media'),('academy_content_refs'),('product_facts')),
content_counts as (
  select t, case when to_regclass('public.' || t) is null then null
    else (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', t), false, true, '')))[1]::text::bigint end as n
  from content_tables),
key_tables(t) as (values ('dealers'),('dealer_users'),('staff_users'),('manufacturers'),('app_settings'),
  ('orders'),('order_items'),('monthly_sales'),('product_content'),('product_content_sources'),
  ('product_content_history'),('product_media'),('email_queue'),('email_sends'),('email_optout'),('commission_splits')),
counts as (
  select t, case when to_regclass('public.' || t) is null then null
    else (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', t), false, true, '')))[1]::text::bigint end as n
  from key_tables),
-- Outside the Academy: the same fingerprints the A1 and M1 preflights recorded.
grants_fp as (
  select md5(coalesce(string_agg(table_name || ':' || grantee || ':' || privilege_type, ',' order by table_name, grantee, privilege_type), '')) fp, count(*) n
  from information_schema.role_table_grants
  where table_schema = 'public' and table_name not like 'academy\_%' and table_name not like 'product\_facts%'),
policies_fp as (
  select md5(coalesce(string_agg(schemaname || '.' || tablename || ':' || policyname || ':' || cmd || ':' || coalesce(qual,'') || ':' || coalesce(with_check,''),
                                 ',' order by schemaname, tablename, policyname), '')) fp, count(*) n
  from pg_policies where schemaname in ('public','storage') and tablename not like 'academy\_%' and tablename not like 'product\_facts%'),
tables_fp as (
  select md5(coalesce(string_agg(table_name || ':' || column_name || ':' || data_type, ',' order by table_name, ordinal_position), '')) fp,
         count(distinct table_name) n
  from information_schema.columns
  where table_schema = 'public' and table_name not like 'academy\_%' and table_name not like 'product\_facts%'),
-- Functions outside the Academy (ordering, sales, CRM …): M3 must not change any of them.
other_funcs_fp as (
  select md5(coalesce(string_agg(p.proname || ':' || pg_get_function_identity_arguments(p.oid) || ':' || md5(p.prosrc), '|'
                                 order by p.proname, pg_get_function_identity_arguments(p.oid)), '')) fp, count(*) n
  from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname not like 'academy\_%'),
-- Inside the Academy: M3 adds triggers, functions and ONE column (academy_modules.exam_quota, reported apart) — table grants,
-- policies, the other columns and RLS must not move.
a_grants_fp as (
  select md5(coalesce(string_agg(table_name || ':' || grantee || ':' || privilege_type, ',' order by table_name, grantee, privilege_type), '')) fp, count(*) n
  from information_schema.role_table_grants
  where table_schema = 'public' and (table_name like 'academy\_%' or table_name like 'product\_facts%')),
a_policies_fp as (
  select md5(coalesce(string_agg(tablename || ':' || policyname, ',' order by tablename, policyname), '')) fp, count(*) n
  from pg_policies where schemaname = 'public' and (tablename like 'academy\_%' or tablename like 'product\_facts%')),
a_columns_fp as (
  select md5(coalesce(string_agg(table_name || ':' || column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default,''),
                                 ',' order by table_name, ordinal_position), '')) fp, count(*) n
  from information_schema.columns
  where table_schema = 'public' and (table_name like 'academy\_%' or table_name like 'product\_facts%')),
a_rls as (
  select count(*) filter (where c.relrowsecurity) on_, count(*) all_
  from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
    and (c.relname like 'academy\_%' or c.relname like 'product\_facts%')),
m1 as (
  select count(*) n,
         md5(string_agg(p.proname || ':' || pg_get_function_identity_arguments(p.oid) || ':' || p.prosecdef || ':' ||
             coalesce(array_to_string(p.proconfig, ','), '') || ':' || p.prosrc, '|' order by p.proname)) fp
  from pg_proc p where p.pronamespace = 'public'::regnamespace and (p.proname like 'academy\_op\_%' or p.proname = 'academy_audited_guard')),
m1_trigs as (select count(*) n from pg_trigger where tgname = 'academy_audited_guard' and not tgisinternal),
m2 as (
  select count(*) n,
         md5(string_agg(p.proname || ':' || pg_get_function_identity_arguments(p.oid) || ':' || p.prosecdef || ':' ||
             coalesce(array_to_string(p.proconfig, ','), '') || ':' || p.prosrc, '|' order by p.proname)) fp
  from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_content\_%'),
m2_trigs as (select count(*) n from pg_trigger where tgname in ('academy_content_guard', 'academy_content_guard_truncate') and not tgisinternal),
m3_funcs as (
  select coalesce(jsonb_agg(p.proname order by p.proname), '[]') j, count(*) n
  from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_author\_%'),
m3_fp as (
  select md5(string_agg(p.proname || ':' || pg_get_function_identity_arguments(p.oid) || ':' || p.prosecdef || ':' ||
             coalesce(array_to_string(p.proconfig, ','), '') || ':' || p.prosrc, '|' order by p.proname)) fp
  from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_author\_%'),
m31_funcs as (
  select coalesce(jsonb_agg(p.proname order by p.proname), '[]') j, count(*) n
  from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_save\_%'),
m3_trigs as (
  select coalesce(jsonb_agg(c.relname || '.' || t.tgname order by c.relname, t.tgname), '[]') j, count(*) n
  from pg_trigger t join pg_class c on c.oid = t.tgrelid where t.tgname like 'academy\_author\_%' and not t.tgisinternal),
start_attempt as (
  select md5(p.proname || ':' || pg_get_function_identity_arguments(p.oid) || ':' || p.prosecdef || ':' ||
             coalesce(array_to_string(p.proconfig, ','), '') || ':' || p.prosrc) fp,
         p.prosrc like '%academy_author_exam_draw(%' m3_draw,
         has_function_privilege('service_role', p.oid, 'EXECUTE') server,
         has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE') public_keys
  from pg_proc p where p.oid = to_regprocedure('public.academy_op_start_attempt(text,uuid)')),
content_triggers as (
  select coalesce(jsonb_agg(c.relname || '.' || t.tgname order by c.relname, t.tgname), '[]') j
  from pg_trigger t join pg_class c on c.oid = t.tgrelid
  where not t.tgisinternal and c.relnamespace = 'public'::regnamespace
    and c.relname in ('academy_courses','academy_course_versions','academy_modules','academy_lessons',
                      'academy_questions','academy_media','academy_content_refs')),
flags as (
  select coalesce((select jsonb_object_agg(k, v) from jsonb_each(value) as e(k, v) where k like 'academy\_%'), '{}') j
  from public.app_settings where key = 'phase2_flags')
select jsonb_build_object(
  'postgres', current_setting('server_version'),
  'ready_for_m3_1', (select n from m1) = 19 and (select n from m1_trigs) = 6
                  and (select fp from m1) in ('2802eaad1697750470f840f4b90d68d9', 'a809004b8fe77dce69cfc555ff984bdb')
                  and (select n from m2) = 15 and (select n from m2_trigs) = 8
                  and (select fp from m2) in ('f24e4f888c8ed7a4e0765382737dfe35', '794f3c3e007bf3cc6d72b574aac614e3')
                  and (select n from m3_funcs) = 24 and (select n from m3_trigs) = 7
                  and (select fp from m3_fp) in ('e48e4c2758dae2be0e679c3b9cbe97e8', '9f41ee27d9ea6b271b35ea5ec1a25c7e')
                  and (select n from m31_funcs) = 0
                  and (select count(*) from content_counts where n is null) = 0
                  and exists (select 1 from staff_users where coalesce(active, true) and lower(coalesce(role, '')) = 'president')
                  and not exists (select 1 from flags, jsonb_each(flags.j) e where e.value = 'true'::jsonb and e.key <> 'academy_admin'),
  'm1', jsonb_build_object('functions', (select n from m1), 'guard_triggers', (select n from m1_trigs), 'code_fingerprint', (select fp from m1)),
  'm2', jsonb_build_object('functions', (select n from m2), 'guard_triggers', (select n from m2_trigs), 'code_fingerprint', (select fp from m2)),
  'm3', jsonb_build_object('functions', (select n from m3_funcs), 'triggers', (select n from m3_trigs), 'code_fingerprint', (select fp from m3_fp)),
  'start_attempt', (select jsonb_build_object('fingerprint', fp, 'draws_through_m3', m3_draw, 'server', server, 'public_keys', public_keys) from start_attempt),
  'm3_1_installed', (select n from m31_funcs) > 0,
  'm3_1_objects', (select j from m31_funcs),
  'content_rows', (select jsonb_object_agg(t, n) from content_counts),
  'lessons_fingerprint', (select md5(coalesce(string_agg(id::text || ':' || blocks::text, ',' order by id), '')) from academy_lessons),
  'content_refs_fingerprint', (select md5(coalesce(string_agg(id::text || ':' || coalesce(lesson_id::text, '-') || ':' || coalesce(question_id::text, '-') || ':' ||
                                manufacturer_slug || ':' || model_code || ':' || coalesce(field, '-'), ',' order by id), '')) from academy_content_refs),
  'audit_rows', (select count(*) from academy_events),
  'content_triggers', (select j from content_triggers),
  'active_presidents', (select count(*) from staff_users where coalesce(active, true) and lower(coalesce(role, '')) = 'president'),
  'academy_switches', (select coalesce((select j from flags), '{}')),
  'academy_fingerprints', jsonb_build_object(
     'grants', (select fp || ' / ' || n from a_grants_fp),
     'policies', (select fp || ' / ' || n from a_policies_fp),
     'columns', (select fp || ' / ' || n from a_columns_fp),
     'rls_on', (select on_ || ' / ' || all_ || ' tables' from a_rls)),
  'fingerprints', jsonb_build_object(
     'grants', (select fp || ' / ' || n from grants_fp),
     'policies', (select fp || ' / ' || n from policies_fp),
     'columns', (select fp || ' / ' || n || ' tables' from tables_fp),
     'other_functions', (select fp || ' / ' || n from other_funcs_fp),
     'row_counts', (select jsonb_object_agg(t, n) from counts))
) as academy_a2d_m3_1_preflight;
