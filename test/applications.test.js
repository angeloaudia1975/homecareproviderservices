/* C3-07 Stage 5 — manufacturer applications: the REAL dealer-applications-api, documenso-webhook and applications-admin-api
   handlers against the in-memory PostgREST fake (phase0-mock) with Documenso, storage and email answered locally.
   Nothing reaches Supabase, Documenso or a mail provider. Synthetic dealers and answers only.
     node test/applications.test.js */
const path = require('path');
const crypto = require('crypto');
const M = require(process.env.MOCK || path.join(__dirname, 'phase0-mock.js'));
const ROOT = process.env.CAT_ROOT || path.join(__dirname, '..', 'netlify', 'functions');
let fail = 0, pass = 0;
async function t(n, f) { try { await f(); pass++; console.log('ok   ' + n); } catch (e) { fail++; console.log('FAIL ' + n + '\n     ' + (e && e.stack || e).toString().split('\n').slice(0, 3).join('\n     ')); } }
const eq = (a, b, w) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((w || '') + ' got ' + JSON.stringify(a) + ' expected ' + JSON.stringify(b)); };
const ok = (c, w) => { if (!c) throw new Error(w); };
const HQ = '11111111-1111-1111-1111-111111111111', BR = '22222222-2222-2222-2222-222222222222', BR2 = '33333333-3333-3333-3333-333333333333', OTHER = '44444444-4444-4444-4444-444444444444';
const KEY = crypto.randomBytes(32).toString('base64');
const SECRET = 'whsec-test-' + 'x'.repeat(24);
const ENV = { APPLICATIONS_ENC_KEY: KEY, DOCUMENSO_API_TOKEN: 'api_test_token', DOCUMENSO_WEBHOOK_SECRET: SECRET, RESEND_API_KEY: 're_test' };

