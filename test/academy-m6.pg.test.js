/* HCPS Academy A2E / M6 — exam attempts with server-enforced limits, run in a REAL Postgres (pg-safeupdate loaded, as
   Supabase's API sessions do) on top of A1, M1, M2, M3, M3.1, M4 and M5 exactly as committed. What is tested is what
   Angelo would run: supabase/academy_a2e_m6_exam_attempts.sql and its rollback. Skipped when there is no server.
     PGHOST=127.0.0.1 PGUSER=postgres PGPASSWORD=… node test/academy-m6.pg.test.js
   PG17.6 without pg-safeupdate: PGTEST_NO_SAFEUPDATE=1. */
const { spawnSync, spawn } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

const PSQL = process.env.PGTEST_PSQL || 'psql';
const SUP = f => path.join(__dirname, '..', 'supabase', f);
const LOCAL = f => path.join(__dirname, 'academy', f);
const psql = (db, args) => spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db].concat(args), { encoding: 'utf8' });
const run = (db, sql) => { const r = psql(db, ['-c', sql]); if (r.error || r.status !== 0) throw new Error((r.error && r.error.message) || r.stderr); return r.stdout.trim(); };
const tryRun = (db, sql) => { const r = psql(db, ['-c', sql]); return { ok: r.status === 0, out: r.stdout.trim(), err: r.stderr }; };
const file = (db, f) => { const r = psql(db, ['-f', f]); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
try { run('postgres', 'select 1'); } catch (e) { console.log('SKIP: no Postgres (' + String(e.message).split('\n')[0] + ')'); process.exit(0); }
const NO_SAFEUPDATE = process.env.PGTEST_NO_SAFEUPDATE === '1';
const fixtureText = () => { let s = fs.readFileSync(LOCAL('fixture.sql'), 'utf8'); if (NO_SAFEUPDATE) s = s.replace(/^do \$\$ begin execute format\('alter database %I set session_preload_libraries.*$/m, ''); return s; };

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + String(e && e.stack || e).split('\n').slice(0, 8).join('\n       ')); } }
const json = s => JSON.parse(s);
const J = v => `$j$${JSON.stringify(v)}$j$::jsonb`;
const H = v => crypto.createHash('sha256').update(String(v)).digest('hex');
const PRES = `'staff:admin@test.example'`;
const MIG = SUP('academy_a2e_m6_exam_attempts.sql'), RB = SUP('academy_a2e_m6_exam_attempts_rollback.sql');
const HQ = '00000000-0000-0000-0000-0000000000a1', OTHER = '00000000-0000-0000-0000-0000000000b1';
const TESTD = '00000000-0000-0000-0000-0000000000c1';

function base(name, withM6) {
  run('postgres', `drop database if exists ${name}`); run('postgres', `create database ${name}`);
  run(name, fixtureText());
  run(name, `alter table public.dealers add column is_test boolean not null default false;
             create table public.dealer_users (uid uuid primary key, email text, dealer_id uuid references public.dealers(id), status text);
             insert into public.dealers (id, business_name, is_test) values ('${TESTD}', 'TEST Sandbox', true);`);
  file(name, SUP('academy_a1_foundation.sql'));
  run(name, 'grant all on all tables in schema public to service_role');
  for (const f of ['academy_a2a_m1_audited_ops.sql', 'academy_a2c_m2_content_ops.sql', 'academy_a2d_m3_author_ops.sql', 'academy_a2d_m3_1_save_lesson.sql',
                   'academy_c2_m4_publish_ops.sql', 'academy_a2b_m5_learner_access.sql']) file(name, SUP(f));
  run(name, `insert into app_settings (key, value) values ('phase2_flags', '{"academy_admin": true}') on conflict (key) do update set value = excluded.value`);
  if (withM6) file(name, MIG);
}
const course = (db, slug) => json(run(db, `select academy_content_op_create_course(${PRES}, null, ${J({ slug, title: slug, course_type: 'hcps_certification', manufacturer_slug: 'golden-technologies' })})`)).id;
function version(db, c) {
  const v = json(run(db, `select academy_content_op_create_version(${PRES}, null, '${c}', '{"exam_questions":2}')`)).id;
  const qs = [];
  for (const k of ['A', 'B']) {
    const m = json(run(db, `select academy_content_op_create_module(${PRES}, null, '${v}', ${J({ title: 'Module ' + k })})`)).id;
    qs.push(json(run(db, `select academy_author_op_create_question(${PRES}, null, '${v}', ${J({ module_id: m, kind: 'single', prompt: 'Exam ' + k + ' ' + v.slice(0, 6) + '?', choices: [{ id: 'a', text: 'Right ' + k }, { id: 'b', text: 'Wrong ' + k }], answer_key: 'a', explanation: 'SECRET-EXPLANATION-' + k, objective_tags: ['topic-' + k.toLowerCase()] })})`)).id);
    const l = json(run(db, `select academy_content_op_create_lesson(${PRES}, null, '${m}', ${J({ title: 'Lesson ' + k, est_minutes: 10 })})`)).id;
    run(db, `select academy_author_op_set_blocks(${PRES}, '${l}', ${J([{ kind: 'text', heading: 'One', body: 'First.' }, { kind: 'text', heading: 'Two', body: 'Second.' }, { kind: 'text', heading: 'Three', body: 'Third.' }])})`);
  }
  return { v, qs };
}
const publish = (db, v) => { run(db, `select academy_content_op_move_version(${PRES}, '${v}', 'in_review')`); run(db, `select academy_publish_op_publish_version(${PRES}, '${v}', null)`); };
const q1 = (db, sql) => json(run(db, `select coalesce(to_jsonb(x), 'null') from (${sql}) x`));
const count = (db, table, where) => Number(run(db, `select count(*) from ${table}${where ? ' where ' + where : ''}`));
const N = e => e.trim().toLowerCase();
function learnerAt(db, dealer, email, code) {
  run(db, `select academy_access_op_invite(${PRES}, '${dealer}', '${email}', 'Person', 'learner')`);
  run(db, `select academy_access_op_request_code('${email}', '${H(N(email) + code)}', '${H('ip-' + email)}')`);
  return json(run(db, `select academy_access_op_verify_code('${email}', '${H(N(email) + code)}', '${H('ip-' + email)}')`)).learner_id;
}
const enrollRaw = (db, l, v) => json(run(db, `select academy_enroll_op_enroll(${PRES}, '${l}', '${v}', null)`)).id;
const lessonsOf = (db, v) => run(db, `select l.id from academy_lessons l join academy_modules m on m.id = l.module_id where m.version_id = '${v}' order by m.position, l.position`).split('\n').filter(Boolean);
// the learner finishes lessons through M5's own progress operation (only `completed` counts for the exam)
const finish = (db, l, e, ids, status) => { for (const id of ids) run(db, `select academy_progress_op_save('learner:${l}', '${e}', '${id}', '${status || 'completed'}', 0)`); };
// most tests start from an enrollment whose lessons are all complete; the lesson-gate tests use enrollRaw
const enroll = (db, l, v) => { const e = enrollRaw(db, l, v); finish(db, l, e, lessonsOf(db, v)); return e; };
const op = (db, fn, args) => json(run(db, `select academy_exam_op_${fn}(${args})`));
// test-only: move an attempt in time / write one as the owner with the operation marker (the guard lets the owner through)
const asOwner = sql => `begin; select set_config('academy.op', 'test', true); ${sql}; commit;`;
function bg(db, sql) {
  return new Promise(res => {
    const p = spawn(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql]);
    let out = '', err = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
    p.on('close', code => res({ ok: code === 0, out: out.trim(), err }));
  });
}

