/* HCPS Academy Phase 2 / M8 — eligibility, pricing, outside organizations, Stripe TEST-mode checkout, verified webhooks,
   purchases and refunds. A REAL local Postgres holds A1, M1–M7 and M8 exactly as committed (pg-safeupdate loaded); the
   real academy-checkout.js, academy-stripe-webhook.js, academy-api.js and academy-admin-api.js handlers run unchanged;
   Supabase calls are answered by test/academy-pgrest.js; Stripe's API is a local stand-in (nothing leaves this machine).
     PGHOST=127.0.0.1 PGUSER=postgres PGPASSWORD=… node test/academy-p2.pg.test.js
   PG17.6 without pg-safeupdate: PGTEST_NO_SAFEUPDATE=1. */
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { shim, BASE } = require('./academy-pgrest.js');

const PSQL = process.env.PGTEST_PSQL || 'psql';
const SUP = f => path.join(__dirname, '..', 'supabase', f);
const psql = (db, args) => spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db].concat(args), { encoding: 'utf8' });
const run = (db, sql) => { const r = psql(db, ['-c', sql]); if (r.error || r.status !== 0) throw new Error((r.error && r.error.message) || r.stderr); return r.stdout.trim(); };
const tryRun = (db, sql) => { const r = psql(db, ['-c', sql]); return { ok: r.status === 0, out: r.stdout.trim(), err: r.stderr }; };
const file = (db, f) => { const r = psql(db, ['-f', f]); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
try { run('postgres', 'select 1'); } catch (e) { console.log('SKIP: no Postgres (' + String(e.message).split('\n')[0] + ')'); process.exit(0); }
const NO_SAFEUPDATE = process.env.PGTEST_NO_SAFEUPDATE === '1';
const fixture = () => { let s = fs.readFileSync(path.join(__dirname, 'academy', 'fixture.sql'), 'utf8'); if (NO_SAFEUPDATE) s = s.replace(/^do \$\$ begin execute format\('alter database %I set session_preload_libraries.*$/m, ''); return s; };
const J = v => `$j$${JSON.stringify(v)}$j$::jsonb`;
const PRES = `'staff:admin@test.example'`, ADM2 = `'staff:admin2@test.example'`;
const HQ = '00000000-0000-0000-0000-0000000000a1', NORTH = '00000000-0000-0000-0000-0000000000a2', OTHER = '00000000-0000-0000-0000-0000000000b1';
const MFR = '00000000-0000-0000-0000-0000000000d1', CLOSED = '00000000-0000-0000-0000-0000000000d2', TESTD = '00000000-0000-0000-0000-0000000000c1';
const PBR = '00000000-0000-0000-0000-0000000000b2';   // an ACTIVE branch under the prospect OTHER
const DUID = '00000000-0000-0000-0000-00000000dddd';
const ORIGIN = 'https://www.homecareproviderservices.org';
const WHSEC = 'whsec_testsecret0123456789abcdef';

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + String(e && e.stack || e).split('\n').slice(0, 8).join('\n       ')); } }
const one = (db, q) => JSON.parse(run(db, `select coalesce(to_jsonb(x), 'null') from (${q}) x`));
const jr = (db, q) => JSON.parse(run(db, q));

function install(DB) {
  run('postgres', `drop database if exists ${DB}`); run('postgres', `create database ${DB}`);
  run(DB, fixture());
  run(DB, `alter table public.dealers add column is_test boolean not null default false;
           alter table public.dealers add column status text;
           alter table public.dealers add column account_class text;
           update public.dealers set status = 'active' where true;
           update public.dealers set status = 'prospect' where id = '${OTHER}';
           insert into public.dealers (id, business_name, parent_id, status) values ('${PBR}', 'Prospect Branch', '${OTHER}', 'active');
           insert into public.dealers (id, business_name, status, account_class) values ('${MFR}', 'Some Manufacturer', 'active', 'manufacturer');
           insert into public.dealers (id, business_name, status) values ('${CLOSED}', 'Closed Dealer', 'inactive');
           insert into public.dealers (id, business_name, status, is_test) values ('${TESTD}', 'TEST Sandbox', 'active', true);
           create table public.dealer_users (uid uuid primary key, email text, dealer_id uuid references public.dealers(id), status text);
           insert into auth.users (id, email) values ('${DUID}', 'buyer@hqmed.example');
           insert into public.dealer_users values ('${DUID}', 'buyer@hqmed.example', '${HQ}', 'approved');
           insert into public.dealer_users values ('00000000-0000-0000-0000-00000000eeee', 'owner@prospect.example', '${OTHER}', 'approved');`);
  file(DB, SUP('academy_a1_foundation.sql'));
  run(DB, 'grant all on all tables in schema public to service_role');
  for (const f of ['academy_a2a_m1_audited_ops.sql', 'academy_a2c_m2_content_ops.sql', 'academy_a2d_m3_author_ops.sql', 'academy_a2d_m3_1_save_lesson.sql',
                   'academy_c2_m4_publish_ops.sql', 'academy_a2b_m5_learner_access.sql']) file(DB, SUP(f));
  run(DB, `insert into app_settings (key, value) values ('phase2_flags', '{"academy_admin": true}') on conflict (key) do update set value = excluded.value`);
  file(DB, SUP('academy_a2e_m6_exam_attempts.sql'));
  file(DB, SUP('academy_a2f_m7_certificates.sql'));
  run(DB, "insert into staff_users (email, name, role, active) values ('admin2@test.example', 'Second Admin', 'admin', true) on conflict do nothing");
}
function publishedCourse(DB, slug, title) {
  const C = JSON.parse(run(DB, `select academy_content_op_create_course(${PRES}, null, ${J({ slug, title, course_type: 'hcps_certification', manufacturer_slug: 'golden-technologies' })})`)).id;
  const V = JSON.parse(run(DB, `select academy_content_op_create_version(${PRES}, null, '${C}', '{"exam_questions":1}')`)).id;
  const M = JSON.parse(run(DB, `select academy_content_op_create_module(${PRES}, null, '${V}', ${J({ title: 'Module A' })})`)).id;
  run(DB, `select academy_author_op_create_question(${PRES}, null, '${V}', ${J({ module_id: M, kind: 'single', use: 'exam', prompt: 'Exam Q ' + slug + '?', choices: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], answer_key: 'b', explanation: 'x', objective_tags: ['t'] })})`);
  const L = JSON.parse(run(DB, `select academy_content_op_create_lesson(${PRES}, null, '${M}', ${J({ title: 'Lesson one', est_minutes: 10 })})`)).id;
  run(DB, `select academy_author_op_set_blocks(${PRES}, '${L}', ${J([{ kind: 'text', heading: 'Hello', body: 'Welcome.' }, { kind: 'text', heading: 'Two', body: 'More.' }, { kind: 'text', heading: 'Bye', body: 'Done.' }])})`);
  run(DB, `select academy_content_op_move_version(${PRES}, '${V}', 'in_review')`); run(DB, `select academy_publish_op_publish_version(${PRES}, '${V}', null)`);
  return { C, V, L };
}

const DB = 'academy_p2_' + process.pid;
install(DB);
const INSTALL_OUT = file(DB, SUP('academy_p2_m8_commerce.sql'));
const TC = publishedCourse(DB, 'test-sales-course', 'TEST Sales Course');
const GC = publishedCourse(DB, 'golden-like', 'Golden Lift Chair Sales Certification');
const flags = f => run(DB, `insert into app_settings (key, value) values ('phase2_flags', ${J(f)}) on conflict (key) do update set value = excluded.value`);
const ON = { academy_admin: true, academy_learner: true, academy_open: true, academy_payments: true, academy_exams: true };

/* ---------- Stripe stand-in ---------- */
const stripeCalls = []; let stripeDown = false;
const sessions = new Map();
async function fakeStripe(url, o) {
  const u = new URL(String(url)); const method = (o.method || 'GET').toUpperCase();
  const headers = Object.fromEntries(Object.entries(o.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const params = new URLSearchParams(o.body || '');
  stripeCalls.push({ method, path: u.pathname, headers, params });
  if (stripeDown) return new Response(JSON.stringify({ error: { type: 'api_error' } }), { status: 500 });
  if (!/^Bearer sk_test_/.test(headers.authorization || '')) return new Response('{}', { status: 401 });
  if (method === 'POST' && u.pathname === '/v1/checkout/sessions') {
    const idem = headers['idempotency-key'];
    for (const s of sessions.values()) if (s.idem === idem) return new Response(JSON.stringify(s), { status: 200 });
    const id = 'cs_test_' + crypto.randomBytes(12).toString('hex');
    const s = { id, url: 'https://checkout.stripe.com/c/pay/' + id, status: 'open', idem, amount_total: Number(params.get('line_items[0][price_data][unit_amount]')),
                currency: params.get('line_items[0][price_data][currency]'), customer_email: params.get('customer_email') };
    sessions.set(id, s); return new Response(JSON.stringify(s), { status: 200 });
  }
  if (method === 'GET' && u.pathname.startsWith('/v1/checkout/sessions/')) {
    const s = sessions.get(u.pathname.split('/').pop()); return new Response(JSON.stringify(s || {}), { status: s ? 200 : 404 });
  }
  if (method === 'POST' && u.pathname === '/v1/refunds') return new Response(JSON.stringify({ id: 're_' + crypto.randomBytes(6).toString('hex'), status: 'succeeded' }), { status: 200 });
  return new Response('{}', { status: 404 });
}

const mails = [], pendingJobs = [];
const S = shim({ db: DB, psql: PSQL, tokens: { pres: 'admin@test.example', adm: 'admin2@test.example' },
  passthrough: async (url, o) => {
    const u = String(url);
    if (u.startsWith('https://api.stripe.com/')) return fakeStripe(url, o);
    if (u === 'https://api.resend.com/emails') { mails.push(JSON.parse(o.body)); return new Response('{"id":"x"}', { status: 200 }); }
    if (u.endsWith('/.netlify/functions/academy-mail-background')) { pendingJobs.push(require('../netlify/functions/academy-mail-background.js')._run({ httpMethod: 'POST', body: o.body })); return new Response(null, { status: 202 }); }
    return new Response('{}', { status: 599 });
  } });
process.env.SUPABASE_URL = BASE; process.env.SUPABASE_SERVICE_ROLE = 'svc-test-key';
process.env.ACADEMY_SESSION_SECRET = 'test-secret-0123456789-abcdefghijklmnopqrstuvwxyz-0123';
process.env.RESEND_API_KEY = 're_test'; process.env.ACADEMY_SIGNIN_FLOOR_MS = '20'; process.env.ACADEMY_MAIL_FROM = 'HCPS Academy <academy@test.example>';
global.fetch = S.fetch;
const CO = require('../netlify/functions/academy-checkout.js');
const WH = require('../netlify/functions/academy-stripe-webhook.js');
const API = require('../netlify/functions/academy-api.js');
const ADMIN = require('../netlify/functions/academy-admin-api.js');
const C = require('../netlify/functions/_academy_commerce.js');
const D360 = require('../netlify/functions/_academy_d360.js');

async function call(handler, body, o) {
  o = o || {};
  const headers = Object.assign({ origin: ORIGIN, 'x-academy-request': '1', 'x-nf-client-connection-ip': o.ip || '203.0.113.7' }, o.cookie ? { cookie: o.cookie } : {}, o.headers || {});
  const out = await handler({ httpMethod: o.method || 'POST', headers, body: o.raw != null ? o.raw : JSON.stringify(body || {}), queryStringParameters: o.query || {} });
  await Promise.all(pendingJobs.splice(0));
  let j = null; try { j = out.body ? JSON.parse(out.body) : null; } catch (e) { j = out.body; }
  const c = ((out.multiValueHeaders || {})['set-cookie'] || [])[0] || '';
  return { status: out.statusCode, body: j, cookie: c.split(';')[0], raw: out };
}
const buy = (body, o) => call(CO.handler, Object.assign({ action: 'start' }, body), o);
const admin = (tok, body) => call(ADMIN.handler, body, { headers: { authorization: 'Bearer ' + tok, 'x-academy-request': undefined } });
const learner = (body, cookie, o) => call(API.handler, body, Object.assign({ cookie }, o || {}));
let evtN = 0;
const evtId = () => 'evt_test' + String(++evtN).padStart(6, '0') + crypto.randomBytes(4).toString('hex');
function hook(ev, o) {
  o = o || {};
  const raw = JSON.stringify(ev);
  const sig = o.sig != null ? o.sig : C.signHeader(raw, o.secret || WHSEC, o.t);
  return call(WH.handler, null, { raw, headers: Object.assign({ 'stripe-signature': sig }, o.headers || {}) });
}
const completed = (s, o) => Object.assign({ id: evtId(), type: 'checkout.session.completed', livemode: false,
  data: { object: { id: s.id, payment_status: 'paid', payment_intent: 'pi_test' + crypto.randomBytes(8).toString('hex'), amount_total: s.amount_total, currency: 'usd' } } }, o || {});
async function signIn(addr) {
  mails.length = 0;
  const r = await learner({ action: 'request_code', email: addr }); assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const m = mails.filter(x => x.to[0] === addr).pop(); assert.ok(m, 'a code was emailed to ' + addr);
  const v = await learner({ action: 'verify_code', email: addr, code: m.subject.slice(0, 6) }); assert.strictEqual(v.status, 200, JSON.stringify(v.body));
  return v.cookie;
}
const setPrice = (patch, course, actor) => tryRun(DB, `select academy_commerce_op_set_price(${actor || PRES}, '${course || TC.C}', ${J(patch)}, 'Phase 2 test price')`);
const elig = d => jr(DB, `select academy_commerce_eligibility('${d}')`);

(async () => {
  try {
    await t('M8 installs: every install check reads true', async () => {
      const rows = INSTALL_OUT.split('\n').filter(l => l.includes('|'));
      assert.strictEqual(rows.length, 8, INSTALL_OUT);
      for (const r of rows) assert.ok(r.endsWith('|t'), 'install check failed: ' + r);
    });
    await t('M8 refuses to install twice', async () => {
      const r = psql(DB, ['-f', SUP('academy_p2_m8_commerce.sql')]); assert.notStrictEqual(r.status, 0); assert.match(r.stderr, /already installed/);
    });

    /* ---------------- eligibility ---------------- */
    await t('Eligibility: an active network dealer and its active branch are free', async () => {
      assert.deepStrictEqual([elig(HQ).eligible, elig(HQ).reason], [true, 'network_dealer']);
      assert.deepStrictEqual([elig(NORTH).eligible, elig(NORTH).head_office_id], [true, HQ]);
    });
    await t('Eligibility: prospects, manufacturers, inactive and TEST dealers are NOT free — and a prospect\'s active branch is not either', async () => {
      assert.deepStrictEqual([elig(OTHER).eligible, elig(OTHER).reason], [false, 'not_active']);
      assert.deepStrictEqual([elig(PBR).eligible, elig(PBR).reason], [false, 'not_active'], 'the head office decides for a branch');
      assert.deepStrictEqual([elig(MFR).eligible, elig(MFR).reason], [false, 'account_class']);
      assert.deepStrictEqual([elig(CLOSED).eligible, elig(CLOSED).reason], [false, 'not_active']);
      assert.deepStrictEqual([elig(TESTD).eligible, elig(TESTD).reason], [false, 'test_dealer']);
      run(DB, `update public.dealers set account_class = 'prospect' where id = '${NORTH}'`);
      assert.strictEqual(elig(NORTH).eligible, false, 'a branch classed as prospect is not free');
      run(DB, `update public.dealers set account_class = 'dealer' where id = '${NORTH}'`);
      assert.strictEqual(elig(NORTH).eligible, true, "account_class 'dealer' is free");
      assert.deepStrictEqual(elig('00000000-0000-0000-0000-000000000999'), { eligible: false, reason: 'unknown_dealer' });
    });
    await t('Eligibility override: President only, reason required, append-only, head-office override reaches the branch, removal restores the rule', async () => {
      assert.match(tryRun(DB, `select academy_commerce_op_set_override(${ADM2}, '${OTHER}', true, 'Pilot partner dealer')`).err, /only the HCPS President/);
      assert.match(tryRun(DB, `select academy_commerce_op_set_override(${PRES}, '${OTHER}', true, 'no')`).err, /reason/);
      run(DB, `select academy_commerce_op_set_override(${PRES}, '${OTHER}', true, 'Signed dealer agreement, onboarding')`);
      assert.deepStrictEqual([elig(OTHER).eligible, elig(OTHER).reason, elig(OTHER).override_scope], [true, 'override', 'dealer']);
      assert.deepStrictEqual([elig(PBR).eligible, elig(PBR).override_scope], [true, 'head_office']);
      run(DB, `select academy_commerce_op_set_override(${PRES}, '${OTHER}', null, 'Back to the standard rule')`);
      assert.strictEqual(elig(OTHER).eligible, false);
      assert.strictEqual(run(DB, `select count(*) from academy_eligibility_overrides where dealer_id = '${OTHER}'`), '2', 'history kept');
      assert.strictEqual(run(DB, `select count(*) from academy_events where action = 'set_eligibility_override'`), '2');
      assert.match(tryRun(DB, `update academy_eligibility_overrides set reason = 'edited reason here' where dealer_id = '${OTHER}'`).err, /commerce operations/);
    });

    /* ---------------- prices ---------------- */
    await t('Prices: President only; reason required; every change in the history and the audit trail', async () => {
      assert.match(setPrice({ price_cents: 1999 }, TC.C, ADM2).err, /only the HCPS President/);
      assert.match(tryRun(DB, `select academy_commerce_op_set_price(${PRES}, '${TC.C}', ${J({ price_cents: 1999 })}, 'x')`).err, /reason/);
      assert.ok(setPrice({ price_cents: 1999, sale_mode: 'test' }).ok);
      assert.ok(setPrice({ price_cents: 999 }).ok);
      assert.deepStrictEqual(one(DB, `select price_cents, sale_mode from academy_course_prices where course_id = '${TC.C}'`), { price_cents: 999, sale_mode: 'test' });
      assert.strictEqual(run(DB, `select count(*) from academy_course_price_history where course_id = '${TC.C}'`), '2');
      assert.strictEqual(run(DB, `select (before->>'price_cents') || '>' || (after->>'price_cents') from academy_course_price_history where course_id = '${TC.C}' order by id desc limit 1`), '1999>999');
      assert.match(setPrice({ price_cents: 1999, discount: 50 }).err, /discount cannot be set/);
      assert.match(setPrice({ price_cents: '1999' }).err, /whole number of cents/);
      assert.match(setPrice({ price_cents: 10, sale_mode: 'test' }).err, /check/, 'below Stripe\'s minimum while on sale');
    });
    await t('Prices: TEST-mode sales only for TEST courses; LIVE needs manufacturer rights recorded as confirmed', async () => {
      assert.match(setPrice({ price_cents: 1999, sale_mode: 'test' }, GC.C).err, /only for TEST courses/);
      assert.ok(setPrice({ price_cents: 1999 }, GC.C).ok, 'a price can be recorded while not on sale');
      assert.match(setPrice({ sale_mode: 'live' }, GC.C).err, /check/, 'Golden live sale refused without rights');
      assert.match(setPrice({ rights_status: 'confirmed' }, GC.C).err, /check/, 'confirmed rights need a reference');
      assert.strictEqual(run(DB, `select sale_mode || '/' || rights_status from academy_course_prices where course_id = '${GC.C}'`), 'off/not_confirmed');
    });
    await t('Prices: publishing a new content version never freezes or changes the price', async () => {
      const V2 = JSON.parse(run(DB, `select academy_content_op_create_version(${PRES}, null, '${GC.C}', '{"exam_questions":1}')`)).id;
      const M = JSON.parse(run(DB, `select academy_content_op_create_module(${PRES}, null, '${V2}', ${J({ title: 'Module A' })})`)).id;
      run(DB, `select academy_author_op_create_question(${PRES}, null, '${V2}', ${J({ module_id: M, kind: 'single', use: 'exam', prompt: 'V2 Q?', choices: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], answer_key: 'a', explanation: 'x', objective_tags: ['t'] })})`);
      const L = JSON.parse(run(DB, `select academy_content_op_create_lesson(${PRES}, null, '${M}', ${J({ title: 'L', est_minutes: 10 })})`)).id;
      run(DB, `select academy_author_op_set_blocks(${PRES}, '${L}', ${J([{ kind: 'text', heading: 'a', body: 'b' }, { kind: 'text', heading: 'c', body: 'd' }, { kind: 'text', heading: 'e', body: 'f' }])})`);
      run(DB, `select academy_content_op_move_version(${PRES}, '${V2}', 'in_review')`); run(DB, `select academy_publish_op_publish_version(${PRES}, '${V2}', null)`);
      assert.strictEqual(run(DB, `select price_cents from academy_course_prices where course_id = '${GC.C}'`), '1999');
      assert.ok(setPrice({ price_cents: 2499 }, GC.C).ok, 'still editable after the new version');
      assert.ok(setPrice({ price_cents: 1999 }, GC.C).ok);
      GC.V2 = V2;
    });

    /* ---------------- the database refuses every other road ---------------- */
    await t('Direct writes are refused: server role has no write rights; the owner without an operation is stopped by the guard', async () => {
      for (const sql of [`insert into academy_course_prices (course_id, price_cents, updated_by) values ('${GC.C}', 1, 'x')`,
                         `update academy_course_prices set price_cents = 1 where course_id = '${TC.C}'`,
                         `insert into academy_purchases (checkout_id, stripe_session_id, mode, amount_cents, currency, course_id, buyer_email, access, access_note) values (gen_random_uuid(), 'cs_test_x', 'test', 100, 'usd', '${TC.C}', 'a@b.c', 'needs_review', 'x')`]) {
        assert.match(tryRun(DB, `set role service_role; ${sql}`).err, /permission denied/, sql);
      }
      assert.match(tryRun(DB, `update academy_course_prices set price_cents = 1 where course_id = '${TC.C}'`).err, /commerce operations/);
      assert.match(tryRun(DB, `delete from academy_course_price_history where true`).err, /commerce operations/);
      assert.match(tryRun(DB, `select set_config('academy.op', 'commerce_x', false); delete from academy_course_price_history where true`).err, /never deleted/);
      assert.match(tryRun(DB, `select set_config('academy.op', 'commerce_x', false); update academy_course_price_history set reason = 'changed text' where true`).err, /append-only/);
      assert.match(tryRun(DB, `truncate academy_purchases`).err, /never truncated/);
      for (const r of ['anon', 'authenticated']) assert.match(tryRun(DB, `set role ${r}; select * from academy_course_prices`).err, /permission denied/);
      assert.match(tryRun(DB, `set role anon; select academy_commerce_eligibility('${HQ}')`).err, /permission denied/);
      assert.match(tryRun(DB, `set role service_role; select academy_commerce_included_dealer('x@y.z')`).err, /permission denied/, 'helpers are owner only');
    });
    await t('Outside-organization access is created only by a purchase; a membership never changes owner', async () => {
      run(DB, `select set_config('academy.op', 'commerce_x', false) from (select 1) z`);
      const L = jr(DB, `select academy_access_op_invite(${PRES}, '${HQ}', 'guard@hqmed.example', 'Guard', 'learner')`);
      assert.ok(L);
      assert.match(tryRun(DB, `insert into academy_organizations (name, contact_email, created_by) values ('Sneaky Co', 'a@b.co', 'x')`).err, /commerce operations/);
      const anyMem = run(DB, `select id from academy_memberships limit 1`);
      if (anyMem) assert.match(tryRun(DB, `update academy_memberships set dealer_id = '${OTHER}' where id = '${anyMem}'`).err, /never changes owner/);
    });

    /* ---------------- checkout API ---------------- */
    await t('Checkout is closed unless academy_payments is on, the Academy is open (not pilot) and a Stripe key is set', async () => {
      flags({ academy_admin: true, academy_learner: true, academy_open: true });
      delete process.env.STRIPE_SECRET_KEY;
      assert.deepStrictEqual((await call(CO.handler, null, { method: 'GET', query: { action: 'catalog' } })).body, { enabled: false, courses: [] });
      assert.strictEqual((await buy({ course: 'test-sales-course', email: 'a@outside.example', name: 'A B', organization: 'Outside Co' })).body.error, 'flag_off');
      flags(ON);
      assert.strictEqual((await buy({ course: 'test-sales-course', email: 'a@outside.example', name: 'A B', organization: 'Outside Co' })).body.error, 'flag_off', 'no key');
      process.env.STRIPE_SECRET_KEY = 'sk_test_' + 'a'.repeat(24);
      flags(Object.assign({}, ON, { academy_open: false }));
      assert.strictEqual((await buy({ course: 'test-sales-course', email: 'a@outside.example', name: 'A B', organization: 'Outside Co' })).body.error, 'flag_off', 'never during the pilot');
      process.env.STRIPE_SECRET_KEY = 'sk_live_' + 'a'.repeat(24); flags(ON);
      assert.strictEqual((await buy({ course: 'test-sales-course', email: 'a@outside.example', name: 'A B', organization: 'Outside Co' })).body.error, 'flag_off', 'a LIVE key without academy_payments_live sells nothing');
      process.env.STRIPE_SECRET_KEY = 'sk_test_' + 'a'.repeat(24);
      assert.strictEqual(stripeCalls.length, 0);
    });
    await t('Checkout: the catalog lists only what is on sale in the key\'s mode (TEST course in TEST mode; never the Golden course)', async () => {
      process.env.STRIPE_WEBHOOK_SECRET = WHSEC;
      const r = await call(CO.handler, null, { method: 'GET', query: { action: 'catalog' } });
      assert.strictEqual(r.body.mode, 'test');
      assert.deepStrictEqual(r.body.courses.map(c => [c.slug, c.price]), [['test-sales-course', '$9.99']]);
    });
    await t('Checkout: cross-site POSTs are refused', async () => {
      assert.strictEqual((await buy({ course: 'test-sales-course', email: 'x@outside.example', name: 'X Y', organization: 'X Co' }, { headers: { origin: 'https://evil.example' } })).status, 403);
      assert.strictEqual((await buy({ course: 'test-sales-course', email: 'x@outside.example', name: 'X Y', organization: 'X Co' }, { headers: { 'x-academy-request': undefined } })).status, 403);
    });
    let S1;
    await t('Checkout: the price comes from the DATABASE — a price in the request is ignored; Stripe gets an idempotency key', async () => {
      const r = await buy({ course: 'test-sales-course', email: 'Pat@Outside.example', name: 'Pat Buyer', organization: 'Outside Mobility LLC', price_cents: 1, amount: 1 });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.match(r.body.url, /^https:\/\/checkout\.stripe\.com\//);
      const c = stripeCalls.filter(x => x.path === '/v1/checkout/sessions' && x.method === 'POST').pop();
      assert.strictEqual(c.params.get('line_items[0][price_data][unit_amount]'), '999');
      assert.strictEqual(c.params.get('customer_email'), 'pat@outside.example');
      assert.strictEqual(c.params.get('payment_method_types[0]'), 'card');
      assert.match(c.headers['idempotency-key'], /^academy-checkout-[0-9a-f-]{36}$/);
      S1 = [...sessions.values()].pop();
      assert.strictEqual(run(DB, `select stripe_session_id from academy_checkouts where buyer_email = 'pat@outside.example'`), S1.id);
    });
    await t('Checkout: the same buyer again re-uses the open checkout (one per buyer and course, no second session)', async () => {
      const n = stripeCalls.filter(x => x.method === 'POST').length;
      const r = await buy({ course: 'test-sales-course', email: 'pat@outside.example', name: 'Pat Buyer', organization: 'Outside Mobility LLC' });
      assert.strictEqual(r.body.url, S1.url);
      assert.strictEqual(stripeCalls.filter(x => x.method === 'POST').length, n, 'no new Stripe session');
      assert.strictEqual(run(DB, `select count(*) from academy_checkouts where buyer_email = 'pat@outside.example'`), '1');
    });
    await t('Checkout: an eligible HCPS dealer (Partner 360 login) is sent to the Academy instead of paying; staff cannot buy', async () => {
      const r = await buy({ course: 'test-sales-course', email: 'buyer@hqmed.example', name: 'HQ Person', organization: 'HQ Medical' });
      assert.strictEqual(r.status, 409); assert.strictEqual(r.body.error, 'included');
      const s = await buy({ course: 'test-sales-course', email: 'admin2@test.example', name: 'Staff', organization: 'HCPS' });
      assert.strictEqual(s.body.error, 'staff');
      const p = await buy({ course: 'test-sales-course', email: 'owner@prospect.example', name: 'Prospect Owner', organization: 'Other Dealer' });
      assert.strictEqual(p.status, 200, 'a PROSPECT dealer is not free: it may buy');
    });
    await t('Checkout: not on sale / unknown course refused; Stripe outage = nothing charged, a clear message', async () => {
      assert.strictEqual((await buy({ course: 'golden-like', email: 'q@outside.example', name: 'Q R', organization: 'Q Co' })).body.error, 'not_for_sale');
      assert.strictEqual((await buy({ course: 'no-such-course', email: 'q@outside.example', name: 'Q R', organization: 'Q Co' })).status, 404);
      stripeDown = true;
      const r = await buy({ course: 'test-sales-course', email: 'down@outside.example', name: 'D E', organization: 'Down Co' });
      stripeDown = false;
      assert.strictEqual(r.status, 502); assert.strictEqual(r.body.error, 'payment_unavailable');
      const again = await buy({ course: 'test-sales-course', email: 'down@outside.example', name: 'D E', organization: 'Down Co' });
      assert.strictEqual(again.status, 200, 'a retry works (same checkout, same idempotency key)');
    });
    await t('Checkout: rate limit — 5 checkouts per address per hour', async () => {
      for (let i = 0; i < 4; i++) { run(DB, `select set_config('academy.op','commerce_t',false); update academy_checkouts set status = 'canceled' where buyer_email = 'rl@outside.example' and status = 'open'`); await buy({ course: 'test-sales-course', email: 'rl@outside.example', name: 'R L', organization: 'RL Co' }, { ip: '198.51.100.' + i }); }
      run(DB, `select set_config('academy.op','commerce_t',false); update academy_checkouts set status = 'canceled' where buyer_email = 'rl@outside.example' and status = 'open'`);
      await buy({ course: 'test-sales-course', email: 'rl@outside.example', name: 'R L', organization: 'RL Co' }, { ip: '198.51.100.9' });
      run(DB, `select set_config('academy.op','commerce_t',false); update academy_checkouts set status = 'canceled' where buyer_email = 'rl@outside.example' and status = 'open'`);
      const r = await buy({ course: 'test-sales-course', email: 'rl@outside.example', name: 'R L', organization: 'RL Co' }, { ip: '198.51.100.10' });
      assert.strictEqual(r.status, 429);
    });

    /* ---------------- webhook ---------------- */
    await t('Webhook: unsigned, mis-signed, tampered or stale events are refused and record nothing', async () => {
      const ev = completed(S1);
      const raw = JSON.stringify(ev);
      assert.strictEqual((await call(WH.handler, null, { raw })).status, 400, 'no signature');
      assert.strictEqual((await hook(ev, { secret: 'whsec_wrongsecret0123456789' })).status, 400);
      const sig = C.signHeader(raw, WHSEC);
      assert.strictEqual((await call(WH.handler, null, { raw: raw.replace('"paid"', '"paid" '), headers: { 'stripe-signature': sig } })).status, 400, 'body changed after signing');
      assert.strictEqual((await hook(ev, { t: Math.floor(Date.now() / 1000) - 600 })).status, 400, '10 minutes old');
      assert.strictEqual((await hook(Object.assign({}, ev, { livemode: true }))).status, 400, 'a LIVE event to a TEST setup');
      assert.strictEqual((await call(WH.handler, null, { raw, method: 'GET', headers: { 'stripe-signature': sig } })).status, 405);
      assert.strictEqual(run(DB, `select count(*) from academy_stripe_events`), '0');
      assert.strictEqual(run(DB, `select count(*) from academy_purchases`), '0');
      const old = process.env.STRIPE_WEBHOOK_SECRET; delete process.env.STRIPE_WEBHOOK_SECRET;
      assert.strictEqual((await hook(ev)).status, 503, 'no secret configured = refuse');
      process.env.STRIPE_WEBHOOK_SECRET = old;
    });
    await t('Webhook: a signed v1 among several signatures is accepted (key rotation)', async () => {
      const ev = { id: evtId(), type: 'customer.created', livemode: false, data: { object: {} } };
      const raw = JSON.stringify(ev); const ts = Math.floor(Date.now() / 1000);
      const good = C.signHeader(raw, WHSEC, ts).split(',v1=')[1];
      assert.strictEqual((await call(WH.handler, null, { raw, headers: { 'stripe-signature': `t=${ts},v1=${'0'.repeat(64)},v1=${good}` } })).body.ignored, true);
    });
    let PUR;
    await t('Webhook: a verified paid session grants access — outside organization, purchased membership, enrollment, purchase record, audit', async () => {
      const ev = completed(S1);
      const r = await hook(ev); assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      PUR = one(DB, `select * from academy_purchases where stripe_session_id = '${S1.id}'`);
      assert.strictEqual(PUR.access, 'granted'); assert.strictEqual(PUR.amount_cents, 999); assert.strictEqual(PUR.status, 'paid');
      const m = one(DB, `select * from academy_memberships where id = '${PUR.membership_id}'`);
      assert.strictEqual(m.dealer_id, null); assert.strictEqual(m.access_type, 'purchased'); assert.strictEqual(m.role, 'learner');
      assert.strictEqual(run(DB, `select name from academy_organizations where id = '${m.organization_id}'`), 'Outside Mobility LLC');
      assert.strictEqual(run(DB, `select access_source || '/' || version_id from academy_enrollments where id = '${PUR.enrollment_id}'`), 'purchase/' + TC.V);
      assert.strictEqual(run(DB, `select status from academy_checkouts where stripe_session_id = '${S1.id}'`), 'completed');
      assert.ok(Number(run(DB, `select count(*) from academy_events where actor = 'system:stripe' and action in ('purchase','create_organization','purchase_access','enroll','create_learner')`)) >= 5);
      PUR.event = ev;
    });
    await t('Webhook: replays never grant twice — the same event, or a new event for the same session', async () => {
      assert.strictEqual((await hook(PUR.event)).status, 200);
      assert.strictEqual((await hook(completed(S1))).status, 200);
      assert.strictEqual(run(DB, `select count(*) from academy_purchases`), '1');
      assert.strictEqual(run(DB, `select count(*) from academy_organizations`), '1');
      assert.strictEqual(run(DB, `select count(*) from academy_enrollments where access_source = 'purchase'`), '1');
    });
    await t('Webhook: an amount, currency or mode different from the checkout grants NOTHING (recorded for review)', async () => {
      const r = await buy({ course: 'test-sales-course', email: 'mis@outside.example', name: 'Mis Match', organization: 'Mis Co' });
      const s = [...sessions.values()].find(x => x.url === r.body.url);
      await hook(completed(s, { data: { object: { id: s.id, payment_status: 'paid', payment_intent: 'pi_test0000000001', amount_total: 1, currency: 'usd' } } }));
      assert.strictEqual(run(DB, `select count(*) from academy_purchases where stripe_session_id = '${s.id}'`), '0');
      assert.strictEqual(run(DB, `select count(*) from academy_stripe_events where outcome = 'mismatch'`), '1');
      assert.strictEqual(run(DB, `select status from academy_checkouts where stripe_session_id = '${s.id}'`), 'open');
      const unpaid = await hook(completed(s, { data: { object: { id: s.id, payment_status: 'unpaid', amount_total: 999, currency: 'usd' } } }));
      assert.strictEqual(unpaid.body.waiting, 'payment');
      await hook(completed({ id: 'cs_test_unknownsession00', amount_total: 999 }));
      assert.strictEqual(run(DB, `select count(*) from academy_stripe_events where outcome = 'unknown_session'`), '1');
      const exp = { id: evtId(), type: 'checkout.session.expired', livemode: false, data: { object: { id: s.id } } };
      await hook(exp); assert.strictEqual(run(DB, `select status from academy_checkouts where stripe_session_id = '${s.id}'`), 'expired');
    });
    await t('Success page status: granted / pending / unknown — never a name, email or amount', async () => {
      const g = await call(CO.handler, { action: 'status', session: S1.id }); assert.deepStrictEqual(g.body, { state: 'granted' });
      assert.deepStrictEqual((await call(CO.handler, { action: 'status', session: 'cs_test_nothinghere000' })).body, { state: 'unknown' });
    });

    /* ---------------- isolation ---------------- */
    let PC;
    await t('The buyer signs in with an Academy email code and sees ONLY the purchased course, under their own company', async () => {
      PC = await signIn('pat@outside.example');
      const me = await learner({ action: 'me' }, PC);
      assert.deepStrictEqual(me.body.memberships.map(m => [m.dealer_id, m.dealer, m.outside]), [[null, 'Outside Mobility LLC', true]]);
      assert.strictEqual(me.body.training_manager, false);
      const mc = await learner({ action: 'my_courses' }, PC);
      assert.deepStrictEqual(mc.body.courses.map(c => c.title || c.course), ['TEST Sales Course']);
    });
    await t('Isolation: outside buyers never appear on Dealer 360, in a Training Manager\'s team, or in dealership figures', async () => {
      const sbGet = async p => { const r = await S.fetch(BASE + '/rest/v1/' + p); return r.json(); };
      for (const d of [HQ, OTHER, TESTD]) assert.ok(!JSON.stringify(await D360.dealerAcademy(sbGet, d, [])).includes('pat@'), 'not on Dealer 360');
      assert.ok(!JSON.stringify(await D360.dealerAcademy(sbGet, HQ, [NORTH])).includes('Pat Buyer'));
      const ov = await admin('pres', { action: 'overview' });
      assert.strictEqual(ov.status, 200, JSON.stringify(ov.body));
      assert.deepStrictEqual(ov.body.outside_organizations, { memberships: 1, organizations: 1 });
      const ds = await admin('pres', { action: 'dealer_summary' });
      assert.ok(!ds.body.dealerships.some(d => d.dealer_id == null), 'no "null dealership" row');
      const ll = await admin('pres', { action: 'list_learners' });
      const pat = ll.body.learners.find(l => l.email === 'pat@outside.example');
      assert.deepStrictEqual(pat.memberships.map(m => [m.outside, m.dealer]), [[true, 'Outside Mobility LLC']]);
    });
    await t('Isolation: a Training Manager can never act on an outside buyer (database refuses even a forged call)', async () => {
      const tm = JSON.parse(run(DB, `select academy_access_op_invite(${PRES}, '${HQ}', 'tm@hqmed.example', 'HQ TM', 'training_manager')`));
      const TMC = await signIn('tm@hqmed.example');
      const team = await learner({ action: 'team' }, TMC);
      assert.ok(!JSON.stringify(team.body).includes('pat@outside'), 'not in the team');
      const tmId = (await learner({ action: 'me' }, TMC)).body.learner.id;
      assert.match(tryRun(DB, `select academy_access_op_deactivate('learner:${tmId}', '${PUR.membership_id}', 'trying to end outside access')`).err, /Training Manager or HCPS/);
      assert.match(tryRun(DB, `select academy_enroll_op_enroll('learner:${tmId}', '${PUR.learner_id}', '${GC.V2}', null)`).err, /Training Manager or HCPS/);
      assert.ok(tm);
    });

    /* ---------------- refunds ---------------- */
    await t('Refund: the buyer may ask within 14 days (once); after 14 days the request is refused', async () => {
      const mp = await learner({ action: 'my_purchases' }, PC);
      assert.strictEqual(mp.body.purchases.length, 1); assert.strictEqual(mp.body.purchases[0].can_request_refund, true); assert.strictEqual(mp.body.purchases[0].amount, '$9.99');
      assert.strictEqual((await learner({ action: 'refund_request', purchase_id: PUR.id, reason: 'no' }, PC)).status, 400);
      const r = await learner({ action: 'refund_request', purchase_id: PUR.id, reason: 'Bought the wrong course' }, PC);
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual((await learner({ action: 'refund_request', purchase_id: PUR.id, reason: 'Bought the wrong course' }, PC)).status, 400, 'once');
      assert.strictEqual(run(DB, `select status from academy_purchases where id = '${PUR.id}'`), 'refund_requested');
    });
    await t('Refund: someone else cannot ask for the buyer; only the President decides', async () => {
      const other = await signIn('tm@hqmed.example');
      assert.strictEqual((await learner({ action: 'refund_request', purchase_id: PUR.id, reason: 'not mine at all' }, other)).status, 403);
      const a = await admin('adm', { action: 'refund_decide', purchase_id: PUR.id, decision: 'approve', reason: 'Wrong course bought' });
      assert.strictEqual(a.status, 403); assert.strictEqual(a.body.error, 'president_only');
      assert.match(tryRun(DB, `select academy_commerce_op_refund_decide(${ADM2}, '${PUR.id}', 'approve', 'Wrong course bought')`).err, /only the HCPS President/);
    });
    await t('Refund: President approves → Stripe refund with an idempotency key; access ends only when Stripe\'s signed refund event arrives', async () => {
      const a = await admin('pres', { action: 'refund_decide', purchase_id: PUR.id, decision: 'approve', reason: 'Wrong course bought' });
      assert.strictEqual(a.status, 200, JSON.stringify(a.body)); assert.strictEqual(a.body.refund, 'sent');
      const c = stripeCalls.filter(x => x.path === '/v1/refunds').pop();
      assert.strictEqual(c.params.get('payment_intent'), PUR.payment_intent_id); assert.strictEqual(c.params.get('amount'), '999');
      assert.strictEqual(c.headers['idempotency-key'], `academy-refund-${PUR.id}-999`);
      assert.strictEqual(run(DB, `select status from academy_purchases where id = '${PUR.id}'`), 'refund_approved');
      assert.strictEqual(run(DB, `select status from academy_enrollments where id = '${PUR.enrollment_id}'`), 'not_started', 'still enrolled until Stripe confirms');
      const ev = { id: evtId(), type: 'charge.refunded', livemode: false, data: { object: { payment_intent: PUR.payment_intent_id, amount_refunded: 999 } } };
      assert.strictEqual((await hook(ev)).status, 200);
      assert.strictEqual(run(DB, `select status || '/' || refunded_cents from academy_purchases where id = '${PUR.id}'`), 'refunded/999');
      assert.strictEqual(run(DB, `select status from academy_enrollments where id = '${PUR.enrollment_id}'`), 'withdrawn');
      await hook(ev); assert.strictEqual(run(DB, `select count(*) from academy_events where action = 'refund' and entity_id = '${PUR.id}'`), '1', 'a replay changes nothing');
    });
    await t('Refund: a partial refund is recorded; a late, smaller total never lowers it; a completed course is kept', async () => {
      const r = await buy({ course: 'test-sales-course', email: 'part@outside.example', name: 'Part Ial', organization: 'Part Co' });
      const s = [...sessions.values()].find(x => x.url === r.body.url);
      const ev = completed(s); await hook(ev);
      const p = one(DB, `select * from academy_purchases where stripe_session_id = '${s.id}'`);
      run(DB, `select set_config('academy.op','',false); update academy_enrollments set status = 'completed', completed_at = now() where id = '${p.enrollment_id}'`);
      await hook({ id: evtId(), type: 'charge.refunded', livemode: false, data: { object: { payment_intent: p.payment_intent_id, amount_refunded: 500 } } });
      assert.strictEqual(run(DB, `select status || '/' || refunded_cents from academy_purchases where id = '${p.id}'`), 'paid/500');
      await hook({ id: evtId(), type: 'charge.refunded', livemode: false, data: { object: { payment_intent: p.payment_intent_id, amount_refunded: 300 } } });
      assert.strictEqual(run(DB, `select refunded_cents from academy_purchases where id = '${p.id}'`), '500');
      await hook({ id: evtId(), type: 'charge.refunded', livemode: false, data: { object: { payment_intent: p.payment_intent_id, amount_refunded: 999 } } });
      assert.strictEqual(run(DB, `select status from academy_purchases where id = '${p.id}'`), 'refunded');
      assert.strictEqual(run(DB, `select status from academy_enrollments where id = '${p.enrollment_id}'`), 'completed', 'earned training is never taken back by a refund');
      await hook({ id: evtId(), type: 'charge.refunded', livemode: false, data: { object: { payment_intent: p.payment_intent_id, amount_refunded: 5000 } } });
      assert.strictEqual(run(DB, `select refunded_cents from academy_purchases where id = '${p.id}'`), '999', 'more than was paid is refused');
    });
    await t('Dispute: the purchase is marked for review', async () => {
      const r = await buy({ course: 'test-sales-course', email: 'disp@outside.example', name: 'Dis Pute', organization: 'Disp Co' });
      const s = [...sessions.values()].find(x => x.url === r.body.url); await hook(completed(s));
      const p = one(DB, `select * from academy_purchases where stripe_session_id = '${s.id}'`);
      await hook({ id: evtId(), type: 'charge.dispute.created', livemode: false, data: { object: { payment_intent: p.payment_intent_id } } });
      assert.strictEqual(run(DB, `select status from academy_purchases where id = '${p.id}'`), 'disputed');
    });
    await t('Refund window: 14 days from purchase — day 15 is refused, and the buyer\'s page says so', async () => {
      const r = await buy({ course: 'test-sales-course', email: 'late@outside.example', name: 'Late Asker', organization: 'Late Co' });
      const s = [...sessions.values()].find(x => x.url === r.body.url); await hook(completed(s));
      const p = one(DB, `select * from academy_purchases where stripe_session_id = '${s.id}'`);
      run(DB, `select set_config('academy.op','commerce_t',false); update academy_purchases set paid_at = now() - interval '15 days' where id = '${p.id}'`);
      const LC = await signIn('late@outside.example');
      assert.strictEqual((await learner({ action: 'my_purchases' }, LC)).body.purchases[0].can_request_refund, false);
      const q = await learner({ action: 'refund_request', purchase_id: p.id, reason: 'Changed my mind' }, LC);
      assert.strictEqual(q.status, 400); assert.match(q.body.message, /within 14 days/);
      run(DB, `select set_config('academy.op','commerce_t',false); update academy_purchases set paid_at = now() - interval '13 days' where id = '${p.id}'`);
      assert.strictEqual((await learner({ action: 'refund_request', purchase_id: p.id, reason: 'Changed my mind' }, LC)).status, 200, 'day 13 is fine');
      const d = await admin('pres', { action: 'refund_decide', purchase_id: p.id, decision: 'decline', reason: 'Course already completed in full' });
      assert.strictEqual(d.status, 200); assert.strictEqual(run(DB, `select status || '/' || review_note from academy_purchases where id = '${p.id}'`), 'paid/Course already completed in full');
    });
    await t('Abuse review: two refunds in 12 months → the next purchase waits for the President; "allow" lets it through (audited)', async () => {
      // pat has one refund; the second purchase for pat is refunded too
      const r = await buy({ course: 'test-sales-course', email: 'pat@outside.example', name: 'Pat Buyer', organization: 'Outside Mobility LLC' });
      assert.strictEqual(r.status, 200, 'withdrawn after a refund = may buy again: ' + JSON.stringify(r.body));
      const s = [...sessions.values()].find(x => x.url === r.body.url); await hook(completed(s));
      const p = one(DB, `select * from academy_purchases where stripe_session_id = '${s.id}'`);
      assert.strictEqual(p.access, 'granted'); assert.strictEqual(run(DB, `select count(*) from academy_organizations where name = 'Outside Mobility LLC'`), '1', 'same company re-used');
      await hook({ id: evtId(), type: 'charge.refunded', livemode: false, data: { object: { payment_intent: p.payment_intent_id, amount_refunded: 999 } } });
      const blocked = await buy({ course: 'test-sales-course', email: 'pat@outside.example', name: 'Pat Buyer', organization: 'Outside Mobility LLC' });
      assert.strictEqual(blocked.status, 403); assert.strictEqual(blocked.body.error, 'review');
      assert.strictEqual((await admin('adm', { action: 'buyer_review', email: 'pat@outside.example', decision: 'allow', reason: 'Spoke with buyer' })).status, 403);
      assert.strictEqual((await admin('pres', { action: 'buyer_review', email: 'pat@outside.example', decision: 'allow', reason: 'Spoke with buyer, genuine' })).status, 200);
      assert.strictEqual((await buy({ course: 'test-sales-course', email: 'pat@outside.example', name: 'Pat Buyer', organization: 'Outside Mobility LLC' })).status, 200);
    });

    /* ---------------- Command Center ---------------- */
    await t('Command Center: overview shows readiness, prices, purchases and refunds — no key or secret ever', async () => {
      const r = await admin('adm', { action: 'commerce_overview' });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.deepStrictEqual(r.body.readiness, { payments_switch: true, live_switch: false, academy_open: true, stripe_key_mode: 'test', webhook_secret: true, live_ready: false });
      const txt = JSON.stringify(r.body);
      assert.ok(!txt.includes(process.env.STRIPE_SECRET_KEY) && !txt.includes(WHSEC) && !/sk_test_|whsec_|ip_hash/.test(txt));
      assert.ok(r.body.purchases.length >= 4); assert.ok(r.body.price_history.length >= 2);
      const g = r.body.courses.find(c => c.slug === 'golden-like'); assert.strictEqual(g.price.price, '$19.99'); assert.strictEqual(g.price.sale_mode, 'off');
    });
    await t('Command Center: President sets prices and overrides through the API; an admin may look but not change', async () => {
      assert.strictEqual((await admin('adm', { action: 'set_price', course_id: GC.C, patch: { price_cents: 2999 }, reason: 'Try a new price' })).body.error, 'president_only');
      const ok = await admin('pres', { action: 'set_price', course_id: GC.C, patch: { price_cents: 1999, public_note: 'Coming soon' }, reason: 'Proposed launch price' });
      assert.strictEqual(ok.status, 200, JSON.stringify(ok.body)); assert.strictEqual(ok.body.price.public_note, 'Coming soon');
      assert.strictEqual((await admin('pres', { action: 'set_price', course_id: GC.C, patch: { price_cents: 19.99 }, reason: 'Decimal price' })).status, 400);
      assert.strictEqual((await admin('pres', { action: 'set_price', course_id: GC.C, patch: { sale_mode: 'test' }, reason: 'Try test mode' })).status, 400);
      const e = await admin('adm', { action: 'eligibility_check', q: 'Prospect' });
      assert.deepStrictEqual(e.body.dealers.map(d => [d.dealer, d.eligibility.eligible]), [['Prospect Branch', false]]);
      const ov = await admin('pres', { action: 'set_eligibility_override', dealer_id: MFR, eligible: true, reason: 'Manufacturer staff training' });
      assert.strictEqual(ov.body.eligibility.eligible, true);
    });

    /* ---------------- pages in a real browser (only when Playwright is available) ---------------- */
    if (process.env.PLAYWRIGHT_MODULE) {
      const http = require('http');
      const { chromium } = require(process.env.PLAYWRIGHT_MODULE);
      const SRC = path.join(__dirname, '..', 'src');
      const FN = { 'academy-checkout': CO, 'academy-admin-api': ADMIN, 'academy-api': API };
      const srv = http.createServer(async (req, res) => {
        const chunks = []; for await (const c of req) chunks.push(c);
        const [p, qs] = req.url.split('?');
        const fn = p.startsWith('/.netlify/functions/') ? p.split('/').pop() : null;
        if (fn) {
          if (!FN[fn]) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true,"favorites":[],"count":0}'); }
          const headers = Object.assign({}, req.headers, { origin: ORIGIN, 'x-nf-client-connection-ip': '192.0.2.50' });
          const out = await FN[fn].handler({ httpMethod: req.method, headers, body: Buffer.concat(chunks).toString('utf8'), queryStringParameters: Object.fromEntries(new URLSearchParams(qs || '')) });
          res.writeHead(out.statusCode, out.headers); return res.end(out.body);
        }
        let f = path.join(SRC, p.replace(/\.\./g, '')); if (p.endsWith('/')) f = path.join(f, 'index.html');
        if (!fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); return res.end(''); }
        res.writeHead(200, { 'content-type': f.endsWith('.css') ? 'text/css' : f.endsWith('.js') ? 'application/javascript' : 'text/html' }); res.end(fs.readFileSync(f));
      });
      await new Promise(r => srv.listen(0, '127.0.0.1', r)); const site = `http://127.0.0.1:${srv.address().port}`;
      const browser = await chromium.launch({ executablePath: fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined });
      const SHOTS = process.env.SHOTS;
      const pageAt = async (width, token) => {
        const ctx = await browser.newContext({ viewport: { width, height: 900 } });
        if (token) await ctx.addInitScript(tok => { try { localStorage.setItem('hcps_staff_token', tok); localStorage.setItem('hcps_staff_profile', JSON.stringify({ email: 'admin@test.example', name: 'Angelo', role: 'president' })); } catch (e) {} }, token);
        const nav = [];
        await ctx.route(u => !/^http:\/\/127\.0\.0\.1[:/]/.test(String(u)), r => { nav.push(r.request().url()); return /checkout\.stripe\.com/.test(r.request().url()) ? r.fulfill({ status: 200, contentType: 'text/html', body: '<p>stripe</p>' }) : r.abort(); });
        const pg = await ctx.newPage(); pg.errors = []; pg.nav = nav; pg.on('pageerror', e => pg.errors.push(String(e)));
        return pg;
      };
      const overflow = pg => pg.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      try {
        for (const w of [390, 1280]) {
          await t(`Browser ${w}px: /academy/buy/ lists the TEST course at the server's price and hands the buyer to Stripe`, async () => {
            const pg = await pageAt(w);
            await pg.goto(site + '/academy/buy/?course=test-sales-course');
            await pg.waitForSelector('#course');
            assert.match(await pg.textContent('#course'), /TEST Sales Course — \$9\.99/);
            assert.match(await pg.textContent('main'), /TEST MODE — no real card is charged/);
            await pg.fill('#name', 'Browser Buyer'); await pg.fill('#org', 'Browser Co ' + w); await pg.fill('#email', `browser${w}@outside.example`);
            await Promise.all([pg.waitForURL(/checkout\.stripe\.com/), pg.click('button[type=submit]')]);
            assert.ok(pg.nav.some(u => /^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_/.test(u)));
            assert.deepStrictEqual(pg.errors, []);
            if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); }
            await pg.goto(site + '/academy/buy/?course=test-sales-course'); await pg.waitForSelector('#course');
            assert.strictEqual(await overflow(pg), false, 'no sideways scroll');
            if (SHOTS) await pg.screenshot({ path: path.join(SHOTS, `p2-buy-${w}.png`), fullPage: true });
            await pg.context().close();
          });
        }
        await t('Browser: the success page confirms a granted purchase without showing personal data', async () => {
          const pg = await pageAt(390);
          await pg.goto(site + '/academy/buy/done/?session=' + S1.id);
          await pg.waitForFunction(() => /course is ready/.test(document.body.textContent));
          assert.ok(!/pat@outside|9\.99/.test(await pg.textContent('main')));
          assert.strictEqual(await pg.evaluate(() => location.search), '', 'the session id leaves the address bar');
          await pg.context().close();
        });
        for (const w of [390, 1280]) {
          await t(`Browser ${w}px: Command Center → Pricing & purchases renders for the President (readiness, prices, purchases, eligibility check)`, async () => {
            const pg = await pageAt(w, 'pres');
            await pg.goto(site + '/admin/academy.html');
            await pg.waitForSelector('#tabs .tab');
            await pg.click('#tabs .tab[data-t="people"]'); await pg.waitForSelector('#pc'); await pg.click('#pc');
            await pg.waitForFunction(() => /Payment readiness/.test(document.body.textContent));
            const txt = await pg.textContent('#view');
            assert.match(txt, /Golden Lift Chair Sales Certification[\s\S]*\$19\.99/); assert.match(txt, /TEST mode/i); assert.match(txt, /Outside company/);
            assert.ok(!/sk_test_|whsec_/.test(await pg.content()));
            await pg.fill('#elq', 'Prospect'); await pg.click('#elgo');
            await pg.waitForFunction(() => /Prospect Branch/.test(document.getElementById('elres').textContent));
            assert.match(await pg.textContent('#elres'), /Pays/);
            await pg.click('[data-pr]'); await pg.waitForSelector('#msave'); assert.match(await pg.textContent('#mbox'), /Manufacturer permission/);
            if (SHOTS) await pg.screenshot({ path: path.join(SHOTS, `p2-admin-${w}.png`), fullPage: true });
            assert.deepStrictEqual(pg.errors, []);
            await pg.context().close();
          });
        }
      } finally { await browser.close(); srv.close(); }
    }

    /* ---------------- rollback ---------------- */
    await t('Rollback is refused while commerce records exist; on a clean install it removes M8 and restores the old checks', async () => {
      const r = psql(DB, ['-f', SUP('academy_p2_m8_commerce_rollback.sql')]); assert.notStrictEqual(r.status, 0); assert.match(r.stderr, /commerce records exist/);
      const D2 = DB + '_rb'; install(D2); file(D2, SUP('academy_p2_m8_commerce.sql'));
      const out = file(D2, SUP('academy_p2_m8_commerce_rollback.sql'));
      assert.match(out, /M8 removed\|t/);
      assert.strictEqual(run(D2, `select attnotnull from pg_attribute where attrelid = 'public.academy_memberships'::regclass and attname = 'dealer_id'`), 't');
      assert.strictEqual(run(D2, `select count(*) from pg_proc where proname like 'academy_commerce_%'`), '0');
      run('postgres', `drop database if exists ${D2} with (force)`);
    });
  } finally {
    console.log(`\nacademy-p2.pg: ${pass} passed, ${fail} failed`);
    try { run('postgres', `drop database if exists ${DB} with (force)`); } catch (e) {}
    process.exit(fail ? 1 : 0);
  }
})();
