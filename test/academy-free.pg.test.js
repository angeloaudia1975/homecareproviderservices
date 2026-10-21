/* HCPS Academy Phase 2 / F1 — FREE launch access (issue #29), end to end.
   A local Postgres holds A1, M1–M8 and F1 exactly as committed; the real academy-free.js, academy-api.js,
   academy-checkout.js, academy-stripe-webhook.js, academy-verify.js and academy-admin-api.js handlers run unchanged; their
   Supabase calls are answered by test/academy-pgrest.js (real database functions, real tables). Emails are captured,
   never sent. No real card, key or network call is involved.
     PGHOST=127.0.0.1 PGUSER=postgres PGPASSWORD=localtest node test/academy-free.pg.test.js */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const assert = require('assert');
const { shim, BASE } = require('./academy-pgrest.js');

const PSQL = process.env.PGTEST_PSQL || 'psql';
const SUP = f => path.join(__dirname, '..', 'supabase', f);
const psql = (db, args) => spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db].concat(args), { encoding: 'utf8' });
const run = (db, sql) => { const r = psql(db, ['-c', sql]); if (r.error || r.status !== 0) throw new Error((r.error && r.error.message) || r.stderr); return r.stdout.trim(); };
const tryRun = (db, sql) => { const r = psql(db, ['-c', sql]); return { ok: r.status === 0, err: r.stderr || '', out: r.stdout.trim() }; };
const file = (db, f) => { const r = psql(db, ['-f', f]); if (r.status !== 0) throw new Error(f + ': ' + r.stderr); return r.stdout.trim(); };
try { run('postgres', 'select 1'); } catch (e) { console.log('SKIP: no Postgres (' + String(e.message).split('\n')[0] + ')'); process.exit(0); }
const NO_SAFEUPDATE = process.env.PGTEST_NO_SAFEUPDATE === '1';
const fixture = () => { let s = fs.readFileSync(path.join(__dirname, 'academy', 'fixture.sql'), 'utf8'); if (NO_SAFEUPDATE) s = s.replace(/^do \$\$ begin execute format\('alter database %I set session_preload_libraries.*$/m, ''); return s; };
const J = v => `$j$${JSON.stringify(v)}$j$::jsonb`;
const PRES = `'staff:admin@test.example'`;
const D = n => '00000000-0000-0000-0000-0000000000' + n;
const HQ = D('a1'), NORTH = D('a2'), OTHER = D('b1');
const INHQ = D('c1'), INBR = D('c2'), PRHQ = D('c3'), PRBR = D('c4'), CLOSED = D('c5'), MFR = D('c6');
const TESTD = D('d1'), TESTBR = D('d2'), TESTUNDERREAL = D('d3');
const ORIGIN = 'https://www.homecareproviderservices.org';
const PRE = ['academy_a2a_m1_audited_ops.sql', 'academy_a2c_m2_content_ops.sql', 'academy_a2d_m3_author_ops.sql', 'academy_a2d_m3_1_save_lesson.sql',
             'academy_c2_m4_publish_ops.sql', 'academy_a2b_m5_learner_access.sql', 'academy_a2e_m6_exam_attempts.sql', 'academy_a2f_m7_certificates.sql',
             'academy_p2_m8_payments.sql'];

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + String(e && e.stack || e).split('\n').slice(0, 8).join('\n       ')); } }

function makeDb(name) {
  run('postgres', `drop database if exists ${name}`); run('postgres', `create database ${name}`);
  run(name, fixture());
  run(name, `alter table public.dealers add column is_test boolean not null default false, add column status text, add column account_class text,
                                       add column active boolean;
             create table public.dealer_users (uid uuid primary key, email text, dealer_id uuid references public.dealers(id), status text);
             insert into public.dealers (id, business_name, parent_id, active, status, account_class, is_test) values
               ('${INHQ}', 'Inactive Medical HQ', null, false, null, null, false),
               ('${INBR}', 'Inactive Medical Branch', '${INHQ}', true, null, null, false),
               ('${PRHQ}', 'Prospect Medical HQ', null, true, 'prospect', null, false),
               ('${PRBR}', 'Prospect Medical Branch', '${PRHQ}', true, null, null, false),
               ('${CLOSED}', 'Closed Medical', null, true, 'closed', null, false),
               ('${MFR}', 'A Manufacturer', null, true, null, 'manufacturer', false),
               ('${TESTD}', 'TEST — Golden Sandbox', null, true, null, null, true),
               ('${TESTBR}', 'TEST Sandbox Branch (not TEST itself)', '${TESTD}', true, null, null, false),
               ('${TESTUNDERREAL}', 'TEST Branch of a real dealer', '${HQ}', true, null, null, true);
             update public.dealers set account_class = 'prospect' where id = '${OTHER}';
             insert into public.dealer_users values ('00000000-0000-0000-0000-00000000d001', 'p360@hqnorth.example', '${NORTH}', 'approved');`);
  file(name, SUP('academy_a1_foundation.sql'));
  run(name, 'grant all on all tables in schema public to service_role');
  for (const f of PRE) file(name, SUP(f));
}

const DB = 'academy_free_' + process.pid;
makeDb(DB);
const preF1 = run(DB, `select md5(string_agg(pg_get_functiondef(p.oid), '|' order by p.proname)) from pg_proc p where p.pronamespace = 'public'::regnamespace
                        and p.proname in ('academy_purchase_dealer_eligible', 'academy_purchase_member_guard')`);
