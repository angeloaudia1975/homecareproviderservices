-- =============================================================================================
-- HCPS Academy — A2A M1 acceptance tests (rev 2)        supabase/academy_a2a_m1_acceptance_tests.sql
-- Run right after M1, in the Supabase SQL editor (as the database owner, as the editor does). Tests 1-3 only read.
-- Tests 4-42 create test rows inside a sub-transaction that is always undone (a deliberate exception rolls it back
-- after the results are saved). Inside that sub-transaction the certificates switch is turned on for the issuance
-- tests and test 25 adds a temporary refusing trigger to the audit table; both are undone with everything else and
-- are never visible to any other session. The results table is the LAST statement, so the editor shows it.
-- Check 43 confirms nothing was left behind and phase2_flags is exactly as before.
-- Uses existing rows only as references: one dealer, Golden, two auth users, one active HCPS administrator.
-- =============================================================================================
drop table if exists t_m1;
create temp table t_m1 (n int, test text, result text, detail text);
drop table if exists t_m1_flags;
create temp table t_m1_flags as select value from app_settings where key = 'phase2_flags';

-- ---------- Structure and privileges (read-only) ----------
insert into t_m1
select 1, 'M1 installed: 18 academy_op functions (11 operations + 7 helpers), 1 guard function, 6 guard triggers',
  case when (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname like 'academy\_op\_%') = 18
        and exists (select 1 from pg_proc where proname = 'academy_audited_guard')
        and (select count(*) from pg_trigger where tgname = 'academy_audited_guard' and not tgisinternal) = 6
       then 'PASS' else 'FAIL' end, ''
union all
select 2, 'Only the server role can run the 11 operations; nobody but the owner can run the helpers or the guard; nothing for public/anon/authenticated',
  case when (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname like 'academy\_op\_%' and p.prosecdef
                and has_function_privilege('service_role', p.oid, 'EXECUTE')) = 11
        and not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                         where n.nspname = 'public' and (p.proname like 'academy\_op\_%' or p.proname = 'academy_audited_guard')
                           and not p.prosecdef and has_function_privilege('service_role', p.oid, 'EXECUTE'))
        and not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace, unnest(array['anon','authenticated']) r
                         where n.nspname = 'public' and (p.proname like 'academy\_op\_%' or p.proname = 'academy_audited_guard')
                           and has_function_privilege(r, p.oid, 'EXECUTE'))
        and not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                         where n.nspname = 'public' and (p.proname like 'academy\_op\_%' or p.proname = 'academy_audited_guard')
                           and a.grantee = 0 and a.privilege_type = 'EXECUTE')
        and not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                         where n.nspname = 'public' and (p.proname like 'academy\_op\_%' or p.proname = 'academy_audited_guard')
                           and not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'))
       then 'PASS' else 'FAIL' end, ''
union all
select 3, 'A1 rules still in place (18 tables with RLS, 7 rule triggers)',
  case when (select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relrowsecurity
              and (c.relname like 'academy\_%' or c.relname = 'product_facts')) = 18
        and (select count(*) from pg_trigger where not tgisinternal and tgname in ('academy_modules_frozen','academy_lessons_frozen',
             'academy_questions_frozen','academy_course_versions_guard','product_facts_append_only','academy_events_append_only',
             'academy_certificates_guard')) = 7
       then 'PASS' else 'FAIL' end, '';

-- ---------- Behaviour (undone at the end) ----------
do $$
declare
  ADMIN text; v_u1 uuid; v_u2 uuid; v_dealer uuid; v_learner uuid; v_l2 uuid; v_mem uuid; v_course uuid; v_test_course uuid;
  v_c2 uuid; v_cd uuid; v_ver uuid; v_tver uuid; v_v2 uuid; v_vd uuid; v_mod uuid; v_q uuid[] := '{}'; v_qid uuid; x1 uuid; d1 uuid;
  v_enr uuid; v_tenr uuid; v_e2 uuid; v_ed uuid; v_ew uuid; v_att uuid; v_att2 uuid; v_tatt uuid; v_bad uuid; v_ext uuid;
  v_media uuid; v_fact uuid; v_fact2 uuid; v_cert jsonb; v_res jsonb; v_n0 bigint; v_n1 bigint; ok boolean; v_saved text; i int;
  v_role_ok boolean := true;
