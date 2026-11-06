// C3-07 Stage 5 — MANUFACTURER ACCOUNT SETUP CENTER (dealer side): complete a manufacturer's ORIGINAL credit / dealer
// application in the 360 Dealer Portal, save and resume, review the completed PDF, sign it electronically (Documenso Free),
// and HCPS's President reviews it privately. NOTHING is ever sent to a manufacturer automatically, and no manufacturer
// account is ever approved automatically (owner D1 / D5, 2026-11-05).
//
//   POST + Bearer <dealer JWT>:
//     {action:"app_list"}                                    -> {ok, forms, locations, signing, monthly}
//     {action:"app_start", manufacturer, location_id?}       -> {ok, application}       (prefilled from HCPS's records; one open per location + line)
//     {action:"app_get", id}                                 -> {ok, application, sections}
//     {action:"app_save", id, version, answers}              -> {ok, application}       (stale version → 409)
//     {action:"app_preview", id}                             -> {ok, pdf_base64}        (the completed original, "Sign here" boxes shown)
//     {action:"app_sign", id, version}                       -> {ok, url} | {ok, queued}  (free monthly limit reached → queued, HCPS told)
//     {action:"app_signing_link", id}                        -> {ok, url}
//     {action:"app_refresh", id}                             -> {ok, application}       (checks a pending signature with Documenso)
//     {action:"app_offline", id}                             -> {ok, pdf_base64}        (print, sign by hand, return it to HCPS)
//     {action:"app_withdraw", id}                            -> {ok}
// Locations (D2): a head office for any of its visible locations; a branch only its own; never another dealer.
// Privacy (D5): answers are stored only encrypted (_app_crypto.js), never logged, never emailed; the event log holds no answers.
// ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE, APPLICATIONS_ENC_KEY, DOCUMENSO_API_TOKEN (optional until signing is on).
const AC = require('./_account_center.js');
const F = require('./_app_forms.js');
const PDF = require('./_app_pdf.js');
const S = require('./_app_store.js');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type, authorization' };
const json = (c, o) => ({ statusCode: c, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS }, body: JSON.stringify(o) });
const enc = encodeURIComponent;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const NOT_YET = 'Manufacturer applications open shortly.';
const OPEN = new Set(['draft', 'queued', 'signing_failed']);           // the dealer may still edit
const ACTIVE = ['draft', 'queued', 'signing', 'signing_failed', 'signed', 'offline_signed', 'under_review', 'sent_to_manufacturer'];
const RETIRED = new Set(['ohio-medical', 'gce', 'complete-medical-supplies']);

