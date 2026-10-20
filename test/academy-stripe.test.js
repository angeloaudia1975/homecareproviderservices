/* _stripe.js unit tests + a small mutation check of the signature verifier (Phase 2 / M8).
     node test/academy-stripe.test.js */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const SRC = path.join(__dirname, '..', 'netlify', 'functions', '_stripe.js');
const load = src => { const m = new Module(SRC); m.filename = SRC; m.paths = Module._nodeModulePaths(path.dirname(SRC)); m._compile(src, SRC); return m.exports; };
const WHSEC = 'whsec_' + 'B'.repeat(32), LIVE_WHSEC = 'whsec_' + 'W'.repeat(32);
const sign = (raw, ts, secret) => `t=${ts},v1=${crypto.createHmac('sha256', secret || WHSEC).update(ts + '.' + raw).digest('hex')}`;
const now = () => Math.floor(Date.now() / 1000);
const EV = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', livemode: false, data: { object: { id: 'cs_test_x', payment_status: 'paid', amount_total: 1999, currency: 'usd', client_reference_id: 'p', payment_intent: 'pi_1' } } });

function suite(S) {
  const out = [];
  const t = (name, fn) => { try { fn(); out.push([name, true]); } catch (e) { out.push([name, false, e.message]); } };
  process.env.STRIPE_WEBHOOK_SECRET = WHSEC; process.env.STRIPE_WEBHOOK_SECRET_LIVE = LIVE_WHSEC;
  const LIVE_EV = EV.replace('"livemode":false', '"livemode":true');
  t('live: signed with the live secret and livemode true accepted', () => assert.ok(S.verify(Buffer.from(LIVE_EV), sign(LIVE_EV, now(), LIVE_WHSEC))));
  t('live: a sandbox-signed event claiming livemode is refused', () => assert.strictEqual(S.verify(Buffer.from(LIVE_EV), sign(LIVE_EV, now())), null));
  t('live: a live-signed event claiming sandbox is refused', () => assert.strictEqual(S.verify(Buffer.from(EV), sign(EV, now(), LIVE_WHSEC)), null));
  t('live: without a live secret, live events are refused', () => {
    delete process.env.STRIPE_WEBHOOK_SECRET_LIVE; const a = S.verify(Buffer.from(LIVE_EV), sign(LIVE_EV, now(), LIVE_WHSEC));
    process.env.STRIPE_WEBHOOK_SECRET_LIVE = LIVE_WHSEC; assert.strictEqual(a, null);
  });
  t('webhookConfigured per mode', () => {
    assert.strictEqual(S.webhookConfigured(true), true); assert.strictEqual(S.webhookConfigured(false), true);
    process.env.STRIPE_WEBHOOK_SECRET_LIVE = 'nope'; const l = S.webhookConfigured(true); process.env.STRIPE_WEBHOOK_SECRET_LIVE = LIVE_WHSEC;
    assert.strictEqual(l, false);
  });
  t('valid signature accepted', () => assert.ok(S.verify(Buffer.from(EV), sign(EV, now()))));
  t('wrong secret refused', () => assert.strictEqual(S.verify(Buffer.from(EV), sign(EV, now(), 'whsec_' + 'C'.repeat(32))), null));
  t('tampered body refused', () => assert.strictEqual(S.verify(Buffer.from(EV.replace('1999', '1')), sign(EV, now())), null));
  t('stale timestamp refused', () => assert.strictEqual(S.verify(Buffer.from(EV), sign(EV, now() - 301)), null));
  t('future timestamp refused', () => assert.strictEqual(S.verify(Buffer.from(EV), sign(EV, now() + 301)), null));
  t('missing header refused', () => assert.strictEqual(S.verify(Buffer.from(EV), ''), null));
  t('v0 / non-hex signature ignored', () => assert.strictEqual(S.verify(Buffer.from(EV), `t=${now()},v0=${'a'.repeat(64)}`), null));
  t('one good v1 among several accepted (secret rotation)', () => assert.ok(S.verify(Buffer.from(EV), `t=${now()},v1=${'0'.repeat(64)},` + sign(EV, now()).split(',')[1])));
  t('no secret configured refuses all (even a signature made with an empty key)', () => {
    process.env.STRIPE_WEBHOOK_SECRET = ''; delete process.env.STRIPE_WEBHOOK_SECRET_LIVE;
    const a = S.verify(Buffer.from(EV), sign(EV, now())), b = S.verify(Buffer.from(EV), sign(EV, now(), ''));
    process.env.STRIPE_WEBHOOK_SECRET = 'short'; const c = S.verify(Buffer.from(EV), sign(EV, now(), 'short'));
    process.env.STRIPE_WEBHOOK_SECRET = WHSEC; process.env.STRIPE_WEBHOOK_SECRET_LIVE = LIVE_WHSEC; assert.strictEqual(a, null); assert.strictEqual(b, null); assert.strictEqual(c, null);
  });
  t('non-JSON body refused', () => assert.strictEqual(S.verify(Buffer.from('nope'), sign('nope', now())), null));
  t('keyMode', () => {
    const k = process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_SECRET_KEY = 'sk_test_' + 'a'.repeat(20); assert.strictEqual(S.keyMode(), 'test');
    process.env.STRIPE_SECRET_KEY = 'sk_live_' + 'a'.repeat(20); assert.strictEqual(S.keyMode(), 'live');
    process.env.STRIPE_SECRET_KEY = 'pk_test_' + 'a'.repeat(20); assert.strictEqual(S.keyMode(), 'invalid');
    process.env.STRIPE_SECRET_KEY = ''; assert.strictEqual(S.keyMode(), 'missing');
    process.env.STRIPE_SECRET_KEY = k;
    const lk = process.env.STRIPE_SECRET_KEY_LIVE;
    process.env.STRIPE_SECRET_KEY_LIVE = 'sk_live_' + 'a'.repeat(20); assert.strictEqual(S.liveKeyMode(), 'live'); assert.strictEqual(S.keyReady(true), true);
    process.env.STRIPE_SECRET_KEY_LIVE = 'sk_test_' + 'a'.repeat(20); assert.strictEqual(S.keyReady(true), false, 'a test key never serves live');
    process.env.STRIPE_SECRET_KEY = 'sk_live_' + 'a'.repeat(20); assert.strictEqual(S.keyReady(false), false, 'a live key never serves the sandbox');
    process.env.STRIPE_SECRET_KEY = k; if (lk === undefined) delete process.env.STRIPE_SECRET_KEY_LIVE; else process.env.STRIPE_SECRET_KEY_LIVE = lk;
  });
  t('extract keeps only needed fields (no card data)', () => {
    const ev = JSON.parse(EV); ev.data.object.payment_method_details = { card: { last4: '4242' } }; ev.data.object.customer_details = { email: 'x@y.z' };
    const x = S.extract(ev); assert.deepStrictEqual(Object.keys(x).sort(), ['amount_subtotal', 'amount_tax', 'amount_total', 'client_reference_id', 'currency', 'payment_intent', 'payment_status', 'session_id']);
    assert.ok(!JSON.stringify(x).includes('4242'));
    assert.deepStrictEqual(S.extract({ type: 'charge.refunded', data: { object: { payment_intent: { id: 'pi_9' }, amount_refunded: 5 } } }), { payment_intent: 'pi_9', amount_refunded: '5' });
  });
  t('form encoding nests line items', () => assert.ok(S._form({ a: { 0: { b: 1 } } }).includes('a%5B0%5D%5Bb%5D=1')));
  return out;
}

