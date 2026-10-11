/* HCPS Academy — Connect 360 admin API (A2A shell). Staff only: the Connect 360 sign-in (bearer token -> an active
   staff_users row). A learner's Academy session is never accepted here.
     POST {action:"whoami"} -> who you are to the Academy, the switch states, and what you may do.
   Every other action arrives with A2C and stays refused (403 flag_off) while the academy_admin switch is off. */
const A = require('./_academy.js');
const ACTIONS = {};   // A2C adds its actions here; each is checked against the switch and the caller's role.

exports.handler = A.handler(async event => {
  const staff = await A.staffActor(event);
  if (!staff) return A.respond(event, 401, { error: 'unauthorized', message: 'Please sign in to Connect 360.' });
  const b = event.httpMethod === 'GET' ? Object.assign({}, event.queryStringParameters || {}) : A.body(event);
  const action = String(b.action || 'whoami');
  if (action === 'whoami') {
    const sw = await A.switches();
    return A.respond(event, 200, {
      ok: true, email: staff.email, role: staff.role, enabled: sw.academy_admin, switches: sw,
      may: { administer: A.isAdmin(staff), see_scores: A.isAdmin(staff), dealer_scope: A.isAdmin(staff) || A.isRelations(staff) ? 'all' : 'own_book' },
    });
  }
  if (!(await A.switchOn('academy_admin'))) return A.respond(event, 403, { error: 'flag_off', message: 'The Academy Command Center is switched off.' });
  const fn = ACTIONS[action];
  if (!fn) return A.respond(event, 404, { error: 'unknown_action', message: 'Unknown action.' });
  return fn(event, staff, b);
});
exports._actions = ACTIONS;
