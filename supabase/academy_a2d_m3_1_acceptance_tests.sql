-- =============================================================================================
-- HCPS Academy — A2D M3.1 acceptance tests           supabase/academy_a2d_m3_1_acceptance_tests.sql
-- Run right after M3.1, in the Supabase SQL editor (as the database owner, as the editor does). Tests 1-3 only read.
-- Tests 4-16 create test rows inside a sub-transaction that is always undone (a deliberate exception rolls it back after
-- the results are saved). Tests 12 and 13 add a temporary refusing trigger inside that undone block; it is never visible
-- to any other session. Works with real Academy content present (it only adds, then undoes, its own "m3-1-test-…" course).
-- Check 17 confirms nothing was left behind: every content table, product facts and the audit history hold exactly as
-- many rows as before, and no test trigger remains. The results table is the LAST statement, so the editor shows it.
-- Uses existing rows only as references: Golden in the manufacturer list and one active HCPS President.
-- Two-session tests (simultaneous saves) need two connections and run locally: test/academy-m3_1.pg.test.js.
-- =============================================================================================
drop table if exists t_m31;
create temp table t_m31 (n int, test text, result text, detail text);
drop table if exists t_m31_before;
create temp table t_m31_before as
  select (select count(*) from academy_courses) c, (select count(*) from academy_course_versions) v,
         (select count(*) from academy_modules) m, (select count(*) from academy_lessons) l, (select count(*) from academy_questions) q,
         (select count(*) from academy_media) md, (select count(*) from academy_content_refs) r, (select count(*) from product_facts) f,
         (select count(*) from academy_events) e, (select md5(coalesce(string_agg(id::text || ':' || blocks::text, ',' order by id), '')) from academy_lessons) lb;

-- ---------- Structure and privileges (read-only) ----------
insert into t_m31
select 1, 'M3.1 installed: one operation (academy_save_op_lesson, security definer) and one helper (academy_save_lesson_links), both with a pinned search path and the same owner as the M3 guard',
  case when (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like 'academy\_save\_%') = 2
        and (select prosecdef from pg_proc where oid = to_regprocedure('public.academy_save_op_lesson(text,uuid,jsonb,jsonb)'))
        and not (select prosecdef from pg_proc where oid = to_regprocedure('public.academy_save_lesson_links(jsonb)'))
        and not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_save\_%'
                         and not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'))
        and (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like 'academy\_save\_%'
              and pg_get_userbyid(proowner) = (select pg_get_userbyid(proowner) from pg_proc where oid = 'public.academy_author_guard()'::regprocedure)) = 2
       then 'PASS' else 'FAIL' end, ''
union all
select 2, 'Only the server role can run the operation; nobody but the owner can run the helper; nothing for public/anon/authenticated',
  case when has_function_privilege('service_role', 'public.academy_save_op_lesson(text,uuid,jsonb,jsonb)', 'EXECUTE')
        and not has_function_privilege('service_role', 'public.academy_save_lesson_links(jsonb)', 'EXECUTE')
        and not exists (select 1 from pg_proc p, unnest(array['anon','authenticated']) r
                         where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_save\_%'
                           and has_function_privilege(r, p.oid, 'EXECUTE'))
        and not exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                         where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_save\_%'
                           and a.grantee = 0 and a.privilege_type = 'EXECUTE')
       then 'PASS' else 'FAIL' end, ''
