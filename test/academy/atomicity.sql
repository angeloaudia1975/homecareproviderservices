-- LOCAL TEST ONLY (test/academy-a2a.pg.test.js). Proves every M1 audited operation is all-or-nothing: with the audit
-- table made to refuse every insert, each operation must fail AND leave its change undone. Everything is rolled back.
begin;
create temp table t_atom (op text, result text, detail text);
do $$
declare
  ADMIN constant text := 'staff:admin@test.example';
  v_user uuid; v_user2 uuid; v_dealer uuid; v_learner uuid; v_mem uuid; v_course uuid; v_ver uuid; v_ver2 uuid; v_mod uuid; v_mod2 uuid;
  v_q uuid; v_enr uuid; v_course2 uuid; v_learner2 uuid; v_enr2 uuid; v_att uuid; v_att2 uuid; v_cert uuid; v_ext uuid; v_med uuid;
  v_fact uuid; v_n bigint; ok boolean;
begin
  select id into v_user from auth.users order by created_at, id limit 1;
  select id into v_user2 from auth.users order by created_at, id offset 1 limit 1;
  select id into v_dealer from dealers order by business_name limit 1;
  insert into app_settings (key, value) values ('phase2_flags', '{"academy_certificates": true}')
    on conflict (key) do update set value = app_settings.value || '{"academy_certificates": true}';
  insert into academy_learners (auth_user_id, full_name, email) values (v_user, 'Atomic', 'atomic@example.com') returning id into v_learner;
  insert into academy_learners (auth_user_id, full_name, email) values (v_user2, 'Atomic 2', 'atomic2@example.com') returning id into v_learner2;
  insert into academy_memberships (learner_id, dealer_id, role, access_type, created_by) values (v_learner, v_dealer, 'learner', 'training_only', 't') returning id into v_mem;
  perform set_config('academy.op', 'test-setup', true);  -- A2C M2: content is written only by audited operations; test setup is the owner with the marker
  insert into academy_courses (slug, title, course_type, issuer) values ('atomic-course', 'Atomic', 'hcps_certification', 'hcps') returning id into v_course;
  insert into academy_course_versions (course_id, version, exam_questions) values (v_course, 1, 1) returning id into v_ver;
  insert into academy_courses (slug, title, course_type, issuer) values ('atomic-course-2', 'Atomic 2', 'hcps_certification', 'hcps') returning id into v_course2;
  insert into academy_course_versions (course_id, version, exam_questions) values (v_course2, 1, 1) returning id into v_ver2;
  insert into academy_modules (version_id, position, title) values (v_ver, 1, 'M') returning id into v_mod;
  insert into academy_modules (version_id, position, title) values (v_ver2, 1, 'M') returning id into v_mod2;
  insert into academy_questions (version_id, module_id, kind, prompt, choices, answer_key, explanation, objective_tags)   -- A2D M3: questions too
    values (v_ver, v_mod, 'single', 'Q', '[{"id":"a"},{"id":"b"}]', '"a"', 'B', '{t}') returning id into v_q;
  insert into academy_questions (version_id, module_id, kind, prompt, choices, answer_key, explanation, objective_tags)
    values (v_ver2, v_mod2, 'single', 'Q', '[{"id":"a"},{"id":"b"}]', '"a"', 'B', '{t}');
  perform set_config('academy.op', '', true);
  perform academy_op_publish_version(ADMIN, v_ver);
  insert into academy_enrollments (learner_id, version_id, access_source) values (v_learner, v_ver, 'admin_grant') returning id into v_enr;
  v_att := (academy_op_start_attempt('learner:' || v_learner, v_enr)->>'id')::uuid;
  perform academy_op_submit_attempt('learner:' || v_learner, v_att, jsonb_build_object(v_q::text, 'a'));
  insert into academy_enrollments (learner_id, version_id, access_source) values (v_learner2, v_ver, 'admin_grant') returning id into v_enr2;
  v_att2 := (academy_op_start_attempt('learner:' || v_learner2, v_enr2)->>'id')::uuid;
  perform academy_op_submit_attempt('learner:' || v_learner2, v_att2, jsonb_build_object(v_q::text, 'a'));
  v_cert := (academy_op_issue_certificate('system:grader', v_att, 'HQ')->>'id')::uuid;
  perform set_config('academy.op', 'test-setup', true);  -- A2D M3: media too
  insert into academy_media (kind, storage_path, rights) values ('pdf', 'academy-private/x.pdf', 'hcps_owned') returning id into v_med;
  perform set_config('academy.op', '', true);
  insert into academy_external_certs (learner_id, course_id, manufacturer_slug, status, upload_media_id, certificate_uploaded_at)
    values (v_learner, v_course, 'golden-technologies', 'certificate_uploaded', v_med, now()) returning id into v_ext;
  v_fact := (academy_op_record_fact(ADMIN, jsonb_build_object('manufacturer_slug','golden-technologies','model_code','PR1','field','zones',
    'value',2,'field_class','display','status','verified','source_url','https://x','source_label','x','verified_on',current_date,'verified_by','t'), null, null)->>'id')::uuid;

  -- From here the audit table refuses every insert.
  execute 'create function pg_temp.refuse_audit() returns trigger language plpgsql as $f$ begin raise exception ''audit store unavailable (test)''; end $f$';
  execute 'create trigger zz_refuse_audit before insert on academy_events for each row execute function pg_temp.refuse_audit()';

  begin perform academy_op_set_training_manager(ADMIN, v_mem, true, 'x'); ok := false; exception when others then ok := sqlerrm like '%audit store unavailable%'; end;
  insert into t_atom values ('set_training_manager', case when ok and (select role from academy_memberships where id = v_mem) = 'learner' then 'PASS' else 'FAIL' end, '');
  begin perform academy_op_review_external_cert(ADMIN, v_ext, 'verified', 'golden_certificate', null, null); ok := false; exception when others then ok := sqlerrm like '%audit store unavailable%'; end;
  insert into t_atom values ('review_external_cert', case when ok and (select status from academy_external_certs where id = v_ext) = 'certificate_uploaded' then 'PASS' else 'FAIL' end, '');
  select count(*) into v_n from academy_certificates;
  begin perform academy_op_issue_certificate('system:grader', v_att2, 'HQ'); ok := false; exception when others then ok := sqlerrm like '%audit store unavailable%'; end;
  insert into t_atom values ('issue_certificate', case when ok and (select count(*) from academy_certificates) = v_n then 'PASS' else 'FAIL' end, '');
  begin perform academy_op_revoke_certificate(ADMIN, v_cert, 'x'); ok := false; exception when others then ok := sqlerrm like '%audit store unavailable%'; end;
  insert into t_atom values ('revoke_certificate', case when ok and (select status from academy_certificates where id = v_cert) = 'valid' then 'PASS' else 'FAIL' end, '');
  begin perform academy_op_publish_version(ADMIN, v_ver2); ok := false; exception when others then ok := sqlerrm like '%audit store unavailable%'; end;
  insert into t_atom values ('publish_version', case when ok and (select status from academy_course_versions where id = v_ver2) = 'draft' then 'PASS' else 'FAIL' end, '');
  begin perform academy_op_retire_version(ADMIN, v_ver, 'x'); ok := false; exception when others then ok := sqlerrm like '%audit store unavailable%'; end;
  insert into t_atom values ('retire_version', case when ok and (select status from academy_course_versions where id = v_ver) = 'published' then 'PASS' else 'FAIL' end, '');
  select count(*) into v_n from academy_attempts;
  begin perform academy_op_start_attempt('learner:' || v_learner, v_enr); ok := false; exception when others then ok := sqlerrm like '%audit store unavailable%'; end;
  insert into t_atom values ('start_attempt', case when ok and (select count(*) from academy_attempts) = v_n then 'PASS' else 'FAIL' end, '');
  -- an open attempt for submit_attempt: made with the owner + marker (start_attempt cannot run while audits fail)
  perform set_config('academy.op', 'test-setup', true);
  insert into academy_attempts (enrollment_id, question_ids) values (v_enr, array[v_q]) returning id into v_att;
  perform set_config('academy.op', '', true);
  begin perform academy_op_submit_attempt('learner:' || v_learner, v_att, jsonb_build_object(v_q::text, 'a')); ok := false; exception when others then ok := sqlerrm like '%audit store unavailable%'; end;
  insert into t_atom values ('submit_attempt', case when ok and (select submitted_at from academy_attempts where id = v_att) is null then 'PASS' else 'FAIL' end, '');
  begin perform academy_op_correct_attempt(ADMIN, v_att2, 0, 'x'); ok := false; exception when others then ok := sqlerrm like '%audit store unavailable%'; end;
  insert into t_atom values ('correct_attempt', case when ok and (select score from academy_attempts where id = v_att2) = 100 then 'PASS' else 'FAIL' end, '');
  select count(*) into v_n from product_facts;
  begin perform academy_op_record_fact(ADMIN, jsonb_build_object('manufacturer_slug','golden-technologies','model_code','PR2','field','zones',
    'value',4,'field_class','display','status','verified','source_url','https://x','source_label','x','verified_on',current_date,'verified_by','t'), null, null);
    ok := false; exception when others then ok := sqlerrm like '%audit store unavailable%'; end;
  insert into t_atom values ('record_fact', case when ok and (select count(*) from product_facts) = v_n then 'PASS' else 'FAIL' end, '');
  begin perform academy_op_withdraw_fact(ADMIN, v_fact, 'x'); ok := false; exception when others then ok := sqlerrm like '%audit store unavailable%'; end;
  insert into t_atom values ('withdraw_fact', case when ok and (select valid_to from product_facts where id = v_fact) is null
                                                and (select count(*) from product_facts) = v_n then 'PASS' else 'FAIL' end, '');
end $$;
select op || '|' || result from t_atom order by op;
rollback;
