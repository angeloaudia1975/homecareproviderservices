/* Phase D — the source-aware import check (netlify/functions/_source_import.js + shipto-review-api import_check).
   A registered order export → strict Ship-To (+ saved correction overlays) → MI-1a DRY RUN only. A held report never
   reaches MI-1a; automatic financial posting is OFF (apply is always false, whatever the request says); quarantined
   rows and other lanes block eligibility; the manual importer's mapRow is copied verbatim.
     node test/source-import.test.js */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { load, call } = require('./phase0-mock');
const { HEADER, line, W, CSV: HELD_CSV, DEALERS, ACCOUNTS } = require('./fixtures/shipto-fixture.js');
const F = f => require(path.join(__dirname, '..', 'netlify', 'functions', f));
const BASE = 'https://db.test';

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + String(e && e.message || e).split('\n')[0]); } }

// A report every order of which resolves: one dealer, a unique-ZIP branch, a ZIP with a leading zero.
const READY_CSV = [HEADER,
  line({ n: 7139, user: 'harmonia', company: 'Harmonia Medical Supply', sname: 'Harmonia Medical Supply', saddr: '415 Vigo Street', scity: 'Vincennes', sstate: 'IN', szip: '47591-1143' }),
  line({ n: 7139, sku: '1010AB', user: 'harmonia', company: 'Harmonia Medical Supply', sname: 'Harmonia Medical Supply', saddr: '415 Vigo Street', scity: 'Vincennes', sstate: 'IN', szip: '47591-1143', price: '541.00' }),
  line(Object.assign({ n: 7191, sname: 'Wilbur Brothers Princeton', saddr: '101 W. Brumfield Avenue', scity: 'Princeton', sstate: 'Indiana', szip: '47670', price: '320.00' }, W)),
  line({ n: 7210, user: 'boston', company: 'Boston Rehab', sname: 'Boston Rehab', saddr: '1 Main St', scity: 'Boston', sstate: 'MA', szip: '02134', price: '297.00' }),
].join('\r\n') + '\r\n';

