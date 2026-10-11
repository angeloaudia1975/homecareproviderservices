-- =============================================================================================
-- HCPS Academy — A2A M1 PRODUCTION PREFLIGHT (READ-ONLY)     supabase/academy_a2a_m1_preflight.sql
-- Changes nothing: one SELECT that returns one JSON row. Run it in the Supabase SQL editor BEFORE
-- the M1 migration and paste the result back; run it again AFTER M1 — every fingerprint must be
-- identical and only "m1_installed" / "m1_objects" may change.
--   ready_for_m1 = true  means: A1 is installed, M1 is not, and no Academy data exists yet.
-- =============================================================================================
with
a1_tables(t) as (values ('academy_learners'),('academy_memberships'),('academy_invites'),('academy_handoff_codes'),
  ('academy_courses'),('academy_course_versions'),('academy_modules'),('academy_lessons'),('academy_questions'),
  ('academy_media'),('product_facts'),('academy_content_refs'),('academy_enrollments'),('academy_progress'),
  ('academy_attempts'),('academy_certificates'),('academy_external_certs'),('academy_events')),
a1_counts as (
  select t, case when to_regclass('public.' || t) is null then null
    else (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', t), false, true, '')))[1]::text::bigint end as n
  from a1_tables),
key_tables(t) as (values ('dealers'),('dealer_users'),('staff_users'),('manufacturers'),('app_settings'),
  ('orders'),('order_items'),('monthly_sales'),('product_content'),('product_content_sources'),
  ('product_content_history'),('product_media'),('email_queue'),('email_sends'),('email_optout'),('commission_splits')),
counts as (
  select t, case when to_regclass('public.' || t) is null then null
    else (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', t), false, true, '')))[1]::text::bigint end as n
  from key_tables),
-- Outside the Academy: the same three fingerprints the A1 preflight recorded.
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
-- Inside the Academy: M1 adds triggers and functions only — table grants, policies, columns and RLS must not move.
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
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and (c.relname like 'academy\_%' or c.relname like 'product\_facts%')),
a1_triggers as (
  select coalesce(jsonb_agg(c.relname || '.' || t.tgname order by c.relname, t.tgname), '[]') j
  from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and not t.tgisinternal and t.tgname <> 'academy_audited_guard'
    and (c.relname like 'academy\_%' or c.relname like 'product\_facts%')),
m1_funcs as (
  select coalesce(jsonb_agg(p.proname order by p.proname), '[]') j, count(*) n
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and (p.proname like 'academy\_op\_%' or p.proname = 'academy_audited_guard')),
m1_trigs as (
  select coalesce(jsonb_agg(c.relname order by c.relname), '[]') j, count(*) n
  from pg_trigger t join pg_class c on c.oid = t.tgrelid
  where t.tgname = 'academy_audited_guard'),
flags as (
  select coalesce((select jsonb_object_agg(k, v) from jsonb_each(value) as e(k, v) where k like 'academy\_%'), '{}') j
  from public.app_settings where key = 'phase2_flags')
select jsonb_build_object(
  'postgres', current_setting('server_version'),
  'ready_for_m1', (select count(*) from a1_counts where n is null) = 0
                  and (select n from m1_funcs) = 0 and (select n from m1_trigs) = 0
                  and (select coalesce(sum(n), 0) from a1_counts) = 0,
  'a1_installed', jsonb_build_object(
     'tables_present', (select count(*) from a1_counts where n is not null) || ' / 18',
     'missing', (select coalesce(jsonb_agg(t), '[]') from a1_counts where n is null),
     'a1_triggers', (select j from a1_triggers),
     'bucket_academy_private', exists (select 1 from storage.buckets where id = 'academy-private'),
     'app_settings_academy', (select value from public.app_settings where key = 'academy')),
  'academy_rows', (select jsonb_object_agg(t, n) from a1_counts),
  'm1_installed', (select n from m1_funcs) > 0 or (select n from m1_trigs) > 0,
  'm1_objects', jsonb_build_object('functions', (select j from m1_funcs), 'guard_triggers_on', (select j from m1_trigs)),
  'academy_switches', (select coalesce((select j from flags), '{}')),
  'roles', (select jsonb_object_agg(rolname, rolbypassrls) from pg_roles where rolname in ('anon','authenticated','service_role')),
  'academy_fingerprints', jsonb_build_object(
     'grants', (select fp || ' / ' || n from a_grants_fp),
     'policies', (select fp || ' / ' || n from a_policies_fp),
     'columns', (select fp || ' / ' || n from a_columns_fp),
     'rls_on', (select on_ || ' / ' || all_ || ' tables' from a_rls)),
  'fingerprints', jsonb_build_object(
     'grants', (select fp || ' / ' || n from grants_fp),
     'policies', (select fp || ' / ' || n from policies_fp),
     'columns', (select fp || ' / ' || n || ' tables' from tables_fp),
     'row_counts', (select jsonb_object_agg(t, n) from counts))
) as academy_a2a_m1_preflight;
