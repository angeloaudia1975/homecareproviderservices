-- HCPS Academy — Phase 2 / F1 PREFLIGHT (read-only). Run before academy_p2_f1_free_access.sql; ready_for_f1 must be true.
select 'M8 installed' as check, to_regclass('public.academy_purchases') is not null as ok, null::text as value
union all select 'F1 not installed yet', to_regclass('public.academy_course_access') is null, null
union all select 'dealers.active present', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'dealers' and column_name = 'active'), null
union all select 'M8 eligibility today (eligible dealers by M8 rule)', true, (select count(*)::text from dealers d where academy_purchase_dealer_eligible(d.id))
union all select 'dealers by active flag (true / false / null)', true,
  (select count(*) filter (where active) || ' / ' || count(*) filter (where active = false) || ' / ' || count(*) filter (where active is null) from dealers)
union all select 'purchases by status', true, (select string_agg(status || '=' || n, ', ' order by status) from (select status, count(*) n from academy_purchases group by status) s)
union all select 'enrollments by access source', true, (select string_agg(access_source || '=' || n, ', ' order by access_source) from (select access_source, count(*) n from academy_enrollments group by access_source) s)
union all select 'switches', true, (select value::text from app_settings where key = 'phase2_flags');
