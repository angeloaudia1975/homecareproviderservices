/* C3-07 Stage 5 — shared store for manufacturer applications: database rows, the append-only event log, the PRIVATE
   storage bucket, completing a signed envelope, and the President's notification (D5: never the application's contents
   — only that one is waiting, with a link). Used by dealer-applications-api, documenso-webhook and applications-admin-api. */
const CRYPTO = require('./_app_crypto.js');
const DS = require('./_documenso.js');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const BUCKET = 'dealer-applications';
const ADMIN_PAGE = (process.env.HCPS_ADMIN_BASE || 'https://homecareproviderservices.netlify.app') + '/admin/applications.html';
const H = () => ({ apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` });
const enc = encodeURIComponent;
const SEL = 'id,dealer_id,location_id,manufacturer,form_sha256,status,answers_enc,business_name,signer_name,signer_email,envelope_id,signing_token_enc,sent_pdf_sha256,signed_path,signed_sha256,certificate_path,audit_path,signed_at,submitted_at,review_notes,decided_at,retention_until,version,created_by,created_at,updated_by,updated_at';
const FREE_MONTHLY = Math.max(1, Number(process.env.DOCUMENSO_MONTHLY_LIMIT || 5));
const MISSING = (e) => { const m = String(e && e.message); return /PGRST205|42P01/.test(m) && /dealer_application/.test(m); };

async function sb(method, path, body, extra) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method, headers: { ...H(), 'content-type': 'application/json', ...(extra || {}) }, body: body != null ? JSON.stringify(body) : undefined });
  const t = await r.text(); if (!r.ok) { const e = new Error(`Supabase ${r.status}: ${t}`); e.status = r.status; throw e; }
  return t ? JSON.parse(t) : null;
}
async function getApp(id) { const r = await sb('GET', `dealer_applications?id=eq.${enc(id)}&select=${SEL}`); return (r && r[0]) || null; }
async function event(appId, actor, action, detail) {   // never the answers: callers pass ids, statuses, hashes and counts only
  await sb('POST', 'dealer_application_events', { application_id: appId, actor: String(actor || 'system').slice(0, 200), action, detail: detail || {} }, { Prefer: 'return=minimal' });
}
/* compare-and-set: the row changes only if it is still the version the caller read */
async function update(app, patch, by) {
  const body = Object.assign({}, patch, { version: app.version + 1, updated_by: String(by || 'system').slice(0, 200), updated_at: new Date().toISOString() });
  const r = await sb('PATCH', `dealer_applications?id=eq.${enc(app.id)}&version=eq.${app.version}`, body, { Prefer: 'return=representation' });
  if (!(r && r.length)) { const e = new Error('changed'); e.status = 409; throw e; }
  return r[0];
}
/* envelopes created this calendar month (Chicago) — the free plan allows FREE_MONTHLY */
/* the first instant of the current month in Chicago (CST or CDT — the offset of that very day, never a fixed -06:00) */
function chicagoMonthStart(now) {
  now = now || new Date();
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit' }).formatToParts(now).map((x) => [x.type, x.value]));
  const guess = new Date(Date.UTC(+p.year, +p.month - 1, 1, 6));
  const off = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', timeZoneName: 'shortOffset' }).formatToParts(guess).find((x) => x.type === 'timeZoneName');
  const h = off && /GMT([+-]\d+)/.test(off.value) ? -Number(off.value.match(/GMT([+-]\d+)/)[1]) : 6;
  return new Date(Date.UTC(+p.year, +p.month - 1, 1, h)).toISOString();
}
async function countEvents(action, extra) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/dealer_application_events?action=eq.${action}&at=gte.${enc(chicagoMonthStart())}${extra || ''}&select=id`, { headers: { ...H(), Prefer: 'count=exact', Range: '0-0' } });
  if (!r.ok) { const e = new Error('count ' + r.status); e.status = 503; throw e; }
  const n = Number(String(r.headers.get('content-range') || '').split('/')[1]); return Number.isFinite(n) ? n : 0;
}
/* signing slots used this month: every reservation, less the ones given back because no envelope was created.
   Reserved BEFORE Documenso is called, so a failure after the envelope exists still counts it. dealer: that company only. */
