/* HCPS Academy — Stripe (Phase 2 / M8 sandbox + M9 live). No npm package: global fetch + node crypto.
   Two separate credential sets, so the sandbox keeps working beside live:
     sandbox  STRIPE_SECRET_KEY      (sk_test_ / rk_test_ only)   STRIPE_WEBHOOK_SECRET       (sandbox endpoint)
     live     STRIPE_SECRET_KEY_LIVE (sk_live_ / rk_live_ only)   STRIPE_WEBHOOK_SECRET_LIVE  (live endpoint)
   A test key in the live slot (or a live key in the sandbox slot) is refused. WHICH mode a checkout uses is decided by the
   database (phase2_flags.academy_payments_live, read by academy_purchase_op_open), never by the browser.
     keyMode()                 'test' | 'live' | 'missing' | 'invalid' for STRIPE_SECRET_KEY (never returns the key)
     liveKeyMode()             the same for STRIPE_SECRET_KEY_LIVE
     keyReady(live)            the key for that mode is present and of that mode
     webhookConfigured(live?)  that endpoint's signing secret is present and well formed (no argument: either)
     verify(raw, header, now)  Stripe-Signature check: t=…,v1=… → HMAC-SHA256("t.raw") with each configured signing secret,
                               timing-safe, 5-minute tolerance. Returns the parsed event or null; an event signed with the
                               sandbox secret must say livemode false, with the live secret livemode true. Never throws.
     createCheckoutSession(p)  POST /v1/checkout/sessions with price_data (no Stripe Products or Prices are created),
                               one line, customer_email, client_reference_id + metadata = the HCPS purchase id,
                               Idempotency-Key = the purchase id, using the key of p.live's mode (refused if not ready).
   Secrets are never logged, returned or put in an error message. */
const crypto = require('crypto');

const API = 'https://api.stripe.com/v1';
const TOLERANCE_S = 300;

function modeOf(k) {
  k = k || '';
  if (!k) return 'missing';
  if (/^(sk|rk)_test_[A-Za-z0-9]{10,}$/.test(k)) return 'test';
  if (/^(sk|rk)_live_[A-Za-z0-9]{10,}$/.test(k)) return 'live';
  return 'invalid';
}
function keyMode() { return modeOf(process.env.STRIPE_SECRET_KEY); }
function liveKeyMode() { return modeOf(process.env.STRIPE_SECRET_KEY_LIVE); }
function keyReady(live) { return live ? liveKeyMode() === 'live' : keyMode() === 'test'; }
const SECRET_RE = /^whsec_[A-Za-z0-9+/=]{16,}$/;
function webhookConfigured(live) {
  const t = SECRET_RE.test(process.env.STRIPE_WEBHOOK_SECRET || ''), l = SECRET_RE.test(process.env.STRIPE_WEBHOOK_SECRET_LIVE || '');
  return live === true ? l : live === false ? t : (t || l);
}

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
  if (!webhookConfigured() || !Buffer.isBuffer(raw)) return null;
  const { t, v1 } = parseHeader(header);
  if (t == null || !v1.length) return null;
  const now = Math.floor((nowMs == null ? Date.now() : nowMs) / 1000);
  if (Math.abs(now - t) > TOLERANCE_S) return null;
  let signedLive = null;
  for (const live of [false, true]) {
    if (!webhookConfigured(live)) continue;
    const secret = live ? process.env.STRIPE_WEBHOOK_SECRET_LIVE : process.env.STRIPE_WEBHOOK_SECRET;
    const expected = crypto.createHmac('sha256', secret).update(String(t) + '.').update(raw).digest();
    const ok = v1.some(sig => { const b = Buffer.from(sig, 'hex'); return b.length === expected.length && crypto.timingSafeEqual(b, expected); });
    if (ok) { signedLive = live; break; }
  }
  if (signedLive === null) return null;
  try {
    const ev = JSON.parse(raw.toString('utf8'));
    if (!ev || typeof ev !== 'object' || typeof ev.id !== 'string' || typeof ev.type !== 'string') return null;
    if ((ev.livemode === true) !== signedLive) return null;      // a sandbox-signed event can never claim to be live, nor the reverse
    return ev;
  } catch (e) { return null; }
}

