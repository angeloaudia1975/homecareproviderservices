/* HCPS Academy Phase 2 / F2 — manufacturer technical-certification program pages (issue #32): official video in the
   Academy, then the manufacturer's own quiz, self-reported steps, certificate upload and HCPS verification.
   Real academy-api / academy-admin-api handlers against a local Postgres with A1, M1–M8 and F2 exactly as committed
   (test/academy-pgrest.js; in-memory private storage). Nothing reaches YouTube, Google or an email provider.
     PGHOST=127.0.0.1 PGUSER=postgres PGPASSWORD=localtest node test/academy-f2.pg.test.js */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { shim, BASE } = require('./academy-pgrest.js');

const PSQL = process.env.PGTEST_PSQL || 'psql';
const SUP = f => path.join(__dirname, '..', 'supabase', f);
const psql = (db, args) => spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db].concat(args), { encoding: 'utf8' });
const run = (db, sql) => { const r = psql(db, ['-c', sql]); if (r.error || r.status !== 0) throw new Error((r.error && r.error.message) || r.stderr); return r.stdout.trim(); };
const tryRun = (db, sql) => { const r = psql(db, ['-c', sql]); return { ok: r.status === 0, err: r.stderr || '' }; };
const file = (db, f) => { const r = psql(db, ['-f', f]); if (r.status !== 0) throw new Error(f + ': ' + r.stderr); return r.stdout.trim(); };
try { run('postgres', 'select 1'); } catch (e) { console.log('SKIP: no Postgres (' + String(e.message).split('\n')[0] + ')'); process.exit(0); }
const NO_SAFEUPDATE = process.env.PGTEST_NO_SAFEUPDATE === '1';
const fixture = () => { let s = fs.readFileSync(path.join(__dirname, 'academy', 'fixture.sql'), 'utf8'); if (NO_SAFEUPDATE) s = s.replace(/^do \$\$ begin execute format\('alter database %I set session_preload_libraries.*$/m, ''); return s; };
const J = v => `$j$${JSON.stringify(v)}$j$::jsonb`;
const PRES = `'staff:admin@test.example'`;
const HQ = '00000000-0000-0000-0000-0000000000a1';
const ORIGIN = 'https://www.homecareproviderservices.org';
const PRE = ['academy_a2a_m1_audited_ops.sql', 'academy_a2c_m2_content_ops.sql', 'academy_a2d_m3_author_ops.sql', 'academy_a2d_m3_1_save_lesson.sql',
             'academy_c2_m4_publish_ops.sql', 'academy_a2b_m5_learner_access.sql', 'academy_a2e_m6_exam_attempts.sql', 'academy_a2f_m7_certificates.sql',
             'academy_p2_m8_payments.sql'];
let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + String(e && e.stack || e).split('\n').slice(0, 8).join('\n       ')); } }

function makeDb(name) {
  run('postgres', `drop database if exists ${name}`); run('postgres', `create database ${name}`);
  run(name, fixture());
  run(name, `alter table public.dealers add column is_test boolean not null default false, add column status text, add column account_class text, add column active boolean;
             create table public.dealer_users (uid uuid primary key, email text, dealer_id uuid references public.dealers(id), status text);`);
  file(name, SUP('academy_a1_foundation.sql'));
  run(name, 'grant all on all tables in schema public to service_role');
  for (const f of PRE) file(name, SUP(f));
}
const DB = 'academy_f2_' + process.pid;
makeDb(DB);
const installOut = file(DB, SUP('academy_p2_f2_programs.sql'));
const flags = f => run(DB, `insert into app_settings (key, value) values ('phase2_flags', ${J(f)}) on conflict (key) do update set value = excluded.value`);
const ON = { academy_admin: true, academy_learner: true, academy_invites: true, academy_open: true };
flags(ON);
const op = sql => JSON.parse(run(DB, `select ${sql}`));
const prog = (slug, title) => op(`academy_content_op_create_course(${PRES}, null, ${J({ slug, title, course_type: 'manufacturer_program', manufacturer_slug: 'golden-technologies', external_url: 'https://forms.gle/BsZRxeTDWitwRGfr5' })})`).id;
const LIFT = prog('golden-lift-chair-technical-service-certification', 'Golden Lift Chair Technical Service Certification');
const MOB = prog('golden-mobility-technical-service-certification', 'Golden Mobility Technical Service Certification');
run(DB, `select academy_publish_op_publish_course(${PRES}, '${LIFT}')`);
const HCPS = op(`academy_content_op_create_course(${PRES}, null, ${J({ slug: 'dealer-sales-basics', title: 'Dealer Sales Basics', course_type: 'hcps_certification' })})`).id;

