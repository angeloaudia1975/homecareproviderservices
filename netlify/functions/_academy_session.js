/* HCPS Academy — learner session (A2A). The Academy's OWN session, separate from every other HCPS login.

   Why not a Supabase session (security review, 10 Oct 2026): a Supabase access/refresh token for a dealer login also
   works on Partner 360 (ordering, pricing). Handing one to the Academy pages would put an ordering-capable credential
   on the marketing site's origin. The Academy session instead is:
     - a signed, short-lived value (HMAC-SHA256, 8 hours) naming ONE learner and ONE server-side session row
       (A2B / M5: academy_sessions; ending the row ends the session on the next request, whatever the cookie says);
     - kept in an HttpOnly, Secure, SameSite=Strict cookie with the __Host- prefix, so page scripts can't read it,
       other sites can't send it, and it can't be scoped to another host or path;
     - accepted ONLY by the Academy's learner API. Ordering, pricing, Partner 360 and Connect 360 never read it.
   Every request re-checks the learner and membership in the database, so closing a learner ends their access at
   once. Rotating ACADEMY_SESSION_SECRET (Netlify env, set by Angelo, never seen by Claude) signs everyone out.
   No secret set = no learner sessions at all (fail closed). */
const crypto = require('crypto');

const COOKIE = '__Host-hcps_academy';
const TTL_SECONDS = 8 * 60 * 60;
const MIN_SECRET = 32;
const CONTEXT = 'hcps-academy-session.v2.';   // binds a signature to this purpose only (v2: names a session row)

function secret() {
  const s = process.env.ACADEMY_SESSION_SECRET || '';
  return s.length >= MIN_SECRET ? s : null;
}
const b64u = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const sign = (key, payload) => b64u(crypto.createHmac('sha256', key).update(CONTEXT + payload).digest());

/* A new session value for one learner + one session row (academy_sessions). Returns null when no secret is configured. */
function issue(learnerId, sessionId, now) {
  const key = secret(); if (!key) return null;
  if (!learnerId || !sessionId) throw new Error('issue: learner and session are required');
  const t = Math.floor((now || Date.now()) / 1000);
  const payload = b64u(JSON.stringify({ v: 2, sub: String(learnerId), sid: String(sessionId), iat: t, exp: t + TTL_SECONDS,
                                        jti: b64u(crypto.randomBytes(12)) }));
  return payload + '.' + sign(key, payload);
}

/* The claims of a valid session value, or null. Never throws. */
function verify(value, now) {
  try {
    const key = secret(); if (!key || !value || typeof value !== 'string' || value.length > 2048) return null;
    const dot = value.indexOf('.'); if (dot < 1 || dot !== value.lastIndexOf('.')) return null;
    const payload = value.slice(0, dot), sig = value.slice(dot + 1);
    const want = Buffer.from(sign(key, payload)), got = Buffer.from(sig);
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
    const c = JSON.parse(unb64u(payload).toString('utf8'));
    const t = Math.floor((now || Date.now()) / 1000);
    if (!c || c.v !== 2 || typeof c.sub !== 'string' || typeof c.sid !== 'string') return null;
    if (!(c.exp > t) || !(c.iat <= t + 60) || c.exp - c.iat > TTL_SECONDS) return null;
    return { learner_id: c.sub, session_id: c.sid, iat: c.iat, exp: c.exp };
  } catch (e) { return null; }
}

function readCookie(event) {
  const h = (event && event.headers) || {};
  const raw = h.cookie || h.Cookie || '';
  for (const part of String(raw).split(';')) {
    const i = part.indexOf('='); if (i < 0) continue;
    if (part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
  }
  return null;
}
const setCookie = value => `${COOKIE}=${value}; Path=/; Max-Age=${TTL_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
const clearCookie = () => `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;

/* Cross-site request check for cookie-authenticated calls. A state-changing request must carry the Academy's own
   header (which a form on another site cannot send, and a script on another site cannot send without a CORS
   approval the Academy never gives) AND an Origin from the allow-list. Reads (GET/HEAD) carry no side effects. */
function sameSiteRequest(event, allowedOrigins) {
  const m = String((event && event.httpMethod) || 'GET').toUpperCase();
  if (m === 'GET' || m === 'HEAD') return true;
  const h = (event && event.headers) || {};
  const marker = h['x-academy-request'] || h['X-Academy-Request'];
  const origin = h.origin || h.Origin;
  return marker === '1' && !!origin && allowedOrigins.includes(String(origin).toLowerCase());
}

/* Keyed hashes for what the database keeps instead of secrets: sign-in codes, handoff codes and network addresses.
   Keyed with the session secret (a 6-digit code's plain SHA-256 could be reversed by trying all million codes). */
function keyedHash(purpose, value) {
  const key = secret(); if (!key) throw new Error('no session secret');
  return crypto.createHmac('sha256', key).update('hcps-academy.' + purpose + '.' + String(value)).digest('hex');
}

/* Sealed mail jobs (A2B security review S1). The sign-in action hands every request — a real code or a decoy — to the
   mail worker in the same sealed, fixed-length envelope (AES-256-GCM, key derived from ACADEMY_SESSION_SECRET), so the
   answer takes the same path whether or not the address is known, and the code is never readable in transit or logs. */
const JOB_LEN = 640;
const jobKey = key => crypto.createHmac('sha256', key).update('hcps-academy-mail-key.v1').digest();
function sealJob(job, now) {
  const key = secret(); if (!key) return null;
  const body = JSON.stringify(Object.assign({}, job, { iat: Math.floor((now || Date.now()) / 1000) }));
  if (body.length > JOB_LEN) throw new Error('sealJob: job too long');
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', jobKey(key), iv);
  const ct = Buffer.concat([c.update(body.padEnd(JOB_LEN, ' '), 'utf8'), c.final()]);
  return b64u(Buffer.concat([iv, ct, c.getAuthTag()]));
}
/* The job, or null if it was not sealed with this secret, was changed, or is older than maxAge seconds. Never throws. */
function openJob(value, maxAge, now) {
  try {
    const key = secret(); if (!key || typeof value !== 'string' || value.length > 2048) return null;
    const raw = unb64u(value); if (raw.length !== 12 + JOB_LEN + 16) return null;
    const d = crypto.createDecipheriv('aes-256-gcm', jobKey(key), raw.subarray(0, 12)); d.setAuthTag(raw.subarray(raw.length - 16));
    const job = JSON.parse(Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString('utf8').trim());
    const t = Math.floor((now || Date.now()) / 1000);
    if (!job || typeof job.iat !== 'number' || job.iat > t + 60 || t - job.iat > (maxAge || 120)) return null;
    return job;
  } catch (e) { return null; }
}

module.exports = { COOKIE, TTL_SECONDS, configured: () => !!secret(), issue, verify, readCookie, setCookie, clearCookie, sameSiteRequest, keyedHash, sealJob, openJob, JOB_LEN };
