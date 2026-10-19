/* HCPS Academy — Phase 3: dealership training management, end to end through the REAL learner/Training Manager API and
   the REAL database rules (A1, M1–M7 as committed, pg-safeupdate loaded). Proves each Training Manager job works for
   their own dealership (enroll, assign, lesson completion, exam pass/fail + attempts with no score, certificates and
   expiring-soon, remove access) and that every one of them is refused for another dealership — in the API AND, called
   directly, in the database.
     PGHOST=127.0.0.1 PGUSER=postgres PGPASSWORD=… node test/academy-phase3.pg.test.js */
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

const DB = 'academy_ph3_' + process.pid;
run('postgres', `drop database if exists ${DB}`); run('postgres', `create database ${DB}`);
run(DB, fixture());
run(DB, `alter table public.dealers add column is_test boolean not null default false;
         create table public.dealer_users (uid uuid primary key, email text, dealer_id uuid references public.dealers(id), status text);
         insert into auth.users (id, email) values ('${DUID}', 'buyer@hqmed.example');
         insert into public.dealer_users values ('${DUID}', 'buyer@hqmed.example', '${HQ}', 'approved');`);
file(DB, SUP('academy_a1_foundation.sql'));
run(DB, 'grant all on all tables in schema public to service_role');
for (const f of ['academy_a2a_m1_audited_ops.sql', 'academy_a2c_m2_content_ops.sql', 'academy_a2d_m3_author_ops.sql', 'academy_a2d_m3_1_save_lesson.sql', 'academy_c2_m4_publish_ops.sql', 'academy_a2b_m5_learner_access.sql', 'academy_a2e_m6_exam_attempts.sql', 'academy_a2f_m7_certificates.sql']) file(DB, SUP(f));
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
const S = shim({ db: DB, psql: PSQL, tokens: { pres: 'admin@test.example', adm: 'admin2@test.example', own: 'owner@test.example', oldp: 'oldpres@test.example', buyer: { id: DUID, email: 'buyer@hqmed.example' } },
  passthrough: async (url, o) => { if (String(url) === 'https://api.resend.com/emails') { if (providerDelay) await new Promise(r => setTimeout(r, providerDelay)); if (providerFails) return new Response('{}', { status: 500 }); mails.push(JSON.parse(o.body)); return new Response('{"id":"x"}', { status: 200 }); } if (String(url).endsWith('/.netlify/functions/academy-mail-background')) { jobs.push(o.body); if (workerDown) return new Response('', { status: 503 }); pendingJobs.push(require('../netlify/functions/academy-mail-background.js')._run({ httpMethod: 'POST', body: o.body }).then(x => { outcomes.push(x); return x; })); return new Response(null, { status: 202 }); } return new Response('{}', { status: 599 }); } });
run(DB, "insert into staff_users (email, name, role, active) values ('admin2@test.example', 'Second Admin', 'admin', true), ('owner@test.example', 'Owner', 'owner', true), ('oldpres@test.example', 'Former President', 'president', false)");
process.env.SUPABASE_URL = BASE; process.env.SUPABASE_SERVICE_ROLE = 'svc-test-key';
process.env.ACADEMY_SESSION_SECRET = 'test-secret-0123456789-abcdefghijklmnopqrstuvwxyz-0123';
process.env.RESEND_API_KEY = 're_test'; process.env.ACADEMY_SIGNIN_FLOOR_MS = process.env.ACADEMY_SIGNIN_FLOOR_MS || '40'; process.env.ACADEMY_MAIL_FROM = 'HCPS Academy <academy@test.example>';
global.fetch = S.fetch;
const API = require('../netlify/functions/academy-api.js');
const HAND = require('../netlify/functions/academy-handoff.js');
const ADMIN = require('../netlify/functions/academy-admin-api.js');
const VERIFY = require('../netlify/functions/academy-verify.js');

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



