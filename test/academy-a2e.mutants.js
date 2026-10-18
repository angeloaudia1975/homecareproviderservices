/* HCPS Academy A2E — mutation tests. Each mutant breaks ONE rule (in the M6 SQL or the exam server code) in a scratch
   copy of the working tree; the A2E suites must then fail. A clean control run must pass first, and the CONTROL mutant
   (a comment only) must survive. Needs a local Postgres (same env as the .pg tests).
     PGHOST=127.0.0.1 PGUSER=postgres PGPASSWORD=… node test/academy-a2e.mutants.js [from] [to] */
const { spawnSync, execSync } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');
const ROOT = path.join(__dirname, '..');
const SQL = 'supabase/academy_a2e_m6_exam_attempts.sql', LRN = 'netlify/functions/_academy_learner.js', ADM = 'netlify/functions/academy-admin-api.js';
const MUTANTS = [
  { f: SQL, control: true, from: '-- Save answers so far', to: '-- Save answers so far (control)', why: 'CONTROL: a comment only' },
  { f: SQL, from: "  v_e := academy_exam_enrollment(p_actor, p_enrollment_id);\n  perform pg_advisory_xact_lock(hashtext('academy-exam:' || v_e.learner_id::text));\n  perform academy_exam_expire(v_e.learner_id);\n  v_lim", to: "  v_e := academy_exam_enrollment(p_actor, p_enrollment_id);\n  perform academy_exam_expire(v_e.learner_id);\n  v_lim", why: 'simultaneous starts (no per-learner lock)' },
  { f: SQL, from: "  if v_last is not null and v_last + make_interval(mins => v_v.exam_cooldown_minutes) > p_now then", to: "  if false then", why: 'no cooldown' },
  { f: SQL, from: "  if v_today >= v_v.exam_daily_limit then", to: "  if false then", why: 'no daily limit' },
  { f: SQL, from: "  v_day_start := (date_trunc('day', p_now at time zone 'America/Chicago')) at time zone 'America/Chicago';", to: "  v_day_start := date_trunc('day', p_now at time zone 'UTC') at time zone 'UTC';", why: 'the day is UTC, not Central' },
  { f: SQL, from: "  v_next_day := (date_trunc('day', p_now at time zone 'America/Chicago') + interval '1 day') at time zone 'America/Chicago';", to: "  v_next_day := date_trunc('day', p_now at time zone 'America/Chicago') at time zone 'America/Chicago' + interval '24 hours';", why: 'next day = +24 h (wrong across daylight saving)' },
  { f: SQL, from: "  if v_open.id is not null then", to: "  if false then", why: 'a second open attempt' },
  { f: SQL, from: "    v_x := academy_exam_expire(v_a.learner_id);\n    select * into v_a from academy_attempts where id = p_attempt_id;", to: "    perform academy_op_submit_attempt(p_actor, p_attempt_id, coalesce(p_answers, '{}'::jsonb));\n    select * into v_a from academy_attempts where id = p_attempt_id;", why: 'answers sent after the deadline count' },
  { f: SQL, from: "  if v_a.expires_at <= now() then return jsonb_build_object('ok', false, 'reason', 'expired', 'expires_at', v_a.expires_at); end if;", to: "", why: 'saving after the deadline' },
  { f: SQL, from: "    if k !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or not (k::uuid = any (p_ids)) then", to: "    if k !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then", why: 'answers for questions not in the exam' },
  { f: SQL, from: "    (select jsonb_agg(jsonb_build_object('id', q.id, 'kind', q.kind, 'prompt', q.prompt,", to: "    (select jsonb_agg(jsonb_build_object('id', q.id, 'kind', q.kind, 'prompt', q.prompt, 'answer_key', q.answer_key,", why: 'the answer key in the exam view' },
  { f: SQL, from: "  if not found then raise exception 'academy: attempt not found' using errcode = 'P0002'; end if;\n  perform academy_exam_enrollment(p_actor, v_a.enrollment_id);\n  return jsonb_build_object('attempt_id'", to: "  if not found then raise exception 'academy: attempt not found' using errcode = 'P0002'; end if;\n  return jsonb_build_object('attempt_id'", why: 'anyone opens anyone’s exam' },
  { f: SQL, from: "revoke execute on function public.academy_op_start_attempt(text, uuid) from service_role;", to: "", why: 'the server starts attempts around the limits' },
  { f: SQL, from: "revoke insert, update, delete, truncate on table public.academy_attempts from service_role;", to: "", why: 'the server writes attempts directly' },
  { f: SQL, from: "  elsif new.learner_id is distinct from old.learner_id or new.expires_at is distinct from old.expires_at", to: "  elsif new.learner_id is distinct from old.learner_id", why: 'the deadline can be moved' },
  { f: SQL, from: "  if not exists (select 1 from academy_memberships m where m.id = v_e.membership_id and m.status = 'active') then\n    raise exception 'academy: your access for this course has ended'", to: "  if false then\n    raise exception 'academy: your access for this course has ended'", why: 'ended access still takes the exam' },
  { f: SQL, from: "  select max(least(coalesce(submitted_at, expires_at), expires_at)) into v_last", to: "  select max(coalesce(submitted_at, expires_at)) into v_last", why: 'an expired attempt’s cooldown runs from grading, not its deadline' },
  { f: SQL, from: "      perform academy_op_submit_attempt('learner:' || p_learner::text, a.id, a.draft_answers);", to: "      perform academy_op_submit_attempt('learner:' || p_learner::text, a.id, '{}'::jsonb);", why: 'an expired attempt loses its saved answers' },
  // review items 2–4 (grading failures, ungraded submits, per-learner vs per-enrollment limits)
  { f: SQL, from: "      v_failed := v_failed || jsonb_build_array(jsonb_build_object('attempt_id', a.id, 'sqlstate', v_state,\n        'recorded', academy_exam_grading_failed(a, 'expire_failed', 'system', 'system:exam-clock', v_state, v_msg)));", to: "      null;", why: 'an expiry failure is swallowed (not recorded, not returned)' },
  { f: SQL, from: "    if p_attempt.grading_error is distinct from v_err then", to: "    if false then", why: 'a grading failure leaves no audit row' },
  { f: SQL, from: "    if p_attempt.grading_error is distinct from v_err then", to: "    if true then", why: 'the same grading failure is audited on every retry' },
  { f: SQL, from: "    raise warning 'academy: the grading failure of attempt % could not be recorded: % %', p_attempt.id, sqlstate, sqlerrm;\n    return false;", to: "    raise;", why: 'a failure to record hides the call’s answer' },
  { f: SQL, from: "  raise warning 'academy: attempt % could not be graded (%): %', p_attempt.id, p_action, v_err;\n", to: "", why: 'no WARNING in the database log' },
  { f: SQL, from: "    if v_a.submitted_at is null then\n      return jsonb_build_object('ok', false, 'expired', true, 'reason', 'grading_pending'", to: "    if false then\n      return jsonb_build_object('ok', false, 'expired', true, 'reason', 'grading_pending'", why: 'an ungraded expired submit answers ok:true' },
  { f: SQL, from: "    return jsonb_build_object('ok', false, 'expired', false, 'reason', 'grading_failed'", to: "    return jsonb_build_object('ok', true, 'expired', false, 'reason', 'grading_failed'", why: 'an ungraded in-time submit answers ok:true' },
  { f: SQL, from: "  if v_stuck.id is not null then", to: "  if false then", why: 'a new start while the last attempt is ungraded' },
  { f: SQL, from: "  select * into v_open from academy_attempts where learner_id = p_learner and submitted_at is null and expires_at > p_now", to: "  select * into v_open from academy_attempts where enrollment_id = p_enrollment.id and submitted_at is null and expires_at > p_now", why: 'one open attempt per course instead of per learner' },
  { f: SQL, from: "   where enrollment_id = p_enrollment.id and started_at >= v_day_start and started_at <= p_now;", to: "   where learner_id = p_learner and started_at >= v_day_start and started_at <= p_now;", why: 'the daily limit counts every course' },
  { f: SQL, from: "    from academy_attempts where enrollment_id = p_enrollment.id and started_at <= p_now;", to: "    from academy_attempts where learner_id = p_learner and started_at <= p_now;", why: 'one course’s cooldown holds another' },
  { f: LRN, from: "  if (r && r.ok === false) {", to: "  if (false) {", why: 'the API answers 200 for an ungraded submit' },
  // owner decision 18 Oct 2026: the lesson gate and the reasonable-accommodation path
  { f: SQL, from: "  if v_lessons = 0 or v_done < v_lessons then", to: "  if false then", why: 'the exam starts before the lessons are done' },
  { f: SQL, from: "                                                    and pr.lesson_id = l.id and pr.status = 'completed'))", to: "                                                    and pr.lesson_id = l.id))", why: 'a viewed lesson counts as completed' },
  // (not a mutant: "lessons finished in another enrollment count" is equivalent under M5 — a progress row's lesson must
  //  belong to its enrollment's version, and a learner has one enrollment per version — so it cannot be told apart)
  { f: SQL, from: "    from academy_lessons l join academy_modules m on m.id = l.module_id where m.version_id = p_enrollment.version_id;", to: "    from academy_lessons l join academy_modules m on m.id = l.module_id where m.version_id = p_enrollment.version_id and l.position = 1;", why: 'only some of the version’s lessons are required' },
  { f: SQL, from: "  select e.learner_id, v.exam_time_limit_minutes + e.exam_extra_minutes into v_l, v_min", to: "  select e.learner_id, v.exam_time_limit_minutes into v_l, v_min", why: 'extra time is ignored at the deadline' },
  { f: SQL, from: "  perform academy_op_actor_staff(p_actor);\n  if p_extra_minutes is null", to: "  if p_extra_minutes is null", why: 'anyone sets extra time' },
  { f: SQL, from: "  if p_reason is null or length(trim(p_reason)) < 5 or length(p_reason) > 500 then", to: "  if false then", why: 'extra time without a reason' },
  { f: SQL, from: "  if p_extra_minutes is null or p_extra_minutes not between 0 and 240 then", to: "  if p_extra_minutes is null then", why: 'unbounded extra time' },
  { f: SQL, from: "  perform academy_op_audit('staff', p_actor, 'academy_enrollments', v_e.id::text, 'exam_accommodation',", to: "  perform jsonb_build_array(", why: 'extra time is not audited' },
  { f: SQL, from: "create trigger academy_exam_enrollment_guard before insert or update on public.academy_enrollments\n  for each row execute function public.academy_exam_enrollment_guard();", to: "", why: 'extra time written by hand, around the operation' },
  { f: ADM, from: "  requirePresident(staff);\n  const m = Number(b.extra_minutes);", to: "  const m = Number(b.extra_minutes);", why: 'any administrator sets extra time from the Command Center' },
  { f: LRN, from: "LEARNER.exam_start = async (event, learner, b) => {\n  await examsOn();", to: "LEARNER.exam_start = async (event, learner, b) => {", why: 'exams start with the switch off' },
  { f: LRN, from: "    return { attempts: done.length, passed: done.some(x => x.passed === true), last_at:", to: "    return { attempts: done.length, score: done.map(x => x.passed), passed: done.some(x => x.passed === true), last_at:", why: 'the Training Manager sees more than pass/fail' },
  { f: LRN, from: "  if (!(await myEnrollments(learner)).some(e => String(e.id) === eid)) A.refuse(404, 'not_found', 'Course not found.');", to: "", why: 'another person’s enrollment reaches the database' },
];
const SUITES = ['test/academy-m6.pg.test.js', 'test/academy-a2e.pg.test.js'];
function tree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2emut-'));
  for (const d of ['netlify', 'supabase', 'test', 'src']) execSync(`cp -r ${path.join(ROOT, d)} ${dir}/`);
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'));
  return dir;
}
function tests(dir) {
  return SUITES.map(f => { const r = spawnSync(process.execPath, [f], { cwd: dir, encoding: 'utf8', env: process.env, timeout: 300000 });
    return { f, ok: r.status === 0, tail: (r.stdout || '').trim().split('\n').slice(-1)[0] }; });
}
const [from, to] = process.argv.slice(2).map(Number);
const list = MUTANTS.slice(from || 0, to || MUTANTS.length);
const dir = tree();
let killed = 0; const survived = [];
try {
  if (!from) { const c = tests(dir); if (!c.every(x => x.ok)) { console.log('CONTROL FAILED', c); process.exit(1); } console.log('control: clean (' + c.map(x => x.tail).join(' · ') + ')'); }
  for (const [i, m] of list.entries()) {
    const p = path.join(dir, m.f), orig = fs.readFileSync(p, 'utf8');
    if (!orig.includes(m.from)) { console.log(`  ANCHOR NOT FOUND #${(from || 0) + i}: ${m.why}`); survived.push(m.why + ' (anchor)'); continue; }
    fs.writeFileSync(p, orig.replace(m.from, m.to));
    const r = tests(dir); fs.writeFileSync(p, orig);
    const dead = r.some(x => !x.ok);
    if (m.control) { console.log((dead ? '  CONTROL KILLED (bad) ' : '  control survived ') + m.why); if (dead) survived.push('CONTROL'); continue; }
    if (dead) { killed++; console.log(`  killed   #${(from || 0) + i} ${m.why}`); } else { survived.push(m.why); console.log(`  SURVIVED #${(from || 0) + i} ${m.why}`); }
  }
} finally { execSync(`rm -rf ${dir}`); }
const total = list.filter(m => !m.control).length;
console.log(`\nacademy A2E mutants: ${killed}/${total} killed${survived.length ? '; survivors: ' + survived.join('; ') : ''}`);
process.exitCode = survived.length ? 1 : 0;
