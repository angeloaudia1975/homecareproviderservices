-- =============================================================================================
-- HCPS Academy — A2C migration M2: ATOMIC CONTENT OPERATIONS     supabase/academy_a2c_m2_content_ops.sql
-- STATUS: proposed for review. Run ONLY after Angelo approves this exact file (preflight, review, approval, SQL editor
-- Run button with the committed file pasted verbatim, sha256 checked). Rollback: supabase/academy_a2c_m2_rollback.sql.
-- Tests: supabase/academy_a2c_m2_acceptance_tests.sql (and test/academy-m2.pg.test.js locally).
--
-- WHY (Angelo, 11 Oct 2026): the Command Center's ordinary content changes — courses, draft versions, modules and
-- lessons — must be saved in the SAME transaction as their audit record: if the change fails, no audit row claims it;
-- if the audit row fails, the change is not saved; direct writes to this content are refused; published and retired
-- content stays protected; the M1 operations stay exactly as they are; the acting person comes from the verified
-- sign-in (the server passes "staff:<email>"; the database checks it names an ACTIVE HCPS administrator).
--
-- Operations (SECURITY DEFINER, pinned search path, executable by the server role only):
--   academy_content_op_create_course (p_actor, p_id, p_course)      academy_content_op_update_course (p_actor, p_id, p_changes)
--   academy_content_op_create_version(p_actor, p_id, p_course_id, p_settings)
--   academy_content_op_update_version(p_actor, p_id, p_changes)    academy_content_op_move_version  (p_actor, p_id, p_to)
--   academy_content_op_create_module (p_actor, p_id, p_version_id, p_module)
--   academy_content_op_update_module (p_actor, p_id, p_changes)    academy_content_op_delete_module (p_actor, p_id)
--   academy_content_op_create_lesson (p_actor, p_id, p_module_id, p_lesson)
--   academy_content_op_update_lesson (p_actor, p_id, p_changes)    academy_content_op_delete_lesson (p_actor, p_id)
-- Internal helpers (owner only): academy_content_actor_president, academy_content_lock_draft, academy_content_keys
-- Guard: academy_content_guard() + trigger academy_content_guard on academy_courses, academy_course_versions,
--   academy_modules, academy_lessons — refuses every insert/update/delete not made by an audited operation (the M1
--   publish/retire operations included: they already run as the owner with the operation marker set).
--
-- Reuses the M1 helpers academy_op_begin / academy_op_end / academy_op_audit / academy_op_actor_staff, which stay
-- owner-only; M1's 19 functions and 6 triggers are NOT changed (their installed-code fingerprint is unchanged — the
-- M2 names do not match 'academy\_op\_%'). Changes NOTHING outside the Academy: reads staff_users, writes neither it nor
-- any other HCPS table. Every UPDATE / DELETE carries a WHERE clause (pg-safeupdate). Runs as ONE transaction.
-- Every operation reads its row again under the version lock and must change exactly one row before the audit row is
--   written; if the row is gone, nothing is saved and nothing is recorded.
-- Errors: 42501 not allowed · P0002 not found · 22023 invalid input · 55000 locked (in review, published or retired,
--   or a module that still has lessons) · 23505 duplicate (a short name already used).
-- Not covered (later units): exam questions, lesson blocks, content links, media (C2); course-level publishing (C2).
-- =============================================================================================
begin;

do $$
begin
  if to_regprocedure('public.academy_op_begin(text,text)') is null or to_regprocedure('public.academy_audited_guard()') is null then
    raise exception 'M1 (audited operations) is not installed. Stop and investigate.';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname like 'academy\_content\_%') then
    raise exception 'M2 content operations already exist. Stop and investigate; do not re-run.';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- INTERNAL HELPERS (owner only)