const mails = [], pendingJobs = [];
const storage = new Map();
const S = shim({ db: DB, psql: PSQL, storage, tokens: { pres: 'admin@test.example', adm: 'admin2@test.example', rep: 'rep@test.example' },
  passthrough: async (url, o) => {
    const u = String(url);
    if (u === 'https://api.resend.com/emails') { mails.push(JSON.parse(o.body)); return new Response('{"id":"x"}', { status: 200 }); }
    if (u.endsWith('/.netlify/functions/academy-mail-background')) { pendingJobs.push(require('../netlify/functions/academy-mail-background.js')._run({ httpMethod: 'POST', body: o.body })); return new Response(null, { status: 202 }); }
    return new Response('{}', { status: 599 });
  } });
run(DB, "insert into staff_users (email, name, role, active) values ('admin2@test.example', 'Second Admin', 'admin', true)");
process.env.SUPABASE_URL = BASE; process.env.SUPABASE_SERVICE_ROLE = 'svc-test-key';
process.env.ACADEMY_SESSION_SECRET = 'test-secret-0123456789-abcdefghijklmnopqrstuvwxyz-0123';
process.env.RESEND_API_KEY = 're_test'; process.env.ACADEMY_SIGNIN_FLOOR_MS = '20'; process.env.ACADEMY_MAIL_FROM = 'HCPS Academy <academy@test.example>';
global.fetch = S.fetch;
const API = require('../netlify/functions/academy-api.js');
const ADMIN = require('../netlify/functions/academy-admin-api.js');
const cookieOf = out => { const c = ((out.multiValueHeaders || {})['set-cookie'] || [])[0] || ''; return c.split(';')[0]; };
let ipN = 1;
async function call(handler, body, o) {
  o = o || {};
  const headers = Object.assign({ origin: ORIGIN, 'x-academy-request': '1', 'x-nf-client-connection-ip': '203.0.113.' + (ipN++ % 250) }, o.cookie ? { cookie: o.cookie } : {}, o.headers || {});
  for (const k of Object.keys(headers)) if (headers[k] === undefined) delete headers[k];
  const out = await handler({ httpMethod: o.method || 'POST', headers, body: JSON.stringify(body || {}), queryStringParameters: o.query || {} });
  await Promise.all(pendingJobs.splice(0));
  let j = null; try { j = out.body ? JSON.parse(out.body) : null; } catch (e) { j = out.body; }
  return { status: out.statusCode, body: j, cookie: cookieOf(out) };
}
const learner = (body, cookie, o) => call(API.handler, body, Object.assign({ cookie }, o || {}));
const admin = (tok, body) => call(ADMIN.handler, body, { headers: { authorization: 'Bearer ' + tok, 'x-academy-request': undefined } });
const lastCode = to => { const m = mails.filter(x => x.to[0] === to).pop(); return m && (/is your HCPS Academy sign-in code/.test(m.subject) ? m.subject.slice(0, 6) : null); };
async function signIn(addr) {
  mails.length = 0;
  assert.strictEqual((await learner({ action: 'request_code', email: addr })).status, 200);
  const v = await learner({ action: 'verify_code', email: addr, code: lastCode(addr) }); assert.strictEqual(v.status, 200, JSON.stringify(v.body));
  return v.cookie;
}
const PDF = Buffer.from('%PDF-1.4\n% Golden certificate (test bytes)\n').toString('base64');
const upload = (cookie, data, course) => call(API.handler, { action: 'program_certificate', course_id: course || LIFT, file_name: 'golden.pdf', data }, { cookie, headers: { 'x-academy-upload': '1' } });

