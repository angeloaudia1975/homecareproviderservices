-- LOCAL TEST ONLY (test/academy-m3.pg.test.js). A2D M3 hardening: what the SQL-editor acceptance tests cannot show
-- (they run as the owner, with production's staff list). Roles anon / authenticated / service_role as the API uses them,
-- a non-President administrator, every M3 function's rights, and answer-key exposure. Rolled back.
begin;
create temp table t_h3 (n int, test text, result text, detail text);
grant all on t_h3 to public;
insert into staff_users (email, name, role, active) values ('second@test.example', 'Second Admin', 'admin', true)
  on conflict (email) do nothing;

do $$
declare
  PRES constant text := 'staff:admin@test.example';
  ADM  constant text := 'staff:second@test.example';
  v_c uuid; v_v uuid; v_m uuid; v_l uuid; v_q uuid; v_p1 uuid; v_p2 uuid; v_med uuid; v_ref uuid; v_learner uuid; v_enr uuid;
  ok boolean; r jsonb; t text; f record; n int; tb text; v_args text;
begin
  -- 1 anon and authenticated (the public keys) can run none of the 24 M3 functions, nor start-attempt
  ok := true; n := 0;
  for f in select p.oid::regprocedure as sig, p.proname, p.proargtypes from pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and (p.proname like 'academy\_author\_%' and p.proname not in ('academy_author_guard', 'academy_author_publish_check')
                   or p.proname = 'academy_op_start_attempt') loop
    v_args := (select string_agg('null::' || format_type(x, null), ',') from unnest(f.proargtypes) x);
    foreach t in array array['anon','authenticated'] loop
      begin
        execute format('set local role %I', t);
        execute format('select %s(%s)', f.proname, v_args);
        ok := false;
      exception when insufficient_privilege then n := n + 1; end;
      execute 'reset role';
    end loop;
  end loop;
  insert into t_h3 values (1, 'anon and authenticated are refused on all 22 callable M3 functions and on start-attempt',
    case when ok and n = 46 then 'PASS' else 'FAIL' end, n || ' refusals');
end $$;

do $$
declare
  PRES constant text := 'staff:admin@test.example';
  ADM  constant text := 'staff:second@test.example';
  v_c uuid; v_v uuid; v_m uuid; v_l uuid; v_q uuid; v_p1 uuid; v_p2 uuid; v_med uuid; v_ref uuid; r jsonb;
begin

  -- 2 the server role runs the 12 operations (as the API does) but none of the helpers or the draw
  execute 'set local role service_role';
  v_c := (academy_content_op_create_course(PRES, null, '{"slug":"h3-course","title":"H3","course_type":"hcps_certification"}')->>'id')::uuid;
  v_v := (academy_content_op_create_version(PRES, null, v_c, '{"exam_questions":2}')->>'id')::uuid;
  v_m := (academy_content_op_create_module(PRES, null, v_v, '{"title":"Only module"}')->>'id')::uuid;
  v_l := (academy_content_op_create_lesson(PRES, null, v_m, '{"title":"L"}')->>'id')::uuid;
  v_q := (academy_author_op_create_question(PRES, null, v_v, jsonb_build_object('module_id', v_m, 'kind','single', 'prompt','Exam one?',
          'choices','[{"id":"a","text":"A"},{"id":"b","text":"B"}]'::jsonb, 'answer_key','b', 'explanation','x', 'objective_tags','["t"]'::jsonb))->>'id')::uuid;
  perform academy_author_op_create_question(PRES, null, v_v, jsonb_build_object('module_id', v_m, 'kind','single', 'prompt','Exam two?',
          'choices','[{"id":"a","text":"A"},{"id":"b","text":"B"}]'::jsonb, 'answer_key','a', 'explanation','x', 'objective_tags','["t"]'::jsonb));
  v_p1 := (academy_author_op_create_question(ADM, null, v_v, '{"kind":"single","use":"practice","prompt":"Practice one?","choices":[{"id":"a","text":"A"},{"id":"b","text":"B"}],"answer_key":"a","explanation":"x","objective_tags":["t"]}')->>'id')::uuid;
  v_p2 := (academy_author_op_create_question(ADM, null, v_v, '{"kind":"single","use":"practice","prompt":"Practice two?","choices":[{"id":"a","text":"A"},{"id":"b","text":"B"}],"answer_key":"b","explanation":"x","objective_tags":["t"]}')->>'id')::uuid;
  v_med := (academy_author_op_create_media(PRES, null, '{"kind":"image","storage_path":"media/h3/chair.jpg","rights":"hcps_owned","alt_text":"A lift chair shown upright, front view"}')->>'id')::uuid;
  v_ref := (academy_author_op_link_fact(ADM, null, jsonb_build_object('lesson_id', v_l, 'manufacturer_slug', 'golden-technologies', 'model_code', 'H3', 'field', 'zones'))->>'id')::uuid;
  r := academy_author_op_set_blocks(ADM, v_l, jsonb_build_array(jsonb_build_object('kind','image','media_id',v_med),
         '{"kind":"fact","manufacturer_slug":"golden-technologies","model_code":"H3","field":"zones"}'::jsonb,
         jsonb_build_object('kind','check','question_ids',jsonb_build_array(v_p1, v_p2))));
  perform academy_author_op_reorder_lessons(ADM, v_m, array[v_l]);
  perform academy_author_op_reorder_modules(ADM, v_v, array[v_m]);
  perform academy_author_op_set_exam_distribution(ADM, v_v, jsonb_build_object(v_m::text, 2));
  perform academy_author_op_update_question(ADM, v_q, '{"explanation":"Because B."}');
  perform academy_author_op_set_question_status(ADM, v_q, 'retired', 'checking the server role');
  perform academy_author_op_set_question_status(ADM, v_q, 'active', null);
  execute 'reset role';
end $$;

-- (2 continued, in a fresh block: the server role and the helpers)
do $$
declare ok boolean := true; n int := 0; f record; v_args text;
begin
  execute 'set local role service_role';
  for f in select p.oid::regprocedure as sig, p.proname, p.proargtypes from pg_proc p
            where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_author\_%'
              and p.proname not like 'academy\_author\_op\_%' and p.proname not in ('academy_author_guard', 'academy_author_publish_check') loop
    v_args := (select string_agg('null::' || format_type(x, null), ',') from unnest(f.proargtypes) x);
    begin execute format('select %s(%s)', f.proname, v_args); ok := false;
    exception when insufficient_privilege then n := n + 1; end;
  end loop;
  execute 'reset role';
  insert into t_h3 values (2, 'The server role runs the operations (as the API does) but none of the 10 helpers, the exam draw included',
    case when ok and n = 10 and exists (select 1 from academy_questions where prompt = 'Exam one?' and explanation = 'Because B.')
              and exists (select 1 from academy_lessons where title = 'L' and jsonb_array_length(blocks) = 3)
         then 'PASS' else 'FAIL' end, n || ' helper refusals');
end $$;

do $$
declare
  PRES constant text := 'staff:admin@test.example'; ADM constant text := 'staff:second@test.example';
  ok boolean; n int; t text; tb text; r jsonb; v_v uuid; v_m uuid; v_l uuid; v_q uuid; v_med uuid; v_ref uuid; v_learner uuid; v_enr uuid; v_p1 uuid;
begin
  select id into v_v from academy_course_versions where course_id = (select id from academy_courses where slug = 'h3-course');
  select id into v_m from academy_modules where version_id = v_v;
  select id into v_l from academy_lessons where module_id = v_m;
  select id into v_q from academy_questions where prompt = 'Exam one?';
  select id into v_p1 from academy_questions where prompt = 'Practice one?';
  select id into v_med from academy_media where storage_path = 'media/h3/chair.jpg';
  select id into v_ref from academy_content_refs where lesson_id = v_l;

  -- 3 direct writes with a forged marker are refused for every API role, on every M3 table, for insert, update and delete
  ok := true; n := 0;
  foreach t in array array['anon','authenticated','service_role'] loop
    foreach tb in array array['academy_questions','academy_media','academy_content_refs'] loop
      begin
        execute format('set local role %I', t);
        perform set_config('academy.op', 'create_question', true);
        if tb = 'academy_questions' then
          execute format('insert into academy_questions (version_id, kind, prompt, choices, answer_key, explanation) values (%L, ''single'', ''f'', ''[{"id":"a"},{"id":"b"}]'', ''"a"'', ''x'')', v_v);
        elsif tb = 'academy_media' then
          insert into academy_media (kind, storage_path, rights) values ('pdf', 'media/h3/forged.pdf', 'hcps_owned');
        else
          execute format('insert into academy_content_refs (version_id, lesson_id, manufacturer_slug, model_code) values (%L, %L, ''golden-technologies'', ''F'')', v_v, v_l);
        end if;
        ok := false;
      exception when insufficient_privilege then n := n + 1; end;
      execute 'reset role';
      begin
        execute format('set local role %I', t);
        perform set_config('academy.op', 'update_question', true);
        execute format('update %I set id = id where true', tb);
        if found then ok := false; end if;
      exception when insufficient_privilege then n := n + 1; end;
      execute 'reset role';
      begin
        execute format('set local role %I', t);
        perform set_config('academy.op', 'delete_media', true);
        execute format('delete from %I where true', tb);
        if found then ok := false; end if;
      exception when insufficient_privilege then n := n + 1; end;
      execute 'reset role';
    end loop;
  end loop;
  perform set_config('academy.op', '', true);
  insert into t_h3 values (3, 'A forged operation marker opens nothing: insert, update and delete on questions, media and fact links refused for anon, authenticated and service_role',
    case when ok and (select answer_key from academy_questions where id = v_q) = '"b"'::jsonb and exists (select 1 from academy_media where id = v_med)
              and exists (select 1 from academy_content_refs where id = v_ref) then 'PASS' else 'FAIL' end, n || ' refusals');

  -- 4 a non-President administrator authors drafts, but cannot record or change a stored manufacturer file
  ok := exists (select 1 from academy_events where actor = ADM and action in ('set_blocks','create_media','link_fact','set_exam_distribution','reorder_modules'));
  begin perform academy_author_op_create_media(ADM, null, '{"kind":"image","storage_path":"media/h3/golden.jpg","rights":"manufacturer_permitted","manufacturer_slug":"golden-technologies","permission_ref":"x","alt_text":"A lift chair shown from the front"}'); ok := false;
  exception when insufficient_privilege then null; end;
  r := academy_author_op_create_media(PRES, null, '{"kind":"image","storage_path":"media/h3/golden.jpg","rights":"manufacturer_permitted","manufacturer_slug":"golden-technologies","permission_ref":"Golden email 2026-10-01","alt_text":"A lift chair shown from the front"}');
  begin perform academy_author_op_update_media(ADM, (r->>'id')::uuid, '{"alt_text":"A lift chair shown from the front, upright"}'); ok := false;
  exception when insufficient_privilege then null; end;
  begin perform academy_author_op_update_media(ADM, v_med, '{"rights":"manufacturer_permitted","manufacturer_slug":"golden-technologies","permission_ref":"x"}'); ok := false;
  exception when insufficient_privilege then null; end;
  perform academy_author_op_update_media(PRES, (r->>'id')::uuid, '{"alt_text":"A lift chair shown from the front, upright"}');
  begin perform academy_author_op_update_media(ADM, (r->>'id')::uuid, '{"rights":"hcps_owned","manufacturer_slug":null,"permission_ref":null}'); ok := false;   -- downgrade
  exception when insufficient_privilege then null; end;
  begin perform academy_author_op_create_media(ADM, null, '{"kind":"image","storage_path":"media/h3/any.jpg","rights":"hcps_owned","alt_text":"A lift chair in a showroom corner"}'); ok := false;
  exception when insufficient_privilege then null; end;
  r := academy_author_op_create_media(ADM, null, '{"kind":"pdf","storage_path":"media/h3/hcps-guide.pdf","rights":"hcps_owned","alt_text":"HCPS guide"}');
  r := academy_author_op_create_media(PRES, null, '{"kind":"pdf","storage_path":"media/h3/golden-manual.pdf","rights":"manufacturer_permitted","manufacturer_slug":"golden-technologies","permission_ref":"Golden email 2026-10-01","alt_text":"Owner manual"}');
  begin perform academy_author_op_update_media(ADM, (r->>'id')::uuid, '{"rights":"hcps_owned","manufacturer_slug":null,"permission_ref":null}'); ok := false;   -- a stored manufacturer document, downgraded
  exception when insufficient_privilege then null; end;
  ok := ok and (select rights from academy_media where id = (r->>'id')::uuid) = 'manufacturer_permitted';
  ok := ok and (select rights from academy_media where storage_path = 'media/h3/golden.jpg') = 'manufacturer_permitted';
  insert into t_h3 values (4, 'A non-President administrator builds drafts and stores HCPS documents; only the President records any stored photo, or records, changes, re-labels or downgrades a stored manufacturer file',
    case when ok then 'PASS' else 'FAIL' end, '');

  -- 5 inactive administrators, reps and former staff are refused on every operation that names an actor
  ok := true; n := 0;
  foreach t in array array['staff:rep@test.example', 'staff:former@test.example', 'staff:ADMIN@TEST.EXAMPLE '] loop
    begin perform academy_author_op_set_blocks(t, v_l, '[]'); ok := false; exception when insufficient_privilege then n := n + 1; end;
    begin perform academy_author_op_unlink_fact(t, v_ref); ok := false; exception when insufficient_privilege then n := n + 1; end;
    begin perform academy_author_op_delete_media(t, v_med); ok := false; exception when insufficient_privilege then n := n + 1; end;
    begin perform academy_author_op_set_question_status(t, v_q, 'retired', 'x'); ok := false; exception when insufficient_privilege then n := n + 1; end;
  end loop;
  insert into t_h3 values (5, 'A rep, a former administrator and a malformed actor are refused (42501) before anything is read or changed',
    case when ok and n = 12 then 'PASS' else 'FAIL' end, n || ' / 12');

  -- 6 answer keys never leave the database for a learner: the attempt and the result carry ids, a score and topics only
  perform academy_op_publish_version(PRES, v_v);
  insert into academy_learners (auth_user_id, full_name, email) values ('00000000-0000-0000-0000-00000000aaaa', 'H3 Learner', 'h3@example.com') returning id into v_learner;
  insert into academy_enrollments (learner_id, version_id, access_source) values (v_learner, v_v, 'admin_grant') returning id into v_enr;
  execute 'set local role service_role';
  r := academy_op_start_attempt('learner:' || v_learner, v_enr);
  ok := (select array_agg(k order by k) from jsonb_object_keys(r) k) = array['id','question_ids'] and jsonb_array_length(r->'question_ids') = 2;
  r := academy_op_submit_attempt('learner:' || v_learner, (r->>'id')::uuid, jsonb_build_object(v_q::text, 'b'));
  execute 'reset role';
  ok := ok and (select array_agg(k order by k) from jsonb_object_keys(r) k) = array['passed','score','study_topics']
    and not exists (select 1 from academy_events where after::text like '%answer_key"%' or before::text like '%answer_key"%');
  insert into t_h3 values (6, 'Learner-facing results (start, submit) carry no answer key, and no audit row anywhere holds one',
    case when ok then 'PASS' else 'FAIL' end, r::text);

  -- 7 an exam question can never be shown in a lesson check, even through a crafted block in an edit
  ok := true;
  begin perform academy_author_check_blocks(v_l, v_v, jsonb_build_array(jsonb_build_object('kind','check','question_ids',jsonb_build_array(v_q, v_p1)))); ok := false;
  exception when others then ok := sqlstate = '22023'; end;
  insert into t_h3 values (7, 'The block checker itself refuses an exam question in a knowledge check',
    case when ok then 'PASS' else 'FAIL' end, '');

  -- 8 TRUNCATE is refused like any other direct write, for the owner and the server role
  ok := true;
  begin truncate academy_questions cascade; ok := false; exception when insufficient_privilege then null; end;
  begin
    execute 'set local role service_role';
    perform set_config('academy.op', 'forged', true);
    truncate academy_media cascade; ok := false;
  exception when insufficient_privilege then null; end;
  execute 'reset role';
  insert into t_h3 values (8, 'TRUNCATE of questions or media is refused (owner without an operation; server role with a forged marker)',
    case when ok and exists (select 1 from academy_questions where id = v_q) then 'PASS' else 'FAIL' end, '');
end $$;

-- 9-12: in a fresh draft, with the second administrator
do $$
declare
  PRES constant text := 'staff:admin@test.example'; ADM constant text := 'staff:second@test.example';
  ok boolean := true; v_c uuid; v_v uuid; v_m uuid; v_m2 uuid; v_l uuid; v_q uuid; v_med uuid; v_ref uuid; v_doc uuid; v_learner uuid; v_enr uuid;
  v_fact uuid; v_aw uuid; v_bad text := '';
begin
  -- 9 every M3 operation clears its marker when it finishes (checked after EACH call)
  v_c := (academy_content_op_create_course(PRES, null, '{"slug":"h3-marker","title":"Marker","course_type":"hcps_certification"}')->>'id')::uuid;
  v_v := (academy_content_op_create_version(PRES, null, v_c, '{"exam_questions":2}')->>'id')::uuid;
  v_m := (academy_content_op_create_module(PRES, null, v_v, '{"title":"M1"}')->>'id')::uuid;
  v_m2 := (academy_content_op_create_module(PRES, null, v_v, '{"title":"M2"}')->>'id')::uuid;
  v_l := (academy_content_op_create_lesson(PRES, null, v_m, '{"title":"L"}')->>'id')::uuid;
  perform academy_author_op_set_blocks(ADM, v_l, '[{"kind":"text","body":"x"}]');
  if current_setting('academy.op', true) <> '' then v_bad := v_bad || ' set_blocks'; end if;
  perform academy_author_op_reorder_modules(ADM, v_v, array[v_m2, v_m]);
  if current_setting('academy.op', true) <> '' then v_bad := v_bad || ' reorder_modules'; end if;
  perform academy_author_op_reorder_lessons(ADM, v_m, array[v_l]);
  if current_setting('academy.op', true) <> '' then v_bad := v_bad || ' reorder_lessons'; end if;
  perform academy_author_op_set_exam_distribution(ADM, v_v, jsonb_build_object(v_m::text, 1, v_m2::text, 1));
  if current_setting('academy.op', true) <> '' then v_bad := v_bad || ' set_exam_distribution'; end if;
  v_q := (academy_author_op_create_question(ADM, null, v_v, jsonb_build_object('module_id', v_m, 'kind','single', 'prompt','Marker one?',
          'choices','[{"id":"a","text":"A"},{"id":"b","text":"B"}]'::jsonb, 'answer_key','a', 'explanation','x', 'objective_tags','["t"]'::jsonb))->>'id')::uuid;
  if current_setting('academy.op', true) <> '' then v_bad := v_bad || ' create_question'; end if;
  perform academy_author_op_update_question(ADM, v_q, '{"explanation":"y"}');
  if current_setting('academy.op', true) <> '' then v_bad := v_bad || ' update_question'; end if;
  perform academy_author_op_set_question_status(ADM, v_q, 'retired', 'x');
  if current_setting('academy.op', true) <> '' then v_bad := v_bad || ' set_question_status'; end if;
  perform academy_author_op_set_question_status(ADM, v_q, 'active', null);
  v_med := (academy_author_op_create_media(ADM, null, '{"kind":"link","external_url":"https://example.com/m","rights":"link_only"}')->>'id')::uuid;
  if current_setting('academy.op', true) <> '' then v_bad := v_bad || ' create_media'; end if;
  perform academy_author_op_update_media(ADM, v_med, '{"alt_text":"Link"}');
  if current_setting('academy.op', true) <> '' then v_bad := v_bad || ' update_media'; end if;
  perform academy_author_op_delete_media(ADM, v_med);
  if current_setting('academy.op', true) <> '' then v_bad := v_bad || ' delete_media'; end if;
  v_ref := (academy_author_op_link_fact(ADM, null, jsonb_build_object('lesson_id', v_l, 'manufacturer_slug', 'golden-technologies', 'model_code', 'MK1'))->>'id')::uuid;
  if current_setting('academy.op', true) <> '' then v_bad := v_bad || ' link_fact'; end if;
  perform academy_author_op_unlink_fact(ADM, v_ref);
  if current_setting('academy.op', true) <> '' then v_bad := v_bad || ' unlink_fact'; end if;
  insert into t_h3 values (9, 'No M3 operation leaves its operation marker behind (checked after each of the 12)',
    case when v_bad = '' then 'PASS' else 'FAIL' end, v_bad);

  -- 10 start-attempt keeps M1's messages: an unpublished version or a withdrawn enrollment is reported as before, even
  --    with a short bank; a short bank on a published version names the module
  insert into academy_learners (auth_user_id, full_name, email) values ('00000000-0000-0000-0000-00000000bbbb', 'H3 Two', 'h3b@example.com') returning id into v_learner;
  insert into academy_enrollments (learner_id, version_id, access_source) values (v_learner, v_v, 'admin_grant') returning id into v_enr;
  begin perform academy_op_start_attempt('learner:' || v_learner, v_enr); ok := false;      -- draft version; M2 has no question yet
  exception when others then ok := sqlstate = '22023' and sqlerrm like '%only on a published course version%'; end;
  perform academy_author_op_create_question(ADM, null, v_v, jsonb_build_object('module_id', v_m2, 'kind','single', 'prompt','Marker two?',
          'choices','[{"id":"a","text":"A"},{"id":"b","text":"B"}]'::jsonb, 'answer_key','a', 'explanation','x', 'objective_tags','["t"]'::jsonb));
  v_fact := (academy_op_record_fact(PRES, jsonb_build_object('manufacturer_slug','golden-technologies','model_code','MK1','field','zones','value',2,
            'field_class','display','status','verified','source_url','https://example.com','source_label','x','verified_on',current_date,'verified_by','x'), null, null)->>'id')::uuid;
  perform academy_author_op_link_fact(ADM, null, jsonb_build_object('question_id', v_q, 'manufacturer_slug', 'golden-technologies', 'model_code', 'MK1', 'field', 'zones'));
  perform academy_op_publish_version(PRES, v_v);
  perform academy_op_withdraw_fact(PRES, v_fact, 'H3 test');                                   -- the module M1 question is now unusable
  begin perform academy_op_start_attempt('learner:' || v_learner, v_enr); ok := false;
  exception when others then ok := ok and sqlstate = '22023' and sqlerrm like '%module "M1" has 0 usable%'; end;
  update academy_enrollments set status = 'withdrawn' where id = v_enr;
  begin perform academy_op_start_attempt('learner:' || v_learner, v_enr); ok := false;
  exception when others then ok := ok and sqlstate = '22023' and sqlerrm like '%withdrawn%'; end;
  insert into t_h3 values (10, 'Start-attempt keeps M1''s messages for an unpublished version and a withdrawn enrollment (even with a short bank); a short published bank names the module',
    case when ok and not exists (select 1 from academy_attempts where enrollment_id = v_enr) then 'PASS' else 'FAIL' end, '');

  -- 11 a question pinned to a fact that is current but NOT verified is never drawn (possible if a fact is replaced while a
  --    publish is pinning); set up directly as the owner with a marker, as no operation produces it
  v_aw := (select id from product_facts where model_code = 'MK1' and field = 'zones' and valid_to is null);   -- the awaiting_manufacturer row
  perform set_config('academy.op', 'test-setup', true);
  update academy_content_refs set pinned_fact_id = v_aw where question_id = v_q;
  perform set_config('academy.op', '', true);
  ok := (select status from product_facts where id = v_aw) = 'awaiting_manufacturer'
    and not (v_q = any (academy_author_exam_draw(v_v, false))) and cardinality(academy_author_exam_draw(v_v, false)) = 0;
  insert into t_h3 values (11, 'A question pinned to a current but unverified fact is never drawn',
    case when ok then 'PASS' else 'FAIL' end, '');

  -- 12 a learner's credential evidence can never be shown in a lesson
  v_c := (academy_content_op_create_course(PRES, null, '{"slug":"h3-cred","title":"Cred","course_type":"training"}')->>'id')::uuid;
  v_v := (academy_content_op_create_version(PRES, null, v_c, null)->>'id')::uuid;
  v_m := (academy_content_op_create_module(PRES, null, v_v, '{"title":"M"}')->>'id')::uuid;
  v_l := (academy_content_op_create_lesson(PRES, null, v_m, '{"title":"L"}')->>'id')::uuid;
  perform set_config('academy.op', 'test-setup', true);                                     -- stands in for the future (A2E) upload operation
  insert into academy_media (kind, storage_path, rights) values ('pdf', 'certs/learner.pdf', 'hcps_owned') returning id into v_doc;
  insert into academy_external_certs (learner_id, course_id, manufacturer_slug, status, upload_media_id, certificate_uploaded_at)
    values (v_learner, v_c, 'golden-technologies', 'certificate_uploaded', v_doc, now());
  perform set_config('academy.op', '', true);
  ok := true;
  begin perform academy_author_op_set_blocks(PRES, v_l, jsonb_build_array(jsonb_build_object('kind','document','media_id',v_doc,'title','x'))); ok := false;
  exception when others then ok := sqlstate = '22023' and sqlerrm like '%credential%'; end;
  insert into t_h3 values (12, 'A media record that is a learner''s credential evidence cannot be placed in a lesson',
    case when ok and (select blocks from academy_lessons where id = v_l) = '[]'::jsonb then 'PASS' else 'FAIL' end, '');
end $$;

select lpad(n::text, 2, '0') || '|' || result || '|' || test || '|' || coalesce(detail, '') from t_h3 order by n;
rollback;
