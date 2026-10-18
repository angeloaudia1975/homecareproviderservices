-- =============================================================================================
-- HCPS Academy — A2E / M6: exam attempts with server-enforced limits (DEVELOPMENT; NOT run in production)
--
-- The approved retake policy, enforced by the DATABASE (never the browser), per course version:
--   * one open attempt at a time PER LEARNER, across all their courses (an attempt is open until it is submitted or
--     its deadline passes) — a learner never sits two exams at once;
--   * PER ENROLLMENT (one course version): at least exam_cooldown_minutes (default 60) between the end of one attempt
--     and the start of the next, and at most exam_daily_limit (default 3) attempts started per calendar day,
--     America/Chicago (DST-safe). An attempt in one course never uses up the cooldown or daily attempts of another;
--   * unlimited retakes otherwise.
--   An open attempt has a time limit, exam_time_limit_minutes (default 45 for 25 questions — Angelo's decision I,
--   proposed default). An attempt still open at its deadline EXPIRES: it is graded with the answers saved before the
--   deadline (unanswered = wrong), so an abandoned attempt can never block a learner, and answers sent after the
--   deadline never count.
-- A grading failure is never swallowed: it is recorded on the attempt (grading_failures, grading_failed_at,
-- grading_error), written to the audit trail when it is new or different, raised as a WARNING to the database log and
-- returned to the caller. The attempt stays ungraded and is graded again by the next exam call (the same saved answers,
-- so the same result); meanwhile its enrollment cannot start another attempt (reason grading_pending) and a submit
-- answers ok:false with reason grading_pending — never ok:true without a result.
-- Learners see questions and choices only. Answer keys and explanations never leave the database: questions are read
-- through academy_exam_op_view, and results through M1's grading (score, pass/fail, topics to study).
--
-- Design: new functions only (prefix academy_exam_). M1's academy_op_start_attempt / academy_op_submit_attempt stay
-- byte-identical and are CALLED inside these operations, so every M1/M3 rule (the per-module draw, verified facts,
-- published version, exact-fraction pass mark, single submission) still runs. The server role loses EXECUTE on those
-- two M1 functions and INSERT/UPDATE/DELETE on academy_attempts, so the limits cannot be bypassed.
-- New columns: academy_attempts.learner_id (from the enrollment, by trigger), expires_at, draft_answers,
-- draft_saved_at, expired, grading_failures, grading_failed_at, grading_error; academy_course_versions.exam_time_limit_minutes / exam_cooldown_minutes / exam_daily_limit.
-- Every UPDATE carries a WHERE clause (pg-safeupdate).
-- Run order: after M1–M5. Rollback: academy_a2e_m6_exam_attempts_rollback.sql (refused while any attempt exists).
-- RULE 19: no new table or view. The operations are SECURITY DEFINER with a pinned search path, executable by
-- service_role only; the helpers by the owner only.
-- =============================================================================================
begin;

do $$ begin
  if to_regprocedure('public.academy_op_start_attempt(text,uuid)') is null
     or to_regprocedure('public.academy_op_submit_attempt(text,uuid,jsonb)') is null
     or to_regprocedure('public.academy_author_exam_draw(uuid,boolean)') is null
     or to_regprocedure('public.academy_access_op_request_code(text,text,text)') is null then
    raise exception 'M6 needs M1, M3 and M5 installed first';
  end if;
  if to_regprocedure('public.academy_exam_op_start(text,uuid)') is not null then
    raise exception 'M6 is already installed';
  end if;
  if exists (select 1 from academy_attempts) then
    raise exception 'M6 expects no exam attempts yet (found some). Stop and investigate.';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- COLUMNS
-- ---------------------------------------------------------------------------------------------
alter table public.academy_course_versions
  add column exam_time_limit_minutes int not null default 45 check (exam_time_limit_minutes between 5 and 240),
  add column exam_cooldown_minutes   int not null default 60 check (exam_cooldown_minutes between 0 and 1440),
  add column exam_daily_limit        int not null default 3  check (exam_daily_limit between 1 and 20);

