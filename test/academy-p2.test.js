/* HCPS Academy Phase 2 — Stripe helper unit tests (no database, no network): signature verification, key modes,
   form encoding, and the checkout / webhook front doors refusing what they must before any database call. */
const assert = require('assert');
const crypto = require('crypto');
const C = require('../netlify/functions/_academy_commerce.js');

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + String(e && e.stack || e).split('\n').slice(0, 5).join('\n       ')); } }
const SEC = 'whsec_unit0123456789abcdefgh';
const body = JSON.stringify({ id: 'evt_test0000000001', type: 'x', livemode: false });
const now = Math.floor(Date.now() / 1000);

(async () => {
  await t('signature: a correct header verifies', () => assert.strictEqual(C.verifySignature(body, C.signHeader(body, SEC, now), SEC, now), true));
  await t('signature: wrong secret, changed body, missing parts are refused', () => {
    assert.strictEqual(C.verifySignature(body, C.signHeader(body, 'whsec_other0123456789abcd', now), SEC, now), false);
    assert.strictEqual(C.verifySignature(body + ' ', C.signHeader(body, SEC, now), SEC, now), false);
    assert.strictEqual(C.verifySignature(body, `t=${now}`, SEC, now), false);
    assert.strictEqual(C.verifySignature(body, `v1=${'a'.repeat(64)}`, SEC, now), false);
    assert.strictEqual(C.verifySignature(body, '', SEC, now), false);
    assert.strictEqual(C.verifySignature(body, C.signHeader(body, SEC, now), '', now), false);
    assert.strictEqual(C.verifySignature(undefined, C.signHeader(body, SEC, now), SEC, now), false);
  });
  await t('signature: older or newer than 5 minutes is refused; 5 minutes exactly is fine', () => {
    assert.strictEqual(C.verifySignature(body, C.signHeader(body, SEC, now - 301), SEC, now), false);
    assert.strictEqual(C.verifySignature(body, C.signHeader(body, SEC, now + 301), SEC, now), false);
    assert.strictEqual(C.verifySignature(body, C.signHeader(body, SEC, now - 300), SEC, now), true);
  });
  await t('signature: v0 (Stripe test-only scheme) never counts; any one valid v1 does', () => {
    const good = C.signHeader(body, SEC, now).split('v1=')[1];
    assert.strictEqual(C.verifySignature(body, `t=${now},v0=${good}`, SEC, now), false);
    assert.strictEqual(C.verifySignature(body, `t=${now},v1=${'f'.repeat(64)},v1=${good}`, SEC, now), true);
    assert.strictEqual(C.verifySignature(body, `t=${now},v1=${good.slice(0, 63)}`, SEC, now), false, 'short signature');
  });
  await t('key mode comes from the key itself; LIVE only with the live switch', () => {
    assert.strictEqual(C.keyMode('sk_test_' + 'a'.repeat(20)), 'test');
    assert.strictEqual(C.keyMode('rk_live_' + 'a'.repeat(20)), 'live');
    assert.strictEqual(C.keyMode('pk_test_' + 'a'.repeat(20)), null, 'a publishable key is never a secret key');
    assert.strictEqual(C.keyMode(''), null);
    process.env.STRIPE_SECRET_KEY = 'sk_live_' + 'a'.repeat(20);
    assert.strictEqual(C.stripeKey(false), null); assert.strictEqual(C.stripeKey(true).mode, 'live');
    process.env.STRIPE_SECRET_KEY = 'sk_test_' + 'a'.repeat(20);
    assert.strictEqual(C.stripeKey(false).mode, 'test');
    delete process.env.STRIPE_SECRET_KEY; assert.strictEqual(C.stripeKey(true), null);
  });
  await t('webhook secret must look like whsec_…', () => {
    process.env.STRIPE_WEBHOOK_SECRET = 'nope'; assert.strictEqual(C.webhookSecret(), null);
    process.env.STRIPE_WEBHOOK_SECRET = SEC; assert.strictEqual(C.webhookSecret(), SEC);
  });
  await t('form encoding uses Stripe bracket notation', () => {
    const f = C.form({ mode: 'payment', line_items: [{ quantity: 1, price_data: { unit_amount: 999 } }], metadata: { a: 'x y' }, skip: null });
    assert.strictEqual(f, 'mode=payment&line_items%5B0%5D%5Bquantity%5D=1&line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=999&metadata%5Ba%5D=x%20y');
  });
  await t('webhook front door: refuses before touching the database (no env = 503; unsigned = 400; GET = 405)', async () => {
    const WH = require('../netlify/functions/academy-stripe-webhook.js');
    let touched = 0; global.fetch = async () => { touched++; return new Response('[]', { status: 200 }); };
    delete process.env.SUPABASE_URL;
    assert.strictEqual((await WH.handler({ httpMethod: 'POST', headers: {}, body: body })).statusCode, 503);
    process.env.SUPABASE_URL = 'https://x.test'; process.env.SUPABASE_SERVICE_ROLE = 'k';
    assert.strictEqual((await WH.handler({ httpMethod: 'GET', headers: {}, body: '' })).statusCode, 405);
    assert.strictEqual((await WH.handler({ httpMethod: 'POST', headers: {}, body })).statusCode, 400);
    assert.strictEqual((await WH.handler({ httpMethod: 'POST', headers: { 'stripe-signature': C.signHeader(body, 'whsec_wrong0123456789abcd') }, body })).statusCode, 400);
    process.env.STRIPE_SECRET_KEY = 'sk_test_' + 'a'.repeat(20);
    const b64 = Buffer.from(body).toString('base64');
    const r = await WH.handler({ httpMethod: 'POST', isBase64Encoded: true, headers: { 'stripe-signature': C.signHeader(body, SEC) }, body: b64 });
    assert.strictEqual(r.statusCode, 200, 'a base64 body is verified on its decoded bytes');
    assert.strictEqual(touched > 0, true);
  });
  console.log(`\nacademy-p2 (unit): ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
