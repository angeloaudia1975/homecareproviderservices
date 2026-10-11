-- =============================================================================================
-- HCPS Academy — A2C M2 acceptance tests                 supabase/academy_a2c_m2_acceptance_tests.sql
-- Run right after M2, in the Supabase SQL editor (as the database owner, as the editor does). Tests 1-3 only read.
-- Tests 4-20 create test rows inside a sub-transaction that is always undone (a deliberate exception rolls it back
-- after the results are saved). Test 17 adds a temporary refusing trigger to the audit table inside its own undone
-- block; it is never visible to any other session. The results table is the LAST statement, so the editor shows it.
-- Check 21 confirms nothing was left behind: the content and audit tables hold exactly as many rows as before.
-- Uses existing rows only as references: Golden in the manufacturer list and one active HCPS President (and, when
-- there is one, an active administrator who is not the President, for test 15). No other HCPS table is written.
-- =============================================================================================
drop table if exists t_m2;
create temp table t_m2 (n int, test text, result text, detail text);
drop table if exists t_m2_before;
create temp table t_m2_before as
  select (select count(*) from academy_courses) c, (select count(*) from academy_course_versions) v,
         (select count(*) from academy_modules) m, (select count(*) from academy_lessons) l, (select count(*) from academy_events) e;

-- ---------- Structure and privileges (read-only) ----------
insert into t_m2
select 1, 'M2 installed: 11 content operations, 3 helpers, the guard function, the guard trigger on the 4 content tables',
  case when (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like 'academy\_content\_op\_%') = 11
        and (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like 'academy\_content\_%') = 15
        and (select string_agg(c.relname, ',' order by c.relname) from pg_trigger t join pg_class c on c.oid = t.tgrelid
              where t.tgname = 'academy_content_guard' and not t.tgisinternal)
            = 'academy_course_versions,academy_courses,academy_lessons,academy_modules'
       then 'PASS' else 'FAIL' end, ''
union all
select 2, 'Only the server role can run the 11 operations (fixed rights, pinned search path); nobody but the owner can run the helpers or the guard; nothing for public/anon/authenticated',
  case when (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like 'academy\_content\_op\_%' and prosecdef
              and has_function_privilege('service_role', oid, 'EXECUTE')) = 11
        and not exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname like 'academy\_content\_%'
                         and not prosecdef and has_function_privilege('service_role', oid, 'EXECUTE'))
        and not exists (select 1 from pg_proc p, unnest(array['anon','authenticated']) r
                         where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_content\_%'
                           and has_function_privilege(r, p.oid, 'EXECUTE'))
        and not exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                         where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_content\_%'
                           and a.grantee = 0 and a.privilege_type = 'EXECUTE')
        and not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_content\_%'
                         and not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'))
        and (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like 'academy\_content\_op\_%'
              and pg_get_userbyid(proowner) = (select pg_get_userbyid(proowner) from pg_proc where oid = 'public.academy_content_guard()'::regprocedure)) = 11
       then 'PASS' else 'FAIL' end, ''
union all
select 3, 'M1 untouched: 19 functions, 6 guard triggers, installed-code fingerprint as approved (130e45fa… or, CRLF paste, e70543ba…); A1 rule triggers in place',
  case when (select count(*) from pg_proc where pronamespace = 'public'::regnamespace
              and (proname like 'academy\_op\_%' or proname = 'academy_audited_guard')) = 19
        and (select count(*) from pg_trigger where tgname = 'academy_audited_guard' and not tgisinternal) = 6
        and (select md5(string_agg(p.proname || ':' || pg_get_function_identity_arguments(p.oid) || ':' || p.prosecdef || ':' ||
                        coalesce(array_to_string(p.proconfig, ','), '') || ':' || p.prosrc, '|' order by p.proname))
               from pg_proc p where p.pronamespace = 'public'::regnamespace
                and (p.proname like 'academy\_op\_%' or p.proname = 'academy_audited_guard'))
            in ('130e45fa36f768e032a89da43b645f8a', 'e70543ba23d96ca7c5aec8eeff0ea341')
        and (select count(*) from pg_trigger where not tgisinternal and tgname in ('academy_modules_frozen','academy_lessons_frozen',
             'academy_questions_frozen','academy_course_versions_guard','product_facts_append_only','academy_events_append_only',
             'academy_certificates_guard')) = 7
       then 'PASS' else 'FAIL' end, '';