alter table public.academy_attempts
  add column learner_id     uuid references public.academy_learners(id) on delete restrict,
  add column expires_at     timestamptz,
  add column draft_answers  jsonb not null default '{}'::jsonb check (jsonb_typeof(draft_answers) = 'object'),
  add column draft_saved_at timestamptz,
  add column expired        boolean not null default false,
  add column grading_failures  int not null default 0 check (grading_failures >= 0),
  add column grading_failed_at timestamptz,
  add column grading_error     text check (length(grading_error) <= 400);
alter table public.academy_attempts alter column learner_id set not null, alter column expires_at set not null;
alter table public.academy_attempts add constraint academy_attempts_expiry check (expires_at > started_at);
create index academy_attempts_learner_started on public.academy_attempts (learner_id, started_at desc);

-- learner_id and expires_at are set by the database from the enrollment and its version, never by a caller.
create function public.academy_exam_attempt_defaults() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_l uuid; v_min int;
begin
  select e.learner_id, v.exam_time_limit_minutes into v_l, v_min
    from academy_enrollments e join academy_course_versions v on v.id = e.version_id where e.id = new.enrollment_id;
  if tg_op = 'INSERT' then
    new.learner_id := v_l;
    new.expires_at := new.started_at + make_interval(mins => v_min);
  elsif new.learner_id is distinct from old.learner_id or new.expires_at is distinct from old.expires_at
        or new.enrollment_id is distinct from old.enrollment_id or new.started_at is distinct from old.started_at then
    raise exception 'academy: an attempt''s learner, enrollment, start and deadline never change' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger academy_exam_attempt_defaults before insert or update on public.academy_attempts
  for each row execute function public.academy_exam_attempt_defaults();

-- ---------------------------------------------------------------------------------------------
-- HELPERS (owner only)
-- ---------------------------------------------------------------------------------------------
-- The enrollment a learner acts on: theirs, not withdrawn, through access that is still active. Returns it.
create function public.academy_exam_enrollment(p_actor text, p_enrollment_id uuid) returns academy_enrollments
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare v_e academy_enrollments;
begin
  select * into v_e from academy_enrollments where id = p_enrollment_id;
  if not found then raise exception 'academy: enrollment not found' using errcode = 'P0002'; end if;
  perform academy_op_actor_learner(p_actor, v_e.learner_id);
  if v_e.status = 'withdrawn' then raise exception 'academy: the enrollment was withdrawn' using errcode = '22023'; end if;
  if not exists (select 1 from academy_memberships m where m.id = v_e.membership_id and m.status = 'active') then
    raise exception 'academy: your access for this course has ended' using errcode = '42501';
  end if;
  return v_e;
end $$;