const DB = 'academy_m6_' + process.pid, DB2 = 'academy_m6rb_' + process.pid;
(async () => {
try {
  base(DB, false);
  const C = course(DB, 'golden-like'); const V = version(DB, C); publish(DB, V.v);
  const L1 = learnerAt(DB, HQ, 'one@test.example', '111111');
  const L2 = learnerAt(DB, HQ, 'two@test.example', '222222');
  const L3 = learnerAt(DB, HQ, 'three@test.example', '333333');
  const E1 = enroll(DB, L1, V.v), E2 = enroll(DB, L2, V.v), E3 = enroll(DB, L3, V.v);
  const A1 = `'learner:${L1}'`, A2 = `'learner:${L2}'`, A3 = `'learner:${L3}'`;

  await t('Static: every UPDATE / DELETE in the M6 files carries a WHERE clause (pg-safeupdate)', () => {
    for (const f of [MIG, RB]) {
      const s = fs.readFileSync(f, 'utf8').replace(/--[^\n]*/g, '').replace(/\bfor\s+update\b/gi, 'for_lock').replace(/\bdo\s+update\b/gi, 'do_upsert').replace(/\bor\s+update\s+on\b/gi, 'or_upd_on');
      for (const m of s.matchAll(/\b(update|delete\s+from)\s+[a-z_.]+\s[\s\S]*?;/gim)) assert.ok(/\bwhere\b/i.test(m[0]), path.basename(f) + ': ' + m[0].slice(0, 80));
    }
  });
  await t('Migration installs in one transaction; all 8 install checks true; a second run is refused', () => {
    const out = file(DB, MIG); const rows = out.split('\n').filter(l => l.includes('|'));
    assert.strictEqual(rows.length, 8, out); assert.ok(rows.every(r => r.endsWith('|t')), out);
    const again = tryRun(DB, fs.readFileSync(MIG, 'utf8')); assert.strictEqual(again.ok, false); assert.match(again.err, /already installed/);
  });
  await t('Rights: the server cannot start or submit through M1 or write attempts; anon gets nothing; helpers are owner-only', () => {
    assert.match(tryRun(DB, `set role service_role; select academy_op_start_attempt(${A1}, '${E1}')`).err, /permission denied/);
    assert.match(tryRun(DB, `set role service_role; select academy_op_submit_attempt(${A1}, '${E1}', '{}')`).err, /permission denied/);
    assert.match(tryRun(DB, `set role service_role; insert into academy_attempts (enrollment_id, question_ids) values ('${E1}', '{}')`).err, /permission denied/);
    assert.match(tryRun(DB, `set role service_role; select academy_exam_expire('${L1}')`).err, /permission denied/);
    assert.match(tryRun(DB, `set role anon; select academy_exam_op_start(${A1}, '${E1}')`).err, /permission denied/);
    assert.ok(tryRun(DB, `set role service_role; select academy_exam_op_status(${A1}, '${E1}')`).ok, 'the server calls the operations');
  });

  let AT;
  await t('Start: one attempt with the version\'s questions and a 45-minute deadline; the view has prompts and choices but never an answer key or explanation', () => {
    const r = op(DB, 'start', `${A1}, '${E1}'`);
    assert.strictEqual(r.ok, true); assert.strictEqual(r.questions, 2); AT = r.attempt_id;
    const a = q1(DB, `select learner_id, round(extract(epoch from expires_at - started_at)) as secs from academy_attempts where id = '${AT}'`);
    assert.strictEqual(a.learner_id, L1); assert.strictEqual(Number(a.secs), 45 * 60);
    const v = op(DB, 'view', `${A1}, '${AT}'`); const s = JSON.stringify(v);
    assert.strictEqual(v.questions.length, 2); assert.ok(v.questions.every(q => q.prompt && q.choices.length === 2 && q.choices.every(c => Object.keys(c).sort().join() === 'id,text')));
    assert.ok(!/answer_key|SECRET-EXPLANATION|explanation/.test(s), 'no key, no explanation');
    assert.match(tryRun(DB, `select academy_exam_op_view(${A2}, '${AT}')`).err, /not this record's learner/, 'only the learner sees their attempt');
  });
  await t('One open attempt: a second start (any course) is refused with the deadline and writes nothing', () => {
    const r = op(DB, 'start', `${A1}, '${E1}'`);
    assert.strictEqual(r.ok, false); assert.strictEqual(r.reason, 'open_attempt'); assert.strictEqual(r.open_attempt_id, AT); assert.ok(r.next_at);
    assert.strictEqual(count(DB, 'academy_attempts', `learner_id = '${L1}'`), 1);
  });
  await t('Save and resume: only this attempt\'s questions and real choices; saved answers come back in the view', () => {
    assert.match(tryRun(DB, `select academy_exam_op_save(${A1}, '${AT}', ${J({ [V.qs[0]]: 'z' })})`).err, /choice a–f/);
    assert.match(tryRun(DB, `select academy_exam_op_save(${A1}, '${AT}', ${J({ '00000000-0000-0000-0000-000000000009': 'a' })})`).err, /not part of this exam/);
    assert.match(tryRun(DB, `select academy_exam_op_save(${A1}, '${AT}', ${J({ [V.qs[0]]: ['a', 'a'] })})`).err, /different choices/);
    assert.strictEqual(op(DB, 'save', `${A1}, '${AT}', ${J({ [V.qs[0]]: 'a' })}`).answered, 1);
    assert.deepStrictEqual(op(DB, 'view', `${A1}, '${AT}'`).answers, { [V.qs[0]]: 'a' });
    assert.match(tryRun(DB, `select academy_exam_op_save(${A2}, '${AT}', '{}')`).err, /not this record's learner/);
  });
  await t('Submit: graded by M1 from the saved + sent answers; only score, pass/fail and topics come back; never twice', () => {
    const r = op(DB, 'submit', `${A1}, '${AT}', ${J({ [V.qs[1]]: 'b' })}`);
    assert.deepStrictEqual(Object.keys(r).sort(), ['expired', 'ok', 'passed', 'score', 'study_topics']);
    assert.strictEqual(r.score, 50); assert.strictEqual(r.passed, false); assert.deepStrictEqual(r.study_topics, ['topic-b']);
    assert.match(tryRun(DB, `select academy_exam_op_submit(${A1}, '${AT}', '{}')`).err, /already submitted/);
    assert.match(tryRun(DB, `select academy_exam_op_save(${A1}, '${AT}', '{}')`).err, /already submitted/);
  });
  await t('Cooldown: refused right after, with the next allowed time; at the exact edges 59:59 refused, 60:00 allowed', () => {
    const r = op(DB, 'start', `${A1}, '${E1}'`);
    assert.strictEqual(r.ok, false); assert.strictEqual(r.reason, 'cooldown');
    const end = q1(DB, `select submitted_at as t from academy_attempts where id = '${AT}'`).t;
    const lim = at => json(run(DB, `select academy_exam_limits('${L1}', e, '${end}'::timestamptz + interval '${at}') from academy_enrollments e where e.id = '${E1}'`));
    assert.strictEqual(lim('59 minutes 59 seconds').reason, 'cooldown');
    assert.strictEqual(lim('60 minutes').can_start, true);
    assert.strictEqual(new Date(r.next_at).getTime(), new Date(end).getTime() + 3600e3);
  });
  await t('Simultaneous: 20 start requests from one learner at the same instant create exactly ONE attempt', async () => {
    const rs = await Promise.all(Array.from({ length: 20 }, () => bg(DB, `begin; select academy_exam_op_start(${A2}, '${E2}'); select pg_sleep(0.1); commit;`)));
    assert.ok(rs.every(r => r.ok), rs.map(r => r.err).join('\n'));
    assert.strictEqual(rs.filter(r => json(r.out.split('\n')[0]).ok).length, 1);
    assert.strictEqual(count(DB, 'academy_attempts', `learner_id = '${L2}'`), 1);
  });
  await t('Daily limit (America/Chicago): the 3rd attempt of the day is allowed, the 4th refused until local midnight; the window follows daylight saving', () => {
    // three finished attempts on 2026-11-01 (the day daylight saving ends: 25 hours long), written as the owner
    const day = ['2026-11-01 00:05:00-05', '2026-11-01 09:00:00-06', '2026-11-01 16:00:00-06'];
    for (const s of day) run(DB, asOwner(`insert into academy_attempts (enrollment_id, question_ids, started_at, answers, submitted_at, score, passed, graded_at)
      values ('${E3}', array['${V.qs[0]}','${V.qs[1]}']::uuid[], '${s}', '{}', '${s}'::timestamptz + interval '10 minutes', 0, false, '${s}'::timestamptz + interval '10 minutes')`));
    const lim = at => json(run(DB, `select academy_exam_limits('${L3}', e, '${at}'::timestamptz) from academy_enrollments e where e.id = '${E3}'`));
    const late = lim('2026-11-01 23:59:59-06');
    assert.strictEqual(late.reason, 'daily_limit'); assert.strictEqual(late.attempts_today, 3);
    assert.strictEqual(new Date(late.next_at).toISOString(), new Date('2026-11-02T00:00:00-06:00').toISOString(), 'next local midnight (CST after the change)');
    assert.strictEqual(lim('2026-11-02 00:00:00-06').can_start, true, 'a new day at local midnight');
    assert.strictEqual(lim('2026-11-01 00:04:59-05').can_start, true, 'that morning, before the first attempt: none yet');
    // spring forward: 2026-03-08 is 23 hours long; the day still ends at local midnight
    const spring = json(run(DB, `select academy_exam_limits('${L3}', e, '2026-03-08 12:00:00-05') from academy_enrollments e where e.id = '${E3}'`));
    assert.strictEqual(spring.can_start, true);
    // two on one day: the 3rd is allowed
    assert.strictEqual(lim('2026-11-01 15:00:00-06').can_start, true, 'with 2 started that day, a 3rd may start');
  });
  await t('Expiry: an attempt open past its deadline is graded with the answers saved before it (and counts as ended for the cooldown); answers sent afterwards never count', () => {
    const L4 = learnerAt(DB, HQ, 'four@test.example', '444444'); const E4 = enroll(DB, L4, V.v); const A4 = `'learner:${L4}'`;
    run(DB, asOwner(`insert into academy_attempts (enrollment_id, question_ids, started_at, draft_answers)
      values ('${E4}', array['${V.qs[0]}','${V.qs[1]}']::uuid[], now() - interval '50 minutes', ${J({ [V.qs[0]]: 'a' })})`));
    const id = q1(DB, `select id from academy_attempts where learner_id = '${L4}'`).id;
    assert.strictEqual(op(DB, 'save', `${A4}, '${id}', ${J({ [V.qs[1]]: 'a' })}`).reason, 'expired', 'no saving after the deadline');
    const r = op(DB, 'submit', `${A4}, '${id}', ${J({ [V.qs[1]]: 'a' })}`);
    assert.strictEqual(r.expired, true); assert.strictEqual(r.score, 50, 'only the answer saved in time counted');
    const row = q1(DB, `select expired, score from academy_attempts where id = '${id}'`); assert.strictEqual(row.expired, true);
    const st = op(DB, 'status', `${A4}, '${E4}'`);
    assert.strictEqual(st.reason, 'cooldown', 'the deadline was 5 minutes ago: the 60-minute cooldown runs from it');
    const nx = new Date(st.next_at).getTime() - Date.now(); assert.ok(nx > 54 * 60e3 && nx < 56 * 60e3, String(nx));
  });
  await t('Expiry via status: an abandoned attempt never blocks — status grades it and the cooldown runs from its deadline', () => {
    const L5 = learnerAt(DB, HQ, 'five@test.example', '555555'); const E5 = enroll(DB, L5, V.v); const A5 = `'learner:${L5}'`;
    run(DB, asOwner(`insert into academy_attempts (enrollment_id, question_ids, started_at, draft_answers)
      values ('${E5}', array['${V.qs[0]}','${V.qs[1]}']::uuid[], now() - interval '3 hours', ${J({ [V.qs[0]]: 'a', [V.qs[1]]: 'a' })})`));
    const st = op(DB, 'status', `${A5}, '${E5}'`);
    assert.strictEqual(st.can_start, true, 'deadline 2h15m ago: past the 60-minute cooldown');
    assert.strictEqual(st.attempts[0].expired, true); assert.strictEqual(st.attempts[0].score, 100); assert.strictEqual(st.attempts[0].passed, true);
    assert.ok(!JSON.stringify(st).includes('SECRET'), 'no explanations');
    assert.strictEqual(count(DB, 'academy_events', `action = 'expire_attempt'`) >= 1, true);
  });
  await t('Access: a withdrawn enrollment or ended access cannot start; another learner\'s enrollment is refused', () => {
    const L6 = learnerAt(DB, HQ, 'six@test.example', '666666'); const E6 = enroll(DB, L6, V.v); const A6 = `'learner:${L6}'`;
    assert.match(tryRun(DB, `select academy_exam_op_start(${A1}, '${E6}')`).err, /not this record's learner/);
    run(DB, `select academy_enroll_op_withdraw(${PRES}, '${E6}', 'mistake')`);
    assert.match(tryRun(DB, `select academy_exam_op_start(${A6}, '${E6}')`).err, /withdrawn/);
    run(DB, `select academy_enroll_op_enroll(${PRES}, '${L6}', '${V.v}', null)`);
    const m = q1(DB, `select id from academy_memberships where learner_id = '${L6}' and status = 'active'`).id;
    run(DB, `select academy_access_op_deactivate(${PRES}, '${m}', 'left')`);
    assert.match(tryRun(DB, `select academy_exam_op_start(${A6}, '${E6}')`).err, /access .* has ended|not active/);
    assert.strictEqual(count(DB, 'academy_attempts', `learner_id = '${L6}'`), 0);
  });
  // ---- review item 4: the one-open rule is per learner across courses; cooldown and daily limit are per enrollment
  const C2 = course(DB, 'second-course'); const V2 = version(DB, C2); publish(DB, V2.v);
  await t('Across courses: an open attempt in course A blocks starting course B; once A is submitted, B starts at once (A\'s cooldown is A\'s alone)', () => {
    const L = learnerAt(DB, HQ, 'seven@test.example', '777777'); const EA = enroll(DB, L, V.v), EB = enroll(DB, L, V2.v); const AL = `'learner:${L}'`;
    const a = op(DB, 'start', `${AL}, '${EA}'`); assert.strictEqual(a.ok, true);
    const b = op(DB, 'start', `${AL}, '${EB}'`);
    assert.strictEqual(b.ok, false); assert.strictEqual(b.reason, 'open_attempt'); assert.strictEqual(b.open_enrollment_id, EA); assert.strictEqual(b.open_attempt_id, a.attempt_id);
    assert.strictEqual(op(DB, 'status', `${AL}, '${EB}'`).reason, 'open_attempt', 'status for B says the same');
    assert.strictEqual(op(DB, 'submit', `${AL}, '${a.attempt_id}', '{}'`).ok, true);
    assert.strictEqual(op(DB, 'status', `${AL}, '${EA}'`).reason, 'cooldown', 'A waits for its cooldown');
    const b2 = op(DB, 'start', `${AL}, '${EB}'`); assert.strictEqual(b2.ok, true, 'B is not held by A\'s cooldown: ' + JSON.stringify(b2));
    assert.strictEqual(op(DB, 'start', `${AL}, '${EA}'`).reason, 'open_attempt', 'and now B\'s open attempt blocks A');
    assert.strictEqual(count(DB, 'academy_attempts', `learner_id = '${L}'`), 2);
  });
  await t('Across courses: the daily limit is counted per enrollment — three attempts in course A leave course B\'s three untouched', () => {
    const L = learnerAt(DB, HQ, 'eight@test.example', '888888'); const EA = enroll(DB, L, V.v), EB = enroll(DB, L, V2.v);
    for (const s of ['2026-11-05 08:00:00-06', '2026-11-05 10:00:00-06', '2026-11-05 12:00:00-06']) run(DB, asOwner(`insert into academy_attempts (enrollment_id, question_ids, started_at, answers, submitted_at, score, passed, graded_at)
      values ('${EA}', array['${V.qs[0]}','${V.qs[1]}']::uuid[], '${s}', '{}', '${s}'::timestamptz + interval '10 minutes', 0, false, '${s}'::timestamptz + interval '10 minutes')`));
    const lim = (e, at) => json(run(DB, `select academy_exam_limits('${L}', e, '${at}'::timestamptz) from academy_enrollments e where e.id = '${e}'`));
    assert.strictEqual(lim(EA, '2026-11-05 20:00:00-06').reason, 'daily_limit');
    const b = lim(EB, '2026-11-05 20:00:00-06'); assert.strictEqual(b.can_start, true, JSON.stringify(b)); assert.strictEqual(b.attempts_today, 0);
  });

  // ---- owner decision 18 Oct 2026: every lesson of the enrolled version completed first, enforced in the database
  await t('Lesson gate: no lessons, one of two, or "viewed" only → refused (lessons_incomplete, counts) with nothing written; all completed → starts', () => {
    const L = learnerAt(DB, HQ, 'gate@test.example', '121212'); const E = enrollRaw(DB, L, V.v); const AL = `'learner:${L}'`; const ids = lessonsOf(DB, V.v);
    const none = op(DB, 'start', `${AL}, '${E}'`);
    assert.strictEqual(none.ok, false); assert.strictEqual(none.reason, 'lessons_incomplete'); assert.strictEqual(none.lessons_total, 2); assert.strictEqual(none.lessons_completed, 0);
    finish(DB, L, E, [ids[0]]); finish(DB, L, E, [ids[1]], 'viewed');
    const part = op(DB, 'start', `${AL}, '${E}'`); assert.strictEqual(part.reason, 'lessons_incomplete'); assert.strictEqual(part.lessons_completed, 1, 'viewed does not count');
    assert.strictEqual(op(DB, 'status', `${AL}, '${E}'`).reason, 'lessons_incomplete', 'status says the same');
    assert.strictEqual(count(DB, 'academy_attempts', `learner_id = '${L}'`), 0);
    finish(DB, L, E, [ids[1]]);
    const ok = op(DB, 'start', `${AL}, '${E}'`); assert.strictEqual(ok.ok, true, JSON.stringify(ok));
    run(DB, `select academy_exam_op_submit(${AL}, '${ok.attempt_id}', '{}')`);
  });
  await t('Lesson gate across enrollments: lessons finished in another course never count; the M5 progress operation refuses another course\'s lesson', () => {
    const L = learnerAt(DB, HQ, 'cross@test.example', '131313'); const EA = enrollRaw(DB, L, V.v), EB = enrollRaw(DB, L, V2.v); const AL = `'learner:${L}'`;
    finish(DB, L, EB, lessonsOf(DB, V2.v));
    assert.strictEqual(op(DB, 'start', `${AL}, '${EA}'`).reason, 'lessons_incomplete', 'course B\'s lessons do not open course A');
    assert.match(tryRun(DB, `select academy_progress_op_save(${AL}, '${EA}', '${lessonsOf(DB, V2.v)[0]}', 'completed', 0)`).err, /not part of this course/);
    assert.strictEqual(op(DB, 'start', `${AL}, '${EB}'`).ok, true);
  });
  await t('Lesson gate and a new course version: progress on version 1 does not open version 2; a withdrawn enrollment with every lesson done is still refused', () => {
    const C3 = course(DB, 'versioned-course'); const W1 = version(DB, C3); publish(DB, W1.v);
    const L = learnerAt(DB, HQ, 'ver@test.example', '141414'); const AL = `'learner:${L}'`; const E1v = enroll(DB, L, W1.v);
    const W2 = version(DB, C3); publish(DB, W2.v);   // replaces version 1 (retired in the same step by M4)
    const E2v = enrollRaw(DB, L, W2.v);
    assert.strictEqual(op(DB, 'start', `${AL}, '${E2v}'`).reason, 'lessons_incomplete', 'version 2 needs its own lessons');
    assert.strictEqual(tryRun(DB, `select academy_exam_op_start(${AL}, '${E1v}')`).ok, false, 'the retired version opens no new exam');
    finish(DB, L, E2v, lessonsOf(DB, W2.v));
    run(DB, `select academy_enroll_op_withdraw(${PRES}, '${E2v}', 'mistake')`);
    assert.match(tryRun(DB, `select academy_exam_op_start(${AL}, '${E2v}')`).err, /withdrawn/);
    assert.strictEqual(count(DB, 'academy_attempts', `learner_id = '${L}'`), 0);
  });
  await t('Lesson gate under load: 20 simultaneous starts with a lesson unfinished create no attempt; after finishing, 20 more create exactly one', async () => {
    const L = learnerAt(DB, HQ, 'load@test.example', '151515'); const E = enrollRaw(DB, L, V.v); const AL = `'learner:${L}'`;
    finish(DB, L, E, [lessonsOf(DB, V.v)[0]]);
    const go = () => Promise.all(Array.from({ length: 20 }, () => bg(DB, `begin; select academy_exam_op_start(${AL}, '${E}'); select pg_sleep(0.05); commit;`)));
    const a = await go(); assert.ok(a.every(r => r.ok && json(r.out.split('\n')[0]).reason === 'lessons_incomplete'));
    assert.strictEqual(count(DB, 'academy_attempts', `learner_id = '${L}'`), 0);
    finish(DB, L, E, [lessonsOf(DB, V.v)[1]]);
    const b = await go(); assert.strictEqual(b.filter(r => r.ok && json(r.out.split('\n')[0]).ok).length, 1);
    assert.strictEqual(count(DB, 'academy_attempts', `learner_id = '${L}'`), 1);
  });
  await t('Resume keeps the original deadline: view and save after a "reconnect" return the same expires_at; saved answers come back', () => {
    const L = learnerAt(DB, HQ, 'resume@test.example', '161616'); const E = enroll(DB, L, V.v); const AL = `'learner:${L}'`;
    const s0 = op(DB, 'start', `${AL}, '${E}'`);
    op(DB, 'save', `${AL}, '${s0.attempt_id}', ${J({ [V.qs[0]]: 'a' })}`);
    const v1 = op(DB, 'view', `${AL}, '${s0.attempt_id}'`), sv = op(DB, 'save', `${AL}, '${s0.attempt_id}', '{}'`), v2 = op(DB, 'view', `${AL}, '${s0.attempt_id}'`);
    assert.strictEqual(new Date(v1.expires_at).getTime(), new Date(s0.expires_at).getTime());
    assert.strictEqual(new Date(sv.expires_at).getTime(), new Date(s0.expires_at).getTime());
    assert.deepStrictEqual(v2.answers, { [V.qs[0]]: 'a' }); assert.strictEqual(v2.open, true);
    run(DB, `select academy_exam_op_submit(${AL}, '${s0.attempt_id}', '{}')`);
  });

  // ---- reasonable accommodation: extra time per enrollment, set only by an HCPS administrator, audited
  await t('Accommodation: only an active HCPS administrator, with a reason and 0–240 minutes; never a learner; the server calls it, anon cannot', () => {
    const L = learnerAt(DB, HQ, 'acc@test.example', '171717'); const E = enroll(DB, L, V.v);
    assert.match(tryRun(DB, `select academy_exam_op_accommodate('learner:${L}', '${E}', 15, 'needs more time')`).err, /staff:<email>/);
    assert.match(tryRun(DB, `select academy_exam_op_accommodate('staff:nobody@test.example', '${E}', 15, 'needs more time')`).err, /not an active HCPS administrator/);
    assert.match(tryRun(DB, `select academy_exam_op_accommodate(${PRES}, '${E}', 15, '  ')`).err, /reason/);
    assert.match(tryRun(DB, `select academy_exam_op_accommodate(${PRES}, '${E}', 241, 'needs more time')`).err, /0 to 240/);
    assert.match(tryRun(DB, `select academy_exam_op_accommodate(${PRES}, '${E}', -1, 'needs more time')`).err, /0 to 240/);
    assert.match(tryRun(DB, `set role anon; select academy_exam_op_accommodate(${PRES}, '${E}', 15, 'needs more time')`).err, /permission denied/);
    assert.ok(tryRun(DB, `set role service_role; select academy_exam_op_accommodate(${PRES}, '${E}', 0, 'no change needed')`).ok);
    assert.match(tryRun(DB, `update academy_enrollments set exam_extra_minutes = 60 where id = '${E}'`).err, /only through academy_exam_op_accommodate/, 'not even the owner by hand');
    assert.match(tryRun(DB, `begin; select set_config('academy.op', 'exam_accommodation', true); set local role service_role; update academy_enrollments set exam_extra_minutes = 60 where id = '${E}'; commit;`).err, /permission denied|only through/);
    assert.strictEqual(q1(DB, `select exam_extra_minutes from academy_enrollments where id = '${E}'`).exam_extra_minutes, 0);
  });
  await t('Accommodation: +15 applies to the NEXT attempt (60-minute deadline) and is audited with its reason; a running attempt keeps its deadline; 0 removes it', () => {
    const L = learnerAt(DB, HQ, 'acc2@test.example', '181818'); const E = enroll(DB, L, V.v); const AL = `'learner:${L}'`;
    const a = op(DB, 'start', `${AL}, '${E}'`); const before = q1(DB, `select expires_at from academy_attempts where id = '${a.attempt_id}'`).expires_at;
    const r = json(run(DB, `select academy_exam_op_accommodate(${PRES}, '${E}', 15, 'Approved accommodation request')`));
    assert.strictEqual(r.ok, true); assert.strictEqual(r.open_attempt_unchanged, true);
    assert.strictEqual(q1(DB, `select expires_at from academy_attempts where id = '${a.attempt_id}'`).expires_at, before, 'the running attempt keeps its deadline');
    const ev = q1(DB, `select actor, before, after from academy_events where entity_id = '${E}' and action = 'exam_accommodation'`);
    assert.strictEqual(ev.actor, 'staff:admin@test.example'); assert.strictEqual(ev.before.extra_minutes, 0); assert.strictEqual(ev.after.extra_minutes, 15); assert.strictEqual(ev.after.reason, 'Approved accommodation request');
    const st = op(DB, 'status', `${AL}, '${E}'`); assert.strictEqual(st.policy.extra_minutes, 15); assert.strictEqual(st.policy.your_time_limit_minutes, 60);
    run(DB, `select academy_exam_op_submit(${AL}, '${a.attempt_id}', '{}')`);
    // the next attempt (after its cooldown — moved in time as the owner, test only) gets 45 + 15 minutes
    run(DB, asOwner(`insert into academy_attempts (enrollment_id, question_ids, started_at) values ('${E}', array['${V.qs[0]}','${V.qs[1]}']::uuid[], now() - interval '1 minute')`));
    const n = q1(DB, `select round(extract(epoch from expires_at - started_at)) as secs from academy_attempts where enrollment_id = '${E}' and submitted_at is null`);
    assert.strictEqual(Number(n.secs), 60 * 60, 'deadline = 45 + 15 minutes');
    assert.strictEqual(json(run(DB, `select academy_exam_op_accommodate(${PRES}, '${E}', 15, 'same again please')`)).unchanged, true);
    assert.strictEqual(json(run(DB, `select academy_exam_op_accommodate(${PRES}, '${E}', 0, 'Accommodation ended')`)).extra_minutes, 0);
    assert.strictEqual(count(DB, 'academy_events', `entity_id = '${E}' and action = 'exam_accommodation'`), 2);
  });

  // ---- review items 2 and 3: a grade that cannot be written is recorded, reported and retried — never swallowed
  run(DB, `create function public.zz_test_refuse_events() returns trigger language plpgsql as $f$ begin
             if new.action = any (string_to_array(current_setting('zz.refuse', true), ',')) then raise exception 'test refused %', new.action; end if; return new; end $f$;
           create trigger zz_test_refuse_events before insert on academy_events for each row execute function public.zz_test_refuse_events();`);
  const refuse = actions => run(DB, `alter database ${DB} set zz.refuse = '${actions}'`);
  const overdue = (e, answers) => { run(DB, asOwner(`insert into academy_attempts (enrollment_id, question_ids, started_at, draft_answers)
      values ('${e}', array['${V.qs[0]}','${V.qs[1]}']::uuid[], now() - interval '50 minutes', ${J(answers)})`)); return q1(DB, `select id from academy_attempts where enrollment_id = '${e}' and submitted_at is null`).id; };
  const row = id => q1(DB, `select submitted_at, score, expired, grading_failures, grading_error from academy_attempts where id = '${id}'`);
  const evs = (id, action) => count(DB, 'academy_events', `entity_id = '${id}' and action = '${action}'`);
  let LF, EF, AF, IDF;
  await t('Expiry failure: status still answers; the attempt stays ungraded, is recorded (count, SQLSTATE, audit row, WARNING) and blocks a new start with grading_pending', () => {
    LF = learnerAt(DB, HQ, 'nine@test.example', '999999'); EF = enroll(DB, LF, V.v); AF = `'learner:${LF}'`;
    IDF = overdue(EF, { [V.qs[0]]: 'a' });
    refuse('submit_attempt');
    const r = tryRun(DB, `select academy_exam_op_status(${AF}, '${EF}')`);
    assert.ok(r.ok, r.err); assert.match(r.err, /WARNING:.*could not be graded \(expire_failed\): P0001: test refused submit_attempt/);
    const st = json(r.out);
    assert.strictEqual(st.can_start, false); assert.strictEqual(st.reason, 'grading_pending'); assert.strictEqual(st.pending_attempt_id, IDF);
    assert.strictEqual(st.attempts[0].overdue, true); assert.strictEqual(st.attempts[0].grading_failed, true); assert.strictEqual(st.attempts[0].score, null);
    const w = row(IDF); assert.strictEqual(w.submitted_at, null); assert.strictEqual(w.grading_failures, 1); assert.strictEqual(w.grading_error, 'P0001: test refused submit_attempt');
    assert.strictEqual(evs(IDF, 'expire_failed'), 1); assert.strictEqual(evs(IDF, 'expire_attempt'), 0);
    const ev = q1(DB, `select actor, after from academy_events where entity_id = '${IDF}' and action = 'expire_failed'`);
    assert.strictEqual(ev.actor, 'system:exam-clock'); assert.strictEqual(ev.after.sqlstate, 'P0001'); assert.strictEqual(ev.after.failures, 1);
    const s2 = op(DB, 'start', `${AF}, '${EF}'`); assert.strictEqual(s2.ok, false); assert.strictEqual(s2.reason, 'grading_pending');
    assert.strictEqual(row(IDF).grading_failures, 2, 'every call retries'); assert.strictEqual(evs(IDF, 'expire_failed'), 1, 'the same error is audited once');
    assert.strictEqual(count(DB, 'academy_attempts', `learner_id = '${LF}'`), 1, 'no new attempt');
  });
  await t('Expired submit with a failed grade answers ok:false / grading_pending (recorded) — never ok:true without a result', () => {
    const r = op(DB, 'submit', `${AF}, '${IDF}', ${J({ [V.qs[1]]: 'a' })}`);
    assert.deepStrictEqual(r, { ok: false, expired: true, reason: 'grading_pending', attempt_id: IDF, recorded: true });
    assert.strictEqual(row(IDF).submitted_at, null);
  });
  await t('When even the failure record is refused: the call still answers, recorded = false, two WARNINGs name both errors, nothing half-written', () => {
    const L = learnerAt(DB, HQ, 'ten@test.example', '101010'); const E = enroll(DB, L, V.v); const AL = `'learner:${L}'`;
    const id = overdue(E, { [V.qs[0]]: 'a', [V.qs[1]]: 'a' });
    refuse('submit_attempt,expire_failed');
    const r = tryRun(DB, `select academy_exam_op_submit(${AL}, '${id}', '{}')`);
    assert.ok(r.ok, r.err); assert.match(r.err, /could not be graded/); assert.match(r.err, /could not be recorded: P0001 test refused expire_failed/);
    const x = json(r.out); assert.strictEqual(x.ok, false); assert.strictEqual(x.reason, 'grading_pending'); assert.strictEqual(x.recorded, false);
    const w = row(id); assert.strictEqual(w.submitted_at, null); assert.strictEqual(w.grading_failures, 0, 'the record rolled back whole'); assert.strictEqual(evs(id, 'expire_failed'), 0);
    refuse('');
    const g = op(DB, 'submit', `${AL}, '${id}', '{}'`); assert.strictEqual(g.ok, true); assert.strictEqual(g.score, 100, 'graded with the saved answers once the fault is gone');
  });
  await t('Recovery is deterministic: once the fault is gone the next call grades it with the answers saved in time, and the audit row keeps the failure count', () => {
    const st = op(DB, 'status', `${AF}, '${EF}'`);
    const w = row(IDF); assert.ok(w.submitted_at); assert.strictEqual(w.expired, true); assert.strictEqual(w.score, 50, 'only the answer saved before the deadline');
    assert.strictEqual(q1(DB, `select after from academy_events where entity_id = '${IDF}' and action = 'expire_attempt'`).after.earlier_failures, 3, 'status, start and the expired submit each retried');
    assert.strictEqual(st.attempts[0].grading_failed, false); assert.strictEqual(st.reason, 'cooldown', 'the cooldown runs from its deadline: ' + JSON.stringify(st));
  });
  await t('Submit before the deadline when grading fails: ok:false / grading_failed; the answers are kept; the attempt stays open; a later submit grades it', () => {
    const L = learnerAt(DB, HQ, 'eleven@test.example', '111112'); const E = enroll(DB, L, V.v); const AL = `'learner:${L}'`;
    const s = op(DB, 'start', `${AL}, '${E}'`); assert.strictEqual(s.ok, true);
    op(DB, 'save', `${AL}, '${s.attempt_id}', ${J({ [V.qs[0]]: 'a' })}`);
    refuse('submit_attempt');
    const r = op(DB, 'submit', `${AL}, '${s.attempt_id}', ${J({ [V.qs[1]]: 'a' })}`);
    assert.strictEqual(r.ok, false); assert.strictEqual(r.reason, 'grading_failed'); assert.strictEqual(r.recorded, true); assert.strictEqual(r.expired, false);
    const v = op(DB, 'view', `${AL}, '${s.attempt_id}'`); assert.strictEqual(v.open, true); assert.deepStrictEqual(v.answers, { [V.qs[0]]: 'a', [V.qs[1]]: 'a' }, 'the sent answer was saved');
    assert.strictEqual(evs(s.attempt_id, 'submit_failed'), 1);
    refuse('');
    const g = op(DB, 'submit', `${AL}, '${s.attempt_id}', '{}'`); assert.strictEqual(g.ok, true); assert.strictEqual(g.score, 100);
  });
  run(DB, `drop trigger zz_test_refuse_events on academy_events; drop function public.zz_test_refuse_events(); alter database ${DB} reset zz.refuse`);

  await t('Attempts never change learner, enrollment, start or deadline — not even as the owner with the marker', () => {
    assert.match(tryRun(DB, asOwner(`update academy_attempts set expires_at = expires_at + interval '1 day' where id = '${AT}'`)).err, /never change/);
    assert.match(tryRun(DB, `update academy_attempts set score = 100 where id = '${AT}'`).err, /audited operation/);
  });
  await t('Rollback is refused while attempts exist; on a clean database it removes M6 and gives the server its rights back', () => {
    assert.match(tryRun(DB, fs.readFileSync(RB, 'utf8')).err, /refused/);
    base(DB2, true);
    const out = file(DB2, RB); assert.match(out, /\|t$/m, out);
    assert.ok(tryRun(DB2, `select 1 from pg_attribute where attrelid = 'public.academy_attempts'::regclass and attname = 'learner_id'`).out === '', 'column gone');
    const again = file(DB2, MIG); assert.strictEqual(again.split('\n').filter(l => l.endsWith('|t')).length, 8, 'reinstalls cleanly');
  });
} finally {
  for (const d of [DB, DB2]) { try { run('postgres', `drop database if exists ${d}`); } catch (e) { /* ignore */ } }
  console.log(`\nacademy-m6.pg: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}
})();