-- ---------------------------------------------------------------------------------------------
-- The President: "staff:<email>" of an ACTIVE staff user whose role is president.
create function public.academy_content_actor_president(p_actor text) returns void
language plpgsql stable set search_path = pg_catalog, public, pg_temp as $$
declare v_email text;
begin
  v_email := academy_op_actor_staff(p_actor);
  if not exists (select 1 from staff_users s where lower(s.email) = v_email and coalesce(s.active, true)
                   and lower(coalesce(s.role, '')) = 'president') then
    raise exception 'academy: only the President may change a course learners have seen' using errcode = '42501';
  end if;
end $$;

-- Locks a course version for the rest of the transaction and returns it; refused unless it is still a draft.
create function public.academy_content_lock_draft(p_version_id uuid) returns academy_course_versions
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare v academy_course_versions;
begin
  select * into v from academy_course_versions where id = p_version_id for update;
  if not found then raise exception 'academy: course version not found' using errcode = 'P0002'; end if;
  if v.status = 'in_review' then
    raise exception 'academy: this version is in review; return it to draft before editing' using errcode = '55000';
  elsif v.status <> 'draft' then
    raise exception 'academy: this version is % and can no longer change; create a new version instead', v.status using errcode = '55000';
  end if;
  return v;
end $$;

-- Refuses any key outside the allowed list (a change can never smuggle in a status, an id or a position).
create function public.academy_content_keys(p jsonb, p_allowed text[]) returns void
language plpgsql immutable set search_path = pg_catalog, public, pg_temp as $$
declare k text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'academy: the change must be an object' using errcode = '22023'; end if;
  for k in select jsonb_object_keys(p) loop
    if not (k = any (p_allowed)) then raise exception 'academy: % cannot be set here', k using errcode = '22023'; end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------
-- GUARD: content changes only through an audited operation
-- ---------------------------------------------------------------------------------------------
create function public.academy_content_guard() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if coalesce(current_setting('academy.op', true), '') <> ''
     and current_user = (select pg_get_userbyid(p.proowner) from pg_proc p
                          where p.oid = 'public.academy_content_guard()'::regprocedure) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  raise exception 'academy: % changes must go through the Academy Command Center (audited operations)', tg_table_name
    using errcode = '42501';
end $$;

create trigger academy_content_guard before insert or update or delete on public.academy_courses
  for each row execute function public.academy_content_guard();
create trigger academy_content_guard before insert or update or delete on public.academy_course_versions
  for each row execute function public.academy_content_guard();
create trigger academy_content_guard before insert or update or delete on public.academy_modules
  for each row execute function public.academy_content_guard();
create trigger academy_content_guard before insert or update or delete on public.academy_lessons
  for each row execute function public.academy_content_guard();

