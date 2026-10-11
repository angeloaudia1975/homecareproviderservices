/* MI-1b — netlify/functions/mfr-reports-api.js, loaded unmodified (mutant-capable via phase0-mock's loader)
   against a small fake of Supabase Auth, PostgREST, RPC and Storage. The database's own rules are proven by
   test/mi1b-register.pg.test.js; this proves the API: who may call it, that the server hashes the bytes it
   received (never a client hash), the canonical private storage path, idempotence before any upload, type
   checks, honest dates, that nothing but the register/storage is written, and how refusals come back. */
const assert = require('assert');
const crypto = require('crypto');
const { load, call } = require('./phase0-mock');
const BASE = 'https://db.test';
const PDF = Buffer.from('%PDF-1.7\n' + 'x'.repeat(400) + '\n%%EOF');
const CSV = Buffer.from('order,sku,qty\n5775,1010AB,1\n');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const b64 = b => b.toString('base64');

function world(o) {
  o = o || {};
  const st = { calls: [], uploads: [], rpcs: [], sources: (o.sources || []).map(x => ({ ...x })), events: o.events || [] };
  const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => typeof body === 'string' ? body : JSON.stringify(body) });
  st.fetch = async (url, opts) => {
    opts = opts || {}; const u = String(url), m = (opts.method || 'GET').toUpperCase(); st.calls.push({ u, m, headers: opts.headers || {}, body: opts.body });
    if (u.startsWith(BASE + '/auth/v1/user')) { const tok = String((opts.headers || {}).Authorization || '').replace('Bearer ', '');
      const em = { pres: 'angelo@hcps.us', admin: 'ad@hcps.us', greg: 'greg@hcps.us', lori: 'lori@hcps.us', off: 'gone@hcps.us' }[tok]; return em ? res(200, { email: em }) : res(401, {}); }
    if (u.startsWith(BASE + '/rest/v1/staff_users')) { const em = decodeURIComponent(u.match(/email=eq\.([^&]+)/)[1]);
      const s = { 'angelo@hcps.us': { role: 'president' }, 'ad@hcps.us': { role: 'admin' }, 'greg@hcps.us': { role: 'rep' }, 'lori@hcps.us': { role: 'relations' }, 'gone@hcps.us': { role: 'president', active: false } }[em];
      return res(200, s ? [{ email: em, ...s }] : []); }
    if (o.failRead && m === 'GET' && u.includes('/rest/v1/') && o.failRead(u)) return res(500, { message: 'forced' });
    if (u.startsWith(BASE + '/rest/v1/manufacturers')) { const all = [{ slug: 'strongback-mobility', name: 'Strongback Mobility' }, { slug: 'pedifix', name: 'PediFix' }];
      const f = u.match(/slug=eq\.([^&]+)/); return res(200, f ? all.filter(x => x.slug === decodeURIComponent(f[1])) : all); }
    if (u.startsWith(BASE + '/rest/v1/mfr_sources')) {
      let rows = st.sources; const g = k => { const x = u.match(new RegExp('[?&]' + k + '=eq\\.([^&]+)')); return x && decodeURIComponent(x[1]); };
      if (g('manufacturer')) rows = rows.filter(r => r.manufacturer === g('manufacturer')); if (g('file_sha256')) rows = rows.filter(r => r.file_sha256 === g('file_sha256'));
      if (g('id')) rows = rows.filter(r => String(r.id) === g('id'));
      if (/kind=in\./.test(u)) rows = rows.filter(r => ['sales_export', 'commission_statement', 'dealer_report'].includes(r.kind));
      if (/offset=([1-9])/.test(u)) rows = []; return res(200, rows); }
    if (u.startsWith(BASE + '/rest/v1/mfr_source_events')) return res(200, /offset=([1-9])/.test(u) ? [] : st.events);
    if (u.startsWith(BASE + '/rest/v1/rpc/')) { const fn = u.split('/rpc/')[1]; const p = JSON.parse(opts.body).p; st.rpcs.push({ fn, p });
      if (o.rpc) { const r = o.rpc(fn, p, st); if (r) return res(r.status, r.body); }
      if (fn === 'hcps_mfr_report_register') { const id = 100 + st.rpcs.length; st.sources.push({ id, manufacturer: p.manufacturer, kind: p.kind, file_sha256: p.file_sha256, storage_path: p.storage_path, file_name: p.file_name, status: 'received' });
        return res(200, { ok: true, existing: false, id, status: 'received' }); }
      return res(200, { ok: true, id: p.id }); }
    if (u.startsWith(BASE + '/storage/v1/object/list/')) { const prefix = JSON.parse(opts.body).prefix; st.lists = (st.lists || 0) + 1;
      if (o.failList) return res(500, { message: 'down' });
      const objs = o.objects || []; const kids = new Map();
      for (const pth of objs) if (pth.startsWith(prefix)) { const rest = pth.slice(prefix.length); const seg = rest.split('/')[0];
        kids.set(seg, rest.includes('/') ? { name: seg, id: null } : { name: seg, id: 'obj-' + seg, metadata: { size: 10 }, created_at: '2026-10-11T00:00:00Z' }); }
      return res(200, [...kids.values()]); }
    if (u.startsWith(BASE + '/storage/v1/object/sign/')) return res(200, { signedURL: '/object/sign/mfr-sources/' + u.split('/mfr-sources/')[1] + '?token=t' });
    if (u.startsWith(BASE + '/storage/v1/object/')) { st.uploads.push({ path: u.split('/mfr-sources/')[1], headers: opts.headers, size: opts.body.length, body: opts.body });
      if (o.upload) return o.upload(st); return res(200, { Key: 'x' }); }
    return res(404, { message: 'unexpected call ' + m + ' ' + u });
  };
  return st;
}
const boot = o => { const w = world(o); return { w, m: load('mfr-reports-api.js', w) }; };
const as = tok => ({ token: tok });
const REG = (o) => Object.assign({ action: 'register', manufacturer: 'strongback-mobility', kind: 'dealer_report', file_name: 'Strongback_Report_Overview_September_2026.pdf',
  content_base64: b64(PDF), received_date: '2026-10-10', prepared_date: '2026-10-08', period_start: '2026-09', period_end: '2026-09' }, o);