const installOut = file(DB, SUP('academy_p2_f1_free_access.sql'));
const flags = f => run(DB, `insert into app_settings (key, value) values ('phase2_flags', ${J(f)}) on conflict (key) do update set value = excluded.value`);
const ON = { academy_admin: true, academy_learner: true, academy_invites: true, academy_open: true, academy_payments: true, academy_exams: true, academy_certificates: true };
flags(ON);

function course(slug, title, mfr, type) {
  const C = JSON.parse(run(DB, `select academy_content_op_create_course(${PRES}, null, ${J(Object.assign({ slug, title, course_type: type || 'hcps_certification' }, mfr ? { manufacturer_slug: mfr } : {}))})`)).id;
  const V = JSON.parse(run(DB, `select academy_content_op_create_version(${PRES}, null, '${C}', '{"exam_questions":1}')`)).id;
  const M = JSON.parse(run(DB, `select academy_content_op_create_module(${PRES}, null, '${V}', ${J({ title: 'Module A' })})`)).id;
  const Q = JSON.parse(run(DB, `select academy_author_op_create_question(${PRES}, null, '${V}', ${J({ module_id: M, kind: 'single', use: 'exam', prompt: 'Exam Q?', choices: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], answer_key: 'b', explanation: 'EXAM-SECRET', objective_tags: ['t'] })})`)).id;
  const L = JSON.parse(run(DB, `select academy_content_op_create_lesson(${PRES}, null, '${M}', ${J({ title: 'Lesson one', est_minutes: 10 })})`)).id;
  run(DB, `select academy_author_op_set_blocks(${PRES}, '${L}', ${J([{ kind: 'text', heading: 'Hello', body: 'Welcome.' }])})`);
  run(DB, `select academy_content_op_move_version(${PRES}, '${V}', 'in_review')`); run(DB, `select academy_publish_op_publish_version(${PRES}, '${V}', null)`);
  return { C, V, L, Q, slug };
}
const GOLD = course('golden-lift-chair-sales-certification', 'HCPS Lift Chair Sales & Product Knowledge Certification', 'golden-technologies');
const SALES = course('dealer-sales-basics', 'Dealer Sales Basics', null);
const TESTC = course('test-sandbox-course', 'TEST Sandbox Course', null);

const mails = [], pendingJobs = [], stripeCalls = []; let sessionN = 0;
const S = shim({ db: DB, psql: PSQL, tokens: { pres: 'admin@test.example', adm: 'admin2@test.example' },
  passthrough: async (url, o) => {
    const u = String(url);
    if (u === 'https://api.stripe.com/v1/checkout/sessions') {
      stripeCalls.push({ body: new URLSearchParams(o.body) });
      sessionN++; const id = 'cs_test_f1' + String(sessionN).padStart(8, '0');
      return new Response(JSON.stringify({ id, url: 'https://checkout.stripe.com/c/pay/' + id, expires_at: Math.floor(Date.now() / 1000) + 3600, livemode: false }), { status: 200 });
    }
    if (u === 'https://api.resend.com/emails') { mails.push(JSON.parse(o.body)); return new Response('{"id":"x"}', { status: 200 }); }
    if (u.endsWith('/.netlify/functions/academy-mail-background')) { pendingJobs.push(require('../netlify/functions/academy-mail-background.js')._run({ httpMethod: 'POST', body: o.body })); return new Response(null, { status: 202 }); }
    return new Response('{}', { status: 599 });
  } });
run(DB, "insert into staff_users (email, name, role, active) values ('admin2@test.example', 'Second Admin', 'admin', true)");
process.env.SUPABASE_URL = BASE; process.env.SUPABASE_SERVICE_ROLE = 'svc-test-key';
process.env.ACADEMY_SESSION_SECRET = 'test-secret-0123456789-abcdefghijklmnopqrstuvwxyz-0123';
process.env.RESEND_API_KEY = 're_test'; process.env.ACADEMY_SIGNIN_FLOOR_MS = '20'; process.env.ACADEMY_MAIL_FROM = 'HCPS Academy <academy@test.example>';
const WHSEC = 'whsec_' + 'B'.repeat(32);
process.env.STRIPE_SECRET_KEY = 'sk_test_' + 'A'.repeat(24); process.env.STRIPE_WEBHOOK_SECRET = WHSEC;
process.env.ACADEMY_SANDBOX_BUYER_RE = '@';   // test-only: any address may open a sandbox checkout here
global.fetch = S.fetch;
const API = require('../netlify/functions/academy-api.js');
const ADMIN = require('../netlify/functions/academy-admin-api.js');
const FREE = require('../netlify/functions/academy-free.js');
const CHECKOUT = require('../netlify/functions/academy-checkout.js');
const HOOK = require('../netlify/functions/academy-stripe-webhook.js');
const VERIFY = require('../netlify/functions/academy-verify.js');

const cookieOf = out => { const c = ((out.multiValueHeaders || {})['set-cookie'] || [])[0] || ''; return c.split(';')[0]; };
async function call(handler, body, o) {
  o = o || {};
  const headers = Object.assign({ origin: ORIGIN, 'x-academy-request': '1', 'x-nf-client-connection-ip': o.ip || '203.0.113.7' }, o.cookie ? { cookie: o.cookie } : {}, o.headers || {});
  for (const k of Object.keys(headers)) if (headers[k] === undefined) delete headers[k];
  const out = await handler({ httpMethod: o.method || 'POST', headers, body: o.raw != null ? o.raw : JSON.stringify(body || {}), queryStringParameters: o.query || {} });
  await Promise.all(pendingJobs.splice(0));
  let j = null; try { j = out.body ? JSON.parse(out.body) : null; } catch (e) { j = out.body; }
  return { status: out.statusCode, body: j, cookie: cookieOf(out), raw: out };
}
const learner = (body, cookie, o) => call(API.handler, body, Object.assign({ cookie }, o || {}));
const admin = (tok, body) => call(ADMIN.handler, body, { headers: { authorization: 'Bearer ' + tok, 'x-academy-request': undefined } });
let ipN = 10;
const register = (b, o) => call(FREE.handler, Object.assign({ action: 'register', course_slug: SALES.slug, full_name: 'Pat Outside', company: 'Outside Mobility LLC' }, b),
                                Object.assign({ ip: '198.51.100.' + (ipN++) }, o || {}));
