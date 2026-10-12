-- =============================================================================================
-- HCPS Academy — Phase A1 acceptance tests (26)         supabase/academy_a1_acceptance_tests.sql
-- Run right after the migration, in the Supabase SQL editor. Tests 1-10 only read. Tests 11-26 create
-- test rows inside a sub-transaction that is always undone (a deliberate exception rolls it back after
-- the results are saved), so nothing persists. The editor shows only the LAST statement's result, so the
-- results table is the final statement. Output: one row per test, PASS or FAIL, plus check 27 confirming
-- that no test data was left behind. Uses existing rows only as references (one dealer, Golden, one auth user).
-- Works before and after A2A M1: once M1's audited operations exist, the setup goes through them (M1 refuses direct
-- writes to its guarded tables, by design). With M1 (rev 2) the setup names an active HCPS administrator as actor and turns
-- the certificates switch on inside the undone sub-transaction (never visible to anyone else; phase2_flags is unchanged after).
-- =============================================================================================
drop table if exists t_results;
create temp table t_results (n int, test text, result text, detail text);

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
  procedure_result text; v_saved text;
  v_m1 boolean := to_regprocedure('public.academy_op_start_attempt(text,uuid)') is not null;  -- A2A M1 installed: set up through the audited operations
  v_ext uuid; v_med uuid; ADMIN text;