(async () => {
  try {
    await t('install: the five F2 install checks read true; a second install is refused', async () => {
      const rows = installOut.split('\n').filter(l => l.includes('|'));
      assert.strictEqual(rows.length, 5, installOut); for (const r of rows) assert.ok(r.endsWith('|t'), r);
      assert.ok(!tryRun(DB, `\\i ${SUP('academy_p2_f2_programs.sql')}`).ok);
    });
    await t('RULE 19: public roles read and run nothing; the server cannot write the table directly', async () => {
      assert.ok(!tryRun(DB, 'set role anon; select * from academy_program_details').ok);
      assert.ok(!tryRun(DB, 'set role authenticated; select * from academy_program_details').ok);
      assert.ok(!tryRun(DB, `set role service_role; insert into academy_program_details (course_id, updated_by) values ('${LIFT}', 'x')`).ok);
      const own = tryRun(DB, `insert into academy_program_details (course_id, updated_by) values ('${LIFT}', 'x')`); assert.ok(!own.ok && /audited operation/.test(own.err), own.err);
      assert.ok(!tryRun(DB, `set role anon; select academy_ext_op_step('learner:x', null, 'watched')`).ok);
      assert.ok(!tryRun(DB, `set role service_role; select academy_ext_current(null, null)`).ok, 'helper not callable');
    });
    await t('program page editing: administrators only; YouTube links become the privacy-enhanced embed; bad links refused; audited', async () => {
      assert.ok([401, 403].includes((await admin('rep', { action: 'set_program', course_id: LIFT, video_url: 'https://www.youtube.com/watch?v=VApekZEFn8c' })).status));
      const bad = [['video_url', 'https://vimeo.com/123456'], ['video_url', 'http://www.youtube.com/watch?v=VApekZEFn8c'], ['video_url', 'https://evil.example/watch?v=VApekZEFn8c'],
                   ['quiz_url', 'javascript:alert(1)'], ['quiz_url', 'http://forms.gle/x'], ['manufacturer_page_url', 'https://user:pw@goldentech.com/']];
      for (const [k, v] of bad) assert.strictEqual((await admin('pres', { action: 'set_program', course_id: LIFT, [k]: v })).status, 400, k + ' ' + v);
      assert.strictEqual((await admin('pres', { action: 'set_program', course_id: HCPS, quiz_url: 'https://forms.gle/x' })).status, 400, 'not a manufacturer program');
      for (const v of ['https://youtu.be/VApekZEFn8c', 'https://www.youtube.com/embed/VApekZEFn8c', 'https://www.youtube.com/watch?v=VApekZEFn8c']) {
        const r = await admin('adm', { action: 'set_program', course_id: LIFT, video_url: v }); assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.strictEqual(r.body.details.video_url, 'https://www.youtube-nocookie.com/embed/VApekZEFn8c');
      }
      const r = await admin('pres', { action: 'set_program', course_id: LIFT, video_title: 'Golden Technologies: Lift Chair Technical Service Certification',
        quiz_url: 'https://forms.gle/BsZRxeTDWitwRGfr5', manufacturer_page_url: 'https://goldentech.com/lift-chair-certification/',
        quiz_note: 'Golden requires a perfect score. You may retake it as many times as needed. Golden emails the certificate within a few weeks.' });
      assert.strictEqual(r.status, 200); assert.strictEqual(r.body.details.video_url, 'https://www.youtube-nocookie.com/embed/VApekZEFn8c', 'a partial save keeps the video');
      await admin('pres', { action: 'set_program', course_id: MOB, video_url: 'https://www.youtube.com/watch?v=eI46MshrR3c', quiz_url: 'https://forms.gle/d7CXFRjeDFNiJnBg8' });
      assert.ok(Number(run(DB, `select count(*) from academy_events where entity = 'academy_program_details' and action = 'set_program'`)) >= 5);
      const g = await admin('adm', { action: 'get_program', course_id: LIFT }); assert.strictEqual(g.body.installed, true); assert.strictEqual(g.body.details.quiz_url, 'https://forms.gle/BsZRxeTDWitwRGfr5');
    });
    let C;
    await t('learner: the published program lists with its video and quiz; a draft program is never shown or opened', async () => {
      assert.strictEqual((await admin('pres', { action: 'invite_learner', dealer_id: HQ, email: 'lee@hqmed.example' })).status, 200);
      C = await signIn('lee@hqmed.example');
      const l = await learner({ action: 'manufacturer_programs' }, C); assert.strictEqual(l.status, 200);
      assert.deepStrictEqual(l.body.programs.map(p => p.title), ['Golden Lift Chair Technical Service Certification']);
      const p = l.body.programs[0];
      assert.deepStrictEqual(p.video, { embed: 'https://www.youtube-nocookie.com/embed/VApekZEFn8c', title: 'Golden Technologies: Lift Chair Technical Service Certification', watch_url: 'https://www.youtube.com/watch?v=VApekZEFn8c' });
      assert.strictEqual(p.quiz_url, 'https://forms.gle/BsZRxeTDWitwRGfr5'); assert.strictEqual(p.credential, null);
      const d = await learner({ action: 'program', course_id: LIFT }, C); assert.strictEqual(d.status, 200); assert.strictEqual(d.body.tracking, true); assert.strictEqual(d.body.uploads_open, false);
      assert.strictEqual((await learner({ action: 'program', course_id: MOB }, C)).status, 404, 'draft');
      assert.strictEqual((await learner({ action: 'program', course_id: HCPS }, C)).status, 404);
      assert.strictEqual((await learner({ action: 'program', course_id: LIFT }, null)).status, 401);
      assert.strictEqual((await learner({ action: 'program_step', course_id: MOB, step: 'watched' }, C)).status, 400, 'a draft program records nothing');
    });
    await t('steps: quiz before video refused; watched → quiz submitted recorded as the learner\'s own reports; repeats are harmless; audited', async () => {
      const early = await learner({ action: 'program_step', course_id: LIFT, step: 'quiz_submitted' }, C); assert.strictEqual(early.status, 409); assert.strictEqual(early.body.error, 'watch_first');
      assert.strictEqual((await learner({ action: 'program_step', course_id: LIFT, step: 'passed' }, C)).status, 400, 'no such step');
      const w = await learner({ action: 'program_step', course_id: LIFT, step: 'watched' }, C); assert.strictEqual(w.status, 200); assert.strictEqual(w.body.status, 'training_completed');
      assert.strictEqual((await learner({ action: 'program_step', course_id: LIFT, step: 'watched' }, C)).body.status, 'training_completed');
      const q = await learner({ action: 'program_step', course_id: LIFT, step: 'quiz_submitted' }, C); assert.strictEqual(q.body.status, 'exam_reported'); assert.match(q.body.label, /your report/);
      assert.strictEqual((await learner({ action: 'program_step', course_id: LIFT, step: 'watched' }, C)).body.status, 'exam_reported', 'never moves backwards');
      assert.strictEqual(run(DB, `select count(*) from academy_external_certs`), '1');
      assert.strictEqual(run(DB, `select string_agg(action, ',' order by at) from academy_events where entity = 'academy_external_certs'`), 'ext_watched,ext_watched,ext_quiz_submitted,ext_watched');
      assert.strictEqual(run(DB, `select status from academy_external_certs`), 'exam_reported', 'a self-report is never "verified"');
      const d = await learner({ action: 'program', course_id: LIFT }, C); assert.strictEqual(d.body.program.credential.status, 'exam_reported');
    });
    await t('certificate upload: off by default; then PDF/picture only, private, outside the lesson media library; HCPS reviews it', async () => {
      const off = await upload(C, PDF); assert.strictEqual(off.status, 403); assert.strictEqual(off.body.error, 'flag_off');
      flags(Object.assign({}, ON, { academy_external_uploads: true }));
      assert.strictEqual((await upload(C, Buffer.from('<html>not a certificate</html>').toString('base64'))).status, 400, 'type checked by content');
      assert.strictEqual((await call(API.handler, { action: 'program_step', course_id: LIFT, step: 'watched' }, { cookie: C, headers: { 'x-academy-upload': '1' } })).status, 400, 'the large-body door is only for the upload');
      const ok = await upload(C, PDF); assert.strictEqual(ok.status, 200, JSON.stringify(ok.body)); assert.strictEqual(ok.body.status, 'certificate_uploaded');
      const pth = run(DB, `select m.storage_path from academy_media m join academy_external_certs x on x.upload_media_id = m.id`);
      assert.match(pth, /^media\/learner-evidence\/[0-9a-f-]{36}-[0-9a-f]{32}\.pdf$/); assert.ok(storage.has(pth) || [...storage.keys()].some(k => k.endsWith(pth)), 'stored privately');
      const lib = await admin('pres', { action: 'media_library' }); assert.strictEqual(lib.status, 200);
      assert.ok(!JSON.stringify(lib.body).includes('learner-evidence'), 'never offered as lesson media');
      const list = await admin('adm', { action: 'list_external_certs' });
      const row = list.body.credentials[0]; assert.strictEqual(row.status, 'certificate_uploaded'); assert.strictEqual(row.has_upload, true); assert.strictEqual(row.awaiting_review, true);
      const v = await admin('adm', { action: 'review_external_cert', id: row.id, decision: 'verified', evidence_type: 'golden_certificate', evidence_ref: 'Golden certificate emailed 2026-10-21' });
      assert.strictEqual(v.status, 200, JSON.stringify(v.body)); assert.strictEqual(v.body.credential.status, 'verified');
      const s = await learner({ action: 'program_step', course_id: LIFT, step: 'quiz_submitted' }, C); assert.strictEqual(s.body.status, 'verified', 'nothing changes a verified credential');
      assert.strictEqual((await learner({ action: 'program', course_id: LIFT }, C)).body.program.credential.label, 'Verified by HCPS');
      flags(ON);
    });
    await t('a rejected report: the learner starts again on a new record (history kept)', async () => {
      run(DB, `select academy_publish_op_publish_course(${PRES}, '${MOB}')`);
      await learner({ action: 'program_step', course_id: MOB, step: 'watched' }, C); await learner({ action: 'program_step', course_id: MOB, step: 'quiz_submitted' }, C);
      const id = run(DB, `select id from academy_external_certs where course_id = '${MOB}'`);
      assert.strictEqual((await admin('adm', { action: 'review_external_cert', id, decision: 'rejected', note: 'No Golden certificate was received.' })).status, 200);
      const again = await learner({ action: 'program_step', course_id: MOB, step: 'watched' }, C); assert.strictEqual(again.body.status, 'training_completed');
      assert.strictEqual(run(DB, `select string_agg(status, ',' order by created_at) from academy_external_certs where course_id = '${MOB}'`), 'rejected,training_completed');
    });
    await t('staff Student view of a program: same page data, any status, records nothing', async () => {
      const before = run(DB, 'select count(*) from academy_events');
      const r = await admin('adm', { action: 'student_program', course_id: LIFT }); assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.program.video.embed, 'https://www.youtube-nocookie.com/embed/VApekZEFn8c'); assert.strictEqual(r.body.program.credential, null);
      assert.strictEqual(r.body.program.visible_to_learners, true);
      const cat = await admin('adm', { action: 'student_catalog' }); assert.strictEqual(cat.body.programs.length, 2);
      assert.strictEqual(run(DB, 'select count(*) from academy_events'), before);
      assert.ok([401, 403].includes((await admin('rep', { action: 'student_program', course_id: LIFT })).status));
    });
    await t('rollback: refused while records exist; a clean install rolls back and installs again', async () => {
      const r = tryRun(DB, `\\i ${SUP('academy_p2_f2_programs_rollback.sql')}`); assert.ok(!r.ok && /rollback refused/.test(r.err), r.err);
      const D2 = DB + '_rb'; makeDb(D2); file(D2, SUP('academy_p2_f2_programs.sql')); file(D2, SUP('academy_p2_f2_programs_rollback.sql'));
      assert.strictEqual(run(D2, `select to_regclass('public.academy_program_details') is null and not exists (select 1 from pg_proc where proname like 'academy\\_ext\\_%')`), 't');
      file(D2, SUP('academy_p2_f2_programs.sql')); run('postgres', `drop database if exists ${D2} with (force)`);
    });
  } finally {
    console.log(`\n${pass} passed, ${fail} failed`);
    run('postgres', `drop database if exists ${DB} with (force)`);
    process.exit(fail ? 1 : 0);
  }
})();
