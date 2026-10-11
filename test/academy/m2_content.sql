-- LOCAL TEST ONLY (test/academy-m2.pg.test.js). A2C M2 hardening: what the SQL-editor acceptance tests cannot show
-- (they run as the owner, with production's staff list). Roles anon / authenticated / service_role as the API uses them,
-- a non-President administrator, and an operation marker left behind by a caller that catches an error. Rolled back.
begin;
create temp table t_h2 (n int, test text, result text, detail text);
grant all on t_h2 to public;
insert into staff_users (email, name, role, active) values ('second@test.example', 'Second Admin', 'admin', true);

do $$
declare
  PRES constant text := 'staff:admin@test.example';
  ADM  constant text := 'staff:second@test.example';
  v_c uuid; v_v uuid; v_m uuid; v_l uuid; ok boolean; r jsonb; t text; f record; n int;
begin
  -- 1 anon and authenticated (the public keys) can run none of the 15 M2 functions
  ok := true; n := 0;
  for f in select p.oid::regprocedure as sig, p.proname from pg_proc p
            where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_content\_%' and p.proname <> 'academy_content_guard' loop
    foreach t in array array['anon','authenticated'] loop
      begin
        execute format('set local role %I', t);
        execute format('select %s(%s)', f.proname,
          (select string_agg('null::' || format_type(x, null), ',') from unnest((select proargtypes from pg_proc where oid = f.sig)) x));
        ok := false;
      exception when insufficient_privilege then n := n + 1; end;
      execute 'reset role';
    end loop;
  end loop;
  insert into t_h2 values (1, 'anon and authenticated are refused on all 14 callable M2 functions (11 operations, 3 helpers)',
    case when ok and n = 28 then 'PASS' else 'FAIL' end, n || ' refusals');

  -- 2 the server role runs the operations (as the API does) but none of the helpers
  execute 'set local role service_role';
  r := academy_content_op_create_course(PRES, null, '{"slug":"h2-course","title":"H2","course_type":"hcps_certification"}');
  v_c := (r->>'id')::uuid;
  v_v := (academy_content_op_create_version(PRES, null, v_c, '{"exam_questions":1}')->>'id')::uuid;
  v_m := (academy_content_op_create_module(PRES, null, v_v, '{"title":"M"}')->>'id')::uuid;
  v_l := (academy_content_op_create_lesson(PRES, null, v_m, '{"title":"L"}')->>'id')::uuid;
  ok := v_l is not null; n := 0;
  begin perform academy_content_lock_draft(v_v); ok := false; exception when insufficient_privilege then n := n + 1; end;
  begin perform academy_content_keys('{}', '{}'); ok := false; exception when insufficient_privilege then n := n + 1; end;
  begin perform academy_content_actor_president(PRES); ok := false; exception when insufficient_privilege then n := n + 1; end;
  begin perform academy_op_audit('staff', PRES, 'academy_courses', v_c::text, 'create_course', null, null); ok := false;
  exception when insufficient_privilege then n := n + 1; end;
  execute 'reset role';
  insert into t_h2 values (2, 'The server role runs the operations (course, version, module, lesson) but not the helpers or the M1 audit helper',
    case when ok and n = 4 then 'PASS' else 'FAIL' end, '');

  -- 3 direct writes with a forged marker are refused for every API role
  ok := true; n := 0;
  foreach t in array array['anon','authenticated','service_role'] loop
    begin
      execute format('set local role %I', t);
      perform set_config('academy.op', 'create_course', true);
      insert into academy_courses (slug, title, course_type, issuer) values ('h2-forged', 'x', 'training', 'none'); ok := false;
    exception when insufficient_privilege then n := n + 1; end;
    execute 'reset role';
    begin
      execute format('set local role %I', t);
      perform set_config('academy.op', 'update_lesson', true);
      update academy_lessons set title = 'forged' where id = v_l;
      if found then ok := false; end if;
    exception when insufficient_privilege then n := n + 1; end;
    execute 'reset role';
  end loop;
  insert into t_h2 values (3, 'A forged operation marker opens nothing for anon, authenticated or service_role',
    case when ok and (select title from academy_lessons where id = v_l) = 'L' then 'PASS' else 'FAIL' end, n || ' refusals');

  -- 4 a non-President administrator builds draft content, but cannot change a course learners have seen
  r := academy_content_op_update_course(ADM, v_c, '{"title":"Draft course renamed"}');
  ok := r->>'title' = 'Draft course renamed';
  r := academy_content_op_update_lesson(ADM, v_l, '{"est_minutes":7}'); ok := ok and (r->>'est_minutes')::int = 7;
  perform set_config('academy.op', 'test-setup', true);
  insert into academy_questions (version_id, kind, prompt, choices, answer_key, explanation) values (v_v, 'single', 'Q', '[{"id":"a"},{"id":"b"}]', '"a"', 'B');
  perform set_config('academy.op', '', true);
  perform academy_op_publish_version(PRES, v_v);
  begin perform academy_content_op_update_course(ADM, v_c, '{"title":"x"}'); ok := false;
  exception when insufficient_privilege then null; end;
  r := academy_content_op_update_course(PRES, v_c, '{"category":"Lift chairs"}'); ok := ok and r->>'category' = 'Lift chairs';
  insert into t_h2 values (4, 'A non-President administrator edits drafts; once a version is published only the President changes the course',
    case when ok and (select title from academy_courses where id = v_c) = 'Draft course renamed' then 'PASS' else 'FAIL' end, '');

  -- 5 an operation that fails, caught by its caller, leaves no marker behind
  ok := true;
  begin perform academy_content_op_update_version(PRES, v_v, '{"pass_mark":50}'); ok := false; exception when others then null; end;   -- after academy_op_begin
  begin perform academy_content_op_create_course(PRES, null, '{"slug":"b a d","title":"x","course_type":"training"}'); ok := false; exception when others then null; end;
  ok := ok and coalesce(current_setting('academy.op', true), '') = '';
  begin insert into academy_courses (slug, title, course_type, issuer) values ('h2-after-error', 'x', 'training', 'none'); ok := false;
  exception when insufficient_privilege then null; end;
  insert into t_h2 values (5, 'A failed operation caught by its caller leaves no operation marker; a direct write right after is refused',
    case when ok then 'PASS' else 'FAIL' end, '');

  -- 6 the audit row records exactly the person the server named, and its before/after match the table
  ok := (select count(*) from academy_events where entity_id in (v_c::text, v_v::text, v_m::text, v_l::text)) = 8
    and not exists (select 1 from academy_events where entity_id in (v_c::text, v_v::text, v_m::text, v_l::text) and actor not in (PRES, ADM))
    and (select after from academy_events where entity_id = v_l::text and action = 'update_lesson') = (select to_jsonb(l) from academy_lessons l where id = v_l)
    and (select after->>'title' from academy_events where entity_id = v_c::text and action = 'update_course' and actor = PRES) = 'Draft course renamed';
  insert into t_h2 values (6, 'Every change has one audit row with the named person; the recorded "after" equals the saved row',
    case when ok then 'PASS' else 'FAIL' end, '');

  -- 7 a TEST course made through M2 still never issues a certificate (M1 rule unchanged)
  r := academy_content_op_create_course(PRES, null, '{"slug":"test-h2-pilot","title":"TEST","course_type":"hcps_certification"}');
  ok := r->>'slug' like 'test-%' and r->>'issuer' = 'hcps';
  ok := ok and (select prosrc from pg_proc where proname = 'academy_op_issue_certificate') like '%TEST course never issues%';
  insert into t_h2 values (7, 'TEST courses keep their test- prefix through M2, and M1 still refuses them a certificate',
    case when ok then 'PASS' else 'FAIL' end, '');
end $$;

select lpad(n::text, 2, '0') || '|' || result || '|' || test || '|' || coalesce(detail, '') from t_h2 order by n;
rollback;
