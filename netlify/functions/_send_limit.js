/* LIMITS ON DOCUMENTS A DEALER EMAILS (C3-07 Stage 4, owner 2026-11-05). Brochures (and, later, quotes) go out from an
   HCPS address, so a signed-in dealer could still be used to send a flood. Each send is checked AND recorded in ONE atomic
   database step, dealer_document_send_reserve (per-dealer advisory lock — simultaneous sends can't slip past), before it
   is sent, and refused past:  10 per dealer per hour · 40 per dealer per 24 hours · 5 to the same recipient per 24 hours.
   The recipient is stored as its DOMAIN and a SHA-256 of the normalised address (lower-case, "+tag" removed, Gmail dots
   removed), never the address. A send the provider refused is marked failed and does not count. Anything that can't be
   checked refuses the send (fail closed) — including a database without the reserve function: the Stage 4 SQL is
   installed in production (verified 2026-11-05), so a missing function now means something is wrong, never "send anyway".
   Identical copy in both repos (homecareproviderservices: quotes; homecareproviderservicesordering: brochures). */
const crypto = require('crypto');
const LIMITS = { hour: 10, day: 40, recipient: 5 };
/* only "this function / table does not exist" — never a column, role or any other error */
const NOT_INSTALLED = s => /PGRST202|42883/.test(String(s || '')) && /dealer_document_send_reserve/.test(String(s || ''));

function normaliseEmail(to) {
  let [local, domain] = String(to || '').trim().toLowerCase().split('@');
  local = (local || '').split('+')[0];
  if (domain === 'gmail.com' || domain === 'googlemail.com') { local = local.replace(/\./g, ''); domain = 'gmail.com'; }
  return { addr: local + '@' + (domain || ''), domain: domain || '' };
}
async function reserve({ url, key, dealer_id, kind, to }) {
  const H = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const n = normaliseEmail(to);
  const to_hash = crypto.createHash('sha256').update(n.addr).digest('hex');
  let txt = '', r;
  try {
    r = await fetch(`${url}/rest/v1/rpc/dealer_document_send_reserve`, { method: 'POST', headers: H,
      body: JSON.stringify({ p_dealer: dealer_id, p_kind: kind, p_domain: n.domain, p_hash: to_hash, p_hour: LIMITS.hour, p_day: LIMITS.day, p_recipient: LIMITS.recipient }) });
    txt = await r.text();
  } catch (e) { console.error('send limit unavailable', e && e.message); return { ok: false, status: 503, error: 'Email is unavailable for a moment — please try again.' }; }
  if (!r.ok) {
    if (NOT_INSTALLED(txt)) console.error('send limit function missing — refusing the send');
    console.error('send limit refused', r.status, txt.slice(0, 160));
    return { ok: false, status: 503, error: 'Email is unavailable for a moment — please try again.' };
  }
  let j = null; try { j = JSON.parse(txt); } catch (e) {}
  if (!j || typeof j !== 'object') return { ok: false, status: 503, error: 'Email is unavailable for a moment — please try again.' };
  if (j.ok === true) return { ok: true, id: j.id };
  const msg = j.reason === 'hour' ? `You can email up to ${LIMITS.hour} documents an hour — please try again later.`
    : j.reason === 'day' ? `You've reached today's limit of ${LIMITS.day} emailed documents.`
    : j.reason === 'recipient' ? `This recipient already received ${LIMITS.recipient} documents from you today.`
    : 'This email could not be sent.';
  return { ok: false, status: j.reason === 'bad_request' ? 400 : 429, error: msg };
}
async function markFailed({ url, key, id }) {
  if (!id) return;
  try { await fetch(`${url}/rest/v1/dealer_document_sends?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'failed' }) }); } catch (e) {}
}
module.exports = { reserve, markFailed, normaliseEmail, LIMITS };