-- Saved answers, cleaned: only this attempt's questions; a choice id (a–f) or a list of distinct choice ids.
create function public.academy_exam_clean_answers(p_answers jsonb, p_ids uuid[]) returns jsonb
language plpgsql immutable set search_path = pg_catalog, public, pg_temp as $$
declare k text; v jsonb; out jsonb := '{}'::jsonb;
begin
  if p_answers is null then return out; end if;
  if jsonb_typeof(p_answers) <> 'object' then raise exception 'academy: answers must be an object of question id to answer' using errcode = '22023'; end if;
  if length(p_answers::text) > 20000 then raise exception 'academy: too much answer data' using errcode = '22023'; end if;
  for k, v in select * from jsonb_each(p_answers) loop
    if k !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or not (k::uuid = any (p_ids)) then
      raise exception 'academy: that question is not part of this exam' using errcode = '22023';
    end if;
    if v = 'null'::jsonb then continue; end if;
    if jsonb_typeof(v) = 'string' then
      if (v #>> '{}') !~ '^[a-f]$' then raise exception 'academy: an answer is a choice a–f' using errcode = '22023'; end if;
    elsif jsonb_typeof(v) = 'array' then
      if jsonb_array_length(v) not between 1 and 6
         or exists (select 1 from jsonb_array_elements(v) e where jsonb_typeof(e) <> 'string' or (e #>> '{}') !~ '^[a-f]$')
         or (select count(distinct e) from jsonb_array_elements_text(v) e) <> jsonb_array_length(v) then
        raise exception 'academy: an answer is a list of different choices a–f' using errcode = '22023';
      end if;
    else
      raise exception 'academy: an answer is a choice or a list of choices' using errcode = '22023';
    end if;
    out := out || jsonb_build_object(k, v);
  end loop;
  return out;
end $$;

-- A grade that could not be written: recorded on the attempt (count, time, SQLSTATE: message) and, when the error is
-- new or different from the last one recorded, in the audit trail; always raised as a WARNING to the database log.
-- Returns whether the record was written. Never raises (a failure to record is itself a WARNING), so it cannot hide the
-- original error.
create function public.academy_exam_grading_failed(p_attempt academy_attempts, p_action text, p_actor_type text,
                                                   p_actor text, p_state text, p_msg text) returns boolean
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare v_err text := coalesce(p_state, '?????') || ': ' || left(coalesce(p_msg, ''), 300);
begin
  raise warning 'academy: attempt % could not be graded (%): %', p_attempt.id, p_action, v_err;
  begin
    perform academy_op_begin(p_action, p_actor);
    update academy_attempts set grading_failures = grading_failures + 1, grading_failed_at = now(), grading_error = v_err
     where id = p_attempt.id;
    if p_attempt.grading_error is distinct from v_err then
      perform academy_op_audit(p_actor_type, p_actor, 'academy_attempts', p_attempt.id::text, p_action, null,
        jsonb_build_object('sqlstate', p_state, 'error', left(coalesce(p_msg, ''), 300), 'failures', p_attempt.grading_failures + 1));
    end if;
    perform academy_op_end();
  exception when others then
    raise warning 'academy: the grading failure of attempt % could not be recorded: % %', p_attempt.id, sqlstate, sqlerrm;
    return false;
  end;
  return true;
end $$;

-- Grade every attempt of this learner that is still open past its deadline, with the answers saved before it.
-- Each in its own sub-transaction: one that cannot be graded (e.g. its enrollment was withdrawn) never blocks the rest,
-- and its failure is recorded and returned (academy_exam_grading_failed), never swallowed. Returns
-- {graded, failed: [{attempt_id, sqlstate, recorded}]}.
create function public.academy_exam_expire(p_learner uuid) returns jsonb
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare a academy_attempts; n int := 0; v_failed jsonb := '[]'::jsonb; v_state text; v_msg text;
begin
  for a in select * from academy_attempts where learner_id = p_learner and submitted_at is null and expires_at <= now()
           order by started_at for update loop
    begin
      perform academy_op_submit_attempt('learner:' || p_learner::text, a.id, a.draft_answers);
      perform academy_op_begin('expire_attempt', 'system:exam-clock');
      update academy_attempts set expired = true where id = a.id;
      perform academy_op_audit('system', 'system:exam-clock', 'academy_attempts', a.id::text, 'expire_attempt', null,
        jsonb_build_object('expires_at', a.expires_at, 'answered', (select count(*) from jsonb_object_keys(a.draft_answers)),
                           'earlier_failures', a.grading_failures));
      perform academy_op_end();
      n := n + 1;
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
      v_failed := v_failed || jsonb_build_array(jsonb_build_object('attempt_id', a.id, 'sqlstate', v_state,
        'recorded', academy_exam_grading_failed(a, 'expire_failed', 'system', 'system:exam-clock', v_state, v_msg)));
    end;
  end loop;
  return jsonb_build_object('graded', n, 'failed', v_failed);
end $$;

-- The limits for one enrollment at a moment (the operations pass now()): {can_start, reason, next_at, ...}. Reads only.
create function public.academy_exam_limits(p_learner uuid, p_enrollment academy_enrollments, p_now timestamptz) returns jsonb
language plpgsql stable set search_path = pg_catalog, public, pg_temp as $$
declare v_v academy_course_versions; v_open academy_attempts; v_stuck academy_attempts; v_last timestamptz;
        v_day_start timestamptz; v_today int; v_next_day timestamptz;
begin
  select * into v_v from academy_course_versions where id = p_enrollment.version_id;
  select * into v_open from academy_attempts where learner_id = p_learner and submitted_at is null and expires_at > p_now
   order by started_at desc limit 1;
  if v_open.id is not null then
    return jsonb_build_object('can_start', false, 'reason', 'open_attempt', 'open_attempt_id', v_open.id,
                              'open_enrollment_id', v_open.enrollment_id, 'next_at', v_open.expires_at);
  end if;
  -- an attempt of THIS enrollment past its deadline that could not be graded yet: no new start until it is graded
  select * into v_stuck from academy_attempts where enrollment_id = p_enrollment.id and submitted_at is null
     and expires_at <= p_now and started_at <= p_now order by started_at limit 1;
  if v_stuck.id is not null then
    return jsonb_build_object('can_start', false, 'reason', 'grading_pending', 'pending_attempt_id', v_stuck.id, 'next_at', null);
  end if;
  v_day_start := (date_trunc('day', p_now at time zone 'America/Chicago')) at time zone 'America/Chicago';
  v_next_day := (date_trunc('day', p_now at time zone 'America/Chicago') + interval '1 day') at time zone 'America/Chicago';
  select count(*) into v_today from academy_attempts
   where enrollment_id = p_enrollment.id and started_at >= v_day_start and started_at <= p_now;
  if v_today >= v_v.exam_daily_limit then
    return jsonb_build_object('can_start', false, 'reason', 'daily_limit', 'next_at', v_next_day,
                              'attempts_today', v_today, 'daily_limit', v_v.exam_daily_limit);
  end if;
  select max(least(coalesce(submitted_at, expires_at), expires_at)) into v_last
    from academy_attempts where enrollment_id = p_enrollment.id and started_at <= p_now;
  if v_last is not null and v_last + make_interval(mins => v_v.exam_cooldown_minutes) > p_now then
    return jsonb_build_object('can_start', false, 'reason', 'cooldown',
                              'next_at', v_last + make_interval(mins => v_v.exam_cooldown_minutes),
                              'cooldown_minutes', v_v.exam_cooldown_minutes);
  end if;
  return jsonb_build_object('can_start', true, 'attempts_today', v_today, 'daily_limit', v_v.exam_daily_limit);
end $$;

-- ---------------------------------------------------------------------------------------------
-- OPERATIONS (service_role only). The learner is always "learner:<id>" from the verified Academy session.
-- ---------------------------------------------------------------------------------------------
-- Status for one enrollment: grades expired attempts first, then the limits and the attempt history (results only).
create function public.academy_exam_op_status(p_actor text, p_enrollment_id uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_e academy_enrollments; v_v academy_course_versions;
begin
  v_e := academy_exam_enrollment(p_actor, p_enrollment_id);
  perform pg_advisory_xact_lock(hashtext('academy-exam:' || v_e.learner_id::text));
  perform academy_exam_expire(v_e.learner_id);
  select * into v_v from academy_course_versions where id = v_e.version_id;
  return academy_exam_limits(v_e.learner_id, v_e, now()) || jsonb_build_object(
    'policy', jsonb_build_object('questions', v_v.exam_questions, 'pass_mark', v_v.pass_mark,
               'time_limit_minutes', v_v.exam_time_limit_minutes, 'cooldown_minutes', v_v.exam_cooldown_minutes,
               'daily_limit', v_v.exam_daily_limit, 'version_published', v_v.status = 'published'),
    'attempts', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'started_at', a.started_at,
               'submitted_at', a.submitted_at, 'expires_at', a.expires_at, 'expired', a.expired,
               'score', a.score, 'passed', a.passed, 'open', a.submitted_at is null and a.expires_at > now(),
               'overdue', a.submitted_at is null and a.expires_at <= now(),
               'grading_failed', a.submitted_at is null and a.grading_failures > 0) order by a.started_at desc)
              from academy_attempts a where a.enrollment_id = v_e.id), '[]'::jsonb));
