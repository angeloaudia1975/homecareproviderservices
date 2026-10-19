/* _stripe.js unit tests + a small mutation check of the signature verifier (Phase 2 / M8).
     node test/academy-stripe.test.js */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const SRC = path.join(__dirname, '..', 'netlify', 'functions', '_stripe.js');
const load = src => { const m = new Module(SRC); m.filename = SRC; m.paths = Module._nodeModulePaths(path.dirname(SRC)); m._compile(src, SRC); return m.exports; };
const WHSEC = 'whsec_' + 'B'.repeat(32);
const sign = (raw, ts, secret) => `t=${ts},v1=${crypto.createHmac('sha256', secret || WHSEC).update(ts + '.' + raw).digest('hex')}`;
const now = () => Math.floor(Date.now() / 1000);
const EV = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', livemode: false, data: { object: { id: 'cs_test_x', payment_status: 'paid', amount_total: 1999, currency: 'usd', client_reference_id: 'p', payment_intent: 'pi_1' } } });

function suite(S) {
  const out = [];
  const t = (name, fn) => { try { fn(); out.push([name, true]); } catch (e) { out.push([name, false, e.message]); } };
  process.env.STRIPE_WEBHOOK_SECRET = WHSEC;
  t('valid signature accepted', () => assert.ok(S.verify(Buffer.from(EV), sign(EV, now()))));
  t('wrong secret refused', () => assert.strictEqual(S.verify(Buffer.from(EV), sign(EV, now(), 'whsec_' + 'C'.repeat(32))), null));
  t('tampered body refused', () => assert.strictEqual(S.verify(Buffer.from(EV.replace('1999', '1')), sign(EV, now())), null));
  t('stale timestamp refused', () => assert.strictEqual(S.verify(Buffer.from(EV), sign(EV, now() - 301)), null));
  t('future timestamp refused', () => assert.strictEqual(S.verify(Buffer.from(EV), sign(EV, now() + 301)), null));
  t('missing header refused', () => assert.strictEqual(S.verify(Buffer.from(EV), ''), null));
  t('v0 / non-hex signature ignored', () => assert.strictEqual(S.verify(Buffer.from(EV), `t=${now()},v0=${'a'.repeat(64)}`), null));
  t('one good v1 among several accepted (secret rotation)', () => assert.ok(S.verify(Buffer.from(EV), `t=${now()},v1=${'0'.repeat(64)},` + sign(EV, now()).split(',')[1])));
  t('no secret configured refuses all (even a signature made with an empty key)', () => {
    process.env.STRIPE_WEBHOOK_SECRET = '';
    const a = S.verify(Buffer.from(EV), sign(EV, now())), b = S.verify(Buffer.from(EV), sign(EV, now(), ''));
    process.env.STRIPE_WEBHOOK_SECRET = 'short'; const c = S.verify(Buffer.from(EV), sign(EV, now(), 'short'));
    process.env.STRIPE_WEBHOOK_SECRET = WHSEC; assert.strictEqual(a, null); assert.strictEqual(b, null); assert.strictEqual(c, null);
  });
  t('non-JSON body refused', () => assert.strictEqual(S.verify(Buffer.from('nope'), sign('nope', now())), null));
  t('keyMode', () => {
    const k = process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_SECRET_KEY = 'sk_test_' + 'a'.repeat(20); assert.strictEqual(S.keyMode(), 'test');
    process.env.STRIPE_SECRET_KEY = 'sk_live_' + 'a'.repeat(20); assert.strictEqual(S.keyMode(), 'live');
    process.env.STRIPE_SECRET_KEY = 'pk_test_' + 'a'.repeat(20); assert.strictEqual(S.keyMode(), 'invalid');
    process.env.STRIPE_SECRET_KEY = ''; assert.strictEqual(S.keyMode(), 'missing');
    process.env.STRIPE_SECRET_KEY = k;
  });
  t('extract keeps only needed fields (no card data)', () => {
    const ev = JSON.parse(EV); ev.data.object.payment_method_details = { card: { last4: '4242' } }; ev.data.object.customer_details = { email: 'x@y.z' };
    const x = S.extract(ev); assert.deepStrictEqual(Object.keys(x).sort(), ['amount_total', 'client_reference_id', 'currency', 'payment_intent', 'payment_status', 'session_id']);
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
  // live key refusal in createCheckoutSession (no network)
  const S = load(src); process.env.STRIPE_SECRET_KEY = 'sk_live_' + 'a'.repeat(20); let called = false; global.fetch = async () => { called = true; return new Response('{}'); };
  try { await S.createCheckoutSession({ purchase_id: 'x' }); fail++; console.log('  FAIL live key accepted'); } catch (e) { if (e.code !== 'live_key_refused' || called) { fail++; console.log('  FAIL live key'); } else console.log('  ok   createCheckoutSession refuses a live key without calling Stripe'); }
  // mutation check: each mutant must make at least one test fail
  const MUT = [
    ['tolerance ignored', 'if (Math.abs(now - t) > TOLERANCE_S) return null;', ''],
    ['timestamp not signed', "update(String(t) + '.')", "update('')"],
    ['any v1 passes', 'const ok = v1.some(', 'const ok = true || v1.some('],
    ['secret check skipped', 'if (!webhookConfigured() || !Buffer.isBuffer(raw)) return null;', 'if (!Buffer.isBuffer(raw)) return null;'],
    ['live key treated as test', "if (/^(sk|rk)_live_/.test(k)) return 'live';", "if (/^(sk|rk)_live_/.test(k)) return 'test';"],
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