-- ---------- Behaviour (undone at the end) ----------
do $$
declare
  PRES text; OTHER text; v_saved text; ok boolean; v_n0 bigint; v_n1 bigint; v_e0 bigint; r jsonb; s text;
  v_c uuid; v_mp uuid; v_v1 uuid; v_v2 uuid; v_m1 uuid; v_m2 uuid; v_m3 uuid; v_l1 uuid; v_l2 uuid; v_tc uuid; t text;
begin
  begin  -- sub-transaction: every write in here is undone at the end
    select 'staff:' || lower(email) into PRES from staff_users
     where coalesce(active, true) and lower(coalesce(role, '')) = 'president' order by email limit 1;
    select 'staff:' || lower(email) into OTHER from staff_users
     where coalesce(active, true) and lower(coalesce(role, '')) in ('admin','owner') order by email limit 1;
    if PRES is null or not exists (select 1 from manufacturers where slug = 'golden-technologies') then
      insert into t_m2 values (4, 'Behaviour tests', 'SKIP', 'needs one active HCPS President and Golden in the manufacturer list'); return;
    end if;

    -- 4 the owner (the SQL editor) cannot write content directly either: no audited operation, no change
    ok := true;
    begin insert into academy_courses (slug, title, course_type, issuer) values ('m2-direct', 'x', 'training', 'none'); ok := false;
    exception when insufficient_privilege then null; end;
    insert into t_m2 values (4, 'A direct content insert is refused, even for the database owner', case when ok then 'PASS' else 'FAIL' end, '');

    -- 5 create a course: the row and exactly one audit row, in the same transaction
    select count(*) into v_n0 from academy_events;
    r := academy_content_op_create_course(PRES, null, jsonb_build_object('slug','m2-test-course','title','M2 test',
           'course_type','hcps_certification','manufacturer_slug','golden-technologies','category','Lift chairs'));
    v_c := (r->>'id')::uuid;
    select count(*) into v_n1 from academy_events;
    insert into t_m2 values (5, 'Create course: saved as a draft with the issuer that follows its type, and exactly one audit row naming the person',
      case when r->>'status' = 'draft' and r->>'issuer' = 'hcps' and v_n1 = v_n0 + 1
            and exists (select 1 from academy_events where entity = 'academy_courses' and entity_id = v_c::text and action = 'create_course'
                          and actor = PRES and actor_type = 'staff' and after->>'slug' = 'm2-test-course')
            and coalesce(current_setting('academy.op', true), '') = '' then 'PASS' else 'FAIL' end, '');

    -- 6 refused inputs: no row, no audit row
    select count(*) into v_e0 from academy_events; ok := true;
    foreach s in array array[
      '{"slug":"Bad Slug","title":"x","course_type":"training"}',
      '{"slug":"m2-x","title":"x","course_type":"training","status":"published"}',
      '{"slug":"m2-x","title":"x","course_type":"training","issuer":"manufacturer"}',
      '{"slug":"m2-x","title":"x","course_type":"training","manufacturer_slug":"no-such-maker"}',
      '{"slug":"m2-x","title":"x","course_type":"hcps_certification","external_url":"https://example.com/x"}',
      '{"slug":"m2-x","title":"","course_type":"training"}',
      '{"slug":"m2-x","title":"x","course_type":"certificate"}'] loop
      begin perform academy_content_op_create_course(PRES, null, s::jsonb); ok := false;
      exception when others then ok := ok and sqlstate = '22023'; end;
    end loop;
    begin perform academy_content_op_create_course(PRES, null, '{"slug":"m2-test-course","title":"dup","course_type":"training"}'); ok := false;
    exception when others then ok := ok and sqlstate = '23505'; end;
    insert into t_m2 values (6, 'Invalid course details (bad short name, status or issuer smuggled in, unknown manufacturer, outside link on an HCPS course, no title, unknown type) and a duplicate are refused, with no audit row',
      case when ok and (select count(*) from academy_events) = v_e0 and (select count(*) from academy_courses where slug = 'm2-x') = 0
           then 'PASS' else 'FAIL' end, '');

    -- 7 manufacturer programs
    ok := true;
    begin perform academy_content_op_create_course(PRES, null, '{"slug":"m2-mp","title":"x","course_type":"manufacturer_program","manufacturer_slug":"golden-technologies"}'); ok := false;
    exception when others then ok := ok and sqlstate = '22023'; end;
    begin perform academy_content_op_create_course(PRES, null, '{"slug":"m2-mp","title":"x","course_type":"manufacturer_program","manufacturer_slug":"golden-technologies","external_url":"http://example.com"}'); ok := false;
    exception when others then ok := ok and sqlstate = '22023'; end;
    r := academy_content_op_create_course(PRES, null, '{"slug":"m2-mp","title":"Golden program","course_type":"manufacturer_program","manufacturer_slug":"golden-technologies","external_url":"https://example.com/golden"}');
    v_mp := (r->>'id')::uuid; ok := ok and r->>'issuer' = 'manufacturer';
    begin perform academy_content_op_create_version(PRES, null, v_mp, null); ok := false;
    exception when others then ok := ok and sqlstate = '22023'; end;
    insert into t_m2 values (7, 'A manufacturer program needs its manufacturer and an https:// link, is marked manufacturer-issued, and has no HCPS versions',
      case when ok and not exists (select 1 from academy_course_versions where course_id = v_mp) then 'PASS' else 'FAIL' end, '');

    -- 8 versions
    r := academy_content_op_create_version(PRES, null, v_c, null); v_v1 := (r->>'id')::uuid;
    ok := (r->>'version')::int = 1 and (r->>'pass_mark')::int = 80 and (r->>'exam_questions')::int = 25 and r->>'validity_months' is null and r->>'status' = 'draft';
    r := academy_content_op_create_version(PRES, null, v_c, '{"pass_mark":85,"exam_questions":10,"validity_months":24}'); v_v2 := (r->>'id')::uuid;
    ok := ok and (r->>'version')::int = 2 and (r->>'pass_mark')::int = 85 and (r->>'validity_months')::int = 24;
    insert into t_m2 values (8, 'Create version: numbered 1, 2…, draft, defaults 80% / 25 questions; each with its audit row',
      case when ok and (select count(*) from academy_events where entity = 'academy_course_versions' and action = 'create_version'
                         and entity_id in (v_v1::text, v_v2::text) and actor = PRES) = 2 then 'PASS' else 'FAIL' end, '');

    -- 9 draft settings
    select count(*) into v_e0 from academy_events;
    r := academy_content_op_update_version(PRES, v_v1, '{"pass_mark":90,"exam_questions":1}'); ok := (r->>'pass_mark')::int = 90 and (r->>'exam_questions')::int = 1;
    ok := ok and exists (select 1 from academy_events where entity_id = v_v1::text and action = 'update_version'
                          and (before->>'pass_mark')::int = 80 and (after->>'pass_mark')::int = 90);
    select count(*) into v_e0 from academy_events;
    foreach s in array array['{"status":"published"}', '{"version":7}', '{"published_by":"x"}', '{"pass_mark":"many"}', '{"pass_mark":0}', '{}'] loop
      begin perform academy_content_op_update_version(PRES, v_v1, s::jsonb); ok := false;
      exception when others then ok := ok and sqlstate = '22023'; end;
    end loop;
    insert into t_m2 values (9, 'Update a draft version (audit row holds before and after); status, number, publisher or bad values cannot be set',
      case when ok and (select count(*) from academy_events) = v_e0 and (select pass_mark from academy_course_versions where id = v_v1) = 90
           then 'PASS' else 'FAIL' end, '');

    -- 10 review
    r := academy_content_op_move_version(PRES, v_v2, 'in_review'); ok := r->>'status' = 'in_review';
    begin perform academy_content_op_update_version(PRES, v_v2, '{"pass_mark":70}'); ok := false;
    exception when others then ok := ok and sqlstate = '55000'; end;
    begin perform academy_content_op_create_module(PRES, null, v_v2, '{"title":"x"}'); ok := false;
    exception when others then ok := ok and sqlstate = '55000'; end;
    begin perform academy_content_op_move_version(PRES, v_v2, 'published'); ok := false;
    exception when others then ok := ok and sqlstate = '22023'; end;
    begin perform academy_content_op_move_version(PRES, v_v2, 'in_review'); ok := false;
    exception when others then ok := ok and sqlstate = '55000'; end;
    r := academy_content_op_move_version(PRES, v_v2, 'draft'); ok := ok and r->>'status' = 'draft';
    insert into t_m2 values (10, 'Submit for review / return to draft are audited; a version in review cannot be edited; nothing else can be reached this way (never "published")',
      case when ok and exists (select 1 from academy_events where entity_id = v_v2::text and action = 'submit_for_review')
                   and exists (select 1 from academy_events where entity_id = v_v2::text and action = 'return_to_draft') then 'PASS' else 'FAIL' end, '');

    -- 11 modules
    r := academy_content_op_create_module(PRES, null, v_v1, '{"title":"Safety","objectives":["Explain the lift limit"]}'); v_m1 := (r->>'id')::uuid;
    ok := (r->>'position')::int = 1;
    r := academy_content_op_create_module(PRES, null, v_v1, '{"title":"Spare"}'); v_m2 := (r->>'id')::uuid;
    ok := ok and (r->>'position')::int = 2;
    r := academy_content_op_update_module(PRES, v_m1, '{"title":"Safety first","objectives":["Explain the lift limit","Name the battery check"]}');
    ok := ok and r->>'title' = 'Safety first' and jsonb_array_length(r->'objectives') = 2;
    foreach s in array array['{"objectives":[{}]}', '{"objectives":"one"}', '{"position":5}', '{"version_id":"00000000-0000-0000-0000-000000000000"}', '{"title":""}'] loop
      begin perform academy_content_op_update_module(PRES, v_m1, s::jsonb); ok := false;
      exception when others then ok := ok and sqlstate = '22023'; end;
    end loop;
    r := academy_content_op_delete_module(PRES, v_m2); ok := ok and r->>'deleted' = v_m2::text;
    insert into t_m2 values (11, 'Modules: created in order, edited, an empty one deleted — each audited; bad objectives, position or version changes refused',
      case when ok and not exists (select 1 from academy_modules where id = v_m2)
            and (select count(*) from academy_events where entity = 'academy_modules' and entity_id in (v_m1::text, v_m2::text)) = 4
           then 'PASS' else 'FAIL' end, '');

    -- 12 lessons
    r := academy_content_op_create_lesson(PRES, null, v_m1, '{"title":"Lift limits"}'); v_l1 := (r->>'id')::uuid;
    ok := (r->>'est_minutes')::int = 10 and (r->>'position')::int = 1;
    r := academy_content_op_create_lesson(PRES, null, v_m1, '{"title":"Spare lesson","est_minutes":5}'); v_l2 := (r->>'id')::uuid;
    r := academy_content_op_update_lesson(PRES, v_l1, '{"title":"Lift limits and loads","est_minutes":12}');
    ok := ok and r->>'title' = 'Lift limits and loads' and (r->>'est_minutes')::int = 12;
    foreach s in array array['{"est_minutes":31}', '{"est_minutes":"ten"}', '{"blocks":[]}', '{"module_id":"00000000-0000-0000-0000-000000000000"}'] loop
      begin perform academy_content_op_update_lesson(PRES, v_l1, s::jsonb); ok := false;
      exception when others then ok := ok and sqlstate = '22023'; end;
    end loop;
    begin perform academy_content_op_delete_module(PRES, v_m1); ok := false;
    exception when others then ok := ok and sqlstate = '55000'; end;
    r := academy_content_op_delete_lesson(PRES, v_l2); ok := ok and r->>'deleted' = v_l2::text;
    insert into t_m2 values (12, 'Lessons: created (10 minutes by default), edited, deleted — each audited; 31 minutes, lesson content or moves refused; a module with lessons cannot be deleted',
      case when ok and not exists (select 1 from academy_lessons where id = v_l2)
            and (select count(*) from academy_events where entity = 'academy_lessons' and entity_id in (v_l1::text, v_l2::text)) = 4
           then 'PASS' else 'FAIL' end, '');

    -- 13 direct writes refused: the owner without an operation, and the server role even when it sets the marker itself
    ok := true;
    foreach t in array array['update academy_courses set title = ''x'' where id = $1', 'delete from academy_courses where id = $1',
                             'update academy_course_versions set pass_mark = 50 where id = $2', 'delete from academy_course_versions where id = $2',
                             'update academy_modules set title = ''x'' where id = $3', 'delete from academy_modules where id = $3',
                             'update academy_lessons set title = ''x'' where id = $4', 'delete from academy_lessons where id = $4',
                             'insert into academy_modules (version_id, position, title) values ($2, 9, ''x'')',
                             'insert into academy_lessons (module_id, position, title, est_minutes) values ($3, 9, ''x'', 5)',
                             'insert into academy_course_versions (course_id, version) values ($1, 9)'] loop
      begin execute t using v_c, v_v1, v_m1, v_l1; ok := false;
      exception when insufficient_privilege then null; end;
      begin
        execute 'set local role service_role';
        perform set_config('academy.op', 'forged', true);
        execute t using v_c, v_v1, v_m1, v_l1; ok := false;
      exception when insufficient_privilege then null; end;
      execute 'reset role';
    end loop;
    insert into t_m2 values (13, 'Direct inserts, edits and deletes on courses, versions, modules and lessons are refused — for the owner, and for the server role even with a forged operation marker',
      case when ok and (select title from academy_courses where id = v_c) = 'M2 test' and exists (select 1 from academy_lessons where id = v_l1)
           then 'PASS' else 'FAIL' end, '');

    -- 14 M1 publishing still works on content made by M2, and published content is then locked
    insert into academy_questions (version_id, module_id, kind, prompt, choices, answer_key, explanation)   -- exam questions are C2; one, for publishing
      values (v_v1, v_m1, 'single', 'Q', '[{"id":"a"},{"id":"b"}]', '"a"', 'Because');
    perform academy_op_publish_version(PRES, v_v1);
    ok := (select status from academy_course_versions where id = v_v1) = 'published'
          and exists (select 1 from academy_events where entity_id = v_v1::text and action = 'publish_version');
    select count(*) into v_e0 from academy_events;
    begin perform academy_content_op_update_version(PRES, v_v1, '{"pass_mark":50}'); ok := false; exception when others then ok := ok and sqlstate = '55000'; end;
    begin perform academy_content_op_move_version(PRES, v_v1, 'draft'); ok := false; exception when others then ok := ok and sqlstate = '55000'; end;
    begin perform academy_content_op_create_module(PRES, null, v_v1, '{"title":"x"}'); ok := false; exception when others then ok := ok and sqlstate = '55000'; end;
    begin perform academy_content_op_update_module(PRES, v_m1, '{"title":"x"}'); ok := false; exception when others then ok := ok and sqlstate = '55000'; end;
    begin perform academy_content_op_create_lesson(PRES, null, v_m1, '{"title":"x"}'); ok := false; exception when others then ok := ok and sqlstate = '55000'; end;
    begin perform academy_content_op_update_lesson(PRES, v_l1, '{"title":"x"}'); ok := false; exception when others then ok := ok and sqlstate = '55000'; end;
    begin perform academy_content_op_delete_lesson(PRES, v_l1); ok := false; exception when others then ok := ok and sqlstate = '55000'; end;
    insert into t_m2 values (14, 'M1 publishing still works on M2 content; a published version, its modules and lessons can then no longer be changed (no audit row for the refusals)',
      case when ok and (select count(*) from academy_events) = v_e0 then 'PASS' else 'FAIL' end, '');

    -- 15 a course learners have seen: the President only
    ok := true;
    if OTHER is not null then
      begin perform academy_content_op_update_course(OTHER, v_c, '{"title":"Renamed"}'); ok := false;
      exception when others then ok := sqlstate = '42501'; end;
    end if;
    r := academy_content_op_update_course(PRES, v_c, '{"title":"Renamed by the President"}');
    ok := ok and r->>'title' = 'Renamed by the President'
          and exists (select 1 from academy_events where entity_id = v_c::text and action = 'update_course' and actor = PRES);
    begin perform academy_content_op_update_course(PRES, v_c, '{"status":"published"}'); ok := false; exception when others then ok := ok and sqlstate = '22023'; end;
    begin perform academy_content_op_update_course(PRES, v_c, '{"external_url":"https://example.com"}'); ok := false; exception when others then ok := ok and sqlstate = '22023'; end;
    insert into t_m2 values (15, 'A course with a published version is changed by the President only; its status and an outside link cannot be set this way',
      case when ok then 'PASS' else 'FAIL' end,
      case when OTHER is null then 'no active non-President administrator to try; the refusal is covered by the local tests' else '' end);

    -- 16 the acting person must be an active HCPS administrator, named as staff:<email>
    select count(*) into v_e0 from academy_events; ok := true;
    foreach s in array array['staff:nobody@example.invalid', 'learner:' || gen_random_uuid(), 'system:grader', 'president', ''] loop
      begin perform academy_content_op_create_course(s, null, '{"slug":"m2-actor","title":"x","course_type":"training"}'); ok := false;
      exception when others then ok := ok and sqlstate = '42501'; end;
      begin perform academy_content_op_update_lesson(s, v_l1, '{"title":"x"}'); ok := false;
      exception when others then ok := ok and sqlstate = '42501'; end;
    end loop;
    begin perform academy_content_op_create_course(null, null, '{"slug":"m2-actor","title":"x","course_type":"training"}'); ok := false;
    exception when others then ok := ok and sqlstate = '42501'; end;
    for s in select 'staff:' || lower(email) from staff_users
              where not (coalesce(active, true) and lower(coalesce(role, '')) in ('president','admin','owner')) limit 3 loop
      begin perform academy_content_op_create_course(s, null, '{"slug":"m2-actor","title":"x","course_type":"training"}'); ok := false;
      exception when others then ok := ok and sqlstate = '42501'; end;
    end loop;
    insert into t_m2 values (16, 'Unknown, learner, system, unnamed, inactive or non-administrator actors are refused before anything is written',
      case when ok and (select count(*) from academy_events) = v_e0 and not exists (select 1 from academy_courses where slug = 'm2-actor')
           then 'PASS' else 'FAIL' end, '');

    -- 17 all or nothing: with the audit store refusing writes, every operation fails and changes nothing
    v_tc := (academy_content_op_create_course(PRES, null, '{"slug":"test-m2-pilot","title":"TEST","course_type":"hcps_certification"}')->>'id')::uuid;
    r := academy_content_op_create_version(PRES, null, v_tc, null); v_v2 := (r->>'id')::uuid;
    v_m2 := (academy_content_op_create_module(PRES, null, v_v2, '{"title":"M"}')->>'id')::uuid;
    v_l2 := (academy_content_op_create_lesson(PRES, null, v_m2, '{"title":"L"}')->>'id')::uuid;
    v_m3 := (academy_content_op_create_module(PRES, null, v_v2, '{"title":"Empty"}')->>'id')::uuid;
    ok := true; v_n0 := 0;
    begin
      execute 'create function pg_temp.m2_refuse_audit() returns trigger language plpgsql as $f$ begin raise exception ''audit store unavailable (test)''; end $f$';
      execute 'create trigger zz_m2_refuse_audit before insert on academy_events for each row execute function pg_temp.m2_refuse_audit()';
      foreach s in array array['create_course','update_course','create_version','update_version','move_version','create_module',
                               'update_module','delete_module','create_lesson','update_lesson','delete_lesson'] loop
        begin
          case s
            when 'create_course'  then perform academy_content_op_create_course(PRES, null, '{"slug":"m2-atomic","title":"x","course_type":"training"}');
            when 'update_course'  then perform academy_content_op_update_course(PRES, v_tc, '{"title":"changed"}');
            when 'create_version' then perform academy_content_op_create_version(PRES, null, v_tc, null);
            when 'update_version' then perform academy_content_op_update_version(PRES, v_v2, '{"pass_mark":51}');
            when 'move_version'   then perform academy_content_op_move_version(PRES, v_v2, 'in_review');
            when 'create_module'  then perform academy_content_op_create_module(PRES, null, v_v2, '{"title":"x"}');
            when 'update_module'  then perform academy_content_op_update_module(PRES, v_m2, '{"title":"changed"}');
            when 'delete_module'  then perform academy_content_op_delete_module(PRES, v_m3);
            when 'create_lesson'  then perform academy_content_op_create_lesson(PRES, null, v_m2, '{"title":"x"}');
            when 'update_lesson'  then perform academy_content_op_update_lesson(PRES, v_l2, '{"title":"changed"}');
            when 'delete_lesson'  then perform academy_content_op_delete_lesson(PRES, v_l2);
          end case;
          ok := false;
        exception when others then
          if sqlerrm like '%audit store unavailable%' then v_n0 := v_n0 + 1; else ok := false; end if;
        end;
      end loop;
      ok := ok and v_n0 = 11
            and (select title from academy_courses where id = v_tc) = 'TEST' and not exists (select 1 from academy_courses where slug = 'm2-atomic')
            and (select count(*) from academy_course_versions where course_id = v_tc) = 1
            and (select pass_mark from academy_course_versions where id = v_v2) = 80 and (select status from academy_course_versions where id = v_v2) = 'draft'
            and (select count(*) from academy_modules where version_id = v_v2) = 2 and (select title from academy_modules where id = v_m2) = 'M'
            and (select count(*) from academy_lessons where module_id = v_m2) = 1 and (select title from academy_lessons where id = v_l2) = 'L';
      raise exception 'm2_undo_refusal';
    exception when others then if sqlerrm <> 'm2_undo_refusal' then raise; end if;
    end;
    insert into t_m2 values (17, 'If the audit row cannot be written, each of the 11 operations fails and its change is not saved',
      case when ok and not exists (select 1 from pg_trigger where tgname = 'zz_m2_refuse_audit') then 'PASS' else 'FAIL' end, v_n0 || ' / 11');

    -- 18 a change that does not happen leaves no audit row claiming it
    perform academy_content_op_create_version(PRES, '00000000-0000-0000-0000-0000000000a1', v_tc, null);
    select count(*) into v_e0 from academy_events; ok := true;
    begin perform academy_content_op_create_version(PRES, '00000000-0000-0000-0000-0000000000a1', v_tc, null); ok := false;
    exception when others then ok := sqlstate = '23505'; end;
    begin perform academy_content_op_update_course(PRES, gen_random_uuid(), '{"title":"x"}'); ok := false; exception when others then ok := ok and sqlstate = 'P0002'; end;
    begin perform academy_content_op_update_version(PRES, gen_random_uuid(), '{"pass_mark":70}'); ok := false; exception when others then ok := ok and sqlstate = 'P0002'; end;
    begin perform academy_content_op_move_version(PRES, gen_random_uuid(), 'in_review'); ok := false; exception when others then ok := ok and sqlstate = 'P0002'; end;
    begin perform academy_content_op_create_version(PRES, null, gen_random_uuid(), null); ok := false; exception when others then ok := ok and sqlstate = 'P0002'; end;
    begin perform academy_content_op_create_module(PRES, null, gen_random_uuid(), '{"title":"x"}'); ok := false; exception when others then ok := ok and sqlstate = 'P0002'; end;
    begin perform academy_content_op_update_module(PRES, gen_random_uuid(), '{"title":"x"}'); ok := false; exception when others then ok := ok and sqlstate = 'P0002'; end;
    begin perform academy_content_op_delete_module(PRES, gen_random_uuid()); ok := false; exception when others then ok := ok and sqlstate = 'P0002'; end;
    begin perform academy_content_op_create_lesson(PRES, null, gen_random_uuid(), '{"title":"x"}'); ok := false; exception when others then ok := ok and sqlstate = 'P0002'; end;
    begin perform academy_content_op_update_lesson(PRES, gen_random_uuid(), '{"title":"x"}'); ok := false; exception when others then ok := ok and sqlstate = 'P0002'; end;
    begin perform academy_content_op_delete_lesson(PRES, gen_random_uuid()); ok := false; exception when others then ok := ok and sqlstate = 'P0002'; end;
    insert into t_m2 values (18, 'A change that fails while being saved (the same id twice) or names nothing that exists writes no audit row',
      case when ok and (select count(*) from academy_events) = v_e0 then 'PASS' else 'FAIL' end, '');

    -- 19 M1 retiring still works; a retired version is locked; history is kept
    perform academy_op_retire_version(PRES, v_v1, 'M2 acceptance test');
    ok := (select status from academy_course_versions where id = v_v1) = 'retired';
    begin perform academy_content_op_update_version(PRES, v_v1, '{"pass_mark":60}'); ok := false; exception when others then ok := ok and sqlstate = '55000'; end;
    begin perform academy_content_op_update_lesson(PRES, v_l1, '{"title":"x"}'); ok := false; exception when others then ok := ok and sqlstate = '55000'; end;
    insert into t_m2 values (19, 'M1 retiring still works on M2 content; the retired version and its lessons stay as they were',
      case when ok and exists (select 1 from academy_lessons where id = v_l1 and title = 'Lift limits and loads') then 'PASS' else 'FAIL' end, '');

    -- 20 the operation marker never outlives an operation, so nothing after it can write directly
    ok := coalesce(current_setting('academy.op', true), '') = '';
    begin insert into academy_courses (slug, title, course_type, issuer) values ('m2-after', 'x', 'training', 'none'); ok := false;
    exception when insufficient_privilege then null; end;
    insert into t_m2 values (20, 'After the operations above, no operation marker is left and a direct write is still refused',
      case when ok then 'PASS' else 'FAIL' end, '');

    select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)::text into v_saved from t_m2 x where x.n > 3;
    raise exception 'academy_m2_tests_rollback' using detail = v_saved;
  exception when others then
    if sqlerrm <> 'academy_m2_tests_rollback' then raise; end if;  -- any unexpected error stops the run
    get stacked diagnostics v_saved = pg_exception_detail;
  end;
  delete from t_m2 where n > 3;
  insert into t_m2 select * from jsonb_populate_recordset(null::t_m2, v_saved::jsonb);
end $$;

-- Check 21 (not one of the 20 tests): nothing from the behaviour tests remained.
insert into t_m2 select 21, 'Check: courses, versions, modules, lessons and the audit history hold exactly as many rows as before the tests; no test trigger left',
  case when (select count(*) from academy_courses) = c and (select count(*) from academy_course_versions) = v
        and (select count(*) from academy_modules) = m and (select count(*) from academy_lessons) = l
        and (select count(*) from academy_events) = e
        and not exists (select 1 from pg_trigger where tgname = 'zz_m2_refuse_audit')
       then 'PASS' else 'FAIL' end, ''
from t_m2_before;

select n as "#", test, result, detail from t_m2 order by n;
