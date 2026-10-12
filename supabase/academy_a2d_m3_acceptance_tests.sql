-- =============================================================================================
-- HCPS Academy — A2D M3 acceptance tests                  supabase/academy_a2d_m3_acceptance_tests.sql
-- Run right after M3, in the Supabase SQL editor (as the database owner, as the editor does). Tests 1-3 only read.
-- Tests 4-24 create test rows inside a sub-transaction that is always undone (a deliberate exception rolls it back after
-- the results are saved). Test 22 adds a temporary refusing trigger to the audit table inside that undone block; it is
-- never visible to any other session. The results table is the LAST statement, so the editor shows it.
-- Check 25 confirms nothing was left behind: every content table and the audit history hold exactly as many rows as
-- before.
-- Uses existing rows only as references: Golden in the manufacturer list, one active HCPS President, one sign-in account
-- (auth.users) that is not yet an Academy learner (for the exam tests; the test learner is given a test email), and,
-- when there is one, an active administrator who is not the President (test 13). No other HCPS table is written.
-- =============================================================================================
drop table if exists t_m3;
create temp table t_m3 (n int, test text, result text, detail text);
drop table if exists t_m3_before;
create temp table t_m3_before as
  select (select count(*) from academy_courses) c, (select count(*) from academy_course_versions) v,
         (select count(*) from academy_modules) m, (select count(*) from academy_lessons) l, (select count(*) from academy_questions) q,
         (select count(*) from academy_media) md, (select count(*) from academy_content_refs) r, (select count(*) from product_facts) f,
         (select count(*) from academy_learners) lr, (select count(*) from academy_enrollments) en, (select count(*) from academy_attempts) a,
         (select count(*) from academy_events) e;

-- ---------- Structure and privileges (read-only) ----------
insert into t_m3
select 1, 'M3 installed: 12 operations, 12 helpers/guards; the row and TRUNCATE guards on questions, media and fact links; the publish check on course versions; the exam_quota column',
  case when (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like 'academy\_author\_op\_%') = 12
        and (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like 'academy\_author\_%') = 24
        and (select string_agg(c.relname, ',' order by c.relname) from pg_trigger t join pg_class c on c.oid = t.tgrelid
              where t.tgname = 'academy_author_guard' and not t.tgisinternal) = 'academy_content_refs,academy_media,academy_questions'
        and (select string_agg(c.relname, ',' order by c.relname) from pg_trigger t join pg_class c on c.oid = t.tgrelid
              where t.tgname = 'academy_author_guard_truncate' and not t.tgisinternal) = 'academy_content_refs,academy_media,academy_questions'
        and (select string_agg(c.relname, ',') from pg_trigger t join pg_class c on c.oid = t.tgrelid
              where t.tgname = 'academy_author_publish_check' and not t.tgisinternal) = 'academy_course_versions'
        and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'academy_modules' and column_name = 'exam_quota')
       then 'PASS' else 'FAIL' end, ''
union all
select 2, 'Only the server role can run the 12 operations (fixed rights, pinned search path, same owner as the guard); nobody but the owner can run the helpers and guards; nothing for public/anon/authenticated',
  case when (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like 'academy\_author\_op\_%' and prosecdef
              and has_function_privilege('service_role', oid, 'EXECUTE')) = 12
        and not exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname like 'academy\_author\_%'
                         and proname not like 'academy\_author\_op\_%' and (prosecdef or has_function_privilege('service_role', oid, 'EXECUTE')))
        and not exists (select 1 from pg_proc p, unnest(array['anon','authenticated']) r
                         where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_author\_%'
                           and has_function_privilege(r, p.oid, 'EXECUTE'))
        and not exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                         where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_author\_%'
                           and a.grantee = 0 and a.privilege_type = 'EXECUTE')
        and not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_author\_%'
                         and not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'))
        and (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like 'academy\_author\_op\_%'
              and pg_get_userbyid(proowner) = (select pg_get_userbyid(proowner) from pg_proc where oid = 'public.academy_author_guard()'::regprocedure)) = 12
       then 'PASS' else 'FAIL' end, ''
