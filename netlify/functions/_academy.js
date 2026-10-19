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
                  'academy_certificates', 'academy_dealer360', 'academy_exams', 'academy_open',
                  'academy_payments', 'academy_payments_live'];
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
async function rpc(fn, args) {
  let r; try {
    r = await fetch(`${env().url}/rest/v1/rpc/${fn}`, { method: 'POST', headers: svc({ 'content-type': 'application/json' }), body: JSON.stringify(args || {}) });
  } catch (e) { refuse(502, 'write_failed', 'The change could not be saved.'); }
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { j = null; }
  if (r.ok) return j;
  const code = j && j.code, msg = j && typeof j.message === 'string' && /^academy:\s*/.test(j.message) ? j.message.replace(/^academy:\s*/, '') : '';
  if (code === 'P0002') refuse(404, 'not_found', 'Not found.');
  if (code === '22023' || code === '23514') refuse(400, 'refused', msg || 'That change is not allowed.');
  if (code === '23505') refuse(409, 'conflict', 'That already exists.');
  if (code === '55000') refuse(409, 'locked', msg || 'This can no longer change.');
  if (code === '42501') refuse(403, 'forbidden', msg || 'Not allowed.');
  if (code === '40001') refuse(409, 'changed', msg.replace(/^changed:\s*/, '') || 'This was changed by someone else. Reload it.');
  if (code === 'PGRST202' || r.status === 404) refuse(503, 'not_installed', 'This Academy step is not available yet.');
  refuse(502, 'write_failed', 'The change could not be saved, and nothing was changed.');
}
/* C2 / M4 publication controls: the President check, the replace-and-retire and the course record's status happen in
   ONE database transaction (academy_publish_op_*); the server role can no longer call M1's publish / retire directly. */
async function publishOp(name, args) {
  if (!/^[a-z_]+$/.test(name)) refuse(500, 'internal', 'Unknown operation.');
  return rpc('academy_publish_op_' + name, args);
}
async function publishConsistency() { return rpc('academy_publish_consistency', {}); }
/* A2B / M5 learner access: sign-in codes, Partner 360 handoff, sessions, invitations, memberships, enrollment and
   progress. Same contract: one database call = the change and its audit row, or neither; not installed = 503.
   A2E / M6 exams (exam_op_*) and A2F / M7 HCPS certificates (cert_op_*) use the same door. */
async function accessOp(name, args) {
  if (!/^(access|enroll|progress|exam|cert)_op_[a-z_]+$/.test(name)) refuse(500, 'internal', 'Unknown operation.');
  return rpc('academy_' + name, args);
}
/* Phase 2 / M8 commerce: eligibility overrides, prices, checkouts, purchases, refunds. Same contract: one database call =
   the change and its audit row, or neither; not installed = 503. */
async function commerceOp(name, args) {
  if (!/^[a-z_]+$/.test(name)) refuse(500, 'internal', 'Unknown operation.');
  return rpc('academy_commerce_op_' + name, args);
}
async function eligibility(dealerId) { return rpc('academy_commerce_eligibility', { p_dealer: dealerId }); }
async function op(name, args) {
  if (!/^[a-z_]+$/.test(name)) refuse(500, 'internal', 'Unknown operation.');
  return rpc('academy_op_' + name, args);
}
/* Ordinary content (A2C M2): courses, draft versions, modules and lessons. Same contract as op(): the change and its
   audit row in one transaction, or neither. Never falls back to a plain write: not installed = 503. */
async function contentOp(name, args) {
  if (!/^[a-z_]+$/.test(name)) refuse(500, 'internal', 'Unknown operation.');
  return rpc('academy_content_op_' + name, args);
}

/* A short-lived link to ONE file in the private Academy bucket (A2D Stage 2: lesson pictures and HCPS documents).
   Only server-chosen media paths (media/<folder>/<file>, as M3 stores them) are ever signed. Any failure returns null:
   the lesson then shows a labelled placeholder, never a broken image. */
const MEDIA_PATH = /^media\/[a-z0-9-]{1,60}\/[a-z0-9][a-z0-9._-]{0,120}$/;
async function signPrivate(storagePath, seconds) {
  const p = String(storagePath || '');
  if (!MEDIA_PATH.test(p) || p.includes('..')) return null;
  try {
    const r = await fetch(`${env().url}/storage/v1/object/sign/academy-private/${p.split('/').map(enc).join('/')}`,
      { method: 'POST', headers: svc({ 'content-type': 'application/json' }), body: JSON.stringify({ expiresIn: Math.min(Math.max(seconds || 900, 60), 3600) }) });
    if (!r.ok) return null;
    const j = await r.json(); const s = j && (j.signedURL || j.signedUrl);
    if (typeof s !== 'string' || !s.startsWith('/')) return null;
    return `${env().url}/storage/v1${s}`;
  } catch (e) { return null; }
}