function world(o) {
  o = o || {};
  const docs = { envelopes: {}, created: [], distributed: [], cancelled: [] };
  const stored = [], mail = [];
  const W = M.createWorld({ tokens: {}, missingTables: o.missingTables, tables: {
    dealers: [{ id: HQ, parent_id: null, business_name: 'Sample Medical HQ', address: '1 Main St', city: 'Dayton', state: 'OH', zip: '45402', phone: '555-0100', email: 'office@sample.test', website: 'sample.test' },
      { id: BR, parent_id: HQ, business_name: 'Sample Branch', city: 'Xenia', state: 'OH' }, { id: BR2, parent_id: HQ, business_name: 'Sample Two' }, { id: OTHER, parent_id: null, business_name: 'Else Co' }],
    dealer_users: [{ uid: 'u-hq', status: 'approved', dealer_id: HQ, email: 'hq@sample.test' }, { uid: 'u-br', status: 'approved', dealer_id: BR, email: 'br@sample.test' },
      { uid: 'u-ot', status: 'approved', dealer_id: OTHER, email: 'x@else.test' }],
    dealer_user_scope: [], dealer_addresses: [{ dealer_id: HQ, addr_key: 'ship-wh', address: '50 Dock Rd', city: 'Dayton', state: 'OH', zip: '45404', pri: 2 }],
    manufacturer_meta: [{ slug: 'dalton', active: true }], staff_users: [{ email: 'boss@hcps.test', role: 'president', active: true }, { email: 'rep@hcps.test', role: 'rep', active: true }],
    dealer_applications: [], dealer_application_events: o.events || [] } });
  const inner = W.fetch;
  W.fetch = async (url, opts) => {
    const u = String(url); opts = opts || {}; const hd = opts.headers || {};
    const res = (status, body, extra) => ({ ok: status < 300, status, headers: { get: (h) => (extra || {})[String(h).toLowerCase()] || null },
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), json: async () => body, arrayBuffer: async () => Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) });
    if (u.startsWith(M.BASE + '/auth/v1/user')) { const tok = String(hd.Authorization || '').replace(/^Bearer\s+/i, '');
      const map = { hq: { id: 'u-hq' }, br: { id: 'u-br' }, ot: { id: 'u-ot' }, boss: { id: 's1', email: 'boss@hcps.test' }, rep: { id: 's2', email: 'rep@hcps.test' } };
      return map[tok] ? res(200, map[tok]) : res(401, {}); }
    if (/\/rest\/v1\/dealer_application_events\?action=eq\.slot_(reserved|released)/.test(u)) {
      const act = u.match(/action=eq\.(slot_\w+)/)[1]; const dm = u.match(/detail->>dealer=eq\.([^&]+)/); W.countCalls = (W.countCalls || 0) + 1;
      if (!/at=gte\.\d{4}-\d{2}-01T0[56]%3A00%3A00/.test(u)) throw new Error('month start not a Chicago midnight: ' + u);
      const n = W.db.dealer_application_events.filter((e) => e.action === act && (!dm || e.detail.dealer === decodeURIComponent(dm[1]))).length; return res(200, [], { 'content-range': `0-0/${n}` }); }
    if (u.startsWith(M.BASE + '/storage/v1/object/sign/')) return res(200, { signedURL: '/object/sign/x?token=t' });
    if (u.startsWith(M.BASE + '/storage/v1/object/list/dealer-applications')) { if (o.listFails) return res(500, 'no'); const b = JSON.parse(opts.body);
      return res(200, stored.filter((x) => !x.deleted && x.path.startsWith(b.prefix)).map((x) => ({ name: x.path.slice(b.prefix.length), id: 'f-' + x.path }))); }
    if (u === M.BASE + '/storage/v1/object/dealer-applications' && opts.method === 'DELETE') { if (o.deleteFailsOnce && !W.delFailed) { W.delFailed = true; return res(500, 'no'); } const b = JSON.parse(opts.body); W.deletes = (W.deletes || []).concat(b.prefixes);
      for (const x of stored) if (b.prefixes.includes(x.path)) x.deleted = true; return res(200, []); }
    if (u.startsWith(M.BASE + '/storage/v1/object/dealer-applications/')) { stored.push({ path: u.split('/dealer-applications/')[1], bytes: opts.body.length, upsert: hd['x-upsert'] }); return res(200, { Key: 'k' }); }
    if (u.startsWith('https://app.documenso.com/api/v2/')) {
      if (String(hd.Authorization) !== 'api_test_token') return res(401, { message: 'unauthorized' });
      const p = u.slice('https://app.documenso.com/api/v2'.length);
      if (p === '/envelope/create') {
        if (o.dsLimit) return res(400, { message: 'You have reached your document limit for this month. Upgrade your plan.' });
        const pay = JSON.parse(opts.body.get('payload')); const id = 'envelope_' + (docs.created.length + 1);
        docs.created.push({ id, pay, file: opts.body.get('files') }); docs.envelopes[id] = { id, status: 'DRAFT', externalId: pay.externalId, recipients: [{ email: pay.recipients[0].email, token: 'tok' + id, signingStatus: 'NOT_SIGNED' }], envelopeItems: [{ id: 'item_' + id }] };
        return res(200, { id }); }
      if (p === '/envelope/distribute') { const b = JSON.parse(opts.body); docs.distributed.push(b); const e = docs.envelopes[b.envelopeId]; e.status = 'PENDING';
        return res(200, { success: true, id: e.id, recipients: e.recipients.map((r) => ({ email: r.email, token: r.token, signingUrl: 'https://app.documenso.com/sign/' + r.token })) }); }
      if (p === '/envelope/cancel') { docs.cancelled.push(JSON.parse(opts.body)); return res(200, { success: true }); }
      let m;
      if ((m = p.match(/^\/envelope\/([^/?]+)$/))) return docs.envelopes[m[1]] ? res(200, docs.envelopes[m[1]]) : res(404, {});
      if (/^\/envelope\/item\/[^/]+\/download\?version=signed$/.test(p)) return res(200, '%PDF-signed');
      if (/certificate\/download$/.test(p)) return res(200, '%PDF-cert');
      if (/audit-log\/download$/.test(p)) return res(200, '%PDF-audit');
      return res(404, {});
    }
    if (u.includes('api.resend.com')) { mail.push(JSON.parse(opts.body)); return res(200, { id: 'm' }); }
    return inner(url, opts);
  };
  W.docs = docs; W.stored = stored; W.mail = mail;
  return W;
}
const api = (W, env) => M.load('dealer-applications-api.js', W, Object.assign({}, ENV, env || {}), ROOT);
const hook = (W, env) => M.load('documenso-webhook.js', W, Object.assign({}, ENV, env || {}), ROOT);
const adm = (W, env) => M.load('applications-admin-api.js', W, Object.assign({}, ENV, env || {}), ROOT);
const as = (C, who, body) => M.call(C, body, { headers: { authorization: 'Bearer ' + who } });
const COMPLETE = { 'biz.legal_name': 'Sample Medical HQ LLC', 'biz.address': '1 Main St', 'biz.city': 'Dayton', 'biz.state': 'OH', 'biz.zip': '45402', 'biz.phone': '555-0100',
  'biz.email': 'office@sample.test', 'biz.ein': '00-0000000', 'ap.name': 'Alex Payables', 'ap.email': 'ap@sample.test', 'owner1.name': 'Jordan Owner',
  'signer.name': 'Jordan Owner', 'signer.title': 'President', 'signer.email': 'hq@sample.test', 'biz.entity': 'llc', 'bank.name': 'Test Bank' };
async function started(W, who, m, loc) { const C = api(W); const r = await as(C, who || 'hq', { action: 'app_start', manufacturer: m || 'access4u', location_id: loc }); if (r.status !== 200) throw new Error(JSON.stringify(r.body)); return r.body.application; }
async function filled(W, m) { const C = api(W); const a = await started(W, 'hq', m); const s = await as(C, 'hq', { action: 'app_save', id: a.id, version: a.version, answers: COMPLETE }); eq(s.status, 200, JSON.stringify(s.body)); return s.body.application; }

