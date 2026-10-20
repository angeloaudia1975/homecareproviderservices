/* HCPS Academy — paid course access for OUTSIDE dealerships (Phase 2 / M8 sandbox, M9 live).
     GET  ?action=catalog  -> { enabled, test_mode, courses:[{slug,title,price_cents,currency}] }   (public, read only)
     POST {action:"start", course_slug, full_name, company, email}
          -> { ok:true, url }  the Stripe-hosted payment page (card data never touches HCPS)
          -> 409 included / already_enrolled · 404 not_for_sale · 403 staff / not_allowed · 429 limited · 503 not set up
   Rules (docs/academy/P2_M8_PAYMENTS.md):
     - Off unless the academy_payments switch is exactly true AND the key of the current mode is ready. The mode is the
       academy_payments_live switch (exactly true = live, STRIPE_SECRET_KEY_LIVE; otherwise sandbox, STRIPE_SECRET_KEY);
       the database stamps each purchase with it and the Stripe session must come back in the same mode.
     - The price comes from the database (academy_prices), never from the browser.
     - HCPS network dealers are never charged: an address that belongs to an eligible dealership is told it is included.
     - Opening a checkout NEVER grants access. Only the signature-verified Stripe webhook does (academy-stripe-webhook.js).
     - One open checkout per buyer + course is reused; Stripe's idempotency key is the HCPS purchase id.
     - A course from a manufacturer (Golden) is never on sale until the President records the manufacturer's confirmed
       commercial-use permission (enforced in the database). */
const A = require('./_academy.js');
const STRIPE = require('./_stripe.js');
const OPS = require('./_academy_stripe_ops.js');

const CANON = 'https://www.homecareproviderservices.org';
const clientIp = event => {
  const v = String(((event && event.headers) || {})['x-nf-client-connection-ip'] || '').trim();
  return /^[0-9A-Fa-f:.]{2,45}$/.test(v) ? v.toLowerCase() : 'unknown';
};
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/* A SANDBOX (test-card) purchase grants a real enrollment, so sandbox checkout is open only to HCPS's own test
   mailboxes (security review 2026-10-20). Real buyers can buy only in live mode. */
const SANDBOX_DEFAULT = /^angelo\+academy-[a-z0-9-]{1,40}@homecareproviderservices\.us$/;
function sandboxBuyer(email) {
  const own = process.env.ACADEMY_SANDBOX_BUYER_RE;       // test suites only; unset in production
  let re = SANDBOX_DEFAULT; if (own) { try { re = new RegExp(own); } catch (e) { re = SANDBOX_DEFAULT; } }
  return re.test(email);
}
const REASONS = {
  included:         [409, 'Your dealership is part of the HCPS network, so this course is included at no charge. Sign in to the HCPS Academy with this email, or ask HCPS to add you.'],
  already_enrolled: [409, 'You already have this course. Sign in to the HCPS Academy to continue.'],
  not_for_sale:     [404, 'This course is not available for purchase.'],
  staff:            [403, 'HCPS staff do not purchase Academy courses.'],
  not_allowed:      [403, 'This email cannot purchase Academy courses. Please contact HCPS.'],
  limited:          [429, 'Too many checkout attempts. Please wait a few minutes and try again.'],
};

async function liveMode() { return A.switchOn('academy_payments_live'); }
async function enabled(live) {
  return (await A.switchOn('academy_payments')) && STRIPE.keyReady(live) && STRIPE.webhookConfigured(live) && !(await A.pilotMode());
}

async function catalog(event) {
  const live = await liveMode();
  if (!(await enabled(live))) return A.respond(event, 200, { enabled: false, test_mode: !live, courses: [] });
  const courses = await A.purchaseOp('catalog', {});
  return A.respond(event, 200, { enabled: true, test_mode: !live, tax_added: await A.switchOn('academy_payments_tax'), courses: Array.isArray(courses) ? courses : [] });
}

