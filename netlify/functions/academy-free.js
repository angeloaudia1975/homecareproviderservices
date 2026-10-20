/* HCPS Academy — FREE launch access (Phase 2 / F1, issue #29). No payment, no card, no Stripe.
     GET  ?action=catalog  -> { enabled, courses:[{slug,title,note}] }   the published courses whose access is FREE
     POST {action:"register", course_slug, full_name, company, email}
          An outside dealership's learner gets an Academy account (outside organization, learner-only, never a CRM
          dealer). Registration grants NO course: the server then sends the Academy's own 6-digit sign-in code
          (the same envelope and timing as every sign-in), the learner signs in, and only then enrolls (academy-api
          enroll_free). The answer is the same whether the address is new or already has an account.
          -> 409 partner360 (one identity: open Training from Partner 360) · 403 staff / not_allowed · 404 not_free
          -> 429 limited · 403 flag_off (Academy sign-in off, or the pilot)
   Rules: POSTs only from the Academy's own pages (x-academy-request + allowed Origin); the course must be FREE in the
   database (academy_course_access); nothing here writes outside the audited F1 operation. */
const A = require('./_academy.js');
const L = require('./_academy_learner.js');

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REASONS = {
  partner360:  [409, 'This email belongs to an HCPS Partner 360 account. Open Training from Partner 360 — your free courses are there.'],
  staff:       [403, 'HCPS staff do not enroll as learners.'],
  not_allowed: [403, 'This email cannot use the HCPS Academy. Please contact HCPS.'],
  not_free:    [404, 'This course is not open for free enrollment.'],
  limited:     [429, 'Too many sign-ups from here. Please wait an hour and try again.'],
};

async function open() { return (await A.switchOn('academy_learner')) && !(await A.pilotMode()); }

exports.handler = A.handler(async event => {
  const m = event.httpMethod;
  if (m === 'GET') {
    const action = String(((event.queryStringParameters || {}).action) || 'catalog');
    if (action !== 'catalog') return A.respond(event, 405, { error: 'method', message: 'That needs a POST.' });
    if (!(await open())) return A.respond(event, 200, { enabled: false, courses: [] });
    let courses = [];
    try { courses = await A.freeOp('catalog', {}); } catch (e) { if (!(e && e.code === 'not_installed')) throw e; }
    return A.respond(event, 200, { enabled: true, courses: Array.isArray(courses) ? courses : [] });
  }
  if (m !== 'POST') return A.respond(event, 405, { error: 'method', message: 'Not allowed.' });
  if (!A.SESSION.sameSiteRequest(event, A.SITE_ORIGINS)) return A.respond(event, 403, { error: 'forbidden', message: 'Not allowed.' });
  const b = A.body(event, 8 * 1024);
  if (String(b.action || '') !== 'register') return A.respond(event, 404, { error: 'unknown_action', message: 'Unknown action.' });
  if (!(await open())) return A.respond(event, 403, { error: 'flag_off', message: 'The HCPS Academy is not open for sign-ups yet.' });
  if (!A.SESSION.configured()) return A.respond(event, 503, { error: 'not_configured', message: 'Sign-up is not available just now.' });
  const slug = A.text(b.course_slug, 120, 'Course');
  if (!/^[a-z0-9-]+$/.test(slug)) A.refuse(400, 'invalid', 'Course is not valid.');
  const email = A.text(b.email, 254, 'Email').toLowerCase();
  if (!EMAIL.test(email)) A.refuse(400, 'invalid', 'Please enter a valid email address.');
  const name = A.text(b.full_name, 120, 'Your name'), company = A.text(b.company, 160, 'Company');
  const ip = String(((event.headers || {})['x-nf-client-connection-ip']) || '').trim();
  const r = await A.freeOp('register', { p_email: email, p_full_name: name, p_company: company, p_course_slug: slug,
    p_ip_hash: A.SESSION.keyedHash('ip', /^[0-9A-Fa-f:.]{2,45}$/.test(ip) ? ip.toLowerCase() : 'unknown') });
  if (!r || !r.ok) {
    const [status, message] = REASONS[(r && r.reason) || ''] || [400, 'The sign-up could not be completed.'];
    return A.respond(event, status, { error: (r && r.reason) || 'refused', message });
  }
  // new or existing account: the same answer and the same sign-in email (M5's code request)
  return L.PUBLIC.request_code(event, { email });
});
exports._reasons = REASONS;