(async () => {
  const src = fs.readFileSync(SRC, 'utf8');
  const res = suite(load(src));
  let fail = 0; for (const [n, ok, m] of res) { console.log((ok ? '  ok   ' : '  FAIL ') + n + (ok ? '' : ' — ' + m)); if (!ok) fail++; }
  // key / mode checks in createCheckoutSession (no network)
  const S = load(src); let called = 0, sent = null, answer = {};
  global.fetch = async (u, o) => { called++; sent = o.headers.authorization; return new Response(JSON.stringify(answer), { status: 200 }); };
  const expect = async (label, fn, ok) => { try { const v = await fn(); if (ok(v, null)) console.log('  ok   ' + label); else { fail++; console.log('  FAIL ' + label); } } catch (e) { if (ok(null, e)) console.log('  ok   ' + label); else { fail++; console.log('  FAIL ' + label + ' — ' + (e.code || e.message)); } } };
  process.env.STRIPE_SECRET_KEY = 'sk_live_' + 'a'.repeat(20); delete process.env.STRIPE_SECRET_KEY_LIVE;
  await expect('sandbox checkout refuses a live key in the sandbox slot without calling Stripe', () => S.createCheckoutSession({ purchase_id: 'x' }), (v, e) => e && e.code === 'not_configured' && called === 0);
  process.env.STRIPE_SECRET_KEY_LIVE = 'sk_test_' + 'a'.repeat(20);
  await expect('live checkout refuses a test key in the live slot without calling Stripe', () => S.createCheckoutSession({ live: true, purchase_id: 'x' }), (v, e) => e && e.code === 'not_configured' && called === 0);
  process.env.STRIPE_SECRET_KEY = 'sk_test_' + 's'.repeat(20); process.env.STRIPE_SECRET_KEY_LIVE = 'sk_live_' + 'l'.repeat(20);
  answer = { id: 'cs_live_abcdefgh', url: 'https://checkout.stripe.com/c/pay/cs_live_abcdefgh', livemode: true };
  await expect('live checkout uses the live key and returns a live session', () => S.createCheckoutSession({ live: true, purchase_id: 'x', currency: 'usd', amount_cents: 1999, title: 'T' }),
    (v) => v && v.livemode === true && /sk_live_l/.test(sent));
  await expect('sandbox checkout refuses a live session coming back from Stripe', () => S.createCheckoutSession({ purchase_id: 'x', currency: 'usd', amount_cents: 1999, title: 'T' }),
    (v, e) => e && e.code === 'mode_mismatch' && /sk_test_s/.test(sent));
  // mutation check: each mutant must make at least one test fail
  const MUT = [
    ['tolerance ignored', 'if (Math.abs(now - t) > TOLERANCE_S) return null;', ''],
    ['timestamp not signed', "update(String(t) + '.')", "update('')"],
    ['any v1 passes', 'const ok = v1.some(', 'const ok = true || v1.some('],
    ['secret check skipped', 'if (!webhookConfigured(live)) continue;', ''],
    ['live key treated as test', "if (/^(sk|rk)_live_[A-Za-z0-9]{10,}$/.test(k)) return 'live';", "if (/^(sk|rk)_live_[A-Za-z0-9]{10,}$/.test(k)) return 'test';"],
    ['mode not bound to the signing secret', "if ((ev.livemode === true) !== signedLive) return null;", ""],
    ['live slot accepts any key', "return live ? liveKeyMode() === 'live' : keyMode() === 'test';", "return live ? liveKeyMode() !== 'missing' : keyMode() === 'test';"],
    ['card data passed on', "return { session_id: s(o.id),", "return { card: o.payment_method_details, session_id: s(o.id),"],
  ];
  let killed = 0;
  for (const [name, a, b] of MUT) {
    if (!src.includes(a)) { console.log('  FAIL mutant anchor missing: ' + name); fail++; continue; }
    const r = suite(load(src.replace(a, b)));
    if (r.some(x => !x[1])) killed++; else { console.log('  FAIL mutant survived: ' + name); fail++; }
  }
  console.log(`  mutants killed ${killed}/${MUT.length}`);
  console.log(fail ? `\n${fail} failed` : '\nall passed'); process.exit(fail ? 1 : 0);
})();