async function start(event) {
  if (!A.SESSION.sameSiteRequest(event, A.SITE_ORIGINS)) return A.respond(event, 403, { error: 'forbidden', message: 'Not allowed.' });
  if (!(await A.switchOn('academy_payments'))) return A.respond(event, 403, { error: 'flag_off', message: 'Paid course access is not open yet.' });
  if (await A.pilotMode()) return A.respond(event, 403, { error: 'pilot_only', message: 'Paid course access is not open yet.' });   // outside buyers could not sign in
  if (!STRIPE.keyReady(await liveMode()) || !STRIPE.webhookConfigured(await liveMode())) return A.respond(event, 503, { error: 'not_configured', message: 'Payments are not available just now.' });
  if (!A.SESSION.configured()) return A.respond(event, 503, { error: 'not_configured', message: 'Payments are not available just now.' });
  const b = A.body(event, 8 * 1024);
  const slug = A.text(b.course_slug, 120, 'Course');
  if (!/^[a-z0-9-]+$/.test(slug)) A.refuse(400, 'invalid', 'Course is not valid.');
  const email = A.text(b.email, 254, 'Email').toLowerCase();
  if (!EMAIL.test(email)) A.refuse(400, 'invalid', 'Please enter a valid email address.');
  const name = A.text(b.full_name, 120, 'Your name'), company = A.text(b.company, 160, 'Company');
  if (!(await liveMode()) && !sandboxBuyer(email)) {
    return A.respond(event, 403, { error: 'sandbox_test_only', message: 'Paid course access is not open yet. Please contact HCPS.' });
  }
  const r = await A.purchaseOp('open', { p_email: email, p_full_name: name, p_company: company, p_course_slug: slug,
                                         p_ip_hash: A.SESSION.keyedHash('ip', clientIp(event)) });
  if (!r || !r.ok) {
    const [status, message] = REASONS[(r && r.reason) || ''] || [400, 'This purchase could not be started.'];
    return A.respond(event, status, { error: (r && r.reason) || 'refused', message });
  }
  if (r.reuse) return A.respond(event, 200, { ok: true, url: r.url, reused: true });
  const live = r.livemode === true;                          // the database decided the mode when it opened the purchase
  const origin = String((event.headers || {}).origin || '').toLowerCase();
  const base = A.SITE_ORIGINS.includes(origin) && origin.startsWith('https://www.') ? origin : CANON;
  let s;
  try {
    s = await STRIPE.createCheckoutSession({ live, automatic_tax: await A.switchOn('academy_payments_tax'), purchase_id: r.purchase_id, version_id: r.version_id, email: r.email,
      title: r.course_title, amount_cents: r.amount_cents, currency: r.currency,
      success_url: `${base}/academy/buy/?paid=1&session_id={CHECKOUT_SESSION_ID}`, cancel_url: `${base}/academy/buy/?cancelled=1` });
  } catch (e) {
    await A.purchaseOp('abandon', { p_purchase_id: r.purchase_id, p_reason: 'stripe ' + ((e && e.code) || 'error') }).catch(() => null);
    return A.respond(event, 502, { error: 'checkout_unavailable', message: 'The payment page could not be opened. Nothing was charged. Please try again.' });
  }
  if (s.livemode !== live) {
    await A.purchaseOp('abandon', { p_purchase_id: r.purchase_id, p_reason: 'stripe mode mismatch' }).catch(() => null);
    return A.respond(event, 503, { error: 'not_configured', message: 'Payments are not available just now.' });
  }
  await A.purchaseOp('attach', { p_purchase_id: r.purchase_id, p_session_id: s.id, p_url: s.url, p_expires_at: s.expires_at, p_livemode: live });
  await OPS.expireStale(5);       // the buyer's previous checkout (now superseded) can no longer be paid at Stripe
  return A.respond(event, 200, { ok: true, url: s.url });
}

exports.handler = A.handler(async event => {
  const m = event.httpMethod;
  if (m === 'GET') {
    const action = String(((event.queryStringParameters || {}).action) || 'catalog');
    if (action !== 'catalog') return A.respond(event, 405, { error: 'method', message: 'That needs a POST.' });
    return catalog(event);
  }
  if (m !== 'POST') return A.respond(event, 405, { error: 'method', message: 'Not allowed.' });
  const action = String((A.body(event, 8 * 1024) || {}).action || '');
  if (action !== 'start') return A.respond(event, 404, { error: 'unknown_action', message: 'Unknown action.' });
  return start(event);
});