-- ---------------------------------------------------------------------------------------------
-- COURSES
-- ---------------------------------------------------------------------------------------------
create function public.academy_content_op_create_course(p_actor text, p_id uuid, p_course jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_slug text; v_title text; v_type text; v_mfr text; v_cat text; v_url text; v_new jsonb;
begin
  perform academy_op_actor_staff(p_actor);
  perform academy_op_begin('create_course', p_actor);
  perform academy_content_keys(p_course, array['slug','title','course_type','manufacturer_slug','category','external_url']);
  v_slug := lower(trim(coalesce(p_course->>'slug', '')));
  if v_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or length(v_slug) not between 3 and 80 then
    raise exception 'academy: the short name may use lowercase letters, numbers and single hyphens (3–80)' using errcode = '22023';
  end if;
  v_title := trim(coalesce(p_course->>'title', ''));
  if v_title = '' or length(v_title) > 200 then raise exception 'academy: the title is required (up to 200 characters)' using errcode = '22023'; end if;
  v_type := p_course->>'course_type';
  if v_type is null or v_type not in ('hcps_certification','manufacturer_program','training') then
    raise exception 'academy: the course type is not valid' using errcode = '22023';
  end if;
  v_mfr := nullif(trim(coalesce(p_course->>'manufacturer_slug', '')), '');
  if v_mfr is not null and not exists (select 1 from manufacturers where slug = v_mfr) then
    raise exception 'academy: that manufacturer is not in the HCPS manufacturer list' using errcode = '22023';
  end if;
  v_cat := nullif(trim(coalesce(p_course->>'category', '')), '');
  if length(v_cat) > 80 then raise exception 'academy: the category is too long' using errcode = '22023'; end if;
  v_url := nullif(trim(coalesce(p_course->>'external_url', '')), '');
  if v_type = 'manufacturer_program' then
    if v_mfr is null then raise exception 'academy: a manufacturer program needs its manufacturer' using errcode = '22023'; end if;
    if v_url is null or v_url !~ '^https://[^/[:space:]]+\.[^/[:space:]]+' or length(v_url) > 1000 then
      raise exception 'academy: a manufacturer program needs an https:// training link' using errcode = '22023';
    end if;
  elsif v_url is not null then
    raise exception 'academy: only a manufacturer program links to outside training' using errcode = '22023';
  end if;
  insert into academy_courses (id, slug, manufacturer_slug, title, course_type, issuer, category, external_url, status)
  values (coalesce(p_id, gen_random_uuid()), v_slug, v_mfr, v_title, v_type,
          case v_type when 'hcps_certification' then 'hcps' when 'manufacturer_program' then 'manufacturer' else 'none' end,  -- the issuer follows the type
          v_cat, v_url, 'draft')
  returning to_jsonb(academy_courses.*) into v_new;
  perform academy_op_audit('staff', p_actor, 'academy_courses', v_new->>'id', 'create_course', null, v_new);
  perform academy_op_end();
  return v_new;
end $$;

create function public.academy_content_op_update_course(p_actor text, p_id uuid, p_changes jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_old academy_courses; v_new jsonb; v_title text; v_cat text; v_url text;
begin
  perform academy_op_actor_staff(p_actor);
  perform academy_op_begin('update_course', p_actor);
  perform academy_content_keys(p_changes, array['title','category','external_url']);
  if p_changes = '{}'::jsonb then raise exception 'academy: nothing to change' using errcode = '22023'; end if;
  select * into v_old from academy_courses where id = p_id for update;
  if not found then raise exception 'academy: course not found' using errcode = 'P0002'; end if;
  -- a course learners have seen (not a draft, or with a published / retired version) changes only with the President
  if v_old.status <> 'draft' or exists (select 1 from academy_course_versions where course_id = p_id and status in ('published','retired')) then
    perform academy_content_actor_president(p_actor);
  end if;
  v_title := v_old.title; v_cat := v_old.category; v_url := v_old.external_url;
  if p_changes ? 'title' then
    v_title := trim(coalesce(p_changes->>'title', ''));
    if v_title = '' or length(v_title) > 200 then raise exception 'academy: the title is required (up to 200 characters)' using errcode = '22023'; end if;
  end if;
  if p_changes ? 'category' then
    v_cat := nullif(trim(coalesce(p_changes->>'category', '')), '');
    if length(v_cat) > 80 then raise exception 'academy: the category is too long' using errcode = '22023'; end if;
  end if;
  if p_changes ? 'external_url' then
    if v_old.course_type <> 'manufacturer_program' then
      raise exception 'academy: only a manufacturer program links to outside training' using errcode = '22023';
    end if;
    v_url := nullif(trim(coalesce(p_changes->>'external_url', '')), '');
    if v_url is null or v_url !~ '^https://[^/[:space:]]+\.[^/[:space:]]+' or length(v_url) > 1000 then
      raise exception 'academy: a manufacturer program needs an https:// training link' using errcode = '22023';
    end if;
  end if;
  update academy_courses set title = v_title, category = v_cat, external_url = v_url where id = p_id
  returning to_jsonb(academy_courses.*) into strict v_new;  -- exactly one row changed, or nothing is saved
  perform academy_op_audit('staff', p_actor, 'academy_courses', p_id::text, 'update_course', to_jsonb(v_old), v_new);
  perform academy_op_end();
  return v_new;
end $$;

-- ---------------------------------------------------------------------------------------------
-- VERSIONS (drafts; publishing and retiring stay with the M1 operations)
-- ---------------------------------------------------------------------------------------------
create function public.academy_content_op_create_version(p_actor text, p_id uuid, p_course_id uuid, p_settings jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_course academy_courses; v_next int; v_pass int; v_q int; v_valid int; v_new jsonb;
begin
  perform academy_op_actor_staff(p_actor);
  perform academy_op_begin('create_version', p_actor);
  perform academy_content_keys(coalesce(p_settings, '{}'::jsonb), array['pass_mark','exam_questions','validity_months']);
  select * into v_course from academy_courses where id = p_course_id for update;   -- one new version at a time per course
  if not found then raise exception 'academy: course not found' using errcode = 'P0002'; end if;
  if v_course.course_type = 'manufacturer_program' then
    raise exception 'academy: a manufacturer program is taught and examined by the manufacturer; it has no HCPS versions' using errcode = '22023';
  end if;
  if v_course.status = 'retired' then raise exception 'academy: this course is retired' using errcode = '55000'; end if;
  v_pass := coalesce((p_settings->>'pass_mark')::int, 80);
  v_q := coalesce((p_settings->>'exam_questions')::int, 25);
  v_valid := (p_settings->>'validity_months')::int;
  if v_pass not between 1 and 100 then raise exception 'academy: the pass mark must be 1–100' using errcode = '22023'; end if;
  if v_q not between 1 and 200 then raise exception 'academy: exam questions must be 1–200' using errcode = '22023'; end if;
  if v_valid is not null and v_valid not between 1 and 120 then raise exception 'academy: validity must be 1–120 months' using errcode = '22023'; end if;
  select coalesce(max(version), 0) + 1 into v_next from academy_course_versions where course_id = p_course_id;
  insert into academy_course_versions (id, course_id, version, status, pass_mark, exam_questions, validity_months)
  values (coalesce(p_id, gen_random_uuid()), p_course_id, v_next, 'draft', v_pass, v_q, v_valid)
  returning to_jsonb(academy_course_versions.*) into v_new;
  perform academy_op_audit('staff', p_actor, 'academy_course_versions', v_new->>'id', 'create_version', null, v_new);
  perform academy_op_end();
  return v_new;
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception 'academy: version settings must be whole numbers' using errcode = '22023';
end $$;

create function public.academy_content_op_update_version(p_actor text, p_id uuid, p_changes jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_old academy_course_versions; v_new jsonb; v_pass int; v_q int; v_valid int;
begin
  perform academy_op_actor_staff(p_actor);
  perform academy_op_begin('update_version', p_actor);
  perform academy_content_keys(p_changes, array['pass_mark','exam_questions','validity_months']);
  if p_changes = '{}'::jsonb then raise exception 'academy: nothing to change' using errcode = '22023'; end if;
  v_old := academy_content_lock_draft(p_id);
  v_pass := case when p_changes ? 'pass_mark' then (p_changes->>'pass_mark')::int else v_old.pass_mark end;
  v_q := case when p_changes ? 'exam_questions' then (p_changes->>'exam_questions')::int else v_old.exam_questions end;
  v_valid := case when p_changes ? 'validity_months' then (p_changes->>'validity_months')::int else v_old.validity_months end;
  if v_pass is null or v_pass not between 1 and 100 then raise exception 'academy: the pass mark must be 1–100' using errcode = '22023'; end if;
  if v_q is null or v_q not between 1 and 200 then raise exception 'academy: exam questions must be 1–200' using errcode = '22023'; end if;
  if v_valid is not null and v_valid not between 1 and 120 then raise exception 'academy: validity must be 1–120 months' using errcode = '22023'; end if;
  update academy_course_versions set pass_mark = v_pass, exam_questions = v_q, validity_months = v_valid
   where id = p_id and status = 'draft' returning to_jsonb(academy_course_versions.*) into strict v_new;  -- exactly one row changed, or nothing is saved
  perform academy_op_audit('staff', p_actor, 'academy_course_versions', p_id::text, 'update_version', to_jsonb(v_old), v_new);
  perform academy_op_end();
  return v_new;
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception 'academy: version settings must be whole numbers' using errcode = '22023';
end $$;

-- draft -> in_review (submit for review) or in_review -> draft (return to draft). Nothing else.
create function public.academy_content_op_move_version(p_actor text, p_id uuid, p_to text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_old academy_course_versions; v_new jsonb; v_from text;
begin
  perform academy_op_actor_staff(p_actor);
  perform academy_op_begin('move_version', p_actor);
  if p_to is null or p_to not in ('in_review','draft') then raise exception 'academy: a version can only move to review or back to draft' using errcode = '22023'; end if;
  v_from := case p_to when 'in_review' then 'draft' else 'in_review' end;
  select * into v_old from academy_course_versions where id = p_id for update;
  if not found then raise exception 'academy: course version not found' using errcode = 'P0002'; end if;
  if v_old.status <> v_from then raise exception 'academy: this version is %', v_old.status using errcode = '55000'; end if;
  update academy_course_versions set status = p_to where id = p_id and status = v_from
  returning to_jsonb(academy_course_versions.*) into strict v_new;  -- exactly one row changed, or nothing is saved
  perform academy_op_audit('staff', p_actor, 'academy_course_versions', p_id::text,
    case p_to when 'in_review' then 'submit_for_review' else 'return_to_draft' end, to_jsonb(v_old), v_new);
  perform academy_op_end();
  return v_new;
end $$;

-- ---------------------------------------------------------------------------------------------
-- MODULES AND LESSONS (draft versions only)
-- ---------------------------------------------------------------------------------------------
create function public.academy_content_op_create_module(p_actor text, p_id uuid, p_version_id uuid, p_module jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_title text; v_obj jsonb; v_pos int; v_new jsonb;
begin
  perform academy_op_actor_staff(p_actor);
  perform academy_op_begin('create_module', p_actor);
  perform academy_content_keys(p_module, array['title','objectives']);
  perform academy_content_lock_draft(p_version_id);
  v_title := trim(coalesce(p_module->>'title', ''));
  if v_title = '' or length(v_title) > 200 then raise exception 'academy: the module title is required (up to 200 characters)' using errcode = '22023'; end if;
  v_obj := coalesce(p_module->'objectives', '[]'::jsonb);
  if jsonb_typeof(v_obj) <> 'array' or jsonb_array_length(v_obj) > 12
     or exists (select 1 from jsonb_array_elements(v_obj) e where jsonb_typeof(e) <> 'string' or length(trim(e #>> '{}')) not between 1 and 300) then
    raise exception 'academy: objectives are up to 12 lines of up to 300 characters' using errcode = '22023';
  end if;
  select coalesce(max(position), 0) + 1 into v_pos from academy_modules where version_id = p_version_id;
  insert into academy_modules (id, version_id, position, title, objectives)
  values (coalesce(p_id, gen_random_uuid()), p_version_id, v_pos, v_title, v_obj)
  returning to_jsonb(academy_modules.*) into v_new;
  perform academy_op_audit('staff', p_actor, 'academy_modules', v_new->>'id', 'create_module', null, v_new);
  perform academy_op_end();
  return v_new;
end $$;

create function public.academy_content_op_update_module(p_actor text, p_id uuid, p_changes jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_old academy_modules; v_new jsonb; v_title text; v_obj jsonb;
begin
  perform academy_op_actor_staff(p_actor);
  perform academy_op_begin('update_module', p_actor);
  perform academy_content_keys(p_changes, array['title','objectives']);
  if p_changes = '{}'::jsonb then raise exception 'academy: nothing to change' using errcode = '22023'; end if;
  select * into v_old from academy_modules where id = p_id;
  if not found then raise exception 'academy: module not found' using errcode = 'P0002'; end if;
  perform academy_content_lock_draft(v_old.version_id);
  select * into v_old from academy_modules where id = p_id for update;      -- read again under the version lock
  if not found then raise exception 'academy: module not found' using errcode = 'P0002'; end if;
  v_title := v_old.title; v_obj := v_old.objectives;
  if p_changes ? 'title' then
    v_title := trim(coalesce(p_changes->>'title', ''));
    if v_title = '' or length(v_title) > 200 then raise exception 'academy: the module title is required (up to 200 characters)' using errcode = '22023'; end if;
  end if;
  if p_changes ? 'objectives' then
    v_obj := coalesce(p_changes->'objectives', '[]'::jsonb);
    if jsonb_typeof(v_obj) <> 'array' or jsonb_array_length(v_obj) > 12
       or exists (select 1 from jsonb_array_elements(v_obj) e where jsonb_typeof(e) <> 'string' or length(trim(e #>> '{}')) not between 1 and 300) then
      raise exception 'academy: objectives are up to 12 lines of up to 300 characters' using errcode = '22023';
    end if;
  end if;
  update academy_modules set title = v_title, objectives = v_obj where id = p_id returning to_jsonb(academy_modules.*) into strict v_new;  -- exactly one row changed, or nothing is saved
  perform academy_op_audit('staff', p_actor, 'academy_modules', p_id::text, 'update_module', to_jsonb(v_old), v_new);
  perform academy_op_end();
  return v_new;
end $$;

create function public.academy_content_op_delete_module(p_actor text, p_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_old academy_modules;
begin
  perform academy_op_actor_staff(p_actor);
  perform academy_op_begin('delete_module', p_actor);
  select * into v_old from academy_modules where id = p_id;
  if not found then raise exception 'academy: module not found' using errcode = 'P0002'; end if;
  perform academy_content_lock_draft(v_old.version_id);
  select * into v_old from academy_modules where id = p_id for update;      -- read again under the version lock
  if not found then raise exception 'academy: module not found' using errcode = 'P0002'; end if;
  if exists (select 1 from academy_lessons where module_id = p_id) then
    raise exception 'academy: remove this module''s lessons first' using errcode = '55000';
  end if;
  if exists (select 1 from academy_questions where module_id = p_id) then
    raise exception 'academy: questions are linked to this module' using errcode = '55000';
  end if;
  delete from academy_modules where id = p_id;
  if not found then raise exception 'academy: nothing was deleted' using errcode = 'P0002'; end if;
  perform academy_op_audit('staff', p_actor, 'academy_modules', p_id::text, 'delete_module', to_jsonb(v_old), null);
  perform academy_op_end();
  return jsonb_build_object('deleted', p_id);
end $$;

create function public.academy_content_op_create_lesson(p_actor text, p_id uuid, p_module_id uuid, p_lesson jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_mod academy_modules; v_title text; v_min int; v_pos int; v_new jsonb;
begin
  perform academy_op_actor_staff(p_actor);
  perform academy_op_begin('create_lesson', p_actor);
  perform academy_content_keys(p_lesson, array['title','est_minutes']);
  select * into v_mod from academy_modules where id = p_module_id;
  if not found then raise exception 'academy: module not found' using errcode = 'P0002'; end if;
  perform academy_content_lock_draft(v_mod.version_id);
  perform 1 from academy_modules where id = p_module_id for update;         -- still there under the version lock
  if not found then raise exception 'academy: module not found' using errcode = 'P0002'; end if;
  v_title := trim(coalesce(p_lesson->>'title', ''));
  if v_title = '' or length(v_title) > 200 then raise exception 'academy: the lesson title is required (up to 200 characters)' using errcode = '22023'; end if;
  v_min := coalesce((p_lesson->>'est_minutes')::int, 10);
  if v_min not between 1 and 30 then raise exception 'academy: a lesson is 1–30 minutes' using errcode = '22023'; end if;
  select coalesce(max(position), 0) + 1 into v_pos from academy_lessons where module_id = p_module_id;
  insert into academy_lessons (id, module_id, position, title, est_minutes)
  values (coalesce(p_id, gen_random_uuid()), p_module_id, v_pos, v_title, v_min)
  returning to_jsonb(academy_lessons.*) into v_new;
  perform academy_op_audit('staff', p_actor, 'academy_lessons', v_new->>'id', 'create_lesson', null, v_new);
  perform academy_op_end();
  return v_new;
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception 'academy: minutes must be a whole number' using errcode = '22023';
end $$;

create function public.academy_content_op_update_lesson(p_actor text, p_id uuid, p_changes jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_old academy_lessons; v_ver uuid; v_new jsonb; v_title text; v_min int;
begin
  perform academy_op_actor_staff(p_actor);
  perform academy_op_begin('update_lesson', p_actor);
  perform academy_content_keys(p_changes, array['title','est_minutes']);
  if p_changes = '{}'::jsonb then raise exception 'academy: nothing to change' using errcode = '22023'; end if;
  select m.version_id into v_ver from academy_lessons l join academy_modules m on m.id = l.module_id where l.id = p_id;
  if v_ver is null then raise exception 'academy: lesson not found' using errcode = 'P0002'; end if;
  perform academy_content_lock_draft(v_ver);
  select * into v_old from academy_lessons where id = p_id for update;      -- read again under the version lock
  if not found then raise exception 'academy: lesson not found' using errcode = 'P0002'; end if;
  v_title := v_old.title; v_min := v_old.est_minutes;
  if p_changes ? 'title' then
    v_title := trim(coalesce(p_changes->>'title', ''));
    if v_title = '' or length(v_title) > 200 then raise exception 'academy: the lesson title is required (up to 200 characters)' using errcode = '22023'; end if;
  end if;
  if p_changes ? 'est_minutes' then
    v_min := (p_changes->>'est_minutes')::int;
    if v_min is null or v_min not between 1 and 30 then raise exception 'academy: a lesson is 1–30 minutes' using errcode = '22023'; end if;
  end if;
  update academy_lessons set title = v_title, est_minutes = v_min where id = p_id returning to_jsonb(academy_lessons.*) into strict v_new;  -- exactly one row changed, or nothing is saved
  perform academy_op_audit('staff', p_actor, 'academy_lessons', p_id::text, 'update_lesson', to_jsonb(v_old), v_new);
  perform academy_op_end();
  return v_new;
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception 'academy: minutes must be a whole number' using errcode = '22023';
end $$;

create function public.academy_content_op_delete_lesson(p_actor text, p_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_old academy_lessons; v_ver uuid;
begin
  perform academy_op_actor_staff(p_actor);
  perform academy_op_begin('delete_lesson', p_actor);
  select m.version_id into v_ver from academy_lessons l join academy_modules m on m.id = l.module_id where l.id = p_id;
  if v_ver is null then raise exception 'academy: lesson not found' using errcode = 'P0002'; end if;
  perform academy_content_lock_draft(v_ver);
  select * into v_old from academy_lessons where id = p_id for update;      -- read again under the version lock
  if not found then raise exception 'academy: lesson not found' using errcode = 'P0002'; end if;
  delete from academy_lessons where id = p_id;
  if not found then raise exception 'academy: nothing was deleted' using errcode = 'P0002'; end if;
  perform academy_op_audit('staff', p_actor, 'academy_lessons', p_id::text, 'delete_lesson', to_jsonb(v_old), null);
  perform academy_op_end();
  return jsonb_build_object('deleted', p_id);
end $$;

-- ---------------------------------------------------------------------------------------------
-- PRIVILEGES (rule 19): the 11 operations — server role only. The 3 helpers and the guard — owner only.
-- ---------------------------------------------------------------------------------------------
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname like 'academy\_content\_%' loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f.sig);
    if f.proname like 'academy\_content\_op\_%' then
      execute format('grant execute on function %s to service_role', f.sig);
    end if;
  end loop;
end $$;

commit;
