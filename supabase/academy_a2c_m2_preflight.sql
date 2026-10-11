-- =============================================================================================
-- HCPS Academy — A2C M2 PRODUCTION PREFLIGHT (READ-ONLY)     supabase/academy_a2c_m2_preflight.sql
-- Changes nothing: one SELECT that returns one JSON row. Run it in the Supabase SQL editor BEFORE the M2 migration
-- and paste the result back; run it again AFTER M2 — every fingerprint must be identical and only "m2_installed" /
-- "m2_objects" (and content_triggers, which gains academy_content_guard on the 4 content tables) may change.
--   ready_for_m2 = true means: M1 is installed exactly as approved (19 functions, 6 guard triggers, code fingerprint
--   130e45fa… or e70543ba…), M2 is not, the 4 content tables exist, an active President exists, and every Academy
--   switch is off.
-- No emails or other personal details are returned (the President check is a count).
-- =============================================================================================
with
content_tables(t) as (values ('academy_courses'),('academy_course_versions'),('academy_modules'),('academy_lessons')),
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
-- Functions outside the Academy (ordering, sales, CRM …): M2 must not change any of them.
other_funcs_fp as (
  select md5(coalesce(string_agg(p.proname || ':' || pg_get_function_identity_arguments(p.oid) || ':' || md5(p.prosrc), '|'
                                 order by p.proname, pg_get_function_identity_arguments(p.oid)), '')) fp, count(*) n
  from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname not like 'academy\_%'),
-- Inside the Academy: M2 adds triggers and functions only — table grants, policies, columns and RLS must not move.
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
m2_funcs as (
  select coalesce(jsonb_agg(p.proname order by p.proname), '[]') j, count(*) n
  from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_content\_%'),
m2_trigs as (
  select coalesce(jsonb_agg(c.relname order by c.relname), '[]') j, count(*) n
  from pg_trigger t join pg_class c on c.oid = t.tgrelid where t.tgname = 'academy_content_guard'),
content_triggers as (
  select coalesce(jsonb_agg(c.relname || '.' || t.tgname order by c.relname, t.tgname), '[]') j
  from pg_trigger t join pg_class c on c.oid = t.tgrelid
  where not t.tgisinternal and c.relnamespace = 'public'::regnamespace
    and c.relname in ('academy_courses','academy_course_versions','academy_modules','academy_lessons')),
flags as (
  select coalesce((select jsonb_object_agg(k, v) from jsonb_each(value) as e(k, v) where k like 'academy\_%'), '{}') j
  from public.app_settings where key = 'phase2_flags')
select jsonb_build_object(
  'postgres', current_setting('server_version'),
  'ready_for_m2', (select n from m1) = 19 and (select n from m1_trigs) = 6
                  and (select fp from m1) in ('130e45fa36f768e032a89da43b645f8a', 'e70543ba23d96ca7c5aec8eeff0ea341')
                  and (select n from m2_funcs) = 0 and (select n from m2_trigs) = 0
                  and (select count(*) from content_counts where n is null) = 0
                  and exists (select 1 from staff_users where coalesce(active, true) and lower(coalesce(role, '')) = 'president')
                  and not exists (select 1 from flags, jsonb_each(flags.j) e where e.value = 'true'::jsonb),
  'm1', jsonb_build_object('functions', (select n from m1), 'guard_triggers', (select n from m1_trigs), 'code_fingerprint', (select fp from m1)),
  'm2_installed', (select n from m2_funcs) > 0 or (select n from m2_trigs) > 0,
  'm2_objects', jsonb_build_object('functions', (select j from m2_funcs), 'guard_triggers_on', (select j from m2_trigs)),
  'content_rows', (select jsonb_object_agg(t, n) from content_counts),
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
) as academy_a2c_m2_preflight;
