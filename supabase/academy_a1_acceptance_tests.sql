-- =============================================================================================
-- HCPS Academy — Phase A1 acceptance tests (24)         supabase/academy_a1_acceptance_tests.sql
-- Run right after the migration. Everything happens inside one transaction that is ROLLED BACK:
-- test rows are created and thrown away; nothing persists. Output: one row per test, PASS or FAIL.
-- Uses existing rows only as references (one dealer, the Golden manufacturer, one auth user).
-- =============================================================================================
begin;

create temp table t_results (n int, test text, result text, detail text) on commit drop;

-- ---------- Structure and security (read-only) ----------
with expected(t) as (values
  ('academy_learners'),('academy_memberships'),('academy_invites'),('academy_handoff_codes'),
  ('academy_courses'),('academy_course_versions'),('academy_modules'),('academy_lessons'),('academy_questions'),('academy_media'),
  ('product_facts'),('academy_content_refs'),('academy_enrollments'),('academy_progress'),('academy_attempts'),
  ('academy_certificates'),('academy_external_certs'),('academy_events')),
present as (select e.t, c.oid, c.relrowsecurity from expected e
            left join pg_class c on c.relname = e.t and c.relnamespace = 'public'::regnamespace and c.relkind = 'r')
insert into t_results
select 1, 'All 18 tables exist', case when count(*) filter (where oid is null) = 0 then 'PASS' else 'FAIL' end,
       coalesce(string_agg(t, ', ') filter (where oid is null), '') from present
union all
select 2, 'RLS enabled on all 18', case when bool_and(coalesce(relrowsecurity,false)) then 'PASS' else 'FAIL' end,
       coalesce(string_agg(t, ', ') filter (where not coalesce(relrowsecurity,false)), '') from present
union all
select 3, 'No RLS policies on academy tables', case when count(p.*) = 0 then 'PASS' else 'FAIL' end,
       coalesce(string_agg(p.tablename || '.' || p.policyname, ', '), '')
  from pg_policies p join expected e on e.t = p.tablename where p.schemaname = 'public'
union all
select 4, 'anon and authenticated have no table privileges',
       case when count(*) = 0 then 'PASS' else 'FAIL' end, coalesce(string_agg(r || ' ' || pr || ' ' || t, ', '), '')
  from expected, unnest(array['anon','authenticated']) r, unnest(array['SELECT','INSERT','UPDATE','DELETE']) pr
  where has_table_privilege(r, 'public.' || t, pr)
union all
select 5, 'service_role can select, insert, update and delete on every table',
       case when count(*) = 0 then 'PASS' else 'FAIL' end, coalesce(string_agg(t, ', '), '')
  from expected where not (has_table_privilege('service_role', 'public.' || t, 'SELECT')
                       and has_table_privilege('service_role', 'public.' || t, 'INSERT')
                       and has_table_privilege('service_role', 'public.' || t, 'UPDATE')
                       and has_table_privilege('service_role', 'public.' || t, 'DELETE'))
union all
select 6, 'No academy views exposed', case when count(*) = 0 then 'PASS' else 'FAIL' end,
       coalesce(string_agg(viewname, ', '), '')
  from pg_views where schemaname = 'public' and (viewname like 'academy%' or viewname like 'product_facts%')
union all
select 7, 'academy-private bucket exists, is private, and no storage policy names it',
       case when exists (select 1 from storage.buckets where id = 'academy-private' and public = false)
             and not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
                             and coalesce(qual,'') || coalesce(with_check,'') like '%academy-private%')
            then 'PASS' else 'FAIL' end, ''
union all
select 8, 'Monitoring and auto-update are off',
       case when (select (value->>'product_monitoring_enabled')::boolean = false and (value->>'auto_update_enabled')::boolean = false
                  from public.app_settings where key = 'academy') then 'PASS' else 'FAIL' end, ''
union all
select 9, 'Rule triggers installed (7)',
       case when (select count(*) from pg_trigger where not tgisinternal and tgname in
         ('academy_modules_frozen','academy_lessons_frozen','academy_questions_frozen','academy_course_versions_guard',
          'product_facts_append_only','academy_events_append_only','academy_certificates_guard')) = 7 then 'PASS' else 'FAIL' end, ''
