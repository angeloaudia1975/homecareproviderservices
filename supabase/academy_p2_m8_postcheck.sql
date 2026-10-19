-- =============================================================================================
-- HCPS Academy — Phase 2 / M8 PRE- AND POST-MIGRATION CHECK (READ-ONLY)   supabase/academy_p2_m8_postcheck.sql
-- Changes nothing. Run it before M8 (m8_installed false, everything else = the baseline) and after M8.
-- Expected after M8: m8_installed true · m8_functions 21 · m8_server_callable 12 · m8_public_callable 0
--   m8_code_fingerprint = docs/academy/PHASE2_COMMERCE.md (Unix and Windows-paste forms, both precomputed)
--   commerce rows all 0 · memberships_without_owner 0 · outside_memberships 0
--   m1_m7_fingerprint and academy_switches = the values read BEFORE M8 (M1–M7 untouched, no switch turned on)
-- Any other value = stop and investigate (never roll back on suspicion).
-- =============================================================================================
select jsonb_build_object(
  'm8_installed', to_regprocedure('public.academy_commerce_op_set_price(text,uuid,jsonb,text)') is not null,
  'm8_code_fingerprint', (select md5(string_agg(p.proname || ':' || pg_get_function_identity_arguments(p.oid) || ':' || p.prosecdef || ':' ||
                              coalesce(array_to_string(p.proconfig, ','), '') || ':' || p.prosrc, '|' order by p.proname))
                          from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_commerce\_%'),
  'm8_functions', (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like 'academy\_commerce\_%'),
  'm8_server_callable', (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like 'academy\_commerce\_%'
                          and has_function_privilege('service_role', oid, 'EXECUTE')),
  'm8_public_callable', (select count(*) from pg_proc p, unnest(array['anon','authenticated']) r where p.pronamespace = 'public'::regnamespace
                          and p.proname like 'academy\_commerce\_%' and has_function_privilege(r, p.oid, 'EXECUTE')),
  -- counted only when the table exists (query_to_xml runs the count only then), so this check also runs BEFORE M8
  'commerce_rows', jsonb_build_object(
     'organizations', case when to_regclass('public.academy_organizations') is null then null else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.academy_organizations', false, true, '')))[1]::text::int end,
     'prices', case when to_regclass('public.academy_course_prices') is null then null else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.academy_course_prices', false, true, '')))[1]::text::int end,
     'overrides', case when to_regclass('public.academy_eligibility_overrides') is null then null else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.academy_eligibility_overrides', false, true, '')))[1]::text::int end,
     'checkouts', case when to_regclass('public.academy_checkouts') is null then null else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.academy_checkouts', false, true, '')))[1]::text::int end,
     'purchases', case when to_regclass('public.academy_purchases') is null then null else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.academy_purchases', false, true, '')))[1]::text::int end,
     'stripe_events', case when to_regclass('public.academy_stripe_events') is null then null else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.academy_stripe_events', false, true, '')))[1]::text::int end),
  'memberships', (select count(*) from academy_memberships),
  'memberships_without_dealer', (select count(*) from academy_memberships where dealer_id is null),
  'm1_m7_fingerprint', (select md5(string_agg(p.proname || ':' || pg_get_function_identity_arguments(p.oid) || ':' || p.prosrc, '|' order by p.proname))
                        from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_%' and p.proname not like 'academy\_commerce\_%'),
  'academy_switches', coalesce((select jsonb_object_agg(k, v) from app_settings, jsonb_each(value) e(k, v) where key = 'phase2_flags' and k like 'academy\_%'), '{}')
) as m8_check;
