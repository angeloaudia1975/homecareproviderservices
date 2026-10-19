/* HCPS Academy PILOT GATE (launch directive 19 Oct 2026): until academy_open is exactly true, only TEST dealerships can
   use the Academy — sessions, sign-in codes, Partner 360 Training links, invitations, Training Manager appointments,
   restores and enrollments. Same harness as academy-a2b.pg (real handlers, real M1–M5 database rules).
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

const DB = 'academy_pilot_' + process.pid;
const TUID = '00000000-0000-0000-0000-00000000eeee';
run('postgres', `drop database if exists ${DB}`); run('postgres', `create database ${DB}`);
run(DB, fixture());
run(DB, `alter table public.dealers add column is_test boolean not null default false;
         create table public.dealer_users (uid uuid primary key, email text, dealer_id uuid references public.dealers(id), status text);
         insert into auth.users (id, email) values ('${DUID}', 'buyer@hqmed.example');
         insert into public.dealer_users values ('${DUID}', 'buyer@hqmed.example', '${HQ}', 'approved');
         insert into auth.users (id, email) values ('${TUID}', 'buyer@sandbox.example');
         insert into public.dealer_users values ('${TUID}', 'buyer@sandbox.example', '${OTHER}', 'approved');
         update public.dealers set is_test = true where id = '${OTHER}';
         insert into public.dealers (id, business_name, parent_id, is_test) select '00000000-0000-0000-0000-0000000000b2', 'Real Branch Of Sandbox', '${OTHER}', false;`);
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
const S = shim({ db: DB, psql: PSQL, tokens: { pres: 'admin@test.example', adm: 'admin2@test.example', buyer: { id: DUID, email: 'buyer@hqmed.example' }, tbuyer: { id: TUID, email: 'buyer@sandbox.example' } },
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
  const PILOT = { academy_admin: true, academy_learner: true, academy_invites: true, academy_handoff: true };
  let REALC, REAL_ID;
  try {
    await t('Setup while OPEN: a real-dealership learner signs in (this is what the pilot must shut out)', async () => {
      flags(Object.assign({ academy_open: true }, PILOT));
      assert.strictEqual((await admin('pres', { action: 'invite_learner', dealer_id: HQ, email: 'real@hqmed.example' })).status, 200);
      REALC = await signIn('real@hqmed.example');
      assert.strictEqual((await admin('pres', { action: 'invite_learner', dealer_id: HQ, email: 'pending@hqmed.example' })).status, 200, 'an invitation to a real dealership left pending');
      REAL_ID = (await learner({ action: 'me' }, REALC)).body.learner.id;
    });
    await t('PILOT (academy_open absent): the real-dealership learner\'s live session is refused at once', async () => {
      flags(PILOT);
      const r = await learner({ action: 'me' }, REALC); assert.strictEqual(r.status, 401);
      assert.strictEqual((await learner({ action: 'my_courses' }, REALC)).status, 401);
    });
    await t('PILOT: academy_open must be exactly true — "true", 1 and false all mean pilot', async () => {
      for (const v of ['true', 1, false, null]) { flags(Object.assign({ academy_open: v }, PILOT)); assert.strictEqual((await learner({ action: 'me' }, REALC)).status, 401, String(v)); }
      flags(PILOT);
    });
    await t('PILOT: a sign-in code request from a real-dealership learner gets the SAME answer, no email, and the code is burned', async () => {
      mails.length = 0;
      const a = await learner({ action: 'request_code', email: 'real@hqmed.example' }, null, { ip: '198.51.100.1' });
      const b = await learner({ action: 'request_code', email: 'nobody@example.com' }, null, { ip: '198.51.100.2' });
      assert.strictEqual(a.status, 200); assert.strictEqual(a.body.message, b.body.message);
      await learner({ action: 'request_code', email: 'pending@hqmed.example' }, null, { ip: '198.51.100.4' });
      assert.strictEqual(mails.length, 0, 'no email reaches a real dealership during the pilot (learner or pending invitation)');
      assert.strictEqual(run(DB, `select count(*) from academy_login_codes c where c.email = 'real@hqmed.example' and c.used_at is null and c.burned_at is null and c.expires_at > now()`), '0', 'no live code left');
    });
    await t('PILOT: a code obtained before the pilot cannot open a session for a real-dealership learner', async () => {
      flags(Object.assign({ academy_open: true }, PILOT)); mails.length = 0;
      await learner({ action: 'request_code', email: 'real@hqmed.example' }, null, { ip: '198.51.100.3' }); const code = lastCode('real@hqmed.example'); assert.ok(code);
      flags(PILOT);
      const v = await learner({ action: 'verify_code', email: 'real@hqmed.example', code }, null, { ip: '198.51.100.3' });
      assert.strictEqual(v.status, 403); assert.strictEqual(v.body.error, 'no_access'); assert.strictEqual(v.cookie, '', 'no cookie');
    });
    await t('PILOT: HCPS cannot invite, restore, appoint or enroll at a real dealership; it can at the TEST dealership', async () => {
      const r = await admin('pres', { action: 'invite_learner', dealer_id: HQ, email: 'new@hqmed.example' });
      assert.strictEqual(r.status, 403); assert.strictEqual(r.body.error, 'pilot_only');
      assert.strictEqual((await admin('pres', { action: 'invite_learner', dealer_id: NORTH, email: 'new@north.example' })).body.error, 'pilot_only', 'a real branch too');
      assert.strictEqual((await admin('pres', { action: 'restore_membership', learner_id: REAL_ID, dealer_id: HQ })).body.error, 'pilot_only');
      const mem = one(`select id from academy_memberships where learner_id = '${REAL_ID}'`).id;
      assert.strictEqual((await admin('pres', { action: 'set_training_manager', membership_id: mem, make: true, reason: 'pilot test' })).body.error, 'pilot_only');
      assert.strictEqual((await admin('pres', { action: 'enroll_learner', learner_id: REAL_ID, version_id: V })).body.error, 'pilot_only');
      assert.strictEqual(run(DB, `select count(*) from academy_enrollments where learner_id = '${REAL_ID}'`), '0');
      const ok = await admin('pres', { action: 'invite_learner', dealer_id: OTHER, email: 'tm@sandbox.example', full_name: 'Sandbox TM', role: 'training_manager' });
      assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    });
    let TMC;
    await t('PILOT: the TEST-dealership Training Manager signs in, invites and enrolls inside the sandbox; a real dealership stays out of reach', async () => {
      TMC = await signIn('tm@sandbox.example');
      const me = await learner({ action: 'me' }, TMC); assert.strictEqual(me.body.training_manager, true);
      assert.strictEqual((await learner({ action: 'invite', dealer_id: OTHER, email: 'pilot1@sandbox.example', full_name: 'Pilot One' }, TMC)).status, 200);
      assert.strictEqual((await learner({ action: 'invite', dealer_id: HQ, email: 'x@hqmed.example' }, TMC)).status, 403);
      const br = await learner({ action: 'invite', dealer_id: '00000000-0000-0000-0000-0000000000b2', email: 'y@branch.example' }, TMC);
      assert.strictEqual(br.status, 403); assert.strictEqual(br.body.error, 'pilot_only', 'a real branch under the TEST dealership stays closed');
      const LC = await signIn('pilot1@sandbox.example'); const lid = (await learner({ action: 'me' }, LC)).body.learner.id;
      const e = await learner({ action: 'enroll', learner_id: lid, version_id: V }, TMC); assert.strictEqual(e.status, 200, JSON.stringify(e.body));
      assert.strictEqual((await learner({ action: 'my_courses' }, LC)).body.courses.length, 1);
      const team = await learner({ action: 'team' }, TMC);
      assert.ok(!JSON.stringify(team.body).includes('hqmed'), 'nothing of a real dealership in the sandbox view');
    });
    await t('PILOT: a learner with memberships at BOTH a real and the TEST dealership only acts through the TEST one', async () => {
      flags(Object.assign({ academy_open: true }, PILOT));
      assert.strictEqual((await admin('pres', { action: 'invite_learner', dealer_id: HQ, email: 'pilot1@sandbox.example' })).status, 200);
      const LC = await signIn('pilot1@sandbox.example');   // accepts the HQ invitation on sign-in
      flags(PILOT);
      const me = await learner({ action: 'me' }, LC); assert.strictEqual(me.status, 200);
      assert.deepStrictEqual(me.body.memberships.map(m => m.dealer_id), [OTHER]);
    });
    await t('PILOT: Partner 360 — a real dealership login gets no Training link; the TEST dealership login does, and it redeems', async () => {
      assert.deepStrictEqual((await call(HAND.handler, { action: 'status' }, { headers: { origin: P360 } })).body, { enabled: false }, 'no button for an anonymous visitor');
      assert.deepStrictEqual((await call(HAND.handler, { action: 'status' }, { headers: { origin: P360, authorization: 'Bearer buyer' } })).body, { enabled: false }, 'no button for a real dealership');
      assert.deepStrictEqual((await call(HAND.handler, { action: 'status' }, { headers: { origin: P360, authorization: 'Bearer tbuyer' } })).body, { enabled: true }, 'the TEST dealership sees it');
      const r = await call(HAND.handler, { action: 'mint' }, { headers: { origin: P360, authorization: 'Bearer buyer' } });
      assert.strictEqual(r.status, 403); assert.strictEqual(r.body.error, 'pilot_only');
      assert.strictEqual(run(DB, `select count(*) from academy_handoff_codes where auth_user_id = '${DUID}' and used_at is null`), '0');
      const m = await call(HAND.handler, { action: 'mint' }, { headers: { origin: P360, authorization: 'Bearer tbuyer' } });
      assert.strictEqual(m.status, 200, JSON.stringify(m.body));
      const red = await learner({ action: 'handoff_redeem', code: m.body.url.split('#handoff=')[1] });
      assert.strictEqual(red.status, 200, JSON.stringify(red.body));
      assert.strictEqual((await learner({ action: 'me' }, red.cookie)).body.learner.email, 'buyer@sandbox.example');
    });
    await t('OPEN (academy_open exactly true): the real-dealership learner works again — the gate is the only thing that changed', async () => {
      flags(Object.assign({ academy_open: true }, PILOT));
      assert.strictEqual((await learner({ action: 'me' }, REALC)).status, 200, 'the same session works again once the Academy is open');
    });
  } finally {
    console.log(`\nacademy-pilot.pg: ${pass} passed, ${fail} failed`);
    try { run('postgres', `drop database if exists ${DB} with (force)`); } catch (e) {}
    process.exit(fail ? 1 : 0);
  }
})();