union all
select 3, 'M1, M2 and M3 untouched: M3 24 functions (fingerprint as installed), M1 19 functions (fingerprint as after M3), M2 15 functions (as approved); guards and triggers unchanged',
  case when (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like 'academy\_author\_%') = 24
        and (select md5(string_agg(p.proname || ':' || pg_get_function_identity_arguments(p.oid) || ':' || p.prosecdef || ':' ||
                        coalesce(array_to_string(p.proconfig, ','), '') || ':' || p.prosrc, '|' order by p.proname))
               from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_author\_%')
            in ('e48e4c2758dae2be0e679c3b9cbe97e8', '9f41ee27d9ea6b271b35ea5ec1a25c7e')
        and (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and (proname like 'academy\_op\_%' or proname = 'academy_audited_guard')) = 19
        and (select md5(string_agg(p.proname || ':' || pg_get_function_identity_arguments(p.oid) || ':' || p.prosecdef || ':' ||
                        coalesce(array_to_string(p.proconfig, ','), '') || ':' || p.prosrc, '|' order by p.proname))
               from pg_proc p where p.pronamespace = 'public'::regnamespace and (p.proname like 'academy\_op\_%' or p.proname = 'academy_audited_guard'))
            in ('2802eaad1697750470f840f4b90d68d9', 'a809004b8fe77dce69cfc555ff984bdb')
        and (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like 'academy\_content\_%') = 15
        and (select md5(string_agg(p.proname || ':' || pg_get_function_identity_arguments(p.oid) || ':' || p.prosecdef || ':' ||
                        coalesce(array_to_string(p.proconfig, ','), '') || ':' || p.prosrc, '|' order by p.proname))
               from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_content\_%')
            in ('f24e4f888c8ed7a4e0765382737dfe35', '794f3c3e007bf3cc6d72b574aac614e3')
        and (select count(*) from pg_trigger where tgname = 'academy_audited_guard' and not tgisinternal) = 6
        and (select count(*) from pg_trigger where tgname in ('academy_content_guard','academy_content_guard_truncate') and not tgisinternal) = 8
        and (select count(*) from pg_trigger where tgname in ('academy_author_guard','academy_author_guard_truncate') and not tgisinternal) = 6
       then 'PASS' else 'FAIL' end, '';

-- ---------- Behaviour (undone at the end) ----------
do $$
declare
  PRES text; NOBODY constant text := 'staff:m31-not-staff@example.com'; MFR constant text := 'golden-technologies';
  v_saved text; ok boolean; v_e0 bigint; v_r0 bigint; v_n int; r jsonb; s text;
  v_c uuid; v_v uuid; v_m uuid; v_l1 uuid; v_l2 uuid; v_q1 uuid; v_q2 uuid; v_qref uuid; v_other uuid; v_blocks jsonb; v_base jsonb;
  FACT constant jsonb := '{"kind":"fact","manufacturer_slug":"golden-technologies","model_code":"m31a","field":"weight_capacity","label":"Capacity"}';
  CMP constant jsonb := '{"kind":"comparison","title":"Side by side","manufacturer_slug":"golden-technologies","models":["M31A","M31B"],"fields":[{"field":"weight_capacity","label":"Capacity"},{"field":"sizes","label":"Sizes"}]}';
  OBJ constant jsonb := '{"kind":"objectives","items":["Explain the first thing","Explain the second thing"]}';
  TXT constant jsonb := '{"kind":"text","heading":"Hello","body":"Plain words."}';
begin
  begin  -- sub-transaction: every write in here is undone at the end
    select 'staff:' || lower(email) into PRES from staff_users
     where coalesce(active, true) and lower(coalesce(role, '')) = 'president' order by email limit 1;
    if PRES is null or not exists (select 1 from manufacturers where slug = MFR) then
      insert into t_m31 values (4, 'Behaviour tests', 'SKIP', 'needs one active HCPS President and Golden in the manufacturer list'); return;
    end if;
    v_c := (academy_content_op_create_course(PRES, null, jsonb_build_object('slug','m3-1-test-course','title','M3.1 test','course_type','hcps_certification','manufacturer_slug',MFR))->>'id')::uuid;
    v_v := (academy_content_op_create_version(PRES, null, v_c, '{"exam_questions":2}')->>'id')::uuid;
    v_m := (academy_content_op_create_module(PRES, null, v_v, '{"title":"Module A"}')->>'id')::uuid;
    v_l1 := (academy_content_op_create_lesson(PRES, null, v_m, '{"title":"Lesson one","est_minutes":12}')->>'id')::uuid;
    v_l2 := (academy_content_op_create_lesson(PRES, null, v_m, '{"title":"Lesson two","est_minutes":12}')->>'id')::uuid;

    -- 4 a save creates the links its screens need, passes the M3 block checker in the same transaction, writes ONE audit row
    select count(*) into v_e0 from academy_events;
    v_blocks := jsonb_build_array(OBJ, FACT, CMP);
    r := academy_save_op_lesson(PRES, v_l1, '[]', v_blocks);
    ok := (r->>'links_added')::int = 4 and (r->>'links_removed')::int = 0
      and (select count(*) from academy_content_refs where lesson_id = v_l1) = 4
      and exists (select 1 from academy_content_refs where lesson_id = v_l1 and model_code = 'M31A' and field = 'weight_capacity')
      and exists (select 1 from academy_content_refs where lesson_id = v_l1 and model_code = 'M31B' and field = 'sizes')
      and (select blocks->1->>'model_code' from academy_lessons where id = v_l1) = 'M31A'
      and (select count(*) from academy_events) = v_e0 + 1
      and exists (select 1 from academy_events where entity = 'academy_lessons' and entity_id = v_l1::text and action = 'save_lesson' and actor = PRES
                    and jsonb_array_length(after->'_links'->'added') = 4 and before->'blocks' = '[]'::jsonb and after->'blocks' = r->'lesson'->'blocks')
      and not exists (select 1 from academy_events where action in ('link_fact','set_blocks') and entity_id in (v_l1::text));
    insert into t_m31 values (4, 'One save: the screens'' 4 fact links are created and satisfy the block checker''s "linked fact" rule in the same transaction; screens saved; exactly one audit row (save_lesson) listing the links',
      case when ok then 'PASS' else 'FAIL' end, coalesce(r::text, ''));

    -- 5 compare-and-set: a save that does not start from the stored content is refused 40001 and writes nothing
    select count(*) into v_e0 from academy_events; select count(*) into v_r0 from academy_content_refs;
    v_n := 0;
    begin perform academy_save_op_lesson(PRES, v_l1, '[]', jsonb_build_array(OBJ, TXT));
    exception when others then if sqlstate = '40001' and sqlerrm like 'academy: changed%' then v_n := 1; end if; end;
    ok := v_n = 1 and (select blocks from academy_lessons where id = v_l1) = (select r->'lesson'->'blocks')
      and (select count(*) from academy_events) = v_e0 and (select count(*) from academy_content_refs) = v_r0;
    insert into t_m31 values (5, 'Conflicting version: a save whose starting content is not the stored content is refused ("changed", 40001); the stored screens, links and history are untouched',
      case when ok then 'PASS' else 'FAIL' end, '');

    -- 6 screens refused by the block checker: the links made for them are gone too, no audit row
    select count(*) into v_e0 from academy_events; select count(*) into v_r0 from academy_content_refs;
    v_base := (select blocks from academy_lessons where id = v_l1); v_n := 0;
    begin perform academy_save_op_lesson(PRES, v_l1, v_base, jsonb_build_array(TXT, OBJ, '{"kind":"fact","manufacturer_slug":"golden-technologies","model_code":"M31NEW","field":"sizes","label":"x"}'::jsonb));
    exception when others then if sqlstate = '22023' and sqlerrm like '%objectives come first%' then v_n := 1; end if; end;
    ok := v_n = 1 and (select blocks from academy_lessons where id = v_l1) = v_base
      and not exists (select 1 from academy_content_refs where model_code = 'M31NEW')
      and (select count(*) from academy_events) = v_e0 and (select count(*) from academy_content_refs) = v_r0;
    insert into t_m31 values (6, 'Refused screens (objectives not first): the new fact link created for them is rolled back with them; no audit row',
      case when ok then 'PASS' else 'FAIL' end, '');

    -- 7 pruning touches only this lesson's own links: never another lesson's, never a question's, never product_facts
    perform academy_save_op_lesson(PRES, v_l2, '[]', jsonb_build_array(OBJ, FACT));                       -- lesson 2 shows the same fact
    v_q1 := (academy_author_op_create_question(PRES, null, v_v, jsonb_build_object('module_id', v_m, 'kind','single','use','practice','prompt','Practice one?',
             'choices','[{"id":"a","text":"A"},{"id":"b","text":"B"}]'::jsonb,'answer_key','a','explanation','x','objective_tags','["t"]'::jsonb))->>'id')::uuid;
    v_q2 := (academy_author_op_create_question(PRES, null, v_v, jsonb_build_object('module_id', v_m, 'kind','single','use','exam','prompt','Exam one?',
             'choices','[{"id":"a","text":"A"},{"id":"b","text":"B"}]'::jsonb,'answer_key','a','explanation','x','objective_tags','["t"]'::jsonb))->>'id')::uuid;
    v_qref := (academy_author_op_link_fact(PRES, null, jsonb_build_object('question_id', v_q2, 'manufacturer_slug', MFR, 'model_code', 'M31A', 'field', 'weight_capacity'))->>'id')::uuid;
    select count(*) into v_r0 from product_facts;
    v_base := (select blocks from academy_lessons where id = v_l1);
    r := academy_save_op_lesson(PRES, v_l1, v_base, jsonb_build_array(OBJ, TXT));                            -- lesson 1 drops every fact
    ok := (r->>'links_removed')::int = 4 and (r->>'links_added')::int = 0
      and not exists (select 1 from academy_content_refs where lesson_id = v_l1)
      and exists (select 1 from academy_content_refs where lesson_id = v_l2 and model_code = 'M31A' and field = 'weight_capacity')
      and exists (select 1 from academy_content_refs where id = v_qref)
      and (select count(*) from product_facts) = v_r0
      and exists (select 1 from academy_events where entity_id = v_l1::text and action = 'save_lesson' and jsonb_array_length(after->'_links'->'removed') = 4);
    insert into t_m31 values (7, 'Removing facts from a lesson removes exactly that lesson''s 4 links; the same fact on another lesson, an exam question''s link and every product fact stay',
      case when ok then 'PASS' else 'FAIL' end, coalesce(r::text, ''));

    -- 8 a check block in the screens uses practice questions only (the unchanged M3 checker), and saving the same content again changes no link
    v_base := (select blocks from academy_lessons where id = v_l1);
    v_other := (academy_author_op_create_question(PRES, null, v_v, jsonb_build_object('module_id', v_m, 'kind','single','use','practice','prompt','Practice two?',
             'choices','[{"id":"a","text":"A"},{"id":"b","text":"B"}]'::jsonb,'answer_key','a','explanation','x','objective_tags','["t"]'::jsonb))->>'id')::uuid;
    v_n := 0;
    begin perform academy_save_op_lesson(PRES, v_l1, v_base, jsonb_build_array(OBJ, jsonb_build_object('kind','check','question_ids', jsonb_build_array(v_q1, v_q2))));
    exception when others then if sqlstate = '22023' and sqlerrm like '%only active practice questions%' then v_n := 1; end if; end;
    r := academy_save_op_lesson(PRES, v_l1, v_base, jsonb_build_array(OBJ, jsonb_build_object('kind','check','question_ids', jsonb_build_array(v_q1, v_other))));
    v_base := r->'lesson'->'blocks'; select count(*) into v_r0 from academy_content_refs;
    r := academy_save_op_lesson(PRES, v_l1, v_base, v_base);
    ok := v_n = 1 and (r->>'links_added')::int = 0 and (r->>'links_removed')::int = 0 and (select count(*) from academy_content_refs) = v_r0;
    insert into t_m31 values (8, 'The M3 block checker still decides (an exam question in a lesson check is refused); saving the same screens again adds and removes nothing',
      case when ok then 'PASS' else 'FAIL' end, '');

    -- 9 only drafts: a version in review refuses (55000), nothing written
    perform academy_content_op_move_version(PRES, v_v, 'in_review');
    select count(*) into v_e0 from academy_events; v_n := 0;
    begin perform academy_save_op_lesson(PRES, v_l1, v_base, jsonb_build_array(OBJ, TXT)); exception when others then if sqlstate = '55000' then v_n := 1; end if; end;
    ok := v_n = 1 and (select blocks from academy_lessons where id = v_l1) = v_base and (select count(*) from academy_events) = v_e0;
    perform academy_content_op_move_version(PRES, v_v, 'draft');
    insert into t_m31 values (9, 'A version in review cannot be saved (locked, 55000) and nothing is written',
      case when ok then 'PASS' else 'FAIL' end, '');

    -- 10 the acting person: not staff / not an administrator / malformed -> 42501; missing base or lesson -> refused; no audit row
    select count(*) into v_e0 from academy_events; ok := true;
    begin perform academy_save_op_lesson(NOBODY, v_l1, v_base, v_base); ok := false; exception when others then ok := ok and sqlstate = '42501'; end;
    begin perform academy_save_op_lesson('angelo', v_l1, v_base, v_base); ok := false; exception when others then ok := ok and sqlstate = '42501'; end;
    begin perform academy_save_op_lesson(PRES, v_l1, null, v_base); ok := false; exception when others then ok := ok and sqlstate = '22023'; end;
    begin perform academy_save_op_lesson(PRES, gen_random_uuid(), '[]', '[]'); ok := false; exception when others then ok := ok and sqlstate = 'P0002'; end;
    begin perform academy_save_op_lesson(PRES, v_l1, v_base, jsonb_build_array(OBJ, '{"kind":"fact","manufacturer_slug":"not-a-maker","model_code":"X1","field":"sizes","label":"x"}'::jsonb));
      ok := false; exception when others then ok := ok and sqlstate = '22023'; end;
    insert into t_m31 values (10, 'Refused without an audit row: an actor who is not an active administrator (42501), no starting content (22023), an unknown lesson (404), a manufacturer outside the HCPS list (22023)',
      case when ok and (select count(*) from academy_events) = v_e0 then 'PASS' else 'FAIL' end, '');

    -- 11 the operation marker never outlives the save; a direct write to fact links is still refused
    perform academy_save_op_lesson(PRES, v_l1, v_base, v_base);                                            -- a successful save, then:
    ok := coalesce(current_setting('academy.op', true), '') = '';
    begin insert into academy_content_refs (version_id, lesson_id, manufacturer_slug, model_code, field) values (v_v, v_l1, MFR, 'M31Z', 'sizes'); ok := false;
    exception when insufficient_privilege then null; end;
    insert into t_m31 values (11, 'After the saves no operation marker is left, and a direct write to fact links is still refused by the M3 guard',
      case when ok then 'PASS' else 'FAIL' end, '');

    -- 12 audit failure: with the audit history refusing writes, the save fails and leaves screens and links as they were
    v_base := (select blocks from academy_lessons where id = v_l1);
    select count(*) into v_e0 from academy_events; select count(*) into v_r0 from academy_content_refs;
    execute 'create function pg_temp.m31_refuse() returns trigger language plpgsql as $f$ begin raise exception ''store unavailable (M3.1 test)''; end $f$';
    execute 'create trigger zz_m31_refuse_audit before insert on academy_events for each row execute function pg_temp.m31_refuse()';
    v_n := 0;
    begin perform academy_save_op_lesson(PRES, v_l1, v_base, jsonb_build_array(OBJ, FACT, CMP)); exception when others then if sqlerrm like '%store unavailable%' then v_n := 1; end if; end;
    execute 'drop trigger zz_m31_refuse_audit on academy_events';
    ok := v_n = 1 and (select blocks from academy_lessons where id = v_l1) = v_base
      and (select count(*) from academy_content_refs) = v_r0 and (select count(*) from academy_events) = v_e0;
    insert into t_m31 values (12, 'All or nothing (audit failure): the audit row cannot be written, so the new links and the new screens are rolled back too',
      case when ok then 'PASS' else 'FAIL' end, '');

    -- 13 interrupted write: the lesson update fails AFTER the links were inserted and checked -> nothing remains
    select count(*) into v_e0 from academy_events; select count(*) into v_r0 from academy_content_refs;
    execute 'create trigger zz_m31_refuse_lesson before update on academy_lessons for each row execute function pg_temp.m31_refuse()';
    v_n := 0;
    begin perform academy_save_op_lesson(PRES, v_l1, v_base, jsonb_build_array(OBJ, FACT, CMP)); exception when others then if sqlerrm like '%store unavailable%' then v_n := 1; end if; end;
    execute 'drop trigger zz_m31_refuse_lesson on academy_lessons';
    ok := v_n = 1 and (select blocks from academy_lessons where id = v_l1) = v_base
      and (select count(*) from academy_content_refs) = v_r0 and (select count(*) from academy_events) = v_e0;
    insert into t_m31 values (13, 'All or nothing (interrupted write): the screens cannot be written after the links were created, and the links are rolled back with them',
      case when ok then 'PASS' else 'FAIL' end, '');

    -- 14 a model code is matched case-insensitively and a link made earlier by M3 link_fact is reused, never duplicated
    perform academy_author_op_link_fact(PRES, null, jsonb_build_object('lesson_id', v_l1, 'manufacturer_slug', MFR, 'model_code', 'm31c', 'field', 'sizes'));
    v_base := (select blocks from academy_lessons where id = v_l1);
    r := academy_save_op_lesson(PRES, v_l1, v_base, jsonb_build_array(OBJ, '{"kind":"fact","manufacturer_slug":"golden-technologies","model_code":"M31c","field":"sizes","label":"Sizes"}'::jsonb));
    ok := (r->>'links_added')::int = 0 and (select count(*) from academy_content_refs where lesson_id = v_l1 and upper(model_code) = 'M31C') = 1;
    insert into t_m31 values (14, 'An existing link (made by M3 link_fact, any letter case) is reused, never duplicated',
      case when ok then 'PASS' else 'FAIL' end, coalesce(r::text, ''));

    -- 15 a lesson link with no field (made by M3 link_fact) is removed when the screens do not show it, as the Stage 3 save did
    perform academy_author_op_link_fact(PRES, null, jsonb_build_object('lesson_id', v_l1, 'manufacturer_slug', MFR, 'model_code', 'M31D'));
    v_base := (select blocks from academy_lessons where id = v_l1);
    r := academy_save_op_lesson(PRES, v_l1, v_base, v_base);
    ok := (r->>'links_removed')::int = 1 and not exists (select 1 from academy_content_refs where lesson_id = v_l1 and model_code = 'M31D');
    insert into t_m31 values (15, 'Links always end up matching the screens: a lesson link the screens do not show (even one without a field) is removed by the next save',
      case when ok then 'PASS' else 'FAIL' end, coalesce(r::text, ''));

    -- 16 the lesson's other columns never change through a save
    ok := (select title from academy_lessons where id = v_l1) = 'Lesson one' and (select est_minutes from academy_lessons where id = v_l1) = 12
      and (select module_id from academy_lessons where id = v_l1) = v_m;
    insert into t_m31 values (16, 'A save changes only the screens: title, minutes, module and position stay',
      case when ok then 'PASS' else 'FAIL' end, '');

    select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)::text into v_saved from t_m31 x where x.n > 3;
    raise exception 'academy_m31_tests_rollback' using detail = v_saved;
  exception when others then
    if sqlerrm <> 'academy_m31_tests_rollback' then raise; end if;  -- any unexpected error stops the run
    get stacked diagnostics v_saved = pg_exception_detail;
  end;
  delete from t_m31 where n > 3;
  insert into t_m31 select * from jsonb_populate_recordset(null::t_m31, v_saved::jsonb);
end $$;

-- Check 17 (not one of the 16 tests): nothing from the behaviour tests remained.
insert into t_m31 select 17, 'Check: every Academy content table, product facts and the audit history hold exactly as many rows as before; every lesson''s screens are byte-identical; no test trigger left',
  case when (select count(*) from academy_courses) = c and (select count(*) from academy_course_versions) = v
        and (select count(*) from academy_modules) = m and (select count(*) from academy_lessons) = l
        and (select count(*) from academy_questions) = q and (select count(*) from academy_media) = md
        and (select count(*) from academy_content_refs) = r and (select count(*) from product_facts) = f
        and (select count(*) from academy_events) = e
        and (select md5(coalesce(string_agg(id::text || ':' || blocks::text, ',' order by id), '')) from academy_lessons) = lb
        and not exists (select 1 from pg_trigger where tgname like 'zz\_m31\_%')
       then 'PASS' else 'FAIL' end, ''
from t_m31_before;

select n as "#", test, result, detail from t_m31 order by n;