async function envelopesThisMonth(dealer) {
  const f = dealer ? `&detail->>dealer=eq.${enc(dealer)}` : '';
  return (await countEvents('slot_reserved', f)) - (await countEvents('slot_released', f));
}

async function putFile(path, bytes) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, { method: 'POST', headers: { ...H(), 'content-type': 'application/pdf', 'x-upsert': 'true' }, body: bytes });
  if (!r.ok) { const e = new Error('storage ' + r.status); e.status = 502; throw e; }
  return path;
}
async function signedLink(path, seconds) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}/${path}`, { method: 'POST', headers: { ...H(), 'content-type': 'application/json' }, body: JSON.stringify({ expiresIn: seconds || 120 }) });
  if (!r.ok) return null; const j = await r.json(); const u = j && (j.signedURL || j.signedUrl);
  return u ? `${SUPABASE_URL}/storage/v1${u.startsWith('/') ? '' : '/'}${u}` : null;
}

/* a completed envelope → the signed PDF, certificate and audit log in private storage; status "signed" (awaiting the
   President). Re-reads the envelope from Documenso — a webhook payload is never trusted. Idempotent. */
async function finalize(app, actor, envelopeId) {
  if (!app.envelope_id || (envelopeId && envelopeId !== app.envelope_id)) return { ok: false, reason: 'not_current_envelope' };
  if (app.signed_path) return { ok: true, already: true };
  /* only an application that is WITH the signer becomes "signed"; a withdrawn / reopened one keeps its status (the
     President still gets the signed file on record, as an event) */
  const current = app.status === 'signing';
  const env = await DS.getEnvelope(app.envelope_id);
  if (!env || (env.externalId && env.externalId !== app.id)) return { ok: false, reason: 'mismatch' };
  if (env.status !== 'COMPLETED') return { ok: false, reason: 'not_completed', status: env.status };
  const item = (env.envelopeItems || [])[0]; if (!item) return { ok: false, reason: 'no_item' };
  const crypto = require('crypto');
  const signed = await DS.downloadItem(item.id, 'signed');
  let cert = null, audit = null;
  try { cert = await DS.downloadCertificate(app.envelope_id); } catch (e) { /* recorded below */ }
  try { audit = await DS.downloadAudit(app.envelope_id); } catch (e) { /* recorded below */ }
  const base = `${app.dealer_id}/${app.id}`;
  await putFile(`${base}/signed.pdf`, signed);
  if (cert) await putFile(`${base}/certificate.pdf`, cert);
  if (audit) await putFile(`${base}/audit-log.pdf`, audit);
  const sha = crypto.createHash('sha256').update(signed).digest('hex');
  if (!current) { await event(app.id, actor, 'signed_after_withdrawal', { envelope: app.envelope_id, status: app.status, signed_sha256: sha, stored: `${base}/signed.pdf` }); return { ok: true, late: true }; }
  const row = await update(app, { status: 'signed', signed_path: `${base}/signed.pdf`, signed_sha256: sha, certificate_path: cert ? `${base}/certificate.pdf` : null,
    audit_path: audit ? `${base}/audit-log.pdf` : null, signed_at: env.completedAt || new Date().toISOString(), signing_token_enc: null }, actor);
  await event(app.id, actor, 'signed', { envelope: app.envelope_id, signed_sha256: sha, certificate: !!cert, audit_log: !!audit });
  await notifyPresident(row, 'signed').catch(() => {});
  return { ok: true, application: row };
}

const FORM_NAMES = () => { const F = require('./_app_forms.js'); return Object.fromEntries(Object.entries(F.FORMS).map(([k, v]) => [k, v.name])); };
async function notifyPresident(app, why) {
  if (!process.env.RESEND_API_KEY) return;
  const s = await sb('GET', 'staff_users?role=eq.president&active=eq.true&select=email&limit=3');
  const to = (s || []).map((x) => x.email).filter((e) => /^[^@\s]+@[^@\s]+$/.test(e)); if (!to.length) return;
  const name = FORM_NAMES()[app.manufacturer] || app.manufacturer;
  const what = why === 'queued' ? `A ${name} application is waiting for a signing slot (the free e-signature plan's monthly limit is reached).` : `A signed ${name} application is ready for your review.`;
  const from = process.env.HCPS_MAIL_FROM || 'HomeCare Provider Services <orders@homecareproviderservices.us>';
  /* D5: no business name, answers or figures in the email — the review page holds them */
  await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, subject: why === 'queued' ? `Application waiting to be signed — ${name}` : `Application ready for review — ${name}`,
      html: `<p>${what}</p><p><a href="${ADMIN_PAGE}">Open Manufacturer Applications</a> (Connect 360, President only).</p><p style="color:#777;font-size:12px">The application itself is kept private on HCPS's systems and is never sent by email.</p>` }) });
}

