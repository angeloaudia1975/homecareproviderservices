/* HCPS Academy — the shared security layer (Phase A2A). Every Academy function goes through this module:
     1. WHO is calling        staffActor (Connect 360 sign-in) · learnerActor (the Academy's own session cookie)
     2. WHAT they may touch   role checks + dealership scope (Training Manager family, rep book via _scope.js)
     3. a RECORD of changes   audit() for ordinary writes; op() for the security-sensitive ones, which run as ONE
                              database transaction with their audit row (migration A2A M1) or not at all
     4. the SWITCHES          _flags.js: on only when exactly true; unreadable = off
     5. SAFE INPUT/OUTPUT     size and shape checks, no-store responses, an origin allow-list, plain errors that never
                              say whether an email or record exists, nothing secret in a response or a log
   Rules (CLAUDE.md 16, 17, 19, 20): reads that feed a decision are strict (unreadable = 503, never "empty"); whose
   records a request touches always comes from the credential, never from the request body; the service key never
   leaves the server. */
const SC = require('./_scope.js');
const FL = require('./_flags.js');
const SESSION = require('./_academy_session.js');

const SWITCHES = ['academy_admin', 'academy_learner', 'academy_handoff', 'academy_invites', 'academy_external_uploads',
                  'academy_certificates', 'academy_dealer360'];
const SITE_ORIGINS = ['https://homecareproviderservices.org', 'https://www.homecareproviderservices.org',
                      'https://homecareproviderservices.netlify.app'];
const PARTNER360_ORIGINS = ['https://hcpsonlineordering.netlify.app'];
const MAX_BODY = 256 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class AcademyError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}
const refuse = (status, code, message) => { throw new AcademyError(status, code, message); };

const env = () => ({ url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE });
function svc(extra) { const { key } = env(); return Object.assign({ apikey: key, authorization: 'Bearer ' + key }, extra || {}); }
const enc = encodeURIComponent;

/* Strict read: anything but a 2xx is an error, never an empty list. */
async function sbGet(path) {
  let r; try { r = await fetch(`${env().url}/rest/v1/${path}`, { headers: svc() }); }
  catch (e) { refuse(503, 'unreadable', 'The Academy could not read its data just now.'); }
  if (!r.ok) refuse(503, 'unreadable', 'The Academy could not read its data just now.');
  const t = await r.text(); return t ? JSON.parse(t) : [];
}
async function sbSend(method, path, body, prefer) {
  let r; try {
    r = await fetch(`${env().url}/rest/v1/${path}`, { method, headers: svc({ 'content-type': 'application/json', prefer: prefer || 'return=representation' }),
                                                     body: body == null ? undefined : JSON.stringify(body) });
  } catch (e) { refuse(502, 'write_failed', 'The change could not be saved.'); }
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { j = null; }
  if (!r.ok) {
    const code = j && j.code;
    if (code === '23505') refuse(409, 'conflict', 'That already exists.');
    if (code === '23514' || code === '22023' || code === '23502') refuse(400, 'invalid', 'That change is not allowed.');
    if (code === '42501') refuse(403, 'forbidden', 'That change must go through its approved step.');
    refuse(502, 'write_failed', 'The change could not be saved.');
  }
  return j;
}

/* A security-sensitive change: one database function = one transaction = the change AND its audit row, or neither.
   (Training Manager role, Golden verification, HCPS certificates, publishing, exam results, product facts.) */
async function op(name, args) {
  if (!/^[a-z_]+$/.test(name)) refuse(500, 'internal', 'Unknown operation.');
  let r; try {
    r = await fetch(`${env().url}/rest/v1/rpc/academy_op_${name}`, { method: 'POST', headers: svc({ 'content-type': 'application/json' }), body: JSON.stringify(args || {}) });
  } catch (e) { refuse(502, 'write_failed', 'The change could not be saved.'); }
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { j = null; }
  if (r.ok) return j;
  const code = j && j.code, msg = j && typeof j.message === 'string' ? j.message.replace(/^academy:\s*/, '') : '';
  if (code === 'P0002') refuse(404, 'not_found', 'Not found.');
  if (code === '22023' || code === '23514') refuse(400, 'refused', msg || 'That change is not allowed.');
  if (code === '23505') refuse(409, 'conflict', 'That already exists.');
  if (code === '42501') refuse(403, 'forbidden', 'Not allowed.');
  if (code === 'PGRST202' || r.status === 404) refuse(503, 'not_installed', 'This Academy step is not available yet.');
  refuse(502, 'write_failed', 'The change could not be saved, and nothing was changed.');
}

/* ---------- switches ---------- */
async function switchOn(name) {
  if (!SWITCHES.includes(name)) return false;
  return FL.flagOn(sbGetLoose, name);        // _flags.js: unreadable or missing = off
}
async function switches() {
  const f = await FL.flags(sbGetLoose); const out = {};
  for (const s of SWITCHES) out[s] = f[s] === true;
  return out;
}
async function sbGetLoose(path) { return sbGet(path); }   // _flags.js catches its own read errors (off)