const writesOf = w => w.calls.filter(c => c.m !== 'GET' && !/\/auth\/v1\//.test(c.u));

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + String(e && e.message || e).split('\n')[0]); } }

(async () => {
  console.log('\n— who may call it —');
  await t('no sign-in → 401; rep → 403; Relations → 403; inactive staff → 401; nothing written', async () => {
    for (const [tok, code] of [[null, 401], ['greg', 403], ['lori', 403], ['off', 401], ['forged', 401]]) {
      const { w, m } = boot(); const r = await call(m, REG(), tok ? as(tok) : {});
      assert.strictEqual(r.status, code, String(tok)); assert.strictEqual(writesOf(w).length, 0);
    }
  });
  await t('president and admin may list', async () => {
    for (const tok of ['pres', 'admin']) { const { m } = boot(); const r = await call(m, { action: 'list' }, as(tok)); assert.strictEqual(r.status, 200); }
  });
  await t('GET is refused', async () => { const { m } = boot(); const r = await m.handler({ httpMethod: 'GET', headers: { authorization: 'Bearer pres' } }); assert.strictEqual(r.statusCode, 405); });

  console.log('\n— register —');
  await t('stores the original privately at reports/<mfr>/<kind>/<server sha>.pdf, then registers it with the server hash', async () => {
    const { w, m } = boot(); const r = await call(m, REG(), as('pres'));
    assert.strictEqual(r.status, 200, JSON.stringify(r.body)); const h = sha(PDF);
    assert.strictEqual(w.uploads.length, 1); assert.strictEqual(w.uploads[0].path, `reports/strongback-mobility/dealer_report/${h}.pdf`);
    assert.ok(Buffer.compare(w.uploads[0].body, PDF) === 0, 'the exact bytes are stored');
    assert.strictEqual(w.uploads[0].headers['x-upsert'], 'false'); assert.strictEqual(w.uploads[0].headers['content-type'], 'application/pdf');
    const p = w.rpcs[0].p; assert.strictEqual(w.rpcs[0].fn, 'hcps_mfr_report_register');
    assert.deepStrictEqual([p.file_sha256, p.storage_path, p.file_size, p.received_date, p.prepared_date, p.report_period_start, p.report_period_end],
      [h, `reports/strongback-mobility/dealer_report/${h}.pdf`, PDF.length, '2026-10-10', '2026-10-08', '2026-09-01', '2026-09-30']);
  });
  await t('a client-supplied hash, actor or storage path is ignored — the server computes and decides', async () => {
    const { w, m } = boot(); await call(m, REG({ file_sha256: 'f'.repeat(64), actor: 'someone@else', storage_path: 'public/x.pdf' }), as('pres'));
    assert.strictEqual(w.rpcs[0].p.file_sha256, sha(PDF)); assert.strictEqual(w.rpcs[0].p.actor, 'angelo@hcps.us');
    assert.ok(w.rpcs[0].p.storage_path.startsWith('reports/strongback-mobility/dealer_report/'));
  });
  await t('the same file again returns the existing record — no upload, no RPC (idempotent)', async () => {
    const h = sha(PDF); const { w, m } = boot({ sources: [{ id: 7, manufacturer: 'strongback-mobility', kind: 'dealer_report', file_sha256: h, status: 'accepted' }] });
    const r = await call(m, REG(), as('pres'));
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.existing, true); assert.strictEqual(r.body.report.id, 7);
    assert.strictEqual(w.uploads.length, 0); assert.strictEqual(w.rpcs.length, 0);
  });
  await t('the same file under another kind → 409, nothing stored', async () => {
    const h = sha(PDF); const { w, m } = boot({ sources: [{ id: 3, manufacturer: 'strongback-mobility', kind: 'price_list', file_sha256: h }] });
    const r = await call(m, REG(), as('pres')); assert.strictEqual(r.status, 409); assert.strictEqual(r.body.error, 'mi1b_hash_registered_as_other_kind');
    assert.strictEqual(w.uploads.length + w.rpcs.length, 0);
  });
  await t('a file already in storage from an interrupted attempt is reused (409 Duplicate is not an error)', async () => {
    const { w, m } = boot({ upload: () => ({ ok: false, status: 409, text: async () => '{"error":"Duplicate","message":"The resource already exists"}' }) });
    const r = await call(m, REG(), as('pres')); assert.strictEqual(r.status, 200); assert.strictEqual(w.rpcs.length, 1);
  });
  await t('a storage failure registers nothing (502)', async () => {
    const { w, m } = boot({ upload: () => ({ ok: false, status: 500, text: async () => 'boom' }) });
    const r = await call(m, REG(), as('pres')); assert.strictEqual(r.status, 502); assert.strictEqual(r.body.error, 'upload_failed'); assert.strictEqual(w.rpcs.length, 0);
  });
  await t('type checks: extension must be pdf/xlsx/xls/csv and the bytes must match it', async () => {
    for (const [o, err] of [[{ file_name: 'r.exe' }, 'file_type_not_allowed'], [{ file_name: 'r.pdf', content_base64: b64(CSV) }, 'file_type_mismatch'],
      [{ file_name: 'r.xlsx', content_base64: b64(PDF) }, 'file_type_mismatch'], [{ file_name: 'r.csv', content_base64: b64(Buffer.from([0x50, 0, 1])) }, 'file_type_mismatch'],
      [{ content_base64: '' }, 'file_required']]) {
      const { w, m } = boot(); const r = await call(m, REG(o), as('pres')); assert.strictEqual(r.body.error, err, JSON.stringify(o).slice(0, 60)); assert.strictEqual(writesOf(w).length, 0);
    }
    const { w, m } = boot(); const r = await call(m, REG({ kind: 'sales_export', file_name: 'Stongback Orders.csv', content_base64: b64(CSV), period_start: '2026-01', period_end: '2026-09' }), as('pres'));
    assert.strictEqual(r.status, 200); assert.ok(w.uploads[0].path.endsWith('.csv')); assert.strictEqual(w.uploads[0].headers['content-type'], 'text/csv');
  });
  await t('size: over 4 MB refused before anything is stored', async () => {
    const big = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(4 * 1024 * 1024)]); const { w, m } = boot();
    const r = await call(m, REG({ content_base64: b64(big) }), as('pres')); assert.strictEqual(r.status, 413); assert.strictEqual(writesOf(w).length, 0);
  });
  await t('honest dates: received required, not in the future; prepared optional, never after received; never filled in', async () => {
    for (const [o, err] of [[{ received_date: '' }, 'mi1b_received_date_required'], [{ received_date: '2026-02-30' }, 'mi1b_received_date_required'],
      [{ received_date: '2999-01-01' }, 'received_in_future'], [{ prepared_date: '2026-10-11' }, 'bad_prepared_date'], [{ prepared_date: 'Oct 8' }, 'bad_prepared_date']]) {
      const { w, m } = boot(); const r = await call(m, REG(o), as('pres')); assert.strictEqual(r.body.error, err, JSON.stringify(o)); assert.strictEqual(writesOf(w).length, 0);
    }
    const { w, m } = boot(); await call(m, REG({ prepared_date: '' }), as('pres'));
    assert.strictEqual(w.rpcs[0].p.prepared_date, '', 'a missing prepared date stays missing — not the received date');
  });
  await t('period: months → first/last day; from ≤ to; not starting after receipt; bad month refused', async () => {
    for (const o of [{ period_start: '2026-10', period_end: '2026-09' }, { period_start: '2026-13', period_end: '2026-13' }, { period_start: '2026-11', period_end: '2026-11' }]) {
      const { w, m } = boot(); const r = await call(m, REG(o), as('pres')); assert.strictEqual(r.body.error, 'mi1b_bad_period', JSON.stringify(o)); assert.strictEqual(writesOf(w).length, 0); }
    const { w, m } = boot(); await call(m, REG({ period_start: '2024-02', period_end: '2024-02' }), as('pres'));
    assert.deepStrictEqual([w.rpcs[0].p.report_period_start, w.rpcs[0].p.report_period_end], ['2024-02-01', '2024-02-29']);
  });
  await t('unknown manufacturer refused before storage', async () => {
    const { w, m } = boot(); const r = await call(m, REG({ manufacturer: 'acme' }), as('pres')); assert.strictEqual(r.body.error, 'unknown_manufacturer'); assert.strictEqual(w.uploads.length, 0);
  });
  await t('a correction passes supersedes_id + reason through to the database', async () => {
    const { w, m } = boot(); await call(m, REG({ supersedes_id: 12, supersede_reason: 'Strongback re-sent September' }), as('pres'));
    assert.deepStrictEqual([w.rpcs[0].p.supersedes_id, w.rpcs[0].p.supersede_reason], ['12', 'Strongback re-sent September']);
  });
  await t('a database refusal comes back with its code (409 period clash, 422 shape), nothing else written', async () => {
    for (const [msg, code, st] of [['mi1b_period_already_registered: record 9 already covers this period', 'mi1b_period_already_registered', 409],
      ['new row for relation "mfr_sources" violates check constraint "mfr_sources_report_shape"', 'mfr_sources_report_shape', 422]]) {
      const { w, m } = boot({ rpc: () => ({ status: 400, body: { code: 'P0001', message: msg } }) });
      const r = await call(m, REG(), as('pres')); assert.strictEqual(r.status, st); assert.strictEqual(r.body.error, code);
      assert.deepStrictEqual(writesOf(w).map(c => c.u.replace(BASE, '').split('/').slice(0, 4).join('/')), ['/storage/v1/object', '/rest/v1/rpc']);
    }
  });
  await t('register never writes a business table (only storage + the register RPC)', async () => {
    const { w, m } = boot(); await call(m, REG(), as('pres'));
    for (const c of writesOf(w)) assert.ok(/\/storage\/v1\/object\/mfr-sources\/|\/rest\/v1\/rpc\/hcps_mfr_report_register$/.test(c.u), c.u);
  });

  await t('a database refusal AFTER the file was stored says so: kept privately, NOT registered, reused if registered again', async () => {
    const { w, m } = boot({ rpc: () => ({ status: 400, body: { message: 'mi1b_period_already_registered: dealer report 9 already covers this period' } }) });
    const r = await call(m, REG(), as('pres'));
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.file_stored, true);
    assert.strictEqual(r.body.storage_path, `reports/strongback-mobility/dealer_report/${sha(PDF)}.pdf`); assert.ok(/NOT registered/.test(r.body.file_note));
    assert.strictEqual(w.calls.filter(c => c.m === 'DELETE').length, 0, 'nothing is deleted');
  });

  console.log('\n— stored files without a record (read-only) —');
  await t('orphans lists stored report files no record names — and deletes nothing', async () => {
    const reg1 = 'reports/strongback-mobility/dealer_report/' + 'a'.repeat(64) + '.pdf', orph = 'reports/strongback-mobility/dealer_report/' + 'b'.repeat(64) + '.pdf',
      orph2 = 'reports/pedifix/commission_statement/' + 'c'.repeat(64) + '.xlsx';
    const { w, m } = boot({ objects: [reg1, orph, orph2, 'catalog/bemis/x.xlsx'], sources: [{ id: 9, manufacturer: 'strongback-mobility', kind: 'dealer_report', storage_path: reg1 }] });
    const r = await call(m, { action: 'orphans' }, as('pres'));
    assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.deepStrictEqual([r.body.stored, r.body.registered], [3, 1]);
    assert.deepStrictEqual(r.body.orphans.map(x => x.path).sort(), [orph2, orph].sort());
    assert.strictEqual(writesOf(w).filter(c => !/object\/list\//.test(c.u)).length, 0, 'read-only');
  });
  await t('orphans: storage or register unreadable → 503, never a guess; reps cannot ask', async () => {
    const a = boot({ failList: true }); assert.strictEqual((await call(a.m, { action: 'orphans' }, as('pres'))).status, 503);
    const b = boot({ objects: ['reports/x/dealer_report/' + 'a'.repeat(64) + '.pdf'], failRead: u => /mfr_sources/.test(u) }); assert.strictEqual((await call(b.m, { action: 'orphans' }, as('pres'))).status, 503);
    const c = boot(); assert.strictEqual((await call(c.m, { action: 'orphans' }, as('greg'))).status, 403);
  });

  console.log('\n— decide / publication / link / download —');
  await t('decide, publication, link_batch pass the verified actor and their inputs to the database functions', async () => {
    const { w, m } = boot();
    await call(m, { action: 'decide', id: 5, decision: 'rejected', reason: 'wrong month', actor: 'x@y' }, as('admin'));
    await call(m, { action: 'publication', id: 5, publication: 'publish', reason: 'r' }, as('pres'));
    await call(m, { action: 'link_batch', id: 5, batch_id: '0f0e0d0c-0b0a-4908-8706-050403020100' }, as('pres'));
    assert.deepStrictEqual(w.rpcs.map(x => x.fn), ['hcps_mfr_report_decide', 'hcps_mfr_report_publication', 'hcps_mfr_report_link_batch']);
    assert.deepStrictEqual([w.rpcs[0].p.actor, w.rpcs[0].p.decision, w.rpcs[0].p.reason], ['ad@hcps.us', 'rejected', 'wrong month']);
    assert.strictEqual(w.rpcs[1].p.action, 'publish'); assert.strictEqual(w.rpcs[2].p.batch_id, '0f0e0d0c-0b0a-4908-8706-050403020100');
  });
  await t('publish refused by the database (no MI-1c intelligence) → 409 with that code', async () => {
    const { m } = boot({ rpc: () => ({ status: 400, body: { message: 'mi1b_publish_unavailable: no dealer intelligence is staged for record 5 (MI-1c is not installed)' } }) });
    const r = await call(m, { action: 'publication', id: 5, publication: 'publish' }, as('pres'));
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.error, 'mi1b_publish_unavailable');
  });
  await t('bad ids are refused before the database', async () => {
    const { w, m } = boot();
    for (const b of [{ action: 'decide', id: 'x' }, { action: 'publication' }, { action: 'link_batch', id: 1, batch_id: 'nope' }, { action: 'download', id: 0 }]) {
      const r = await call(m, b, as('pres')); assert.strictEqual(r.status, 400, JSON.stringify(b)); }
    assert.strictEqual(w.rpcs.length, 0);
  });
  await t('download: a 2-minute signed link for a REPORT record only (never a catalog source)', async () => {
    const { w, m } = boot({ sources: [{ id: 4, manufacturer: 'bemis', kind: 'price_list', storage_path: 'catalog/bemis/price.xlsx', file_name: 'price.xlsx' }, { id: 9, manufacturer: 'strongback-mobility', kind: 'dealer_report', storage_path: 'reports/strongback-mobility/dealer_report/' + 'a'.repeat(64) + '.pdf', file_name: 'S.pdf' }] });
    assert.strictEqual((await call(m, { action: 'download', id: 4 }, as('pres'))).status, 404);
    const r = await call(m, { action: 'download', id: 9 }, as('pres'));
    assert.strictEqual(r.status, 200); assert.ok(r.body.url.startsWith(BASE + '/storage/v1/object/sign/mfr-sources/reports/')); assert.strictEqual(r.body.expires_in, 120);
    assert.strictEqual(JSON.parse(w.calls.find(c => /object\/sign/.test(c.u)).body).expiresIn, 120);
  });

  console.log('\n— list —');
  await t('list returns report records only, with their audit events; an unreadable table is a 503, never an empty list', async () => {
    const { m } = boot({ sources: [{ id: 1, manufacturer: 'bemis', kind: 'price_list' }, { id: 9, manufacturer: 'strongback-mobility', kind: 'dealer_report' }],
      events: [{ id: 1, source_id: 9, action: 'registered', actor: 'a' }] });
    const r = await call(m, { action: 'list' }, as('pres'));
    assert.deepStrictEqual(r.body.reports.map(x => x.id), [9]); assert.strictEqual(r.body.reports[0].events.length, 1);
    const b2 = boot({ sources: [{ id: 9, manufacturer: 'strongback-mobility', kind: 'dealer_report' }], failRead: u => /mfr_source_events/.test(u) }); const r2 = await call(b2.m, { action: 'list' }, as('pres'));
    assert.strictEqual(r2.status, 503);
    const b3 = boot({ failRead: u => /mfr_sources/.test(u) }); assert.strictEqual((await call(b3.m, { action: 'list' }, as('pres'))).status, 503);
  });

  console.log(`\nmi1b-api: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