async function dealerFromToken(event) {
  const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
  const tok = auth.replace(/^Bearer\s+/i, ''); if (!tok) return null;
  const ur = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${tok}` } });
  if (!ur.ok) return null;
  const u = await ur.json();
  const rows = await S.sb('GET', `dealer_users?uid=eq.${enc(u.id)}&select=status,dealer_id,email`);
  const du = rows && rows[0];
  if (!du || du.status !== 'approved' || !du.dealer_id) return null;
  return { dealer_id: du.dealer_id, email: String(du.email || u.email || '').trim(), uid: u.id };
}
async function sbOpt(path) { try { return await S.sb('GET', path); } catch (e) { if (/42703|PGRST204/.test(String(e.message))) return null; throw e; } }

/* answers: only known keys, short strings, no control characters */
function cleanAnswers(input) {
  const out = {}; const src = input && typeof input === 'object' ? input : {};
  for (const [k, v] of Object.entries(src)) {
    if (!F.FIELDS.has(k)) continue;
    let s = String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, k === 'req.notes' ? 1000 : 200);
    if (k === 'biz.entity' && s && !F.ENTITIES[s]) s = '';
    if (s) out[k] = s;
  }
  return out;
}
function missing(a) {
  const m = []; for (const f of F.FIELDS.values()) if (f.required && !a[f.key]) m.push(f.label);
  if (a['signer.email'] && !EMAIL_RE.test(a['signer.email'])) m.push('a valid signer email');
  return m;
}
const pub = (app, names, answers) => app && ({ id: app.id, manufacturer: app.manufacturer, name: (F.FORMS[app.manufacturer] || {}).name || app.manufacturer, location_id: app.location_id,
  location_name: (names && names.get(String(app.location_id))) || '', status: app.status, version: app.version, business_name: app.business_name || '', signer_name: app.signer_name || '',
  signed_at: app.signed_at, submitted_at: app.submitted_at, updated_at: app.updated_at, answers: answers || undefined });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'method not allowed' });
  if (!SUPABASE_URL || !SERVICE_ROLE) return json(500, { ok: false, error: 'not configured' });
  let b; try { b = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { ok: false, error: 'bad JSON' }); }
  let who; try { who = await dealerFromToken(event); } catch (e) { return json(503, { ok: false, error: 'Please try again in a moment.' }); }
  if (!who) return json(401, { ok: false, error: 'Please sign in again.' });
  const did = who.dealer_id;

  let visible, self, family;
  try {
    const d = await S.sb('GET', `dealers?id=eq.${enc(did)}&select=id,parent_id,business_name`); self = d && d[0];
    if (!self) return json(404, { ok: false, error: 'Account not found.' });
    const root = self.parent_id || self.id;
    const fq = `dealers?or=(id.eq.${enc(root)},parent_id.eq.${enc(root)})&select=id,parent_id,business_name`;
    family = await sbOpt(fq + ',active&limit=200'); if (family == null) family = await S.sb('GET', fq + '&limit=200');
    family = (family || []).filter((x) => x.active !== false || String(x.id) === String(did));
    let scopeRow = null;
    try { const s = await S.sb('GET', `dealer_user_scope?uid=eq.${enc(who.uid)}&select=scope,locations`); scopeRow = (s && s[0]) || null; }
    catch (e) { if (!/PGRST205|42P01/.test(String(e.message))) throw e; }
    visible = AC.visibleLocations(did, family, scopeRow);
  } catch (e) { console.error('application scope read failed', e && e.status); return json(503, { ok: false, error: 'Your applications could not be loaded just now — please try again.' }); }
  const headOffice = !self.parent_id;   // a head office narrowed to its own location still sees only that one (visible)
  const owner = String(self.parent_id || self.id);
  const names = new Map(visible.map((v) => [String(v.id), v.business_name || '']));
  const mayRead = (loc) => names.has(String(loc));
  const mayWrite = (loc) => mayRead(loc) && (headOffice || String(loc) === String(did));
  const by = 'dealer:' + (who.email || who.uid);
  if (!S.CRYPTO.available()) return json(503, { ok: false, error: NOT_YET });

  const load = async (id) => {
    if (!UUID.test(String(id || ''))) return { status: 404, error: "That application isn't available." };
    const a = await S.getApp(id);
    if (!a || String(a.dealer_id) !== owner || !mayRead(a.location_id)) return { status: 404, error: "That application isn't available." };
    return { a };
  };
  const answersOf = (a) => S.CRYPTO.open(a.answers_enc, 'app:' + a.id) || {};

  try {
    if (b.action === 'app_list') {
      const locs = [...names.keys()].map(enc).join(',');
      const rows = await S.sb('GET', `dealer_applications?dealer_id=eq.${enc(owner)}&location_id=in.(${locs})&select=id,location_id,manufacturer,status,version,updated_at,signed_at&order=updated_at.desc&limit=200`);
      let off = new Set(); try { const m = await S.sb('GET', 'manufacturer_meta?select=slug,active'); off = new Set((m || []).filter((x) => x.active === false).map((x) => x.slug)); } catch (e) { /* none hidden */ }
      const forms = Object.entries(F.FORMS).filter(([k]) => !off.has(k)).map(([k, f]) => ({ slug: k, name: f.name, mode: f.mode, notice: f.notice || '' }))
        .concat(Object.entries(F.EXTERNAL).filter(([k]) => !RETIRED.has(k) && !off.has(k)).map(([k, x]) => ({ slug: k, name: x.name, external: { how: x.how, url: x.url } })))
        .sort((x, y) => x.name.localeCompare(y.name));
      let monthly = null; try { monthly = { used: await S.envelopesThisMonth(), limit: S.FREE_MONTHLY }; } catch (e) { /* shown as unknown */ }
      return json(200, { ok: true, head_office: headOffice, self_id: String(did), forms, signing: S.DS.configured(), monthly,
        locations: visible.map((v) => ({ id: String(v.id), name: v.business_name || '', can_apply: mayWrite(v.id) })),
        applications: (rows || []).map((a) => pub(a, names)) });
    }

    if (b.action === 'app_start') {
      const m = String(b.manufacturer || ''); const form = F.FORMS[m];
      if (!form) return json(400, { ok: false, error: F.EXTERNAL[m] ? 'This manufacturer uses its own application — use the link shown.' : 'Unknown manufacturer.' });
      const loc = String(b.location_id || did);
      if (!mayWrite(loc)) return json(403, { ok: false, error: "You can't apply for that location." });
      const open = await S.sb('GET', `dealer_applications?location_id=eq.${enc(loc)}&manufacturer=eq.${enc(m)}&status=in.(${ACTIVE.join(',')})&select=${S.SEL}`);
      if (open && open[0]) return json(200, { ok: true, application: pub(open[0], names), existing: true });
      const answers = await prefill(loc, owner, who);
      const id = require('crypto').randomUUID();
      const row = { id, dealer_id: owner, location_id: loc, manufacturer: m, form_sha256: form.sha256, status: 'draft', version: 1, answers_enc: S.CRYPTO.seal(answers, 'app:' + id),
        business_name: (answers['biz.legal_name'] || '').slice(0, 160) || null, signer_name: null, signer_email: null, created_by: by, updated_by: by };
      let ins;
      try { ins = await S.sb('POST', 'dealer_applications', row, { Prefer: 'return=representation' }); }
      catch (e) { if (e.status === 409) return json(409, { ok: false, error: 'An application for this manufacturer is already open — reload.' }); throw e; }
      await S.event(id, by, 'started', { manufacturer: m, location: loc });
      return json(200, { ok: true, application: pub(ins[0], names) });
    }

    const L = await load(b.id); if (L.error) return json(L.status, { ok: false, error: L.error });
    const app = L.a; const form = F.FORMS[app.manufacturer];

    if (b.action === 'app_get') {
      const ans = answersOf(app);
      return json(200, { ok: true, application: pub(app, names, ans), sections: F.SECTIONS.map(([s, l]) => ({ title: s, fields: l.map(([k, label, r]) => ({ key: k, label, required: r === 'req' })) })),
        entities: F.ENTITIES, notice: (form && form.notice) || '', can_edit: mayWrite(app.location_id) && OPEN.has(app.status), signing: S.DS.configured() });
    }
    if (!mayWrite(app.location_id)) return json(403, { ok: false, error: "You can't change that location's applications." });

    if (b.action === 'app_save') {
      if (!OPEN.has(app.status)) return json(409, { ok: false, error: 'This application is already with the signer or HCPS — it can no longer be edited.' });
      if (Number(b.version) !== app.version) return json(409, { ok: false, error: 'This application was changed somewhere else — reopen it.' });
      const ans = cleanAnswers(b.answers);
      const row = await S.update(app, { answers_enc: S.CRYPTO.seal(ans, 'app:' + app.id), status: 'draft', business_name: (ans['biz.legal_name'] || '').slice(0, 160) || null,
        signer_name: (ans['signer.name'] || '').slice(0, 120) || null, signer_email: (ans['signer.email'] || '').slice(0, 200) || null }, by);
      await S.event(app.id, by, 'saved', { fields: Object.keys(ans).length });
      return json(200, { ok: true, application: pub(row, names), missing: missing(ans) });
    }
    if (b.action === 'app_preview' || b.action === 'app_offline') {
      const r = await PDF.build(app.manufacturer, answersOf(app), { preview: b.action === 'app_preview' });
      if (b.action === 'app_offline') await S.event(app.id, by, 'offline_copy', { sha256: r.sha256 });
      return json(200, { ok: true, pdf_base64: r.bytes.toString('base64'), pages: r.pages, file: `${app.manufacturer}-application.pdf` });
    }
    if (b.action === 'app_sign') {
      if (!OPEN.has(app.status)) return json(409, { ok: false, error: 'This application is already with the signer or HCPS.' });
      if (Number(b.version) !== app.version) return json(409, { ok: false, error: 'This application was changed somewhere else — reopen it.' });
      const ans = answersOf(app); const miss = missing(ans);
      if (miss.length) return json(400, { ok: false, error: 'Please complete: ' + miss.slice(0, 6).join(', ') + (miss.length > 6 ? '…' : ''), missing: miss });
      if (!S.DS.configured()) return json(503, { ok: false, error: 'Electronic signing opens shortly — you can print the completed application and sign it by hand meanwhile.' });
      const used = await S.envelopesThisMonth();
      if (used >= S.FREE_MONTHLY) {
        const row = await S.update(app, { status: 'queued', submitted_at: new Date().toISOString() }, by);
        await S.event(app.id, by, 'queued', { reason: 'monthly_limit', used });
        await S.notifyPresident(row, 'queued').catch(() => {});
        return json(200, { ok: true, queued: true, application: pub(row, names) });
      }
      const built = await PDF.build(app.manufacturer, ans, { preview: false });
      const fields = []
        .concat((form.sign || []).map((b2) => Object.assign({ type: 'SIGNATURE' }, b2)))
        .concat([...(form.date || []), ...(form.dateTop || [])].map((b2) => Object.assign({ type: 'DATE' }, b2)))
        .concat((form.signerText || []).map((t) => ({ type: 'TEXT', page: t.page, positionX: t.positionX, positionY: t.positionY, width: t.width, height: t.height, fieldMeta: { type: 'text', label: t.label, required: false, fontSize: 9 } })));
      let created;
      try {
        created = await S.DS.createForSigning({ title: `${form.name} application — ${ans['biz.legal_name']}`, pdf: built.bytes, signer: { name: ans['signer.name'], email: ans['signer.email'] }, fields, externalId: app.id,
          redirectUrl: process.env.APPLICATIONS_RETURN_URL || 'https://hcpsonlineordering.netlify.app/#account' });
      } catch (e) {
        if (e.limit) {
          const row = await S.update(app, { status: 'queued', submitted_at: new Date().toISOString() }, by);
          await S.event(app.id, by, 'queued', { reason: 'provider_limit', status: e.status });
          await S.notifyPresident(row, 'queued').catch(() => {});
          return json(200, { ok: true, queued: true, application: pub(row, names) });
        }
        console.error('documenso create failed', e.status);
        await S.event(app.id, by, 'signing_error', { status: e.status || 0 });
        return json(502, { ok: false, error: 'The signing service could not be reached — please try again in a few minutes.' });
      }
      await S.event(app.id, by, 'envelope_created', { envelope: created.envelopeId, sent_sha256: built.sha256, pages: built.pages });
      const row = await S.update(app, { status: 'signing', envelope_id: created.envelopeId, signing_token_enc: S.CRYPTO.seal({ t: created.token, u: created.url }, 'tok:' + app.id),
        sent_pdf_sha256: built.sha256, submitted_at: new Date().toISOString() }, by);
      return json(200, { ok: true, url: created.url, application: pub(row, names) });
    }
    if (b.action === 'app_signing_link') {
      if (app.status !== 'signing' || !app.signing_token_enc) return json(409, { ok: false, error: 'There is nothing waiting to be signed.' });
      const t = S.CRYPTO.open(app.signing_token_enc, 'tok:' + app.id) || {};
      return json(200, { ok: true, url: t.u || S.DS.signUrl(t.t) });
    }
    if (b.action === 'app_refresh') {
      if (app.status !== 'signing') return json(200, { ok: true, application: pub(app, names) });
      const r = await S.finalize(app, by);
      return json(200, { ok: true, application: pub(r.application || (await S.getApp(app.id)), names), state: r.reason || (r.ok ? 'signed' : '') });
    }
    if (b.action === 'app_withdraw') {
      if (!['draft', 'queued', 'signing', 'signing_failed'].includes(app.status)) return json(409, { ok: false, error: 'This application is already with HCPS — ask HCPS to withdraw it.' });
      if (app.status === 'signing' && app.envelope_id) { try { await S.DS.cancel(app.envelope_id); } catch (e) { /* recorded */ } }
      await S.update(app, { status: 'withdrawn', signing_token_enc: null }, by);
      await S.event(app.id, by, 'withdrawn', {});
      return json(200, { ok: true });
    }
    return json(400, { ok: false, error: 'unknown action' });
  } catch (e) {
    if (S.MISSING(e)) return json(503, { ok: false, error: NOT_YET });
    if (e && e.status === 409) return json(409, { ok: false, error: 'This application was changed somewhere else — reopen it.' });
    if (e && (e.code === 'form_changed' || e.code === 'form_missing')) return json(503, { ok: false, error: 'This manufacturer’s application form was updated — HCPS is reviewing it. Please try again later.' });
    console.error('applications failed', e && (e.code || e.status));   // never the answers
    return json(503, { ok: false, error: 'That could not be completed just now — please try again.' });
  }
};

/* the dealer's details already on file at HCPS — the dealer reviews and corrects them before signing */
async function prefill(loc, owner, who) {
  const a = {};
  const d = (await S.sb('GET', `dealers?id=eq.${enc(loc)}&select=business_name,address,city,state,zip,phone,email,contact_name`) || [])[0] || {};
  const w = await sbOpt(`dealers?id=eq.${enc(loc)}&select=website`);
  Object.assign(a, { 'biz.legal_name': d.business_name, 'biz.address': d.address, 'biz.city': d.city, 'biz.state': d.state, 'biz.zip': d.zip, 'biz.phone': d.phone, 'biz.email': d.email,
    'biz.website': w && w[0] && w[0].website, 'signer.email': who.email });
  try {
    const ad = await S.sb('GET', `dealer_addresses?dealer_id=eq.${enc(loc)}&select=addr_key,address,city,state,zip,pri&order=pri.asc`);
    const ship = (ad || []).find((x) => /^ship/.test(x.addr_key || ''));
    if (ship) Object.assign(a, { 'ship.address': ship.address, 'ship.city': ship.city, 'ship.state': ship.state, 'ship.zip': ship.zip });
  } catch (e) { /* none on file */ }
  return cleanAnswers(a);
}

module.exports._cleanAnswers = cleanAnswers;
module.exports._missing = missing;