begin
  begin  -- sub-transaction: every write in here is undone at the end
    select 'staff:' || lower(email) into ADMIN from staff_users
     where coalesce(active, true) and lower(coalesce(role, '')) in ('president','admin','owner') order by email limit 1;
    select id into v_u1 from auth.users order by created_at, id limit 1;
    select id into v_u2 from auth.users order by created_at, id offset 1 limit 1;
    select id into v_dealer from public.dealers limit 1;
    if ADMIN is null or v_u1 is null or v_u2 is null or v_dealer is null then
      insert into t_m1 values (4, 'Behaviour tests', 'SKIP', 'needs an active HCPS administrator, two auth users and one dealer'); return;
    end if;
    -- the certificates switch, on for this undone sub-transaction only
    if exists (select 1 from app_settings where key = 'phase2_flags') then
      update app_settings set value = value || '{"academy_certificates": true}' where key = 'phase2_flags';
    else
      insert into app_settings (key, value) values ('phase2_flags', '{"academy_certificates": true}');
    end if;
    insert into academy_learners (auth_user_id, full_name, email) values (v_u1, 'Test Learner', 'm1test@example.com') returning id into v_learner;
    insert into academy_learners (auth_user_id, full_name, email) values (v_u2, 'Test Learner 2', 'm1test2@example.com') returning id into v_l2;
    insert into academy_memberships (learner_id, dealer_id, role, access_type, created_by)
      values (v_learner, v_dealer, 'learner', 'training_only', 'test') returning id into v_mem;
    insert into academy_courses (slug, manufacturer_slug, title, course_type, issuer)
      values ('m1-test-course', 'golden-technologies', 'M1 test', 'hcps_certification', 'hcps') returning id into v_course;
    insert into academy_courses (slug, title, course_type, issuer)
      values ('test-m1-pilot', 'TEST — pilot', 'hcps_certification', 'hcps') returning id into v_test_course;
    insert into academy_courses (slug, title, course_type, issuer) values ('m1-test-other', 'Other', 'hcps_certification', 'hcps') returning id into v_c2;
    insert into academy_courses (slug, title, course_type, issuer) values ('m1-test-draft', 'Draft', 'hcps_certification', 'hcps') returning id into v_cd;
    insert into academy_course_versions (course_id, version, exam_questions, pass_mark) values (v_course, 1, 5, 80) returning id into v_ver;
    insert into academy_course_versions (course_id, version, exam_questions, pass_mark) values (v_test_course, 1, 1, 80) returning id into v_tver;
    insert into academy_course_versions (course_id, version, exam_questions) values (v_c2, 1, 1) returning id into v_v2;
    insert into academy_course_versions (course_id, version, exam_questions) values (v_cd, 1, 1) returning id into v_vd;
    insert into academy_modules (version_id, position, title) values (v_ver, 1, 'M1') returning id into v_mod;
    for i in 1..5 loop
      insert into academy_questions (version_id, module_id, kind, prompt, choices, answer_key, explanation, objective_tags)
        values (v_ver, v_mod, case when i = 5 then 'multi' else 'single' end, 'Q' || i, '[{"id":"a"},{"id":"b"},{"id":"c"}]',
                case when i = 5 then '["a","c"]'::jsonb else '"a"'::jsonb end, 'Because', array['topic-' || i]) returning id into v_qid;
      v_q := v_q || v_qid;
    end loop;
    insert into academy_questions (version_id, kind, prompt, choices, answer_key, explanation, objective_tags)
      values (v_tver, 'single', 'T', '[{"id":"a"},{"id":"b"}]', '"a"', 'Because', array['t']);
    insert into academy_questions (version_id, kind, prompt, choices, answer_key, explanation)
      values (v_v2, 'single', 'X', '[{"id":"a"},{"id":"b"}]', '"a"', 'Because') returning id into x1;
    insert into academy_questions (version_id, kind, prompt, choices, answer_key, explanation)
      values (v_vd, 'single', 'D', '[{"id":"a"},{"id":"b"}]', '"a"', 'Because') returning id into d1;

    -- 4-6 Training Manager role
    begin update academy_memberships set role = 'training_manager' where id = v_mem; ok := false;
    exception when insufficient_privilege then ok := true; end;
    insert into t_m1 values (4, 'A direct change to the Training Manager role is refused', case when ok then 'PASS' else 'FAIL' end, '');
    select count(*) into v_n0 from academy_events;
    v_res := academy_op_set_training_manager(ADMIN, v_mem, true, 'test');
    select count(*) into v_n1 from academy_events;
    insert into t_m1 values (5, 'The audited operation grants the role and writes exactly one audit row',
      case when v_res->>'role' = 'training_manager' and v_n1 = v_n0 + 1
            and exists (select 1 from academy_events where entity_id = v_mem::text and action = 'grant_training_manager' and actor = ADMIN) then 'PASS' else 'FAIL' end, '');
    v_res := academy_op_set_training_manager(ADMIN, v_mem, false, 'test');
    insert into t_m1 values (6, 'The audited operation revokes the role', case when v_res->>'role' = 'learner' then 'PASS' else 'FAIL' end, '');

    -- 7-10 Product facts
    begin insert into product_facts (manufacturer_slug, model_code, field, value, field_class, status, source_url, source_label, verified_on, verified_by)
            values ('golden-technologies','PR999','capacity.med','400','approval_required','verified','https://example.com','test',current_date,'test'); ok := false;
    exception when insufficient_privilege then ok := true; end;
    insert into t_m1 values (7, 'A direct product-fact insert is refused', case when ok then 'PASS' else 'FAIL' end, '');
    begin perform academy_op_record_fact(ADMIN, jsonb_build_object('manufacturer_slug','golden-technologies','model_code','PR999',
            'field','capacity.med','value',400,'field_class','approval_required','status','verified','source_url','https://example.com',
            'source_label','test','verified_on',current_date,'verified_by','test'), null, null); ok := false;
    exception when others then ok := sqlstate = '22023'; end;
    insert into t_m1 values (8, 'An approval-required fact without an approver is refused', case when ok then 'PASS' else 'FAIL' end, '');
    v_res := academy_op_record_fact(ADMIN, jsonb_build_object('manufacturer_slug','golden-technologies','model_code','PR999',
            'field','capacity.med','value',400,'field_class','approval_required','status','verified','source_url','https://example.com',
            'source_label','test','verified_on',current_date,'verified_by','test'), null, ADMIN);
    v_fact := (v_res->>'id')::uuid;
    v_res := academy_op_record_fact(ADMIN, jsonb_build_object('manufacturer_slug','golden-technologies','model_code','PR999',
            'field','capacity.med','value',500,'field_class','approval_required','status','verified','source_url','https://example.com',
            'source_label','test','verified_on',current_date,'verified_by','test'), v_fact, ADMIN);
    v_fact2 := (v_res->>'id')::uuid;
    insert into t_m1 values (9, 'Superseding keeps history: old row closed and pointing at the new one',
      case when (select replaced_by from product_facts where id = v_fact) = v_fact2
            and (select value from product_facts where id = v_fact2) = '500'::jsonb
            and (select count(*) from product_facts where model_code = 'PR999' and valid_to is null) = 1 then 'PASS' else 'FAIL' end, '');
    v_res := academy_op_withdraw_fact(ADMIN, v_fact2, 'Disputed by manufacturer');
    insert into t_m1 values (10, 'Withdrawing with no replacement: current row is awaiting manufacturer with no value',
      case when v_res->>'status' = 'awaiting_manufacturer' and v_res->'value' = 'null'::jsonb
            and (select replaced_by from product_facts where id = v_fact2) = (v_res->>'id')::uuid then 'PASS' else 'FAIL' end, '');

    -- 11-14 Publishing
    begin update academy_course_versions set status = 'published', published_at = now(), published_by = 'x' where id = v_ver; ok := false;
    exception when insufficient_privilege then ok := true; end;
    insert into t_m1 values (11, 'A direct publish is refused', case when ok then 'PASS' else 'FAIL' end, '');
    insert into academy_content_refs (version_id, question_id, manufacturer_slug, model_code, field)
      values (v_ver, v_q[1], 'golden-technologies', 'PR999', 'capacity.med');
    begin perform academy_op_publish_version(ADMIN, v_ver); ok := false;
    exception when others then ok := sqlstate = '22023' and sqlerrm like '%not verified%'; end;
    insert into t_m1 values (12, 'Publishing is refused while an exam question relies on an unverified fact', case when ok then 'PASS' else 'FAIL' end, '');
    v_res := academy_op_record_fact(ADMIN, jsonb_build_object('manufacturer_slug','golden-technologies','model_code','PR999',
            'field','capacity.med','value',400,'field_class','approval_required','status','verified','source_url','https://example.com',
            'source_label','test','verified_on',current_date,'verified_by','test'),
            (select id from product_facts where model_code = 'PR999' and valid_to is null), ADMIN);
    v_res := academy_op_publish_version(ADMIN, v_ver);
    insert into t_m1 values (13, 'Publishing works once the fact is verified, and pins the fact version',
      case when v_res->>'status' = 'published'
            and (select pinned_fact_id from academy_content_refs where question_id = v_q[1]) =
                (select id from product_facts where model_code = 'PR999' and valid_to is null) then 'PASS' else 'FAIL' end, '');
    begin perform academy_op_retire_version(ADMIN, v_ver, ''); ok := false;
    exception when others then ok := sqlstate = '22023'; end;
    insert into t_m1 values (14, 'Retiring a version needs a reason', case when ok then 'PASS' else 'FAIL' end, '');
    perform academy_op_publish_version(ADMIN, v_tver);
    perform academy_op_publish_version(ADMIN, v_v2);

    -- 15-21 Exams
    insert into academy_enrollments (learner_id, version_id, access_source) values (v_learner, v_ver, 'admin_grant') returning id into v_enr;
    v_att := (academy_op_start_attempt('learner:' || v_learner, v_enr)->>'id')::uuid;
    begin update academy_attempts set answers = '{}', submitted_at = now(), score = 100, passed = true, graded_at = now() where id = v_att; ok := false;
    exception when insufficient_privilege then ok := true; end;
    insert into t_m1 values (15, 'A direct exam submission or score is refused', case when ok then 'PASS' else 'FAIL' end, '');
    -- 4 of 5 right (the multi-answer question given in a different order) = exactly 80% = pass
    v_res := academy_op_submit_attempt('learner:' || v_learner, v_att, jsonb_build_object(v_q[1]::text,'a', v_q[2]::text,'a', v_q[3]::text,'a',
              v_q[4]::text,'b', v_q[5]::text, jsonb_build_array('c','a')));
    insert into t_m1 values (16, 'Grading in the database: 4 of 5 = 80% passes at an 80 pass mark; multi-answer order does not matter',
      case when (v_res->>'score')::int = 80 and (v_res->>'passed')::boolean and v_res->'study_topics' = '["topic-4"]'::jsonb then 'PASS' else 'FAIL' end, v_res::text);
    insert into t_m1 values (17, 'The result never contains the answer key or per-question answers',
      case when not (v_res ? 'answer_key') and not (v_res ? 'answers') and (select count(*) from jsonb_object_keys(v_res)) = 3 then 'PASS' else 'FAIL' end, '');
    begin perform academy_op_submit_attempt('learner:' || v_learner, v_att, '{}'); ok := false;
    exception when others then ok := sqlstate = '22023'; end;
    insert into t_m1 values (18, 'An attempt can be submitted only once', case when ok then 'PASS' else 'FAIL' end, '');
    v_att2 := (academy_op_start_attempt('learner:' || v_learner, v_enr)->>'id')::uuid;
    v_res := academy_op_submit_attempt('learner:' || v_learner, v_att2, jsonb_build_object(v_q[1]::text,'a', v_q[2]::text,'a', v_q[3]::text,'a',
              v_q[4]::text,'b', v_q[5]::text,'b'));
    insert into t_m1 values (19, '3 of 5 = 60% fails at an 80 pass mark',
      case when (v_res->>'score')::int = 60 and not (v_res->>'passed')::boolean then 'PASS' else 'FAIL' end, '');
    begin perform academy_op_correct_attempt(ADMIN, v_att2, 100, ' '); ok := false;
    exception when others then ok := sqlstate = '22023'; end;
    insert into t_m1 values (20, 'Correcting an exam result needs a reason', case when ok then 'PASS' else 'FAIL' end, '');
    begin delete from academy_attempts where id = v_att2; ok := false;
    exception when insufficient_privilege then ok := true; end;
    insert into t_m1 values (21, 'Exam attempts cannot be deleted', case when ok then 'PASS' else 'FAIL' end, '');

    -- 22-26 HCPS certificates
    begin insert into academy_certificates (cert_number, learner_id, enrollment_id, version_id, attempt_id, learner_name)
            values ('HCPS-AAAA-BBBB', v_learner, v_enr, v_ver, v_att, 'x'); ok := false;
    exception when insufficient_privilege then ok := true; end;
    insert into t_m1 values (22, 'A direct certificate insert is refused', case when ok then 'PASS' else 'FAIL' end, '');
    begin perform academy_op_issue_certificate('system:grader', v_att2, null); ok := false;
    exception when others then ok := sqlstate = '22023'; end;
    insert into t_m1 values (23, 'A failed attempt earns no certificate', case when ok then 'PASS' else 'FAIL' end, '');
    insert into academy_enrollments (learner_id, version_id, access_source) values (v_learner, v_tver, 'admin_grant') returning id into v_tenr;
    v_tatt := (academy_op_start_attempt('learner:' || v_learner, v_tenr)->>'id')::uuid;
    perform academy_op_submit_attempt('learner:' || v_learner, v_tatt, jsonb_build_object((select id from academy_questions where version_id = v_tver)::text, 'a'));
    begin perform academy_op_issue_certificate('system:grader', v_tatt, null); ok := false;
    exception when others then ok := sqlstate = '22023' and sqlerrm like '%TEST course%'; end;
    insert into t_m1 values (24, 'A TEST course never issues a certificate', case when ok then 'PASS' else 'FAIL' end, '');
    select count(*) into v_n0 from academy_certificates;
    begin
      execute 'create function pg_temp.m1_refuse_audit() returns trigger language plpgsql as $f$ begin raise exception ''audit store unavailable (test)''; end $f$';
      execute 'create trigger zz_m1_refuse_audit before insert on academy_events for each row execute function pg_temp.m1_refuse_audit()';
      perform academy_op_issue_certificate('system:grader', v_att, 'HQ'); ok := false;
    exception when others then ok := sqlerrm like '%audit store unavailable%'; end;
    insert into t_m1 values (25, 'If the audit row cannot be written, no certificate is issued (all or nothing)',
      case when ok and (select count(*) from academy_certificates) = v_n0 then 'PASS' else 'FAIL' end, '');
    v_cert := academy_op_issue_certificate('system:grader', v_att, 'HQ');
    v_res := academy_op_revoke_certificate(ADMIN, (v_cert->>'id')::uuid, 'Issued in error');
    insert into t_m1 values (26, 'Issue gives an HCPS-XXXX-XXXX number valid 12 months; revoke records who and why',
      case when v_cert->>'cert_number' ~ '^HCPS-[A-Z0-9]{4}-[A-Z0-9]{4}$'
            and (v_cert->>'expires_at')::timestamptz > now() + interval '11 months'
            and v_res->>'status' = 'revoked' and v_res->>'revoked_reason' = 'Issued in error' and v_res->>'revoked_by' = ADMIN then 'PASS' else 'FAIL' end, '');

    -- 27-30 Golden-issued credentials
    insert into academy_external_certs (learner_id, course_id, manufacturer_slug, status) values (v_learner, v_course, 'golden-technologies', 'exam_reported')
      returning id into v_ext;
    begin update academy_external_certs set status = 'verified', verified_by = 'x', verified_at = now() where id = v_ext; ok := false;
    exception when insufficient_privilege then ok := true; end;
    insert into t_m1 values (27, 'A direct Golden verification is refused', case when ok then 'PASS' else 'FAIL' end, '');
    begin perform academy_op_review_external_cert(ADMIN, v_ext, 'verified', 'golden_certificate', null, null); ok := false;
    exception when check_violation then ok := true; end;
    insert into t_m1 values (28, 'Verification without evidence is refused', case when ok then 'PASS' else 'FAIL' end, '');
    begin perform academy_op_review_external_cert(ADMIN, v_ext, 'rejected', null, null, ''); ok := false;
    exception when others then ok := sqlstate = '22023'; end;
    insert into t_m1 values (29, 'A rejection needs a note', case when ok then 'PASS' else 'FAIL' end, '');
    insert into academy_media (kind, storage_path, rights) values ('pdf', 'academy-private/test.pdf', 'hcps_owned') returning id into v_media;
    update academy_external_certs set status = 'certificate_uploaded', upload_media_id = v_media, certificate_uploaded_at = now() where id = v_ext;
    v_res := academy_op_review_external_cert(ADMIN, v_ext, 'verified', 'golden_certificate', null, null);
    insert into t_m1 values (30, 'Verification with an uploaded Golden certificate works and records who verified',
      case when v_res->>'status' = 'verified' and v_res->>'verified_by' = ADMIN then 'PASS' else 'FAIL' end, '');

    -- ===== Rev 2 refinements (A–E, 10 Oct 2026 22:29) =====
    -- A. corrections: score only, pass/fail derived, 0-100
    v_res := academy_op_correct_attempt(ADMIN, v_att2, 85, 'Question 5 regraded');
    ok := (v_res->>'passed')::boolean;
    v_res := academy_op_correct_attempt(ADMIN, v_att2, 70, 'Question 5 regraded back');
    ok := ok and not (v_res->>'passed')::boolean
          and to_regprocedure('public.academy_op_correct_attempt(text,uuid,integer,boolean,text)') is null;
    insert into t_m1 values (31, 'A: a correction sets the score only; pass/fail follows the pass mark (no way to record a contradicting result)',
      case when ok then 'PASS' else 'FAIL' end, '');
    begin perform academy_op_correct_attempt(ADMIN, v_att2, 101, 'x'); ok := false; exception when others then ok := sqlstate = '22023'; end;
    begin perform academy_op_correct_attempt(ADMIN, v_att2, -1, 'x'); ok := ok and false; exception when others then ok := ok and sqlstate = '22023'; end;
    insert into t_m1 values (32, 'A: a corrected score outside 0–100 is refused', case when ok then 'PASS' else 'FAIL' end, '');
    -- B. a certified pass cannot become a fail while the certificate is valid
    insert into academy_enrollments (learner_id, version_id, access_source) values (v_l2, v_ver, 'admin_grant') returning id into v_e2;
    v_bad := (academy_op_start_attempt('learner:' || v_l2, v_e2)->>'id')::uuid;
    perform academy_op_submit_attempt('learner:' || v_l2, v_bad, jsonb_build_object(v_q[1]::text,'a', v_q[2]::text,'a', v_q[3]::text,'a',
              v_q[4]::text,'a', v_q[5]::text, jsonb_build_array('a','c')));
    v_cert := academy_op_issue_certificate(ADMIN, v_bad, 'HQ');
    begin perform academy_op_correct_attempt(ADMIN, v_bad, 0, 'Misconduct'); ok := false;
    exception when others then ok := sqlerrm like '%revoke it first%'; end;
    ok := ok and (select passed from academy_attempts where id = v_bad)
             and (select status from academy_certificates where id = (v_cert->>'id')::uuid) = 'valid';
    perform academy_op_revoke_certificate(ADMIN, (v_cert->>'id')::uuid, 'Misconduct');
    v_res := academy_op_correct_attempt(ADMIN, v_bad, 0, 'Misconduct');
    ok := ok and not (v_res->>'passed')::boolean;
    insert into t_m1 values (33, 'B: a certified pass is not corrected to a fail until the certificate is revoked (both steps audited)',
      case when ok then 'PASS' else 'FAIL' end, '');
    -- C. question sets
    begin
      execute 'set local role service_role';
      begin
        insert into academy_attempts (enrollment_id, question_ids) values (v_enr, v_q); ok := false;
      exception when others then ok := sqlstate = '42501'; end;
      execute 'reset role';
    exception when others then v_role_ok := false; ok := null; end;
    insert into t_m1 values (34, 'C: the server role cannot create an exam attempt directly (the database draws the questions)',
      case when ok then 'PASS' when ok is null then 'SKIP' else 'FAIL' end, case when ok is null then 'this editor session cannot switch to service_role' else '' end);
    insert into academy_enrollments (learner_id, version_id, access_source) values (v_learner, v_vd, 'admin_grant') returning id into v_ed;
    insert into academy_enrollments (learner_id, version_id, access_source) values (v_l2, v_v2, 'admin_grant') returning id into v_ew;
    ok := true;
    -- bad sets made by the owner with the marker (as a code bug would): another version's question, a duplicate, too few, a draft version
    perform set_config('academy.op', 'test-setup', true);
    insert into academy_attempts (enrollment_id, question_ids) values (v_e2, v_q[1:4] || x1) returning id into v_bad;
    perform set_config('academy.op', '', true);
    begin perform academy_op_submit_attempt('learner:' || v_l2, v_bad, '{}'); ok := false; exception when others then null; end;
    perform set_config('academy.op', 'test-setup', true);
    update academy_attempts set question_ids = v_q[1:4] || v_q[1] where id = v_bad;
    perform set_config('academy.op', '', true);
    begin perform academy_op_submit_attempt('learner:' || v_l2, v_bad, '{}'); ok := false; exception when others then null; end;
    perform set_config('academy.op', 'test-setup', true);
    update academy_attempts set question_ids = v_q[1:4] where id = v_bad;
    perform set_config('academy.op', '', true);
    begin perform academy_op_submit_attempt('learner:' || v_l2, v_bad, '{}'); ok := false; exception when others then null; end;
    perform set_config('academy.op', 'test-setup', true);
    insert into academy_attempts (enrollment_id, question_ids) values (v_ed, array[d1]) returning id into v_bad;
    perform set_config('academy.op', '', true);
    begin perform academy_op_submit_attempt('learner:' || v_learner, v_bad, '{}'); ok := false; exception when others then null; end;
    insert into t_m1 values (35, 'C: an attempt is not graded if a question is from another version, repeated, missing, or on an unpublished version',
      case when ok then 'PASS' else 'FAIL' end, '');
    begin perform academy_op_start_attempt('learner:' || v_learner, v_ed); ok := false; exception when others then ok := true; end;
    v_res := academy_op_start_attempt('learner:' || v_l2, v_ew);
    ok := ok and (select cardinality(question_ids) = 1 and question_ids = array[x1] from academy_attempts where id = (v_res->>'id')::uuid)
             and not (v_res ? 'answer_key');
    begin perform academy_op_start_attempt('learner:' || v_l2, v_ew); ok := ok and false; exception when others then null; end;
    insert into t_m1 values (36, 'C: start draws the version''s count of distinct active exam questions; one open attempt; never on a draft',
      case when ok then 'PASS' else 'FAIL' end, '');
    begin perform academy_op_submit_attempt('learner:' || v_learner, (v_res->>'id')::uuid, jsonb_build_object(x1::text, 'a')); ok := false;
    exception when others then ok := sqlstate = '42501'; end;
    insert into t_m1 values (37, 'C: a learner cannot submit another learner''s attempt', case when ok then 'PASS' else 'FAIL' end, '');
    update academy_enrollments set status = 'withdrawn' where id = v_ew;
    begin perform academy_op_submit_attempt('learner:' || v_l2, (v_res->>'id')::uuid, jsonb_build_object(x1::text, 'a')); ok := false;
    exception when others then ok := sqlerrm like '%withdrawn%'; end;
    insert into t_m1 values (38, 'C: a withdrawn enrollment cannot submit (or start) an exam', case when ok then 'PASS' else 'FAIL' end, '');
    -- D. the guard and the actors
    ok := not exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace
                        and proname in ('academy_op_begin','academy_op_end','academy_op_audit','academy_op_norm_answer',
                                        'academy_op_actor_staff','academy_op_actor_learner','academy_op_attempt_check')
                        and has_function_privilege('service_role', oid, 'EXECUTE'));
    if v_role_ok then
      begin
        execute 'set local role service_role';
        begin
          perform set_config('academy.op', 'forged', true);
          update academy_memberships set role = 'training_manager' where id = v_mem; ok := false;
        exception when others then ok := ok and sqlstate = '42501'; end;
        execute 'reset role';
        perform set_config('academy.op', '', true);
      exception when others then ok := false; end;
    end if;
    insert into t_m1 values (39, 'D: the server role can neither call the helpers nor make a guarded change by setting the marker itself',
      case when ok and (select role from academy_memberships where id = v_mem) = 'learner' then 'PASS' else 'FAIL' end,
      case when not v_role_ok then 'marker part skipped: this editor session cannot switch to service_role' else '' end);
    begin perform academy_op_set_training_manager('staff:nobody@example.invalid', v_mem, true, 'x'); ok := false; exception when others then ok := sqlstate = '42501'; end;
    begin perform academy_op_set_training_manager('test', v_mem, true, 'x'); ok := ok and false; exception when others then ok := ok and sqlstate = '42501'; end;
    begin perform academy_op_record_fact(ADMIN, jsonb_build_object('manufacturer_slug','golden-technologies','model_code','PR998','field','zones',
            'value',2,'field_class','approval_required','status','verified','source_url','https://example.com','source_label','test',
            'verified_on',current_date,'verified_by','test'), null, 'president'); ok := ok and false;
    exception when others then ok := ok and sqlstate = '42501'; end;
    begin perform academy_op_submit_attempt('test', v_att, '{}'); ok := ok and false; exception when others then ok := ok and sqlstate = '42501'; end;
    insert into t_m1 values (40, 'D: actors must be an active HCPS administrator (staff:<email>) or the record''s own learner; approvers too',
      case when ok then 'PASS' else 'FAIL' end, '');
    ok := (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like 'academy\_op\_%' and prosecdef
             and pg_get_userbyid(proowner) = (select pg_get_userbyid(proowner) from pg_proc where oid = 'public.academy_audited_guard()'::regprocedure)) = 11;
    insert into t_m1 values (41, 'D: the 11 operations run with their owner''s fixed rights (security definer, pinned search path)',
      case when ok then 'PASS' else 'FAIL' end, '');
    -- E. issuance prerequisites
    insert into academy_enrollments (learner_id, version_id, access_source) values (v_learner, v_v2, 'admin_grant') returning id into v_bad;
    v_res := academy_op_start_attempt('learner:' || v_learner, v_bad);
    perform academy_op_submit_attempt('learner:' || v_learner, (v_res->>'id')::uuid, jsonb_build_object(x1::text, 'a'));
    update app_settings set value = value || '{"academy_certificates": false}' where key = 'phase2_flags';
    begin perform academy_op_issue_certificate('system:grader', (v_res->>'id')::uuid, 'HQ'); ok := false;
    exception when others then ok := sqlerrm like '%switched off%'; end;
    update app_settings set value = value || '{"academy_certificates": true}' where key = 'phase2_flags';
    begin perform academy_op_issue_certificate('grader', (v_res->>'id')::uuid, 'HQ'); ok := ok and false; exception when others then ok := ok and true; end;
    update academy_enrollments set status = 'withdrawn' where id = v_bad;
    begin perform academy_op_issue_certificate('system:grader', (v_res->>'id')::uuid, 'HQ'); ok := ok and false; exception when others then ok := ok and true; end;
    update academy_enrollments set status = 'in_progress' where id = v_bad;
    perform academy_op_issue_certificate('system:grader', (v_res->>'id')::uuid, 'HQ');
    begin perform academy_op_issue_certificate('system:grader', (v_res->>'id')::uuid, 'HQ'); ok := ok and false;
    exception when others then ok := ok and sqlerrm like '%already has%'; end;
    insert into t_m1 values (42, 'E: no certificate with the switch off, from an unknown issuer, for a withdrawn enrollment, or twice per enrollment',
      case when ok then 'PASS' else 'FAIL' end, '');

    select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb)::text into v_saved from t_m1 r where r.n > 3;
    raise exception 'academy_m1_tests_rollback' using detail = v_saved;
  exception when others then
    if sqlerrm <> 'academy_m1_tests_rollback' then raise; end if;  -- any unexpected error stops the run
    get stacked diagnostics v_saved = pg_exception_detail;
  end;
  insert into t_m1 select * from jsonb_populate_recordset(null::t_m1, v_saved::jsonb);
end $$;

-- Check 43 (not one of the 42 tests): nothing from the behaviour tests remained, and phase2_flags is exactly as before.
insert into t_m1 select 43, 'Check: no test data left in any academy table; phase2_flags unchanged (certificates switch as before)',
  case when (select count(*) from academy_learners) + (select count(*) from academy_courses) + (select count(*) from academy_course_versions)
          + (select count(*) from academy_modules) + (select count(*) from academy_questions) + (select count(*) from academy_media)
          + (select count(*) from product_facts) + (select count(*) from academy_content_refs) + (select count(*) from academy_enrollments)
          + (select count(*) from academy_attempts) + (select count(*) from academy_certificates) + (select count(*) from academy_external_certs)
          + (select count(*) from academy_events) + (select count(*) from academy_memberships) = 0
        and (select count(*) from app_settings where key = 'phase2_flags') = (select count(*) from t_m1_flags)
        and coalesce((select value from app_settings where key = 'phase2_flags') = (select value from t_m1_flags), true)
        and not exists (select 1 from pg_trigger where tgname = 'zz_m1_refuse_audit')
       then 'PASS' else 'FAIL' end, '';

select n as "#", test, result, detail from t_m1 order by n;
