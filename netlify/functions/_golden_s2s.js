// HCPS ⇄ Golden server-to-server request signing — contract golden-commerce-v1 (§5 of the contract doc).
//
// THIS FILE IS SHARED BYTE-FOR-BYTE between the two repositories:
//   golden-dealer-portal      repo/functions/lib/hcps-s2s.js
//   homecareproviderservices  netlify/functions/_golden_s2s.js
// Its SHA-256 is pinned in docs/contracts/golden-commerce-v1.lock.json in BOTH repos and each repo's
// test suite fails if its copy drifts. Change it in both repos together and update the lock.
//
// Design (corrected 2026-11-02):
//   • The HMAC secret is a SHARED SECRET held only in each site's Netlify environment. It is never stored in a
//     database (a hash of an HMAC key cannot verify an HMAC, and storing the key itself would put a live
//     credential in table backups). The database holds only the key id, scopes, active flag and a short
//     FINGERPRINT that confirms which secret is configured — it is never used to compute or check a signature.
//   • A secret must be at least 32 bytes. Generate one with:  openssl rand -base64 48
//   • The signature covers: scheme/version, audience, method, path, sorted query, timestamp, nonce,
//     SHA-256 of the exact raw body bytes, SHA-256 of the exact delegation header value. Nothing a caller
//     could swap after signing is left outside it.
//   • Verification: strict header grammar, |now − ts| ≤ 300 s, signature compared in constant time on the
//     decoded 32 bytes, delegation claims checked (audience, ≤120 s lifetime, not before iat). Nonce replay is
//     enforced by the receiver's database (unique (kid, nonce)), not here.
//   • Pure: no env reads, no network. The caller supplies the secret lookup and the clock.
'use strict';
const crypto = require('crypto');

const SCHEME = 'HCPS-S2S';
const VERSION = 'v1';
const AUDIENCE = 'golden-commerce-v1';
const MAX_SKEW_SEC = 300;
const MAX_DELEGATION_SEC = 120;
const MIN_SECRET_BYTES = 32;
const DELEGATION_ROLES = Object.freeze(['dealer', 'dealer_admin', 'branch_user', 'staff_preview', 'hcps_staff']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KID_RE = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const AUTH_RE = /^HCPS-S2S kid=([a-z0-9][a-z0-9._-]{2,63}), ts=(\d{9,11}), nonce=([0-9a-f-]{36}), sig=([0-9a-f]{64})$/;

function sha256hex(data) { return crypto.createHash('sha256').update(data).digest('hex'); }

// The secret's public fingerprint: identifies WHICH secret is configured (for the integration_clients row and
// audit), never used for signing. 16 hex chars of SHA-256 over a domain-separated input.
function fingerprint(secret) { return sha256hex('hcps-s2s-fingerprint:' + String(secret || '')).slice(0, 16); }

function secretUsable(secret) { return typeof secret === 'string' && Buffer.byteLength(secret, 'utf8') >= MIN_SECRET_BYTES; }

// Netlify gives the body as a string (base64 when isBase64Encoded). Signatures are over the exact bytes received.
function rawBodyBytes(event) {
  const b = event && event.body;
  if (b == null || b === '') return Buffer.alloc(0);
  return event.isBase64Encoded ? Buffer.from(String(b), 'base64') : Buffer.from(String(b), 'utf8');
}

// Sorted, percent-encoded query. Arrays are refused by the caller (single-valued contract).
function canonicalQuery(q) {
  const o = q || {};
  return Object.keys(o).filter(k => o[k] != null).sort()
    .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(String(o[k]))).join('&');
}

function canonicalString(p) {
  return [SCHEME + '-' + VERSION, AUDIENCE, String(p.method || '').toUpperCase(), String(p.path || ''),
    canonicalQuery(p.query), String(p.ts), String(p.nonce), p.bodyHash, p.delegationHash].join('\n');
}

function hmacHex(secret, str) { return crypto.createHmac('sha256', Buffer.from(String(secret), 'utf8')).update(str, 'utf8').digest('hex'); }

function encodeDelegation(claims) { return Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url'); }
function decodeDelegation(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,2048}$/.test(value)) return null;
  try { const o = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); return (o && typeof o === 'object' && !Array.isArray(o)) ? o : null; }
  catch { return null; }
}

