/* HCPS Academy — Stripe (Phase 2 / M8). SANDBOX ONLY.
   No npm package: global fetch + node crypto, like every other HCPS function.
     keyMode()                 'test' | 'live' | 'missing' | 'invalid' for STRIPE_SECRET_KEY (never returns the key)
     webhookConfigured()       STRIPE_WEBHOOK_SECRET is present and shaped like a signing secret
     verify(raw, header, now)  Stripe-Signature check: t=…,v1=… → HMAC-SHA256("t.raw") with STRIPE_WEBHOOK_SECRET,
                               timing-safe, 5-minute tolerance. Returns the parsed event or null. Never throws on input.
     createCheckoutSession(p)  POST /v1/checkout/sessions with price_data (no Stripe Products or Prices are created),
                               one line, customer_email, client_reference_id + metadata = the HCPS purchase id,
                               Idempotency-Key = the purchase id. Refuses unless the key is a TEST key.
   Live keys are refused here AND by the database (academy_purchases.livemode must be false): taking real payments is a
   reviewed follow-up with Angelo's approval. Secrets are never logged, returned or put in an error message. */
const crypto = require('crypto');

const API = 'https://api.stripe.com/v1';
const TOLERANCE_S = 300;

function keyMode() {
  const k = process.env.STRIPE_SECRET_KEY || '';
  if (!k) return 'missing';
  if (/^(sk|rk)_test_[A-Za-z0-9]{10,}$/.test(k)) return 'test';
  if (/^(sk|rk)_live_/.test(k)) return 'live';
  return 'invalid';
}
function webhookConfigured() { return /^whsec_[A-Za-z0-9+/=]{16,}$/.test(process.env.STRIPE_WEBHOOK_SECRET || ''); }

function parseHeader(h) {
  const out = { t: null, v1: [] };
  for (const part of String(h || '').split(',')) {
    const i = part.indexOf('='); if (i < 1) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === 't' && /^\d{1,12}$/.test(v)) out.t = Number(v);
    else if (k === 'v1' && /^[0-9a-f]{64}$/.test(v)) out.v1.push(v);
  }
  return out;
}

/* raw: Buffer of the exact request body. Returns the event object, or null when anything is wrong. */
function verify(raw, header, nowMs) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET || '';
  if (!webhookConfigured() || !Buffer.isBuffer(raw)) return null;
  const { t, v1 } = parseHeader(header);
  if (t == null || !v1.length) return null;
  const now = Math.floor((nowMs == null ? Date.now() : nowMs) / 1000);
  if (Math.abs(now - t) > TOLERANCE_S) return null;
  const expected = crypto.createHmac('sha256', secret).update(String(t) + '.').update(raw).digest();
  const ok = v1.some(sig => { const b = Buffer.from(sig, 'hex'); return b.length === expected.length && crypto.timingSafeEqual(b, expected); });
  if (!ok) return null;
  try { const ev = JSON.parse(raw.toString('utf8')); return ev && typeof ev === 'object' && typeof ev.id === 'string' && typeof ev.type === 'string' ? ev : null; }
  catch (e) { return null; }
}

/* Only the fields HCPS needs, per event type. Card data is never read or stored. */
function extract(ev) {
  const o = (ev.data && ev.data.object) || {};
  const s = v => (v == null ? null : String(v));
  const pi = v => (v && typeof v === 'object' ? s(v.id) : s(v));
  if (/^checkout\.session\./.test(ev.type)) {
    return { session_id: s(o.id), client_reference_id: s(o.client_reference_id), payment_status: s(o.payment_status),
             amount_total: o.amount_total == null ? null : String(o.amount_total), currency: s(o.currency), payment_intent: pi(o.payment_intent) };
  }
  if (ev.type === 'charge.refunded') return { payment_intent: pi(o.payment_intent), amount_refunded: o.amount_refunded == null ? null : String(o.amount_refunded) };
  if (/^charge\.dispute\./.test(ev.type)) return { payment_intent: pi(o.payment_intent), dispute_status: s(o.status) };
  return {};
}

function form(obj, prefix, out) {
  out = out || [];
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') form(v, key, out);
    else out.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(v)));
  }
  return out;
}

class StripeError extends Error { constructor(status, code) { super('stripe ' + code); this.status = status; this.code = code; } }

async function createCheckoutSession(p) {
  if (keyMode() !== 'test') throw new StripeError(503, keyMode() === 'live' ? 'live_key_refused' : 'not_configured');
  const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60;   // one hour (Stripe allows 30 min – 24 h)
  const body = form({
    mode: 'payment',
    customer_email: p.email,
    client_reference_id: p.purchase_id,
    success_url: p.success_url,
    cancel_url: p.cancel_url,
    expires_at: expiresAt,
    'payment_method_types[0]': 'card',
    line_items: { 0: { quantity: 1, price_data: { currency: p.currency, unit_amount: p.amount_cents,
                  product_data: { name: p.title, description: 'HCPS Academy course access (HCPS-issued training)' } } } },
    metadata: { purchase_id: p.purchase_id, version_id: p.version_id, source: 'hcps-academy' },
    payment_intent_data: { metadata: { purchase_id: p.purchase_id, source: 'hcps-academy' }, description: 'HCPS Academy: ' + p.title },
  }).join('&');
  let r;
  try {
    r = await fetch(`${API}/checkout/sessions`, { method: 'POST', body, headers: {
      authorization: 'Bearer ' + process.env.STRIPE_SECRET_KEY, 'content-type': 'application/x-www-form-urlencoded',
      'idempotency-key': 'hcps-academy-' + p.purchase_id, 'stripe-version': '2024-06-20' } });
  } catch (e) { throw new StripeError(502, 'unreachable'); }
  let j = null; try { j = await r.json(); } catch (e) { j = null; }
  if (!r.ok || !j || typeof j.id !== 'string' || typeof j.url !== 'string') throw new StripeError(502, (j && j.error && j.error.type) || 'refused');
  return { id: j.id, url: j.url, expires_at: new Date((j.expires_at || expiresAt) * 1000).toISOString(), livemode: j.livemode === true };
}

module.exports = { keyMode, webhookConfigured, verify, extract, createCheckoutSession, StripeError, parseHeader, TOLERANCE_S, _form: form };
