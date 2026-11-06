/* C3-07 Stage 5 (D1) — Documenso FREE cloud plan, API v2 (https://app.documenso.com/api/v2), team token in
   DOCUMENSO_API_TOKEN (a Netlify environment variable Angelo sets; never in the repo, a log or the browser).
   The free plan allows about 5 documents a month; at the limit Documenso refuses (it never charges) — the caller queues the
   application and offers the manual (OpenSign / wet-signature) route instead.
   Envelopes are created with distributionMethod NONE: Documenso sends no email; the dealer signs through the link HCPS
   shows (https://app.documenso.com/sign/<recipient token>). Completed documents are fetched by HCPS (signed PDF + signing
   certificate + audit log) — webhook payloads are never trusted, the envelope is re-read from the API. */
const BASE = (process.env.DOCUMENSO_API_URL || 'https://app.documenso.com/api/v2').replace(/\/+$/, '');
const SIGN_BASE = (process.env.DOCUMENSO_SIGN_URL || 'https://app.documenso.com/sign').replace(/\/+$/, '');
const configured = () => !!process.env.DOCUMENSO_API_TOKEN;
const hdr = () => ({ Authorization: process.env.DOCUMENSO_API_TOKEN });

async function call(method, path, body, raw) {
  const r = await fetch(BASE + path, { method, headers: Object.assign(hdr(), body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
    body: body ? (body instanceof FormData ? body : JSON.stringify(body)) : undefined });
  if (raw) { if (!r.ok) throw httpErr(r.status, await r.text().catch(() => '')); return Buffer.from(await r.arrayBuffer()); }
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (e) {}
  if (!r.ok) throw httpErr(r.status, t);
  return j;
}
function httpErr(status, text) {
  const e = new Error('documenso ' + status); e.status = status;
  const s = String(text || '');
  /* the free plan's monthly document limit: a refusal that says so (never a 429 rate limit, never a validation error) */
  e.limit = status === 402 || ((status === 400 || status === 403) && /(document|monthly|plan)[^\n]{0,40}limit|limit[^\n]{0,40}(document|month|plan)|upgrade/i.test(s));
  e.detail = s.replace(/api_[A-Za-z0-9]+/g, 'api_***').slice(0, 300);
  return e;
}

/* create a DOCUMENT envelope from the completed PDF with ONE signer and its fields; returns { envelopeId, token, url } */
async function createForSigning({ title, pdf, signer, fields, externalId, redirectUrl }) {
  const payload = { type: 'DOCUMENT', title: String(title).slice(0, 250), externalId,
    meta: { distributionMethod: 'NONE', timezone: 'America/Chicago', dateFormat: 'MM/dd/yyyy', redirectUrl: redirectUrl || undefined, typedSignatureEnabled: true, drawSignatureEnabled: true, uploadSignatureEnabled: false,
      /* D5: no Documenso email at all — the signed PDF (with the dealer's credit details) never travels by email; HCPS fetches it */
      emailSettings: { recipientSigningRequest: false, recipientRemoved: false, recipientSigned: false, documentPending: false, documentCompleted: false, documentDeleted: false,
        ownerDocumentCompleted: false, ownerRecipientExpired: false, ownerDocumentCreated: false } },
    recipients: [{ email: signer.email, name: signer.name, role: 'SIGNER', signingOrder: 1, fields: fields.map((f) => Object.assign({ identifier: 0 }, f)) }] };
  const fd = new FormData();
  fd.append('payload', JSON.stringify(payload));
  fd.append('files', new Blob([pdf], { type: 'application/pdf' }), 'application.pdf');
  const created = await call('POST', '/envelope/create', fd);
  const envelopeId = created && (created.id || created.envelopeId);
  if (!envelopeId) throw httpErr(502, 'no envelope id');
  let dist; try { dist = await call('POST', '/envelope/distribute', { envelopeId, meta: { distributionMethod: 'NONE' } }); } catch (e) { e.envelopeId = envelopeId; throw e; }
  let rs = (dist && dist.recipients) || null;
  if (!rs || !rs.length) rs = ((await getEnvelope(envelopeId)) || {}).recipients || [];
  const r = rs.find((x) => String(x.email).toLowerCase() === String(signer.email).toLowerCase()) || rs[0];
  if (!r || !r.token) throw httpErr(502, 'no signing token');
  const url = r.signingUrl && /^https:\/\//.test(r.signingUrl) ? r.signingUrl : signUrl(r.token);
  return { envelopeId, token: r.token, url };
}
const signUrl = (token) => `${SIGN_BASE}/${encodeURIComponent(token)}`;
const getEnvelope = (id) => call('GET', '/envelope/' + encodeURIComponent(id));
const downloadItem = (itemId, version) => call('GET', `/envelope/item/${encodeURIComponent(itemId)}/download?version=${version || 'signed'}`, null, true);
const downloadCertificate = (id) => call('GET', `/envelope/${encodeURIComponent(id)}/certificate/download`, null, true);
const downloadAudit = (id) => call('GET', `/envelope/${encodeURIComponent(id)}/audit-log/download`, null, true);
const cancel = (envelopeId) => call('POST', '/envelope/cancel', { envelopeId });

module.exports = { configured, createForSigning, getEnvelope, downloadItem, downloadCertificate, downloadAudit, cancel, signUrl, BASE };