/* ---------- who is calling ---------- */
function bearer(event) {
  const h = (event && event.headers) || {};
  const a = h.authorization || h.Authorization || '';
  const tok = String(a).replace(/^Bearer\s+/i, '').trim();
  return tok || null;
}
/* The Supabase login behind a bearer token, or null. */
async function bearerUser(event) {
  const tok = bearer(event); if (!tok || tok.length > 4096) return null;
  let r; try { r = await fetch(`${env().url}/auth/v1/user`, { headers: { apikey: env().key, authorization: 'Bearer ' + tok } }); }
  catch (e) { refuse(503, 'unreadable', 'Sign-in could not be checked just now.'); }
  if (r.status === 401 || r.status === 403) return null;
  if (!r.ok) refuse(503, 'unreadable', 'Sign-in could not be checked just now.');
  const u = await r.json(); const email = u && u.email ? String(u.email).toLowerCase() : null;
  return email ? { id: u.id || null, email } : null;
}
/* Connect 360 staff: an active staff_users row behind the bearer token. */
async function staffActor(event) {
  const u = await bearerUser(event); if (!u) return null;
  const rows = await sbGet(`staff_users?email=eq.${enc(u.email)}&select=email,name,role,rep_name,active`);
  const s = rows[0]; if (!s || s.active === false) return null;
  return { kind: 'staff', email: u.email, name: s.name || null, role: String(s.role || 'rep').toLowerCase(), rep_name: s.rep_name || null };
}
/* A learner: a valid Academy session cookie, an active learner record for that same login, and the learner's
   ACTIVE memberships. HCPS staff emails are never learners in A2 (decision D6). */
async function learnerActor(event) {
  const raw = SESSION.readCookie(event); if (!raw) return null;
  if (!SESSION.configured()) refuse(503, 'session_unavailable', 'Academy sign-in is not available just now.');
  const c = SESSION.verify(raw); if (!c) return null;
  if (!UUID.test(c.learner_id) || !UUID.test(c.auth_user_id)) return null;
  const ls = await sbGet(`academy_learners?id=eq.${enc(c.learner_id)}&select=id,auth_user_id,full_name,email,status`);
  const l = ls[0];
  if (!l || l.status !== 'active' || String(l.auth_user_id) !== c.auth_user_id) return null;
  const staff = await sbGet(`staff_users?email=eq.${enc(String(l.email).toLowerCase())}&select=email,active`);
  if (staff.some(s => s.active !== false)) return null;
  const mem = await sbGet(`academy_memberships?learner_id=eq.${enc(l.id)}&status=eq.active&select=id,dealer_id,role,access_type`);
  return { kind: 'learner', learner_id: l.id, auth_user_id: l.auth_user_id, email: l.email, full_name: l.full_name, memberships: mem };
}

/* ---------- what they may touch ---------- */
const isAdmin = a => !!a && a.kind === 'staff' && SC.isAdmin(a);
const isRelations = a => !!a && a.kind === 'staff' && a.role === 'relations';
const isRep = a => !!a && a.kind === 'staff' && !SC.isAdmin(a) && a.role !== 'relations';

/* A dealer and its direct branches (dealers.parent_id) — "own dealership" for a Training Manager. A branch has no
   branches of its own, so a branch Training Manager's family is just the branch (decision D3). */
async function family(dealerId) {
  if (!UUID.test(String(dealerId))) return new Set();
  const [self, kids] = await Promise.all([
    sbGet(`dealers?id=eq.${enc(dealerId)}&select=id`),
    sbGet(`dealers?parent_id=eq.${enc(dealerId)}&select=id`),
  ]);
  const ids = new Set(); if (self[0]) ids.add(String(self[0].id));
  if (ids.size) for (const k of kids) ids.add(String(k.id));
  return ids;
}
/* The rep's book through _scope.js, made strict: _scope swallows read errors (it fails closed with an empty book);
   the Academy turns any read error during scoping into a 503 instead of an empty answer. */
async function repScope(staff) {
  const errors = [];
  const rec = async p => { try { return await sbGet(p); } catch (e) { errors.push(e); throw e; } };
  const sc = await SC.dealerScope(staff, rec);
  if (errors.length) refuse(503, 'unreadable', 'The Academy could not read its data just now.');
  return sc;
}
/* Which dealerships this person may see learner status for: { all:boolean, ids:Set }. */
async function dealerScope(actor) {
  if (!actor) return { all: false, ids: new Set() };
  if (actor.kind === 'staff') {
    if (isAdmin(actor) || isRelations(actor)) return { all: true, ids: new Set() };
    const sc = await repScope(actor);
    return { all: !!sc.isAll, ids: new Set([...(sc.ids || [])].map(String)) };
  }
  const ids = new Set();
  for (const m of actor.memberships || []) if (m.role === 'training_manager') for (const id of await family(m.dealer_id)) ids.add(id);
  return { all: false, ids };
}
async function canSeeDealer(actor, dealerId) {
  const s = await dealerScope(actor); return s.all || s.ids.has(String(dealerId));
}
/* Numeric exam scores: HCPS admin everywhere; a Training Manager for their own dealership; a learner their own
   (handled where results are read). Reps and Relations see status only (decisions of 14:31 and D8). */
