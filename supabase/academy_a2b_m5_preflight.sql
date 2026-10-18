-- =============================================================================================
-- HCPS Academy — A2B M5 PRODUCTION PREFLIGHT (READ-ONLY)    supabase/academy_a2b_m5_preflight.sql
-- Changes nothing: one SELECT returning one JSON row. Run it BEFORE the M5 migration and paste the result back; run it
-- again AFTER M5. Every "outside_*" value and every M1–M4 fingerprint must be identical before and after. Expected to
-- change (and only these): ready_for_m5 (true -> false), m5_installed (false -> true), academy_grants / academy_columns /
-- academy_tables (M5 adds 2 tables, 2 columns on academy_login_codes, an email index, and takes INSERT/UPDATE/DELETE on
-- the 8 learner-side tables from the server role).
--   ready_for_m5 = true means: M1, M2, M3, M3.1 and M4 are installed; M5 is not; dealer_users and dealers.is_test exist;
--   no learner records exist; an active President exists; every Academy switch except academy_admin is off.
-- No personal details are returned (counts and fingerprints only).
-- =============================================================================================
with
fp(kind, n, fp) as (
  select 'm1', count(*), md5(string_agg(p.proname || ':' || pg_get_function_identity_arguments(p.oid) || ':' || p.prosecdef || ':' ||
           coalesce(array_to_string(p.proconfig, ','), '') || ':' || p.prosrc, '|' order by p.proname))
    from pg_proc p where p.pronamespace = 'public'::regnamespace and (p.proname like 'academy\_op\_%' or p.proname = 'academy_audited_guard')
  union all
  select 'm2', count(*), md5(string_agg(p.proname || ':' || pg_get_function_identity_arguments(p.oid) || ':' || p.prosecdef || ':' ||
           coalesce(array_to_string(p.proconfig, ','), '') || ':' || p.prosrc, '|' order by p.proname))
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_content\_%'
  union all
  select 'm3', count(*), md5(string_agg(p.proname || ':' || pg_get_function_identity_arguments(p.oid) || ':' || p.prosecdef || ':' ||
           coalesce(array_to_string(p.proconfig, ','), '') || ':' || p.prosrc, '|' order by p.proname))
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_author\_%'
  union all
  select 'm3_1', count(*), md5(string_agg(p.proname || ':' || pg_get_function_identity_arguments(p.oid) || ':' || p.prosecdef || ':' ||
           coalesce(array_to_string(p.proconfig, ','), '') || ':' || p.prosrc, '|' order by p.proname))
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_save\_%'
  union all
  select 'm4', count(*), md5(string_agg(p.proname || ':' || pg_get_function_identity_arguments(p.oid) || ':' || p.prosecdef || ':' ||
           coalesce(array_to_string(p.proconfig, ','), '') || ':' || p.prosrc, '|' order by p.proname))
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_publish\_%'
  union all
  select 'm5', count(*), md5(string_agg(p.proname || ':' || pg_get_function_identity_arguments(p.oid) || ':' || p.prosecdef || ':' ||
           coalesce(array_to_string(p.proconfig, ','), '') || ':' || p.prosrc, '|' order by p.proname))
    from pg_proc p where p.pronamespace = 'public'::regnamespace
     and (p.proname like 'academy\_access\_%' or p.proname like 'academy\_enroll\_op\_%' or p.proname like 'academy\_progress\_op\_%')),
outside_grants as (
  select md5(coalesce(string_agg(table_name || ':' || grantee || ':' || privilege_type, ',' order by table_name, grantee, privilege_type), '')) fp, count(*) n
  from information_schema.role_table_grants
  where table_schema = 'public' and table_name not like 'academy\_%' and table_name not like 'product\_facts%'),
outside_policies as (
  select md5(coalesce(string_agg(schemaname || '.' || tablename || ':' || policyname || ':' || cmd || ':' || coalesce(qual,'') || ':' || coalesce(with_check,''),
                                 ',' order by schemaname, tablename, policyname), '')) fp, count(*) n
  from pg_policies where schemaname in ('public','storage') and tablename not like 'academy\_%' and tablename not like 'product\_facts%'),
outside_columns as (
  select md5(coalesce(string_agg(table_name || ':' || column_name || ':' || data_type, ',' order by table_name, ordinal_position), '')) fp,
         count(distinct table_name) n
  from information_schema.columns
  where table_schema = 'public' and table_name not like 'academy\_%' and table_name not like 'product\_facts%'),
