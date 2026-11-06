// C3-07 Stage 5 — MANUFACTURER APPLICATIONS review (Connect 360, President ONLY — owner D5, 2026-11-05).
// The President reviews each signed application privately, downloads the signed PDF / signing certificate / audit log
// through two-minute links, and records what HE did: "sent to the manufacturer" (he sends it himself — nothing here ever
// sends an application), then the manufacturer's answer. Approving here records the outcome only; it changes no ordering
// access or account number (those stay in Dealer Manager → Account changes, verified by HCPS).
//   POST + Bearer <staff JWT>:
//     {action:"list", status?}                    -> {ok, applications, monthly}
//     {action:"get", id}                          -> {ok, application (answers decrypted), events, files:{signed,certificate,audit}}
//     {action:"set_status", id, version, status, notes?}   status ∈ under_review | sent_to_manufacturer | approved | declined
//     {action:"retry_signing", id}                -> moves a queued / failed application back to draft for the dealer to sign
// D5: retention 7 years from the decision (retention_until); every action is in dealer_application_events.
const F = require('./_app_forms.js');
const PDF = require('./_app_pdf.js');
const S = require('./_app_store.js');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const json = (c, o) => ({ statusCode: c, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(o) });
const enc = encodeURIComponent;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NEXT = { signed: ['under_review', 'sent_to_manufacturer', 'declined'],
  under_review: ['sent_to_manufacturer', 'declined'], sent_to_manufacturer: ['approved', 'declined'] };