/* Only the fields HCPS needs, per event type. Card data is never read or stored. */
function extract(ev) {
  const o = (ev.data && ev.data.object) || {};
  const s = v => (v == null ? null : String(v));
  const pi = v => (v && typeof v === 'object' ? s(v.id) : s(v));
  if (/^checkout\.session\./.test(ev.type)) {
    const td = o.total_details && typeof o.total_details === 'object' ? o.total_details : {};
    return { session_id: s(o.id), client_reference_id: s(o.client_reference_id), payment_status: s(o.payment_status),
             amount_total: o.amount_total == null ? null : String(o.amount_total),
             amount_subtotal: o.amount_subtotal == null ? null : String(o.amount_subtotal),
             amount_tax: td.amount_tax == null ? null : String(td.amount_tax),
             currency: s(o.currency), payment_intent: pi(o.payment_intent) };
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
  const live = p.live === true;
  if (!keyReady(live)) throw new StripeError(503, 'not_configured');
  const key = live ? process.env.STRIPE_SECRET_KEY_LIVE : process.env.STRIPE_SECRET_KEY;
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
                  tax_behavior: 'exclusive',   // tax (when Stripe Tax is on) is added ON TOP of the course price; never hidden inside it
                  product_data: { name: p.title, description: 'HCPS Academy course access (HCPS-issued training)' } } } },
    metadata: { purchase_id: p.purchase_id, version_id: p.version_id, source: 'hcps-academy' },
    payment_intent_data: { metadata: { purchase_id: p.purchase_id, source: 'hcps-academy' }, description: 'HCPS Academy: ' + p.title },
    automatic_tax: p.automatic_tax === true ? { enabled: 'true' } : null,
  }).join('&');
  let r;
  try {
    r = await fetch(`${API}/checkout/sessions`, { method: 'POST', body, headers: {
      authorization: 'Bearer ' + key, 'content-type': 'application/x-www-form-urlencoded',
      'idempotency-key': 'hcps-academy-' + p.purchase_id, 'stripe-version': '2024-06-20' } });
  } catch (e) { throw new StripeError(502, 'unreachable'); }
  let j = null; try { j = await r.json(); } catch (e) { j = null; }
  if (!r.ok || !j || typeof j.id !== 'string' || typeof j.url !== 'string') throw new StripeError(502, (j && j.error && j.error.type) || 'refused');
  if ((j.livemode === true) !== live) throw new StripeError(502, 'mode_mismatch');
  return { id: j.id, url: j.url, expires_at: new Date((j.expires_at || expiresAt) * 1000).toISOString(), livemode: j.livemode === true };
}

async function call(live, method, pathAndQuery, body) {
  if (!keyReady(live)) throw new StripeError(503, 'not_configured');
  const key = live ? process.env.STRIPE_SECRET_KEY_LIVE : process.env.STRIPE_SECRET_KEY;
  let r;
  try {
    r = await fetch(API + pathAndQuery, { method, body, headers: { authorization: 'Bearer ' + key, 'stripe-version': '2024-06-20',
      'content-type': 'application/x-www-form-urlencoded' } });
  } catch (e) { throw new StripeError(502, 'unreachable'); }
  let j = null; try { j = await r.json(); } catch (e) { j = null; }
  if (!r.ok || !j) throw new StripeError(r.status === 404 ? 404 : 502, (j && j.error && (j.error.code || j.error.type)) || 'refused');
  return j;
}
/* Close a checkout HCPS no longer honours (superseded by a new price or a new checkout), so it cannot be paid twice. */
async function expireSession(id, live) {
  if (!/^cs_(test|live)_[A-Za-z0-9_]{8,250}$/.test(String(id || '')) || id.startsWith('cs_live_') !== (live === true)) throw new StripeError(400, 'bad_session');
  return call(live === true, 'POST', `/checkout/sessions/${encodeURIComponent(id)}/expire`, '');
}
/* Completed Academy checkouts in Stripe since a time (for the reconciliation check). Only fields HCPS needs. */
async function completedSessions(live, sinceSec) {
  const out = []; let after = null;
  for (let page = 0; page < 5; page++) {
    const q = `?status=complete&limit=100&created[gte]=${Math.floor(sinceSec)}` + (after ? `&starting_after=${encodeURIComponent(after)}` : '');
    const j = await call(live === true, 'GET', '/checkout/sessions' + q);
    for (const o of j.data || []) {
      if (!o.metadata || o.metadata.source !== 'hcps-academy') continue;
      out.push({ session_id: String(o.id), purchase_id: o.client_reference_id || null, payment_status: o.payment_status || null,
                 amount_total: o.amount_total, created: o.created, email: (o.customer_details && o.customer_details.email) || o.customer_email || null });
    }
    if (!j.has_more || !(j.data || []).length) break;
    after = j.data[j.data.length - 1].id;
  }
  return out;
}

module.exports = { expireSession, completedSessions, keyMode, liveKeyMode, keyReady, webhookConfigured, verify, extract, createCheckoutSession, StripeError, parseHeader, TOLERANCE_S, _form: form };