outside_functions as (
  select md5(coalesce(string_agg(p.proname || ':' || pg_get_function_identity_arguments(p.oid) || ':' || md5(p.prosrc), '|'
                                 order by p.proname, pg_get_function_identity_arguments(p.oid)), '')) fp, count(*) n
  from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname not like 'academy\_%'),
academy_grants as (
  select md5(coalesce(string_agg(table_name || ':' || grantee || ':' || privilege_type, ',' order by table_name, grantee, privilege_type), '')) fp, count(*) n
  from information_schema.role_table_grants
  where table_schema = 'public' and (table_name like 'academy\_%' or table_name like 'product\_facts%')),
academy_columns as (
  select md5(coalesce(string_agg(table_name || ':' || column_name || ':' || data_type || ':' || is_nullable, ',' order by table_name, ordinal_position), '')) fp,
         count(*) n, count(distinct table_name) tables
  from information_schema.columns
  where table_schema = 'public' and (table_name like 'academy\_%' or table_name like 'product\_facts%')),
academy_rls as (
  select count(*) filter (where c.relrowsecurity) on_, count(*) all_,
         (select count(*) from pg_policies where schemaname = 'public' and (tablename like 'academy\_%' or tablename like 'product\_facts%')) policies
  from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
    and (c.relname like 'academy\_%' or c.relname like 'product\_facts%')),
switches as (
  select coalesce((select jsonb_object_agg(k, v) from app_settings, jsonb_each(value) e(k, v) where key = 'phase2_flags' and k like 'academy\_%'), '{}') j),
learner_rows as (
  select (select count(*) from academy_learners) + (select count(*) from academy_memberships) + (select count(*) from academy_invites)
       + (select count(*) from academy_handoff_codes) + (select count(*) from academy_enrollments) + (select count(*) from academy_progress) n),
key_tables(t) as (values ('dealers'),('dealer_users'),('staff_users'),('orders'),('order_items'),('monthly_sales'),
  ('academy_courses'),('academy_lessons'),('academy_questions'),('academy_media'),('academy_events')),
key_rows as (
  select jsonb_object_agg(t, case when to_regclass('public.' || t) is null then null
    else (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', t), false, true, '')))[1]::text::bigint end) j
  from key_tables),
golden as (select status from academy_course_versions where id = '34a4ed42-5c62-4f04-bffc-2a4341182bea')
select jsonb_build_object(
  'ready_for_m5',
     (select n from fp where kind = 'm1') = 19 and (select n from fp where kind = 'm2') = 15 and (select n from fp where kind = 'm3') = 24
     and (select n from fp where kind = 'm3_1') = 2 and (select n from fp where kind = 'm4') > 0 and (select n from fp where kind = 'm5') = 0
     and to_regclass('public.academy_sessions') is null and to_regclass('public.academy_login_codes') is null
     and to_regclass('public.dealer_users') is not null
     and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'dealers' and column_name = 'is_test')
     and (select n from learner_rows) = 0
     and exists (select 1 from staff_users where role = 'president' and active)
     and not exists (select 1 from app_settings, jsonb_each(value) e(k, v) where key = 'phase2_flags' and k like 'academy\_%' and k <> 'academy_admin' and v = 'true'::jsonb),
  'm5_installed', (select n from fp where kind = 'm5') > 0,
  'postgres', current_setting('server_version'),
  'code_fingerprints', (select jsonb_object_agg(kind, jsonb_build_object('functions', n, 'fp', fp)) from fp),
  'outside_grants', (select jsonb_build_object('n', n, 'fp', fp) from outside_grants),
  'outside_policies', (select jsonb_build_object('n', n, 'fp', fp) from outside_policies),
  'outside_columns', (select jsonb_build_object('tables', n, 'fp', fp) from outside_columns),
  'outside_functions', (select jsonb_build_object('n', n, 'fp', fp) from outside_functions),
  'academy_grants', (select jsonb_build_object('n', n, 'fp', fp) from academy_grants),
  'academy_columns', (select jsonb_build_object('n', n, 'tables', tables, 'fp', fp) from academy_columns),
  'academy_rls', (select jsonb_build_object('on', on_, 'tables', all_, 'policies', policies) from academy_rls),
  'academy_switches', (select j from switches),
  'learner_rows', (select n from learner_rows),
  'key_rows', (select j from key_rows),
  'golden_version_status', (select status from golden)
) as m5_preflight;
