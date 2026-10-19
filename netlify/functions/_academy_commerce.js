/* HCPS Academy — Phase 2 commerce helpers: Stripe (hosted Checkout, verified webhooks, refunds) and the money rules.
   Rules (docs/academy/PHASE2_PAYMENTS_PROPOSAL.md; PR #25 comment 6278300397):
     - The PRICE always comes from the database (academy_commerce_op_checkout_open), never from the browser.
     - Access is granted ONLY by a Stripe webhook whose signature verifies with STRIPE_WEBHOOK_SECRET over the RAW body,
       within 5 minutes; the event's mode (test / live) must equal the key's mode. Never by the success page.
     - Card details never touch HCPS: Stripe's hosted Checkout page takes them.
     - The mode comes from the secret key itself: sk_test_ / rk_test_ = TEST mode; sk_live_ / rk_live_ = LIVE, and LIVE is
       used only when the academy_payments_live switch is exactly true. No key = no checkout.
     - Every Stripe write carries an Idempotency-Key, so a retry never creates a second session or refund.
   Nothing secret is ever returned or logged (no key, no signature, no card data). */
const crypto = require('crypto');

const STRIPE_API = 'https://api.stripe.com/v1';
const TOLERANCE_S = 300;

function keyMode(key) {
  const k = String(key || '');
  if (/^(sk|rk)_test_[A-Za-z0-9]{10,}$/.test(k)) return 'test';
  if (/^(sk|rk)_live_[A-Za-z0-9]{10,}$/.test(k)) return 'live';
  return null;
}
/* What the server can sell with right now: {mode, key} or null. */
function stripeKey(liveAllowed) {
  const key = process.env.STRIPE_SECRET_KEY || '';
  const mode = keyMode(key);
  if (!mode) return null;
  if (mode === 'live' && !liveAllowed) return null;
  return { mode, key };
}
const webhookSecret = () => { const s = process.env.STRIPE_WEBHOOK_SECRET || ''; return /^whsec_[A-Za-z0-9+/=_-]{10,}$/.test(s) ? s : null; };

/* Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>…][,v0=…]. Returns true only when one v1 equals
   HMAC-SHA256(secret, "<t>.<raw body>") and t is within the tolerance. Constant-time comparison. */
function verifySignature(rawBody, header, secret, nowSeconds) {
  if (typeof rawBody !== 'string' || !header || !secret) return false;
  const parts = String(header).split(',').map(x => x.trim());
  let t = null; const sigs = [];
  for (const p of parts) {
    const i = p.indexOf('='); if (i < 1) continue;
    const k = p.slice(0, i), v = p.slice(i + 1);
    if (k === 't' && /^\d{1,12}$/.test(v)) t = Number(v);
    else if (k === 'v1' && /^[0-9a-f]{64}$/.test(v)) sigs.push(v);
  }
  if (t == null || !sigs.length) return false;
  const now = nowSeconds == null ? Math.floor(Date.now() / 1000) : nowSeconds;
  if (Math.abs(now - t) > TOLERANCE_S) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`, 'utf8').digest();
  return sigs.some(s => { const b = Buffer.from(s, 'hex'); return b.length === expected.length && crypto.timingSafeEqual(b, expected); });
}
/* Test helper (and the shape Stripe uses): a valid header for a body. */
function signHeader(rawBody, secret, t) {
  const ts = t == null ? Math.floor(Date.now() / 1000) : t;
  return `t=${ts},v1=${crypto.createHmac('sha256', secret).update(`${ts}.${rawBody}`, 'utf8').digest('hex')}`;
}

/* application/x-www-form-urlencoded with Stripe's bracket notation. */
function form(obj, prefix, out) {
  out = out || [];
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => typeof x === 'object' ? form(x, `${key}[${i}]`, out) : out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(x))}`));
    else if (typeof v === 'object') form(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out.join('&');
}

class StripeError extends Error { constructor(status, type) { super('stripe ' + status + ' ' + (type || '')); this.status = status; this.type = type || null; } }
async function stripe(sk, method, path, params, idem) {
  if (!/^\/[a-z_\/A-Za-z0-9]+$/.test(path)) throw new StripeError(0, 'bad_path');
  const headers = { authorization: 'Bearer ' + sk.key, 'stripe-version': '2024-06-20' };
  if (method === 'POST') { headers['content-type'] = 'application/x-www-form-urlencoded'; if (idem) headers['idempotency-key'] = idem; }
  let r; try {
    r = await fetch(STRIPE_API + path, { method, headers, body: method === 'POST' ? form(params || {}) : undefined });
  } catch (e) { throw new StripeError(0, 'network'); }
  let j = null; try { j = await r.json(); } catch (e) { j = null; }
  if (!r.ok) throw new StripeError(r.status, j && j.error && j.error.type);
  return j;
}

/* A hosted Checkout Session for one checkout row. The amount, currency and product name come from that row (the
   database's price); the customer email is the buyer's; card payments only (so "paid" is known on completion). */
async function createCheckoutSession(sk, checkout, courseTitle, siteOrigin) {
  const s = await stripe(sk, 'POST', '/checkout/sessions', {
    mode: 'payment',
    payment_method_types: ['card'],
    customer_email: checkout.buyer_email,
    client_reference_id: checkout.id,
    line_items: [{ quantity: 1, price_data: { currency: checkout.currency, unit_amount: checkout.amount_cents,
                                              product_data: { name: String(courseTitle).slice(0, 200), description: 'HCPS Academy course access (HCPS-issued training).' } } }],
    metadata: { checkout_id: checkout.id, course_id: checkout.course_id },
    payment_intent_data: { metadata: { checkout_id: checkout.id, course_id: checkout.course_id } },
    success_url: `${siteOrigin}/academy/buy/done/?session={CHECKOUT_SESSION_ID}`,
    cancel_url: `${siteOrigin}/academy/buy/?canceled=1`,
    expires_at: Math.floor(Date.parse(checkout.expires_at) / 1000) - 60,
  }, 'academy-checkout-' + checkout.id);
  if (!s || typeof s.id !== 'string' || !new RegExp('^cs_' + sk.mode + '_').test(s.id) || typeof s.url !== 'string' || !/^https:\/\/checkout\.stripe\.com\//.test(s.url)) {
    throw new StripeError(502, 'unexpected_session');
  }
  return { id: s.id, url: s.url };
}
async function retrieveCheckoutSession(sk, id) {
  if (!/^cs_(test|live)_[A-Za-z0-9]{8,240}$/.test(String(id))) throw new StripeError(400, 'bad_id');
  const s = await stripe(sk, 'GET', '/checkout/sessions/' + id);
  return { id: s.id, url: s.url || null, status: s.status || null };
}
async function createRefund(sk, purchase, amountCents) {
  return stripe(sk, 'POST', '/refunds', { payment_intent: purchase.payment_intent_id, amount: amountCents,
    metadata: { purchase_id: purchase.id } }, 'academy-refund-' + purchase.id + '-' + amountCents);
}

const dollars = c => '$' + (Number(c) / 100).toFixed(2);

module.exports = { keyMode, stripeKey, webhookSecret, verifySignature, signHeader, form, stripe, StripeError,
                   createCheckoutSession, retrieveCheckoutSession, createRefund, dollars, TOLERANCE_S, STRIPE_API };