union all
select 10, 'Existing order_items policy unchanged (dealer_items_sel only)',
       case when to_regclass('public.order_items') is null then 'SKIP'
            when (select string_agg(policyname, ',' order by policyname) from pg_policies
                  where schemaname = 'public' and tablename = 'order_items') = 'dealer_items_sel' then 'PASS' else 'FAIL' end, '';

-- ---------- Behaviour (rolled back) ----------
do $$
declare
  v_user uuid; v_dealer uuid; v_learner uuid; v_course uuid; v_ver uuid; v_mod uuid; v_les uuid; v_q uuid;
  v_fact uuid; v_fact2 uuid; v_enr uuid; v_att uuid; v_cert uuid; ok boolean;
  procedure_result text;
begin
  select id into v_user from auth.users order by created_at limit 1;
  select id into v_dealer from public.dealers limit 1;
  if v_user is null or v_dealer is null then
    insert into t_results values (20, 'Behaviour tests', 'SKIP', 'needs one auth user and one dealer'); return;
  end if;

  insert into academy_learners (auth_user_id, full_name, email) values (v_user, 'Test Learner', 'test@example.com') returning id into v_learner;
  insert into academy_courses (slug, manufacturer_slug, title, course_type, issuer)
    values ('test-course', 'golden-technologies', 'Test', 'hcps_certification', 'hcps') returning id into v_course;
  insert into academy_course_versions (course_id, version) values (v_course, 1) returning id into v_ver;
  insert into academy_modules (version_id, position, title) values (v_ver, 1, 'M1') returning id into v_mod;
  insert into academy_lessons (module_id, position, title, est_minutes) values (v_mod, 1, 'L1', 5) returning id into v_les;
  insert into academy_questions (version_id, module_id, kind, prompt, choices, answer_key, explanation)
    values (v_ver, v_mod, 'single', 'Q?', '[{"id":"a","text":"A"},{"id":"b","text":"B"}]', '"a"', 'Because') returning id into v_q;
  update academy_course_versions set status = 'published', published_at = now(), published_by = 'test' where id = v_ver;

  -- 11 published version is frozen
  begin
    update academy_lessons set title = 'changed' where id = v_les; ok := false;
  exception when others then ok := true; end;
  insert into t_results values (11, 'Published lessons cannot be edited', case when ok then 'PASS' else 'FAIL' end, '');

  begin
    update academy_questions set answer_key = '"b"' where id = v_q; ok := false;
  exception when others then ok := true; end;
  insert into t_results values (12, 'Published exam answers cannot be edited', case when ok then 'PASS' else 'FAIL' end, '');

  -- product facts
  insert into product_facts (manufacturer_slug, model_code, field, value, unit, field_class, status, source_url, source_label, verified_on, verified_by)
    values ('golden-technologies', 'PR999', 'capacity.med', '400', 'lb', 'approval_required', 'verified', 'https://example.com', 'test', current_date, 'test')
    returning id into v_fact;
  begin
    update product_facts set value = '500' where id = v_fact; ok := false;
  exception when others then ok := true; end;
  insert into t_results values (13, 'A product fact value cannot be edited in place', case when ok then 'PASS' else 'FAIL' end, '');

  begin
    insert into product_facts (manufacturer_slug, model_code, field, value, field_class, status, source_url, source_label, verified_on, verified_by)
      values ('golden-technologies', 'PR999', 'capacity.med', '500', 'approval_required', 'verified', 'https://example.com', 'test', current_date, 'test');
    ok := false;
  exception when unique_violation then ok := true; end;
  insert into t_results values (14, 'Only one current value per model and field', case when ok then 'PASS' else 'FAIL' end, '');

  begin
    -- the approved way: close the current row pointing at the new id, then insert the new row (one transaction)
    v_fact2 := gen_random_uuid();
    update product_facts set valid_to = now(), replaced_by = v_fact2 where id = v_fact;
    insert into product_facts (id, manufacturer_slug, model_code, field, value, unit, field_class, status, source_url, source_label, verified_on, verified_by)
      values (v_fact2, 'golden-technologies', 'PR999', 'capacity.med', '500', 'lb', 'approval_required', 'verified', 'https://example.com', 'test', current_date, 'test');
    set constraints all immediate;
    ok := (select count(*) = 2 from product_facts where model_code = 'PR999' and field = 'capacity.med')
          and (select value = '500'::jsonb from product_facts where model_code = 'PR999' and field = 'capacity.med' and valid_to is null);
  exception when others then ok := false; procedure_result := sqlerrm; end;
  insert into t_results values (15, 'A fact can be superseded (history kept)', case when ok then 'PASS' else 'FAIL' end, coalesce(procedure_result, ''));

  begin
    delete from product_facts where id = v_fact; ok := false;
  exception when others then ok := true; end;
  insert into t_results values (16, 'Product facts cannot be deleted', case when ok then 'PASS' else 'FAIL' end, '');

  -- handoff codes
  begin
    insert into academy_handoff_codes (code_hash, auth_user_id, expires_at) values ('h1', v_user, now() + interval '10 minutes'); ok := false;
  exception when check_violation then ok := true; end;
  insert into t_results values (17, 'Handoff codes cannot live longer than 120 seconds', case when ok then 'PASS' else 'FAIL' end, '');

  -- audit log
  insert into academy_events (actor_type, actor, entity, action) values ('system', 'test', 'test', 'created');
  begin
    update academy_events set action = 'x'; ok := false;
  exception when others then ok := true; end;
  insert into t_results values (18, 'Audit log cannot be edited', case when ok then 'PASS' else 'FAIL' end, '');

  -- certificates
  insert into academy_enrollments (learner_id, version_id, access_source) values (v_learner, v_ver, 'admin_grant') returning id into v_enr;
  insert into academy_attempts (enrollment_id, question_ids, answers, submitted_at, score, passed, graded_at)
    values (v_enr, array[v_q], '{}'::jsonb, now(), 100, true, now()) returning id into v_att;
  insert into academy_certificates (cert_number, learner_id, enrollment_id, version_id, attempt_id, learner_name, expires_at)
    values ('HCPS-TEST-0001', v_learner, v_enr, v_ver, v_att, 'Test Learner', now() + interval '12 months') returning id into v_cert;
  begin
    update academy_certificates set learner_name = 'Someone Else' where id = v_cert; ok := false;
  exception when others then ok := true; end;
  insert into t_results values (19, 'Certificate details cannot be altered', case when ok then 'PASS' else 'FAIL' end, '');

  begin
    update academy_certificates set status = 'revoked', revoked_at = now(), revoked_by = 'test', revoked_reason = 'test' where id = v_cert;
    ok := true;
  exception when others then ok := false; end;
  insert into t_results values (20, 'A certificate can be revoked', case when ok then 'PASS' else 'FAIL' end, '');

  begin
    insert into academy_courses (slug, title, course_type, issuer) values ('golden-tech', 'Golden tech', 'manufacturer_program', 'manufacturer'); ok := false;
  exception when check_violation then ok := true; end;
  insert into t_results values (21, 'A manufacturer program must name the manufacturer and link to its course', case when ok then 'PASS' else 'FAIL' end, '');

  begin
    insert into academy_courses (slug, title, course_type, issuer) values ('fake-cert', 'x', 'hcps_certification', 'manufacturer'); ok := false;
  exception when check_violation then ok := true; end;
  insert into t_results values (22, 'An HCPS certification cannot be marked as manufacturer-issued', case when ok then 'PASS' else 'FAIL' end, '');
  begin
    update academy_course_versions set status = 'draft', published_at = null, published_by = null where id = v_ver; ok := false;
  exception when others then ok := true; end;
  insert into t_results values (23, 'A published version cannot be un-published', case when ok then 'PASS' else 'FAIL' end, '');

  begin
    update academy_course_versions set pass_mark = 50 where id = v_ver; ok := false;
  exception when others then ok := true; end;
  insert into t_results values (24, 'A published version''s pass mark cannot change', case when ok then 'PASS' else 'FAIL' end, '');
end $$;

select n as "#", test, result, detail from t_results order by n;

rollback;