const freeCatalog = () => call(FREE.handler, null, { method: 'GET', query: { action: 'catalog' } });
const lastCode = to => { const m = mails.filter(x => x.to[0] === to).pop(); return m && (/is your HCPS Academy sign-in code/.test(m.subject) ? m.subject.slice(0, 6) : null); };
async function codeSignIn(addr) {
  const code = lastCode(addr); assert.ok(code, 'a code was emailed to ' + addr);
  const v = await learner({ action: 'verify_code', email: addr, code }); assert.strictEqual(v.status, 200, JSON.stringify(v.body));
  return v.cookie;
}
async function signIn(addr) {
  mails.length = 0;
  assert.strictEqual((await learner({ action: 'request_code', email: addr }, null, { ip: '192.0.2.' + (ipN++ % 250) })).status, 200);
  return codeSignIn(addr);
}
const setAccess = (c, mode, reason) => admin('pres', { action: 'set_course_access', course_id: c.C, mode: mode || 'free', reason: reason || 'Free launch decision (issue 29)' });
const enrollmentsOf = email => JSON.parse(run(DB, `select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'source', e.access_source, 'status', e.status, 'dealer', m.dealer_id, 'org', m.organization_id, 'version', e.version_id)), '[]')
                                                  from academy_enrollments e join academy_learners l on l.id = e.learner_id join academy_memberships m on m.id = e.membership_id where l.email = '${email}'`));
async function completeAndPass(cookie, c, enr) {
  assert.strictEqual((await learner({ action: 'save_progress', enrollment_id: enr, lesson_id: c.L, status: 'completed', resume_block: 0 }, cookie)).status, 200);
  const s = await learner({ action: 'exam_start', enrollment_id: enr }, cookie); assert.strictEqual(s.status, 200, JSON.stringify(s.body));
  assert.strictEqual((await learner({ action: 'exam_view', attempt_id: s.body.attempt_id }, cookie)).status, 200);
  const r = await learner({ action: 'exam_submit', attempt_id: s.body.attempt_id, answers: { [c.Q]: 'b' } }, cookie);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.strictEqual(r.body.passed, true);
  return r.body;
}
let evtN = 0;
async function hook(type, object) {
  const ev = { id: 'evt_f1' + String(++evtN).padStart(12, '0'), object: 'event', type, livemode: false, data: { object } };
  const raw = JSON.stringify(ev), ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', WHSEC).update(ts + '.' + raw).digest('hex');
  return call(HOOK.handler, null, { raw, headers: { 'stripe-signature': `t=${ts},v1=${sig}`, origin: undefined, 'x-academy-request': undefined } });
}

