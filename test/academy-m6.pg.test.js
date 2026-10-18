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
const enroll = (db, l, v) => json(run(db, `select academy_enroll_op_enroll(${PRES}, '${l}', '${v}', null)`)).id;
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
