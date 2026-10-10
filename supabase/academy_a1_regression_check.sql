-- =============================================================================================
-- HCPS Academy — Phase A1 REGRESSION CHECK (READ-ONLY)     supabase/academy_a1_regression_check.sql
-- Run after the migration and acceptance tests. Every value must equal the preflight result:
-- existing tables, columns, row counts, grants and policies untouched; security fix still in place.
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
  'security_baseline', jsonb_build_object(
     'order_items_policies', (select string_agg(policyname, ',' order by policyname) from pg_policies where schemaname='public' and tablename='order_items'),
     'views_anon_select', (select jsonb_object_agg(v, case when to_regclass('public.' || v) is null then null
                                   else has_table_privilege('anon', 'public.' || v, 'SELECT') end)
                           from unnest(array['v_commission_by_rep','v_sales_by_account','v_dealer_activity','hcps_dealer_rep','product_content_review_queue']) v)),
  'fingerprints', jsonb_build_object(
     'grants', (select fp || ' / ' || n from grants_fp),
     'policies', (select fp || ' / ' || n from policies_fp),
     'columns', (select fp || ' / ' || n || ' tables' from tables_fp),
     'row_counts', (select jsonb_object_agg(t, n) from counts)),
  'storage_buckets', (select jsonb_agg(id || case when public then ' (PUBLIC)' else ' (private)' end order by id) from storage.buckets),
  'academy_objects', jsonb_build_object(
     'tables', (select count(*) from pg_tables where schemaname='public' and (tablename like 'academy\_%' or tablename = 'product_facts')),
     'settings', (select value from public.app_settings where key = 'academy'))
) as academy_a1_regression;
