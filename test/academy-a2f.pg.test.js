/* HCPS Academy A2F — HCPS certificates through the REAL learner, Training Manager, admin and public verification APIs
   against the REAL database rules: A1, M1–M6 and M7 exactly as committed (pg-safeupdate loaded); the handlers run
   unchanged; their Supabase calls are answered by test/academy-pgrest.js.
     PGHOST=127.0.0.1 PGUSER=postgres PGPASSWORD=… node test/academy-a2f.pg.test.js */
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

const DB = 'academy_a2f_' + process.pid;
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


const verify = (n, o) => call(VERIFY.handler, null, Object.assign({ method: 'GET', query: n == null ? {} : { n } }, o || {}));
const ON = { academy_admin: true, academy_learner: true, academy_open: true, academy_invites: true, academy_exams: true };
async function passExam(cookie, enr, right) {
  assert.strictEqual((await learner({ action: 'save_progress', enrollment_id: enr, lesson_id: L1, status: 'completed', resume_block: 2 }, cookie)).status, 200);
  const s = await learner({ action: 'exam_start', enrollment_id: enr }, cookie); assert.strictEqual(s.status, 200, JSON.stringify(s.body));
  const r = await learner({ action: 'exam_submit', attempt_id: s.body.attempt_id, answers: { [QX]: right === false ? 'a' : 'b' } }, cookie);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.strictEqual(r.body.passed, right !== false);
  return Object.assign({ attempt_id: s.body.attempt_id }, r.body);
}
(async () => {
  try {
    flags({ academy_admin: true, academy_learner: true, academy_open: true, academy_invites: true });
    await admin('pres', { action: 'invite_learner', dealer_id: HQ, email: 'tm@hqmed.example', role: 'training_manager' });
    await admin('pres', { action: 'invite_learner', dealer_id: OTHER, email: 'tm@other.example', role: 'training_manager' });
    const TMC = await signIn('tm@hqmed.example', '198.51.100.1'), TM2 = await signIn('tm@other.example', '198.51.100.9');
    await learner({ action: 'invite', dealer_id: NORTH, email: 'pat@north.example', full_name: 'Pat Learner' }, TMC);
    await learner({ action: 'invite', dealer_id: HQ, email: 'sam@hqmed.example', full_name: 'Sam Seller' }, TMC);
    await learner({ action: 'invite', dealer_id: OTHER, email: 'oz@other.example', full_name: 'Oz Other' }, TM2);
    const PC = await signIn('pat@north.example', '198.51.100.2'), SC = await signIn('sam@hqmed.example', '198.51.100.3'), OC = await signIn('oz@other.example', '198.51.100.4');
    const id = async c => (await learner({ action: 'me' }, c)).body.learner.id;
    const PID = await id(PC), SID = await id(SC), OID = await id(OC);
    const PE = (await learner({ action: 'enroll', learner_id: PID, version_id: V }, TMC)).body.enrollment.id;
    const SE = (await learner({ action: 'enroll', learner_id: SID, version_id: V }, TMC)).body.enrollment.id;
    const OE = (await learner({ action: 'enroll', learner_id: OID, version_id: V }, TM2)).body.enrollment.id;
    flags(ON);
    let PA, CERT;

    await t('Certificates off: a pass is graded and kept, but no certificate (and nothing pending); claim → 403 flag_off; verify says not open', async () => {
      const r = await passExam(PC, PE); PA = r.attempt_id;
      assert.strictEqual(r.certificate, undefined); assert.strictEqual(r.certificate_pending, undefined);
      const m = await learner({ action: 'my_certificates' }, PC); assert.deepStrictEqual([m.body.certificates, m.body.issuing], [[], false]);
      assert.strictEqual((await learner({ action: 'claim_certificate', attempt_id: PA }, PC)).body.error, 'flag_off');
      assert.deepStrictEqual((await verify('HCPS-AAAA-AAAA')).body.enabled, false);
      assert.strictEqual(run(DB, 'select count(*) from academy_certificates'), '0');
    });
    await t('Switch on: the learner claims their earlier pass — one HCPS certificate, branch dealership, 12 months, Golden disclosure; a repeat returns the same one', async () => {
      flags(Object.assign({ academy_certificates: true }, ON));
      const r = await learner({ action: 'claim_certificate', attempt_id: PA }, PC); assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      CERT = r.body.certificate;
      assert.strictEqual(CERT.dealer_name, 'HQ Medical North'); assert.strictEqual(CERT.status, 'valid'); assert.strictEqual(CERT.expiring_soon, false);
      assert.ok(CERT.days_left >= 364 && CERT.days_left <= 366, String(CERT.days_left));
      assert.match(CERT.disclosure, /not issued or endorsed by Golden Technologies/);
      assert.strictEqual(CERT.course, 'Golden Lift Chair Sales Certification');
      const again = await learner({ action: 'claim_certificate', attempt_id: PA }, PC); assert.strictEqual(again.body.existing, true); assert.strictEqual(again.body.certificate.id, CERT.id);
      assert.strictEqual(run(DB, 'select count(*) from academy_certificates'), '1');
    });
    await t('Another person cannot claim Pat\'s attempt (another learner, or a Training Manager)', async () => {
      for (const c of [SC, TMC, OC]) { const r = await learner({ action: 'claim_certificate', attempt_id: PA }, c); assert.ok(r.status >= 400 && r.status < 500, String(r.status)); assert.ok(!r.body.certificate); }
    });
    await t('A pass while issuing is on returns the certificate with the result; a fail returns none', async () => {
      const f = await passExam(OC, OE, false); assert.strictEqual(f.certificate, undefined); assert.strictEqual(f.certificate_pending, undefined);
      const r = await passExam(SC, SE); assert.ok(r.certificate && /^HCPS-/.test(r.certificate.cert_number), JSON.stringify(r));
      assert.strictEqual(r.certificate.dealer_name, 'HQ Medical');
    });
    await t('my_courses and my_certificates show the learner\'s own certificate only — never a revocation reason', async () => {
      const mc = (await learner({ action: 'my_courses' }, PC)).body.courses; assert.strictEqual(mc[0].certificate.cert_number, CERT.cert_number);
      const m = (await learner({ action: 'my_certificates' }, PC)).body; assert.deepStrictEqual(m.certificates.map(c => c.cert_number), [CERT.cert_number]);
      assert.ok(!/revoked_reason|revoked_by|score/.test(JSON.stringify(m)));
      assert.strictEqual((await learner({ action: 'my_certificates' }, PC, { method: 'GET', query: { action: 'my_certificates' } })).status, 200, 'a read');
    });
    await t('Training Manager: HQ sees Pat (branch) and Sam with number, status and expiry — no score anywhere; Other\'s TM sees neither', async () => {
      const T = (await learner({ action: 'team' }, TMC)).body;
      const pat = T.roster.find(p => p.learner_id === PID), sam = T.roster.find(p => p.learner_id === SID);
      assert.strictEqual(pat.courses[0].certificate.cert_number, CERT.cert_number); assert.strictEqual(pat.courses[0].certificate.status, 'valid');
      assert.strictEqual(sam.courses[0].certificate.status, 'valid'); assert.ok('expiring_soon' in sam.courses[0].certificate);
      assert.ok(!/"score"|revoked_reason/.test(JSON.stringify(T)));
      const T2 = (await learner({ action: 'team' }, TM2)).body; const s2 = JSON.stringify(T2);
      assert.ok(!s2.includes(CERT.cert_number) && !s2.includes(PID) && !s2.includes(SID));
      assert.strictEqual(T2.roster.find(p => p.learner_id === OID).courses[0].certificate, null, 'Oz failed: no certificate');
    });
    await t('Expiring soon: a certificate within 60 days of expiry is flagged for the Training Manager and in the Command Center', async () => {
      run(DB, `begin; set local session_replication_role = replica; update academy_certificates set expires_at = now() + interval '30 days' where learner_id = '${SID}'; commit;`);
      const sam = (await learner({ action: 'team' }, TMC)).body.roster.find(p => p.learner_id === SID).courses[0].certificate;
      assert.strictEqual(sam.expiring_soon, true); assert.ok(sam.days_left <= 30);
      const L = (await admin('pres', { action: 'list_certificates' })).body;
      assert.strictEqual(L.summary.expiring_soon, 1); assert.strictEqual(L.summary.valid, 2);
    });
    await t('Public verification: GET only, public fields only; format 400, unknown 404; lower case and spaces accepted', async () => {
      const r = await verify(' ' + CERT.cert_number.toLowerCase() + ' '); assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual(r.body.status, 'valid'); assert.strictEqual(r.body.learner_name, 'Pat Learner'); assert.match(r.body.disclosure, /not issued or endorsed by Golden/);
      assert.ok(!/@|score|attempt|reason|enrollment|learner_id/.test(JSON.stringify(r.body)), JSON.stringify(r.body));
      assert.deepStrictEqual(Object.keys(r.body).sort(), ['cert_number', 'course_title', 'dealer_name', 'disclosure', 'enabled', 'expires_at', 'found', 'issued_at', 'issuer', 'learner_name', 'revoked_at', 'status'], 'exactly the public fields');
      assert.strictEqual((await verify('nope')).status, 400); assert.strictEqual((await verify('HCPS-ZZZZ-ZZZZ')).status, 404);
      assert.strictEqual((await call(VERIFY.handler, {}, { method: 'POST' })).status, 405);
      assert.strictEqual(r.raw.headers['cache-control'], 'no-store');
    });
    await t('Revoke: an administrator who is not the President is refused by the API (president_only); a too-short reason refused; nothing changes', async () => {
      assert.strictEqual((await admin('adm', { action: 'revoke_certificate', id: CERT.id, reason: 'Left the company' })).body.error, 'president_only');
      assert.strictEqual((await admin('own', { action: 'revoke_certificate', id: CERT.id, reason: 'Left the company' })).body.error, 'president_only');
      const short = await admin('pres', { action: 'revoke_certificate', id: CERT.id, reason: 'no' }); assert.strictEqual(short.status, 400); assert.match(short.body.message, /at least 5 characters/, 'refused by the API before the database');
      assert.strictEqual(run(DB, `select status from academy_certificates where id = '${CERT.id}'`), 'valid');
    });
    await t('Revoke by the President: audited; verifies as revoked (no reason public); the learner sees revoked; the Command Center sees the reason', async () => {
      const r = await admin('pres', { action: 'revoke_certificate', id: CERT.id, reason: 'Issued to the wrong person', p_actor: 'staff:admin2@test.example', actor: 'staff:admin2@test.example' }); assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual(r.body.certificate.status, 'revoked');
      assert.strictEqual(run(DB, `select count(*) from academy_events where action = 'revoke_certificate' and actor = 'staff:admin@test.example'`), '1');
      const v = (await verify(CERT.cert_number)).body; assert.strictEqual(v.status, 'revoked'); assert.ok(v.revoked_at); assert.ok(!/wrong person/.test(JSON.stringify(v)));
      assert.strictEqual((await learner({ action: 'my_certificates' }, PC)).body.certificates[0].status, 'revoked');
      const L = (await admin('pres', { action: 'list_certificates' })).body.certificates.find(c => c.id === CERT.id);
      assert.strictEqual(L.display_status, 'revoked'); assert.strictEqual(L.revoked_reason, 'Issued to the wrong person');
      assert.strictEqual((await admin('pres', { action: 'revoke_certificate', id: CERT.id, reason: 'Second time' })).status, 400, 'already revoked');
      assert.strictEqual((await learner({ action: 'claim_certificate', attempt_id: PA }, PC)).body.certificate.status, 'revoked', 'no fresh certificate after a revocation');
    });
    await t('A certificate that cannot be issued never fails the graded exam: certificate_pending, the pass stays recorded', async () => {
      await learner({ action: 'invite', dealer_id: HQ, email: 'kim@hqmed.example', full_name: 'Kim' }, TMC);
      const KC = await signIn('kim@hqmed.example', '198.51.100.5'); const KID = await id(KC);
      const KE = (await learner({ action: 'enroll', learner_id: KID, version_id: V }, TMC)).body.enrollment.id;
      run(DB, 'alter function academy_cert_op_claim(text, uuid) rename to academy_cert_op_claim_gone');
      let r; try { r = await passExam(KC, KE); } finally { run(DB, 'alter function academy_cert_op_claim_gone(text, uuid) rename to academy_cert_op_claim'); }
      assert.strictEqual(r.certificate_pending, true); assert.strictEqual(r.passed, true);
      assert.strictEqual(run(DB, `select count(*) from academy_attempts a join academy_enrollments e on e.id = a.enrollment_id where e.learner_id = '${KID}' and a.passed`), '1');
      assert.strictEqual((await learner({ action: 'claim_certificate', attempt_id: r.attempt_id }, KC)).status, 200, 'the learner (or a retry) claims it later');
    });
  } catch (e) { fail++; console.log('  FAIL setup\n       ' + String(e && e.stack || e)); }
  finally {
    try { run('postgres', `drop database if exists ${DB}`); } catch (e) {}
    console.log(`\nacademy-a2f.pg: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
  }
})();
