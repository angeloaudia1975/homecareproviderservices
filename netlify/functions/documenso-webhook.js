// C3-07 Stage 5 — Documenso webhook (signing events for manufacturer applications).
// Documenso sends the shared secret in the X-Documenso-Secret header (a plain secret, not an HMAC — docs.documenso.com,
// "Webhook verification"); it is compared in constant time with DOCUMENSO_WEBHOOK_SECRET (set by Angelo in Netlify and in
// Documenso; never viewed, logged or committed). No secret configured → every call is refused (fail closed).
// The payload is used ONLY to find which application to look at: the envelope is then re-read from Documenso's API
// (_app_store.finalize) — a forged or replayed payload can at most make HCPS re-check a real envelope.
const crypto = require('crypto');
const S = require('./_app_store.js');
const json = (c, o) => ({ statusCode: c, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(o) });
const ENV_ID = /^[A-Za-z0-9_-]{4,80}$/;

function secretOk(event) {
  const want = process.env.DOCUMENSO_WEBHOOK_SECRET || '';
  const got = String((event.headers || {})['x-documenso-secret'] || (event.headers || {})['X-Documenso-Secret'] || '');
  if (want.length < 16 || !got) return false;
  const a = crypto.createHash('sha256').update(want).digest(), b = crypto.createHash('sha256').update(got).digest();
  return crypto.timingSafeEqual(a, b);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false });
  if (!secretOk(event)) return json(401, { ok: false });
  let b; try { b = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { ok: false }); }
  const kind = String(b.event || '').toUpperCase();
  const p = b.payload || {};
  const envelopeId = String(p.envelopeId || (Array.isArray(p.recipients) && p.recipients[0] && p.recipients[0].envelopeId) || '');
  if (!ENV_ID.test(envelopeId) && !/^[0-9a-f-]{36}$/i.test(String(p.externalId || ''))) return json(200, { ok: true, ignored: 'no envelope' });
  try {
    const rows = await S.sb('GET', `dealer_applications?envelope_id=eq.${encodeURIComponent(envelopeId)}&select=${S.SEL}`);
    let app = rows && rows[0];
    /* the envelope id is the link; an externalId (our application id) is only a hint to find a row whose OWN stored
       envelope is then re-read — never the payload's */
    if (!app && /^[0-9a-f-]{36}$/i.test(String(p.externalId || ''))) { const r2 = await S.getApp(p.externalId); if (r2 && r2.envelope_id) app = r2; }
    if (!app) return json(200, { ok: true, ignored: 'not an application' });   // other Documenso documents are not ours
    if (/COMPLETED/.test(kind)) { const r = await S.finalize(app, 'documenso', app.envelope_id); return json(200, { ok: true, state: r.ok ? 'signed' : r.reason }); }
    if (/REJECTED|CANCELLED|EXPIRED/.test(kind) && app.status === 'signing') {
      /* re-read: only a status Documenso itself reports changes the application */
      const env = await S.DS.getEnvelope(app.envelope_id);
      const rejected = (env.recipients || []).some((r) => r.signingStatus === 'REJECTED');
      if (rejected || ['CANCELLED', 'REJECTED'].includes(env.status) || (env.recipients || []).some((r) => r.expired)) {
        await S.update(app, { status: 'signing_failed', signing_token_enc: null }, 'documenso');
        await S.event(app.id, 'documenso', 'signing_stopped', { event: kind.slice(0, 40), status: String(env.status || '').slice(0, 20) });
      }
      return json(200, { ok: true });
    }
    await S.event(app.id, 'documenso', 'webhook', { event: kind.slice(0, 40) });
    return json(200, { ok: true });
  } catch (e) {
    console.error('documenso webhook failed', e && (e.status || e.code));
    return json(503, { ok: false });   // Documenso retries
  }
};
module.exports._secretOk = secretOk;