// Build the headers for one request. `body` = the exact string/Buffer that will be sent.
function sign({ kid, secret, method, path, query, body, delegation, ts, nonce }) {
  if (!KID_RE.test(String(kid || ''))) throw new Error('hcps-s2s: bad key id');
  if (!secretUsable(secret)) throw new Error('hcps-s2s: secret missing or shorter than ' + MIN_SECRET_BYTES + ' bytes');
  const t = ts != null ? Number(ts) : Math.floor(Date.now() / 1000);
  const n = nonce || crypto.randomUUID();
  const bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(body == null ? '' : String(body), 'utf8');
  const delegationValue = delegation ? encodeDelegation(delegation) : '';
  const sig = hmacHex(secret, canonicalString({ method, path, query, ts: t, nonce: n,
    bodyHash: sha256hex(bodyBuf), delegationHash: sha256hex(delegationValue) }));
  const headers = { authorization: `${SCHEME} kid=${kid}, ts=${t}, nonce=${n}, sig=${sig}` };
  if (delegationValue) headers['x-hcps-delegation'] = delegationValue;
  return headers;
}

function header(headers, name) {
  const h = headers || {}; const want = name.toLowerCase();
  for (const k of Object.keys(h)) if (k.toLowerCase() === want) return h[k];
  return undefined;
}

function checkDelegation(d, nowSec) {
  if (!d) return 'delegation_invalid';
  if (d.aud !== AUDIENCE) return 'delegation_audience';
  const iat = Number(d.iat), exp = Number(d.exp);
  if (!Number.isInteger(iat) || !Number.isInteger(exp)) return 'delegation_invalid';
  if (exp <= iat || exp - iat > MAX_DELEGATION_SEC) return 'delegation_lifetime';
  if (iat > nowSec + 30) return 'delegation_not_yet_valid';
  if (exp < nowSec) return 'delegation_expired';
  if (!UUID_RE.test(String(d.sub_dealer || ''))) return 'delegation_subject';
  if (d.sub_branch != null && !UUID_RE.test(String(d.sub_branch))) return 'delegation_branch';
  if (!DELEGATION_ROLES.includes(d.role)) return 'delegation_role';
  if (d.actor != null && (typeof d.actor !== 'string' || d.actor.length > 128)) return 'delegation_actor';
  return null;
}

// Verify a received request. secretFor(kid) → the configured secret or null.
// Returns { ok:true, kid, ts, nonce, delegation } or { ok:false, status, reason }.
function verify({ headers, method, path, query, rawBody, nowSec, secretFor, requireDelegation }) {
  const now = nowSec != null ? nowSec : Math.floor(Date.now() / 1000);
  const fail = (reason, status) => ({ ok: false, status: status || 401, reason });
  const auth = header(headers, 'authorization');
  if (typeof auth !== 'string') return fail('missing_signature');
  const m = AUTH_RE.exec(auth);
  if (!m) return fail('bad_signature_header');
  const [, kid, tsStr, nonce, sigHex] = m;
  if (!UUID_RE.test(nonce)) return fail('bad_nonce');
  const ts = Number(tsStr);
  if (Math.abs(now - ts) > MAX_SKEW_SEC) return fail('stale_request');
  const secret = secretFor(kid);
  if (!secretUsable(secret)) return fail('unknown_key');
  for (const k of Object.keys(query || {})) if (Array.isArray(query[k])) return fail('bad_query', 400);
  const delegationValue = header(headers, 'x-hcps-delegation');
  if (delegationValue != null && typeof delegationValue !== 'string') return fail('delegation_invalid');
  const dv = delegationValue || '';
  const expected = hmacHex(secret, canonicalString({ method, path, query, ts, nonce,
    bodyHash: sha256hex(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody == null ? '' : String(rawBody), 'utf8')),
    delegationHash: sha256hex(dv) }));
  const a = Buffer.from(sigHex, 'hex'), b = Buffer.from(expected, 'hex');
  if (a.length !== 32 || b.length !== 32 || !crypto.timingSafeEqual(a, b)) return fail('bad_signature');
  let delegation = null;
  if (dv) {
    delegation = decodeDelegation(dv);
    const why = checkDelegation(delegation, now);
    if (why) return fail(why);
  } else if (requireDelegation) {
    return fail('delegation_required');
  }
  return { ok: true, kid, ts, nonce, delegation };
}

module.exports = {
  SCHEME, VERSION, AUDIENCE, MAX_SKEW_SEC, MAX_DELEGATION_SEC, MIN_SECRET_BYTES, DELEGATION_ROLES,
  sha256hex, fingerprint, secretUsable, rawBodyBytes, canonicalQuery, canonicalString,
  encodeDelegation, decodeDelegation, sign, verify, header, checkDelegation,
};