/* ---- C3-07 Stage 5 follow-ups (owner 2026-11-06 13:25 CT) ---- */
const PAPER_MAX = 4 * 1024 * 1024;   // a scanned, hand-signed PDF (Netlify's request limit leaves room for ~4 MB)
/* a hand-signed PDF sent as base64 → { bytes, sha256 } or { error } — a real PDF only, never stored over another file */
function paperPdf(b64) {
  const s = String(b64 || ''); if (!s || s.length > Math.ceil(PAPER_MAX / 3) * 4 + 8 || !/^[A-Za-z0-9+/=\s]+$/.test(s)) return { error: 'Choose a PDF of 4 MB or less.' };
  const bytes = Buffer.from(s, 'base64'); if (bytes.length < 200 || bytes.length > PAPER_MAX) return { error: 'Choose a PDF of 4 MB or less.' };
  if (bytes.slice(0, 5).toString('latin1') !== '%PDF-') return { error: 'That file is not a PDF.' };
  return { bytes, sha256: require('crypto').createHash('sha256').update(bytes).digest('hex') };
}
async function putNew(path, bytes) {   // x-upsert false: a stored document is never overwritten
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, { method: 'POST', headers: { ...H(), 'content-type': 'application/pdf', 'x-upsert': 'false' }, body: bytes });
  if (r.status === 409 || r.status === 400) { const t = await r.text().catch(() => ''); if (/exists|Duplicate/i.test(t)) return path; const e = new Error('storage ' + r.status); e.status = 502; throw e; }
  if (!r.ok) { const e = new Error('storage ' + r.status); e.status = 502; throw e; }
  return path;
}
/* every stored file of one application (its own folder) */
async function listFiles(app) {
  const prefix = `${app.dealer_id}/${app.id}/`; const out = [];
  for (let off = 0; ; off += 100) {
    const r = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${BUCKET}`, { method: 'POST', headers: { ...H(), 'content-type': 'application/json' }, body: JSON.stringify({ prefix, limit: 100, offset: off }) });
    if (!r.ok) { const e = new Error('storage list ' + r.status); e.status = 502; throw e; }
    const j = await r.json(); for (const f of j || []) if (f && f.name && f.id) out.push(prefix + f.name);
    if (!j || j.length < 100) return out;
  }
}
async function removeFiles(paths) {
  for (let i = 0; i < paths.length; i += 100) {
    const r = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}`, { method: 'DELETE', headers: { ...H(), 'content-type': 'application/json' }, body: JSON.stringify({ prefixes: paths.slice(i, i + 100) }) });
    if (!r.ok) { const e = new Error('storage delete ' + r.status); e.status = 502; throw e; }
  }
}
/* today in Chicago, YYYY-MM-DD (retention dates are calendar dates) */
function chicagoToday(now) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now || new Date()); }
/* Documenso Free usage: signing slots per Chicago month for the last n months (reserved less released) */
async function usageByMonth(n) {
  const since = new Date(Date.now() - (n || 6) * 31 * 864e5).toISOString();
  const r = await sb('GET', `dealer_application_events?action=in.(slot_reserved,slot_released)&at=gte.${enc(since)}&select=at,action&order=at.asc&limit=5000`);
  const m = {}; const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit' });
  for (const e of r || []) { const k = fmt.format(new Date(e.at)); m[k] = (m[k] || 0) + (e.action === 'slot_reserved' ? 1 : -1); }
  return Object.keys(m).sort().slice(-(n || 6)).map((k) => ({ month: k, used: Math.max(0, m[k]) }));
}
module.exports = { sb, getApp, event, update, envelopesThisMonth, chicagoMonthStart, putFile, signedLink, finalize, notifyPresident, SEL, FREE_MONTHLY, MISSING, BUCKET, CRYPTO, DS,
  paperPdf, putNew, listFiles, removeFiles, chicagoToday, usageByMonth, PAPER_MAX };