/* Lesson content (A2D M3): lesson blocks, ordering, the exam distribution, questions, media records and fact links. Same
   contract as op() and contentOp(): one database call = the change and its audit row, or neither; never a plain write. */
async function authorOp(name, args) {
  if (!/^[a-z_]+$/.test(name)) refuse(500, 'internal', 'Unknown operation.');
  return rpc('academy_author_op_' + name, args);
}
/* M3.1: the atomic lesson save (screens + their fact links + one audit row, compare-and-set under the lock). Same
   contract: one database call, all or nothing; not installed = 503, never a fallback. */
async function saveOp(name, args) {
  if (!/^[a-z_]+$/.test(name)) refuse(500, 'internal', 'Unknown operation.');
  return rpc('academy_save_op_' + name, args);
}
/* The private bucket, for lesson files only (A2D Stage 3 builder). Every path is server-chosen media/<folder>/<file>,
   exactly the form M3 accepts; nothing else in the bucket is ever listed, written or removed here. */
async function putPrivate(storagePath, bytes, contentType) {
  const p = String(storagePath || '');
  if (!MEDIA_PATH.test(p) || p.includes('..')) refuse(400, 'invalid', 'That file path is not allowed.');
  let r; try {
    r = await fetch(`${env().url}/storage/v1/object/academy-private/${p.split('/').map(enc).join('/')}`,
      { method: 'POST', headers: svc({ 'content-type': contentType, 'x-upsert': 'false', 'cache-control': 'no-store' }), body: bytes });
  } catch (e) { refuse(502, 'upload_failed', 'The file could not be stored. Nothing was changed.'); }
  if (r.ok) return { stored: true };
  const t = await r.text().catch(() => '');
  if (r.status === 409 || /already exists|Duplicate/i.test(t)) return { stored: false, existed: true };   // same name = same bytes (the name carries the hash)
  refuse(502, 'upload_failed', 'The file could not be stored. Nothing was changed.');
}
async function listPrivate(prefix) {
  if (!/^media\/([a-z0-9-]{1,60}\/)?$/.test(String(prefix))) refuse(400, 'invalid', 'That folder is not allowed.');
  let out = [], offset = 0;
  for (let i = 0; i < 20; i++) {
    let r; try {
      r = await fetch(`${env().url}/storage/v1/object/list/academy-private`, { method: 'POST', headers: svc({ 'content-type': 'application/json' }),
        body: JSON.stringify({ prefix, limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } }) });
    } catch (e) { refuse(503, 'unreadable', 'The Academy could not read its files just now.'); }
    if (!r.ok) refuse(503, 'unreadable', 'The Academy could not read its files just now.');
    const rows = await r.json(); out = out.concat(rows); if (rows.length < 1000) return out; offset += 1000;
  }
  refuse(503, 'too_large', 'There are more files than this screen can show at once.');
}
async function removePrivate(storagePath) {
  const p = String(storagePath || '');
  if (!MEDIA_PATH.test(p) || p.includes('..')) refuse(400, 'invalid', 'That file path is not allowed.');
  let r; try {
    r = await fetch(`${env().url}/storage/v1/object/academy-private`, { method: 'DELETE', headers: svc({ 'content-type': 'application/json' }), body: JSON.stringify({ prefixes: [p] }) });
  } catch (e) { refuse(502, 'remove_failed', 'The file could not be removed.'); }
  if (!r.ok) refuse(502, 'remove_failed', 'The file could not be removed.');
  return true;
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

/* ---------- PILOT GATE (launch directive 19 Oct 2026) ----------
   The learner switches are global, so until HCPS opens the Academy to every dealership (switch academy_open exactly true)
   the Academy runs in PILOT MODE, default-deny: only dealerships marked TEST (dealers.is_test) can hold a working
   Academy session, receive a sign-in code, get a Partner 360 Training link, be invited, appointed, restored or enrolled.
   A missing, false or unreadable academy_open = pilot mode. Reads behind the gate are strict (unreadable = 503). */
async function pilotMode() { return !(await switchOn('academy_open')); }
async function testDealerIds(ids) {
  const list = [...new Set((ids || []).map(String).filter(x => UUID.test(x)))];
  if (!list.length) return new Set();
  const rows = await sbGet(`dealers?id=in.(${list.map(enc).join(',')})&is_test=eq.true&select=id`);
  return new Set(rows.map(r => String(r.id)));
}
/* Refuses unless the Academy is open to all, or the dealership is a TEST dealership. */
async function pilotDealer(dealerId) {
  if (!(await pilotMode())) return;
  if (!(await testDealerIds([dealerId])).has(String(dealerId))) refuse(403, 'pilot_only', 'The HCPS Academy is in its pilot. It is not open for this dealership yet.');
}
/* Active memberships the pilot allows: all of them when open; only TEST dealerships' during the pilot. */
async function pilotMemberships(mem) {
  if (!(await pilotMode())) return mem;
  const ok = await testDealerIds(mem.map(m => m.dealer_id));
  return mem.filter(m => ok.has(String(m.dealer_id)));
}
/* May this address use the Academy right now? Pilot: an active learner with an active TEST-dealership membership, or a
   pending, unexpired invitation to a TEST dealership (their first sign-in accepts it). */
async function pilotEmailAllowed(email) {
  if (!(await pilotMode())) return true;
  const addr = enc(String(email).toLowerCase());
  const inv = (await sbGet(`academy_invites?email=eq.${addr}&status=eq.pending&select=dealer_id,expires_at`)).filter(i => Date.parse(i.expires_at) > Date.now());
  if ((await testDealerIds(inv.map(i => i.dealer_id))).size) return true;
  const ls = await sbGet(`academy_learners?email=eq.${addr}&status=eq.active&select=id`);
  if (!ls.length) return false;
  const mem = await sbGet(`academy_memberships?learner_id=in.(${ls.map(l => enc(l.id)).join(',')})&status=eq.active&select=dealer_id`);
  return (await testDealerIds(mem.map(m => m.dealer_id))).size > 0;
}

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
  if (!UUID.test(c.learner_id) || !UUID.test(c.session_id)) return null;
  // A2B / M5: the cookie names a session row; it must still be open (signing out, ending a membership or suspending
  // the learner ends it at once), unexpired and the same learner's.
  const ss = await sbGet(`academy_sessions?id=eq.${enc(c.session_id)}&select=id,learner_id,expires_at,ended_at`);
  const s = ss[0];
  if (!s || s.ended_at || String(s.learner_id) !== c.learner_id || !(Date.parse(s.expires_at) > Date.now())) return null;
  const ls = await sbGet(`academy_learners?id=eq.${enc(c.learner_id)}&select=id,auth_user_id,full_name,email,status`);
  const l = ls[0];
  if (!l || l.status !== 'active') return null;
  const staff = await sbGet(`staff_users?email=eq.${enc(String(l.email).toLowerCase())}&select=email,active`);
  if (staff.some(x => x.active !== false)) return null;
  // select=*: works before and after M8 (which adds organization_id)
  const mem = (await pilotMemberships(await sbGet(`academy_memberships?learner_id=eq.${enc(l.id)}&status=eq.active&select=*`))).map(m => ({ id: m.id, dealer_id: m.dealer_id, organization_id: m.organization_id || null, role: m.role, access_type: m.access_type }));
  if (!mem.length) return null;   // no active access for any dealership (pilot: no TEST dealership) = no session
  return { kind: 'learner', learner_id: l.id, session_id: s.id, auth_user_id: l.auth_user_id || null, email: l.email, full_name: l.full_name, memberships: mem };
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
/* max: a larger limit for the ONE caller that needs it (the builder's file upload); everything else keeps MAX_BODY. */
function body(event, max) {
  const raw = event && event.body; if (!raw) return {};
  const text = event.isBase64Encoded ? Buffer.from(raw, 'base64').toString('utf8') : String(raw);
  if (Buffer.byteLength(text) > (max || MAX_BODY)) refuse(413, 'too_large', 'That request is too large.');
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
  pilotMode, testDealerIds, pilotDealer, pilotMemberships, pilotEmailAllowed,
  sbGet, sbSend, op, commerceOp, eligibility, publishOp, publishConsistency, accessOp, contentOp, authorOp, saveOp, switchOn, switches, signPrivate, putPrivate, listPrivate, removePrivate, MEDIA_PATH,
  bearer, bearerUser, staffActor, learnerActor,
  isAdmin, isRelations, isRep, family, dealerScope, canSeeDealer, canSeeScores, requireDealer, requireAdmin, actorLabel,
  audit, redact, body, uuid, oneOf, text, respond, handler, SESSION,
};
