-- =============================================================================================
-- HCPS Academy — Phase A1 PRODUCTION PREFLIGHT (READ-ONLY)        supabase/academy_a1_preflight.sql
-- Changes nothing: one SELECT that returns one JSON row. Run it in the Supabase SQL editor and
-- paste the result back. Its "fingerprints" are compared after the migration to prove that no
-- existing table, row count, grant or policy changed.
-- =============================================================================================
with
key_tables(t) as (values ('dealers'),('dealer_users'),('staff_users'),('manufacturers'),('app_settings'),
  ('orders'),('order_items'),('monthly_sales'),('product_content'),('product_content_sources'),
  ('product_content_history'),('product_media'),('email_queue'),('email_sends'),('email_optout'),('commission_splits')),
counts as (
  select t, case when to_regclass('public.' || t) is null then null
    else (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', t), false, true, '')))[1]::text::bigint end as n
  from key_tables),
grants_fp as (
  select md5(coalesce(string_agg(table_name || ':' || grantee || ':' || privilege_type, ',' order by table_name, grantee, privilege_type), '')) fp,
         count(*) n
  from information_schema.role_table_grants
  where table_schema = 'public' and table_name not like 'academy\_%' and table_name not like 'product\_facts%'),
policies_fp as (
  select md5(coalesce(string_agg(schemaname || '.' || tablename || ':' || policyname || ':' || cmd || ':' || coalesce(qual,'') || ':' || coalesce(with_check,''),
                                 ',' order by schemaname, tablename, policyname), '')) fp,
         count(*) n
  from pg_policies where schemaname in ('public','storage') and tablename not like 'academy\_%' and tablename not like 'product\_facts%'),
tables_fp as (
  select md5(coalesce(string_agg(table_name || ':' || column_name || ':' || data_type, ',' order by table_name, ordinal_position), '')) fp,
         count(distinct table_name) n
  from information_schema.columns
  where table_schema = 'public' and table_name not like 'academy\_%' and table_name not like 'product\_facts%')
select jsonb_build_object(
  'postgres', current_setting('server_version'),
  'name_conflicts', jsonb_build_object(
     'relations', (select coalesce(jsonb_agg(c.relname || ' (' || c.relkind::text || ')'), '[]') from pg_class c join pg_namespace n on n.oid = c.relnamespace
                   where n.nspname = 'public' and (c.relname like 'academy\_%' or c.relname like 'product\_facts%')),
     'functions', (select coalesce(jsonb_agg(p.proname), '[]') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'public' and (p.proname like 'academy\_%' or p.proname like 'product\_facts%')),
     'bucket_academy_private', exists (select 1 from storage.buckets where id = 'academy-private'),
     'app_settings_academy_key', (select count(*) from public.app_settings where key = 'academy')),
  'references', jsonb_build_object(
     'dealers_id', (select data_type from information_schema.columns where table_schema='public' and table_name='dealers' and column_name='id'),
     'dealers_id_is_pk', exists (select 1 from pg_index i where i.indrelid = 'public.dealers'::regclass and i.indisprimary),
     'manufacturers_slug', (select data_type from information_schema.columns where table_schema='public' and table_name='manufacturers' and column_name='slug'),
     'manufacturers_slug_unique', exists (select 1 from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
                                         where i.indrelid = 'public.manufacturers'::regclass and i.indisunique and a.attname = 'slug' and i.indnatts = 1),
     'golden_technologies_row', exists (select 1 from public.manufacturers where slug = 'golden-technologies'),
     'auth_users_id', (select data_type from information_schema.columns where table_schema='auth' and table_name='users' and column_name='id'),
     'app_settings_columns', (select jsonb_agg(column_name || ' ' || data_type order by ordinal_position) from information_schema.columns
                              where table_schema='public' and table_name='app_settings'),
     'app_settings_rls', (select relrowsecurity from pg_class where oid = 'public.app_settings'::regclass),
     'gen_random_uuid', exists (select 1 from pg_proc where proname = 'gen_random_uuid')),
  'roles', (select jsonb_object_agg(rolname, rolbypassrls) from pg_roles where rolname in ('anon','authenticated','service_role')),
  'default_privileges_public', (select coalesce(jsonb_agg(pg_get_userbyid(defaclrole) || ' ' || defaclobjtype::text || ' ' || defaclacl::text), '[]')
                                from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace where n.nspname = 'public'),
  'storage', jsonb_build_object(
     'bucket_columns', (select jsonb_agg(column_name order by ordinal_position) from information_schema.columns where table_schema='storage' and table_name='buckets'),
     'buckets', (select jsonb_agg(id || case when public then ' (PUBLIC)' else ' (private)' end order by id) from storage.buckets),
     'object_policies', (select coalesce(jsonb_agg(policyname || ' | ' || cmd || ' | ' || array_to_string(roles, ',') || ' | names a bucket: ' ||
                              ((coalesce(qual,'') || coalesce(with_check,'')) like '%bucket_id%')::text order by policyname), '[]')
                         from pg_policies where schemaname = 'storage' and tablename = 'objects')),
  'event_triggers', (select coalesce(jsonb_agg(evtname || ' ' || evtevent), '[]') from pg_event_trigger),
  'security_baseline', jsonb_build_object(
     'order_items_policies', (select string_agg(policyname, ',' order by policyname) from pg_policies where schemaname='public' and tablename='order_items'),
     'views_anon_select', (select jsonb_object_agg(v, case when to_regclass('public.' || v) is null then null
                                   else has_table_privilege('anon', 'public.' || v, 'SELECT') end)
                           from unnest(array['v_commission_by_rep','v_sales_by_account','v_dealer_activity','hcps_dealer_rep','product_content_review_queue']) v)),
  'fingerprints', jsonb_build_object(
     'grants', (select fp || ' / ' || n from grants_fp),
     'policies', (select fp || ' / ' || n from policies_fp),
     'columns', (select fp || ' / ' || n || ' tables' from tables_fp),
     'row_counts', (select jsonb_object_agg(t, n) from counts))
) as academy_a1_preflight;
