-- LOCAL TEST ONLY (test/academy-a2a.pg.test.js). The M1 final security refinements requested by Angelo on 10 Oct 2026
-- 22:29 (A–E). Each test names the defect it guards against. The same file runs against the ORIGINAL M1 (to show which
-- tests fail there) and the REFINED M1 (all must pass). Calls that differ between the two versions are wrapped so a
-- missing function or signature counts as a failure, never a crash. Everything is rolled back.
begin;
create temp table t_h (n int, test text, result text, detail text);

-- Attempts for tests that need a deliberately BAD attempt (simulating a code bug or a privileged path): made by the
-- database owner with the operation marker, which both versions accept from the owner.
create function pg_temp.h_attempt(p_enr uuid, p_qs uuid[]) returns uuid language plpgsql as $$
declare v uuid;
begin
  perform set_config('academy.op', 'test-setup', true);
  insert into academy_attempts (enrollment_id, question_ids) values (p_enr, p_qs) returning id into v;
  perform set_config('academy.op', '', true);
  return v;
end $$;
-- Grade an attempt directly (owner + marker) — only to build a "passed on a draft version" case for test 25.
create function pg_temp.h_grade(p_att uuid) returns void language plpgsql as $$
begin
  perform set_config('academy.op', 'test-setup', true);
  update academy_attempts set answers = '{}', submitted_at = now(), score = 100, passed = true, graded_at = now() where id = p_att;
  perform set_config('academy.op', '', true);
end $$;
-- Issue / correct through whichever signature this M1 has.
create function pg_temp.h_issue(p_actor text, p_att uuid) returns jsonb language plpgsql as $$
begin
  if to_regprocedure('public.academy_op_issue_certificate(text,uuid,text)') is not null then
    return academy_op_issue_certificate(p_actor, p_att, 'HQ');
  end if;
  return academy_op_issue_certificate(split_part(p_actor, ':', 1), p_actor, p_att, 'HQ');
end $$;
create function pg_temp.h_correct(p_actor text, p_att uuid, p_score int, p_reason text) returns jsonb language plpgsql as $$
begin
  if to_regprocedure('public.academy_op_correct_attempt(text,uuid,integer,text)') is not null then
    return academy_op_correct_attempt(p_actor, p_att, p_score, p_reason);
  end if;
  return academy_op_correct_attempt(p_actor, p_att, p_score, p_score >= 80, p_reason);
end $$;
create function pg_temp.h_switch(p_on boolean) returns void language plpgsql as $$
begin
  if exists (select 1 from app_settings where key = 'phase2_flags') then
    update app_settings set value = value || jsonb_build_object('academy_certificates', p_on) where key = 'phase2_flags';
  else
    insert into app_settings (key, value) values ('phase2_flags', jsonb_build_object('academy_certificates', p_on));
  end if;
end $$;

do $$
declare
  ADMIN constant text := 'staff:admin@test.example';
  REP   constant text := 'staff:rep@test.example';
  v_u1 uuid; v_u2 uuid; v_l1 uuid; v_l2 uuid; v_mem uuid; v_dealer uuid;
  v_c uuid; v_v uuid; v_c2 uuid; v_v2 uuid; v_cd uuid; v_vd uuid; v_ct uuid; v_vt uuid;
  q1 uuid; q2 uuid; q3 uuid; x1 uuid; d1 uuid; t1 uuid;
  e1 uuid; e2 uuid; ed uuid; et uuid; ew uuid; e3 uuid;
  a uuid; a2 uuid; r jsonb; ok boolean; msg text; v_cert uuid; n bigint;