async function whoami(event) {
  const tok = String(event.headers['authorization'] || event.headers['Authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  if (!tok) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${tok}` } });
    if (!r.ok) return null; const u = await r.json(); const email = u && u.email && String(u.email).toLowerCase(); if (!email) return null;
    const s = await S.sb('GET', `staff_users?email=eq.${enc(email)}&select=email,role,active`); const su = s && s[0];
    return su && su.active !== false ? { email, role: String(su.role || 'rep').toLowerCase() } : null;
  } catch (e) { return null; }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'POST only' });
  if (!SUPABASE_URL || !SERVICE_ROLE) return json(500, { ok: false, error: 'not configured' });
  const me = await whoami(event);
  if (!me) return json(401, { ok: false, error: 'Please sign in again.' });
  if (me.role !== 'president') return json(403, { ok: false, error: 'Manufacturer applications are visible to the President only.' });
  let b; try { b = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { ok: false, error: 'bad JSON' }); }
  const by = 'staff:' + me.email;
  try {
    if (b.action === 'list') {
      const st = String(b.status || ''); const filt = /^[a-z_]{3,30}$/.test(st) ? `&status=eq.${st}` : '&status=neq.withdrawn';
      const rows = await S.sb('GET', `dealer_applications?select=id,dealer_id,location_id,manufacturer,status,business_name,signer_name,signed_at,submitted_at,updated_at,decided_at,version${filt}&order=updated_at.desc&limit=300`);
      const ids = [...new Set((rows || []).flatMap((r) => [r.dealer_id, r.location_id]))];
      const ds = ids.length ? await S.sb('GET', `dealers?id=in.(${ids.map(enc).join(',')})&select=id,business_name,city,state`) : [];
      const dn = new Map((ds || []).map((d) => [String(d.id), d]));
      let monthly = null; try { monthly = { used: await S.envelopesThisMonth(), limit: S.FREE_MONTHLY }; } catch (e) {}
      return json(200, { ok: true, monthly, signing: S.DS.configured(), applications: (rows || []).map((r) => ({ ...r, name: (F.FORMS[r.manufacturer] || {}).name || r.manufacturer,
        location: dn.get(String(r.location_id)) || null, company: dn.get(String(r.dealer_id)) || null })) });
    }
    if (b.action === 'forms_check') {   // read-only: every bundled original form is present, unchanged and buildable (synthetic answers)
      const out = [];
      for (const k of Object.keys(F.FORMS)) {
        try { const r = await PDF.build(k, { 'biz.legal_name': 'Forms check (synthetic)', 'signer.name': 'Test Signer', 'signer.title': 'Test' }, { preview: true }); out.push({ form: k, ok: true, pages: r.pages }); }
        catch (e) { out.push({ form: k, ok: false, error: e.code || 'build_failed' }); }
      }
      return json(200, { ok: out.every((x) => x.ok), forms: out, signing: S.DS.configured(), encryption: S.CRYPTO.available(), webhook_secret: (process.env.DOCUMENSO_WEBHOOK_SECRET || '').length >= 16 });
    }
    if (!UUID.test(String(b.id || ''))) return json(404, { ok: false, error: 'Unknown application.' });
    const app = await S.getApp(b.id); if (!app) return json(404, { ok: false, error: 'Unknown application.' });

    if (b.action === 'get') {
      const answers = S.CRYPTO.open(app.answers_enc, 'app:' + app.id) || {};
      const ev = await S.sb('GET', `dealer_application_events?application_id=eq.${enc(app.id)}&select=at,actor,action,detail&order=at.asc&limit=200`);
      const files = {};
      for (const [k, p] of [['signed', app.signed_path], ['certificate', app.certificate_path], ['audit', app.audit_path]]) if (p) files[k] = await S.signedLink(p, 120);
      await S.event(app.id, by, 'viewed', {});
      const { answers_enc, signing_token_enc, ...rest } = app;
      return json(200, { ok: true, application: { ...rest, name: (F.FORMS[app.manufacturer] || {}).name || app.manufacturer }, answers,
        sections: F.SECTIONS.map(([s, l]) => ({ title: s, fields: l.map(([k, label]) => ({ key: k, label })) })), events: ev || [], files, next: NEXT[app.status] || [] });
    }
    if (b.action === 'preview') {   // the completed original as the dealer saw it (before signing)
      const r = await PDF.build(app.manufacturer, S.CRYPTO.open(app.answers_enc, 'app:' + app.id) || {}, { preview: true });
      await S.event(app.id, by, 'previewed', {});
      return json(200, { ok: true, pdf_base64: r.bytes.toString('base64') });
    }
    if (b.action === 'set_status') {
      const to = String(b.status || '');
      if (!(NEXT[app.status] || []).includes(to)) return json(400, { ok: false, error: `An application that is ${app.status.replace(/_/g, ' ')} can't be marked ${to.replace(/_/g, ' ')}.` });
      if (Number(b.version) !== app.version) return json(409, { ok: false, error: 'This application changed — reload it.' });
      const notes = b.notes == null ? app.review_notes : String(b.notes).slice(0, 4000);
      const patch = { status: to, review_notes: notes };
      if (to === 'approved' || to === 'declined') { const d = new Date(); patch.decided_at = d.toISOString(); patch.retention_until = `${d.getUTCFullYear() + 7}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`; }
      const row = await S.update(app, patch, by);
      await S.event(app.id, by, 'status', { from: app.status, to });
      return json(200, { ok: true, application: { id: row.id, status: row.status, version: row.version, decided_at: row.decided_at, retention_until: row.retention_until } });
    }
    if (b.action === 'withdraw') {
      if (['approved', 'declined', 'withdrawn'].includes(app.status)) return json(400, { ok: false, error: 'This application is already closed.' });
      if (app.status === 'signing' && app.envelope_id) { try { await S.DS.cancel(app.envelope_id); } catch (e) { /* recorded below */ } }
      const d = new Date(); const row = await S.update(app, { status: 'withdrawn', signing_token_enc: null, decided_at: d.toISOString(), retention_until: `${d.getUTCFullYear() + 7}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`, review_notes: b.notes == null ? app.review_notes : String(b.notes).slice(0, 4000) }, by);
      await S.event(app.id, by, 'withdrawn_by_hcps', { from: app.status });
      return json(200, { ok: true, application: { id: row.id, status: row.status, version: row.version } });
    }
    if (b.action === 'retry_signing') {
      if (!['queued', 'signing_failed'].includes(app.status)) return json(400, { ok: false, error: 'Only a waiting or failed signature can be sent back to the dealer.' });
      const row = await S.update(app, { status: 'draft', signing_token_enc: null }, by);
      await S.event(app.id, by, 'back_to_dealer', { from: app.status });
      return json(200, { ok: true, application: { id: row.id, status: row.status, version: row.version } });
    }
    return json(400, { ok: false, error: 'unknown action' });
  } catch (e) {
    if (S.MISSING(e)) return json(503, { ok: false, error: 'Manufacturer applications open shortly.' });
    if (e && e.code === 'no_key') return json(503, { ok: false, error: 'The applications encryption key is not set yet.' });
    if (e && e.status === 409) return json(409, { ok: false, error: 'This application changed — reload it.' });
    console.error('applications admin failed', e && (e.code || e.status));
    return json(503, { ok: false, error: 'That could not be completed just now — please try again.' });
  }
};
