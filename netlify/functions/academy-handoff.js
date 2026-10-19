/* HCPS Academy — Partner 360 entry (A2B). A dealer signed in to Partner 360 opens Training:
     GET/POST {action:"status"}  -> {enabled}   (Partner 360 shows its Training button only when enabled)
     POST {action:"mint"} + Authorization: Bearer <the dealer's Partner 360 login>
                                 -> {url}       a single-use, 60-second code, carried in the URL FRAGMENT (never sent to a
                                                server or in a Referer) to the Academy's own page, which redeems it with
                                                academy-api handoff_redeem and receives the Academy's own session.
   The code is 32 random bytes; only its keyed hash is stored (M5 academy_access_op_handoff_mint). The Partner 360 token
   is only READ here to learn who is signed in; it is never stored, forwarded or exchanged for anything that orders or
   prices. Off (403 flag_off) unless both academy_learner and academy_handoff are on. */
const crypto = require('crypto');
const A = require('./_academy.js');
const OPTS = { origins: A.SITE_ORIGINS.concat(A.PARTNER360_ORIGINS) };
const ENTRY = 'https://www.homecareproviderservices.org/academy/#handoff=';

/* Is the Partner 360 login behind this request an approved user of a TEST dealership? (pilot gate) */
async function testLogin(event, known) {
  const u = known || await A.bearerUser(event); if (!u || !u.id) return false;
  const du = await A.sbGet(`dealer_users?uid=eq.${encodeURIComponent(u.id)}&status=eq.approved&select=dealer_id&limit=1`);
  return !!du[0] && (await A.testDealerIds([du[0].dealer_id])).has(String(du[0].dealer_id));
}

exports.handler = A.handler(async event => {
  const isGet = event.httpMethod === 'GET';
  const b = isGet ? Object.assign({}, event.queryStringParameters || {}) : A.body(event);
  const on = (await A.switchOn('academy_learner')) && (await A.switchOn('academy_handoff'));
  if (String(b.action || 'status') === 'status') {
    // PILOT GATE: during the pilot the Training button shows only for a signed-in login of a TEST dealership
    if (on && await A.pilotMode()) return A.respond(event, 200, { enabled: await testLogin(event) }, OPTS);
    return A.respond(event, 200, { enabled: on }, OPTS);
  }
  if (!on) return A.respond(event, 403, { error: 'flag_off', message: 'Academy entry from Partner 360 is not available yet.' }, OPTS);
  if (String(b.action) !== 'mint') return A.respond(event, 404, { error: 'unknown_action', message: 'Unknown action.' }, OPTS);
  if (isGet) return A.respond(event, 405, { error: 'method', message: 'That needs a POST.' }, OPTS);
  const origin = String((event.headers || {}).origin || (event.headers || {}).Origin || '').toLowerCase();
  if (!A.PARTNER360_ORIGINS.includes(origin)) return A.respond(event, 403, { error: 'forbidden', message: 'Not allowed.' }, OPTS);
  if (!A.SESSION.configured()) return A.respond(event, 503, { error: 'session_unavailable', message: 'Academy sign-in is not available just now.' }, OPTS);
  const u = await A.bearerUser(event);
  if (!u || !u.id) return A.respond(event, 401, { error: 'unauthorized', message: 'Please sign in to Partner 360 first.' }, OPTS);
  // PILOT GATE: during the pilot only a login of a TEST dealership gets a Training link
  if (await A.pilotMode() && !(await testLogin(event, u)))
    return A.respond(event, 403, { error: 'pilot_only', message: 'HCPS Academy training is not open for your dealership yet.' }, OPTS);
  const code = crypto.randomBytes(32).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await A.accessOp('access_op_handoff_mint', { p_auth_user_id: u.id, p_code_hash: A.SESSION.keyedHash('handoff', code) });
  return A.respond(event, 200, { ok: true, url: ENTRY + code, expires_in: 60 }, OPTS);
}, OPTS);