union all
select 3, 'M1 and M2 intact: the 18 other M1 functions exactly as approved; start-attempt draws through M3 and is still server-only; 6 M1 guard triggers; M2 15 functions, 8 guard triggers, fingerprint as approved',
  case when (select count(*) from pg_proc where pronamespace = 'public'::regnamespace
              and (proname like 'academy\_op\_%' or proname = 'academy_audited_guard')) = 19
        and (select md5(string_agg(p.proname || ':' || pg_get_function_identity_arguments(p.oid) || ':' || p.prosecdef || ':' ||
                        coalesce(array_to_string(p.proconfig, ','), '') || ':' || p.prosrc, '|' order by p.proname))
               from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname <> 'academy_op_start_attempt'
                and (p.proname like 'academy\_op\_%' or p.proname = 'academy_audited_guard'))
            in ('e05951fca31652f7289b1be904cc079a', '30a6a689fca7ed63c0c24ce774d514be')
        and (select prosrc like '%academy_author_exam_draw(%' and prosecdef from pg_proc where oid = 'public.academy_op_start_attempt(text,uuid)'::regprocedure)
        and has_function_privilege('service_role', 'public.academy_op_start_attempt(text,uuid)', 'EXECUTE')
        and not has_function_privilege('anon', 'public.academy_op_start_attempt(text,uuid)', 'EXECUTE')
        and not has_function_privilege('authenticated', 'public.academy_op_start_attempt(text,uuid)', 'EXECUTE')
        and (select count(*) from pg_trigger where tgname = 'academy_audited_guard' and not tgisinternal) = 6
        and (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like 'academy\_content\_%') = 15
        and (select count(*) from pg_trigger where tgname in ('academy_content_guard','academy_content_guard_truncate') and not tgisinternal) = 8
        and (select md5(string_agg(p.proname || ':' || pg_get_function_identity_arguments(p.oid) || ':' || p.prosecdef || ':' ||
                        coalesce(array_to_string(p.proconfig, ','), '') || ':' || p.prosrc, '|' order by p.proname))
               from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_content\_%')
            in ('f24e4f888c8ed7a4e0765382737dfe35', '794f3c3e007bf3cc6d72b574aac614e3')
       then 'PASS' else 'FAIL' end, '';

-- ---------- Behaviour (undone at the end) ----------
do $$
declare
  PRES text; OTHER text; NOBODY constant text := 'staff:m3-not-staff@example.com'; MFR constant text := 'golden-technologies';
  v_saved text; ok boolean; v_e0 bigint; v_n int; r jsonb; s text; i int; k int; t text;
  v_c uuid; v_v uuid; v_m1 uuid; v_m2 uuid; v_m3 uuid; v_l1 uuid; v_l2 uuid; v_img uuid; v_dec uuid; v_vid uuid; v_pdf uuid; v_spare uuid;
  v_p1 uuid; v_p2 uuid; v_qx uuid; v_blocks jsonb; v_ref uuid; v_qref uuid; v_user uuid; v_learner uuid; v_enr uuid; v_att uuid;
  v_ids uuid[]; v_cnt jsonb; v_fact uuid; v_grouped int := 0; v_c2 uuid; v_v2 uuid; v_a uuid; v_b uuid; v_q uuid; v_tag text;
begin
  begin  -- sub-transaction: every write in here is undone at the end
    select 'staff:' || lower(email) into PRES from staff_users
     where coalesce(active, true) and lower(coalesce(role, '')) = 'president' order by email limit 1;
    select 'staff:' || lower(email) into OTHER from staff_users
     where coalesce(active, true) and lower(coalesce(role, '')) in ('admin','owner') order by email limit 1;
    select u.id into v_user from auth.users u where not exists (select 1 from academy_learners l where l.auth_user_id = u.id)
     order by u.created_at, u.id limit 1;
    if PRES is null or v_user is null or not exists (select 1 from manufacturers where slug = MFR) then
      insert into t_m3 values (4, 'Behaviour tests', 'SKIP', 'needs one active HCPS President, one sign-in account and Golden in the manufacturer list'); return;
    end if;

    -- 4 nobody writes questions, media or fact links directly — not even the owner (the SQL editor)
    r := academy_content_op_create_course(PRES, null, jsonb_build_object('slug','m3-test-course','title','M3 test','course_type','hcps_certification','manufacturer_slug',MFR));
    v_c := (r->>'id')::uuid;
    v_v := (academy_content_op_create_version(PRES, null, v_c, '{"exam_questions":6}')->>'id')::uuid;
    v_m1 := (academy_content_op_create_module(PRES, null, v_v, '{"title":"Module A"}')->>'id')::uuid;
    v_m2 := (academy_content_op_create_module(PRES, null, v_v, '{"title":"Module B"}')->>'id')::uuid;
    v_m3 := (academy_content_op_create_module(PRES, null, v_v, '{"title":"Module C"}')->>'id')::uuid;
    v_l1 := (academy_content_op_create_lesson(PRES, null, v_m1, '{"title":"Lesson one","est_minutes":12}')->>'id')::uuid;
    v_l2 := (academy_content_op_create_lesson(PRES, null, v_m1, '{"title":"Lesson two","est_minutes":12}')->>'id')::uuid;
    ok := true; v_n := 0;
    begin insert into academy_questions (version_id, kind, prompt, choices, answer_key, explanation) values (v_v, 'single', 'x', '[{"id":"a"},{"id":"b"}]', '"a"', 'x'); ok := false;
    exception when insufficient_privilege then v_n := v_n + 1; end;
    begin insert into academy_media (kind, storage_path, rights) values ('pdf', 'media/x/x.pdf', 'hcps_owned'); ok := false;
    exception when insufficient_privilege then v_n := v_n + 1; end;
    begin insert into academy_content_refs (version_id, lesson_id, manufacturer_slug, model_code) values (v_v, v_l1, MFR, 'X'); ok := false;
    exception when insufficient_privilege then v_n := v_n + 1; end;
    begin truncate academy_content_refs; ok := false; exception when insufficient_privilege then v_n := v_n + 1; end;
    begin
      perform set_config('academy.op', 'forged', true);
      execute 'set local role service_role';
      insert into academy_media (kind, storage_path, rights) values ('pdf', 'media/x/y.pdf', 'hcps_owned'); ok := false;
    exception when insufficient_privilege then v_n := v_n + 1; end;
    execute 'reset role'; perform set_config('academy.op', '', true);
    insert into t_m3 values (4, 'A direct write to questions, media or fact links (or a TRUNCATE) is refused, even for the owner and for the server role with a forged marker',
      case when ok and v_n = 5 then 'PASS' else 'FAIL' end, v_n || ' / 5 refused');

    -- 5 create questions: one row and one audit row each; the audit row never carries the answer key
    select count(*) into v_e0 from academy_events;
    r := academy_author_op_create_question(PRES, null, v_v, jsonb_build_object('module_id', v_m1, 'kind','multi', 'use','exam',
           'prompt','Which two features matter most for a tall customer?', 'choices', '[{"id":"a","text":"Seat depth"},{"id":"b","text":"Fabric colour"},{"id":"c","text":"Seat height"}]'::jsonb,
           'answer_key', '["c","a"]'::jsonb, 'explanation', 'Fit depends on depth and height.', 'objective_tags', '["m3-fit"]'::jsonb));
    v_qx := (r->>'id')::uuid;
    ok := r->'answer_key' = '["a","c"]'::jsonb and r->>'status' = 'active'
      and (select count(*) from academy_events) = v_e0 + 1
      and exists (select 1 from academy_events where entity = 'academy_questions' and entity_id = v_qx::text and action = 'create_question'
                    and actor = PRES and not (after ? 'answer_key') and after->>'answer_key_changed' = 'true');
    insert into t_m3 values (5, 'Create question: saved active with the answer normalized, exactly one audit row naming the person, and the audit row holds no answer key',
      case when ok then 'PASS' else 'FAIL' end, '');

    -- 6 invalid questions are refused, with no row and no audit row
    v_c2 := (academy_content_op_create_course(PRES, null, '{"slug":"m3-test-other","title":"M3 other","course_type":"training"}')->>'id')::uuid;
    v_v2 := (academy_content_op_create_version(PRES, null, v_c2, '{"exam_questions":1}')->>'id')::uuid;
    v_a := (academy_content_op_create_module(PRES, null, v_v2, '{"title":"Other module"}')->>'id')::uuid;
    v_b := (academy_author_op_create_question(PRES, null, v_v2, '{"kind":"single","use":"practice","prompt":"Other practice?","choices":[{"id":"a","text":"A"},{"id":"b","text":"B"}],"answer_key":"a","explanation":"x","objective_tags":["t"]}')->>'id')::uuid;
    select count(*) into v_e0 from academy_events; ok := true; v_n := 0;
    foreach s in array array[
      '{"kind":"essay","prompt":"x","choices":[{"id":"a","text":"A"},{"id":"b","text":"B"}],"answer_key":"a","explanation":"x","objective_tags":["t"]}',
      '{"kind":"single","prompt":"x","choices":[{"id":"a","text":"A"}],"answer_key":"a","explanation":"x","objective_tags":["t"]}',
      '{"kind":"single","prompt":"x","choices":[{"id":"a","text":"A"},{"id":"b","text":"B"}],"answer_key":"z","explanation":"x","objective_tags":["t"]}',
      '{"kind":"single","prompt":"<b>x</b>","choices":[{"id":"a","text":"A"},{"id":"b","text":"B"}],"answer_key":"a","explanation":"x","objective_tags":["t"]}',
      '{"kind":"single","prompt":"x","choices":[{"id":"a","text":"A"},{"id":"b","text":"B"}],"answer_key":"a","explanation":"x","objective_tags":[]}',
      '{"kind":"single","prompt":"x","choices":[{"id":"a","text":"A"},{"id":"a","text":"B"}],"answer_key":"a","explanation":"x","objective_tags":["t"]}',
      '{"kind":"single","prompt":"x","choices":[{"id":"a","text":"A"},{"id":"b","text":"B"}],"answer_key":"a","explanation":"","objective_tags":["t"]}',
      '{"kind":"single","prompt":"x","choices":[{"id":"a","text":"A","correct":true},{"id":"b","text":"B"}],"answer_key":"a","explanation":"x","objective_tags":["t"]}',
      '{"kind":"multi","prompt":"x","choices":[{"id":"a","text":"A"},{"id":"b","text":"B"}],"answer_key":["a","a"],"explanation":"x","objective_tags":["t"]}',
      '{"kind":"single","prompt":"x","choices":[{"id":"a","text":"A"},{"id":"b","text":"B"}],"answer_key":"a","explanation":"x","objective_tags":["t"],"status":"retired"}',
      '{"kind":"single","module_id":"00000000-0000-0000-0000-000000000001","prompt":"x","choices":[{"id":"a","text":"A"},{"id":"b","text":"B"}],"answer_key":"a","explanation":"x","objective_tags":["t"]}',
      '{"kind":"single","use":"practice","prompt":"Which two  features matter most for a tall customer?","choices":[{"id":"a","text":"A"},{"id":"b","text":"B"}],"answer_key":"a","explanation":"x","objective_tags":["t"]}'] loop
      begin perform academy_author_op_create_question(PRES, null, v_v, s::jsonb); ok := false;
      exception when others then if sqlstate = '22023' then v_n := v_n + 1; else ok := false; end if; end;
    end loop;
    begin perform academy_author_op_create_question(PRES, null, v_v, jsonb_build_object('module_id', v_a, 'kind','single', 'prompt','x',   -- another version's real module
      'choices','[{"id":"a","text":"A"},{"id":"b","text":"B"}]'::jsonb, 'answer_key','a', 'explanation','x', 'objective_tags','["t"]'::jsonb)); ok := false;
    exception when others then if sqlstate = '22023' then v_n := v_n + 1; else ok := false; end if; end;
    insert into t_m3 values (6, 'Invalid questions (unknown kind, one choice, answer not a choice, HTML, no topic, repeated choice id, no explanation, a smuggled key or status, an unknown or another version''s module, an exam question reused as practice) are refused, with no audit row',
      case when ok and v_n = 13 and (select count(*) from academy_events) = v_e0 and (select count(*) from academy_questions where version_id = v_v) = 1
           then 'PASS' else 'FAIL' end, v_n || ' / 13 refused');

    -- 7 edit, retire and restore a question; a retirement needs a reason; no audit row of this course holds a key
    r := academy_author_op_update_question(PRES, v_qx, '{"answer_key":["a"],"explanation":"Depth matters most."}');
    ok := r->'answer_key' = '["a"]'::jsonb and r->>'explanation' = 'Depth matters most.';
    begin perform academy_author_op_set_question_status(PRES, v_qx, 'retired', ''); ok := false; exception when others then ok := ok and sqlstate = '22023'; end;
    r := academy_author_op_set_question_status(PRES, v_qx, 'retired', 'M3 test');
    ok := ok and r->>'status' = 'retired';
    r := academy_author_op_set_question_status(PRES, v_qx, 'active', null);
    ok := ok and r->>'status' = 'active'
      and exists (select 1 from academy_events where entity_id = v_qx::text and action = 'update_question' and after->>'answer_key_changed' = 'true')
      and not exists (select 1 from academy_events where entity = 'academy_questions' and entity_id = v_qx::text
                        and (before ? 'answer_key' or after ? 'answer_key'));
    insert into t_m3 values (7, 'Edit, retire (with a reason only) and restore a question; every audit row records that the key changed, never the key itself',
      case when ok then 'PASS' else 'FAIL' end, '');

    -- 8 media: rights and alt text (decision C)
    ok := true; v_n := 0;
    v_img := (academy_author_op_create_media(PRES, null, '{"kind":"image","storage_path":"media/m3-test/chair-side.jpg","rights":"hcps_owned","alt_text":"A lift chair shown fully reclined, side view"}')->>'id')::uuid;
    v_dec := (academy_author_op_create_media(PRES, null, '{"kind":"image","storage_path":"media/m3-test/divider.png","rights":"hcps_owned","alt_text":""}')->>'id')::uuid;
    v_vid := (academy_author_op_create_media(PRES, null, '{"kind":"video","external_url":"https://www.youtube-nocookie.com/embed/AbCdEf12345","rights":"link_only","alt_text":"Lift chair overview video"}')->>'id')::uuid;
    v_pdf := (academy_author_op_create_media(PRES, null, '{"kind":"pdf","storage_path":"media/m3-test/guide.pdf","rights":"hcps_owned","alt_text":"Measuring guide"}')->>'id')::uuid;
    v_spare := (academy_author_op_create_media(PRES, null, '{"kind":"link","external_url":"https://example.com/brochure","rights":"link_only"}')->>'id')::uuid;
    ok := (select alt_text from academy_media where id = v_dec) = '' and (select count(*) from academy_events where entity = 'academy_media' and action = 'create_media'
            and entity_id in (v_img::text, v_dec::text, v_vid::text, v_pdf::text, v_spare::text)) = 5;
    foreach s in array array[
      '{"kind":"image","storage_path":"media/m3-test/a.jpg","rights":"hcps_owned"}',
      '{"kind":"image","storage_path":"media/m3-test/b.jpg","rights":"hcps_owned","alt_text":"IMG_2041.jpg"}',
      '{"kind":"image","storage_path":"media/m3-test/c.jpg","rights":"hcps_owned","alt_text":"chair"}',
      '{"kind":"image","external_url":"https://example.com/x.jpg","rights":"link_only","alt_text":"A lift chair in a showroom"}',
      '{"kind":"video","external_url":"https://www.youtube.com/watch?v=AbCdEf12345","rights":"link_only","alt_text":"Video"}',
      '{"kind":"pdf","storage_path":"media/m3-test/d.pdf","rights":"link_only"}',
      '{"kind":"pdf","storage_path":"media/m3-test/e.pdf","rights":"hcps_owned","manufacturer_slug":"golden-technologies"}',
      '{"kind":"pdf","storage_path":"../secret.pdf","rights":"hcps_owned"}',
      '{"kind":"image","storage_path":"media/m3-test/f.jpg","rights":"manufacturer_permitted","manufacturer_slug":"golden-technologies","alt_text":"A lift chair shown upright, front view"}',
      '{"kind":"link","external_url":"javascript:alert(1)","rights":"link_only"}'] loop
      begin perform academy_author_op_create_media(PRES, null, s::jsonb); ok := false;
      exception when others then if sqlstate = '22023' then v_n := v_n + 1; else ok := false; end if; end;
    end loop;
    begin perform academy_author_op_create_media(PRES, null, '{"kind":"pdf","storage_path":"media/m3-test/guide.pdf","rights":"hcps_owned"}'); ok := false;
    exception when others then ok := ok and sqlstate = '23505'; end;
    insert into t_m3 values (8, 'Media: an image needs descriptive alt text ("" marks it decorative); file names and one-word alt text, outside image links, non-embed video links, stored link-only files, a manufacturer on HCPS-owned files, unsafe paths, manufacturer files without a permission and non-https links are refused; a file is recorded once',
      case when ok and v_n = 10 then 'PASS' else 'FAIL' end, v_n || ' / 10 refused');

    -- 9 a lesson with all 14 block kinds is saved, normalized, with one audit row
    v_p1 := (academy_author_op_create_question(PRES, null, v_v, '{"kind":"single","use":"practice","prompt":"Practice one?","choices":[{"id":"a","text":"Yes"},{"id":"b","text":"No"}],"answer_key":"a","explanation":"Because.","objective_tags":["m3-practice"]}')->>'id')::uuid;
    v_p2 := (academy_author_op_create_question(PRES, null, v_v, '{"kind":"single","use":"practice","prompt":"Practice two?","choices":[{"id":"a","text":"Yes"},{"id":"b","text":"No"}],"answer_key":"b","explanation":"Because.","objective_tags":["m3-practice"]}')->>'id')::uuid;
    v_ref := (academy_author_op_link_fact(PRES, null, jsonb_build_object('lesson_id', v_l1, 'manufacturer_slug', MFR, 'model_code', 'm3test1', 'field', 'capacity.lbs'))->>'id')::uuid;
    perform academy_author_op_link_fact(PRES, null, jsonb_build_object('lesson_id', v_l1, 'manufacturer_slug', MFR, 'model_code', 'M3TEST2', 'field', 'capacity.lbs'));
    v_blocks := jsonb_build_array(
      '{"kind":"objectives","items":["Explain the lift positions","Choose the right chair size"]}'::jsonb,
      '{"kind":"text","heading":"Why size matters","body":"A chair that fits supports the customer.\nMeasure first."}'::jsonb,
      '{"kind":"callout","tone":"tip","body":"Measure the customer seated."}'::jsonb,
      '{"kind":"quote","text":"Built for comfort.","manufacturer_slug":"golden-technologies","source_label":"Manufacturer brochure","source_date":"2026-01-15"}'::jsonb,
      jsonb_build_object('kind','image','media_id',v_img,'caption','Side view'),
      '{"kind":"image","placeholder":"Approved by Golden; HCPS-hosted file to be added","alt":"A lift chair shown fully reclined, side view"}'::jsonb,
      jsonb_build_object('kind','video','media_id',v_vid),
      jsonb_build_object('kind','document','media_id',v_pdf,'title','Measuring guide'),
      '{"kind":"fact","manufacturer_slug":"golden-technologies","model_code":"m3test1","field":"capacity.lbs","label":"Weight capacity"}'::jsonb,
      '{"kind":"comparison","manufacturer_slug":"golden-technologies","models":["M3TEST1","M3TEST2"],"fields":[{"field":"capacity.lbs","label":"Capacity"}]}'::jsonb,
      jsonb_build_object('kind','explorer','style','hotspots','media_id',v_img,'items',
        '[{"title":"Back","body":"The back reclines.","x":20,"y":30},{"title":"Feet","body":"The footrest rises.","x":70,"y":80}]'::jsonb),
      '{"kind":"steps","items":["Unplug the chair","Hold the reset button"],"source_label":"Manufacturer reset guide"}'::jsonb,
      '{"kind":"scenario","prompt":"A tall customer asks which chair to try.","choices":[{"id":"a","text":"Measure first","feedback":"Right.","best":true},{"id":"b","text":"Pick the biggest","feedback":"Not always."},{"id":"c","text":"Pick by colour","feedback":"Fit comes first."}]}'::jsonb,
      jsonb_build_object('kind','check','question_ids',jsonb_build_array(v_p1, v_p2)),
      '{"kind":"takeaways","items":["Measure first","Size decides comfort","Ask the manufacturer when unsure"]}'::jsonb);
    select count(*) into v_e0 from academy_events;
    r := academy_author_op_set_blocks(PRES, v_l1, v_blocks);
    ok := jsonb_array_length(r->'blocks') = 15
      and (select count(distinct b->>'kind') from jsonb_array_elements(r->'blocks') b) = 14
      and r->'blocks'->8->>'model_code' = 'M3TEST1'
      and not jsonb_path_exists(r->'blocks', '$.** ? (@ == null)')
      and not jsonb_path_exists(r->'blocks', '$.**.answer_key')
      and (select count(*) from academy_events) = v_e0 + 1
      and exists (select 1 from academy_events where entity_id = v_l1::text and action = 'set_blocks' and actor = PRES and after->'blocks' = r->'blocks');
    insert into t_m3 values (9, 'A lesson with all 14 block kinds is saved (model codes upper-cased, no empty fields, no answer key anywhere), with one audit row holding the saved blocks',
      case when ok then 'PASS' else 'FAIL' end, '');

    -- 10 invalid blocks are refused, the lesson unchanged, no audit row
    select count(*) into v_e0 from academy_events; ok := true; v_n := 0;
    foreach s in array array[
      '[{"kind":"slides","items":[]}]',
      '[{"kind":"text","body":"x","style":"red"}]',
      '[{"kind":"text","body":"<script>alert(1)</script>"}]',
      '[{"kind":"text","body":"bell \u0007 character"}]',
      '[{"kind":"text","body":"ok"},{"kind":"objectives","items":["a","b"]}]',
      '[{"kind":"image"}]',
      '[{"kind":"image","placeholder":"To come"}]',
      '[{"kind":"image","placeholder":"To come","alt":"photo.jpg"}]',
      '[{"kind":"fact","manufacturer_slug":"golden-technologies","model_code":"M3TEST9","field":"capacity.lbs"}]',
      '[{"kind":"comparison","manufacturer_slug":"golden-technologies","models":["M3TEST1","M3TEST9"],"fields":[{"field":"capacity.lbs","label":"Capacity"}]}]',
      '[{"kind":"quote","text":"x","manufacturer_slug":"golden-technologies","source_label":"x"}]',
      '[{"kind":"quote","text":"x","manufacturer_slug":"golden-technologies","source_label":"x","source_date":"2026-01-01","source_url":"javascript:alert(1)"}]',
      '[{"kind":"callout","tone":"warning","body":"x"}]',
      '[{"kind":"scenario","prompt":"x","choices":[{"id":"a","text":"x","feedback":"x"},{"id":"b","text":"x","feedback":"x"},{"id":"c","text":"x","feedback":"x"}]}]',
      '[{"kind":"takeaways","items":["only one"]}]',
      '[{"kind":"explorer","style":"hotspots","items":[{"title":"a","body":"a","x":1,"y":1},{"title":"b","body":"b","x":2,"y":2}]}]'] loop
      begin perform academy_author_op_set_blocks(PRES, v_l2, s::jsonb); ok := false;
      exception when others then if sqlstate = '22023' then v_n := v_n + 1; else ok := false; end if; end;
    end loop;
    foreach r in array array[
      jsonb_build_array(jsonb_build_object('kind','check','question_ids',jsonb_build_array(v_p1, v_qx))),                  -- an exam question
      jsonb_build_array(jsonb_build_object('kind','check','question_ids',jsonb_build_array(v_p1))),                        -- only one
      jsonb_build_array(jsonb_build_object('kind','check','question_ids',jsonb_build_array(v_p1, v_b))),                   -- another version's question
      jsonb_build_array(jsonb_build_object('kind','image','media_id',v_img,'placeholder','To come')),                      -- both a file and a placeholder
      (select jsonb_agg(jsonb_build_object('kind','text','body',repeat('y', 3990))) from generate_series(1, 20)),           -- over 64 KB in all
      jsonb_build_array(jsonb_build_object('kind','video','media_id',v_img)),                                              -- wrong kind
      jsonb_build_array(jsonb_build_object('kind','image','media_id',v_img,'alt','Something else entirely')),               -- alt belongs to the media
      jsonb_build_array(jsonb_build_object('kind','image','media_id',gen_random_uuid())),                                  -- no such media
      (select jsonb_agg('{"kind":"text","body":"x"}'::jsonb) from generate_series(1, 41)),                                   -- too many blocks
      jsonb_build_array(jsonb_build_object('kind','text','body',repeat('x', 4001)))] loop                                   -- too long
      begin perform academy_author_op_set_blocks(PRES, v_l2, r); ok := false;
      exception when others then if sqlstate = '22023' then v_n := v_n + 1; else ok := false; end if; end;
    end loop;
    insert into t_m3 values (10, 'Invalid blocks (unknown kind or key, HTML, a control character, objectives not first, image without file or placeholder, placeholder without real alt text, unlinked fact or comparison cell, quote without date or with an unsafe link, bad tone, no best scenario choice, too few takeaways, hotspots without a picture, an exam question, another version''s question or a single question in a check, a file and a placeholder together, wrong media kind, alt text on the block, missing media, too many, too long or over 64 KB) are refused; lesson unchanged; no audit row',
      case when ok and v_n = 26 and (select blocks from academy_lessons where id = v_l2) = '[]'::jsonb and (select count(*) from academy_events) = v_e0
           then 'PASS' else 'FAIL' end, v_n || ' / 26 refused');

    -- 11 fact links: one per lesson or question, no duplicates, not removed while a block shows the fact
    ok := true;
    begin perform academy_author_op_link_fact(PRES, null, jsonb_build_object('lesson_id', v_l1, 'manufacturer_slug', MFR, 'model_code', 'M3TEST1', 'field', 'capacity.lbs')); ok := false;
    exception when others then ok := ok and sqlstate = '23505'; end;
    begin perform academy_author_op_link_fact(PRES, null, jsonb_build_object('lesson_id', v_l1, 'question_id', v_qx, 'manufacturer_slug', MFR, 'model_code', 'M3TEST1')); ok := false;
    exception when others then ok := ok and sqlstate = '22023'; end;
    begin perform academy_author_op_link_fact(PRES, null, jsonb_build_object('lesson_id', v_l1, 'manufacturer_slug', 'no-such-maker', 'model_code', 'M3TEST1')); ok := false;
    exception when others then ok := ok and sqlstate = '22023'; end;
    begin perform academy_author_op_unlink_fact(PRES, v_ref); ok := false; exception when others then ok := ok and sqlstate = '55000'; end;
    v_a := (academy_author_op_link_fact(PRES, null, jsonb_build_object('lesson_id', v_l2, 'manufacturer_slug', MFR, 'model_code', 'M3TEST3'))->>'id')::uuid;
    r := academy_author_op_unlink_fact(PRES, v_a);
    ok := ok and not exists (select 1 from academy_content_refs where id = v_a) and exists (select 1 from academy_content_refs where id = v_ref)
      and exists (select 1 from academy_events where entity_id = v_a::text and action = 'unlink_fact' and actor = PRES);
    insert into t_m3 values (11, 'Fact links: a duplicate, a link to both a lesson and a question, an unknown manufacturer and removing a link a block still shows are refused; an unused link is removed with an audit row',
      case when ok then 'PASS' else 'FAIL' end, '');

    -- 12 reorder modules and lessons: a complete new order only
    r := academy_author_op_reorder_modules(PRES, v_v, array[v_m3, v_m1, v_m2]);
    ok := (select position from academy_modules where id = v_m3) = 1 and (select position from academy_modules where id = v_m2) = 3;
    r := academy_author_op_reorder_modules(PRES, v_v, array[v_m1, v_m2, v_m3]);
    r := academy_author_op_reorder_lessons(PRES, v_m1, array[v_l2, v_l1]);
    ok := ok and (select position from academy_lessons where id = v_l2) = 1 and (select position from academy_lessons where id = v_l1) = 2;
    begin perform academy_author_op_reorder_modules(PRES, v_v, array[v_m1, v_m2]); ok := false; exception when others then ok := ok and sqlstate = '22023'; end;
    begin perform academy_author_op_reorder_modules(PRES, v_v, array[v_m1, v_m1, v_m2, v_m3]); ok := false; exception when others then ok := ok and sqlstate = '22023'; end;
    begin perform academy_author_op_reorder_lessons(PRES, v_m1, array[v_l2, v_l1, v_m1]); ok := false; exception when others then ok := ok and sqlstate = '22023'; end;
    perform academy_author_op_reorder_lessons(PRES, v_m1, array[v_l1, v_l2]);
    ok := ok and (select count(*) from academy_events where action in ('reorder_modules','reorder_lessons') and actor = PRES
                   and entity_id in (v_v::text, v_m1::text)) = 4;
    insert into t_m3 values (12, 'Modules and lessons are reordered only by a complete new order (a missing, repeated or foreign id is refused), each with one audit row',
      case when ok then 'PASS' else 'FAIL' end, '');

    -- 13 who may author: active administrators only; a manufacturer-hosted file is the President's decision
    ok := true; v_n := 0;
    foreach t in array array[NOBODY, 'learner:' || gen_random_uuid()::text, 'system:grader', ''] loop
      begin perform academy_author_op_create_question(t, null, v_v, '{"kind":"single","prompt":"Who?","choices":[{"id":"a","text":"A"},{"id":"b","text":"B"}],"answer_key":"a","explanation":"x","objective_tags":["t"]}'); ok := false;
      exception when others then if sqlstate in ('42501','22023') then v_n := v_n + 1; else ok := false; end if; end;
      begin perform academy_author_op_set_blocks(t, v_l2, '[]'); ok := false;
      exception when others then if sqlstate in ('42501','22023') then v_n := v_n + 1; else ok := false; end if; end;
      begin perform academy_author_op_create_media(t, null, '{"kind":"link","external_url":"https://example.com/z","rights":"link_only"}'); ok := false;
      exception when others then if sqlstate in ('42501','22023') then v_n := v_n + 1; else ok := false; end if; end;
    end loop;
    r := academy_author_op_create_media(PRES, null, '{"kind":"image","storage_path":"media/m3-test/golden-front.jpg","rights":"manufacturer_permitted","manufacturer_slug":"golden-technologies","permission_ref":"M3 test permission","alt_text":"A lift chair shown upright, front view"}');
    ok := ok and r->>'rights' = 'manufacturer_permitted';
    if OTHER is not null then
      begin perform academy_author_op_create_media(OTHER, null, '{"kind":"image","storage_path":"media/m3-test/golden-back.jpg","rights":"manufacturer_permitted","manufacturer_slug":"golden-technologies","permission_ref":"x","alt_text":"A lift chair shown from the back"}'); ok := false;
      exception when others then ok := ok and sqlstate = '42501'; end;
      r := academy_author_op_create_question(OTHER, null, v_v, '{"kind":"single","use":"practice","prompt":"Admin practice?","choices":[{"id":"a","text":"A"},{"id":"b","text":"B"}],"answer_key":"a","explanation":"x","objective_tags":["t"]}');
      ok := ok and r->>'id' is not null;
    end if;
    insert into t_m3 values (13, 'Only an active HCPS administrator authors (someone not on staff, a learner, the grader or nobody are refused); a stored manufacturer file is recorded by the President only',
      case when ok and v_n = 12 then 'PASS' else 'FAIL' end,
      v_n || ' / 12 refused' || case when OTHER is null then '; no second administrator here, so the non-President part was not run' else '' end);

    -- 14 the exam distribution (decision B): every module, adding up to the exam size; can be cleared
    ok := true; v_n := 0;
    foreach r in array array[
      jsonb_build_object(v_m1::text, 3, v_m2::text, 3),                                   -- a module missing
      jsonb_build_object(v_m1::text, 2, v_m2::text, 2, v_m3::text, 1),                    -- adds up to 5, not 6
      jsonb_build_object(v_m1::text, 0, v_m2::text, 3, v_m3::text, 3),                    -- a module with none
      jsonb_build_object(v_m1::text, 2, v_m2::text, 2, gen_random_uuid()::text, 2),       -- a foreign module
      jsonb_build_object(v_m1::text, 2.5, v_m2::text, 2, v_m3::text, 1.5),                -- not whole numbers
      jsonb_build_object(v_m1::text, 99999999999, v_m2::text, 2, v_m3::text, 2),          -- out of range
      jsonb_build_object(v_m1::text, 1, upper(v_m1::text), 1, v_m2::text, 2, v_m3::text, 2),   -- one module named twice
      '[2,2,2]'::jsonb] loop
      begin perform academy_author_op_set_exam_distribution(PRES, v_v, r); ok := false;
      exception when others then if sqlstate = '22023' then v_n := v_n + 1; else ok := false; end if; end;
    end loop;
    r := academy_author_op_set_exam_distribution(PRES, v_v, jsonb_build_object(v_m1::text, 2, v_m2::text, 2, v_m3::text, 2));
    ok := ok and (select count(*) from academy_modules where version_id = v_v and exam_quota = 2) = 3;
    perform academy_author_op_set_exam_distribution(PRES, v_v, '{}');
    ok := ok and not exists (select 1 from academy_modules where version_id = v_v and exam_quota is not null);
    perform academy_author_op_set_exam_distribution(PRES, v_v, jsonb_build_object(upper(v_m1::text), 2, upper(v_m2::text), 2, upper(v_m3::text), 2));
    ok := ok and (select count(*) from academy_modules where version_id = v_v and exam_quota = 2) = 3;   -- ids in capitals mean the same modules
    ok := ok and (select count(*) from academy_events where entity_id = v_v::text and action = 'set_exam_distribution') = 3;
    insert into t_m3 values (14, 'Exam distribution: a missing, empty or foreign module, a module named twice, a wrong total, fractions and out-of-range numbers are refused; a complete distribution (ids in any letter case) is saved and can be cleared, each with an audit row',
      case when ok and v_n = 8 then 'PASS' else 'FAIL' end, v_n || ' / 8 refused');

    -- 15 publishing checks the exam can be drawn: too few questions in a module, or a total that no longer matches, is refused
    for i in 1..3 loop
      perform academy_author_op_create_question(PRES, null, v_v, jsonb_build_object('module_id', v_m1, 'kind','single', 'prompt','A' || i || '?',
        'choices','[{"id":"a","text":"Yes"},{"id":"b","text":"No"}]'::jsonb, 'answer_key','a', 'explanation','x', 'objective_tags', jsonb_build_array('m3-a')));
      perform academy_author_op_create_question(PRES, null, v_v, jsonb_build_object('module_id', v_m2, 'kind','single', 'prompt','B' || i || '?',
        'choices','[{"id":"a","text":"Yes"},{"id":"b","text":"No"}]'::jsonb, 'answer_key','a', 'explanation','x', 'objective_tags', jsonb_build_array('m3-b')));
    end loop;
    perform academy_author_op_create_question(PRES, null, v_v, jsonb_build_object('module_id', v_m3, 'kind','single', 'prompt','C1?',
      'choices','[{"id":"a","text":"Yes"},{"id":"b","text":"No"}]'::jsonb, 'answer_key','a', 'explanation','x', 'objective_tags', jsonb_build_array('m3-c')));
    perform academy_author_op_set_question_status(PRES, v_qx, 'retired', 'not needed for the draw test');
    ok := true;
    v_a := (academy_content_op_create_module(PRES, null, v_v, '{"title":"Module D"}')->>'id')::uuid;   -- added after the distribution was set
    begin perform academy_op_publish_version(PRES, v_v); ok := false;
    exception when others then ok := sqlstate = '22023' and sqlerrm like '%incomplete%Module D%'; end;
    perform academy_content_op_delete_module(PRES, v_a);
    v_b := (academy_author_op_create_question(PRES, null, v_v, '{"kind":"single","prompt":"No module?","choices":[{"id":"a","text":"A"},{"id":"b","text":"B"}],"answer_key":"a","explanation":"x","objective_tags":["t"]}')->>'id')::uuid;
    begin perform academy_op_publish_version(PRES, v_v); ok := false;
    exception when others then ok := ok and sqlstate = '22023' and sqlerrm like '%needs its module%'; end;
    perform academy_author_op_set_question_status(PRES, v_b, 'retired', 'no module');
    begin perform academy_op_publish_version(PRES, v_v); ok := false;
    exception when others then ok := ok and sqlstate = '22023' and sqlerrm like '%Module C%'; end;
    v_q := (academy_author_op_create_question(PRES, null, v_v, jsonb_build_object('module_id', v_m3, 'kind','single', 'prompt','C2?',
      'choices','[{"id":"a","text":"Yes"},{"id":"b","text":"No"}]'::jsonb, 'answer_key','b', 'explanation','x', 'objective_tags', jsonb_build_array('m3-c')))->>'id')::uuid;
    v_fact := (academy_op_record_fact(PRES, jsonb_build_object('manufacturer_slug',MFR,'model_code','M3TEST1','field','seat.width','value',21,
              'field_class','display','status','verified','source_url','https://example.com/m3','source_label','M3 test','verified_on',current_date,
              'verified_by','m3 test'), null, null)->>'id')::uuid;
    perform academy_author_op_link_fact(PRES, null, jsonb_build_object('question_id', v_q, 'manufacturer_slug', MFR, 'model_code', 'M3TEST1', 'field', 'seat.width'));
    perform academy_content_op_update_version(PRES, v_v, '{"exam_questions":5}');
    begin perform academy_op_publish_version(PRES, v_v); ok := false;
    exception when others then ok := ok and sqlstate = '22023' and sqlerrm like '%adds up to 6%'; end;
    perform academy_content_op_update_version(PRES, v_v, '{"exam_questions":6}');
    ok := ok and (select status from academy_course_versions where id = v_v) = 'draft';
    insert into t_m3 values (15, 'Publishing is refused while a module has no number (added later), an exam question has no module, a module has fewer usable exam questions than its share, or the distribution no longer adds up to the exam size; the version stays a draft',
      case when ok then 'PASS' else 'FAIL' end, '');

    -- 16 published: every exam attempt follows the distribution exactly; no attempt result carries an answer key
    perform academy_op_publish_version(PRES, v_v);
    insert into academy_learners (auth_user_id, full_name, email) values (v_user, 'M3 Test Learner', 'm3test@example.com') returning id into v_learner;
    insert into academy_enrollments (learner_id, version_id, access_source) values (v_learner, v_v, 'admin_grant') returning id into v_enr;
    ok := (select pinned_fact_id from academy_content_refs where question_id = v_q) = v_fact;
    for i in 1..8 loop
      r := academy_op_start_attempt('learner:' || v_learner, v_enr);
      v_att := (r->>'id')::uuid;
      v_ids := array(select jsonb_array_elements_text(r->'question_ids')::uuid);
      select jsonb_object_agg(coalesce(m.title, 'none'), n) into v_cnt
        from (select module_id, count(*) n from academy_questions where id = any (v_ids) group by module_id) x
        left join academy_modules m on m.id = x.module_id;
      if (select count(*) from academy_questions where id = any (v_ids[1:2]) and module_id = v_m1) = 2 then v_grouped := v_grouped + 1; end if;
      ok := ok and v_cnt = '{"Module A":2,"Module B":2,"Module C":2}'::jsonb and cardinality(v_ids) = 6
        and (r - 'id' - 'question_ids') = '{}'::jsonb and not jsonb_path_exists(r, '$.**.answer_key');
      r := academy_op_submit_attempt('learner:' || v_learner, v_att, '{}');
      ok := ok and not (r ? 'answer_key') and not jsonb_path_exists(r, '$.**.answer_key');
    end loop;
    insert into t_m3 values (16, 'After publishing, every attempt (8 in a row) draws exactly 2 / 2 / 2 from the three modules in a shuffled order, and neither the start nor the result returns an answer key',
      case when ok and v_grouped < 8 then 'PASS' else 'FAIL' end, coalesce(v_cnt::text, ''));

    -- 17 a fact replaced after publishing takes its question out of every scored exam; the exam then refuses to start
    perform academy_op_record_fact(PRES, jsonb_build_object('manufacturer_slug',MFR,'model_code','M3TEST1','field','seat.width','value',22,
              'field_class','display','status','verified','source_url','https://example.com/m3','source_label','M3 test','verified_on',current_date,
              'verified_by','m3 test'), v_fact, null);
    ok := not (v_q = any (academy_author_exam_draw(v_v, false))) or cardinality(academy_author_exam_draw(v_v, false)) = 0;
    begin perform academy_op_start_attempt('learner:' || v_learner, v_enr); ok := false;
    exception when others then ok := ok and sqlstate = '22023' and sqlerrm like '%Module C%usable%'; end;
    ok := ok and not exists (select 1 from academy_attempts where enrollment_id = v_enr and submitted_at is null);
    insert into t_m3 values (17, 'When a product fact an exam question relies on is replaced, that question never reaches a scored exam: with too few left, the exam refuses to start and nothing is created',
      case when ok then 'PASS' else 'FAIL' end, '');

    -- 18 published content is frozen for every M3 operation; media used by it cannot change or be deleted
    ok := true; v_n := 0;
    begin perform academy_author_op_set_blocks(PRES, v_l2, '[]'); ok := false; exception when others then if sqlstate = '55000' then v_n := v_n + 1; else ok := false; end if; end;
    begin perform academy_author_op_reorder_modules(PRES, v_v, array[v_m1, v_m2, v_m3]); ok := false; exception when others then if sqlstate = '55000' then v_n := v_n + 1; else ok := false; end if; end;
    begin perform academy_author_op_reorder_lessons(PRES, v_m1, array[v_l1, v_l2]); ok := false; exception when others then if sqlstate = '55000' then v_n := v_n + 1; else ok := false; end if; end;
    begin perform academy_author_op_set_exam_distribution(PRES, v_v, '{}'); ok := false; exception when others then if sqlstate = '55000' then v_n := v_n + 1; else ok := false; end if; end;
    begin perform academy_author_op_create_question(PRES, null, v_v, '{"kind":"single","prompt":"Late?","choices":[{"id":"a","text":"A"},{"id":"b","text":"B"}],"answer_key":"a","explanation":"x","objective_tags":["t"]}'); ok := false;
    exception when others then if sqlstate = '55000' then v_n := v_n + 1; else ok := false; end if; end;
    begin perform academy_author_op_update_question(PRES, v_q, '{"answer_key":"a"}'); ok := false; exception when others then if sqlstate = '55000' then v_n := v_n + 1; else ok := false; end if; end;
    begin perform academy_author_op_set_question_status(PRES, v_q, 'retired', 'late'); ok := false; exception when others then if sqlstate = '55000' then v_n := v_n + 1; else ok := false; end if; end;
    begin perform academy_author_op_link_fact(PRES, null, jsonb_build_object('lesson_id', v_l2, 'manufacturer_slug', MFR, 'model_code', 'M3TEST4')); ok := false;
    exception when others then if sqlstate = '55000' then v_n := v_n + 1; else ok := false; end if; end;
    begin perform academy_author_op_unlink_fact(PRES, v_ref); ok := false; exception when others then if sqlstate = '55000' then v_n := v_n + 1; else ok := false; end if; end;
    begin perform academy_author_op_unlink_fact(PRES, (select id from academy_content_refs where question_id = v_q)); ok := false;   -- a published question's fact link
    exception when others then if sqlstate = '55000' then v_n := v_n + 1; else ok := false; end if; end;
    begin perform academy_author_op_update_media(PRES, v_img, '{"alt_text":"A different description of the chair"}'); ok := false;
    exception when others then if sqlstate = '55000' then v_n := v_n + 1; else ok := false; end if; end;
    begin perform academy_author_op_delete_media(PRES, v_img); ok := false; exception when others then if sqlstate = '55000' then v_n := v_n + 1; else ok := false; end if; end;
    insert into t_m3 values (18, 'Published content is frozen for every M3 operation (blocks, order, distribution, questions, fact links), and a media record it uses can be neither edited nor deleted',
      case when ok and v_n = 12 and (select alt_text from academy_media where id = v_img) = 'A lift chair shown fully reclined, side view'
                and exists (select 1 from academy_content_refs where question_id = v_q) then 'PASS' else 'FAIL' end, v_n || ' / 12 refused');

    -- 19 the automatic draw (no distribution): one from every module that has exam questions, the rest at random
    v_c2 := (academy_content_op_create_course(PRES, null, '{"slug":"m3-test-auto","title":"M3 auto","course_type":"hcps_certification"}')->>'id')::uuid;
    v_v2 := (academy_content_op_create_version(PRES, null, v_c2, '{"exam_questions":3}')->>'id')::uuid;
    for k in 1..3 loop
      v_a := (academy_content_op_create_module(PRES, null, v_v2, jsonb_build_object('title', 'Auto ' || k))->>'id')::uuid;
      for i in 1..3 loop
        perform academy_author_op_create_question(PRES, null, v_v2, jsonb_build_object('module_id', v_a, 'kind','single', 'prompt','Auto ' || k || '.' || i || '?',
          'choices','[{"id":"a","text":"Yes"},{"id":"b","text":"No"}]'::jsonb, 'answer_key','a', 'explanation','x', 'objective_tags', jsonb_build_array('m3-auto')));
      end loop;
    end loop;
    v_a := (academy_content_op_create_module(PRES, null, v_v2, '{"title":"Auto 4"}')->>'id')::uuid;   -- a module without exam questions
    ok := true;
    begin perform academy_op_publish_version(PRES, v_v2); ok := false;
    exception when others then ok := sqlstate = '22023' and sqlerrm like '%Auto 4%no usable exam question%'; end;
    perform academy_content_op_delete_module(PRES, v_a);
    perform academy_op_publish_version(PRES, v_v2);
    insert into academy_enrollments (learner_id, version_id, access_source) values (v_learner, v_v2, 'admin_grant') returning id into v_b;
    for i in 1..6 loop
      r := academy_op_start_attempt('learner:' || v_learner, v_b);
      v_ids := array(select jsonb_array_elements_text(r->'question_ids')::uuid);
      ok := ok and (select count(distinct module_id) from academy_questions where id = any (v_ids)) = 3;
      perform academy_op_submit_attempt('learner:' || v_learner, (r->>'id')::uuid, '{}');
    end loop;
    insert into t_m3 values (19, 'Without a distribution, publishing is refused while a module has no exam question, and every attempt (6 in a row) covers each of the three modules',
      case when ok then 'PASS' else 'FAIL' end, '');

    -- 20 a question used by a knowledge check can be neither retired nor moved to the exam bank
    ok := true;
    v_c2 := (academy_content_op_create_course(PRES, null, '{"slug":"m3-test-check","title":"M3 check","course_type":"training"}')->>'id')::uuid;
    v_v2 := (academy_content_op_create_version(PRES, null, v_c2, '{"exam_questions":1}')->>'id')::uuid;
    v_a := (academy_content_op_create_module(PRES, null, v_v2, '{"title":"M"}')->>'id')::uuid;
    v_b := (academy_content_op_create_lesson(PRES, null, v_a, '{"title":"L"}')->>'id')::uuid;
    v_p1 := (academy_author_op_create_question(PRES, null, v_v2, '{"kind":"single","use":"practice","prompt":"P1?","choices":[{"id":"a","text":"A"},{"id":"b","text":"B"}],"answer_key":"a","explanation":"x","objective_tags":["t"]}')->>'id')::uuid;
    v_p2 := (academy_author_op_create_question(PRES, null, v_v2, '{"kind":"single","use":"practice","prompt":"P2?","choices":[{"id":"a","text":"A"},{"id":"b","text":"B"}],"answer_key":"a","explanation":"x","objective_tags":["t"]}')->>'id')::uuid;
    perform academy_author_op_set_blocks(PRES, v_b, jsonb_build_array(jsonb_build_object('kind','check','question_ids',jsonb_build_array(v_p1, v_p2))));
    begin perform academy_author_op_set_question_status(PRES, v_p1, 'retired', 'x'); ok := false; exception when others then ok := ok and sqlstate = '55000'; end;
    begin perform academy_author_op_update_question(PRES, v_p2, '{"use":"exam"}'); ok := false; exception when others then ok := ok and sqlstate = '55000'; end;
    perform academy_author_op_set_blocks(PRES, v_b, '[]');
    r := academy_author_op_set_question_status(PRES, v_p1, 'retired', 'no longer used');
    ok := ok and r->>'status' = 'retired';
    insert into t_m3 values (20, 'A practice question shown in a lesson knowledge check can be neither retired nor turned into an exam question until the check stops using it',
      case when ok then 'PASS' else 'FAIL' end, '');

    -- 21 media no lesson uses can be edited and deleted; media still in use cannot be deleted
    ok := true;
    r := academy_author_op_update_media(PRES, v_dec, '{"alt_text":"A thin divider line between sections"}');
    ok := r->>'alt_text' = 'A thin divider line between sections';
    begin perform academy_author_op_update_media(PRES, v_dec, '{"storage_path":"media/m3-test/other.png"}'); ok := false; exception when others then ok := ok and sqlstate = '22023'; end;
    r := academy_author_op_delete_media(PRES, v_spare);
    ok := ok and not exists (select 1 from academy_media where id = v_spare)
      and exists (select 1 from academy_events where entity_id = v_spare::text and action = 'delete_media' and actor = PRES and after is null);
    insert into t_m3 values (21, 'Unused media: its alt text can be corrected (the file itself never changes) and it can be deleted with an audit row',
      case when ok then 'PASS' else 'FAIL' end, '');

    -- 22 all or nothing: when the audit row cannot be written, no M3 change is saved (temporary refusing trigger, undone)
    v_c2 := (academy_content_op_create_course(PRES, null, '{"slug":"m3-test-atomic","title":"M3 atomic","course_type":"training"}')->>'id')::uuid;
    v_v2 := (academy_content_op_create_version(PRES, null, v_c2, '{"exam_questions":2}')->>'id')::uuid;
    v_a := (academy_content_op_create_module(PRES, null, v_v2, '{"title":"M1"}')->>'id')::uuid;
    v_b := (academy_content_op_create_module(PRES, null, v_v2, '{"title":"M2"}')->>'id')::uuid;
    v_l2 := (academy_content_op_create_lesson(PRES, null, v_a, '{"title":"L"}')->>'id')::uuid;
    v_q := (academy_author_op_create_question(PRES, null, v_v2, '{"kind":"single","prompt":"Atomic?","choices":[{"id":"a","text":"A"},{"id":"b","text":"B"}],"answer_key":"a","explanation":"x","objective_tags":["t"]}')->>'id')::uuid;
    v_ref := (academy_author_op_link_fact(PRES, null, jsonb_build_object('lesson_id', v_l2, 'manufacturer_slug', MFR, 'model_code', 'M3TEST5'))->>'id')::uuid;
    select count(*) into v_e0 from academy_events;
    execute 'create function pg_temp.m3_refuse_audit() returns trigger language plpgsql as $f$ begin raise exception ''audit store unavailable (M3 test)''; end $f$';
    execute 'create trigger zz_m3_refuse_audit before insert on academy_events for each row execute function pg_temp.m3_refuse_audit()';
    v_n := 0;
    begin perform academy_author_op_set_blocks(PRES, v_l2, '[{"kind":"text","body":"x"}]'); exception when others then if sqlerrm like '%audit store unavailable%' then v_n := v_n + 1; end if; end;
    begin perform academy_author_op_reorder_modules(PRES, v_v2, array[v_b, v_a]); exception when others then if sqlerrm like '%audit store unavailable%' then v_n := v_n + 1; end if; end;
    begin perform academy_author_op_set_exam_distribution(PRES, v_v2, jsonb_build_object(v_a::text, 1, v_b::text, 1)); exception when others then if sqlerrm like '%audit store unavailable%' then v_n := v_n + 1; end if; end;
    begin perform academy_author_op_create_question(PRES, null, v_v2, '{"kind":"single","prompt":"Lost?","choices":[{"id":"a","text":"A"},{"id":"b","text":"B"}],"answer_key":"a","explanation":"x","objective_tags":["t"]}'); exception when others then if sqlerrm like '%audit store unavailable%' then v_n := v_n + 1; end if; end;
    begin perform academy_author_op_update_question(PRES, v_q, '{"answer_key":"b"}'); exception when others then if sqlerrm like '%audit store unavailable%' then v_n := v_n + 1; end if; end;
    begin perform academy_author_op_set_question_status(PRES, v_q, 'retired', 'x'); exception when others then if sqlerrm like '%audit store unavailable%' then v_n := v_n + 1; end if; end;
    begin perform academy_author_op_create_media(PRES, null, '{"kind":"link","external_url":"https://example.com/lost","rights":"link_only"}'); exception when others then if sqlerrm like '%audit store unavailable%' then v_n := v_n + 1; end if; end;
    begin perform academy_author_op_update_media(PRES, v_dec, '{"alt_text":"Lost description of the divider"}'); exception when others then if sqlerrm like '%audit store unavailable%' then v_n := v_n + 1; end if; end;
    begin perform academy_author_op_delete_media(PRES, v_dec); exception when others then if sqlerrm like '%audit store unavailable%' then v_n := v_n + 1; end if; end;
    begin perform academy_author_op_link_fact(PRES, null, jsonb_build_object('lesson_id', v_l2, 'manufacturer_slug', MFR, 'model_code', 'M3TEST6')); exception when others then if sqlerrm like '%audit store unavailable%' then v_n := v_n + 1; end if; end;
    begin perform academy_author_op_unlink_fact(PRES, v_ref); exception when others then if sqlerrm like '%audit store unavailable%' then v_n := v_n + 1; end if; end;
    begin perform academy_author_op_reorder_lessons(PRES, v_a, array[v_l2]); exception when others then if sqlerrm like '%audit store unavailable%' then v_n := v_n + 1; end if; end;
    execute 'drop trigger zz_m3_refuse_audit on academy_events';
    ok := v_n = 12 and (select blocks from academy_lessons where id = v_l2) = '[]'::jsonb
      and (select position from academy_modules where id = v_a) = 1
      and not exists (select 1 from academy_modules where version_id = v_v2 and exam_quota is not null)
      and (select count(*) from academy_questions where version_id = v_v2) = 1
      and (select answer_key from academy_questions where id = v_q) = '"a"'::jsonb and (select status from academy_questions where id = v_q) = 'active'
      and not exists (select 1 from academy_media where external_url = 'https://example.com/lost')
      and (select alt_text from academy_media where id = v_dec) = 'A thin divider line between sections'
      and (select count(*) from academy_content_refs where lesson_id = v_l2) = 1
      and (select count(*) from academy_events) = v_e0;
    insert into t_m3 values (22, 'All or nothing: with the audit history refusing writes, each of the 12 operations fails and leaves nothing changed',
      case when ok and not exists (select 1 from pg_trigger where tgname = 'zz_m3_refuse_audit') then 'PASS' else 'FAIL' end, v_n || ' / 12');

    -- 23 a change that names nothing that exists writes no audit row
    select count(*) into v_e0 from academy_events; ok := true;
    begin perform academy_author_op_set_blocks(PRES, gen_random_uuid(), '[]'); ok := false; exception when others then ok := ok and sqlstate = 'P0002'; end;
    begin perform academy_author_op_reorder_lessons(PRES, gen_random_uuid(), '{}'); ok := false; exception when others then ok := ok and sqlstate = 'P0002'; end;
    begin perform academy_author_op_reorder_modules(PRES, gen_random_uuid(), '{}'); ok := false; exception when others then ok := ok and sqlstate = 'P0002'; end;
    begin perform academy_author_op_set_exam_distribution(PRES, gen_random_uuid(), '{}'); ok := false; exception when others then ok := ok and sqlstate = 'P0002'; end;
    begin perform academy_author_op_create_question(PRES, null, gen_random_uuid(), '{"kind":"single","prompt":"x","choices":[{"id":"a","text":"A"},{"id":"b","text":"B"}],"answer_key":"a","explanation":"x","objective_tags":["t"]}'); ok := false;
    exception when others then ok := ok and sqlstate = 'P0002'; end;
    begin perform academy_author_op_update_question(PRES, gen_random_uuid(), '{"prompt":"x"}'); ok := false; exception when others then ok := ok and sqlstate = 'P0002'; end;
    begin perform academy_author_op_set_question_status(PRES, gen_random_uuid(), 'retired', 'x'); ok := false; exception when others then ok := ok and sqlstate = 'P0002'; end;
    begin perform academy_author_op_update_media(PRES, gen_random_uuid(), '{"alt_text":"Something to describe"}'); ok := false; exception when others then ok := ok and sqlstate = 'P0002'; end;
    begin perform academy_author_op_delete_media(PRES, gen_random_uuid()); ok := false; exception when others then ok := ok and sqlstate = 'P0002'; end;
    begin perform academy_author_op_link_fact(PRES, null, jsonb_build_object('lesson_id', gen_random_uuid(), 'manufacturer_slug', MFR, 'model_code', 'X')); ok := false;
    exception when others then ok := ok and sqlstate = 'P0002'; end;
    begin perform academy_author_op_unlink_fact(PRES, gen_random_uuid()); ok := false; exception when others then ok := ok and sqlstate = 'P0002'; end;
    insert into t_m3 values (23, 'An operation on a lesson, module, version, question, media record or fact link that does not exist is refused (not found) and writes no audit row',
      case when ok and (select count(*) from academy_events) = v_e0 then 'PASS' else 'FAIL' end, '');

    -- 24 the operation marker never outlives an operation, so nothing after it can write directly
    ok := coalesce(current_setting('academy.op', true), '') = '';
    begin insert into academy_media (kind, storage_path, rights) values ('pdf', 'media/x/after.pdf', 'hcps_owned'); ok := false;
    exception when insufficient_privilege then null; end;
    insert into t_m3 values (24, 'After the operations above, no operation marker is left and a direct write is still refused',
      case when ok then 'PASS' else 'FAIL' end, '');

    select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)::text into v_saved from t_m3 x where x.n > 3;
    raise exception 'academy_m3_tests_rollback' using detail = v_saved;
  exception when others then
    if sqlerrm <> 'academy_m3_tests_rollback' then raise; end if;  -- any unexpected error stops the run
    get stacked diagnostics v_saved = pg_exception_detail;
  end;
  delete from t_m3 where n > 3;
  insert into t_m3 select * from jsonb_populate_recordset(null::t_m3, v_saved::jsonb);
end $$;

-- Check 25 (not one of the 24 tests): nothing from the behaviour tests remained.
insert into t_m3 select 25, 'Check: every Academy content table, learners, enrollments, attempts, product facts and the audit history hold exactly as many rows as before the tests; no test trigger left',
  case when (select count(*) from academy_courses) = c and (select count(*) from academy_course_versions) = v
        and (select count(*) from academy_modules) = m and (select count(*) from academy_lessons) = l
        and (select count(*) from academy_questions) = q and (select count(*) from academy_media) = md
        and (select count(*) from academy_content_refs) = r and (select count(*) from product_facts) = f
        and (select count(*) from academy_learners) = lr and (select count(*) from academy_enrollments) = en
        and (select count(*) from academy_attempts) = a and (select count(*) from academy_events) = e
        and not exists (select 1 from pg_trigger where tgname = 'zz_m3_refuse_audit')
       then 'PASS' else 'FAIL' end, ''
from t_m3_before;

select n as "#", test, result, detail from t_m3 order by n;
