-- =============================================================================================
-- HCPS Academy — Phase A1 PREFLIGHT PART 2 (READ-ONLY)     supabase/academy_a1_preflight_storage.sql
-- Changes nothing: one SELECT that returns one JSON row. Added after the 10 Oct 2026 production
-- preflight showed trigger functions on storage.buckets (protect_bucket_control_*) and storage
-- columns that the local test copy does not have. It shows exactly what those triggers do, which
-- bucket columns need values, whether this SQL-editor role may insert a bucket, and how the
-- app_settings row will be filled. Run it in the Supabase SQL editor and paste the result back.
-- =============================================================================================
select jsonb_build_object(
  'run_as', current_user,
  'can_insert_bucket', has_table_privilege(current_user, 'storage.buckets', 'INSERT'),
  'can_delete_bucket', has_table_privilege(current_user, 'storage.buckets', 'DELETE'),
  'bucket_columns', (select jsonb_agg(column_name || ' | ' || data_type || ' | nullable ' || is_nullable || ' | default ' || coalesce(column_default, 'none')
                                      order by ordinal_position)
                     from information_schema.columns where table_schema = 'storage' and table_name = 'buckets'),
  'bucket_triggers', (select jsonb_agg(jsonb_build_object(
                         'trigger', t.tgname,
                         'enabled', t.tgenabled::text,
                         'definition', pg_get_triggerdef(t.oid),
                         'function', p.pronamespace::regnamespace::text || '.' || p.proname,
                         'function_source', p.prosrc) order by t.tgname)
                      from pg_trigger t join pg_proc p on p.oid = t.tgfoid
                      where t.tgrelid = 'storage.buckets'::regclass and not t.tgisinternal),
  'app_settings_columns', (select jsonb_agg(column_name || ' | nullable ' || is_nullable || ' | default ' || coalesce(column_default, 'none') order by ordinal_position)
                           from information_schema.columns where table_schema = 'public' and table_name = 'app_settings'),
  'app_settings_triggers', (select coalesce(jsonb_agg(pg_get_triggerdef(t.oid) order by t.tgname), '[]')
                            from pg_trigger t where t.tgrelid = 'public.app_settings'::regclass and not t.tgisinternal),
  'manufacturers_triggers', (select coalesce(jsonb_agg(pg_get_triggerdef(t.oid) order by t.tgname), '[]')
                             from pg_trigger t where t.tgrelid = 'public.manufacturers'::regclass and not t.tgisinternal)
) as academy_a1_preflight_storage;
