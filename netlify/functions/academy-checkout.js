/* HCPS Academy — public course checkout (Phase 2). Outside dealerships buy course access through Stripe's hosted
   Checkout page; eligible HCPS network dealers never pay (they are sent to the Academy instead).
     GET  ?action=catalog            -> the courses on sale right now, with the DATABASE's price ({enabled:false} when off)
     POST {action:"start", course, email, name, organization}
                                     -> {url} of Stripe's payment page. The price, currency and course come from the
                                        database (academy_commerce_op_checkout_open); the browser's numbers are never read.
     POST {action:"status", session} -> {state: "granted" | "review" | "pending" | "unknown"} for the success page
                                        (no name, email or amount is ever returned).
   Gates: switch academy_payments exactly true; the Academy open to all (academy_open — never during the pilot); a Stripe
   key whose mode the course is on sale in (TEST mode: TEST courses only; LIVE: academy_payments_live + confirmed
   manufacturer rights). POSTs only from the Academy's own pages (x-academy-request + allowed Origin). */
const A = require('./_academy.js');
const C = require('./_academy_commerce.js');

const SLUG = /^[a-z0-9-]{1,80}$/;
const enc = encodeURIComponent;
const clientIp = event => { const v = String(((event && event.headers) || {})['x-nf-client-connection-ip'] || '').trim(); return /^[0-9A-Fa-f:.]{2,45}$/.test(v) ? v.toLowerCase() : 'unknown'; };
const email = v => { const s = String(v == null ? '' : v).trim().toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) || s.length > 254) A.refuse(400, 'invalid', 'Enter a valid email address.'); return s; };
const REASONS = {
  included: [409, 'Your dealership is in the HCPS dealer network, so this course is included at no charge. Sign in to the HCPS Academy with this email, or ask your Training Manager to enroll you.'],
  already_enrolled: [409, 'This email already has access to this course. Sign in to the HCPS Academy to continue.'],
  staff: [403, 'HCPS staff addresses cannot buy courses.'],
  review: [403, 'We need to review this purchase first. Please contact HCPS at info@homecareproviderservices.us.'],
  not_for_sale: [404, 'This course is not available for purchase.'],
  limited: [429, 'Too many checkout attempts. Wait an hour and try again.'],
};

async function salesContext() {
  if (!(await A.switchOn('academy_payments'))) return null;
  if (await A.pilotMode()) return null;                       // never during the pilot
  const sk = C.stripeKey(await A.switchOn('academy_payments_live'));
  return sk;                                                    // null = no usable key
}

async function catalog(sk) {
  const prices = await A.sbGet(`academy_course_prices?sale_mode=eq.${sk.mode}&select=course_id,price_cents,currency,network_included,public_note,rights_status`);
  if (!prices.length) return [];
  const courses = await A.sbGet(`academy_courses?id=in.(${prices.map(p => enc(p.course_id)).join(',')})&select=id,slug,title,course_type,status`);
  const versions = await A.sbGet(`academy_course_versions?course_id=in.(${prices.map(p => enc(p.course_id)).join(',')})&status=eq.published&select=course_id`);
  const live = new Set(versions.map(v => String(v.course_id)));
  return prices.map(p => {
    const c = courses.find(x => String(x.id) === String(p.course_id));
    if (!c || !live.has(String(c.id)) || p.price_cents < 50) return null;
    if (sk.mode === 'test' && !c.slug.startsWith('test-')) return null;
    if (sk.mode === 'live' && !['confirmed', 'not_required'].includes(p.rights_status)) return null;
    return { slug: c.slug, title: c.title, price_cents: p.price_cents, price: C.dollars(p.price_cents), currency: p.currency,
             network_included: p.network_included, note: p.public_note || null };
  }).filter(Boolean);
}

exports.handler = A.handler(async event => {
  const isGet = event.httpMethod === 'GET';
  if (!isGet && event.httpMethod !== 'POST') return A.respond(event, 405, { error: 'method', message: 'Not allowed.' });
  if (!A.SESSION.sameSiteRequest(event, A.SITE_ORIGINS)) return A.respond(event, 403, { error: 'forbidden', message: 'Not allowed.' });
  const b = isGet ? Object.assign({}, event.queryStringParameters || {}) : A.body(event, 8 * 1024);
  const action = String(b.action || 'catalog');
  if (isGet && action !== 'catalog') return A.respond(event, 405, { error: 'method', message: 'That needs a POST.' });

  if (action === 'status') {
    const s = String(b.session || '');
    if (!/^cs_(test|live)_[A-Za-z0-9]{8,240}$/.test(s)) return A.respond(event, 400, { error: 'invalid', message: 'That is not a checkout reference.' });
    const p = (await A.sbGet(`academy_purchases?stripe_session_id=eq.${enc(s)}&select=access`))[0];
    if (p) return A.respond(event, 200, { state: p.access === 'granted' ? 'granted' : 'review' });
    const co = (await A.sbGet(`academy_checkouts?stripe_session_id=eq.${enc(s)}&select=status`))[0];
    return A.respond(event, 200, { state: co ? 'pending' : 'unknown' });
  }

  const sk = await salesContext();
  if (!sk) return A.respond(event, isGet ? 200 : 403, isGet ? { enabled: false, courses: [] } : { error: 'flag_off', message: 'Course purchases are not open yet.' });
  if (action === 'catalog') return A.respond(event, 200, { enabled: true, mode: sk.mode, courses: await catalog(sk) });
  if (action !== 'start') return A.respond(event, 404, { error: 'unknown_action', message: 'Unknown action.' });

  if (!A.SESSION.configured()) A.refuse(503, 'unavailable', 'Checkout is not available just now.');
  const slug = String(b.course || ''); if (!SLUG.test(slug)) A.refuse(400, 'invalid', 'Choose a course.');
  const course = (await A.sbGet(`academy_courses?slug=eq.${enc(slug)}&select=id,title`))[0];
  if (!course) A.refuse(404, 'not_for_sale', REASONS.not_for_sale[1]);
  const r = await A.commerceOp('checkout_open', { p_email: email(b.email), p_name: A.text(b.name, 120, 'Your name'),
    p_org: A.text(b.organization, 160, 'Company name'), p_course_id: course.id, p_mode: sk.mode,
    p_ip_hash: A.SESSION.keyedHash('ip', clientIp(event)) });
  if (!r || r.ok !== true) { const [st, msg] = REASONS[(r && r.reason)] || [400, 'This purchase cannot be started.']; return A.respond(event, st, { error: (r && r.reason) || 'refused', message: msg }); }
  const co = r.checkout;
  const origin = A.SITE_ORIGINS[1];   // the primary domain (www): Stripe sends the buyer back there
  try {
    if (co.stripe_session_id) {
      const s = await C.retrieveCheckoutSession(sk, co.stripe_session_id);
      if (s.status === 'open' && s.url) return A.respond(event, 200, { ok: true, url: s.url });
      A.refuse(409, 'checkout_closed', 'That checkout has closed. Start again in a few minutes.');
    }
    const s = await C.createCheckoutSession(sk, co, course.title, origin);
    await A.commerceOp('checkout_attach', { p_checkout_id: co.id, p_session_id: s.id });
    return A.respond(event, 200, { ok: true, url: s.url });
  } catch (e) {
    if (e instanceof C.StripeError) { console.error('[academy-checkout] stripe', e.status, e.type); A.refuse(502, 'payment_unavailable', 'The payment page could not be opened. Nothing was charged. Try again shortly.'); }
    throw e;
  }
});
exports._reasons = REASONS;
