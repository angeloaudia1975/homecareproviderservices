/* HCPS Academy — public certificate verification (A2F / M7).
     GET ?n=HCPS-XXXX-XXXX  -> {enabled, found, cert_number, learner_name, dealer_name, course_title, issued_at, expires_at,
                               status valid|expired|revoked, revoked_at, issuer, disclosure}
   Anyone holding a certificate number may check it (an employer, a customer). It shows only what the certificate
   itself prints — never an email, a score, an attempt or a revocation reason — and reads through the database function
   academy_cert_op_verify (server role only; M7). Off (enabled:false) until academy_certificates is on. Read only:
   GET only, no cookie, no session; the number space (32^8) makes guessing impractical. */
const A = require('./_academy.js');
const DISCLOSURE = 'Issued by Home Care Provider Services (HCPS). This is an HCPS sales certification; it is not issued or endorsed by Golden Technologies.';
const SHAPE = /^HCPS-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

exports.handler = A.handler(async event => {
  if (event.httpMethod !== 'GET') return A.respond(event, 405, { error: 'method', message: 'Use GET.' });
  if (!(await A.switchOn('academy_certificates'))) return A.respond(event, 200, { enabled: false, message: 'Certificate verification is not open yet.' });
  const n = String((event.queryStringParameters || {}).n || '').trim().toUpperCase().slice(0, 40);
  if (!SHAPE.test(n)) return A.respond(event, 400, { enabled: true, found: false, error: 'format', message: 'A certificate number looks like HCPS-ABCD-2345.' });
  const r = await A.accessOp('cert_op_verify', { p_number: n });
  if (!r || !r.found) return A.respond(event, 404, { enabled: true, found: false, error: 'not_found', message: 'No HCPS certificate has that number.' });
  return A.respond(event, 200, { enabled: true, found: true, cert_number: r.cert_number, learner_name: r.learner_name, dealer_name: r.dealer_name,
    course_title: r.course_title, issued_at: r.issued_at, expires_at: r.expires_at, status: r.status, revoked_at: r.revoked_at || null,
    issuer: r.issuer, disclosure: DISCLOSURE });
});
