/* HCPS Academy — Stripe webhook (Phase 2). The ONLY way a purchase grants course access.
     1. The Stripe-Signature header must verify over the RAW request body with STRIPE_WEBHOOK_SECRET, within 5 minutes.
        Anything unsigned, mis-signed, stale or unreadable: 400, nothing recorded, nothing granted.
     2. The event's mode (livemode) must equal the mode of the server's Stripe key; LIVE events are refused unless the
        academy_payments_live switch is exactly true.
     3. Each handled event goes to ONE audited database operation that is idempotent on the Stripe event id (and, for a
        payment, on the Checkout Session id): a replayed or duplicated event never grants or refunds twice.
   Handled: checkout.session.completed (payment_status paid) · checkout.session.async_payment_succeeded ·
            checkout.session.expired · charge.refunded · charge.dispute.created. Anything else: 200, ignored.
   It does NOT depend on the academy_payments switch: once Stripe has taken money, access must follow even if sales
   were switched off a moment later. Nothing secret is logged or returned. */
const A = require('./_academy.js');
const C = require('./_academy_commerce.js');

const ID = { evt: /^evt_[A-Za-z0-9]{8,240}$/, cs: /^cs_(test|live)_[A-Za-z0-9]{8,240}$/, pi: /^pi_[A-Za-z0-9]{8,240}$/ };
const plain = (status, body) => ({ statusCode: status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }, body: JSON.stringify(body) });

async function handle(event) {
  if (event.httpMethod !== 'POST') return plain(405, { error: 'method' });
  const secret = C.webhookSecret();
  if (!secret) return plain(503, { error: 'not_configured' });
  const raw = event.isBase64Encoded ? Buffer.from(String(event.body || ''), 'base64').toString('utf8') : String(event.body || '');
  if (!raw || Buffer.byteLength(raw) > 512 * 1024) return plain(400, { error: 'invalid' });
  const h = event.headers || {};
  if (!C.verifySignature(raw, h['stripe-signature'] || h['Stripe-Signature'], secret)) return plain(400, { error: 'bad_signature' });
  let ev; try { ev = JSON.parse(raw); } catch (e) { return plain(400, { error: 'invalid' }); }
  if (!ev || typeof ev !== 'object' || !ID.evt.test(String(ev.id || '')) || typeof ev.type !== 'string') return plain(400, { error: 'invalid' });
  const mode = ev.livemode === true ? 'live' : ev.livemode === false ? 'test' : null;
  if (!mode) return plain(400, { error: 'invalid' });
  const liveAllowed = await A.switchOn('academy_payments_live');
  const sk = C.stripeKey(liveAllowed);
  if (!sk || sk.mode !== mode) return plain(400, { error: 'wrong_mode' });   // a live event to a test setup (or the reverse)
  const o = (ev.data && ev.data.object) || {};
  switch (ev.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      if (!ID.cs.test(String(o.id || ''))) return plain(400, { error: 'invalid' });
      if (o.payment_status !== 'paid') return plain(200, { ok: true, waiting: 'payment' });   // async payment: wait for its success event
      const pi = typeof o.payment_intent === 'string' && ID.pi.test(o.payment_intent) ? o.payment_intent : null;
      const r = await A.commerceOp('grant', { p_event_id: ev.id, p_mode: mode, p_session_id: o.id, p_payment_intent: pi,
        p_amount_cents: Number.isInteger(o.amount_total) ? o.amount_total : -1, p_currency: String(o.currency || '') });
      if (!r || r.ok !== true) console.warn('[academy-stripe] payment not granted:', r && r.reason);   // reason only; never a card or email
      return plain(200, { ok: true });
    }
    case 'checkout.session.expired':
      if (!ID.cs.test(String(o.id || ''))) return plain(400, { error: 'invalid' });
      await A.commerceOp('checkout_expired', { p_event_id: ev.id, p_mode: mode, p_session_id: o.id });
      return plain(200, { ok: true });
    case 'charge.refunded':
      if (!ID.pi.test(String(o.payment_intent || '')) || !Number.isInteger(o.amount_refunded)) return plain(400, { error: 'invalid' });
      await A.commerceOp('refund_record', { p_event_id: ev.id, p_mode: mode, p_payment_intent: o.payment_intent, p_refunded_total: o.amount_refunded });
      return plain(200, { ok: true });
    case 'charge.dispute.created':
      if (!ID.pi.test(String(o.payment_intent || ''))) return plain(400, { error: 'invalid' });
      await A.commerceOp('dispute', { p_event_id: ev.id, p_mode: mode, p_payment_intent: o.payment_intent });
      return plain(200, { ok: true });
    default:
      return plain(200, { ok: true, ignored: true });
  }
}

exports.handler = async event => {
  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE) return plain(503, { error: 'unavailable' });
    return await handle(event);
  } catch (e) {
    // a database or network failure: 5xx so Stripe retries (the operations are idempotent, a retry is safe)
    // the database refused the event for good (4xx): record nothing more, answer 200 so Stripe stops retrying
    if (e instanceof A.AcademyError && e.status < 500) { console.warn('[academy-stripe] event refused:', e.code); return plain(200, { ok: false }); }
    // a database or network failure: 5xx so Stripe retries (the operations are idempotent, a retry is safe)
    console.error('[academy-stripe] webhook failed', e && (e.code || e.name));
    return plain(503, { error: 'retry' });
  }
};