function world(o) {
  o = o || {};
  const csv = o.csv || READY_CSV, BY = Buffer.from(csv, 'utf8'), SHA = crypto.createHash('sha256').update(BY).digest('hex');
  const st = { calls: [], rpcs: [] };
  const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => typeof body === 'string' ? body : JSON.stringify(body),
    arrayBuffer: async () => { const b = Buffer.isBuffer(body) ? body : Buffer.from(String(body)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); } });
  const page = (u, rows) => /offset=([1-9])/.test(u) ? [] : rows;
  const src = { id: 8, manufacturer: 'strongback-mobility', kind: 'sales_export', title: 'Strongback orders', file_name: 'Angelo Sep Orders.csv', file_sha256: SHA,
    storage_path: `reports/strongback-mobility/sales_export/${SHA}.csv`, received_date: '2026-10-02', report_period_start: '2026-09-01', report_period_end: '2026-09-30', status: 'received' };
  st.fetch = async (url, opts) => {
    opts = opts || {}; const u = decodeURIComponent(String(url)), m = (opts.method || 'GET').toUpperCase(); st.calls.push({ u, m, body: opts.body });
    if (u.startsWith(BASE + '/auth/v1/user')) { const tok = String((opts.headers || {}).Authorization || '').replace('Bearer ', '');
      const em = { pres: 'angelo@hcps.us', greg: 'greg@hcps.us' }[tok]; return em ? res(200, { email: em }) : res(401, {}); }
    if (u.startsWith(BASE + '/rest/v1/staff_users?email')) { const em = u.match(/email=eq\.([^&]+)/)[1];
      const s = { 'angelo@hcps.us': { role: 'president' }, 'greg@hcps.us': { role: 'rep' } }[em]; return res(200, s ? [{ email: em, ...s }] : []); }
    if (u.startsWith(BASE + '/rest/v1/staff_users')) return res(200, []);
    if (o.failRead && m === 'GET' && o.failRead(u)) return res(500, { message: 'forced' });
    if (u.startsWith(BASE + '/storage/v1/object/mfr-sources/')) return res(200, BY);
    if (u.startsWith(BASE + '/rest/v1/mfr_sources') && u.includes('kind=eq.commission_statement')) return res(200, page(u, o.statements || []));
    if (u.startsWith(BASE + '/rest/v1/mfr_sources')) return res(200, page(u, [src]));
    if (u.startsWith(BASE + '/rest/v1/dealers')) return res(200, page(u, DEALERS));
    if (u.startsWith(BASE + '/rest/v1/dealer_manufacturers')) return res(200, page(u, ACCOUNTS));
    if (u.startsWith(BASE + '/rest/v1/dealer_aliases') || u.startsWith(BASE + '/rest/v1/dealer_directory')) return res(200, page(u, []));
    if (u.startsWith(BASE + '/rest/v1/app_settings')) return res(200, []);
    if (u.startsWith(BASE + '/rest/v1/mfr_shipto_mappings')) return res(200, page(u, []));
    if (u.startsWith(BASE + '/rest/v1/mfr_shipto_corrections')) return res(200, page(u, o.corrections || []));
    if (u.startsWith(BASE + '/rest/v1/mi1a_enrollment')) return res(200, o.enrolled === false ? [] : [{ manufacturer: 'strongback-mobility' }]);
    if (u.startsWith(BASE + '/rest/v1/monthly_sales_quarantine')) return res(200, page(u, o.quarantine || []));
    if (u.startsWith(BASE + '/rest/v1/monthly_sales') && u.includes('select=id,commission_rate')) return res(200, page(u, (o.rates || [0.09, 0.09]).map((r, i) => ({ id: i, commission_rate: r }))));
    if (u.startsWith(BASE + '/rest/v1/monthly_sales') && u.includes('invoice_no=in.')) return res(200, page(u, o.existing || []));
    if (u.startsWith(BASE + '/rest/v1/monthly_sales')) return res(200, page(u, o.monthRows || []));
    if (u.startsWith(BASE + '/rest/v1/rpc/')) { const fn = u.split('/rpc/')[1]; const p = JSON.parse(opts.body).p; st.rpcs.push({ fn, p });
      if (o.rpc) { const r = o.rpc(fn, p); if (r) return res(r.status, r.body); }
      return res(200, { manufacturer: p.manufacturer, rows: p.rows.length, total_amount: p.rows.reduce((s, r) => s + r.amount, 0), cross_lane_matches: 0,
        orders: { new: new Set(p.rows.map(r => r.invoice_no)).size, unchanged: 0, changed: 0, retire: 0 }, changed_detail: [], missing_from_file: [],
        semantic_collisions: [], nonfinancial_differences: [], locked_months_touched: [], needs_paid_approval: false, applied: false }); }
    return res(404, { message: 'unexpected ' + m + ' ' + u });
  };
  return st;
}
const boot = o => { const w = world(o); return { w, m: load('shipto-review-api.js', w) }; };
const writes = w => w.calls.filter(c => c.m !== 'GET' && !c.u.includes('/rpc/') && !c.u.includes('/auth/v1/'));
const check = async (o, body) => { const { w, m } = boot(o); const r = await call(m, Object.assign({ action: 'import_check', source_id: 8 }, body || {}), { token: 'pres' }); return { w, r }; };