async function canSeeScores(actor, dealerId) {
  if (isAdmin(actor)) return true;
  if (actor && actor.kind === 'learner') return (await dealerScope(actor)).ids.has(String(dealerId));
  return false;
}
async function requireDealer(actor, dealerId) {
  if (!(await canSeeDealer(actor, dealerId))) refuse(403, 'forbidden', 'Not allowed.');
}
const requireAdmin = actor => { if (!isAdmin(actor)) refuse(403, 'forbidden', 'Not allowed.'); };
const actorLabel = a => a.kind === 'staff' ? 'staff:' + a.email : 'learner:' + a.learner_id;

/* ---------- audit (ordinary writes) ---------- */
const SECRET_KEY = /token|secret|password|passwd|code_hash|answer_key|authorization|cookie|session/i;
function redact(v, depth) {
  if (depth > 6 || v == null) return v;
  if (Array.isArray(v)) return v.slice(0, 200).map(x => redact(x, depth + 1));
  if (typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(x, depth + 1); return o; }
  if (typeof v === 'string') return v.length > 2000 ? v.slice(0, 2000) + '…' : v;
  return v;
}
/* Saved AFTER the change it describes (the web API cannot save both in one step). A failed audit write never
   undoes the change and is never silent: it returns false, the caller says so in its response, and it is logged. */
async function audit(actor, entity, entityId, action, before, after) {
  try {
    await sbSend('POST', 'academy_events', {
      actor_type: actor ? (actor.kind === 'staff' ? 'staff' : 'learner') : 'system', actor: actor ? actorLabel(actor) : 'system',
      entity, entity_id: entityId == null ? null : String(entityId), action, before: redact(before, 0), after: redact(after, 0),
    }, 'return=minimal');
    return true;
  } catch (e) { console.error('academy audit write failed', entity, action); return false; }
}

/* ---------- input ---------- */
function body(event) {
  const raw = event && event.body; if (!raw) return {};
  const text = event.isBase64Encoded ? Buffer.from(raw, 'base64').toString('utf8') : String(raw);
  if (Buffer.byteLength(text) > MAX_BODY) refuse(413, 'too_large', 'That request is too large.');
  let j; try { j = JSON.parse(text); } catch (e) { refuse(400, 'invalid', 'The request could not be read.'); }
  if (!j || typeof j !== 'object' || Array.isArray(j)) refuse(400, 'invalid', 'The request could not be read.');
  return j;
}
const uuid = (v, name) => { if (!UUID.test(String(v || ''))) refuse(400, 'invalid', `${name || 'id'} is not valid.`); return String(v).toLowerCase(); };
const oneOf = (v, list, name) => { if (!list.includes(v)) refuse(400, 'invalid', `${name || 'value'} is not valid.`); return v; };
const text = (v, max, name) => { const s = String(v == null ? '' : v).trim(); if (!s || s.length > (max || 500)) refuse(400, 'invalid', `${name || 'text'} is not valid.`); return s; };

/* ---------- output ---------- */
function respond(event, status, payload, opts) {
  opts = opts || {};
  const origin = String(((event && event.headers) || {}).origin || ((event && event.headers) || {}).Origin || '').toLowerCase();
  const allowed = (opts.origins || SITE_ORIGINS).includes(origin);
  const headers = Object.assign({
    'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer', vary: 'Origin',
  }, allowed ? { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'content-type, authorization, x-academy-request',
                 'access-control-allow-methods': 'GET, POST, OPTIONS' } : {}, opts.headers || {});
  const out = { statusCode: status, headers, body: payload == null ? '' : JSON.stringify(payload) };
  if (opts.cookie) out.multiValueHeaders = { 'set-cookie': [opts.cookie] };
  return out;
}
/* Wraps a handler: AcademyError -> its status and plain message; anything else -> 500 with nothing internal shown. */
function handler(fn, opts) {
  return async event => {
    if (event && event.httpMethod === 'OPTIONS') return respond(event, 204, null, opts);
    try {
      const { url, key } = env();
      if (!url || !key) return respond(event, 503, { error: 'unavailable', message: 'The Academy is not available just now.' }, opts);
      return await fn(event);
    } catch (e) {
      if (e instanceof AcademyError) return respond(event, e.status, { error: e.code, message: e.message }, opts);
      console.error('academy internal error', e && e.name);
      return respond(event, 500, { error: 'internal', message: 'Something went wrong. Nothing was changed.' }, opts);
    }
  };
}

module.exports = {
  SWITCHES, SITE_ORIGINS, PARTNER360_ORIGINS, MAX_BODY, AcademyError, refuse,
  sbGet, sbSend, op, switchOn, switches,
  bearer, bearerUser, staffActor, learnerActor,
  isAdmin, isRelations, isRep, family, dealerScope, canSeeDealer, canSeeScores, requireDealer, requireAdmin, actorLabel,
  audit, redact, body, uuid, oneOf, text, respond, handler, SESSION,
};
