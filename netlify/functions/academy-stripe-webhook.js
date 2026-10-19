/* HCPS Academy — Stripe webhook (Phase 2 / M8). SANDBOX ONLY.
   Stripe → POST /.netlify/functions/academy-stripe-webhook (endpoint configured in the Stripe Sandbox Workbench).
   Events handled (the endpoint subscribes to exactly these):
     checkout.session.completed · checkout.session.async_payment_succeeded · checkout.session.async_payment_failed ·
     checkout.session.expired · charge.refunded · charge.dispute.created · charge.dispute.closed
   Rules:
     - The exact raw body is verified against the Stripe-Signature header with STRIPE_WEBHOOK_SECRET (HMAC-SHA256,
       timing-safe, 5-minute tolerance). Anything unsigned, mis-signed or stale gets 400 and changes nothing.
     - Only fields HCPS needs are passed on (_stripe.js extract); card data is never read or stored.
     - ONE audited database call decides: academy_purchase_op_stripe_event. Each event id is processed once; a replayed
       or duplicated delivery grants nothing twice; amount, currency, purchase id and session id must match the checkout.
     - Live-mode events are recorded and refused (never grant access).
     - This endpoint does NOT depend on the academy_payments sales switch: refunds and disputes must still be recorded
       after sales are switched off. A database error answers 5xx so Stripe retries.
     - Nothing secret is ever logged or returned. */
const A = require('./_academy.js');
const STRIPE = require('./_stripe.js');

const HANDLED = new Set(['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed',
  'checkout.session.expired', 'charge.refunded', 'charge.dispute.created', 'charge.dispute.closed']);
const MAX = 512 * 1024;
const plain = (status, payload) => ({ statusCode: status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(payload) });

exports.handler = A.handler(async event => {
  if (event.httpMethod !== 'POST') return plain(405, { error: 'method' });
  if (!STRIPE.webhookConfigured()) return plain(503, { error: 'not_configured' });
  const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64') : Buffer.from(event.body || '', 'utf8');
  if (!raw.length || raw.length > MAX) return plain(400, { error: 'invalid' });
  const h = event.headers || {};
  const ev = STRIPE.verify(raw, h['stripe-signature'] || h['Stripe-Signature']);
  if (!ev) return plain(400, { error: 'signature' });
  if (!HANDLED.has(ev.type)) return plain(200, { received: true, outcome: 'not_subscribed' });
  if (!/^evt_[A-Za-z0-9_]{1,250}$/.test(ev.id)) return plain(400, { error: 'invalid' });
  const r = await A.purchaseOp('stripe_event', { p_event_id: ev.id, p_type: ev.type, p_livemode: ev.livemode === true, p_data: STRIPE.extract(ev) });
  return plain(200, { received: true, outcome: (r && r.outcome) || 'recorded' });
});
exports._handled = HANDLED;