end $$;

-- Start an attempt: one learner at a time (lock), expired attempts graded first, then the limits; the draw itself is
-- M1/M3's (academy_op_start_attempt). A refusal writes nothing and says why and when the next start is allowed.
create function public.academy_exam_op_start(p_actor text, p_enrollment_id uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_e academy_enrollments; v_lim jsonb; v_r jsonb; v_a academy_attempts;
begin
  v_e := academy_exam_enrollment(p_actor, p_enrollment_id);
  perform pg_advisory_xact_lock(hashtext('academy-exam:' || v_e.learner_id::text));
  perform academy_exam_expire(v_e.learner_id);
  v_lim := academy_exam_limits(v_e.learner_id, v_e, now());
  if not (v_lim->>'can_start')::boolean then return jsonb_build_object('ok', false) || v_lim; end if;
  v_r := academy_op_start_attempt(p_actor, p_enrollment_id);
  select * into v_a from academy_attempts where id = (v_r->>'id')::uuid;
  return jsonb_build_object('ok', true, 'attempt_id', v_a.id, 'expires_at', v_a.expires_at,
                            'questions', cardinality(v_a.question_ids));
end $$;

-- What the learner sees during an attempt: questions (prompt, kind, choices: id and text) in drawn order, the answers
-- they saved, the deadline. NEVER an answer key or an explanation. Reads only.
create function public.academy_exam_op_view(p_actor text, p_attempt_id uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_a academy_attempts;
begin
  select * into v_a from academy_attempts where id = p_attempt_id;
  if not found then raise exception 'academy: attempt not found' using errcode = 'P0002'; end if;
  perform academy_exam_enrollment(p_actor, v_a.enrollment_id);
  return jsonb_build_object('attempt_id', v_a.id, 'enrollment_id', v_a.enrollment_id, 'started_at', v_a.started_at,
    'expires_at', v_a.expires_at, 'submitted', v_a.submitted_at is not null, 'open', v_a.submitted_at is null and v_a.expires_at > now(),
    'answers', v_a.draft_answers, 'questions',
    (select jsonb_agg(jsonb_build_object('id', q.id, 'kind', q.kind, 'prompt', q.prompt,
        'choices', (select jsonb_agg(jsonb_build_object('id', c->>'id', 'text', c->>'text')) from jsonb_array_elements(q.choices) c))
        order by o.n)
       from unnest(v_a.question_ids) with ordinality o(id, n) join academy_questions q on q.id = o.id));
end $$;

-- Save answers so far (resume after a dropped connection). Only while the attempt is open and before its deadline.
create function public.academy_exam_op_save(p_actor text, p_attempt_id uuid, p_answers jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_a academy_attempts; v_clean jsonb;
begin
  select * into v_a from academy_attempts where id = p_attempt_id;
  if not found then raise exception 'academy: attempt not found' using errcode = 'P0002'; end if;
  perform academy_exam_enrollment(p_actor, v_a.enrollment_id);
  perform pg_advisory_xact_lock(hashtext('academy-exam:' || v_a.learner_id::text));
  select * into v_a from academy_attempts where id = p_attempt_id for update;
  if v_a.submitted_at is not null then raise exception 'academy: this attempt was already submitted' using errcode = '22023'; end if;
  if v_a.expires_at <= now() then return jsonb_build_object('ok', false, 'reason', 'expired', 'expires_at', v_a.expires_at); end if;
  v_clean := academy_exam_clean_answers(v_a.draft_answers || coalesce(p_answers, '{}'::jsonb), v_a.question_ids);
  perform academy_op_begin('save_answers', p_actor);
  update academy_attempts set draft_answers = v_clean, draft_saved_at = now() where id = p_attempt_id;
  perform academy_op_end();
  return jsonb_build_object('ok', true, 'answered', (select count(*) from jsonb_object_keys(v_clean)), 'expires_at', v_a.expires_at);
end $$;

-- Submit. Before the deadline: the saved answers plus these are graded by M1. After it: only the answers saved
-- before the deadline count (the attempt is graded as expired). Returns score, pass/fail and topics to study only.
-- When the grade cannot be written it says so and keeps the answers: ok:false with reason grading_failed (before the
-- deadline: the answers are saved and the learner may submit again) or grading_pending (after it: graded again by the
-- next exam call). The failure is recorded (academy_exam_grading_failed). Never ok:true without a result.
create function public.academy_exam_op_submit(p_actor text, p_attempt_id uuid, p_answers jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_a academy_attempts; v_r jsonb; v_clean jsonb; v_x jsonb; v_state text; v_msg text; v_rec boolean;
begin
  select * into v_a from academy_attempts where id = p_attempt_id;
  if not found then raise exception 'academy: attempt not found' using errcode = 'P0002'; end if;
  perform academy_exam_enrollment(p_actor, v_a.enrollment_id);
  perform pg_advisory_xact_lock(hashtext('academy-exam:' || v_a.learner_id::text));
  select * into v_a from academy_attempts where id = p_attempt_id for update;
  if v_a.submitted_at is not null then raise exception 'academy: this attempt was already submitted' using errcode = '22023'; end if;
  if v_a.expires_at <= now() then
    v_x := academy_exam_expire(v_a.learner_id);
    select * into v_a from academy_attempts where id = p_attempt_id;
    if v_a.submitted_at is null then
      return jsonb_build_object('ok', false, 'expired', true, 'reason', 'grading_pending', 'attempt_id', v_a.id,
        'recorded', coalesce((select bool_and((f->>'recorded')::boolean) from jsonb_array_elements(v_x->'failed') f
                               where f->>'attempt_id' = p_attempt_id::text), false));
    end if;
    return jsonb_build_object('ok', true, 'expired', true, 'score', v_a.score, 'passed', v_a.passed);
  end if;
  v_clean := academy_exam_clean_answers(v_a.draft_answers || coalesce(p_answers, '{}'::jsonb), v_a.question_ids);
  perform academy_op_begin('save_answers', p_actor);
  update academy_attempts set draft_answers = v_clean, draft_saved_at = now() where id = p_attempt_id;
  perform academy_op_end();
  select * into v_a from academy_attempts where id = p_attempt_id;
  begin
    v_r := academy_op_submit_attempt(p_actor, p_attempt_id, v_clean);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    v_rec := academy_exam_grading_failed(v_a, 'submit_failed', 'learner', p_actor, v_state, v_msg);
    return jsonb_build_object('ok', false, 'expired', false, 'reason', 'grading_failed', 'attempt_id', p_attempt_id,
                              'recorded', v_rec, 'expires_at', v_a.expires_at);
  end;
  return jsonb_build_object('ok', true, 'expired', false) || v_r;
end $$;

-- ---------------------------------------------------------------------------------------------
-- PRIVILEGES
-- ---------------------------------------------------------------------------------------------
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname like 'academy\_exam\_%'
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f.sig);
    if f.proname like 'academy\_exam\_op\_%' then execute format('grant execute on function %s to service_role', f.sig); end if;
  end loop;
end $$;
-- the only way to start or submit an exam is through the limits above
revoke execute on function public.academy_op_start_attempt(text, uuid) from service_role;
revoke execute on function public.academy_op_submit_attempt(text, uuid, jsonb) from service_role;
revoke insert, update, delete, truncate on table public.academy_attempts from service_role;

-- ---------------------------------------------------------------------------------------------
-- INSTALL CHECKS (each must read ok = true)
-- ---------------------------------------------------------------------------------------------
select 'M6 functions' as check, count(*) = 11 as ok from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname like 'academy\_exam\_%'
union all
select 'operations are security definer with a pinned path', bool_and(p.prosecdef and p.proconfig::text like '%search_path=pg_catalog, public, pg_temp%')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'academy\_exam\_op\_%'
union all
select 'server calls the 5 operations and nothing else of M6',
       count(*) filter (where has_function_privilege('service_role', p.oid, 'execute')) = 5
   and count(*) filter (where p.proname not like 'academy\_exam\_op\_%' and has_function_privilege('service_role', p.oid, 'execute')) = 0
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'academy\_exam\_%'
union all
select 'anon and authenticated call nothing of M6', not bool_or(has_function_privilege(r, p.oid, 'execute'))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace, unnest(array['anon','authenticated']) r
 where n.nspname = 'public' and p.proname like 'academy\_exam\_%'
union all
select 'server can no longer start or submit through M1 directly',
       not has_function_privilege('service_role', 'public.academy_op_start_attempt(text,uuid)', 'execute')
   and not has_function_privilege('service_role', 'public.academy_op_submit_attempt(text,uuid,jsonb)', 'execute')
union all
select 'server reads but cannot write attempts', has_table_privilege('service_role', 'public.academy_attempts', 'select')
   and not has_table_privilege('service_role', 'public.academy_attempts', 'insert')
   and not has_table_privilege('service_role', 'public.academy_attempts', 'update')
   and not has_table_privilege('service_role', 'public.academy_attempts', 'delete')
union all
select 'attempt columns, learner index and limits on versions',
       exists (select 1 from pg_attribute where attrelid = 'public.academy_attempts'::regclass and attname = 'learner_id' and attnotnull)
   and to_regclass('public.academy_attempts_learner_started') is not null
   and exists (select 1 from pg_attribute where attrelid = 'public.academy_course_versions'::regclass and attname = 'exam_daily_limit')
union all
select 'no attempts written', not exists (select 1 from academy_attempts);

commit;
