/* HCPS Academy — learner API (A2A shell). Learners and Dealer Training Managers only, signed in with the Academy's
   own session cookie (_academy_session.js). Connect 360 and Partner 360 tokens are never accepted here.
     GET or POST {action:"me"} -> your learner record and active memberships.
   Refused with 403 flag_off while the academy_learner switch is off. State-changing calls must come from the
   Academy's own pages (x-academy-request header + an allowed Origin). Whose records are read always comes from the
   session, never from the request. A2B and A2E add their actions here. */
const A = require('./_academy.js');
const ACTIONS = {};
// GET may only READ. Every action that changes anything is POST, so it always passes the cross-site check (security
// review 10 Oct 2026, finding C1). A2B/A2E add read actions here only if they change nothing.
const READ_ACTIONS = new Set(['me']);

exports.handler = A.handler(async event => {
  if (!(await A.switchOn('academy_learner'))) return A.respond(event, 403, { error: 'flag_off', message: 'The HCPS Academy is not open yet.' });
  if (!A.SESSION.sameSiteRequest(event, A.SITE_ORIGINS)) return A.respond(event, 403, { error: 'forbidden', message: 'Not allowed.' });
  const isGet = event.httpMethod === 'GET';
  if (!isGet && event.httpMethod !== 'POST') return A.respond(event, 405, { error: 'method', message: 'Not allowed.' });
  const b = isGet ? Object.assign({}, event.queryStringParameters || {}) : A.body(event);
  if (isGet && !READ_ACTIONS.has(String(b.action || 'me'))) return A.respond(event, 405, { error: 'method', message: 'That needs a POST.' });
  const learner = await A.learnerActor(event);
  if (!learner) return A.respond(event, 401, { error: 'unauthorized', message: 'Please sign in to the HCPS Academy.' },
                                 A.SESSION.readCookie(event) ? { cookie: A.SESSION.clearCookie() } : undefined);
  const action = String(b.action || 'me');
  if (action === 'me') {
    return A.respond(event, 200, {
      ok: true, learner: { id: learner.learner_id, full_name: learner.full_name, email: learner.email },
      memberships: learner.memberships.map(m => ({ id: m.id, dealer_id: m.dealer_id, role: m.role, access_type: m.access_type })),
    });
  }
  const fn = ACTIONS[action];
  if (!fn) return A.respond(event, 404, { error: 'unknown_action', message: 'Unknown action.' });
  return fn(event, learner, b);
});
exports._actions = ACTIONS;
exports._readActions = READ_ACTIONS;