begin
  begin  -- sub-transaction: every write in here is undone at the end
    select id into v_user from auth.users order by created_at limit 1;
    select id into v_dealer from public.dealers limit 1;
    select 'staff:' || lower(email) into ADMIN from staff_users
     where coalesce(active, true) and lower(coalesce(role, '')) in ('president','admin','owner') order by email limit 1;
    if v_user is null or v_dealer is null or (v_m1 and ADMIN is null) then
      insert into t_results values (20, 'Behaviour tests', 'SKIP', 'needs one auth user, one dealer and (with M1) one active HCPS administrator'); return;
    end if;

    insert into academy_learners (auth_user_id, full_name, email) values (v_user, 'Test Learner', 'test@example.com') returning id into v_learner;
    perform set_config('academy.op', 'test-setup', true);  -- A2C M2: content is written only by audited operations; test setup is the owner with the marker
    insert into academy_courses (slug, manufacturer_slug, title, course_type, issuer)
      values ('a1-test-course', 'golden-technologies', 'Test', 'hcps_certification', 'hcps') returning id into v_course;
    insert into academy_course_versions (course_id, version, exam_questions) values (v_course, 1, 1) returning id into v_ver;
    insert into academy_modules (version_id, position, title) values (v_ver, 1, 'M1') returning id into v_mod;
    insert into academy_lessons (module_id, position, title, est_minutes) values (v_mod, 1, 'L1', 5) returning id into v_les;
    insert into academy_questions (version_id, module_id, kind, prompt, choices, answer_key, explanation)   -- A2D M3: questions too
      values (v_ver, v_mod, 'single', 'Q?', '[{"id":"a","text":"A"},{"id":"b","text":"B"}]', '"a"', 'Because') returning id into v_q;
    perform set_config('academy.op', '', true);
    if v_m1 then perform academy_op_publish_version(ADMIN, v_ver);
    else update academy_course_versions set status = 'published', published_at = now(), published_by = 'test' where id = v_ver; end if;

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
    if v_m1 then
      v_fact := (academy_op_record_fact(ADMIN, jsonb_build_object('manufacturer_slug','golden-technologies','model_code','PR999','field','capacity.med',
        'value',400,'unit','lb','field_class','approval_required','status','verified','source_url','https://example.com','source_label','test',
        'verified_on',current_date,'verified_by','test'), null, ADMIN)->>'id')::uuid;
    else
      insert into product_facts (manufacturer_slug, model_code, field, value, unit, field_class, status, source_url, source_label, verified_on, verified_by)
        values ('golden-technologies', 'PR999', 'capacity.med', '400', 'lb', 'approval_required', 'verified', 'https://example.com', 'test', current_date, 'test')
        returning id into v_fact;
    end if;
    begin
      update product_facts set value = '500' where id = v_fact; ok := false;
    exception when others then ok := true; end;
    insert into t_results values (13, 'A product fact value cannot be edited in place', case when ok then 'PASS' else 'FAIL' end, '');

    begin
      if v_m1 then
        perform academy_op_record_fact(ADMIN, jsonb_build_object('manufacturer_slug','golden-technologies','model_code','PR999','field','capacity.med',
          'value',500,'field_class','approval_required','status','verified','source_url','https://example.com','source_label','test',
          'verified_on',current_date,'verified_by','test'), null, ADMIN);
      else
        insert into product_facts (manufacturer_slug, model_code, field, value, field_class, status, source_url, source_label, verified_on, verified_by)
          values ('golden-technologies', 'PR999', 'capacity.med', '500', 'approval_required', 'verified', 'https://example.com', 'test', current_date, 'test');
      end if;
      ok := false;
    exception when unique_violation then ok := true; end;
    insert into t_results values (14, 'Only one current value per model and field', case when ok then 'PASS' else 'FAIL' end, '');

    begin
      -- the approved way: close the current row pointing at the new id, then insert the new row (one transaction)
      if v_m1 then
        v_fact2 := (academy_op_record_fact(ADMIN, jsonb_build_object('manufacturer_slug','golden-technologies','model_code','PR999','field','capacity.med',
          'value',500,'unit','lb','field_class','approval_required','status','verified','source_url','https://example.com','source_label','test',
          'verified_on',current_date,'verified_by','test'), v_fact, ADMIN)->>'id')::uuid;
      else
        v_fact2 := gen_random_uuid();
        update product_facts set valid_to = now(), replaced_by = v_fact2 where id = v_fact;
        insert into product_facts (id, manufacturer_slug, model_code, field, value, unit, field_class, status, source_url, source_label, verified_on, verified_by)
          values (v_fact2, 'golden-technologies', 'PR999', 'capacity.med', '500', 'lb', 'approval_required', 'verified', 'https://example.com', 'test', current_date, 'test');
      end if;
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
    if v_m1 then
      v_att := (academy_op_start_attempt('learner:' || v_learner, v_enr)->>'id')::uuid;
      perform academy_op_submit_attempt('learner:' || v_learner, v_att, jsonb_build_object(v_q::text, 'a'));
      -- the certificates switch, on for this undone sub-transaction only
      if exists (select 1 from app_settings where key = 'phase2_flags') then
        update app_settings set value = value || '{"academy_certificates": true}' where key = 'phase2_flags';
      else
        insert into app_settings (key, value) values ('phase2_flags', '{"academy_certificates": true}');
      end if;
      v_cert := (academy_op_issue_certificate('system:grader', v_att, null)->>'id')::uuid;
    else
      insert into academy_attempts (enrollment_id, question_ids, answers, submitted_at, score, passed, graded_at)
        values (v_enr, array[v_q], '{}'::jsonb, now(), 100, true, now()) returning id into v_att;
      insert into academy_certificates (cert_number, learner_id, enrollment_id, version_id, attempt_id, learner_name, expires_at)
        values ('HCPS-TEST-0001', v_learner, v_enr, v_ver, v_att, 'Test Learner', now() + interval '12 months') returning id into v_cert;
    end if;
    begin
      update academy_certificates set learner_name = 'Someone Else' where id = v_cert; ok := false;
    exception when others then ok := true; end;
    insert into t_results values (19, 'Certificate details cannot be altered', case when ok then 'PASS' else 'FAIL' end, '');

    begin
      if v_m1 then perform academy_op_revoke_certificate(ADMIN, v_cert, 'test');
      else update academy_certificates set status = 'revoked', revoked_at = now(), revoked_by = 'test', revoked_reason = 'test' where id = v_cert; end if;
      ok := true;
    exception when others then ok := false; end;
    insert into t_results values (20, 'A certificate can be revoked', case when ok then 'PASS' else 'FAIL' end, '');

    begin
      perform set_config('academy.op', 'test-setup', true);
      insert into academy_courses (slug, title, course_type, issuer) values ('golden-tech', 'Golden tech', 'manufacturer_program', 'manufacturer'); ok := false;
    exception when check_violation then ok := true; end;
    perform set_config('academy.op', '', true);
    insert into t_results values (21, 'A manufacturer program must name the manufacturer and link to its course', case when ok then 'PASS' else 'FAIL' end, '');

    begin
      perform set_config('academy.op', 'test-setup', true);
      insert into academy_courses (slug, title, course_type, issuer) values ('fake-cert', 'x', 'hcps_certification', 'manufacturer'); ok := false;
    exception when check_violation then ok := true; end;
    perform set_config('academy.op', '', true);
    insert into t_results values (22, 'An HCPS certification cannot be marked as manufacturer-issued', case when ok then 'PASS' else 'FAIL' end, '');
    begin
      update academy_course_versions set status = 'draft', published_at = null, published_by = null where id = v_ver; ok := false;
    exception when others then ok := true; end;
    insert into t_results values (23, 'A published version cannot be un-published', case when ok then 'PASS' else 'FAIL' end, '');

    begin
      update academy_course_versions set pass_mark = 50 where id = v_ver; ok := false;
    exception when others then ok := true; end;
    insert into t_results values (24, 'A published version''s pass mark cannot change', case when ok then 'PASS' else 'FAIL' end, '');
    begin
      if v_m1 then
        insert into academy_external_certs (learner_id, course_id, manufacturer_slug, status, exam_opened_at, exam_reported_at)
          values (v_learner, v_course, 'golden-technologies', 'exam_reported', now(), now()) returning id into v_ext;
        perform academy_op_review_external_cert(ADMIN, v_ext, 'verified', null, null, null);
      else
        insert into academy_external_certs (learner_id, course_id, manufacturer_slug, status, exam_opened_at, exam_reported_at,
                                            verified_by, verified_at)
          values (v_learner, v_course, 'golden-technologies', 'verified', now(), now(), 'test', now());
      end if;
      ok := false;
    exception when check_violation then ok := true; end;
    insert into t_results values (25, 'A Golden credential cannot be verified from an exam click or self-report alone', case when ok then 'PASS' else 'FAIL' end, '');

    begin
      perform set_config('academy.op', 'test-setup', true);  -- A2D M3: media is written only by audited operations
      insert into academy_media (kind, storage_path, rights) values ('pdf', 'academy-private/test.pdf', 'hcps_owned') returning id into v_med;
      perform set_config('academy.op', '', true);
      if v_m1 then
        insert into academy_external_certs (learner_id, course_id, manufacturer_slug, status, upload_media_id, certificate_uploaded_at)
          values (v_learner, v_course, 'golden-technologies', 'certificate_uploaded', v_med, now()) returning id into v_ext;
        perform academy_op_review_external_cert(ADMIN, v_ext, 'verified', 'golden_certificate', null, null);
      else
        insert into academy_external_certs (learner_id, course_id, manufacturer_slug, status, upload_media_id, certificate_uploaded_at,
                                            evidence_type, verified_by, verified_at)
          values (v_learner, v_course, 'golden-technologies', 'verified', v_med, now(), 'golden_certificate', 'test', now());
      end if;
      ok := true;
    exception when others then ok := false; procedure_result := sqlerrm; end;
    insert into t_results values (26, 'A Golden credential can be verified with an uploaded certificate', case when ok then 'PASS' else 'FAIL' end, coalesce(procedure_result,''));
    select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb)::text into v_saved from t_results r where r.n > 10;
    raise exception 'academy_tests_rollback' using detail = v_saved;
  exception when others then
    if sqlerrm <> 'academy_tests_rollback' then raise; end if;  -- any unexpected error stops the run
    get stacked diagnostics v_saved = pg_exception_detail;
  end;
  insert into t_results select * from jsonb_populate_recordset(null::t_results, v_saved::jsonb);
end $$;

-- Check 27 (not one of the 26 tests): nothing from the behaviour tests remained.
insert into t_results select 27, 'Check: no test data left behind in any academy table',
  case when (select count(*) from academy_learners) + (select count(*) from academy_courses) + (select count(*) from academy_course_versions)
          + (select count(*) from academy_modules) + (select count(*) from academy_lessons) + (select count(*) from academy_questions)
          + (select count(*) from academy_media) + (select count(*) from product_facts) + (select count(*) from academy_content_refs)
          + (select count(*) from academy_enrollments) + (select count(*) from academy_progress) + (select count(*) from academy_attempts)
          + (select count(*) from academy_certificates) + (select count(*) from academy_external_certs) + (select count(*) from academy_events)
          + (select count(*) from academy_memberships) + (select count(*) from academy_invites) + (select count(*) from academy_handoff_codes) = 0
       then 'PASS' else 'FAIL' end, '';

select n as "#", test, result, detail from t_results order by n;
