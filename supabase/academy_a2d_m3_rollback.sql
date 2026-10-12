-- =============================================================================================
-- HCPS Academy — A2D migration M3 ROLLBACK                  supabase/academy_a2d_m3_rollback.sql
-- Run ONLY with Angelo's approval, and only after any Command Center code that calls the M3 operations is switched off
-- or reverted (those calls then answer "not installed"). Removing the guard re-opens plain writes to questions, media
-- and fact links, so this is never a reaction to a suspected problem: investigate first (rule 19).
-- What it does, in ONE transaction:
--   1. puts back M1's academy_op_start_attempt exactly as the approved M1 file wrote it (same text, rights and owner);
--   2. drops the publish check, the 6 guard triggers and every public function named academy_author_*;
--   3. drops academy_modules.exam_quota — REFUSED while any module still holds a number (clear the distribution
--      first with academy_author_op_set_exam_distribution(..., '{}'), so no setting is lost silently). A PUBLISHED
--      version's distribution cannot be cleared (it is frozen), so once a version with a distribution is published this
--      rollback can no longer run: rolling back would change how live exams are drawn. That needs its own reviewed plan;
--   4. refuses to finish unless M1 (19 functions, 6 triggers, the original start-attempt text) and M2 (15 functions,
--      8 guard triggers) are intact.
-- Touches no rows: questions, media, fact links, lesson blocks and audit rows all stay.
-- =============================================================================================
begin;
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'academy_modules'
             and column_name = 'exam_quota')
     and exists (select 1 from public.academy_modules where exam_quota is not null) then
    raise exception 'M3 rollback stopped: a module still has an exam distribution number. Clear it first (nothing was removed).';
  end if;
end $$;
-- 1. M1 start-attempt, exactly as in supabase/academy_a2a_m1_audited_ops.sql (only "create" became "create or replace"):
create or replace function public.academy_op_start_attempt(p_actor text, p_enrollment_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_enr academy_enrollments; v_ver academy_course_versions; v_ids uuid[]; v_id uuid;
begin
  select * into v_enr from academy_enrollments where id = p_enrollment_id for update;
  if not found then raise exception 'academy: enrollment not found' using errcode = 'P0002'; end if;
  perform academy_op_actor_learner(p_actor, v_enr.learner_id);
  perform academy_op_begin('start_attempt', p_actor);
  if exists (select 1 from academy_attempts where enrollment_id = p_enrollment_id and submitted_at is null) then
    raise exception 'academy: an exam attempt is already open for this course' using errcode = '22023';
  end if;
  select * into v_ver from academy_course_versions where id = v_enr.version_id;
  v_ids := array(select id from academy_questions
                  where version_id = v_ver.id and use = 'exam' and status = 'active'
                  order by random() limit v_ver.exam_questions);
  perform academy_op_attempt_check(p_enrollment_id, v_ids, 'start');      -- withdrawn, published, count, duplicates
  insert into academy_attempts (enrollment_id, question_ids) values (p_enrollment_id, v_ids) returning id into v_id;
  perform academy_op_audit('learner', p_actor, 'academy_attempts', v_id::text, 'start_attempt', null,
    jsonb_build_object('enrollment_id', p_enrollment_id, 'questions', cardinality(v_ids)));
  perform academy_op_end();
  return jsonb_build_object('id', v_id, 'question_ids', to_jsonb(v_ids));
end $$;
drop trigger if exists academy_author_publish_check on public.academy_course_versions;
drop trigger if exists academy_author_guard on public.academy_questions;
drop trigger if exists academy_author_guard on public.academy_media;
drop trigger if exists academy_author_guard on public.academy_content_refs;
drop trigger if exists academy_author_guard_truncate on public.academy_questions;
drop trigger if exists academy_author_guard_truncate on public.academy_media;
drop trigger if exists academy_author_guard_truncate on public.academy_content_refs;
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname like 'academy\_author\_%' loop
    execute format('drop function %s', f.sig);
  end loop;
end $$;
alter table public.academy_modules drop column if exists exam_quota;
do $$
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname like 'academy\_author\_%')
     or exists (select 1 from pg_trigger where tgname like 'academy\_author\_%') then
    raise exception 'M3 rollback incomplete: an M3 function or trigger remains';
  end if;
  -- the approved M1 text exactly (compared without carriage returns, so a Windows paste of either file is accepted)
  if (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = 'public.academy_op_start_attempt(text,uuid)'::regprocedure)
     <> '9efd2e887095a89aca56ebd08d88cbad' then
    raise exception 'M3 rollback incomplete: start-attempt is not the approved M1 text';
  end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and (p.proname like 'academy\_op\_%' or p.proname = 'academy_audited_guard')) <> 19
     or (select count(*) from pg_trigger where tgname = 'academy_audited_guard' and not tgisinternal) <> 6
     or not has_function_privilege('service_role', 'public.academy_op_start_attempt(text,uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.academy_op_start_attempt(text,uuid)', 'EXECUTE') then
    raise exception 'M3 rollback stopped: M1 is not intact (expected 19 functions, 6 guard triggers, start-attempt server-only). Nothing was removed.';
  end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname like 'academy\_content\_%') <> 15
     or (select count(*) from pg_trigger where tgname in ('academy_content_guard','academy_content_guard_truncate')) <> 8 then
    raise exception 'M3 rollback stopped: M2 is not intact (expected 15 functions and 8 guard triggers). Nothing was removed.';
  end if;
end $$;
commit;