begin
  select id into v_u1 from auth.users order by created_at, id limit 1;
  select id into v_u2 from auth.users order by created_at, id offset 1 limit 1;
  select id into v_dealer from dealers order by business_name limit 1;
  insert into academy_learners (auth_user_id, full_name, email) values (v_u1, 'H One', 'h1@example.com') returning id into v_l1;
  insert into academy_learners (auth_user_id, full_name, email) values (v_u2, 'H Two', 'h2@example.com') returning id into v_l2;
  insert into academy_memberships (learner_id, dealer_id, role, access_type, created_by) values (v_l1, v_dealer, 'learner', 'training_only', 't') returning id into v_mem;
  -- C/V: the real exam (2 questions, pass mark 80) + a practice question; C2/V2: another course; CD/VD: a draft; CT/VT: TEST
  insert into academy_courses (slug, title, course_type, issuer) values ('h-course', 'H', 'hcps_certification', 'hcps') returning id into v_c;
  insert into academy_course_versions (course_id, version, exam_questions, pass_mark) values (v_c, 1, 2, 80) returning id into v_v;
  insert into academy_questions (version_id, kind, prompt, choices, answer_key, explanation, objective_tags)
    values (v_v, 'single', 'Q1', '[{"id":"a"},{"id":"b"}]', '"a"', 'B', '{t1}') returning id into q1;
  insert into academy_questions (version_id, kind, prompt, choices, answer_key, explanation, objective_tags)
    values (v_v, 'single', 'Q2', '[{"id":"a"},{"id":"b"}]', '"a"', 'B', '{t2}') returning id into q2;
  insert into academy_questions (version_id, kind, use, prompt, choices, answer_key, explanation)
    values (v_v, 'single', 'practice', 'P', '[{"id":"a"},{"id":"b"}]', '"a"', 'B') returning id into q3;
  insert into academy_courses (slug, title, course_type, issuer) values ('h-course-2', 'H2', 'hcps_certification', 'hcps') returning id into v_c2;
  insert into academy_course_versions (course_id, version, exam_questions) values (v_c2, 1, 1) returning id into v_v2;
  insert into academy_questions (version_id, kind, prompt, choices, answer_key, explanation)
    values (v_v2, 'single', 'X1', '[{"id":"a"},{"id":"b"}]', '"a"', 'B') returning id into x1;
  insert into academy_courses (slug, title, course_type, issuer) values ('h-draft', 'D', 'hcps_certification', 'hcps') returning id into v_cd;
  insert into academy_course_versions (course_id, version, exam_questions) values (v_cd, 1, 1) returning id into v_vd;
  insert into academy_questions (version_id, kind, prompt, choices, answer_key, explanation)
    values (v_vd, 'single', 'D1', '[{"id":"a"},{"id":"b"}]', '"a"', 'B') returning id into d1;
  insert into academy_courses (slug, title, course_type, issuer) values ('test-h-pilot', 'TEST', 'hcps_certification', 'hcps') returning id into v_ct;
  insert into academy_course_versions (course_id, version, exam_questions) values (v_ct, 1, 1) returning id into v_vt;
  insert into academy_questions (version_id, kind, prompt, choices, answer_key, explanation)
    values (v_vt, 'single', 'T1', '[{"id":"a"},{"id":"b"}]', '"a"', 'B') returning id into t1;
  perform academy_op_publish_version(ADMIN, v_v);
  perform academy_op_publish_version(ADMIN, v_v2);
  perform academy_op_publish_version(ADMIN, v_vt);
  insert into academy_enrollments (learner_id, version_id, access_source) values (v_l1, v_v, 'admin_grant') returning id into e1;
  insert into academy_enrollments (learner_id, version_id, access_source) values (v_l2, v_v, 'admin_grant') returning id into e2;
  insert into academy_enrollments (learner_id, version_id, access_source) values (v_l1, v_vd, 'admin_grant') returning id into ed;
  insert into academy_enrollments (learner_id, version_id, access_source) values (v_l1, v_vt, 'admin_grant') returning id into et;
  insert into academy_enrollments (learner_id, version_id, access_source) values (v_l2, v_v2, 'admin_grant') returning id into ew;
  insert into academy_enrollments (learner_id, version_id, access_source) values (v_l1, v_v2, 'admin_grant') returning id into e3;
  update academy_enrollments set status = 'withdrawn' where id = ew;
  perform pg_temp.h_switch(true);

  -- ===================== A. Exam corrections =====================
  a := pg_temp.h_attempt(e1, array[q1, q2]);
  perform academy_op_submit_attempt('learner:' || v_l1, a, jsonb_build_object(q1::text, 'a', q2::text, 'a'));   -- 100, passed
  begin perform pg_temp.h_correct(ADMIN, a, 150, 'x'); ok := false; exception when others then ok := true; end;
  insert into t_h values (1, 'A: a corrected score outside 0–100 is refused', case when ok then 'PASS' else 'FAIL' end, '');
  ok := to_regprocedure('public.academy_op_correct_attempt(text,uuid,integer,boolean,text)') is null;   -- no "passed" input at all
  begin
    r := pg_temp.h_correct(ADMIN, a, 60, 'Regraded question 2');
    ok := ok and (r->>'passed')::boolean = false;
    r := pg_temp.h_correct(ADMIN, a, 90, 'Regraded again');
    ok := ok and (r->>'passed')::boolean = true;
  exception when others then ok := false; msg := sqlerrm; end;
  insert into t_h values (2, 'A: a correction cannot record pass/fail that contradicts the score (pass = score ≥ pass mark)',
    case when ok then 'PASS' else 'FAIL' end, coalesce(msg, '')); msg := null;
  begin perform pg_temp.h_correct(ADMIN, a, 90, ''); ok := false; exception when others then ok := true; end;
  insert into t_h values (3, 'A: a correction needs a reason', case when ok then 'PASS' else 'FAIL' end, '');

  -- ===================== B. Certificate integrity on correction =====================
  begin
    v_cert := (pg_temp.h_issue('system:grader', a)->>'id')::uuid;
  exception when others then v_cert := null; msg := sqlerrm; end;
  ok := false;
  if v_cert is not null then
    begin perform pg_temp.h_correct(ADMIN, a, 0, 'Fraud found'); ok := false;
    exception when others then ok := true; msg := sqlerrm; end;
    ok := ok and (select passed from academy_attempts where id = a) and (select status from academy_certificates where id = v_cert) = 'valid';
  end if;
  insert into t_h values (4, 'B: an attempt with a valid certificate cannot be corrected to a fail until the certificate is revoked',
    case when ok then 'PASS' else 'FAIL' end, coalesce(msg, '')); msg := null;
  ok := false;
  if v_cert is not null then
    begin
      perform academy_op_revoke_certificate(ADMIN, v_cert, 'Fraud found');
      r := pg_temp.h_correct(ADMIN, a, 0, 'Fraud found');
      ok := (r->>'passed')::boolean = false
        and exists (select 1 from academy_events where entity_id = v_cert::text and action = 'revoke_certificate')
        and exists (select 1 from academy_events where entity_id = a::text and action = 'correct_attempt' and after->>'score' = '0');
    exception when others then ok := false; msg := sqlerrm; end;
  end if;
  insert into t_h values (5, 'B: after the certificate is revoked (its own audited step) the correction goes through; both are audited',
    case when ok then 'PASS' else 'FAIL' end, coalesce(msg, '')); msg := null;

  -- ===================== C. Exam question validation =====================
  begin
    execute 'set local role service_role';
    insert into academy_attempts (enrollment_id, question_ids) values (e2, array[q1, q2]);
    ok := false;
  exception when others then ok := true; end;
  execute 'reset role';
  insert into t_h values (6, 'C: an exam attempt cannot be created directly by the server role (questions are drawn by the database)',
    case when ok then 'PASS' else 'FAIL' end, '');

  begin
    r := academy_op_start_attempt('learner:' || v_l2, e2);
    a2 := (r->>'id')::uuid;
    ok := (select cardinality(question_ids) = 2 and question_ids @> array[q1, q2] from academy_attempts where id = a2)
          and not (r ? 'answer_key') and jsonb_array_length(r->'question_ids') = 2;
  exception when others then ok := false; msg := sqlerrm; end;
  insert into t_h values (12, 'C: starting an exam draws exactly the configured number of distinct active exam questions of the enrolled version',
    case when ok then 'PASS' else 'FAIL' end, coalesce(msg, '')); msg := null;
  begin perform academy_op_start_attempt('learner:' || v_l2, e2); ok := false; exception when others then ok := true; end;
  insert into t_h values (13, 'C: only one open exam attempt at a time', case when ok then 'PASS' else 'FAIL' end, '');
  if a2 is not null then perform academy_op_submit_attempt('learner:' || v_l2, a2, '{}'::jsonb); end if;   -- close it
  a := pg_temp.h_attempt(e2, array[q1, x1]);
  begin perform academy_op_submit_attempt('learner:' || v_l2, a, jsonb_build_object(q1::text, 'a', x1::text, 'a')); ok := false;
  exception when others then ok := true; end;
  insert into t_h values (7, 'C: an attempt holding a question from another course version is not graded', case when ok then 'PASS' else 'FAIL' end, '');
  a := pg_temp.h_attempt(e2, array[q1, q1]);
  begin perform academy_op_submit_attempt('learner:' || v_l2, a, jsonb_build_object(q1::text, 'a')); ok := false;
  exception when others then ok := true; end;
  insert into t_h values (8, 'C: an attempt with a duplicated question is not graded', case when ok then 'PASS' else 'FAIL' end, '');
  a := pg_temp.h_attempt(e2, array[q1]);
  begin perform academy_op_submit_attempt('learner:' || v_l2, a, jsonb_build_object(q1::text, 'a')); ok := false;
  exception when others then ok := true; end;
  insert into t_h values (9, 'C: an attempt with fewer questions than the version requires is not graded', case when ok then 'PASS' else 'FAIL' end, '');
  a := pg_temp.h_attempt(e2, array[q1, q3]);
  begin perform academy_op_submit_attempt('learner:' || v_l2, a, jsonb_build_object(q1::text, 'a', q3::text, 'a')); ok := false;
  exception when others then ok := true; end;
  insert into t_h values (10, 'C: an attempt holding a practice question is not graded', case when ok then 'PASS' else 'FAIL' end, '');
  a := pg_temp.h_attempt(ed, array[d1]);
  begin perform academy_op_submit_attempt('learner:' || v_l1, a, jsonb_build_object(d1::text, 'a')); ok := false;
  exception when others then ok := true; end;
  insert into t_h values (11, 'C: an attempt on an unpublished (draft) version is not graded', case when ok then 'PASS' else 'FAIL' end, '');

  begin perform academy_op_start_attempt('learner:' || v_l1, ed); ok := false; exception when others then ok := true; end;
  insert into t_h values (14, 'C: an exam cannot start on an unpublished version', case when ok then 'PASS' else 'FAIL' end, '');
  a := pg_temp.h_attempt(e2, array[q1, q2]);
  begin perform academy_op_submit_attempt('learner:' || v_l1, a, jsonb_build_object(q1::text, 'a', q2::text, 'a')); ok := false;
  exception when others then ok := true; end;
  insert into t_h values (15, 'C: a learner cannot submit (or substitute answers on) another learner''s attempt',
    case when ok then 'PASS' else 'FAIL' end, '');
  a := pg_temp.h_attempt(ew, array[x1]);
  begin perform academy_op_submit_attempt('learner:' || v_l2, a, jsonb_build_object(x1::text, 'a')); ok := false;
  exception when others then ok := true; end;
  begin perform academy_op_start_attempt('learner:' || v_l2, ew); ok := ok and false; exception when others then ok := ok and true; end;
  insert into t_h values (16, 'C: a withdrawn enrollment can neither start nor submit an exam', case when ok then 'PASS' else 'FAIL' end, '');
  begin perform pg_temp.h_attempt(e2, '{}'::uuid[]); ok := false; exception when others then ok := true; end;
  insert into t_h values (17, 'C: a zero-question attempt cannot exist', case when ok then 'PASS' else 'FAIL' end, '');

  -- ===================== D. The audited-operation guard =====================
  ok := not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
                      and p.proname in ('academy_op_begin','academy_op_end','academy_op_audit','academy_op_norm_answer')
                      and has_function_privilege('service_role', p.oid, 'EXECUTE'));
  insert into t_h values (18, 'D: the internal helpers (marker, audit row) cannot be called by the server role', case when ok then 'PASS' else 'FAIL' end, '');
  begin
    execute 'set local role service_role';
    perform set_config('academy.op', 'forged', true);
    update academy_memberships set role = 'training_manager' where id = v_mem;
    ok := false;
  exception when others then ok := true; msg := sqlerrm; end;
  execute 'reset role';
  perform set_config('academy.op', '', true);
  ok := ok and (select role from academy_memberships where id = v_mem) = 'learner';
  insert into t_h values (19, 'D: setting the operation marker by hand does not let the server role make a guarded change',
    case when ok then 'PASS' else 'FAIL' end, coalesce(msg, '')); msg := null;
  begin perform academy_op_set_training_manager('staff:nobody@test.example', v_mem, true, 'x'); ok := false; exception when others then ok := true; end;
  begin perform academy_op_set_training_manager(REP, v_mem, true, 'x'); ok := ok and false; exception when others then ok := ok and true; end;
  begin perform academy_op_set_training_manager('test', v_mem, true, 'x'); ok := ok and false; exception when others then ok := ok and true; end;
  insert into t_h values (20, 'D: staff operations refuse anyone who is not an active HCPS administrator (unknown, rep, free text)',
    case when ok then 'PASS' else 'FAIL' end, '');
  ok := (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
           and p.proname in ('academy_op_set_training_manager','academy_op_review_external_cert','academy_op_issue_certificate',
                             'academy_op_revoke_certificate','academy_op_publish_version','academy_op_retire_version',
                             'academy_op_start_attempt','academy_op_submit_attempt','academy_op_correct_attempt',
                             'academy_op_record_fact','academy_op_withdraw_fact')
           and p.prosecdef and has_function_privilege('service_role', p.oid, 'EXECUTE')
           and pg_get_userbyid(p.proowner) = (select pg_get_userbyid(proowner) from pg_proc where oid = 'public.academy_audited_guard()'::regprocedure)) = 11
        and not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
                          and (p.proname like 'academy\_op\_%' or p.proname = 'academy_audited_guard')
                          and (not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')
                               or has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE')));
  insert into t_h values (21, 'D: the 11 operations run with their owner''s fixed rights, server role only; every M1 function has a pinned search path; none callable by anon/authenticated',
    case when ok then 'PASS' else 'FAIL' end, '');

  -- ===================== E. Certificate issuance =====================
  a := pg_temp.h_attempt(e3, array[x1]);
  perform academy_op_submit_attempt('learner:' || v_l1, a, jsonb_build_object(x1::text, 'a'));
  perform pg_temp.h_switch(false);
  begin perform pg_temp.h_issue('system:grader', a); ok := false; exception when others then ok := true; end;
  perform pg_temp.h_switch(true);
  insert into t_h values (22, 'E: no certificate while the certificates switch is off', case when ok then 'PASS' else 'FAIL' end, '');
  update academy_enrollments set status = 'withdrawn' where id = e3;
  begin perform pg_temp.h_issue('system:grader', a); ok := false; exception when others then ok := true; end;
  update academy_enrollments set status = 'in_progress' where id = e3;
  insert into t_h values (23, 'E: no certificate for a withdrawn enrollment', case when ok then 'PASS' else 'FAIL' end, '');
  begin perform pg_temp.h_issue('someone', a); ok := false; exception when others then ok := true; end;
  begin perform pg_temp.h_issue(REP, a); ok := ok and false; exception when others then ok := ok and true; end;
  insert into t_h values (24, 'E: only the grading system or an active administrator can issue', case when ok then 'PASS' else 'FAIL' end, '');
  a2 := pg_temp.h_attempt(ed, array[d1]);
  perform pg_temp.h_grade(a2);   -- a "passed" attempt on a draft version (only possible through a bug or a hand-made row)
  begin perform pg_temp.h_issue('system:grader', a2); ok := false; exception when others then ok := true; end;
  insert into t_h values (25, 'E: no certificate from an attempt on an unpublished version', case when ok then 'PASS' else 'FAIL' end, '');
  begin
    perform pg_temp.h_issue('system:grader', a);
    ok := true;
  exception when others then ok := false; msg := sqlerrm; end;
  begin perform pg_temp.h_issue('system:grader', a); ok := ok and false; exception when others then ok := ok and true; end;
  insert into t_h values (26, 'E: a qualifying passed attempt gets one certificate; a second for the same enrollment is refused',
    case when ok then 'PASS' else 'FAIL' end, coalesce(msg, '')); msg := null;
  a := pg_temp.h_attempt(et, array[t1]);
  perform academy_op_submit_attempt('learner:' || v_l1, a, jsonb_build_object(t1::text, 'a'));
  begin perform pg_temp.h_issue('system:grader', a); ok := false; exception when others then ok := sqlerrm like '%TEST%'; end;
  insert into t_h values (27, 'E: a TEST course never issues a certificate, even with the switch on', case when ok then 'PASS' else 'FAIL' end, '');
  begin
    perform academy_op_record_fact(ADMIN, jsonb_build_object('manufacturer_slug','golden-technologies','model_code','PRH','field','zones',
      'value',2,'field_class','approval_required','status','verified','source_url','https://x','source_label','x',
      'verified_on',current_date,'verified_by','t'), null, 'president:test');
    ok := false;
  exception when others then ok := true; end;
  insert into t_h values (28, 'D: an approval-required fact names an active administrator as approver', case when ok then 'PASS' else 'FAIL' end, '');
end $$;
select lpad(n::text, 2, '0') || '|' || result || '|' || test || case when detail <> '' then ' — ' || detail else '' end from t_h order by n;
rollback;
