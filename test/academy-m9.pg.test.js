/* HCPS Academy Phase 2 / M9 (on top of M8) — refund requests, price history, buyer review, TEST eligibility, refund safety.
   Same harness as test/academy-payments.pg.test.js (copied header). M8 then M9, exactly as committed.
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

const DB = 'academy_m9_' + process.pid;
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
const M8FP = () => run(DB, `select md5(string_agg(p.proname || ':' || md5(p.prosrc), '|' order by p.proname)) from pg_proc p where p.pronamespace = 'public'::regnamespace and (p.proname like 'academy\\_purchase\\_%' or p.proname = 'academy_prices_rights_check')`);
const M8_BEFORE = M8FP();
const m9Out = file(DB, SUP('academy_p2_m9_refunds.sql'));
// a TEST sandbox dealer, and a REAL branch under it (the case M8 got wrong)
const TESTD = '00000000-0000-0000-0000-0000000000e1', TESTBR = '00000000-0000-0000-0000-0000000000e2';
run(DB, `insert into public.dealers (id, business_name, status, is_test) values ('${TESTD}', 'TEST Sandbox', 'active', true);
         insert into public.dealers (id, business_name, parent_id, status, is_test) values ('${TESTBR}', 'Real Branch Of Sandbox', '${TESTD}', 'active', false);
         insert into public.dealer_users values ('00000000-0000-0000-0000-00000000d003', 'pilot@sandbox.example', '${TESTD}', 'approved'),
                                                ('00000000-0000-0000-0000-00000000d004', 'real@branchofsandbox.example', '${TESTBR}', 'approved');`);
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

const priceIt = (course, spec, reason) => admin('pres', Object.assign({ action: 'set_price', course_id: course, reason }, spec));
async function paid(email, company) {
  const p = await startPaid(email, company);
  const h = await hook('checkout.session.completed', completed(p)); assert.strictEqual(h.status, 200, JSON.stringify(h.body));
  assert.strictEqual(purchase(p.session).status, 'paid');
  return p;
}
const refundEvt = (p, cents, o) => hook('charge.refunded', { id: 'ch_' + p.session.slice(8), object: 'charge', payment_intent: 'pi_' + p.session.slice(8), amount_refunded: cents }, o);

(async () => {
  try {
    await t('install: M9 refuses without M8 / twice; every install check reads true', async () => {
      const rows = m9Out.split('\n').filter(l => l.includes('|'));
      assert.strictEqual(rows.length, 6, m9Out); for (const r of rows) assert.ok(r.endsWith('|t'), r);
      const again = psql(DB, ['-f', SUP('academy_p2_m9_refunds.sql')]); assert.notStrictEqual(again.status, 0); assert.match(again.stderr, /already installed/);
      const D2 = DB + '_x'; run('postgres', `drop database if exists ${D2}`); run('postgres', `create database ${D2}`);
      const r = psql(D2, ['-f', SUP('academy_p2_m9_refunds.sql')]); assert.notStrictEqual(r.status, 0); assert.match(r.stderr, /needs M8/);
      run('postgres', `drop database ${D2}`);
    });
    await t('M8 is changed in exactly ONE function (academy_purchase_dealer_eligible); every other M8 function is byte-identical', async () => {
      const others = q => run(DB, `select md5(string_agg(p.proname || ':' || md5(p.prosrc), '|' order by p.proname)) from pg_proc p where p.pronamespace = 'public'::regnamespace and (p.proname like 'academy\\_purchase\\_%' or p.proname = 'academy_prices_rights_check') and p.proname <> 'academy_purchase_dealer_eligible'`);
      assert.notStrictEqual(M8FP(), M8_BEFORE, 'the eligibility rule changed');
      const D3 = DB + '_y'; run('postgres', `drop database if exists ${D3}`); run('postgres', `create database ${D3} template ${DB}`);
      run(D3, fs.readFileSync(SUP('academy_p2_m8_payments.sql'), 'utf8').match(/create function public\.academy_purchase_dealer_eligible[\s\S]*?\$\$;/)[0].replace('create function', 'create or replace function'));
      assert.strictEqual(run(D3, `select md5(string_agg(p.proname || ':' || md5(p.prosrc), '|' order by p.proname)) from pg_proc p where p.pronamespace = 'public'::regnamespace and (p.proname like 'academy\\_purchase\\_%' or p.proname = 'academy_prices_rights_check')`), M8_BEFORE, 'putting the M8 rule back restores the M8 fingerprint exactly');
      run('postgres', `drop database ${D3} with (force)`);
      assert.ok(others());
    });
    await t('RULE 19: M9 tables are closed to anon / authenticated; the server role cannot write them or call the helpers', async () => {
      for (const tb of ['academy_refund_requests', 'academy_buyer_reviews', 'academy_price_history']) {
        assert.ok(!tryRun(DB, `set role anon; select * from ${tb}`).ok, tb); assert.ok(!tryRun(DB, `set role authenticated; select * from ${tb}`).ok, tb);
        assert.ok(!tryRun(DB, `set role service_role; delete from ${tb} where true`).ok, tb);
      }
      assert.ok(!tryRun(DB, `set role service_role; select academy_purchase_op_set_price(${PRES}, '${SALES.C}', '{"price_outside_cents":1999}')`).ok, 'M8 reason-less price op revoked');
      assert.ok(!tryRun(DB, `set role anon; select academy_sale_op_refund_request('x', gen_random_uuid(), 'reason')`).ok);
      const g = tryRun(DB, `insert into academy_buyer_reviews (email, decision, reason, decided_by) values ('a@b.co', 'allow', 'by hand', 'x')`);
      assert.ok(!g.ok && /audited operation/.test(g.err), g.err);
      assert.ok(!tryRun(DB, `truncate academy_purchases`).ok, 'no truncate');
    });

    /* ---------- TEST eligibility semantics ---------- */
    await t('TEST: a TEST sandbox dealer is free (never billed, never reaches Stripe); a REAL branch under a TEST head office is NOT free', async () => {
      assert.strictEqual(run(DB, `select academy_purchase_dealer_eligible('${TESTD}')`), 't');
      assert.strictEqual(run(DB, `select academy_purchase_dealer_eligible('${TESTBR}')`), 'f', 'no free access inherited from a TEST head office');
      assert.strictEqual(run(DB, `select academy_purchase_dealer_eligible('${HQ}')::text || academy_purchase_dealer_eligible('${NORTH}')::text || academy_purchase_dealer_eligible('${OTHER}')::text`), 'truetruefalse', 'real rule unchanged');
      assert.strictEqual((await priceIt(SALES.C, { price_outside_cents: 1999, outside_sale_allowed: true, network_included: true }, 'Launch price for outside dealers')).status, 200);
      const n = stripeCalls.length;
      const t1 = await buy({ course_slug: 'dealer-sales-basics', full_name: 'Pilot', company: 'TEST Sandbox', email: 'pilot@sandbox.example' });
      assert.strictEqual(t1.body.error, 'included'); assert.strictEqual(stripeCalls.length, n, 'a TEST dealer never reaches Stripe');
      const t2 = await buy({ course_slug: 'dealer-sales-basics', full_name: 'Real', company: 'Real Branch', email: 'real@branchofsandbox.example' }, { ip: '198.51.100.200' });
      assert.strictEqual(t2.status, 200, 'the real branch is an outside buyer, not a free network dealer');
    });
    await t('TEST: a TEST course is never for sale, whatever is recorded', async () => {
      const TC = course('test-sandbox-course', 'TEST Sandbox Course', null);
      assert.strictEqual((await priceIt(TC.C, { price_outside_cents: 999, outside_sale_allowed: true }, 'Sandbox price check')).status, 200);
      assert.ok(!(await catalog()).body.courses.some(c => c.slug === 'test-sandbox-course'));
      assert.strictEqual((await buy({ course_slug: 'test-sandbox-course', full_name: 'X Y', company: 'X Co', email: 'x@outside.example' })).body.error, 'not_for_sale');
    });

    /* ---------- price history ---------- */
    await t('Price history: every change kept with who and why; a change without a reason is refused (API and database)', async () => {
      const before = Number(run(DB, 'select count(*) from academy_price_history'));
      const r = await priceIt(SALES.C, { price_outside_cents: 2499 }, 'abc');
      assert.strictEqual(r.status, 400, JSON.stringify(r.body)); assert.match(r.body.message, /at least 5 characters/, 'refused by the API first');
      assert.strictEqual((await priceIt(SALES.C, { price_outside_cents: 2499 }, 'Raised for the new content')).status, 200);
      assert.strictEqual(Number(run(DB, 'select count(*) from academy_price_history')), before + 1);
      assert.strictEqual(run(DB, `select (before->>'price_outside_cents') || '>' || (after->>'price_outside_cents') || '|' || reason || '|' || actor from academy_price_history order by id desc limit 1`), '1999>2499|Raised for the new content|staff:admin@test.example');
      const nr = tryRun(DB, `select set_config('academy.op','x',false); update academy_prices set price_outside_cents = 100 where course_id = '${SALES.C}'`);
      assert.ok(!nr.ok && /needs a reason/.test(nr.err), 'owner + marker, no reason: refused by the history trigger: ' + nr.err);
      assert.ok(!tryRun(DB, `select set_config('academy.op','x',false); delete from academy_price_history where true`).ok);
      const ed = tryRun(DB, `select set_config('academy.op','x',false); update academy_price_history set reason = 'edited by hand' where true`);
      assert.ok(!ed.ok && /append-only/.test(ed.err), ed.err);
      assert.strictEqual((await admin('adm', { action: 'set_price', course_id: SALES.C, price_outside_cents: 999, reason: 'Admin try here' })).status, 403);
      assert.ok(!tryRun(DB, `select academy_sale_op_set_price('staff:admin2@test.example', '${SALES.C}', '{"price_outside_cents":999}', 'Admin try here')`).ok);
      assert.strictEqual((await priceIt(SALES.C, { price_outside_cents: 1999 }, 'Back to the launch price')).status, 200);
      const g = await priceIt(GOLD.C, { price_outside_cents: 1999, outside_sale_allowed: true }, 'Try Golden sale');
      assert.strictEqual(g.status, 400, 'M8 Golden rights rule still applies through the new operation'); assert.match(g.body.message, /confirmed commercial use/);
    });

    /* ---------- refund requests ---------- */
    let P, C1;
    await t('Refund request: the buyer asks within 14 days (once, with a reason); "My purchases" shows it', async () => {
      P = await paid('pat@outside.example', 'Outside Mobility LLC');
      C1 = await signIn('pat@outside.example');
      const mp = await learner({ action: 'my_purchases' }, C1);
      assert.strictEqual(mp.status, 200, JSON.stringify(mp.body));
      assert.deepStrictEqual(mp.body.purchases.map(x => [x.course, x.amount, x.can_request_refund]), [['Dealer Sales Basics', '$19.99', true]]);
      assert.strictEqual((await learner({ action: 'refund_request', purchase_id: P.id, reason: 'no' }, C1)).status, 400);
      assert.strictEqual((await learner({ action: 'refund_request', purchase_id: P.id, reason: 'Bought the wrong course' }, C1)).status, 200);
      assert.strictEqual((await learner({ action: 'refund_request', purchase_id: P.id, reason: 'Bought the wrong course' }, C1)).status, 400, 'once');
      const mp2 = await learner({ action: 'my_purchases' }, C1);
      assert.strictEqual(mp2.body.purchases[0].request.status, 'requested'); assert.strictEqual(mp2.body.purchases[0].can_request_refund, false);
    });
    await t('Refund request: another learner cannot ask for it; day 15 is refused', async () => {
      const Q = await paid('late@outside.example', 'Late Co');
      const LC = await signIn('late@outside.example');
      assert.strictEqual((await learner({ action: 'refund_request', purchase_id: P.id, reason: 'not my purchase' }, LC)).status, 403);
      run(DB, `select set_config('academy.op','x',false); update academy_purchases set paid_at = now() - interval '15 days' where id = '${Q.id}'`);
      const r = await learner({ action: 'refund_request', purchase_id: Q.id, reason: 'Changed my mind' }, LC);
      assert.strictEqual(r.status, 400); assert.match(r.body.message, /within 14 days/);
      assert.strictEqual((await learner({ action: 'my_purchases' }, LC)).body.purchases[0].can_request_refund, false);
    });
    let REQ;
    await t('Refund decision: President only (API + database); approval moves NO money and tells the President which payment to refund in Stripe', async () => {
      const s = await admin('pres', { action: 'sales_review' }); assert.strictEqual(s.status, 200);
      REQ = s.body.refund_requests.find(r => r.purchase_id === P.id); assert.ok(REQ); assert.strictEqual(REQ.stripe_payment_intent, null, 'no payment id before approval');
      assert.strictEqual((await admin('adm', { action: 'refund_decide', request_id: REQ.id, decision: 'approve', reason: 'Wrong course bought' })).body.error, 'president_only');
      assert.ok(!tryRun(DB, `select academy_sale_op_refund_decide('staff:admin2@test.example', '${REQ.id}', 'approve', 'Wrong course bought')`).ok);
      const n = stripeCalls.length;
      const a = await admin('pres', { action: 'refund_decide', request_id: REQ.id, decision: 'approve', reason: 'Wrong course bought' });
      assert.strictEqual(a.status, 200, JSON.stringify(a.body)); assert.strictEqual(a.body.stripe_payment_intent, 'pi_' + P.session.slice(8)); assert.strictEqual(a.body.amount_cents, 1999);
      assert.strictEqual(stripeCalls.length, n, 'HCPS never calls Stripe to refund'); assert.strictEqual(purchase(P.session).status, 'paid', 'still paid until Stripe refunds');
      assert.strictEqual((await admin('pres', { action: 'refund_decide', request_id: REQ.id, decision: 'decline', reason: 'Changing my mind' })).status, 409, 'decided once');
    });
    await t('Refund in Stripe → signed charge.refunded closes the purchase AND the request; replay changes nothing', async () => {
      const ev = await refundEvt(P, 1999); assert.strictEqual(ev.status, 200);
      assert.strictEqual(purchase(P.session).status, 'refunded');
      assert.strictEqual(run(DB, `select status from academy_refund_requests where id = '${REQ.id}'`), 'refunded');
      await refundEvt(P, 1999, { id: ev.event_id });
      assert.strictEqual(run(DB, `select count(*) from academy_stripe_events where event_id = '${ev.event_id}'`), '1');
      assert.strictEqual((await learner({ action: 'my_purchases' }, C1)).body.purchases[0].request.status, 'refunded');
    });
    await t('Refund safety: a late, smaller charge.refunded never lowers the refunded amount or reopens "partially refunded"', async () => {
      await refundEvt(P, 500);
      const p = purchase(P.session); assert.strictEqual(p.status, 'refunded'); assert.strictEqual(p.amount_refunded_cents, 1999);
      const Q = await paid('part@outside.example', 'Part Co');
      await refundEvt(Q, 1000); assert.deepStrictEqual([purchase(Q.session).status, purchase(Q.session).amount_refunded_cents], ['partially_refunded', 1000]);
      await refundEvt(Q, 400); assert.strictEqual(purchase(Q.session).amount_refunded_cents, 1000, 'out-of-order lower total ignored');
      await refundEvt(Q, 1999); assert.strictEqual(purchase(Q.session).status, 'refunded');
    });
    await t('Refund keeps earned training: a completed enrollment stays completed after a full refund', async () => {
      const Q = await paid('done@outside.example', 'Done Co');
      const e = purchase(Q.session).enrollment_id;
      run(DB, `update academy_enrollments set status = 'completed', completed_at = now() where id = '${e}'`);
      await refundEvt(Q, 1999);
      assert.strictEqual(run(DB, `select status from academy_enrollments where id = '${e}'`), 'completed');
    });
    await t('Decline: the buyer sees the reason; a declined request cannot be asked again', async () => {
      const Q = await paid('dec@outside.example', 'Dec Co'); const DC = await signIn('dec@outside.example');
      assert.strictEqual((await learner({ action: 'refund_request', purchase_id: Q.id, reason: 'Not what I expected' }, DC)).status, 200);
      const q = (await admin('pres', { action: 'sales_review' })).body.refund_requests.find(r => r.purchase_id === Q.id);
      assert.strictEqual((await admin('pres', { action: 'refund_decide', request_id: q.id, decision: 'decline', reason: 'Course completed in full already' })).status, 200);
      const mp = await learner({ action: 'my_purchases' }, DC);
      assert.deepStrictEqual([mp.body.purchases[0].request.status, mp.body.purchases[0].request.note], ['declined', 'Course completed in full already']);
      assert.strictEqual((await learner({ action: 'refund_request', purchase_id: Q.id, reason: 'Please reconsider' }, DC)).status, 400);
    });

    /* ---------- buyer review ---------- */
    await t('Buyer review: two refunds in 12 months → next checkout refused until the President allows it; "block" stops a buyer (audited)', async () => {
      const Q = await paid('rep@outside.example', 'Rep Co'); await refundEvt(Q, 1999);
      const Q2 = await paid('rep@outside.example', 'Rep Co'); await refundEvt(Q2, 1999);
      const r = await buy({ course_slug: 'dealer-sales-basics', full_name: 'Rep', company: 'Rep Co', email: 'rep@outside.example' }, { ip: '198.51.100.230' });
      assert.strictEqual(r.status, 403, JSON.stringify(r.body)); assert.match(r.body.message, /review this purchase/);
      assert.strictEqual((await admin('adm', { action: 'buyer_review', email: 'rep@outside.example', decision: 'allow', reason: 'Spoke with them' })).status, 403);
      assert.strictEqual((await admin('pres', { action: 'buyer_review', email: 'rep@outside.example', decision: 'allow', reason: 'Spoke with them, genuine' })).status, 200);
      assert.strictEqual((await buy({ course_slug: 'dealer-sales-basics', full_name: 'Rep', company: 'Rep Co', email: 'rep@outside.example' }, { ip: '198.51.100.231' })).status, 200);
      assert.strictEqual((await admin('pres', { action: 'buyer_review', email: 'block@outside.example', decision: 'block', reason: 'Chargeback history elsewhere' })).status, 200);
      assert.strictEqual((await buy({ course_slug: 'dealer-sales-basics', full_name: 'Blk', company: 'Blk Co', email: 'block@outside.example' }, { ip: '198.51.100.232' })).status, 403);
      assert.strictEqual(run(DB, `select count(*) from academy_buyer_reviews where email = 'rep@outside.example'`), '1');
      assert.ok(!tryRun(DB, `select set_config('academy.op','x',false); update academy_buyer_reviews set decision = 'block' where email = 'rep@outside.example'`).ok, 'decisions are never edited');
    });

    /* ---------- Command Center in a real browser (only when Playwright is available) ---------- */
    if (process.env.PLAYWRIGHT_MODULE) {
      const http = require('http'); const { chromium } = require(process.env.PLAYWRIGHT_MODULE);
      const SRC = path.join(__dirname, '..', 'src');
      const srv = http.createServer(async (req, res) => {
        const chunks = []; for await (const c of req) chunks.push(c);
        const [p] = req.url.split('?');
        if (p === '/.netlify/functions/academy-admin-api') {
          const out = await ADMIN.handler({ httpMethod: req.method, headers: req.headers, body: Buffer.concat(chunks).toString('utf8'), queryStringParameters: {} });
          res.writeHead(out.statusCode, out.headers); return res.end(out.body);
        }
        if (p.startsWith('/.netlify/functions/')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true,"favorites":[],"count":0}'); }
        const f = path.join(SRC, p.replace(/\.\./g, ''));
        if (!fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); return res.end(''); }
        res.writeHead(200, { 'content-type': f.endsWith('.css') ? 'text/css' : f.endsWith('.js') ? 'application/javascript' : 'text/html' }); res.end(fs.readFileSync(f));
      });
      await new Promise(r => srv.listen(0, '127.0.0.1', r)); const site = `http://127.0.0.1:${srv.address().port}`;
      const browser = await chromium.launch({ executablePath: fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined });
      try {
        for (const w of [390, 1280]) await t(`Browser ${w}px: Courses → Paid access shows refund requests, buyer reviews and price history for the President`, async () => {
          const ctx = await browser.newContext({ viewport: { width: w, height: 900 } });
          await ctx.addInitScript(() => { try { localStorage.setItem('hcps_staff_token', 'pres'); localStorage.setItem('hcps_staff_profile', JSON.stringify({ email: 'admin@test.example', name: 'Angelo', role: 'president' })); } catch (e) {} });
          await ctx.route(u => !/^http:\/\/127\.0\.0\.1[:/]/.test(String(u)), r => r.abort());
          const pg = await ctx.newPage(); const errors = []; pg.on('pageerror', e => errors.push(String(e)));
          await pg.goto(site + '/admin/academy.html'); await pg.waitForSelector('#tabs .tab');
          await pg.click('#tabs .tab[data-t="courses"]');
          await pg.waitForFunction(() => { const c = document.querySelectorAll('#paycard'); return c.length === 1 && /Refund requests/.test(c[0].textContent) && /Price history/.test(c[0].textContent); }, null, { timeout: 15000 });
          const txt = await pg.evaluate(() => [...document.querySelectorAll('#paycard')].map(e => e.textContent).join(' || '));
          assert.match(txt, /Bought the wrong course/); assert.match(txt, /rep@outside\.example/); assert.match(txt, /refund it in Stripe|refunded/);
          await pg.click('#paycard [data-price]'); await pg.waitForSelector('#preason');
          assert.deepStrictEqual(errors, []);
          if (process.env.SHOTS) { fs.mkdirSync(process.env.SHOTS, { recursive: true }); await pg.screenshot({ path: path.join(process.env.SHOTS, `m9-admin-${w}.png`), fullPage: true }); }
          await ctx.close();
        });
      } finally { await browser.close(); srv.close(); }
    }

    /* ---------- rollback ---------- */
    await t('Rollback: refused while M9 records exist; on a clean M8+M9 it restores M8 exactly (fingerprint) and the M8 price op', async () => {
      const r = psql(DB, ['-f', SUP('academy_p2_m9_refunds_rollback.sql')]); assert.notStrictEqual(r.status, 0); assert.match(r.stderr, /rollback refused/);
      const D4 = DB + '_rb'; run('postgres', `drop database if exists ${D4}`); run('postgres', `create database ${D4}`);
      run(D4, fixture());
      run(D4, `alter table public.dealers add column is_test boolean not null default false, add column status text, add column account_class text;
               create table public.dealer_users (uid uuid primary key, email text, dealer_id uuid references public.dealers(id), status text);`);
      file(D4, SUP('academy_a1_foundation.sql')); run(D4, 'grant all on all tables in schema public to service_role');
      for (const f of ['academy_a2a_m1_audited_ops.sql', 'academy_a2c_m2_content_ops.sql', 'academy_a2d_m3_author_ops.sql', 'academy_a2d_m3_1_save_lesson.sql',
                       'academy_c2_m4_publish_ops.sql', 'academy_a2b_m5_learner_access.sql', 'academy_a2e_m6_exam_attempts.sql', 'academy_a2f_m7_certificates.sql', 'academy_p2_m8_payments.sql']) file(D4, SUP(f));
      const fp = () => run(D4, `select md5(string_agg(p.proname || ':' || md5(p.prosrc), '|' order by p.proname)) from pg_proc p where p.pronamespace = 'public'::regnamespace and (p.proname like 'academy\\_purchase\\_%' or p.proname = 'academy_prices_rights_check')`);
      const before = fp();
      file(D4, SUP('academy_p2_m9_refunds.sql'));
      assert.match(file(D4, SUP('academy_p2_m9_refunds_rollback.sql')), /M9 removed\|t/);
      assert.strictEqual(fp(), before);
      run('postgres', `drop database ${D4} with (force)`);
    });
  } finally {
    console.log(`\nacademy-m9.pg: ${pass} passed, ${fail} failed`);
    try { run('postgres', `drop database if exists ${DB} with (force)`); } catch (e) {}
    process.exit(fail ? 1 : 0);
  }
})();