(async () => {
  try {
    await t('install: the six F1 install checks read true', async () => {
      const rows = installOut.split('\n').filter(l => l.includes('|'));
      assert.strictEqual(rows.length, 6, installOut); for (const r of rows) assert.ok(r.endsWith('|t'), r);
      assert.ok(!tryRun(DB, 'select 1 from academy_course_access').out, 'empty');
      assert.ok(!tryRun(DB, `\\i ${SUP('academy_p2_f1_free_access.sql')}`).ok, 'a second install is refused');
    });

    await t('eligibility: the CRM active flag decides; a branch never inherits from an inactive / prospect head office; TEST is never inherited', async () => {
      const e = id => run(DB, `select academy_purchase_dealer_eligible('${id}')`);
      const want = { [HQ]: 't', [NORTH]: 't', [OTHER]: 'f', [INHQ]: 'f', [INBR]: 'f', [PRHQ]: 'f', [PRBR]: 'f', [CLOSED]: 'f', [MFR]: 'f',
                     [TESTD]: 't', [TESTBR]: 'f', [TESTUNDERREAL]: 't' };
      for (const [id, v] of Object.entries(want)) assert.strictEqual(e(id), v, id);
      assert.strictEqual(e('00000000-0000-0000-0000-000000000999'), 'f', 'an unknown dealer');
      run(DB, `update dealers set active = false where id = '${NORTH}'`);
      assert.strictEqual(e(NORTH), 'f', 'an inactive branch of an active head office is not in the network');
      run(DB, `update dealers set active = null where id = '${NORTH}'`);
      assert.strictEqual(e(NORTH), 't', 'a blank active flag (CRM default) still counts as active');
      // the President's audited override still wins on the dealer, then on the head office
      assert.strictEqual((await admin('pres', { action: 'set_eligibility', dealer_id: INHQ, eligible: true, reason: 'Reopened account' })).status, 200);
      assert.strictEqual(e(INBR), 't', 'a head-office override covers its branches');
      assert.strictEqual((await admin('pres', { action: 'set_eligibility', dealer_id: INBR, eligible: false, reason: 'Branch closed' })).status, 200);
      assert.strictEqual(e(INBR), 'f');
      await admin('pres', { action: 'set_eligibility', dealer_id: INHQ, eligible: null, reason: 'Back to the standard rule' });
      await admin('pres', { action: 'set_eligibility', dealer_id: INBR, eligible: null, reason: 'Back to the standard rule' });
      assert.strictEqual(e(INBR), 'f');
    });

    await t('RULE 19: public roles read nothing; the server cannot write an access policy or registration directly; operations are server-only', async () => {
      for (const tb of ['academy_course_access', 'academy_free_registrations']) {
        assert.ok(!tryRun(DB, `set role anon; select * from ${tb}`).ok, tb + ' anon');
        assert.ok(!tryRun(DB, `set role authenticated; select * from ${tb}`).ok, tb + ' authenticated');
        assert.ok(tryRun(DB, `set role service_role; select * from ${tb}`).ok, tb + ' server reads');
      }
      assert.ok(!tryRun(DB, `set role service_role; insert into academy_course_access (course_id, mode, reason, set_by) values ('${SALES.C}', 'free', 'sneaky way', 'x')`).ok);
      const own = tryRun(DB, `insert into academy_course_access (course_id, mode, reason, set_by) values ('${SALES.C}', 'free', 'sneaky way', 'x')`);
      assert.ok(!own.ok && /audited operation/.test(own.err), 'not even the owner outside an operation: ' + own.err);
      for (const fn of [`academy_free_op_catalog()`, `academy_free_op_enroll('learner:x', null)`]) {
        assert.ok(!tryRun(DB, `set role anon; select ${fn}`).ok, fn + ' anon');
        assert.ok(!tryRun(DB, `set role authenticated; select ${fn}`).ok, fn + ' authenticated');
      }
      assert.ok(!tryRun(DB, `set role service_role; select academy_purchase_dealer_eligible('${HQ}')`).ok, 'the helper is not callable by the server');
    });

    await t('before any policy: nothing is free; the free catalog is empty; registration is refused (not_free)', async () => {
      const c = await freeCatalog(); assert.strictEqual(c.status, 200); assert.deepStrictEqual(c.body, { enabled: true, courses: [] });
      const r = await register({ email: 'early@outside.example' }); assert.strictEqual(r.status, 404); assert.strictEqual(r.body.error, 'not_free');
      assert.strictEqual(run(DB, `select count(*) from academy_learners where email = 'early@outside.example'`), '0');
    });

    // an outside buyer who PAID before the free launch (sandbox) — must keep working afterwards
    let PAID;
    await t('setup: a sandbox purchase made while the course was still paid', async () => {
      assert.strictEqual((await admin('pres', { action: 'set_price', course_id: SALES.C, price_outside_cents: 1999, outside_sale_allowed: true })).status, 200);
      const r = await call(CHECKOUT.handler, { action: 'start', course_slug: SALES.slug, full_name: 'Early Buyer', company: 'Early Co', email: 'angelo+academy-earlybuyer@homecareproviderservices.us' });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      const sid = r.body.url.split('/').pop();
      const p = JSON.parse(run(DB, `select to_jsonb(p) from academy_purchases p where stripe_session_id = '${sid}'`));
      const g = await hook('checkout.session.completed', { id: sid, object: 'checkout.session', client_reference_id: p.id, payment_status: 'paid', amount_total: 1999, currency: 'usd', payment_intent: 'pi_' + sid.slice(8) });
      assert.strictEqual(g.body.outcome, 'granted');
      PAID = { sid, pi: 'pi_' + sid.slice(8), id: p.id };
      // and one buyer left an open checkout
      const o = await call(CHECKOUT.handler, { action: 'start', course_slug: SALES.slug, full_name: 'Open Buyer', company: 'Open Co', email: 'angelo+academy-openbuyer@homecareproviderservices.us' });
      assert.strictEqual(o.status, 200);
      PAID.openSid = o.body.url.split('/').pop();
    });

    await t('access policy: only the President sets it (API and database), with a reason; audited; the price is kept', async () => {
      const a = await admin('adm', { action: 'set_course_access', course_id: SALES.C, mode: 'free', reason: 'Free launch decision' });
      assert.strictEqual(a.status, 403); assert.strictEqual(a.body.error, 'president_only');
      assert.ok(!tryRun(DB, `select academy_free_op_set_access('staff:admin2@test.example', '${SALES.C}', 'free', null, 'Free launch decision')`).ok);
      assert.strictEqual((await admin('pres', { action: 'set_course_access', course_id: SALES.C, mode: 'free', reason: 'no' })).status, 400, 'a reason is required');
      assert.strictEqual((await admin('pres', { action: 'set_course_access', course_id: SALES.C, mode: 'gratis', reason: 'Free launch decision' })).status, 400);
      const ok = await setAccess(SALES); assert.strictEqual(ok.status, 200, JSON.stringify(ok.body)); assert.strictEqual(ok.body.access.mode, 'free');
      const g = await setAccess(GOLD); assert.strictEqual(g.status, 200);
      assert.strictEqual(run(DB, `select price_outside_cents from academy_prices where course_id = '${SALES.C}'`), '1999', 'the price is not wiped');
      assert.strictEqual(run(DB, `select count(*) from academy_events where entity = 'academy_course_access' and action = 'set_access'`), '2');
      assert.strictEqual(run(DB, `select status from academy_purchases where stripe_session_id = '${PAID.openSid}'`), 'superseded', 'an open checkout is closed');
      const mp = JSON.parse(run(DB, `select academy_content_op_create_course(${PRES}, null, ${J({ slug: 'golden-external', title: 'Golden external', course_type: 'manufacturer_program', manufacturer_slug: 'golden-technologies', external_url: 'https://www.goldentech.com/training' })})`)).id;
      const m = await admin('pres', { action: 'set_course_access', course_id: mp, mode: 'free', reason: 'Free launch decision' });
      assert.strictEqual(m.status, 400, 'a manufacturer program is never enrolled here');
    });

    await t('payments view: shows each course\'s access mode; never a secret', async () => {
      const r = await admin('adm', { action: 'payments' }); assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.access_installed, true);
      const s = r.body.courses.find(c => c.id === SALES.C); assert.strictEqual(s.access.mode, 'free'); assert.strictEqual(s.price.price_outside_cents, 1999);
      assert.ok(!JSON.stringify(r.body).includes('whsec') && !JSON.stringify(r.body).includes('sk_test'));
    });

    await t('a FREE course is never sold: left out of the paid catalog, checkout answers "free", the database refuses a checkout row', async () => {
      const cat = await call(CHECKOUT.handler, null, { method: 'GET', query: { action: 'catalog' } });
      assert.ok(!cat.body.courses.some(c => c.slug === SALES.slug), JSON.stringify(cat.body));
      const n = stripeCalls.length;
      const r = await call(CHECKOUT.handler, { action: 'start', course_slug: SALES.slug, full_name: 'Pat', company: 'Co', email: 'x@outside.example' });
      assert.strictEqual(r.status, 409); assert.strictEqual(r.body.error, 'free'); assert.match(r.body.message, /No credit card required|no credit card required/i);
      assert.strictEqual(stripeCalls.length, n, 'no Stripe call');
      const direct = tryRun(DB, `select academy_purchase_op_open('x@outside.example', 'Pat', 'Co', '${SALES.slug}', repeat('a', 64))`);
      assert.ok(!direct.ok && /not sold/.test(direct.err), 'refused by the database on every path: ' + direct.err);
      assert.strictEqual(run(DB, `select count(*) from academy_purchases where email = 'x@outside.example'`), '0');
    });

    await t('free catalog: the published FREE courses only — never a TEST course; GET cannot register', async () => {
      await setAccess(TESTC);
      const c = await freeCatalog();
      assert.deepStrictEqual(c.body.courses.map(x => x.slug).sort(), [GOLD.slug, SALES.slug].sort());
      assert.strictEqual((await call(FREE.handler, null, { method: 'GET', query: { action: 'register' } })).status, 405);
      assert.strictEqual((await call(FREE.handler, null, { method: 'PUT' })).status, 405);
    });

    await t('registration security: own pages only (header + origin), known actions only, pilot / switch off refused', async () => {
      assert.strictEqual((await register({ email: 'a@outside.example' }, { headers: { 'x-academy-request': undefined } })).status, 403);
      assert.strictEqual((await register({ email: 'a@outside.example' }, { headers: { origin: 'https://evil.example' } })).status, 403);
      assert.strictEqual((await call(FREE.handler, { action: 'grant' })).status, 404);
      flags(Object.assign({}, ON, { academy_open: false }));
      assert.strictEqual((await register({ email: 'a@outside.example' })).body.error, 'flag_off');
      assert.strictEqual((await freeCatalog()).body.enabled, false);
      flags(Object.assign({}, ON, { academy_learner: false }));
      assert.strictEqual((await register({ email: 'a@outside.example' })).body.error, 'flag_off');
      flags(ON);
      assert.strictEqual((await register({ email: 'not-an-email' })).status, 400);
      assert.strictEqual((await register({ email: 'a@outside.example', course_slug: TESTC.slug })).body.error, 'not_free', 'a TEST course is never open to the public');
      assert.strictEqual(run(DB, `select count(*) from academy_learners where email = 'a@outside.example'`), '0');
    });

    await t('registration refusals: HCPS staff, a Partner 360 user (one identity), a suspended learner', async () => {
      const s = await register({ email: 'Admin@Test.example' }); assert.strictEqual(s.status, 403); assert.strictEqual(s.body.error, 'staff');
      const p = await register({ email: 'p360@hqnorth.example' }); assert.strictEqual(p.status, 409); assert.strictEqual(p.body.error, 'partner360');
      assert.match(p.body.message, /Partner 360/);
      // a suspended learner
      await register({ email: 'sus@outside.example' });
      const lid = run(DB, `select id from academy_learners where email = 'sus@outside.example'`);
      assert.strictEqual((await admin('pres', { action: 'set_learner_status', learner_id: lid, status: 'suspended', reason: 'Test suspension' })).status, 200);
      const r = await register({ email: 'sus@outside.example' }); assert.strictEqual(r.status, 403); assert.strictEqual(r.body.error, 'not_allowed');
      mails.length = 0;
      await learner({ action: 'request_code', email: 'sus@outside.example' });
      assert.ok(!lastCode('sus@outside.example'), 'no code for a suspended learner');
    });

    let OUT;
    await t('outside learner: registration creates learner + outside organization + learner-only membership, grants NO course, sends a code', async () => {
      mails.length = 0;
      const r = await register({ email: 'Pat@Outside.example', company: 'Outside Mobility LLC', price_cents: 0, amount: 0 });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.strictEqual(r.body.ok, true);
      assert.match(r.body.message, /6-digit code/);
      assert.ok(lastCode('pat@outside.example'), 'a sign-in code was emailed');
      const m = run(DB, `select coalesce(m.dealer_id::text,'none') || ':' || m.role || ':' || m.access_type || ':' || o.name from academy_memberships m
                         join academy_learners l on l.id = m.learner_id join academy_organizations o on o.id = m.organization_id where l.email = 'pat@outside.example'`);
      assert.strictEqual(m, 'none:learner:training_only:Outside Mobility LLC');
      assert.deepStrictEqual(enrollmentsOf('pat@outside.example'), [], 'registration alone enrolls nothing');
      assert.strictEqual(run(DB, `select count(*) from dealers where business_name ilike '%Outside Mobility%'`), '0', 'never a CRM dealer');
      assert.strictEqual(run(DB, `select count(*) from academy_purchases where email = 'pat@outside.example'`), '0', 'no fake $0 order');
      assert.ok(Number(run(DB, `select count(*) from academy_events where actor = 'system:free'`)) >= 3, 'audited');
      OUT = await codeSignIn('pat@outside.example');
    });

    await t('repeat registration: same answer, nothing duplicated; the email rate limit stops floods (no account change)', async () => {
      const r = await register({ email: 'pat@outside.example', company: 'Outside Mobility LLC' });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(run(DB, `select count(*) from academy_memberships m join academy_learners l on l.id = m.learner_id where l.email = 'pat@outside.example'`), '1');
      assert.strictEqual(run(DB, `select string_agg(outcome, ',' order by created_at) from academy_free_registrations where email = 'pat@outside.example'`), 'created,existing');
      await register({ email: 'pat@outside.example' });
      const lim = await register({ email: 'pat@outside.example' }); assert.strictEqual(lim.status, 429); assert.strictEqual(lim.body.error, 'limited');
      let ipLimited = 0;
      for (let i = 0; i < 12; i++) { const x = await register({ email: `flood${i}@outside.example` }, { ip: '192.0.2.250' }); if (x.status === 429) ipLimited++; }
      assert.strictEqual(ipLimited, 2, 'ten sign-ups per network address per hour');
    });

    let OUT_E;
    await t('outside learner enrolls free (access_source free), sees it, and repeated / simultaneous clicks make ONE enrollment', async () => {
      const f = await learner({ action: 'free_courses' }, OUT); assert.strictEqual(f.status, 200);
      assert.deepStrictEqual(f.body.courses.map(c => c.slug + ':' + c.enrolled).sort(), [GOLD.slug + ':false', SALES.slug + ':false'].sort());
      const outs = await Promise.all(Array.from({ length: 6 }, () => learner({ action: 'enroll_free', course_slug: SALES.slug }, OUT)));
      assert.ok(outs.every(o => o.status === 200), JSON.stringify(outs.map(o => [o.status, o.body])));
      assert.strictEqual(new Set(outs.map(o => o.body.enrollment_id)).size, 1);
      assert.strictEqual(outs.filter(o => !o.body.existing).length, 1);
      const e = enrollmentsOf('pat@outside.example'); assert.strictEqual(e.length, 1);
      assert.strictEqual(e[0].source, 'free'); assert.strictEqual(e[0].dealer, null); assert.ok(e[0].org);
      OUT_E = e[0].id;
      assert.strictEqual((await learner({ action: 'enroll_free', course_slug: 'no-such-course' }, OUT)).status, 404);
      assert.strictEqual((await learner({ action: 'enroll_free', course_slug: SALES.slug }, null)).status, 401, 'signed in only');
      assert.strictEqual((await learner({ action: 'enroll_free', course_slug: SALES.slug }, OUT, { method: 'GET', query: { action: 'enroll_free', course_slug: SALES.slug } })).status, 405);
      const mc = await learner({ action: 'my_courses' }, OUT); assert.strictEqual(mc.body.courses.length, 1); assert.strictEqual(mc.body.courses[0].course, 'Dealer Sales Basics');
      assert.ok(!JSON.stringify(mc.body).includes('EXAM-SECRET'));
    });

    await t('outside learner: lessons → exam → HCPS certificate → public verification, the full path', async () => {
      const r = await completeAndPass(OUT, SALES, OUT_E);
      assert.ok(r.certificate && r.certificate.cert_number, JSON.stringify(r));
      assert.match(r.certificate.disclosure, /not issued, sponsored or endorsed by Golden Technologies/);
      const v = await call(VERIFY.handler, null, { method: 'GET', query: { n: r.certificate.cert_number } });
      assert.strictEqual(v.status, 200, JSON.stringify(v.body)); assert.strictEqual(v.body.found, true); assert.strictEqual(v.body.status, 'valid');
      assert.ok(!JSON.stringify(v.body).includes('pat@outside.example'), 'verification never shows an email');
    });

    let DLR;
    await t('HCPS dealer path: a learner at an eligible branch enrolls free through the dealership membership (no organization)', async () => {
      assert.strictEqual((await admin('pres', { action: 'invite_learner', dealer_id: NORTH, email: 'lee@hqnorth.example' })).status, 200);
      DLR = await signIn('lee@hqnorth.example');
      const r = await learner({ action: 'enroll_free', course_slug: GOLD.slug }, DLR); assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      const e = enrollmentsOf('lee@hqnorth.example'); assert.strictEqual(e.length, 1);
      assert.strictEqual(e[0].dealer, NORTH); assert.strictEqual(e[0].org, null); assert.strictEqual(e[0].source, 'free');
      const reg = await register({ email: 'lee@hqnorth.example', course_slug: GOLD.slug, company: 'HQ Medical North' });
      assert.strictEqual(reg.status, 200);
      assert.strictEqual(run(DB, `select count(*) from academy_memberships m join academy_learners l on l.id = m.learner_id where l.email = 'lee@hqnorth.example' and m.organization_id is not null`), '0',
        'a network learner gets no outside organization');
      const done = await completeAndPass(DLR, GOLD, e[0].id); assert.ok(done.certificate);
    });

    await t('inactive / prospect branch: the dealership membership is NOT network access; no ordering, CRM or dealer link is created', async () => {
      assert.strictEqual((await admin('pres', { action: 'invite_learner', dealer_id: INBR, email: 'ina@inactive.example' })).status, 200);
      const C = await signIn('ina@inactive.example');
      const r = await learner({ action: 'enroll_free', course_slug: SALES.slug }, C);
      assert.strictEqual(r.status, 403, JSON.stringify(r.body)); assert.match(r.body.message, /network dealership or a registered outside company/);
      // they may still learn free as an OUTSIDE learner: an outside organization, never their inactive branch
      const reg = await register({ email: 'ina@inactive.example', company: 'Inactive Medical Branch' }); assert.strictEqual(reg.status, 200);
      const ok = await learner({ action: 'enroll_free', course_slug: SALES.slug }, C); assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
      const e = enrollmentsOf('ina@inactive.example'); assert.strictEqual(e[0].dealer, null); assert.ok(e[0].org);
      assert.strictEqual(run(DB, `select count(*) from dealer_users where lower(email) = 'ina@inactive.example'`), '0', 'no Partner 360 / ordering account');
      assert.strictEqual(run(DB, `select coalesce(active::text, 'null') from dealers where id = '${INBR}'`), 'true', 'the CRM record is untouched');
    });

    await t('TEST course: only a TEST dealership\'s people; never an outside learner', async () => {
      const r = await learner({ action: 'enroll_free', course_slug: TESTC.slug }, OUT); assert.strictEqual(r.status, 400); assert.match(r.body.message, /TEST/);
      assert.strictEqual((await admin('pres', { action: 'invite_learner', dealer_id: TESTD, email: 'angelo+academy-free@homecareproviderservices.us' })).status, 200);
      const T = await signIn('angelo+academy-free@homecareproviderservices.us');
      const ok = await learner({ action: 'enroll_free', course_slug: TESTC.slug }, T); assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    });

    await t('suspended / ended access: the session closes and free enrollment is refused', async () => {
      await register({ email: 'kim@outside.example', company: 'Kim Co' });
      const K = await codeSignIn('kim@outside.example');
      const lid = run(DB, `select id from academy_learners where email = 'kim@outside.example'`);
      await admin('pres', { action: 'set_learner_status', learner_id: lid, status: 'suspended', reason: 'Test suspension' });
      assert.strictEqual((await learner({ action: 'enroll_free', course_slug: SALES.slug }, K)).status, 401);
      assert.ok(!tryRun(DB, `select academy_free_op_enroll('learner:${lid}', '${SALES.C}')`).ok, 'the database refuses too');
      assert.ok(!tryRun(DB, `select academy_free_op_enroll('staff:admin@test.example', '${SALES.C}')`).ok, 'staff never enroll as learners');
      assert.strictEqual(enrollmentsOf('kim@outside.example').length, 0);
    });

    await t('old paid purchase: its refund webhook still works after the switch to free; the learner can then enroll free (restored, not duplicated)', async () => {
      const buyer = run(DB, `select learner_id from academy_purchases where id = '${PAID.id}'`);
      const r = await hook('charge.refunded', { object: 'charge', payment_intent: PAID.pi, amount: 1999, amount_refunded: 1999 });
      assert.strictEqual(r.body.outcome, 'refunded');
      assert.strictEqual(run(DB, `select e.status from academy_enrollments e join academy_purchases p on p.enrollment_id = e.id where p.id = '${PAID.id}'`), 'withdrawn');
      const B = await signIn('angelo+academy-earlybuyer@homecareproviderservices.us');
      const f = await learner({ action: 'enroll_free', course_slug: SALES.slug }, B); assert.strictEqual(f.status, 200, JSON.stringify(f.body));
      assert.strictEqual(run(DB, `select count(*) || ':' || string_agg(access_source || '/' || status, ',') from academy_enrollments where learner_id = '${buyer}'`), '1:free/not_started');
      assert.strictEqual(run(DB, `select status from academy_purchases where id = '${PAID.id}'`), 'refunded', 'the purchase record is kept as it was');
    });

    await t('later switch to PAID: free learners keep enrollment, progress and certificate; new free enrollment stops; the course can be sold again', async () => {
      const before = run(DB, `select count(*) from academy_enrollments where access_source = 'free' and status <> 'withdrawn'`);
      assert.strictEqual((await setAccess(SALES, 'paid', 'Paid enrollment introduced')).status, 200);
      assert.strictEqual(run(DB, `select count(*) from academy_enrollments where access_source = 'free' and status <> 'withdrawn'`), before);
      assert.notStrictEqual(enrollmentsOf('pat@outside.example')[0].status, 'withdrawn');
      assert.strictEqual(run(DB, `select count(*) from academy_progress where enrollment_id = '${OUT_E}' and status = 'completed'`), '1', 'progress kept');
      assert.strictEqual(run(DB, `select count(*) from academy_certificates c join academy_enrollments e on e.id = c.enrollment_id where e.id = '${OUT_E}' and c.revoked_at is null`), '1');
      assert.strictEqual((await learner({ action: 'my_courses' }, OUT)).body.courses.length, 1);
      await register({ email: 'late@outside.example', company: 'Late Co' }).then(x => assert.strictEqual(x.body.error, 'not_free'));
      const late = await learner({ action: 'enroll_free', course_slug: SALES.slug }, DLR); assert.strictEqual(late.status, 400);
      const cat = await call(CHECKOUT.handler, null, { method: 'GET', query: { action: 'catalog' } });
      assert.ok(cat.body.courses.some(c => c.slug === SALES.slug && c.price_cents === 1999), 'back on sale at the kept price');
      assert.strictEqual((await call(CHECKOUT.handler, { action: 'start', course_slug: SALES.slug, full_name: 'Pat Outside', company: 'Outside Mobility LLC', email: 'pat@outside.example' })).body.error, 'already_enrolled',
        'a free learner is never asked to pay for a course they have');
      assert.strictEqual((await setAccess(SALES, 'off', 'Pause new enrollments')).status, 200);
      assert.strictEqual((await call(CHECKOUT.handler, { action: 'start', course_slug: SALES.slug, full_name: 'P', company: 'Co', email: 'off@outside.example' })).status, 400, 'off: not sold either');
      assert.strictEqual((await learner({ action: 'my_courses' }, OUT)).body.courses.length, 1, 'off never removes anyone');
      await setAccess(SALES, 'free', 'Free launch decision (issue 29)');
    });

    await t('real concurrency: two database sessions enrolling at the same instant both answer, with ONE enrollment (the lock, not an error)', async () => {
      const lid = run(DB, `select id from academy_learners where email = 'pat@outside.example'`);
      run(DB, `create function pg_temp_slow() returns trigger language plpgsql as $$ begin perform pg_sleep(0.6); return new; end $$;
               create trigger zz_slow before insert on academy_enrollments for each row execute function pg_temp_slow();`);
      try {
        const { spawn } = require('child_process');
        const one = () => new Promise(res => { const p = spawn(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', DB, '-c', `select academy_free_op_enroll('learner:${lid}', '${GOLD.C}')`]);
          let out = '', err = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d); p.on('close', code => res({ code, out: out.trim(), err })); });
        const rs = await Promise.all([one(), one()]);
        assert.ok(rs.every(r => r.code === 0), JSON.stringify(rs.map(r => r.err)));
        assert.strictEqual(new Set(rs.map(r => JSON.parse(r.out).enrollment_id)).size, 1);
        assert.strictEqual(run(DB, `select count(*) from academy_enrollments e join academy_course_versions v on v.id = e.version_id where e.learner_id = '${lid}' and v.course_id = '${GOLD.C}'`), '1');
      } finally { run(DB, `drop trigger zz_slow on academy_enrollments; drop function pg_temp_slow()`); }
    });

    await t('Golden technical certifications: only PUBLISHED manufacturer programs are listed to learners, with Golden\'s link; nothing recorded', async () => {
      const mp = run(DB, `select id from academy_courses where slug = 'golden-external'`);
      let r = await learner({ action: 'manufacturer_programs' }, OUT); assert.strictEqual(r.status, 200); assert.deepStrictEqual(r.body.programs, [], 'a draft program is not shown');
      run(DB, `select academy_publish_op_publish_course(${PRES}, '${mp}')`);
      r = await learner({ action: 'manufacturer_programs' }, OUT);
      assert.strictEqual(r.body.programs.length, 1); assert.strictEqual(r.body.programs[0].url, 'https://www.goldentech.com/training');
      assert.strictEqual(r.body.programs[0].manufacturer, 'Golden Technologies'); assert.strictEqual(r.body.programs[0].credential, null);
      assert.strictEqual((await learner({ action: 'manufacturer_programs' }, null)).status, 401);
      const g = await learner({ action: 'manufacturer_programs' }, OUT, { method: 'GET', query: { action: 'manufacturer_programs' } }); assert.strictEqual(g.status, 200, 'a read action');
      assert.strictEqual(run(DB, `select count(*) from academy_external_certs`), '0');
    });

    await t('records check: every F1 change is audited; no purchase row was made for any free enrollment', async () => {
      assert.strictEqual(run(DB, `select count(*) from academy_enrollments e where e.access_source = 'free' and not exists
                                   (select 1 from academy_events v where v.entity = 'academy_enrollments' and v.entity_id = e.id::text and v.action in ('free_enroll','free_re_enroll'))`), '0');
      assert.strictEqual(run(DB, `select count(*) from academy_purchases p join academy_enrollments e on e.id = p.enrollment_id where e.access_source = 'free'`), '1',
        'only the old refunded purchase points at the restored enrollment');
      const ac = await admin('pres', { action: 'audit_check' }); assert.strictEqual(ac.status, 200);
    });

    await t('rollback: refused while records exist; on a clean install it restores M8 exactly', async () => {
      const r = tryRun(DB, `\\i ${SUP('academy_p2_f1_free_access_rollback.sql')}`);
      assert.ok(!r.ok && /rollback refused/.test(r.err), r.err);
      const DB2 = DB + '_rb'; makeDb(DB2);
      file(DB2, SUP('academy_p2_f1_free_access.sql'));
      file(DB2, SUP('academy_p2_f1_free_access_rollback.sql'));
      const after = run(DB2, `select md5(string_agg(pg_get_functiondef(p.oid), '|' order by p.proname)) from pg_proc p where p.pronamespace = 'public'::regnamespace
                              and p.proname in ('academy_purchase_dealer_eligible', 'academy_purchase_member_guard')`);
      assert.strictEqual(after, preF1, 'M8\'s two functions are back byte for byte');
      assert.strictEqual(run(DB2, `select count(*) from pg_proc where proname like 'academy\\_free\\_%'`), '0');
      assert.strictEqual(run(DB2, `select to_regclass('public.academy_course_access') is null`), 't');
      file(DB2, SUP('academy_p2_f1_free_access.sql'));   // and it can be installed again
      run('postgres', `drop database if exists ${DB2} with (force)`);
    });
  } finally {
    console.log(`\n${pass} passed, ${fail} failed`);
    run('postgres', `drop database if exists ${DB} with (force)`);
    process.exit(fail ? 1 : 0);
  }
})();