const verify = n => call(VERIFY.handler, null, { method: 'GET', query: { n } });
const refused = r => r.status >= 400 && r.status < 500;
const sqlTry = sql => { const r = psql(DB, ['-c', sql]); return { ok: r.status === 0, err: r.stderr }; };
(async () => {
  try {
    flags({ academy_admin: true, academy_learner: true, academy_invites: true, academy_exams: true, academy_certificates: true });
    // HQ (with branch NORTH) and OTHER, each with its own Training Manager; a branch TM at NORTH (D3: branch only)
    await admin('pres', { action: 'invite_learner', dealer_id: HQ, email: 'tm@hqmed.example', role: 'training_manager' });
    await admin('pres', { action: 'invite_learner', dealer_id: OTHER, email: 'tm@other.example', role: 'training_manager' });
    await admin('pres', { action: 'invite_learner', dealer_id: NORTH, email: 'tm@north.example', role: 'training_manager' });
    const TMC = await signIn('tm@hqmed.example', '198.51.100.1'), TM2 = await signIn('tm@other.example', '198.51.100.9'), TMN = await signIn('tm@north.example', '198.51.100.8');
    const me = async c => (await learner({ action: 'me' }, c)).body.learner.id;
    const TMID = await me(TMC), TM2ID = await me(TM2);
    let PID, SID, OID, PE, SE, OE, PM, SM, PC, SC, OC, INV;

    await t('Enroll employees: the HQ TM invites into HQ and its branch; each signs in; Other\'s TM invites into Other', async () => {
      assert.strictEqual((await learner({ action: 'invite', dealer_id: NORTH, email: 'pat@north.example', full_name: 'Pat' }, TMC)).status, 200);
      assert.strictEqual((await learner({ action: 'invite', dealer_id: HQ, email: 'sam@hqmed.example', full_name: 'Sam' }, TMC)).status, 200);
      assert.strictEqual((await learner({ action: 'invite', dealer_id: OTHER, email: 'oz@other.example', full_name: 'Oz' }, TM2)).status, 200);
      INV = (await learner({ action: 'invite', dealer_id: HQ, email: 'later@hqmed.example', full_name: 'Later' }, TMC)).body.invite.id;
      PC = await signIn('pat@north.example', '198.51.100.2'); SC = await signIn('sam@hqmed.example', '198.51.100.3'); OC = await signIn('oz@other.example', '198.51.100.4');
      PID = await me(PC); SID = await me(SC); OID = await me(OC);
      const T = (await learner({ action: 'team' }, TMC)).body;
      PM = T.roster.find(p => p.learner_id === PID).membership_id; SM = T.roster.find(p => p.learner_id === SID).membership_id;
      assert.deepStrictEqual(T.dealers.map(d => d.name).sort(), ['HQ Medical', 'HQ Medical North']);
    });
    await t('Assign courses: the TM sees only published courses and enrolls their own people', async () => {
      const C = (await learner({ action: 'courses' }, TMC)).body.courses; assert.deepStrictEqual(C.map(c => c.version_id), [V]);
      PE = (await learner({ action: 'enroll', learner_id: PID, version_id: V, due_on: '2026-12-31' }, TMC)).body.enrollment.id;
      SE = (await learner({ action: 'enroll', learner_id: SID, version_id: V }, TMC)).body.enrollment.id;
      OE = (await learner({ action: 'enroll', learner_id: OID, version_id: V }, TM2)).body.enrollment.id;
      assert.ok(PE && SE && OE);
    });
    await t('Isolation (API + database): Other\'s TM cannot invite, enroll, withdraw, end, restore access or cancel an invitation at HQ', async () => {
      const tries = [
        ['invite', { action: 'invite', dealer_id: HQ, email: 'x@hqmed.example' }],
        ['enroll', { action: 'enroll', learner_id: SID, version_id: V }],
        ['withdraw', { action: 'withdraw', enrollment_id: SE, reason: 'Not mine to change' }],
        ['deactivate', { action: 'deactivate', membership_id: SM, reason: 'Not mine to change' }],
        ['reactivate', { action: 'reactivate', learner_id: SID, dealer_id: HQ }],
        ['revoke_invite', { action: 'revoke_invite', id: INV, reason: 'Not mine to change' }],
      ];
      for (const [n, b] of tries) { const r = await learner(b, TM2); assert.ok(refused(r), n + ' ' + r.status + ' ' + JSON.stringify(r.body)); }
      assert.strictEqual(run(DB, `select status from academy_enrollments where id = '${SE}'`), 'not_started');
      assert.strictEqual(run(DB, `select status from academy_memberships where id = '${SM}'`), 'active');
      assert.strictEqual(run(DB, `select status from academy_invites where id = '${INV}'`), 'pending');
      // the same refusals straight in the database, with Other's TM as the actor (the API layer bypassed)
      const A2 = `'learner:${TM2ID}'`;
      for (const sql of [`select academy_enroll_op_enroll(${A2}, '${SID}', '${V}', null)`, `select academy_enroll_op_withdraw(${A2}, '${SE}', 'Not mine')`,
                         `select academy_access_op_deactivate(${A2}, '${SM}', 'Not mine')`, `select academy_access_op_revoke_invite(${A2}, '${INV}', 'Not mine')`,
                         `select academy_access_op_invite(${A2}, '${HQ}', 'y@hqmed.example', 'Y', 'learner')`])
        assert.match(sqlTry(sql).err, /Training Manager or HCPS|not active|42501|permission/i, sql);
    });
    await t('Isolation (read): Other\'s TM roster holds no HQ person, enrollment or certificate; a branch TM sees the branch only', async () => {
      const s = JSON.stringify((await learner({ action: 'team' }, TM2)).body);
      for (const id of [PID, SID, PE, SE]) assert.ok(!s.includes(id), id);
      const N = (await learner({ action: 'team' }, TMN)).body;
      assert.deepStrictEqual(N.dealers.map(d => d.name), ['HQ Medical North']);
      assert.ok(N.roster.some(p => p.learner_id === PID) && !N.roster.some(p => p.learner_id === SID), 'branch TM: Pat yes, Sam (HQ) no');
    });
    await t('A TM never appoints a Training Manager and never ends another Training Manager', async () => {
      assert.ok(sqlTry(`select academy_access_op_invite('learner:${TMID}', '${HQ}', 'boss@hqmed.example', 'Boss', 'training_manager')`).ok === false);
      const nm = (await learner({ action: 'team' }, TMC)).body.roster.find(p => p.role === 'training_manager' && p.dealer === 'HQ Medical North');
      assert.ok(refused(await learner({ action: 'deactivate', membership_id: nm.membership_id, reason: 'Trying to end a TM' }, TMC)));
      assert.strictEqual(run(DB, `select status from academy_memberships where id = '${nm.membership_id}'`), 'active');
    });
    await t('Review lesson completion: the roster counts completed lessons per course (viewed does not count)', async () => {
      await learner({ action: 'save_progress', enrollment_id: PE, lesson_id: L1, status: 'viewed', resume_block: 1 }, PC);
      let c = (await learner({ action: 'team' }, TMC)).body.roster.find(p => p.learner_id === PID).courses[0];
      assert.deepStrictEqual([c.lessons_completed, c.lessons_total], [0, 1]);
      await learner({ action: 'save_progress', enrollment_id: PE, lesson_id: L1, status: 'completed', resume_block: 2 }, PC);
      c = (await learner({ action: 'team' }, TMC)).body.roster.find(p => p.learner_id === PID).courses[0];
      assert.deepStrictEqual([c.lessons_completed, c.lessons_total, c.due_on], [1, 1, '2026-12-31']);
    });
    await t('Exam results: pass/fail and attempt count only — never a score, answers or questions', async () => {
      for (const [c, e, ans] of [[PC, PE, 'a'], [SC, SE, 'b']]) {   // Pat fails (key is b), Sam passes
        if (e === SE) await learner({ action: 'save_progress', enrollment_id: SE, lesson_id: L1, status: 'completed', resume_block: 2 }, SC);
        const s = await learner({ action: 'exam_start', enrollment_id: e }, c); assert.strictEqual(s.status, 200, JSON.stringify(s.body));
        assert.strictEqual((await learner({ action: 'exam_submit', attempt_id: s.body.attempt_id, answers: { [QX]: ans } }, c)).status, 200);
      }
      const T = (await learner({ action: 'team' }, TMC)).body; const txt = JSON.stringify(T);
      const pat = T.roster.find(p => p.learner_id === PID).courses[0].exam, sam = T.roster.find(p => p.learner_id === SID).courses[0].exam;
      assert.deepStrictEqual([pat.attempts, pat.passed, sam.attempts, sam.passed], [1, false, 1, true]);
      assert.ok(!/"score"|answer_key|draft_answers|question_ids|EXAM-SECRET/.test(txt), 'nothing but pass/fail and attempts');
      assert.ok(refused(await learner({ action: 'exam_status', enrollment_id: SE }, TMC)), 'a TM never opens an employee\'s exam');
    });
    await t('Certifications: the TM sees Sam\'s HCPS certificate with its validity; expiring soon flagged at 60 days', async () => {
      let c = (await learner({ action: 'team' }, TMC)).body.roster.find(p => p.learner_id === SID).courses[0].certificate;
      assert.ok(c && /^HCPS-/.test(c.cert_number) && c.status === 'valid' && c.expiring_soon === false, JSON.stringify(c));
      assert.strictEqual((await learner({ action: 'team' }, TMC)).body.roster.find(p => p.learner_id === PID).courses[0].certificate, null, 'Pat failed: none');
      run(DB, `begin; set local session_replication_role = replica; update academy_certificates set expires_at = now() + interval '45 days' where learner_id = '${SID}'; commit;`);
      c = (await learner({ action: 'team' }, TMC)).body.roster.find(p => p.learner_id === SID).courses[0].certificate;
      assert.strictEqual(c.expiring_soon, true); assert.ok(c.days_left <= 45);
    });
    await t('Remove access when an employee leaves: session closed at once, courses gone from them, record and certificate kept', async () => {
      const cert = (await learner({ action: 'team' }, TMC)).body.roster.find(p => p.learner_id === SID).courses[0].certificate.cert_number;
      assert.strictEqual((await learner({ action: 'deactivate', membership_id: SM, reason: 'Left the company' }, TMC)).status, 200);
      assert.ok(refused(await learner({ action: 'me' }, SC)), 'the open session no longer works');
      assert.strictEqual(run(DB, `select count(*) from academy_sessions where learner_id = '${SID}' and ended_at is null`), '0');
      const row = (await learner({ action: 'team' }, TMC)).body.roster.find(p => p.learner_id === SID);
      assert.strictEqual(row.status, 'ended'); assert.strictEqual(row.courses[0].exam.passed, true, 'history kept');
      assert.strictEqual((await verify(cert)).body.status, 'valid', 'the certificate is still verifiable');
      assert.strictEqual(run(DB, `select count(*) from academy_events where action = 'deactivate'`), '1', 'audited');
      assert.strictEqual((await learner({ action: 'reactivate', learner_id: SID, dealer_id: HQ }, TMC)).status, 200, 'and access can be restored');
    });
  } catch (e) { fail++; console.log('  FAIL setup\n       ' + String(e && e.stack || e)); }
  finally {
    try { run('postgres', `drop database if exists ${DB}`); } catch (e) {}
    console.log(`\nacademy-phase3.pg: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
  }
})();