(async () => {
  boot();   // compile through the mock loader (mutants)
  const SI = F('_source_import.js');

  console.log('\n— the manual importer is untouched; its row mapping is copied verbatim —');
  await t('mapRow in _source_import.js is byte-identical to sales-import-api.js mapRow', () => {
    const grab = s => s.slice(s.indexOf('function mapRow('), s.indexOf('\n}\n', s.indexOf('function mapRow(')) + 2);
    const a = grab(fs.readFileSync(path.join(__dirname, '..', 'netlify', 'functions', 'sales-import-api.js'), 'utf8'));
    const b = grab(fs.readFileSync(path.join(__dirname, '..', 'netlify', 'functions', '_source_import.js'), 'utf8'));
    assert.ok(a.length > 400); assert.strictEqual(b, a);
  });
  await t('rate: only a single rate in the sales-report history is used; mixed or none → no rate', () => {
    assert.deepStrictEqual(SI.rateFromHistory([0.09, '0.09', 0.09]), { rate: 0.09, basis: 'history_single_rate' });
    assert.strictEqual(SI.rateFromHistory([0.09, 0.15]).rate, null); assert.strictEqual(SI.rateFromHistory([]).rate, null);
  });

  console.log('\n— held reports never reach MI-1a —');
  await t('a report with an unresolved order is HELD: no MI-1a call, not eligible, the held orders are named', async () => {
    const { w, r } = await check({ csv: HELD_CSV });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.plan.status, 'held'); assert.ok(r.body.plan.held_orders.length >= 4);
    assert.strictEqual(w.rpcs.length, 0, 'MI-1a is never called for a held report'); assert.strictEqual(r.body.v2, null);
    assert.strictEqual(r.body.verdict.eligible, false); assert.ok(r.body.verdict.blockers.some(b => b.code === 'ship_to_review'));
    assert.deepStrictEqual(writes(w), []);
  });

  console.log('\n— a ready report: strict branches + overlays → MI-1a dry run —');
  await t('every order resolved strictly; rows carry the strict branch; MI-1a is called once with apply:false', async () => {
    const { w, r } = await check();
    assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.strictEqual(r.body.plan.status, 'ready');
    assert.strictEqual(w.rpcs.length, 1); assert.strictEqual(w.rpcs[0].fn, 'hcps_sales_report_apply'); assert.strictEqual(w.rpcs[0].p.apply, false);
    const rows = w.rpcs[0].p.rows; assert.strictEqual(rows.length, 4);
    assert.deepStrictEqual([...new Set(rows.map(x => x.dealer_id))].sort(), ['bos', 'harm', 'wpr']);
    assert.ok(rows.every(x => x.source === 'sales_report' && x.external_ref === undefined && x.commission_rate === 0.09));
    assert.strictEqual(rows.find(x => x.invoice_no === '7210').ship_zip, '02134');
    assert.strictEqual(r.body.plan.totals.amount, 1658); assert.strictEqual(r.body.plan.totals.commission, 149.22);
    assert.strictEqual(r.body.verdict.eligible, true, JSON.stringify(r.body.verdict.blockers)); assert.strictEqual(r.body.verdict.automatic_posting, 'off');
    assert.deepStrictEqual(writes(w), []);
  });
  await t('apply can never be requested: apply / action:import in the body still sends apply:false', async () => {
    const { w } = await check({}, { apply: true, action2: 'import', confirm_cross_lane: true, approve_paid: true });
    assert.strictEqual(w.rpcs[0].p.apply, false); assert.strictEqual(w.rpcs[0].p.confirm_cross_lane, false); assert.strictEqual(w.rpcs[0].p.approve_paid, false);
  });
  await t('a saved correction overlay supplies the branch and its corrected ship-to; the file is not changed', async () => {
    const RR = F('_report_rows.js'), RV = F('_shipto_review.js');
    const parsed = RR.readOrderRows(Buffer.from(HELD_CSV, 'utf8'), 'csv');
    const fp = RV.buildReview(parsed.rows, {}).orders.find(x => x.order_key === 'o:7200').fingerprint;
    const corrections = ['o:7200', 'o:7201', 'o:7202', 'o:7203', 'o:7204'].map((k, i) => {
      const f = RV.buildReview(parsed.rows, {}).orders.find(x => x.order_key === k).fingerprint;
      return { id: i + 1, order_key: k, version: 1, order_fingerprint: f, scope: 'branch', dealer_id: k === 'o:7202' ? 'tb2' : k === 'o:7203' ? 'bos' : 'wja',
        ship_city: k === 'o:7200' ? 'Jasper' : null, ship_zip: k === 'o:7200' ? '47546' : null, reason: 'checked', actor: 'staff:angelo@hcps.us', created_at: 'x' };
    });
    assert.ok(fp);
    const { w, r } = await check({ csv: HELD_CSV, corrections });
    assert.strictEqual(r.body.plan.status, 'ready', JSON.stringify(r.body.plan.held_orders));
    const row = w.rpcs[0].p.rows.find(x => x.invoice_no === '7200');
    assert.deepStrictEqual([row.dealer_id, row.ship_city, row.ship_zip], ['wja', 'Jasper', '47546']);
    assert.strictEqual(r.body.plan.orders.find(o => o.order_key === 'o:7200').correction_version, 1);
  });

  console.log('\n— eligibility —');
  await t('quarantined rows with the same order numbers block it — never converted into sales', async () => {
    const { r } = await check({ quarantine: [{ id: 1, sales_row_id: '99', manufacturer: 'strongback-mobility', period: '2026-09-01', source: 'commission', source_file: 'Strongback Sept Commission Report 2026.csv',
      reason: 'blank', row_data: { invoice_no: '7139', amount: null, commission: null } }] });
    assert.strictEqual(r.body.quarantined.length, 1); assert.strictEqual(r.body.verdict.eligible, false);
    assert.ok(r.body.verdict.blockers.some(b => b.code === 'previously_quarantined'));
  });
  await t('quarantined rows in the same month block it even without matching order numbers (September Strongback)', async () => {
    const { r } = await check({ quarantine: [{ id: 2, sales_row_id: '98', manufacturer: 'strongback-mobility', period: '2026-09-01', source: 'commission', source_file: 'Strongback Sept Commission Report 2026.csv',
      reason: 'blank', row_data: { invoice_no: null, amount: null, commission: null } }, { id: 3, sales_row_id: '97', period: '2026-07-01', row_data: {} }] });
    assert.strictEqual(r.body.quarantined.length, 0); assert.strictEqual(r.body.quarantined_in_period.length, 1);
    assert.strictEqual(r.body.verdict.eligible, false); assert.ok(r.body.verdict.blockers.some(b => b.code === 'quarantined_period'));
  });
  await t('rows in another lane with the same order numbers block it; sales-report rows of the same order are shown as recorded', async () => {
    const { r } = await check({ existing: [{ id: 5, invoice_no: '7191', period: '2026-09-01', source: 'commission', external_ref: null, amount: 320, commission: 28.8, dealer_id: 'wpr' }] });
    assert.ok(r.body.verdict.blockers.some(b => b.code === 'other_lane_rows'));
    assert.strictEqual(r.body.plan.orders.find(o => o.order_number === '7191').recorded[0].lane, 'commission');
  });
  await t('MI-1a findings block: cross-lane, changed orders, collisions, paid months; a refusal is reported', async () => {
    const mk = extra => ({ rpc: (fn, p) => ({ status: 200, body: Object.assign({ rows: p.rows.length, cross_lane_matches: 0, orders: { new: 3, unchanged: 0, changed: 0, retire: 0 },
      missing_from_file: [], semantic_collisions: [], nonfinancial_differences: [], locked_months_touched: [], needs_paid_approval: false, applied: false }, extra) }) });
    for (const [x, code] of [[{ cross_lane_matches: 2 }, 'cross_lane_duplicate'], [{ orders: { new: 2, unchanged: 0, changed: 1, retire: 0 } }, 'changes_existing_orders'],
      [{ semantic_collisions: [{}] }, 'semantic_collision'], [{ needs_paid_approval: true, locked_months_touched: ['2026-09'] }, 'paid_period']]) {
      const { r } = await check(mk(x)); assert.ok(r.body.verdict.blockers.some(b => b.code === code), code); assert.strictEqual(r.body.verdict.eligible, false);
    }
    const { r } = await check({ rpc: () => ({ status: 400, body: { message: 'mi1a_identity_not_approved: x' } }) });
    assert.ok(r.body.verdict.blockers.some(b => b.code === 'mi1a_refused'));
  });
  await t('not enrolled / no single rate: blocked and MI-1a is not called', async () => {
    let x = await check({ enrolled: false }); assert.strictEqual(x.w.rpcs.length, 0); assert.ok(x.r.body.verdict.blockers.some(b => b.code === 'not_enrolled'));
    x = await check({ rates: [0.09, 0.1] }); assert.strictEqual(x.w.rpcs.length, 0); assert.ok(x.r.body.verdict.blockers.some(b => b.code === 'rate_unknown'));
  });
  await t('a registered commission statement for the month is a caution (stays in its own lane), not a blocker', async () => {
    const { r } = await check({ statements: [{ id: 9, title: 'SR032', file_name: '2026-09 SR032.pdf', status: 'received', report_period_start: '2026-09-01', report_period_end: '2026-09-30', import_batch_id: null }] });
    assert.strictEqual(r.body.statements.length, 1); assert.ok(r.body.verdict.cautions.some(c => c.code === 'statement_registered'));
    assert.strictEqual(r.body.verdict.eligible, true);
  });

  console.log('\n— September quarantine review (read-only) —');
  await t('quarantine review: each quarantined row with its original source and amounts, matched to the registered export; choices; nothing written', async () => {
    const qrow = (id, cust) => ({ id, sales_row_id: String(100 + id), manufacturer: 'strongback-mobility', period: '2026-09-01', source: 'commission',
      source_file: 'Strongback Sept Commission Report 2026.csv', reason: 'blank amount and commission', row_fp: 'fp' + id, quarantined_at: '2026-10-11T02:43:00Z',
      quarantined_by: 'owner:sql-editor', restored_at: null, row_data: { invoice_no: null, customer_name: cust, amount: null, commission: null, dealer_id: 'wpr' } });
    const { w, r } = await check({ quarantine: [qrow(1, 'Harmonia Medical Supply'), qrow(2, 'Nobody Known')] }, { action: 'quarantine_review', manufacturer: 'strongback-mobility', period: '2026-09' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.strictEqual(r.body.read_only, true);
    assert.strictEqual(r.body.quarantined.length, 2); assert.strictEqual(r.body.totals.with_amount, 0);
    assert.strictEqual(r.body.quarantined[0].original.dealer, 'Wilbur Brothers Princeton');
    assert.deepStrictEqual(r.body.quarantined[0].matches.map(m => [m.order_number, m.amount, m.basis]), [['7139', 1041, 'customer']]);
    assert.strictEqual(r.body.quarantined[1].matches.length, 0);
    assert.deepStrictEqual(r.body.choices.map(c => c.key), ['keep_quarantined', 'import_export', 'import_statement', 'restore']);
    assert.deepStrictEqual(writes(w), []); assert.strictEqual(w.rpcs.length, 0);
  });

  console.log('\n— API —');
  await t('management only; an unreadable source is a 503, never "no evidence"', async () => {
    const { m } = boot(); assert.strictEqual((await call(m, { action: 'import_check', source_id: 8 })).status, 401);
    assert.strictEqual((await call(m, { action: 'import_check', source_id: 8 }, { token: 'greg' })).status, 403);
    for (const tb of ['monthly_sales_quarantine', 'mi1a_enrollment', 'monthly_sales']) {
      const { r } = await check({ failRead: u => u.includes('/rest/v1/' + tb + '?') }); assert.strictEqual(r.status, 503, tb);
    }
  });

  console.log(`\nsource-import: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})();
