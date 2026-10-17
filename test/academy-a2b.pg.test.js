/* HCPS Academy A2B — the learner API, Partner 360 entry and HCPS learner actions against the REAL database rules.
   A local Postgres holds A1, M1–M4 and M5 exactly as committed (pg-safeupdate loaded); the real academy-api.js,
   academy-handoff.js and academy-admin-api.js handlers run unchanged; their Supabase calls are answered by
   test/academy-pgrest.js (real database functions, real tables). Emails are captured, never sent.
     PGHOST=127.0.0.1 PGUSER=postgres PGPASSWORD=… node test/academy-a2b.pg.test.js */
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

const DB = 'academy_a2b_' + process.pid;
run('postgres', `drop database if exists ${DB}`); run('postgres', `create database ${DB}`);
run(DB, fixture());
run(DB, `alter table public.dealers add column is_test boolean not null default false;
         create table public.dealer_users (uid uuid primary key, email text, dealer_id uuid references public.dealers(id), status text);
         insert into auth.users (id, email) values ('${DUID}', 'buyer@hqmed.example');
         insert into public.dealer_users values ('${DUID}', 'buyer@hqmed.example', '${HQ}', 'approved');`);
file(DB, SUP('academy_a1_foundation.sql'));
run(DB, 'grant all on all tables in schema public to service_role');
for (const f of ['academy_a2a_m1_audited_ops.sql', 'academy_a2c_m2_content_ops.sql', 'academy_a2d_m3_author_ops.sql', 'academy_a2d_m3_1_save_lesson.sql', 'academy_c2_m4_publish_ops.sql', 'academy_a2b_m5_learner_access.sql']) file(DB, SUP(f));
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
  let TMC, LC, LID, ENR;
  try {
    await t('Switch off: every learner action, the sign-in actions and the Partner 360 entry answer flag_off / disabled; nothing is written', async () => {
      assert.strictEqual((await learner({ action: 'request_code', email: 'a@b.co' })).body.error, 'flag_off');
      assert.deepStrictEqual((await call(HAND.handler, { action: 'status' }, { headers: { origin: P360 } })).body, { enabled: false });
      assert.strictEqual((await call(HAND.handler, { action: 'mint' }, { headers: { origin: P360, authorization: 'Bearer buyer' } })).body.error, 'flag_off');
      assert.strictEqual(run(DB, 'select count(*) from academy_login_codes'), '0');
      flags({ academy_admin: true, academy_learner: true });
    });
    await t('HCPS invitations need academy_invites; then HCPS invites a Training Manager (email captured, no sign-in link in it)', async () => {
      assert.strictEqual((await admin('pres', { action: 'invite_learner', dealer_id: HQ, email: 'tm@hqmed.example', role: 'training_manager' })).body.error, 'flag_off');
      flags({ academy_admin: true, academy_learner: true, academy_invites: true });
      mails.length = 0;
      const r = await admin('pres', { action: 'invite_learner', dealer_id: HQ, email: 'tm@hqmed.example', full_name: 'Terry Manager', role: 'training_manager' });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.strictEqual(r.body.email_sent, true);
      assert.ok(mails[0] && /invited you to the HCPS Training/.test(mails[0].text) && !/code|token|#/.test(mails[0].html.replace(/6-digit code/, '')), 'the invitation never carries a credential');
      assert.strictEqual((await admin('adm', { action: 'invite_learner', dealer_id: HQ, email: 'x@hqmed.example' })).status, 200, 'any HCPS administrator invites');
    });
    await t('Sign-in: the same answer for a known and an unknown address; the code is emailed only to the known one; the session cookie is HttpOnly, Secure, SameSite=Strict, __Host-', async () => {
      mails.length = 0;
      const a = await learner({ action: 'request_code', email: 'nobody@example.com' });
      assert.strictEqual(a.status, 200); assert.strictEqual(mails.length, 0, 'no email for an unknown address');
      TMC = await signIn('tm@hqmed.example');
      const b = await learner({ action: 'request_code', email: 'tm@hqmed.example' });
      assert.strictEqual(b.body.message, a.body.message, 'no difference a visitor could read');
      const me = await learner({ action: 'me' }, TMC); assert.strictEqual(me.body.training_manager, true); assert.strictEqual(me.body.memberships[0].dealer, 'HQ Medical');
    });
    await t('Wrong code, bad shapes, GET and cross-site requests are refused; the code never appears in a response', async () => {
      mails.length = 0; await learner({ action: 'request_code', email: 'tm@hqmed.example' }); const code = lastCode('tm@hqmed.example');
      const wrong = await learner({ action: 'verify_code', email: 'tm@hqmed.example', code: code === '000000' ? '000001' : '000000' });
      assert.strictEqual(wrong.status, 400); assert.strictEqual(wrong.body.error, 'wrong_code'); assert.ok(!JSON.stringify(wrong.body).includes(code));
      assert.strictEqual((await learner({ action: 'verify_code', email: 'tm@hqmed.example', code: '12' })).status, 400);
      assert.strictEqual((await call(API.handler, null, { method: 'GET', query: { action: 'request_code', email: 'tm@hqmed.example' } })).status, 405);
      assert.strictEqual((await learner({ action: 'request_code', email: 'tm@hqmed.example' }, null, { headers: { origin: 'https://evil.example' } })).status, 403);
      assert.strictEqual((await learner({ action: 'request_code', email: 'tm@hqmed.example' }, null, { headers: { 'x-academy-request': undefined } })).status, 403);
    });
    await t('Training Manager: invites employees of their own dealership (and branches); never another dealership; the team view shows only their dealership', async () => {
      const inv = await learner({ action: 'invite', dealer_id: NORTH, email: 'pat@north.example', full_name: 'Pat Learner' }, TMC);
      assert.strictEqual(inv.status, 200, JSON.stringify(inv.body));
      assert.strictEqual((await learner({ action: 'invite', dealer_id: OTHER, email: 'spy@other.example' }, TMC)).status, 403);
      await admin('pres', { action: 'invite_learner', dealer_id: OTHER, email: 'outsider@other.example' });
      const team = await learner({ action: 'team' }, TMC);
      assert.deepStrictEqual(team.body.dealers.map(d => d.id).sort(), [HQ, NORTH].sort());
      assert.ok(team.body.invites.some(i => i.email === 'pat@north.example') && !team.body.invites.some(i => i.email === 'outsider@other.example'));
    });
    await t('An invited employee signs in with a code; they get no Training Manager actions; their cookie is refused by Connect 360', async () => {
      LC = await signIn('pat@north.example');
      const me = await learner({ action: 'me' }, LC); LID = me.body.learner.id;
      assert.strictEqual(me.body.training_manager, false); assert.strictEqual(me.body.memberships[0].access_type, 'training_only');
      assert.strictEqual((await learner({ action: 'team' }, LC)).status, 403);
      assert.strictEqual((await learner({ action: 'invite', dealer_id: NORTH, email: 'friend@north.example' }, LC)).status, 403);
      const c360 = await call(ADMIN.handler, { action: 'overview' }, { cookie: LC });
      assert.strictEqual(c360.status, 401, 'the Academy session is not a Connect 360 sign-in');
    });
    await t('Enrollment by the Training Manager into the published version; the learner sees it; the lesson has no answer key or exam content; practice is graded on the server', async () => {
      const cs = await learner({ action: 'courses' }, TMC); assert.strictEqual(cs.body.courses.length, 1);
      const e = await learner({ action: 'enroll', learner_id: LID, version_id: V }, TMC); assert.strictEqual(e.status, 200, JSON.stringify(e.body)); ENR = e.body.enrollment.id;
      const mine = await learner({ action: 'my_courses' }, LC);
      assert.strictEqual(mine.body.courses.length, 1); assert.strictEqual(mine.body.courses[0].next_lesson_id, L1);
      const les = await learner({ action: 'lesson', enrollment_id: ENR, lesson_id: L1 }, LC); assert.strictEqual(les.status, 200, JSON.stringify(les.body));
      const s = JSON.stringify(les.body);
      assert.ok(!/answer_key|EXAM-SECRET|Because A\.|Because B\.|Exam Q\?/.test(s), 'no answer key, no explanation, no exam question');
      assert.ok(!('warnings' in les.body.lesson), 'no staff authoring notes');
      const right = await learner({ action: 'practice_check', enrollment_id: ENR, lesson_id: L1, question_id: QP, answer: 'a' }, LC);
      assert.deepStrictEqual(right.body, { ok: true, correct: true, explanation: 'Because A.' });
      assert.strictEqual((await learner({ action: 'practice_check', enrollment_id: ENR, lesson_id: L1, question_id: QX, answer: 'b' }, LC)).status, 404, 'an exam question is never checked');
      assert.strictEqual((await learner({ action: 'lesson', enrollment_id: ENR, lesson_id: L1 }, TMC)).status, 404, 'someone else\'s enrollment is not found');
    });
    await t('Progress is saved and resumed; completion sticks; the Training Manager sees lessons completed (no scores)', async () => {
      assert.strictEqual((await learner({ action: 'save_progress', enrollment_id: ENR, lesson_id: L1, status: 'viewed', resume_block: 2 }, LC)).status, 200);
      assert.deepStrictEqual((await learner({ action: 'lesson', enrollment_id: ENR, lesson_id: L1 }, LC)).body.progress, { status: 'viewed', resume_block: 2 });
      await learner({ action: 'save_progress', enrollment_id: ENR, lesson_id: L1, status: 'completed', resume_block: 2 }, LC);
      assert.strictEqual((await learner({ action: 'save_progress', enrollment_id: ENR, lesson_id: L1, status: 'viewed', resume_block: 0 }, LC)).body.progress.status, 'completed');
      const team = await learner({ action: 'team' }, TMC);
      const pat = team.body.roster.find(p => p.email === 'pat@north.example');
      assert.strictEqual(pat.courses[0].lessons_completed, 1); assert.ok(!/score|passed/.test(JSON.stringify(pat)));
      assert.strictEqual((await learner({ action: 'save_progress', enrollment_id: ENR, lesson_id: L1, status: 'viewed', resume_block: 2 }, TMC)).status, 403, 'nobody saves another person\'s progress');
    });
    await t('Ending access ends the live session on the very next request; sign-out ends this session; a forged or old-format cookie is refused', async () => {
      const mem = (await learner({ action: 'team' }, TMC)).body.roster.find(p => p.email === 'pat@north.example').membership_id;
      assert.strictEqual((await learner({ action: 'me' }, LC)).status, 200);
      assert.strictEqual((await learner({ action: 'deactivate', membership_id: mem, reason: 'left' }, TMC)).status, 200);
      const after = await learner({ action: 'me' }, LC); assert.strictEqual(after.status, 401); assert.match(after.raw.multiValueHeaders['set-cookie'][0], /Max-Age=0/);
      assert.strictEqual((await learner({ action: 'reactivate', learner_id: LID, dealer_id: NORTH }, TMC)).status, 200);
      LC = await signIn('pat@north.example');
      const out = await learner({ action: 'sign_out' }, LC); assert.match(out.raw.multiValueHeaders['set-cookie'][0], /Max-Age=0/);
      assert.strictEqual((await learner({ action: 'me' }, LC)).status, 401, 'the old cookie is dead after sign-out');
      const [name, val] = TMC.split('='); const forged = name + '=' + val.slice(0, -2) + (val.slice(-2) === 'AA' ? 'BB' : 'AA');
      assert.strictEqual((await learner({ action: 'me' }, forged)).status, 401);
      const S1 = require('../netlify/functions/_academy_session.js');
      const p = Buffer.from(JSON.stringify({ v: 1, sub: LID, uid: DUID, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url');
      assert.strictEqual(S1.verify(p + '.x'), null, 'a v1 value never verifies');
    });
    await t('Partner 360: status shows enabled only with academy_handoff; mint needs the Partner 360 origin and an approved login; the URL carries the code in its fragment; one redemption only', async () => {
      assert.deepStrictEqual((await call(HAND.handler, { action: 'status' }, { headers: { origin: P360 } })).body, { enabled: false });
      flags({ academy_admin: true, academy_learner: true, academy_invites: true, academy_handoff: true });
      assert.deepStrictEqual((await call(HAND.handler, { action: 'status' }, { headers: { origin: P360 } })).body, { enabled: true });
      assert.strictEqual((await call(HAND.handler, { action: 'mint' }, { headers: { origin: ORIGIN, authorization: 'Bearer buyer' } })).status, 403, 'only from Partner 360');
      assert.strictEqual((await call(HAND.handler, { action: 'mint' }, { headers: { origin: P360 } })).status, 401);
      const m = await call(HAND.handler, { action: 'mint' }, { headers: { origin: P360, authorization: 'Bearer buyer' } });
      assert.strictEqual(m.status, 200, JSON.stringify(m.body)); assert.match(m.body.url, /^https:\/\/www\.homecareproviderservices\.org\/academy\/#handoff=[A-Za-z0-9_-]{43}$/);
      assert.strictEqual(m.raw.headers['access-control-allow-origin'], P360);
      const code = m.body.url.split('#handoff=')[1];
      assert.strictEqual(run(DB, `select count(*) from academy_handoff_codes where code_hash = '${code}'`), '0', 'the code itself is never stored');
      const r = await learner({ action: 'handoff_redeem', code }); assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      const me = await learner({ action: 'me' }, r.cookie); assert.strictEqual(me.body.learner.email, 'buyer@hqmed.example'); assert.strictEqual(me.body.memberships[0].access_type, 'dealer_user');
      assert.strictEqual((await learner({ action: 'handoff_redeem', code })).body.error, 'expired', 'a replay is refused');
      run(DB, `update dealer_users set status = 'suspended' where uid = '${DUID}'`);
      assert.strictEqual((await call(HAND.handler, { action: 'mint' }, { headers: { origin: P360, authorization: 'Bearer buyer' } })).status, 403, 'an unapproved Partner 360 login gets no Training link');
    });
    await t('HCPS: suspend a learner (sessions end), enroll and withdraw through Connect 360; every change is in the audit trail with the signed-in actor', async () => {
      const L2 = await signIn('x@hqmed.example'); const lid = (await learner({ action: 'me' }, L2)).body.learner.id;
      assert.strictEqual((await admin('pres', { action: 'set_learner_status', learner_id: lid, status: 'suspended', reason: 'check' })).status, 200);
      assert.strictEqual((await learner({ action: 'me' }, L2)).status, 401);
      await admin('pres', { action: 'set_learner_status', learner_id: lid, status: 'active', reason: 'ok' });
      const e = await admin('adm', { action: 'enroll_learner', learner_id: lid, version_id: V }); assert.strictEqual(e.status, 200, JSON.stringify(e.body));
      assert.strictEqual((await admin('adm', { action: 'withdraw_enrollment', enrollment_id: e.body.enrollment.id, reason: 'mistake' })).status, 200);
      const ev = one(`select string_agg(distinct actor, ',' order by actor) as a from academy_events where action in ('enroll','withdraw','set_learner_status')`).a;
      assert.ok(ev.includes('staff:admin2@test.example') && ev.includes('staff:admin@test.example') && ev.includes('learner:'), ev);
    });
    await t('Layered checks hold on their own: the sign-in answer is byte-identical for known and unknown addresses; TM invitations need academy_invites; a TM is refused another dealership by the server first; a validly signed cookie without a session row id is refused', async () => {
      run(DB, `delete from academy_login_codes where true`);
      const unknown = await learner({ action: 'request_code', email: 'ghost@example.com' }, null, { ip: '198.51.100.20' });
      const known = await learner({ action: 'request_code', email: 'tm@hqmed.example' }, null, { ip: '198.51.100.21' });
      assert.deepStrictEqual(known.body, unknown.body, 'nothing in the answer tells the two apart');
      TMC = await signIn('tm@hqmed.example', '198.51.100.22');
      flags({ academy_admin: true, academy_learner: true, academy_handoff: true });
      const off = await learner({ action: 'invite', dealer_id: NORTH, email: 'later@north.example' }, TMC);
      assert.strictEqual(off.status, 403); assert.strictEqual(off.body.error, 'flag_off');
      flags({ academy_admin: true, academy_learner: true, academy_invites: true, academy_handoff: true });
      const other = await learner({ action: 'invite', dealer_id: OTHER, email: 'spy2@other.example' }, TMC);
      assert.strictEqual(other.status, 403); assert.strictEqual(other.body.message, 'That person is not in your dealership.', 'refused by the server before the database');
      const crypto = require('crypto'); const b64 = x => Buffer.from(x).toString('base64url'); const now = Math.floor(Date.now() / 1000);
      const payload = b64(JSON.stringify({ v: 1, sub: LID, iat: now, exp: now + 600 }));
      const sig = b64(crypto.createHmac('sha256', process.env.ACADEMY_SESSION_SECRET).update('hcps-academy-session.v2.' + payload).digest());
      assert.strictEqual(require('../netlify/functions/_academy_session.js').verify(payload + '.' + sig), null, 'a signed value with no session row id never verifies');
    });
    await t('Layered lesson rules hold even if the lesson builder or the lesson check let something through: staff notes are removed, answer keys are never read, an exam question is never graded', async () => {
      run(DB, `delete from academy_login_codes where true`);
      LC = await signIn('pat@north.example', '198.51.100.23');
      const LESSON = require('../netlify/functions/_academy_lesson.js');
      const realBuild = LESSON.buildLesson, realHas = LESSON.lessonHasQuestion; let seen = null;
      LESSON.buildLesson = I => { seen = I; return Object.assign(realBuild(I), { warnings: [{ block: 1, message: 'STAFF NOTE' }] }); };
      LESSON.lessonHasQuestion = () => true;
      try {
        const les = await learner({ action: 'lesson', enrollment_id: ENR, lesson_id: L1 }, LC);
        assert.strictEqual(les.status, 200, JSON.stringify(les.body));
        assert.ok(!('warnings' in les.body.lesson) && !/STAFF NOTE/.test(JSON.stringify(les.body)), 'staff notes never reach a learner');
        assert.ok(seen && seen.questions.length === 2 && seen.questions.every(q => !('answer_key' in q) && !('explanation' in q)), 'answer keys are never even read');
        const ex = await learner({ action: 'practice_check', enrollment_id: ENR, lesson_id: L1, question_id: QX, answer: 'b' }, LC);
        assert.strictEqual(ex.status, 403); assert.strictEqual(ex.body.error, 'not_practice');
      } finally { LESSON.buildLesson = realBuild; LESSON.lessonHasQuestion = realHas; }
    });
    await t('S1 timing: the email provider never sits in the sign-in answer — a known and an unknown address answer in the same time (floor) even with a slow provider; every request hands the worker one sealed envelope of the same size', async () => {
      run(DB, `delete from academy_login_codes where true`);
      process.env.ACADEMY_SIGNIN_FLOOR_MS = '300'; providerDelay = 700; jobs.length = 0; mails.length = 0;
      const known = [], unknown = [];
      try {
        for (let i = 0; i < 2; i++) {
          known.push(await learner({ action: 'request_code', email: 'tm@hqmed.example' }, null, { ip: '198.51.100.' + (40 + i) }));
          unknown.push(await learner({ action: 'request_code', email: 'nobody' + i + '@example.com' }, null, { ip: '198.51.100.' + (50 + i) }));
        }
      } finally { process.env.ACADEMY_SIGNIN_FLOOR_MS = '40'; providerDelay = 0; }
      for (const r of known.concat(unknown)) { assert.strictEqual(r.status, 200); assert.ok(r.ms >= 295 && r.ms < 650, 'answered in ' + r.ms + ' ms (floor 300, provider 700)'); }
      const avg = a => a.reduce((x, r) => x + r.ms, 0) / a.length;
      assert.ok(Math.abs(avg(known) - avg(unknown)) < 120, `known ${avg(known)} ms vs unknown ${avg(unknown)} ms`);
      assert.strictEqual(jobs.length, 4, 'one envelope per request, known or not');
      assert.strictEqual(new Set(jobs.map(j => j.length)).size, 1, 'every envelope has the same length');
      assert.ok(jobs.every(j => { const raw = Buffer.from(j, 'base64url'); return !raw.includes('hqmed') && !raw.includes('nobody'); }), 'nothing readable in an envelope');
      assert.strictEqual(mails.filter(m => m.to[0] === 'tm@hqmed.example').length, 2, 'the known address still gets its code (after the answer)');
      assert.ok(!mails.some(m => /nobody/.test(m.to[0])), 'the unknown address gets nothing');
    });
    await t('S1 delivery failure: a code the provider (or the worker) could not send is burned and does not count, so asking again works; the person is never stranded', async () => {
      run(DB, `delete from academy_login_codes where true`); mails.length = 0;
      providerFails = true;
      try { for (let i = 0; i < 3; i++) assert.strictEqual((await learner({ action: 'request_code', email: 'tm@hqmed.example' }, null, { ip: '198.51.100.60' })).status, 200); }
      finally { providerFails = false; }
      assert.strictEqual(Number(run(DB, `select count(*) from academy_login_codes where email = 'tm@hqmed.example' and undelivered and burned_at is not null`)), 3);
      assert.strictEqual(Number(run(DB, `select count(*) from academy_events where action = 'sign_in_code_undelivered'`)) >= 3, true);
      workerDown = true;
      try { assert.strictEqual((await learner({ action: 'request_code', email: 'tm@hqmed.example' }, null, { ip: '198.51.100.60' })).status, 200); }
      finally { workerDown = false; }
      assert.strictEqual(Number(run(DB, `select count(*) from academy_login_codes where email = 'tm@hqmed.example' and undelivered`)), 4, 'worker unreachable: burned at once too');
      TMC = await signIn('tm@hqmed.example', '198.51.100.60');   // past the 3-per-15-minutes limit only because failures do not count
    });
    await t('S1 worker: only a fresh envelope sealed with the Academy secret is acted on; tampered, foreign, old, replayed envelopes, decoys and GETs send nothing', async () => {
      const W = require('../netlify/functions/academy-mail-background.js'), SS = require('../netlify/functions/_academy_session.js');
      run(DB, `delete from academy_login_codes where true`); mails.length = 0; jobs.length = 0;
      await learner({ action: 'request_code', email: 'tm@hqmed.example' }, null, { ip: '198.51.100.71' });
      const good = jobs[0]; assert.strictEqual(mails.length, 1); const code = lastCode('tm@hqmed.example');
      mails.length = 0;
      const flip = good.slice(0, 40) + (good[40] === 'A' ? 'B' : 'A') + good.slice(41);
      assert.strictEqual(await W._run({ httpMethod: 'POST', body: flip }), 'rejected');
      assert.strictEqual(await W._run({ httpMethod: 'GET', body: good }), 'method');
      const real = process.env.ACADEMY_SESSION_SECRET;
      process.env.ACADEMY_SESSION_SECRET = 'another-secret-0123456789-abcdefghijklmnopqrstuvwxyz';
      const foreign = SS.sealJob({ k: 'code', to: 'tm@hqmed.example', code: '123456', id: '00000000-0000-0000-0000-000000000001', h: '0'.repeat(64) });
      process.env.ACADEMY_SESSION_SECRET = real;
      assert.strictEqual(await W._run({ httpMethod: 'POST', body: foreign }), 'rejected');
      const old = SS.sealJob({ k: 'code', to: 'tm@hqmed.example', code: '123456', id: '00000000-0000-0000-0000-000000000001', h: '0'.repeat(64) }, Date.now() - 10 * 60000);
      assert.strictEqual(await W._run({ httpMethod: 'POST', body: old }), 'rejected');
      assert.strictEqual(await W._run({ httpMethod: 'POST', body: SS.sealJob({ k: 'none', to: 'x', code: '000000', id: '00000000-0000-0000-0000-000000000002', h: '0'.repeat(64) }) }), 'decoy');
      assert.strictEqual(mails.length, 0, 'none of those sent anything');
      assert.strictEqual((await learner({ action: 'verify_code', email: 'tm@hqmed.example', code }, null, { ip: '198.51.100.71' })).status, 200);
      assert.strictEqual(await W._run({ httpMethod: 'POST', body: good }), 'stale', 'a replayed envelope never re-sends a used code');
      assert.strictEqual(mails.length, 0);
      const h = SS.keyedHash('code', 'tm@hqmed.example:999999');
      assert.strictEqual(await W._run({ httpMethod: 'POST', body: SS.sealJob({ k: 'code', to: 'someone@else.example', code: '999999', id: '00000000-0000-0000-0000-000000000003', h }) }), 'stale', 'an envelope for a code that does not exist sends nothing');
    });
    await t('S2 network address: only Netlify\'s x-nf-client-connection-ip counts; X-Forwarded-For / Client-IP never change the bucket; without the Netlify header every request shares one bucket', async () => {
      const L = require('../netlify/functions/_academy_learner.js');
      assert.strictEqual(L.clientIp({ headers: { 'x-forwarded-for': '1.2.3.4', 'client-ip': '5.6.7.8' } }), 'unknown');
      assert.strictEqual(L.clientIp({ headers: { 'x-nf-client-connection-ip': '203.0.113.9', 'x-forwarded-for': '1.2.3.4' } }), '203.0.113.9');
      assert.strictEqual(L.clientIp({ headers: { 'x-nf-client-connection-ip': '1.2.3.4, 5.6.7.8' } }), 'unknown', 'a list is not an address');
      run(DB, `delete from academy_login_codes where true`);
      const spoof = i => ({ headers: { 'x-nf-client-connection-ip': undefined, 'x-forwarded-for': `10.0.${i}.1`, 'client-ip': `10.1.${i}.1` } });
      for (let i = 0; i < 10; i++) assert.strictEqual((await learner({ action: 'request_code', email: `spoof${i}@example.com` }, null, spoof(i))).status, 200);
      assert.strictEqual((await learner({ action: 'request_code', email: 'spoof99@example.com' }, null, spoof(99))).status, 429, 'a new forwarded address does not buy a new bucket');
      run(DB, `delete from academy_login_codes where true`);
      for (let i = 0; i < 10; i++) await learner({ action: 'request_code', email: `same${i}@example.com` }, null, { ip: '198.51.100.80', headers: { 'x-forwarded-for': `10.9.${i}.1` } });
      assert.strictEqual((await learner({ action: 'request_code', email: 'same99@example.com' }, null, { ip: '198.51.100.80', headers: { 'x-forwarded-for': '10.9.99.1' } })).status, 429);
      run(DB, `delete from academy_login_codes where true`);
    });
  } finally {
    try { run('postgres', `drop database if exists ${DB}`); } catch (e) { /* ignore */ }
    console.log(`\nacademy-a2b.pg: ${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  }
})();
