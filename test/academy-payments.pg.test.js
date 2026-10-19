/* HCPS Academy Phase 2 / M8 — paid course access (Stripe SANDBOX), end to end.
   A local Postgres holds A1, M1–M7 and M8 exactly as committed; the real academy-checkout.js, academy-stripe-webhook.js,
   academy-api.js and academy-admin-api.js handlers run unchanged; their Supabase calls are answered by
   test/academy-pgrest.js (real database functions, real tables). Stripe's API is a stand-in that records every call;
   webhooks are signed with the test signing secret exactly as Stripe signs them (t=…,v1=HMAC-SHA256("t.body")).
   Emails are captured, never sent. No real card, key or network call is involved.
     PGHOST=/tmp/pgt PGPORT=55432 PGUSER=postgres PGTEST_NO_SAFEUPDATE=1 node test/academy-payments.pg.test.js */
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
const tryRun = (db, sql) => { const r = psql(db, ['-c', sql]); return { ok: r.status === 0, err: r.stderr || '' }; };
const file = (db, f) => { const r = psql(db, ['-f', f]); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
try { run('postgres', 'select 1'); } catch (e) { console.log('SKIP: no Postgres (' + String(e.message).split('\n')[0] + ')'); process.exit(0); }
const NO_SAFEUPDATE = process.env.PGTEST_NO_SAFEUPDATE === '1';
const fixture = () => { let s = fs.readFileSync(path.join(__dirname, 'academy', 'fixture.sql'), 'utf8'); if (NO_SAFEUPDATE) s = s.replace(/^do \$\$ begin execute format\('alter database %I set session_preload_libraries.*$/m, ''); return s; };
const J = v => `$j$${JSON.stringify(v)}$j$::jsonb`;
const PRES = `'staff:admin@test.example'`;
const HQ = '00000000-0000-0000-0000-0000000000a1', NORTH = '00000000-0000-0000-0000-0000000000a2', OTHER = '00000000-0000-0000-0000-0000000000b1';
const CLOSED = '00000000-0000-0000-0000-0000000000c1';
const ORIGIN = 'https://www.homecareproviderservices.org';

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + String(e && e.stack || e).split('\n').slice(0, 8).join('\n       ')); } }

const DB = 'academy_pay_' + process.pid;
run('postgres', `drop database if exists ${DB}`); run('postgres', `create database ${DB}`);
run(DB, fixture());
run(DB, `alter table public.dealers add column is_test boolean not null default false, add column status text, add column account_class text;
         create table public.dealer_users (uid uuid primary key, email text, dealer_id uuid references public.dealers(id), status text);
         update public.dealers set status = 'active' where id in ('${HQ}', '${OTHER}');
         update public.dealers set account_class = 'prospect' where id = '${OTHER}';
         insert into public.dealers (id, business_name, status) values ('${CLOSED}', 'Closed Medical', 'closed');
         insert into public.dealer_users values ('00000000-0000-0000-0000-00000000d001', 'p360@hqnorth.example', '${NORTH}', 'approved'),
                                                ('00000000-0000-0000-0000-00000000d002', 'buyer@prospect.example', '${OTHER}', 'approved');`);
file(DB, SUP('academy_a1_foundation.sql'));
run(DB, 'grant all on all tables in schema public to service_role');
for (const f of ['academy_a2a_m1_audited_ops.sql', 'academy_a2c_m2_content_ops.sql', 'academy_a2d_m3_author_ops.sql', 'academy_a2d_m3_1_save_lesson.sql',
                 'academy_c2_m4_publish_ops.sql', 'academy_a2b_m5_learner_access.sql', 'academy_a2e_m6_exam_attempts.sql', 'academy_a2f_m7_certificates.sql']) file(DB, SUP(f));
const installOut = file(DB, SUP('academy_p2_m8_payments.sql'));
const flags = f => run(DB, `insert into app_settings (key, value) values ('phase2_flags', ${J(f)}) on conflict (key) do update set value = excluded.value`);
const ON = { academy_admin: true, academy_learner: true, academy_invites: true, academy_open: true, academy_payments: true };
flags(ON);

function course(slug, title, mfr) {
  const C = JSON.parse(run(DB, `select academy_content_op_create_course(${PRES}, null, ${J(Object.assign({ slug, title, course_type: 'hcps_certification' }, mfr ? { manufacturer_slug: mfr } : {}))})`)).id;
  const V = JSON.parse(run(DB, `select academy_content_op_create_version(${PRES}, null, '${C}', '{"exam_questions":1}')`)).id;
  const M = JSON.parse(run(DB, `select academy_content_op_create_module(${PRES}, null, '${V}', ${J({ title: 'Module A' })})`)).id;
  run(DB, `select academy_author_op_create_question(${PRES}, null, '${V}', ${J({ module_id: M, kind: 'single', use: 'exam', prompt: 'Exam Q?', choices: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], answer_key: 'b', explanation: 'x', objective_tags: ['t'] })})`);
  const L = JSON.parse(run(DB, `select academy_content_op_create_lesson(${PRES}, null, '${M}', ${J({ title: 'Lesson one', est_minutes: 10 })})`)).id;
  run(DB, `select academy_author_op_set_blocks(${PRES}, '${L}', ${J([{ kind: 'text', heading: 'Hello', body: 'Welcome.' }])})`);
  run(DB, `select academy_content_op_move_version(${PRES}, '${V}', 'in_review')`); run(DB, `select academy_publish_op_publish_version(${PRES}, '${V}', null)`);
  return { C, V };
}
const SALES = course('dealer-sales-basics', 'Dealer Sales Basics', null);
const GOLD = course('golden-lift-chair-sales-certification', 'Golden Lift Chair Sales Certification', 'golden-technologies');

const mails = [], pendingJobs = [], stripeCalls = []; let stripeFails = false, stripeLive = false, sessionN = 0;
const S = shim({ db: DB, psql: PSQL, tokens: { pres: 'admin@test.example', adm: 'admin2@test.example' },
  passthrough: async (url, o) => {
    const u = String(url);
    if (u === 'https://api.stripe.com/v1/checkout/sessions') {
      stripeCalls.push({ body: new URLSearchParams(o.body), headers: o.headers });
      if (stripeFails) return new Response('{"error":{"type":"api_error"}}', { status: 500 });
      sessionN++; const id = 'cs_test_a1' + String(sessionN).padStart(8, '0');
      return new Response(JSON.stringify({ id, url: 'https://checkout.stripe.com/c/pay/' + id, expires_at: Math.floor(Date.now() / 1000) + 3600, livemode: stripeLive }), { status: 200 });
    }
    if (u === 'https://api.resend.com/emails') { mails.push(JSON.parse(o.body)); return new Response('{"id":"x"}', { status: 200 }); }
    if (u.endsWith('/.netlify/functions/academy-mail-background')) { pendingJobs.push(require('../netlify/functions/academy-mail-background.js')._run({ httpMethod: 'POST', body: o.body })); return new Response(null, { status: 202 }); }
    return new Response('{}', { status: 599 });
  } });
run(DB, "insert into staff_users (email, name, role, active) values ('admin2@test.example', 'Second Admin', 'admin', true)");
process.env.SUPABASE_URL = BASE; process.env.SUPABASE_SERVICE_ROLE = 'svc-test-key';
process.env.ACADEMY_SESSION_SECRET = 'test-secret-0123456789-abcdefghijklmnopqrstuvwxyz-0123';
process.env.RESEND_API_KEY = 're_test'; process.env.ACADEMY_SIGNIN_FLOOR_MS = '20'; process.env.ACADEMY_MAIL_FROM = 'HCPS Academy <academy@test.example>';
const TESTKEY = 'sk_test_' + 'A'.repeat(24), WHSEC = 'whsec_' + 'B'.repeat(32);
process.env.STRIPE_SECRET_KEY = TESTKEY; process.env.STRIPE_WEBHOOK_SECRET = WHSEC;
global.fetch = S.fetch;
const API = require('../netlify/functions/academy-api.js');
const ADMIN = require('../netlify/functions/academy-admin-api.js');
const CHECKOUT = require('../netlify/functions/academy-checkout.js');
const HOOK = require('../netlify/functions/academy-stripe-webhook.js');

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
const buy = (body, o) => call(CHECKOUT.handler, Object.assign({ action: 'start' }, body), o);
const catalog = () => call(CHECKOUT.handler, null, { method: 'GET', query: { action: 'catalog' } });
let evtN = 0;
function signed(payload, o) {
  o = o || {};
  const raw = JSON.stringify(payload);
  const ts = o.ts != null ? o.ts : Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', o.secret || WHSEC).update(ts + '.' + raw).digest('hex');
  return { raw: o.tamper ? raw.replace('"paid"', '"PAID"') : raw, header: `t=${ts},v1=${sig}` };
}
async function hook(type, object, o) {
  o = o || {};
  const ev = { id: o.id || ('evt_test' + String(++evtN).padStart(10, '0')), object: 'event', type, livemode: !!o.livemode, data: { object } };
  const s = signed(ev, o);
  const r = await call(HOOK.handler, null, { raw: s.raw, headers: { 'stripe-signature': o.header || s.header, origin: undefined, 'x-academy-request': undefined } });
  return Object.assign(r, { event_id: ev.id });
}
const completed = (p, extra) => Object.assign({ id: p.session, object: 'checkout.session', client_reference_id: p.id, payment_status: 'paid',
  amount_total: p.amount, currency: 'usd', payment_intent: 'pi_' + p.session.slice(8) }, extra || {});
const purchase = sid => JSON.parse(run(DB, `select coalesce(to_jsonb(p), 'null') from academy_purchases p where stripe_session_id = '${sid}'`));
const lastCode = to => { const m = mails.filter(x => x.to[0] === to).pop(); return m && (/is your HCPS Academy sign-in code/.test(m.subject) ? m.subject.slice(0, 6) : null); };
async function signIn(addr) {
  mails.length = 0;
  assert.strictEqual((await learner({ action: 'request_code', email: addr })).status, 200);
  const code = lastCode(addr); assert.ok(code, 'a code was emailed to ' + addr);
  const v = await learner({ action: 'verify_code', email: addr, code }); assert.strictEqual(v.status, 200, JSON.stringify(v.body));
  return v.cookie;
}
let ipN = 10;
async function startPaid(email, company, slug) {
  const r = await buy({ course_slug: slug || 'dealer-sales-basics', full_name: 'Pat Buyer', company: company || 'Outside Mobility LLC', email }, { ip: '198.51.100.' + (ipN++) });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const sid = r.body.url.split('/').pop(); const p = purchase(sid);
  return { id: p.id, session: sid, amount: p.amount_cents, url: r.body.url };
}

(async () => {
  try {
    await t('install: the four M8 install checks read true', async () => {
      const rows = installOut.split('\n').filter(l => l.includes('|'));
      assert.strictEqual(rows.length, 4, installOut); for (const r of rows) assert.ok(r.endsWith('|t'), r);
    });
    await t('RULE 19: the public roles read nothing; the server role cannot write a purchase, price or organization directly', async () => {
      for (const tb of ['academy_purchases', 'academy_prices', 'academy_organizations', 'academy_stripe_events', 'academy_dealer_eligibility']) {
        assert.ok(!tryRun(DB, `set role anon; select * from ${tb}`).ok, tb + ' anon');
        assert.ok(!tryRun(DB, `set role authenticated; select * from ${tb}`).ok, tb + ' authenticated');
      }
      assert.ok(!tryRun(DB, `set role service_role; insert into academy_prices (course_id, updated_by) values ('${SALES.C}', 'x')`).ok);
      const g = tryRun(DB, `insert into academy_prices (course_id, updated_by) values ('${SALES.C}', 'x')`);   // owner, no operation
      assert.ok(!g.ok && /audited operation/.test(g.err), g.err);
      assert.ok(!tryRun(DB, `set role service_role; select academy_purchase_grant(null::academy_purchases)`).ok, 'helpers are not callable');
      assert.ok(!tryRun(DB, `set role anon; select academy_purchase_op_catalog()`).ok, 'operations are not public');
    });
    await t('sandbox only: a live-mode purchase row is refused by the table itself', async () => {
      const r = tryRun(DB, `select set_config('academy.op','x',true); insert into academy_purchases (course_id, version_id, email, full_name, company, amount_cents, currency, ip_hash, livemode)
                            values ('${SALES.C}', '${SALES.V}', 'a@b.co', 'Pat', 'Co', 999, 'usd', repeat('a',64), true)`);
      assert.ok(!r.ok);
    });
    await t('catalog: off when the switch is off; on, nothing is for sale until the President sets a price', async () => {
      flags(Object.assign({}, ON, { academy_payments: false }));
      assert.deepStrictEqual((await catalog()).body, { enabled: false, test_mode: true, courses: [] });
      assert.strictEqual((await buy({ course_slug: 'dealer-sales-basics', full_name: 'Pat', company: 'Co', email: 'x@y.co' })).body.error, 'flag_off');
      flags(ON);
      assert.deepStrictEqual((await catalog()).body.courses, []);
    });
    await t('pricing: only the President sets prices (API and database); another administrator is refused', async () => {
      const a = await admin('adm', { action: 'set_price', course_id: SALES.C, price_outside_cents: 1999, outside_sale_allowed: true });
      assert.strictEqual(a.status, 403); assert.strictEqual(a.body.error, 'president_only');
      assert.ok(!tryRun(DB, `select academy_purchase_op_set_price('staff:admin2@test.example', '${SALES.C}', '{"price_outside_cents":1999}')`).ok);
      const p = await admin('pres', { action: 'set_price', course_id: SALES.C, price_outside_cents: 1999, outside_sale_allowed: true, network_included: true });
      assert.strictEqual(p.status, 200, JSON.stringify(p.body)); assert.strictEqual(p.body.price.price_outside_cents, 1999);
      assert.deepStrictEqual((await catalog()).body.courses, [{ slug: 'dealer-sales-basics', title: 'Dealer Sales Basics', price_cents: 1999, currency: 'usd' }]);
      assert.ok(Number(run(DB, `select count(*) from academy_events where entity = 'academy_prices' and action = 'set_price'`)) >= 1, 'audited');
    });
    await t('Golden: a manufacturer course cannot go on sale to outside dealerships until commercial use is confirmed', async () => {
      const r = await admin('pres', { action: 'set_price', course_id: GOLD.C, price_outside_cents: 1999, outside_sale_allowed: true });
      assert.strictEqual(r.status, 400); assert.match(r.body.message, /confirmed commercial use/);
      assert.strictEqual((await admin('pres', { action: 'set_price', course_id: GOLD.C, price_outside_cents: 1999 })).status, 200, 'a price may be recorded');
      assert.ok(!(await catalog()).body.courses.some(c => c.slug === GOLD.C || /golden/.test(c.slug)));
      const b = await buy({ course_slug: 'golden-lift-chair-sales-certification', full_name: 'Pat', company: 'Outside Co', email: 'gold@outside.example' });
      assert.strictEqual(b.status, 404); assert.strictEqual(b.body.error, 'not_for_sale');
      const own = tryRun(DB, `select set_config('academy.op','x',true); update academy_prices set outside_sale_allowed = true where course_id = '${GOLD.C}'`);
      assert.ok(!own.ok && /commercial use is confirmed/.test(own.err), 'not even the owner with the marker: ' + own.err);
      assert.ok(!tryRun(DB, `set role service_role; select set_config('academy.op','x',true); update academy_prices set outside_sale_allowed = true where course_id = '${GOLD.C}'`).ok);
    });
    await t('unauthorized: checkout needs the Academy header and an allowed origin; GET cannot start one; unknown actions refused', async () => {
      assert.strictEqual((await buy({ course_slug: 'dealer-sales-basics', full_name: 'Pat', company: 'Co', email: 'x@y.co' }, { headers: { 'x-academy-request': undefined } })).status, 403);
      assert.strictEqual((await buy({ course_slug: 'dealer-sales-basics', full_name: 'Pat', company: 'Co', email: 'x@y.co' }, { headers: { origin: 'https://evil.example' } })).status, 403);
      assert.strictEqual((await call(CHECKOUT.handler, null, { method: 'GET', query: { action: 'start' } })).status, 405);
      assert.strictEqual((await call(CHECKOUT.handler, { action: 'grant' })).status, 404);
      assert.strictEqual(stripeCalls.length, 0);
    });
    let REAL;
    await t('HCPS dealer FREE access: an Academy learner at an eligible dealership is never charged', async () => {
      assert.strictEqual((await admin('pres', { action: 'invite_learner', dealer_id: HQ, email: 'real@hqmed.example' })).status, 200);
      REAL = await signIn('real@hqmed.example');
      const r = await buy({ course_slug: 'dealer-sales-basics', full_name: 'Real Learner', company: 'HQ Medical', email: 'real@hqmed.example' });
      assert.strictEqual(r.status, 409); assert.strictEqual(r.body.error, 'included');
      const p = await buy({ course_slug: 'dealer-sales-basics', full_name: 'Branch User', company: 'HQ North', email: 'P360@HQNorth.example' });
      assert.strictEqual(p.body.error, 'included', 'an approved Partner 360 user at a branch of an active dealer is included');
      assert.strictEqual(stripeCalls.length, 0); assert.strictEqual(run(DB, 'select count(*) from academy_purchases'), '0');
    });
    await t('eligibility rule: a prospect / closed account is not included; the President can override one (audited)', async () => {
      assert.strictEqual(run(DB, `select academy_purchase_dealer_eligible('${OTHER}')::text || academy_purchase_dealer_eligible('${CLOSED}')::text || academy_purchase_dealer_eligible('${NORTH}')::text`), 'falsefalsetrue');
      assert.strictEqual((await admin('adm', { action: 'set_eligibility', dealer_id: OTHER, eligible: true, reason: 'Signed dealer agreement' })).status, 403);
      const o = await admin('pres', { action: 'set_eligibility', dealer_id: OTHER, eligible: true, reason: 'Signed dealer agreement' });
      assert.strictEqual(o.status, 200); assert.strictEqual(o.body.result.eligible_now, true);
      assert.strictEqual((await buy({ course_slug: 'dealer-sales-basics', full_name: 'Prospect', company: 'Other', email: 'buyer@prospect.example' })).body.error, 'included');
      const c = await admin('pres', { action: 'set_eligibility', dealer_id: OTHER, eligible: null, reason: 'Back to the standard rule' });
      assert.strictEqual(c.body.result.eligible_now, false);
    });
    let P1, BUYER;
    await t('outside dealership: the price comes from the database, never the browser; Stripe gets one idempotent session', async () => {
      const r = await buy({ course_slug: 'dealer-sales-basics', full_name: 'Pat Buyer', company: 'Outside Mobility LLC', email: 'Pat@Outside.example', price_outside_cents: 1, amount: 1 });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.match(r.body.url, /^https:\/\/checkout\.stripe\.com\//);
      assert.strictEqual(stripeCalls.length, 1);
      const c = stripeCalls[0];
      assert.strictEqual(c.body.get('line_items[0][price_data][unit_amount]'), '1999');
      assert.strictEqual(c.body.get('mode'), 'payment'); assert.strictEqual(c.body.get('customer_email'), 'pat@outside.example');
      assert.ok(!c.body.get('line_items[0][price]'), 'no Stripe Price object is used or created');
      assert.match(c.headers['idempotency-key'], /^hcps-academy-[0-9a-f-]{36}$/); assert.strictEqual(c.headers.authorization, 'Bearer ' + TESTKEY);
      assert.match(c.body.get('success_url'), /^https:\/\/www\.homecareproviderservices\.org\/academy\/buy\/\?paid=1&session_id=\{CHECKOUT_SESSION_ID\}$/);
      P1 = Object.assign({ session: r.body.url.split('/').pop() }, {}); const row = purchase(P1.session); P1.id = row.id; P1.amount = row.amount_cents;
      assert.strictEqual(c.body.get('client_reference_id'), P1.id); assert.strictEqual(row.status, 'open');
      assert.strictEqual(run(DB, `select count(*) from academy_learners where email = 'pat@outside.example'`), '0', 'opening a checkout grants nothing');
    });
    await t('the same buyer + course reuses the open checkout (no second Stripe session)', async () => {
      const r = await buy({ course_slug: 'dealer-sales-basics', full_name: 'Pat Buyer', company: 'Outside Mobility LLC', email: 'pat@outside.example' });
      assert.strictEqual(r.body.reused, true); assert.strictEqual(r.body.url.split('/').pop(), P1.session); assert.strictEqual(stripeCalls.length, 1);
    });
    await t('webhook security: unsigned, wrongly signed, tampered and stale events are refused and change nothing', async () => {
      const obj = completed(P1);
      assert.strictEqual((await hook('checkout.session.completed', obj, { header: 'nonsense' })).status, 400);
      assert.strictEqual((await hook('checkout.session.completed', obj, { secret: 'whsec_' + 'C'.repeat(32) })).status, 400);
      assert.strictEqual((await hook('checkout.session.completed', obj, { tamper: true })).status, 400);
      assert.strictEqual((await hook('checkout.session.completed', obj, { ts: Math.floor(Date.now() / 1000) - 600 })).status, 400);
      const noSig = await call(HOOK.handler, null, { raw: JSON.stringify({ id: 'evt_x', type: 'checkout.session.completed', data: { object: obj } }), headers: { origin: undefined, 'x-academy-request': undefined } });
      assert.strictEqual(noSig.status, 400);
      assert.strictEqual(run(DB, 'select count(*) from academy_stripe_events'), '0'); assert.strictEqual(purchase(P1.session).status, 'open');
      assert.strictEqual((await call(HOOK.handler, null, { method: 'GET' })).status, 405);
    });
    await t('verified payment: automatic enrollment (learner, outside organization, membership, enrollment) in one audited step', async () => {
      const r = await hook('checkout.session.completed', completed(P1));
      assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.strictEqual(r.body.outcome, 'granted');
      const p = purchase(P1.session); assert.strictEqual(p.status, 'paid'); assert.ok(p.enrollment_id && p.organization_id && p.learner_id);
      assert.strictEqual(run(DB, `select access_source || ':' || status from academy_enrollments where id = '${p.enrollment_id}'`), 'purchase:not_started');
      assert.strictEqual(run(DB, `select coalesce(dealer_id::text,'none') || ':' || role || ':' || access_type from academy_memberships where organization_id = '${p.organization_id}'`), 'none:learner:training_only');
      assert.strictEqual(run(DB, `select name from academy_organizations where id = '${p.organization_id}'`), 'Outside Mobility LLC');
      assert.strictEqual(run(DB, `select count(*) from dealers where business_name ilike '%Outside%'`), '0', 'never added to the CRM dealers table');
      assert.ok(Number(run(DB, `select count(*) from academy_events where actor = 'system:stripe'`)) >= 5);
      BUYER = await signIn('pat@outside.example');
      const me = await learner({ action: 'me' }, BUYER); assert.strictEqual(me.body.memberships[0].dealer, 'Outside Mobility LLC');
      const mc = await learner({ action: 'my_courses' }, BUYER); assert.strictEqual(mc.body.courses.length, 1); assert.strictEqual(mc.body.courses[0].course, 'Dealer Sales Basics');
    });
    await t('duplicate webhook delivery: the same event, and a second event for the same session, grant nothing twice', async () => {
      const first = run(DB, `select event_id from academy_stripe_events order by received_at limit 1`);
      const again = await hook('checkout.session.completed', completed(P1), { id: first });
      assert.strictEqual(again.body.outcome, 'duplicate_event');
      assert.strictEqual((await hook('checkout.session.completed', completed(P1))).body.outcome, 'already_granted');
      assert.strictEqual((await hook('checkout.session.async_payment_succeeded', completed(P1))).body.outcome, 'already_granted');
      const p = purchase(P1.session);
      assert.strictEqual(run(DB, `select count(*) from academy_enrollments where learner_id = '${p.learner_id}'`), '1');
      assert.strictEqual(run(DB, `select count(*) from academy_memberships where learner_id = '${p.learner_id}'`), '1');
      const r = await buy({ course_slug: 'dealer-sales-basics', full_name: 'Pat Buyer', company: 'Outside Mobility LLC', email: 'pat@outside.example' });
      assert.strictEqual(r.body.error, 'already_enrolled', 'cannot pay twice for a course they have');
    });
    await t('concurrent duplicate deliveries: ten simultaneous copies of one event record it once', async () => {
      const P = await startPaid('race@outside.example', 'Race Co');
      const ev = { id: 'evt_race0000000001', object: 'event', type: 'checkout.session.completed', livemode: false, data: { object: completed(P) } };
      const s = signed(ev);
      const outs = await Promise.all(Array.from({ length: 10 }, () => call(HOOK.handler, null, { raw: s.raw, headers: { 'stripe-signature': s.header, origin: undefined, 'x-academy-request': undefined } })));
      assert.ok(outs.every(o => o.status === 200), JSON.stringify(outs.map(o => o.status)));
      assert.strictEqual(outs.filter(o => o.body.outcome === 'granted').length, 1);
      assert.strictEqual(run(DB, `select count(*) from academy_enrollments e join academy_purchases p on p.learner_id = e.learner_id where p.stripe_session_id = '${P.session}'`), '1');
    });
    await t('failed / declined payment: async failure, expiry and an unpaid completion never grant access', async () => {
      const A1 = await startPaid('declined@outside.example', 'Declined Co');
      assert.strictEqual((await hook('checkout.session.completed', completed(A1, { payment_status: 'unpaid' }))).body.outcome, 'awaiting_payment');
      assert.strictEqual((await hook('checkout.session.async_payment_failed', completed(A1, { payment_status: 'unpaid' }))).body.outcome, 'failed');
      assert.strictEqual(purchase(A1.session).status, 'failed');
      const A2 = await startPaid('expired@outside.example', 'Expired Co');
      assert.strictEqual((await hook('checkout.session.expired', completed(A2, { payment_status: 'unpaid' }))).body.outcome, 'expired');
      assert.strictEqual(run(DB, `select count(*) from academy_learners where email in ('declined@outside.example','expired@outside.example')`), '0');
      stripeFails = true;
      const f = await buy({ course_slug: 'dealer-sales-basics', full_name: 'Pat', company: 'Down Co', email: 'down@outside.example' });
      stripeFails = false;
      assert.strictEqual(f.status, 502); assert.strictEqual(run(DB, `select status from academy_purchases where email = 'down@outside.example'`), 'failed');
    });
    await t('tampered amount / reference: a paid event that does not match the checkout goes to review, no access', async () => {
      const B = await startPaid('mismatch@outside.example', 'Mismatch Co');
      assert.strictEqual((await hook('checkout.session.completed', completed(B, { amount_total: 1 }))).body.outcome, 'review');
      assert.strictEqual(purchase(B.session).status, 'review'); assert.strictEqual(purchase(B.session).enrollment_id, null);
      const C = await startPaid('ref@outside.example', 'Ref Co');
      assert.strictEqual((await hook('checkout.session.completed', completed(C, { client_reference_id: B.id }))).body.outcome, 'review');
      assert.strictEqual((await hook('checkout.session.completed', completed({ id: C.id, session: 'cs_test_unknown00000001', amount: 1999 }))).body.outcome, 'unknown_session');
    });
    await t('live mode: a live event is recorded and refused; a live key turns checkout off', async () => {
      const L = await startPaid('live@outside.example', 'Live Co');
      assert.strictEqual((await hook('checkout.session.completed', completed(L), { livemode: true })).body.outcome, 'live_mode_refused');
      assert.strictEqual(purchase(L.session).status, 'open');
      process.env.STRIPE_SECRET_KEY = 'sk_live_' + 'Z'.repeat(24);
      const n = stripeCalls.length;
      assert.strictEqual((await catalog()).body.enabled, false);
      assert.strictEqual((await buy({ course_slug: 'dealer-sales-basics', full_name: 'Pat', company: 'Co', email: 'k@outside.example' })).status, 503);
      process.env.STRIPE_SECRET_KEY = TESTKEY; assert.strictEqual(stripeCalls.length, n);
      stripeLive = true;
      const s = await buy({ course_slug: 'dealer-sales-basics', full_name: 'Pat', company: 'Co', email: 'k2@outside.example' });
      stripeLive = false; assert.strictEqual(s.status, 503, 'a live session from Stripe is refused');
    });
    await t('rate limits: one network address is stopped after 10 checkouts in 15 minutes (no Stripe call)', async () => {
      const n = stripeCalls.length; let limited = 0;
      for (let i = 0; i < 12; i++) { const r = await buy({ course_slug: 'dealer-sales-basics', full_name: 'Pat', company: 'Flood Co', email: `flood${i}@outside.example` }, { ip: '192.0.2.99' }); if (r.status === 429) limited++; }
      assert.strictEqual(limited, 2); assert.strictEqual(stripeCalls.length, n + 10);
    });
    await t('refund: a full refund withdraws the enrollment; a partial refund keeps access; recorded with the switch OFF', async () => {
      flags(Object.assign({}, ON, { academy_payments: false }));
      const pi = 'pi_' + P1.session.slice(8);
      const part = await hook('charge.refunded', { object: 'charge', payment_intent: pi, amount: 1999, amount_refunded: 500 });
      assert.strictEqual(part.body.outcome, 'partially_refunded');
      assert.strictEqual((await learner({ action: 'my_courses' }, BUYER)).body.courses.length, 1);
      const full = await hook('charge.refunded', { object: 'charge', payment_intent: pi, amount: 1999, amount_refunded: 1999 });
      assert.strictEqual(full.body.outcome, 'refunded');
      const p = purchase(P1.session); assert.strictEqual(p.status, 'refunded'); assert.strictEqual(p.amount_refunded_cents, 1999);
      assert.strictEqual(run(DB, `select status from academy_enrollments where id = '${p.enrollment_id}'`), 'withdrawn');
      assert.strictEqual((await learner({ action: 'my_courses' }, BUYER)).body.courses.length, 0);
      assert.strictEqual((await hook('charge.refunded', { object: 'charge', payment_intent: 'pi_nobody', amount_refunded: 5 })).body.outcome, 'unknown_payment');
      flags(ON);
    });
    await t('dispute: opening a dispute withdraws access; a won dispute restores it', async () => {
      const D = await startPaid('dispute@outside.example', 'Dispute Co');
      await hook('checkout.session.completed', completed(D));
      const pi = 'pi_' + D.session.slice(8);
      assert.strictEqual((await hook('charge.dispute.created', { object: 'dispute', payment_intent: pi, status: 'needs_response' })).body.outcome, 'disputed');
      const e = purchase(D.session).enrollment_id;
      assert.strictEqual(run(DB, `select status from academy_enrollments where id = '${e}'`), 'withdrawn');
      assert.strictEqual((await hook('charge.dispute.closed', { object: 'dispute', payment_intent: pi, status: 'won' })).body.outcome, 'dispute_won');
      assert.strictEqual(run(DB, `select status from academy_enrollments where id = '${e}'`), 'not_started'); assert.strictEqual(purchase(D.session).status, 'paid');
    });
    await t('course price change: an open checkout at the old price is superseded; the next checkout charges the new price', async () => {
      const O = await startPaid('pricechange@outside.example', 'Price Co');
      assert.strictEqual(O.amount, 1999);
      assert.strictEqual((await admin('pres', { action: 'set_price', course_id: SALES.C, price_outside_cents: 2499 })).status, 200);
      assert.strictEqual(purchase(O.session).status, 'superseded');
      const N = await startPaid('pricechange@outside.example', 'Price Co');
      assert.notStrictEqual(N.session, O.session); assert.strictEqual(N.amount, 2499);
      assert.strictEqual(stripeCalls[stripeCalls.length - 1].body.get('line_items[0][price_data][unit_amount]'), '2499');
      assert.deepStrictEqual((await catalog()).body.courses[0].price_cents, 2499);
      // a buyer who had already paid the superseded checkout is honoured at the price they paid
      assert.strictEqual((await hook('checkout.session.completed', completed(O))).body.outcome, 'granted');
      assert.strictEqual((await admin('pres', { action: 'set_price', course_id: SALES.C, outside_sale_allowed: false })).status, 200);
      assert.strictEqual((await buy({ course_slug: 'dealer-sales-basics', full_name: 'Pat', company: 'Co', email: 'late@outside.example' })).body.error, 'not_for_sale');
      assert.strictEqual(purchase(N.session).status, 'superseded', 'taking a course off sale closes its open checkouts');
      await admin('pres', { action: 'set_price', course_id: SALES.C, outside_sale_allowed: true });
    });
    await t('isolation: an outside learner is invisible to HCPS dealers, Training Managers and Dealer 360 figures', async () => {
      const TM = (await admin('pres', { action: 'invite_learner', dealer_id: HQ, email: 'tm@hqmed.example' })).body;
      const tmc = await signIn('tm@hqmed.example');
      const tid = (await learner({ action: 'me' }, tmc)).body.learner.id;
      const mid = run(DB, `select id from academy_memberships where learner_id = '${tid}' and status = 'active'`);
      assert.strictEqual((await admin('pres', { action: 'set_training_manager', membership_id: mid, make: true, reason: 'Pilot Training Manager' })).status, 200, JSON.stringify(TM));
      const team = await learner({ action: 'team' }, tmc); assert.strictEqual(team.status, 200);
      assert.ok(!JSON.stringify(team.body).includes('outside.example'), 'the HQ team never lists an outside learner');
      const outsider = purchase(P1.session).learner_id;
      const en = await learner({ action: 'enroll', learner_id: outsider, version_id: SALES.V }, tmc);
      assert.strictEqual(en.status, 403, 'a Training Manager cannot touch an outside learner');
      assert.strictEqual((await learner({ action: 'team' }, BUYER)).status, 403, 'an outside learner has no Training Manager powers');
      const ds = await admin('pres', { action: 'dealer_summary' });
      assert.ok(!ds.body.dealerships.some(d => d.dealer_id == null), 'outside organizations are not HCPS dealerships');
      const ll = await admin('pres', { action: 'list_learners' });
      const o = ll.body.learners.find(l => l.email === 'pat@outside.example');
      assert.ok(o.memberships[0].outside); assert.match(o.memberships[0].dealer, /Outside Mobility LLC \(outside\)/);
      assert.ok(!tryRun(DB, `select academy_access_op_invite('learner:${tid}', null, 'x@outside.example', 'X', 'learner')`).ok);
      const direct = tryRun(DB, `select set_config('academy.op','enroll',true); insert into academy_memberships (learner_id, organization_id, role, access_type, created_by)
                                 values ('${tid}', '${purchase(P1.session).organization_id}', 'learner', 'training_only', 'x')`);
      assert.ok(!direct.ok && /verified purchase/.test(direct.err), 'organization access only through a verified purchase');
    });
    await t('pilot mode: while the Academy is TEST-only, nobody outside can buy', async () => {
      flags(Object.assign({}, ON, { academy_open: false }));
      assert.strictEqual((await catalog()).body.enabled, false);
      assert.strictEqual((await buy({ course_slug: 'dealer-sales-basics', full_name: 'Pat', company: 'Co', email: 'p@outside.example' })).body.error, 'pilot_only');
      flags(ON);
    });
    await t('Command Center payments view: modes and history, never a secret', async () => {
      const r = await admin('adm', { action: 'payments' });
      assert.strictEqual(r.status, 200); assert.strictEqual(r.body.stripe_mode, 'test'); assert.strictEqual(r.body.webhook_configured, true);
      assert.ok(r.body.purchases.length >= 8); assert.ok(r.body.totals.paid >= 1 && r.body.totals.refunded === 1);
      const g = r.body.courses.find(c => c.slug === 'golden-lift-chair-sales-certification'); assert.strictEqual(g.needs_rights, true);
      const txt = JSON.stringify(r.body); assert.ok(!txt.includes(TESTKEY) && !txt.includes(WHSEC) && !txt.includes('sk_test') && !txt.includes('whsec'));
      assert.strictEqual((await call(ADMIN.handler, { action: 'payments' }, { headers: { 'x-academy-request': undefined } })).status, 401);
    });
    await t('certificates earned before a refund stay valid; completion is never undone by a refund', async () => {
      const P = await startPaid('done@outside.example', 'Done Co');
      await hook('checkout.session.completed', completed(P));
      const e = purchase(P.session).enrollment_id;
      run(DB, `select set_config('academy.op','progress',true); update academy_enrollments set status = 'completed', completed_at = now() where id = '${e}'`);
      await hook('charge.refunded', { object: 'charge', payment_intent: 'pi_' + P.session.slice(8), amount_refunded: P.amount });
      assert.strictEqual(purchase(P.session).status, 'refunded'); assert.strictEqual(run(DB, `select status from academy_enrollments where id = '${e}'`), 'completed');
    });
  } finally {
    console.log(`\n${pass} passed, ${fail} failed`);
    run('postgres', `drop database if exists ${DB} with (force)`);
    process.exit(fail ? 1 : 0);
  }
})();
