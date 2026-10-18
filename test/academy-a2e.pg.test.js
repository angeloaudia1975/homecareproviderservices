/* HCPS Academy A2E — the learner exam API and the Training Manager's exam view against the REAL database rules.
   A local Postgres holds A1, M1–M5 and M6 exactly as committed (pg-safeupdate loaded); the real academy-api.js handler
   runs unchanged; its Supabase calls are answered by test/academy-pgrest.js (real database functions, real tables).
     PGHOST=127.0.0.1 PGUSER=postgres PGPASSWORD=… node test/academy-a2e.pg.test.js */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { shim, BASE } = require('./academy-pgrest.js');

const PSQL = process.env.PGTEST_PSQL || 'psql';
const SUP = f => path.join(__dirname, '..', 'supabase', f);
const psql = (db, args) => spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db].concat(args), { encoding: 'utf8' });
const run = (db, sql) => { const r = psql(db, ['-c', sql]); if (r.error || r.status !== 0) throw new Error((r.error && r.error.message) || r.stderr); return r.stdout.trim(); };
const file = (db, f) => { const r = psql(db, ['-f', f]); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
try { run('postgres', 'select 1'); } catch (e) { console.log('SKIP: no Postgres (' + String(e.message).split('\n')[0] + ')'); process.exit(0); }
const NO_SAFEUPDATE = process.env.PGTEST_NO_SAFEUPDATE === '1';
const fixture = () => { let s = fs.readFileSync(path.join(__dirname, 'academy', 'fixture.sql'), 'utf8'); if (NO_SAFEUPDATE) s = s.replace(/^do \$\$ begin execute format\('alter database %I set session_preload_libraries.*$/m, ''); return s; };
const J = v => `$j$${JSON.stringify(v)}$j$::jsonb`;
const PRES = `'staff:admin@test.example'`;
const HQ = '00000000-0000-0000-0000-0000000000a1', NORTH = '00000000-0000-0000-0000-0000000000a2', OTHER = '00000000-0000-0000-0000-0000000000b1';
const DUID = '00000000-0000-0000-0000-00000000dddd';
const ORIGIN = 'https://www.homecareproviderservices.org', P360 = 'https://hcpsonlineordering.netlify.app';

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + String(e && e.stack || e).split('\n').slice(0, 8).join('\n       ')); } }

const DB = 'academy_a2e_' + process.pid;
run('postgres', `drop database if exists ${DB}`); run('postgres', `create database ${DB}`);
run(DB, fixture());
run(DB, `alter table public.dealers add column is_test boolean not null default false;
         create table public.dealer_users (uid uuid primary key, email text, dealer_id uuid references public.dealers(id), status text);
         insert into auth.users (id, email) values ('${DUID}', 'buyer@hqmed.example');
         insert into public.dealer_users values ('${DUID}', 'buyer@hqmed.example', '${HQ}', 'approved');`);
file(DB, SUP('academy_a1_foundation.sql'));
run(DB, 'grant all on all tables in schema public to service_role');
for (const f of ['academy_a2a_m1_audited_ops.sql', 'academy_a2c_m2_content_ops.sql', 'academy_a2d_m3_author_ops.sql', 'academy_a2d_m3_1_save_lesson.sql', 'academy_c2_m4_publish_ops.sql', 'academy_a2b_m5_learner_access.sql', 'academy_a2e_m6_exam_attempts.sql']) file(DB, SUP(f));
const flags = f => run(DB, `insert into app_settings (key, value) values ('phase2_flags', ${J(f)}) on conflict (key) do update set value = excluded.value`);
flags({ academy_admin: true });
// a published course with one lesson holding a practice check and an exam question that must never leak
const one = q => JSON.parse(run(DB, `select coalesce(to_jsonb(x), 'null') from (${q}) x`));
const C = JSON.parse(run(DB, `select academy_content_op_create_course(${PRES}, null, ${J({ slug: 'golden-like', title: 'Golden Lift Chair Sales Certification', course_type: 'hcps_certification', manufacturer_slug: 'golden-technologies' })})`)).id;
const V = JSON.parse(run(DB, `select academy_content_op_create_version(${PRES}, null, '${C}', '{"exam_questions":1}')`)).id;
const M = JSON.parse(run(DB, `select academy_content_op_create_module(${PRES}, null, '${V}', ${J({ title: 'Module A' })})`)).id;
const QX = JSON.parse(run(DB, `select academy_author_op_create_question(${PRES}, null, '${V}', ${J({ module_id: M, kind: 'single', use: 'exam', prompt: 'Exam Q?', choices: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], answer_key: 'b', explanation: 'EXAM-SECRET', objective_tags: ['t'] })})`)).id;
const QP = JSON.parse(run(DB, `select academy_author_op_create_question(${PRES}, null, '${V}', ${J({ module_id: M, kind: 'single', use: 'practice', prompt: 'Practice Q?', choices: [{ id: 'a', text: 'Right' }, { id: 'b', text: 'Wrong' }], answer_key: 'a', explanation: 'Because A.', objective_tags: ['t'] })})`)).id;
const QP2 = JSON.parse(run(DB, `select academy_author_op_create_question(${PRES}, null, '${V}', ${J({ module_id: M, kind: 'single', use: 'practice', prompt: 'Second practice?', choices: [{ id: 'a', text: 'Yes' }, { id: 'b', text: 'No' }], answer_key: 'b', explanation: 'Because B.', objective_tags: ['t'] })})`)).id;
const L1 = JSON.parse(run(DB, `select academy_content_op_create_lesson(${PRES}, null, '${M}', ${J({ title: 'Lesson one', est_minutes: 10 })})`)).id;
run(DB, `select academy_author_op_set_blocks(${PRES}, '${L1}', ${J([{ kind: 'text', heading: 'Hello', body: 'Welcome.' }, { kind: 'check', question_ids: [QP, QP2] }, { kind: 'text', heading: 'Bye', body: 'Done.' }])})`);
run(DB, `select academy_content_op_move_version(${PRES}, '${V}', 'in_review')`); run(DB, `select academy_publish_op_publish_version(${PRES}, '${V}', null)`);

const mails = [], jobs = [], pendingJobs = [], outcomes = []; let providerDelay = 0, providerFails = false, workerDown = false;
const S = shim({ db: DB, psql: PSQL, tokens: { pres: 'admin@test.example', adm: 'admin2@test.example', buyer: { id: DUID, email: 'buyer@hqmed.example' } },
  passthrough: async (url, o) => { if (String(url) === 'https://api.resend.com/emails') { if (providerDelay) await new Promise(r => setTimeout(r, providerDelay)); if (providerFails) return new Response('{}', { status: 500 }); mails.push(JSON.parse(o.body)); return new Response('{"id":"x"}', { status: 200 }); } if (String(url).endsWith('/.netlify/functions/academy-mail-background')) { jobs.push(o.body); if (workerDown) return new Response('', { status: 503 }); pendingJobs.push(require('../netlify/functions/academy-mail-background.js')._run({ httpMethod: 'POST', body: o.body }).then(x => { outcomes.push(x); return x; })); return new Response(null, { status: 202 }); } return new Response('{}', { status: 599 }); } });
run(DB, "insert into staff_users (email, name, role, active) values ('admin2@test.example', 'Second Admin', 'admin', true)");
process.env.SUPABASE_URL = BASE; process.env.SUPABASE_SERVICE_ROLE = 'svc-test-key';
process.env.ACADEMY_SESSION_SECRET = 'test-secret-0123456789-abcdefghijklmnopqrstuvwxyz-0123';
process.env.RESEND_API_KEY = 're_test'; process.env.ACADEMY_SIGNIN_FLOOR_MS = process.env.ACADEMY_SIGNIN_FLOOR_MS || '40'; process.env.ACADEMY_MAIL_FROM = 'HCPS Academy <academy@test.example>';
global.fetch = S.fetch;
const API = require('../netlify/functions/academy-api.js');
const HAND = require('../netlify/functions/academy-handoff.js');
const ADMIN = require('../netlify/functions/academy-admin-api.js');

const cookieOf = out => { const c = ((out.multiValueHeaders || {})['set-cookie'] || [])[0] || ''; return c.split(';')[0]; };
async function call(handler, body, o) {
  o = o || {};
  const headers = Object.assign({ origin: ORIGIN, 'x-academy-request': '1', 'x-nf-client-connection-ip': o.ip || '203.0.113.7' }, o.cookie ? { cookie: o.cookie } : {}, o.headers || {});
  const t0 = Date.now();
  const out = await handler({ httpMethod: o.method || 'POST', headers, body: JSON.stringify(body || {}), queryStringParameters: o.query || {} });
  const ms = Date.now() - t0;
  await Promise.all(pendingJobs.splice(0));   // the background mail worker finishes AFTER the answer, as on Netlify
  let j = null; try { j = out.body ? JSON.parse(out.body) : null; } catch (e) { j = out.body; }
  return { status: out.statusCode, body: j, cookie: cookieOf(out), raw: out, ms };
}
const learner = (body, cookie, o) => call(API.handler, body, Object.assign({ cookie }, o || {}));
const admin = (tok, body) => call(ADMIN.handler, body, { headers: { authorization: 'Bearer ' + tok, 'x-academy-request': undefined } });
const lastCode = to => { const m = mails.filter(x => x.to[0] === to).pop(); return m && (/is your HCPS Academy sign-in code/.test(m.subject) ? m.subject.slice(0, 6) : null); };
async function signIn(addr, ip) {
  mails.length = 0;
  const r = await learner({ action: 'request_code', email: addr }, null, { ip }); assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const code = lastCode(addr); assert.ok(code, 'a code was emailed to ' + addr);
  const v = await learner({ action: 'verify_code', email: addr, code }, null, { ip }); assert.strictEqual(v.status, 200, JSON.stringify(v.body));
  assert.match(v.raw.multiValueHeaders['set-cookie'][0], /^__Host-hcps_academy=[^;]+; Path=\/; Max-Age=28800; HttpOnly; Secure; SameSite=Strict$/);
  return v.cookie;
}

(async () => {
  let TMC, LC, LID, ENR, AT;
  try {
    flags({ academy_admin: true, academy_learner: true, academy_invites: true });
    await admin('pres', { action: 'invite_learner', dealer_id: HQ, email: 'tm@hqmed.example', role: 'training_manager' });
    TMC = await signIn('tm@hqmed.example', '198.51.100.1');
    await learner({ action: 'invite', dealer_id: NORTH, email: 'pat@north.example', full_name: 'Pat Learner' }, TMC);
    LC = await signIn('pat@north.example', '198.51.100.2');
    LID = (await learner({ action: 'me' }, LC)).body.learner.id;
    ENR = (await learner({ action: 'enroll', learner_id: LID, version_id: V }, TMC)).body.enrollment.id;

    await t('Switch off: the exam actions answer flag_off and my courses says exams are closed; nothing is written', async () => {
      for (const action of ['exam_status', 'exam_start']) assert.strictEqual((await learner({ action, enrollment_id: ENR }, LC)).body.error, 'flag_off');
      assert.strictEqual((await learner({ action: 'my_courses' }, LC)).body.exams_open, false);
      assert.strictEqual(run(DB, 'select count(*) from academy_attempts'), '0');
      flags({ academy_admin: true, academy_learner: true, academy_invites: true, academy_exams: true });
    });
    await t('Status: the policy (questions, pass mark, time limit, cooldown, daily limit) and that the exam can start', async () => {
      const r = await learner({ action: 'exam_status', enrollment_id: ENR }, LC);
      assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.strictEqual(r.body.can_start, true);
      assert.deepStrictEqual(r.body.policy, { questions: 1, pass_mark: 80, time_limit_minutes: 45, cooldown_minutes: 60, daily_limit: 3, version_published: true });
      assert.strictEqual((await learner({ action: 'my_courses' }, LC)).body.exams_open, true);
    });
    await t('Start + view: the question and its choices, never the answer key or explanation; GET and someone else\'s enrollment refused', async () => {
      assert.strictEqual((await call(API.handler, null, { method: 'GET', cookie: LC, query: { action: 'exam_start', enrollment_id: ENR } })).status, 405);
      assert.strictEqual((await learner({ action: 'exam_start', enrollment_id: ENR }, TMC)).status, 404, 'not the TM\'s enrollment');
      const s = await learner({ action: 'exam_start', enrollment_id: ENR }, LC); assert.strictEqual(s.status, 200, JSON.stringify(s.body)); AT = s.body.attempt_id;
      const v = await learner({ action: 'exam_view', attempt_id: AT }, LC); const txt = JSON.stringify(v.body);
      assert.strictEqual(v.body.questions.length, 1); assert.strictEqual(v.body.questions[0].prompt, 'Exam Q?');
      assert.ok(!/answer_key|EXAM-SECRET|explanation/.test(txt), 'no key or explanation in the exam payload');
      assert.strictEqual((await learner({ action: 'exam_view', attempt_id: AT }, TMC)).status, 403, 'a TM never opens an employee\'s exam');
      const again = await learner({ action: 'exam_start', enrollment_id: ENR }, LC);
      assert.strictEqual(again.status, 409); assert.strictEqual(again.body.error, 'open_attempt'); assert.ok(again.body.next_at);
    });
    await t('Save, resume and submit: answers kept between screens; the result is score, pass/fail and topics only', async () => {
      assert.strictEqual((await learner({ action: 'exam_save', attempt_id: AT, answers: { [QX]: 'z' } }, LC)).status, 400);
      assert.strictEqual((await learner({ action: 'exam_save', attempt_id: AT, answers: 'b' }, LC)).status, 400);
      assert.strictEqual((await learner({ action: 'exam_save', attempt_id: AT, answers: { [QX]: 'a' } }, LC)).body.answered, 1);
      assert.deepStrictEqual((await learner({ action: 'exam_view', attempt_id: AT }, LC)).body.answers, { [QX]: 'a' });
      const r = await learner({ action: 'exam_submit', attempt_id: AT, answers: { [QX]: 'b' } }, LC);
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.deepStrictEqual(r.body, { ok: true, expired: false, score: 100, passed: true, study_topics: [] });
      assert.strictEqual((await learner({ action: 'exam_submit', attempt_id: AT, answers: {} }, LC)).status, 400, 'never twice');
    });
    await t('Cooldown: the next start is refused (409) with when it is allowed; status says the same', async () => {
      const r = await learner({ action: 'exam_start', enrollment_id: ENR }, LC);
      assert.strictEqual(r.status, 409); assert.strictEqual(r.body.error, 'cooldown');
      const wait = Date.parse(r.body.next_at) - Date.now(); assert.ok(wait > 59 * 60e3 && wait <= 60 * 60e3, String(wait));
      const s = await learner({ action: 'exam_status', enrollment_id: ENR }, LC);
      assert.strictEqual(s.body.can_start, false); assert.strictEqual(s.body.attempts.length, 1); assert.strictEqual(s.body.attempts[0].score, 100);
    });
    await t('Training Manager: sees passed / not passed and the number of attempts — never a score', async () => {
      const team = await learner({ action: 'team' }, TMC);
      const pat = team.body.roster.find(p => p.email === 'pat@north.example');
      assert.deepStrictEqual(Object.keys(pat.courses[0].exam).sort(), ['attempts', 'last_at', 'passed']);
      assert.strictEqual(pat.courses[0].exam.passed, true); assert.strictEqual(pat.courses[0].exam.attempts, 1);
      assert.ok(!/score/.test(JSON.stringify(team.body)), 'no score anywhere in the team view');
    });
    await t('Ending access stops the exam at once (the session ends; a new session cannot reach the old enrollment)', async () => {
      const mem = (await learner({ action: 'team' }, TMC)).body.roster.find(p => p.email === 'pat@north.example').membership_id;
      assert.strictEqual((await learner({ action: 'deactivate', membership_id: mem, reason: 'left' }, TMC)).status, 200);
      assert.strictEqual((await learner({ action: 'exam_status', enrollment_id: ENR }, LC)).status, 401);
    });
  } finally {
    try { run('postgres', `drop database if exists ${DB}`); } catch (e) { /* ignore */ }
    console.log(`\nacademy-a2e.pg: ${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  }
})();