(async () => {
  await t('crypto: round trip; bound to its row (a blob moved to another row cannot be read); no key → "opens shortly", never clear text', async () => {
    process.env.APPLICATIONS_ENC_KEY = KEY; delete require.cache[require.resolve(path.join(ROOT, '_app_crypto.js'))];
    const X = require(path.join(ROOT, '_app_crypto.js'));
    const b = X.seal({ a: 1 }, 'app:1'); eq(X.open(b, 'app:1'), { a: 1 });
    let threw = false; try { X.open(b, 'app:2'); } catch (e) { threw = true; } ok(threw, 'opened under another row');
    const W = world(); const r = await as(api(W, { APPLICATIONS_ENC_KEY: '' }), 'hq', { action: 'app_list' }); eq([r.status, r.body.error], [503, 'Manufacturer applications open shortly.']);
  });
  await t('list: the 10 original-form manufacturers + Golden / Corsicana links (Ohio Medical retired); a head office may apply for each visible location', async () => {
    const W = world(); const r = await as(api(W), 'hq', { action: 'app_list' }); eq(r.status, 200, JSON.stringify(r.body));
    eq(r.body.forms.filter((f) => !f.external).length, 10); eq(r.body.forms.filter((f) => f.external).map((f) => f.slug).sort(), ['corsicana', 'golden-technologies']);
    eq(r.body.locations.map((l) => [l.id, l.can_apply]), [[HQ, true], [BR, true], [BR2, true]]); eq([r.body.signing, r.body.monthly], [true, { used: 0, limit: 5 }]);
    const b = await as(api(W), 'br', { action: 'app_list' }); eq(b.body.locations.map((l) => l.id), [BR]);
  });
  await t('start: prefilled from HCPS records, stored ONLY encrypted, one open application per location + manufacturer', async () => {
    const W = world(); const a = await started(W);
    const row = W.db.dealer_applications[0]; const clear = JSON.stringify(row); ok(row.answers_enc && !clear.includes('1 Main St') && !clear.includes('50 Dock Rd') && !clear.includes('office@sample.test'), 'clear text stored');
    const g = await as(api(W), 'hq', { action: 'app_get', id: a.id });
    eq([g.body.application.answers['biz.legal_name'], g.body.application.answers['ship.address'], g.body.application.answers['signer.email']], ['Sample Medical HQ', '50 Dock Rd', 'hq@sample.test']);
    const again = await as(api(W), 'hq', { action: 'app_start', manufacturer: 'access4u' }); eq([again.body.existing, again.body.application.id], [true, a.id]);
    eq((await as(api(W), 'hq', { action: 'app_start', manufacturer: 'golden-technologies' })).status, 400, 'Golden keeps its own process');
  });
  await t('D2: a branch applies only for itself; another branch / dealer never reads or changes it', async () => {
    const W = world(); const a = await started(W, 'br');
    eq((await as(api(W), 'br', { action: 'app_start', manufacturer: 'bemis', location_id: BR2 })).status, 403);
    eq((await as(api(W), 'ot', { action: 'app_get', id: a.id })).status, 404);
    eq((await as(api(W), 'hq', { action: 'app_get', id: a.id })).status, 200, 'head office sees its branch');
    eq((await as(api(W), 'nobody', { action: 'app_list' })).status, 401);
  });
  await t('save: unknown keys dropped, stale version 409, required fields reported; events hold no answers', async () => {
    const W = world(); const a = await started(W); const C = api(W);
    const s = await as(C, 'hq', { action: 'app_save', id: a.id, version: a.version, answers: { 'biz.legal_name': 'X Co', evil: 'y', 'biz.entity': 'bogus' } });
    eq(s.status, 200); ok(s.body.missing.includes('Federal tax ID (EIN)'), 'missing list');
    const ans = (await as(C, 'hq', { action: 'app_get', id: a.id })).body.application.answers; eq([ans.evil, ans['biz.entity']], [undefined, undefined]);
    eq((await as(C, 'hq', { action: 'app_save', id: a.id, version: a.version, answers: {} })).status, 409);
    ok(!JSON.stringify(W.db.dealer_application_events).includes('X Co'), 'answers in the event log');
  });
  await t('preview: every one of the 10 forms builds from its pinned original (a real PDF)', async () => {
    const W = world(); const C = api(W);
    for (const m of ['access4u', 'bemis', 'climbing-steps', 'strongback-mobility', 'abm-respiratory-care', 'pedifix', 'airavant', 'ovation-medical', 'yuwell', 'dalton']) {
      const a = await filled(W, m); const r = await as(C, 'hq', { action: 'app_preview', id: a.id });
      eq(r.status, 200, m + ' ' + JSON.stringify(r.body).slice(0, 120)); ok(Buffer.from(r.body.pdf_base64, 'base64').subarray(0, 5).toString() === '%PDF-', m + ' not a pdf');
    }
  });
  await t('sign: incomplete refused; Documenso gets the original + signature/date fields, no email (distribution NONE); link returned; status signing', async () => {
    const W = world(); const C = api(W); const a0 = await started(W);
    eq((await as(C, 'hq', { action: 'app_sign', id: a0.id, version: a0.version })).status, 400);
    const W2 = world(); const C2 = api(W2); const a = await filled(W2, 'access4u');
    const r = await as(C2, 'hq', { action: 'app_sign', id: a.id, version: a.version }); eq(r.status, 200, JSON.stringify(r.body));
    eq(r.body.url, 'https://app.documenso.com/sign/tokenvelope_1');
    const c = W2.docs.created[0]; eq([c.pay.meta.distributionMethod, c.pay.externalId, c.pay.recipients[0].email, c.pay.recipients[0].role], ['NONE', a.id, 'hq@sample.test', 'SIGNER']);
    ok(c.pay.recipients[0].fields.some((f) => f.type === 'SIGNATURE') && c.pay.recipients[0].fields.some((f) => f.type === 'DATE'), 'fields');
    ok(c.pay.recipients[0].fields.every((f) => f.positionX >= 0 && f.positionX + f.width <= 100 && f.positionY >= 0 && f.positionY + f.height <= 100), 'field inside the page');
    eq(W2.docs.distributed[0].meta.distributionMethod, 'NONE');
    ok(Object.values(c.pay.meta.emailSettings).every((v) => v === false) && Object.keys(c.pay.meta.emailSettings).length === 9, 'Documenso would email the application');
    const row = W2.db.dealer_applications[0]; eq([row.status, row.envelope_id], ['signing', 'envelope_1']); ok(row.signing_token_enc && !JSON.stringify(row).includes('tokenvelope_1'), 'token stored in clear');
    eq((await as(C2, 'hq', { action: 'app_save', id: a.id, version: row.version, answers: COMPLETE })).status, 409, 'editable while with the signer');
    eq((await as(C2, 'hq', { action: 'app_signing_link', id: a.id })).body.url, 'https://app.documenso.com/sign/tokenvelope_1');
  });
  await t('free plan: past 5 envelopes this month (or Documenso refusing) → queued, the President told without contents, never charged', async () => {
    const ev = [1, 2, 3, 4, 5].map((i) => ({ id: i, application_id: 'x', at: new Date().toISOString(), actor: 's', action: 'slot_reserved', detail: { dealer: 'other-' + i } }));
    const W = world({ events: ev }); const a = await filled(W, 'bemis');
    const r = await as(api(W), 'hq', { action: 'app_sign', id: a.id, version: a.version }); eq([r.status, r.body.queued], [200, true]); eq(W.docs.created.length, 0);
    eq(W.mail.length, 1); ok(!JSON.stringify(W.mail[0]).includes('Sample Medical') && /Bemis/.test(W.mail[0].subject), 'contents in the email');
    const W2 = world({ dsLimit: true }); const b = await filled(W2, 'yuwell'); const r2 = await as(api(W2), 'hq', { action: 'app_sign', id: b.id, version: b.version });
    eq([r2.status, r2.body.queued, W2.db.dealer_applications[0].status], [200, true, 'queued']);
  });
  await t('signing off (no Documenso token): signing says "opens shortly"; print-to-sign still works', async () => {
    const W = world(); const a = await filled(W, 'pedifix'); const C = api(W, { DOCUMENSO_API_TOKEN: '' });
    eq((await as(C, 'hq', { action: 'app_sign', id: a.id, version: a.version })).status, 503);
    eq((await as(C, 'hq', { action: 'app_offline', id: a.id })).status, 200);
  });
  await t('webhook: no / wrong secret 401 (and refused when none configured); a COMPLETED event is re-read from Documenso, files stored privately, status signed', async () => {
    const W = world(); const a = await filled(W, 'access4u'); await as(api(W), 'hq', { action: 'app_sign', id: a.id, version: a.version });
    const ev = { event: 'DOCUMENT_COMPLETED', payload: { envelopeId: 'envelope_1', status: 'COMPLETED' } };
    eq((await M.call(hook(W), ev, { headers: {} })).status, 401);
    eq((await M.call(hook(W), ev, { headers: { 'x-documenso-secret': 'wrong' } })).status, 401);
    eq((await M.call(hook(W, { DOCUMENSO_WEBHOOK_SECRET: '' }), ev, { headers: { 'x-documenso-secret': '' } })).status, 401);
    const early = await M.call(hook(W), ev, { headers: { 'x-documenso-secret': SECRET } }); eq(early.body.state, 'not_completed', 'payload trusted');
    W.docs.envelopes.envelope_1.status = 'COMPLETED'; W.docs.envelopes.envelope_1.completedAt = '2026-11-05T12:00:00Z';
    const r = await M.call(hook(W), ev, { headers: { 'x-documenso-secret': SECRET } }); eq(r.body.state, 'signed', JSON.stringify(r.body));
    const row = W.db.dealer_applications[0]; eq([row.status, row.signing_token_enc, !!row.signed_sha256], ['signed', null, true]);
    eq(W.stored.map((s) => s.path.split('/').pop()).sort(), ['audit-log.pdf', 'certificate.pdf', 'signed.pdf']); ok(W.stored.every((s) => s.path.startsWith(HQ + '/' + a.id + '/')), 'path');
    eq(W.mail.length, 1); ok(!JSON.stringify(W.mail[0]).includes('Sample Medical') && !JSON.stringify(W.mail[0]).includes('00-0000000'), 'contents emailed');
    eq((await M.call(hook(W), ev, { headers: { 'x-documenso-secret': SECRET } })).status, 200, 'replay harmless'); eq(W.stored.length, 3);
    W.docs.envelopes.envelope_1.externalId = 'someone-else';
    const W2 = world(); eq((await M.call(hook(W2), { event: 'DOCUMENT_COMPLETED', payload: { envelopeId: 'envelope_9' } }, { headers: { 'x-documenso-secret': SECRET } })).body.ignored, 'not an application');
  });
  await t('admin: President only; sees decrypted answers + 2-minute file links; statuses follow the review path; a decision keeps it 7 years', async () => {
    const W = world(); const a = await filled(W, 'access4u'); await as(api(W), 'hq', { action: 'app_sign', id: a.id, version: a.version });
    W.docs.envelopes.envelope_1.status = 'COMPLETED'; await M.call(hook(W), { event: 'DOCUMENT_COMPLETED', payload: { envelopeId: 'envelope_1' } }, { headers: { 'x-documenso-secret': SECRET } });
    const fc = await as(adm(W), 'boss', { action: 'forms_check' }); eq([fc.status, fc.body.ok, fc.body.forms.length, fc.body.encryption, fc.body.webhook_secret], [200, true, 10, true, true]);
    eq((await as(adm(W), 'rep', { action: 'list' })).status, 403); eq((await as(adm(W), 'hq', { action: 'list' })).status, 401);
    const l = await as(adm(W), 'boss', { action: 'list' }); eq(l.body.applications.length, 1);
    const g = await as(adm(W), 'boss', { action: 'get', id: a.id }); eq(g.body.answers['biz.ein'], '00-0000000'); ok(g.body.files.signed && g.body.files.certificate, 'links');
    ok(!('answers_enc' in g.body.application) && !('signing_token_enc' in g.body.application), 'blob returned');
    let v = g.body.application.version;
    eq((await as(adm(W), 'boss', { action: 'set_status', id: a.id, version: v, status: 'approved' })).status, 400, 'skip the review path');
    const s1 = await as(adm(W), 'boss', { action: 'set_status', id: a.id, version: v, status: 'sent_to_manufacturer', notes: 'emailed to A4U' }); eq(s1.status, 200); v = s1.body.application.version;
    const s2 = await as(adm(W), 'boss', { action: 'set_status', id: a.id, version: v, status: 'approved' }); eq(s2.status, 200);
    ok(Number(String(s2.body.application.retention_until).slice(0, 4)) - new Date().getUTCFullYear() === 7, 'retention');
    ok(W.db.dealer_application_events.some((e) => e.action === 'status' && e.detail.to === 'approved'), 'event');
  });
  await t('withdraw while signing cancels the envelope; before the SQL → "open shortly"', async () => {
    const W = world(); const a = await filled(W, 'access4u'); await as(api(W), 'hq', { action: 'app_sign', id: a.id, version: a.version });
    eq((await as(api(W), 'hq', { action: 'app_withdraw', id: a.id })).status, 200); eq(W.docs.cancelled[0].envelopeId, 'envelope_1'); eq(W.db.dealer_applications[0].status, 'withdrawn');
    const W2 = world({ missingTables: ['dealer_applications'] }); const r = await as(api(W2), 'hq', { action: 'app_list' }); eq([r.status, r.body.error], [503, 'Manufacturer applications open shortly.']);
  });
  await t('review fixes: the signer must be the signed-in user; a double tap claims once (one envelope); one company gets 2 of the 5 free slots; a provider refusal gives the slot back', async () => {
    const W = world(); const C = api(W); const a = await started(W);
    await as(C, 'hq', { action: 'app_save', id: a.id, version: a.version, answers: Object.assign({}, COMPLETE, { 'signer.email': 'someone@sample.test' }) });
    const m = await as(C, 'hq', { action: 'app_sign', id: a.id, version: a.version + 1 }); eq([m.status, m.body.signer_mismatch], [400, true]); eq(W.docs.created.length, 0);
    const W2 = world(); const C2 = api(W2); const b = await filled(W2, 'access4u');
    const [r1, r2] = await Promise.all([as(C2, 'hq', { action: 'app_sign', id: b.id, version: b.version }), as(C2, 'hq', { action: 'app_sign', id: b.id, version: b.version })]);
    eq([r1.status, r2.status].sort(), [200, 409]); eq(W2.docs.created.length, 1, 'two envelopes');
    const W3 = world({ events: [1, 2].map((i) => ({ id: i, application_id: 'x', at: new Date().toISOString(), actor: 's', action: 'slot_reserved', detail: { dealer: HQ } })) });
    const c3 = await filled(W3, 'bemis'); const q = await as(api(W3), 'hq', { action: 'app_sign', id: c3.id, version: c3.version }); eq([q.body.queued, q.body.reason], [true, 'company_limit']);
    const W4 = world({ dsLimit: true }); const d4 = await filled(W4, 'yuwell'); await as(api(W4), 'hq', { action: 'app_sign', id: d4.id, version: d4.version });
    eq(W4.db.dealer_application_events.filter((e) => /^slot_/.test(e.action)).map((e) => e.action), ['slot_reserved', 'slot_released']);
  });
  await t('review fixes: a withdrawn application signed later stays withdrawn (file kept on record); the link is only for the signer; President can withdraw', async () => {
    const W = world(); const a = await filled(W, 'access4u'); await as(api(W), 'hq', { action: 'app_sign', id: a.id, version: a.version });
    eq((await as(api(W), 'br', { action: 'app_signing_link', id: a.id })).status, 404, 'branch sees HQ application');
    await as(api(W), 'hq', { action: 'app_withdraw', id: a.id });
    W.docs.envelopes.envelope_1.status = 'COMPLETED';
    const r = await M.call(hook(W), { event: 'DOCUMENT_COMPLETED', payload: { envelopeId: 'envelope_1' } }, { headers: { 'x-documenso-secret': SECRET } });
    eq([r.status, W.db.dealer_applications[0].status], [200, 'withdrawn']); ok(W.db.dealer_application_events.some((e) => e.action === 'signed_after_withdrawal'), 'kept on record');
    ok(W.db.dealer_applications[0].retention_until, 'withdrawn has a retention date');
    const W2 = world(); const b = await filled(W2, 'pedifix'); await as(api(W2), 'hq', { action: 'app_sign', id: b.id, version: b.version });
    const g = await as(adm(W2), 'boss', { action: 'get', id: b.id }); const w = await as(adm(W2), 'boss', { action: 'withdraw', id: b.id }); eq(w.status, 200); eq(W2.docs.cancelled.length, 1);
  });
  await t('review fixes: CORS only for the 360 Dealer Portal; the month starts at Chicago midnight (CST and CDT)', async () => {
    const W = world(); const C = api(W); const raw = (origin) => C.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer hq', origin }, body: JSON.stringify({ action: 'app_list' }) });
    eq((await raw('https://evil.example')).headers['access-control-allow-origin'], 'https://hcpsonlineordering.netlify.app');
    eq((await raw('https://deploy-preview-52--hcpsonlineordering.netlify.app')).headers['access-control-allow-origin'], 'https://deploy-preview-52--hcpsonlineordering.netlify.app');
    const S = require(path.join(ROOT, '_app_store.js'));
    eq(S.chicagoMonthStart(new Date('2026-01-15T12:00:00Z')), '2026-01-01T06:00:00.000Z'); eq(S.chicagoMonthStart(new Date('2026-07-15T12:00:00Z')), '2026-07-01T05:00:00.000Z');
    eq(S.chicagoMonthStart(new Date('2026-11-01T03:00:00Z')), '2026-10-01T05:00:00.000Z', 'still October in Chicago');
  });
  /* ---- Stage 5 follow-ups (owner 2026-11-06 13:25 CT) ---- */
  const PDF64 = Buffer.from('%PDF-1.4\n' + 'x'.repeat(400)).toString('base64');
  await t('paper-signed: the dealer uploads the hand-signed copy (a real PDF, never overwriting); status offline_signed → the President\'s normal review path', async () => {
    const W = world(); const C = api(W); const a = await filled(W, 'access4u');
    eq((await as(C, 'hq', { action: 'app_upload_paper', id: a.id, version: a.version, kind: 'signed', pdf_base64: Buffer.from('hello not a pdf at all '.repeat(20)).toString('base64') })).status, 400, 'not a PDF');
    eq((await as(C, 'hq', { action: 'app_upload_paper', id: a.id, version: a.version + 5, kind: 'signed', pdf_base64: PDF64 })).status, 409, 'stale');
    eq((await as(C, 'br', { action: 'app_upload_paper', id: a.id, version: a.version, kind: 'signed', pdf_base64: PDF64 })).status, 404, 'another location');
    const r = await as(C, 'hq', { action: 'app_upload_paper', id: a.id, version: a.version, kind: 'signed', pdf_base64: PDF64 });
    eq([r.status, r.body.application.status], [200, 'offline_signed'], JSON.stringify(r.body));
    const st = W.stored.find((x) => /paper-signed-[0-9a-f]{16}\.pdf$/.test(x.path)); ok(st && st.upsert === 'false' && st.path.startsWith(HQ + '/' + a.id + '/'), JSON.stringify(W.stored));
    ok(W.mail.length === 1 && !/Sample Medical/.test(JSON.stringify(W.mail[0])), 'President told, no contents');
    eq((await as(C, 'hq', { action: 'app_save', id: a.id, version: r.body.application.version, answers: COMPLETE })).status, 409, 'no edits after signing');
    eq((await as(C, 'hq', { action: 'app_upload_paper', id: a.id, version: r.body.application.version, kind: 'signed', pdf_base64: PDF64 })).status, 409, 'a second paper copy can\'t replace the signed one');
    const A = adm(W); const g = await as(A, 'boss', { action: 'get', id: a.id }); eq([g.body.next, !!g.body.files.signed], [['under_review', 'sent_to_manufacturer', 'declined'], true]);
    eq((await as(A, 'boss', { action: 'set_status', id: a.id, version: g.body.application.version, status: 'under_review' })).status, 200);
    ok(W.db.dealer_application_events.some((e) => e.action === 'paper_signed_uploaded' && e.detail.sha256 && !JSON.stringify(e.detail).includes('Sample')), 'event without contents');
  });
  await t('paper-signed: an incomplete questionnaire, or one out for e-signature, can\'t be replaced by an upload; the President can upload one he received', async () => {
    const W = world(); const C = api(W); const a = await started(W, 'hq', 'access4u');
    eq((await as(C, 'hq', { action: 'app_upload_paper', id: a.id, version: a.version, kind: 'signed', pdf_base64: PDF64 })).status, 400, 'incomplete');
    const A = adm(W); eq((await as(A, 'rep', { action: 'upload_paper', id: a.id, version: a.version, kind: 'signed', pdf_base64: PDF64 })).status, 403, 'rep');
    const r = await as(A, 'boss', { action: 'upload_paper', id: a.id, version: a.version, kind: 'signed', pdf_base64: PDF64, signed_on: '2026-11-02' });
    eq([r.status, r.body.application.status, W.db.dealer_applications[0].signed_at], [200, 'offline_signed', '2026-11-02T12:00:00Z']);
  });
  await t('Dalton guarantee page: the original page 4, blank, to print (never e-signed); the guarantor\'s hand-signed page is kept with the application', async () => {
    const W = world(); const C = api(W); const a = await filled(W, 'dalton');
    const gp = await as(C, 'hq', { action: 'app_guarantee_page', id: a.id }); eq(gp.status, 200);
    const { PDFDocument } = require('pdf-lib'); const doc = await PDFDocument.load(Buffer.from(gp.body.pdf_base64, 'base64')); eq(doc.getPageCount(), 1, 'one page');
    const b = await filled(W, 'access4u'); eq((await as(C, 'hq', { action: 'app_guarantee_page', id: b.id })).status, 400, 'no guarantee page for Access4U');
    eq((await as(C, 'hq', { action: 'app_upload_paper', id: a.id, version: a.version, kind: 'guarantee', pdf_base64: PDF64 })).status, 200);
    ok(W.stored.some((x) => /\/guarantee-[0-9a-f]{16}\.pdf$/.test(x.path)), 'stored');
    for (let i = 0; i < 4; i++) eq((await as(C, 'hq', { action: 'app_upload_paper', id: a.id, version: a.version, kind: 'guarantee', pdf_base64: Buffer.from('%PDF-1.4\n' + i + 'z'.repeat(400)).toString('base64') })).status, 200);
    eq((await as(C, 'hq', { action: 'app_upload_paper', id: a.id, version: a.version, kind: 'guarantee', pdf_base64: PDF64 })).status, 429, 'at most 5 guarantee pages');
    const g = await as(adm(W), 'boss', { action: 'get', id: a.id }); ok(!!g.body.files.guarantee, 'President sees the guarantee page');
    const L = await as(C, 'hq', { action: 'app_get', id: a.id }); ok(/never signed electronically/.test(L.body.notice), L.body.notice);
  });
  await t('usage: this month used / 5, waiting count and the last months — Documenso Free only', async () => {
    const now = new Date().toISOString(); const W = world({ events: [{ id: 1, application_id: 'x', at: now, actor: 's', action: 'slot_reserved', detail: { dealer: HQ } }, { id: 2, application_id: 'x', at: now, actor: 's', action: 'slot_reserved', detail: { dealer: HQ } }, { id: 3, application_id: 'x', at: now, actor: 's', action: 'slot_released', detail: { dealer: HQ } }] });
    const r = await as(adm(W), 'boss', { action: 'usage' }); eq([r.status, r.body.used, r.body.limit, r.body.months.length, r.body.months[0].used, r.body.waiting], [200, 1, 5, 1, 1, 0], JSON.stringify(r.body));
    eq((await as(adm(W), 'rep', { action: 'usage' })).status, 403);
  });
  await t('retention: listed only after the retention date; purge needs DELETE, deletes every stored file and the encrypted answers, keeps the record and its log', async () => {
    const W = world(); const C = api(W); const a = await filled(W, 'access4u');
    await as(C, 'hq', { action: 'app_upload_paper', id: a.id, version: a.version, kind: 'signed', pdf_base64: PDF64 });
    const A = adm(W); let app = W.db.dealer_applications[0];
    await as(A, 'boss', { action: 'set_status', id: a.id, version: app.version, status: 'declined' }); app = W.db.dealer_applications[0];
    eq((await as(A, 'boss', { action: 'retention' })).body.due.length, 0, 'kept 7 years');
    eq((await as(A, 'boss', { action: 'purge', id: a.id, version: app.version, confirm: 'DELETE' })).status, 400, 'before the date');
    app.retention_until = '2020-01-01';
    const due = (await as(A, 'boss', { action: 'retention' })).body.due; eq([due.length, due[0].id, due[0].answers_enc], [1, a.id, undefined], 'listed without contents');
    eq((await as(A, 'boss', { action: 'purge', id: a.id, version: app.version })).status, 400, 'no confirmation');
    eq((await as(A, 'rep', { action: 'purge', id: a.id, version: app.version, confirm: 'DELETE' })).status, 403);
    const p = await as(A, 'boss', { action: 'purge', id: a.id, version: app.version, confirm: 'DELETE' }); eq([p.status, p.body.files_deleted], [200, 1], JSON.stringify(p.body));
    app = W.db.dealer_applications[0]; eq([app.answers_enc, app.signed_path, app.signer_email, app.status, app.manufacturer], [null, null, null, 'declined', 'access4u']);
    ok(W.stored.every((x) => x.deleted), 'files left'); ok(W.db.dealer_application_events.some((e) => e.action === 'purged'), 'logged');
    eq((await as(A, 'boss', { action: 'retention' })).body.due.length, 0, 'not listed again');
    const W2 = world({ listFails: true }); const b = await filled(W2, 'access4u'); const A2 = adm(W2);
    await as(api(W2), 'hq', { action: 'app_withdraw', id: b.id }); const r2 = W2.db.dealer_applications[0]; r2.retention_until = '2020-01-01';
    eq((await as(A2, 'boss', { action: 'purge', id: b.id, version: r2.version, confirm: 'DELETE' })).status, 503, 'storage unreadable → nothing cleared');
    ok(W2.db.dealer_applications[0].answers_enc, 'answers kept when the files could not be listed');
    const W3 = world({ deleteFailsOnce: true }); const c3 = await filled(W3, 'access4u'); const A3 = adm(W3);
    await as(api(W3), 'hq', { action: 'app_upload_paper', id: c3.id, version: c3.version, kind: 'signed', pdf_base64: PDF64 });
    let r3 = W3.db.dealer_applications[0]; await as(A3, 'boss', { action: 'set_status', id: c3.id, version: r3.version, status: 'declined' }); r3 = W3.db.dealer_applications[0]; r3.retention_until = '2020-01-01';
    eq((await as(A3, 'boss', { action: 'purge', id: c3.id, version: r3.version, confirm: 'DELETE' })).status, 503, 'delete failed');
    r3 = W3.db.dealer_applications[0]; eq([r3.answers_enc, !!r3.signed_path], [null, true], 'answers cleared first; file marker kept');
    eq((await as(A3, 'boss', { action: 'retention' })).body.due.length, 1, 'still listed for a retry');
    eq((await as(A3, 'boss', { action: 'purge', id: c3.id, version: r3.version, confirm: 'DELETE' })).status, 200, 'retry');
    eq([W3.db.dealer_applications[0].signed_path, W3.stored.every((x) => x.deleted)], [null, true]);
    const W4 = world({ deleteFailsOnce: true }); const c4 = await filled(W4, 'dalton'); const A4 = adm(W4);
    await as(api(W4), 'hq', { action: 'app_upload_paper', id: c4.id, version: c4.version, kind: 'guarantee', pdf_base64: PDF64 });
    await as(api(W4), 'hq', { action: 'app_withdraw', id: c4.id }); let r4 = W4.db.dealer_applications[0]; r4.retention_until = '2020-01-01';
    eq((await as(A4, 'boss', { action: 'purge', id: c4.id, version: r4.version, confirm: 'DELETE' })).status, 503);
    ok(W4.db.dealer_applications[0].answers_enc, 'no signed file: answers kept as the marker'); eq((await as(A4, 'boss', { action: 'retention' })).body.due.length, 1, 'listed for retry');
    r4 = W4.db.dealer_applications[0]; eq((await as(A4, 'boss', { action: 'purge', id: c4.id, version: r4.version, confirm: 'DELETE' })).status, 200);
    eq([W4.db.dealer_applications[0].answers_enc, W4.stored.every((x) => x.deleted)], [null, true]);
  });
  console.log(`\napplications: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
