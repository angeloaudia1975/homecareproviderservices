/* HCPS Academy — learner API. Learners and Dealer Training Managers only, signed in with the Academy's own session
   cookie (_academy_session.js + academy_sessions, A2B / M5). Connect 360 and Partner 360 tokens are never accepted here.
     PUBLIC   request_code · verify_code · handoff_redeem      (POST; they open a session)
     LEARNER  me · my_courses · my_certificates · free_courses · enroll_free · manufacturer_programs · program · program_step · program_certificate · claim_certificate · lesson · practice_check · save_progress · sign_out
     EXAM (A2E, switch academy_exams)  exam_status · exam_start · exam_view · exam_save · exam_submit
     TRAINING MANAGER  team · courses · invite · revoke_invite · deactivate · reactivate · enroll · withdraw
   Refused with 403 flag_off while the academy_learner switch is off (invitations also need academy_invites, the
   Partner 360 entry also needs academy_handoff). State-changing calls must come from the Academy's own pages
   (x-academy-request header + an allowed Origin). Whose records are read or changed always comes from the session,
   never from the request. Actions are in _academy_learner.js. */
const A = require('./_academy.js');
const L = require('./_academy_learner.js');

// GET may only READ. Every action that changes anything is POST, so it always passes the cross-site check (security
// review 10 Oct 2026, finding C1). Answers (practice_check) and the sign-in actions are POST too.
const READ_ACTIONS = new Set(['me', 'my_courses', 'my_certificates', 'free_courses', 'manufacturer_programs', 'program', 'lesson', 'team', 'courses']);
const TM_ACTIONS = new Set(Object.keys(L.TM));

exports.handler = A.handler(async event => {
  if (!(await A.switchOn('academy_learner'))) return A.respond(event, 403, { error: 'flag_off', message: 'The HCPS Academy is not open yet.' });
  if (!A.SESSION.sameSiteRequest(event, A.SITE_ORIGINS)) return A.respond(event, 403, { error: 'forbidden', message: 'Not allowed.' });
  const isGet = event.httpMethod === 'GET';
  if (!isGet && event.httpMethod !== 'POST') return A.respond(event, 405, { error: 'method', message: 'Not allowed.' });
  // F2: the one learner request allowed above the usual size is a manufacturer certificate upload (3 MB file, base64)
  const upload = !isGet && String((event.headers || {})['x-academy-upload'] || '') === '1';
  const b = isGet ? Object.assign({}, event.queryStringParameters || {}) : A.body(event, upload ? 4300 * 1024 : undefined);
  if (upload && String(b.action || '') !== 'program_certificate') return A.respond(event, 400, { error: 'invalid', message: 'Not allowed.' });
  const action = String(b.action || 'me');
  if (isGet && !READ_ACTIONS.has(action)) return A.respond(event, 405, { error: 'method', message: 'That needs a POST.' });
  if (Object.prototype.hasOwnProperty.call(L.PUBLIC, action)) return L.PUBLIC[action](event, b);
  const learner = await A.learnerActor(event);
  if (!learner) return A.respond(event, 401, { error: 'unauthorized', message: 'Please sign in to the HCPS Academy.' },
                                 A.SESSION.readCookie(event) ? { cookie: A.SESSION.clearCookie() } : undefined);
  const fn = Object.prototype.hasOwnProperty.call(L.LEARNER, action) ? L.LEARNER[action]
           : TM_ACTIONS.has(action) ? L.TM[action] : null;
  if (!fn) return A.respond(event, 404, { error: 'unknown_action', message: 'Unknown action.' });
  const out = await fn(event, learner, b);
  if (out && out.statusCode) return out;   // an action that sets or clears the cookie answers itself
  return A.respond(event, 200, out);
});
exports._readActions = READ_ACTIONS;
exports._actions = L.LEARNER;   // tests add a stand-in write action here to prove GET can never run one
