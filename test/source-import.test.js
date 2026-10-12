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
      const em = { pres: 'angelo@hcps.us', greg: 'greg@hcps.us', admin: 'ad@hcps.us' }[tok]; return em ? res(200, { email: em }) : res(401, {}); }
    if (u.startsWith(BASE + '/rest/v1/staff_users?email')) { const em = u.match(/email=eq\.([^&]+)/)[1];
      const s = { 'angelo@hcps.us': { role: 'president' }, 'greg@hcps.us': { role: 'rep' }, 'ad@hcps.us': { role: 'admin' } }[em]; return res(200, s ? [{ email: em, ...s }] : []); }
    if (u.startsWith(BASE + '/rest/v1/staff_users')) return res(200, []);
    if (o.failRead && m === 'GET' && o.failRead(u)) return res(500, { message: 'forced' });
    if (u.startsWith(BASE + '/storage/v1/object/mfr-sources/')) return res(200, BY);
    if (u.startsWith(BASE + '/rest/v1/mfr_sources') && u.includes('kind=eq.commission_statement')) return res(200, page(u, o.statements || []));
    if (u.startsWith(BASE + '/rest/v1/mfr_sources')) return res(200, page(u, [Object.assign({}, src, o.src || {})]));
    if (u.startsWith(BASE + '/rest/v1/dealers')) return res(200, page(u, DEALERS));
    if (u.startsWith(BASE + '/rest/v1/dealer_manufacturers')) return res(200, page(u, ACCOUNTS));
    if (u.startsWith(BASE + '/rest/v1/dealer_aliases') || u.startsWith(BASE + '/rest/v1/dealer_directory')) return res(200, page(u, []));
    if (u.startsWith(BASE + '/rest/v1/app_settings')) return res(200, o.flags ? [{ value: o.flags }] : []);
    if (u.startsWith(BASE + '/rest/v1/mfr_quarantine_dispositions')) return o.phaseE ? res(200, page(u, o.phaseE.dispositions || [])) : res(404, { code: 'PGRST205' });
    if (u.startsWith(BASE + '/rest/v1/mfr_auto_import_log')) return o.phaseE ? res(200, page(u, o.phaseE.log || [])) : res(404, { code: 'PGRST205' });
    if (u.startsWith(BASE + '/rest/v1/mfr_import_approvals')) return o.phaseE ? res(200, page(u, (o.phaseE.approvals || []).filter(a => !u.includes('used_at=is.null') || !a.used_at))) : res(404, { code: 'PGRST205' });
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
      const { r } = await check(mk(x)); const v = r.body.verdict;
      // Phase E: a collision is a blocker; changed orders, cross-lane matches and paid months are approvable exceptions.
      if (code === 'semantic_collision') assert.ok(v.blockers.some(b => b.code === code), code);
      else { assert.ok(v.approvals.some(b => b.code === code) && !v.blockers.some(b => b.code === code), code); assert.strictEqual(v.approvable, true, code); }
      assert.strictEqual(v.eligible, false);
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

  console.log('\n— Phase E: quarantine disposition, approvals, automatic import (switch default OFF) —');
  const md5 = t => crypto.createHash('md5').update(t).digest('hex');
  const QROWS = [1, 2, 3].map(i => ({ id: i, sales_row_id: String(100 + i), manufacturer: 'strongback-mobility', period: '2026-09-01', source: 'commission',
    source_file: 'Strongback Sept Commission Report 2026.csv', reason: 'blank', row_fp: 'fp' + i, row_data: { invoice_no: null, amount: null, commission: null } }));
  const QFP = md5(QROWS.map(q => q.id + ':' + q.row_fp).join(';'));
  const DISP = (o) => Object.assign({ id: 1, manufacturer: 'strongback-mobility', period: '2026-09-01', disposition: 'keep_quarantined', quarantine_ids: [1, 2, 3], quarantine_fp: QFP,
    release_source_id: 8, reason: 'blank rows from a mis-mapped import', actor: 'staff:angelo@hcps.us', created_at: 'x' }, o || {});
  const ON = { mi_auto_import: true };
  // MI-1a fake: dry run as before; apply:true imports and answers like hcps_sales_report_apply.
  const miFake = (extra) => (fn, p) => {
    if (fn === 'hcps_sales_report_apply') { const ord = { new: new Set(p.rows.map(r => r.invoice_no)).size, unchanged: 0, changed: 0, retire: 0 };
      const base = { rows: p.rows.length, cross_lane_matches: 0, orders: ord, missing_from_file: [], semantic_collisions: [], nonfinancial_differences: [], locked_months_touched: [], needs_paid_approval: false };
      return { status: 200, body: p.apply ? Object.assign(base, { applied: true, batch_id: '11111111-2222-3333-4444-555555555555', inserted: p.rows.length, superseded: 0 }, (extra && extra.applied) || {}) : Object.assign(base, { applied: false }) }; }
    if (fn === 'hcps_mfr_import_approve') return { status: 200, body: { ok: true, approval_id: 41 } };
    if (extra && extra.fail && extra.fail[fn]) return { status: 400, body: { message: extra.fail[fn] } };
    return { status: 200, body: { ok: true } };
  };
  const fns = w => w.rpcs.map(x => x.fn);
  await t('no disposition: the quarantined month blocks as before; Phase E not installed is reported, never guessed', async () => {
    const { r } = await check({ quarantine: QROWS });
    assert.ok(r.body.verdict.blockers.some(b => b.code === 'quarantined_period')); assert.strictEqual(r.body.verdict.approvable, false);
    assert.deepStrictEqual([r.body.auto_import.installed, r.body.auto_import.switch_on], [false, false]);
  });
  await t('a keep-quarantined disposition releasing THIS export turns the block into an approval item (never eligible on its own)', async () => {
    const { r } = await check({ quarantine: QROWS, phaseE: { dispositions: [DISP()] } });
    const v = r.body.verdict; assert.deepStrictEqual([v.eligible, v.approvable, v.blockers.length], [false, true, 0], JSON.stringify(v.blockers));
    assert.ok(v.approvals.some(a => a.code === 'quarantine_released')); assert.match(r.body.plan_hash, /^[0-9a-f]{64}$/);
  });
  await t('a disposition for another file, or quarantined rows changed since it was recorded, releases nothing', async () => {
    for (const d of [DISP({ release_source_id: 99 }), DISP({ release_source_id: null }), DISP({ quarantine_fp: md5('other') }), DISP({ quarantine_ids: [1, 2] })]) {
      const { r } = await check({ quarantine: QROWS, phaseE: { dispositions: [d] } });
      assert.ok(r.body.verdict.blockers.some(b => b.code === 'quarantined_period'), JSON.stringify(d)); assert.strictEqual(r.body.verdict.approvable, false);
    }
    const { r } = await check({ quarantine: QROWS.concat([{ ...QROWS[0], id: 4, row_fp: 'fp4' }]), phaseE: { dispositions: [DISP()] } });
    assert.ok(r.body.verdict.blockers.some(b => b.code === 'quarantined_period'), 'a new quarantined row in the month');
  });
  await t('quarantine_dispose: President only; dry run writes nothing; the record carries the verified actor', async () => {
    let x = boot({ phaseE: {} }); let r = await call(x.m, { action: 'quarantine_dispose', manufacturer: 'strongback-mobility', period: '2026-09', quarantine_fp: QFP, release_source_id: 8, reason: 'blank rows' }, { token: 'greg' });
    assert.strictEqual(r.status, 403); assert.strictEqual(x.w.rpcs.length, 0);
    x = boot({ phaseE: {}, rpc: miFake() }); r = await call(x.m, { action: 'quarantine_dispose', manufacturer: 'strongback-mobility', period: '2026-09', quarantine_fp: QFP, release_source_id: 8, reason: 'blank rows from a mis-mapped import' }, { token: 'admin' });
    assert.deepStrictEqual([r.status, r.body.error], [403, 'president_only']); assert.strictEqual(x.w.rpcs.length, 0, 'an admin cannot record it');
    x = boot({ phaseE: {} }); r = await call(x.m, { action: 'quarantine_dispose', manufacturer: 'strongback-mobility', period: '2026-09', quarantine_fp: QFP, release_source_id: 8, reason: 'blank rows from a mis-mapped import', dry_run: true, actor: 'staff:someone@x' }, { token: 'pres' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.strictEqual(r.body.dry_run, true); assert.strictEqual(x.w.rpcs.length, 0); assert.deepStrictEqual(writes(x.w), []);
    x = boot({ phaseE: {}, rpc: miFake() }); r = await call(x.m, { action: 'quarantine_dispose', manufacturer: 'strongback-mobility', period: '2026-09', quarantine_fp: QFP, release_source_id: 8, reason: 'blank rows from a mis-mapped import', actor: 'staff:someone@x' }, { token: 'pres' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.deepStrictEqual(fns(x.w), ["hcps_mfr_quarantine_dispose"]);
    assert.deepStrictEqual([x.w.rpcs[0].p.actor, x.w.rpcs[0].p.release_source_id, x.w.rpcs[0].p.period], ['staff:angelo@hcps.us', '8', '2026-09']);
  });
  await t('approve_import: President only; refused while the switch is OFF or Phase E is missing — nothing recorded or imported', async () => {
    const body = { action: 'approve_import', source_id: 8, plan_hash: 'x'.repeat(64), reason: 'September orders approved' };
    let x = boot({ quarantine: QROWS, phaseE: { dispositions: [DISP()] }, flags: ON }); let r = await call(x.m, body, { token: 'greg' }); assert.strictEqual(r.status, 403);
    x = boot({ quarantine: QROWS, phaseE: { dispositions: [DISP()] }, flags: ON, rpc: miFake() }); r = await call(x.m, body, { token: 'admin' });
    assert.deepStrictEqual([r.status, r.body.error], [403, 'president_only']); assert.ok(!x.w.rpcs.some(q => q.fn !== 'hcps_sales_report_apply'));
    x = boot({ quarantine: QROWS, phaseE: { dispositions: [DISP()] } }); r = await call(x.m, body, { token: 'pres' });
    assert.deepStrictEqual([r.status, r.body.error], [409, 'switch_off']); assert.ok(!fns(x.w).some(f => f !== 'hcps_sales_report_apply'));
    x = boot({ quarantine: QROWS, flags: ON }); r = await call(x.m, body, { token: 'pres' }); assert.deepStrictEqual([r.status, r.body.error], [503, 'not_installed']);
  });
  await t('the plan hash covers every row: one changed line, one changed count or another approval set → another hash', () => {
    const rows = [{ invoice_no: '1', amount: 10, dealer_id: 'a', imported_at: 'x' }, { invoice_no: '2', amount: 20, dealer_id: 'b', imported_at: 'y' }];
    const base = { source_id: 8, sha256: 's', rows, v2: { orders: { new: 2 } }, approvals: [{ code: 'quarantine_released' }] };
    const h = SI.planHash(base);
    assert.strictEqual(SI.planHash(Object.assign({}, base, { rows: rows.map(r => Object.assign({}, r, { imported_at: 'later' })) })), h, 'the import timestamp is not part of the plan');
    assert.notStrictEqual(SI.planHash(Object.assign({}, base, { rows: [rows[0], Object.assign({}, rows[1], { amount: 21 })] })), h);
    assert.notStrictEqual(SI.planHash(Object.assign({}, base, { rows: [rows[0], Object.assign({}, rows[1], { dealer_id: 'c' })] })), h);
    assert.notStrictEqual(SI.planHash(Object.assign({}, base, { v2: { orders: { new: 1, changed: 1 } } })), h);
    assert.notStrictEqual(SI.planHash(Object.assign({}, base, { approvals: [] })), h);
  });
  await t('approve_import: a plan that changed since review is refused; blockers can never be approved', async () => {
    let x = boot({ quarantine: QROWS, phaseE: { dispositions: [DISP()] }, flags: ON, rpc: miFake() });
    let r = await call(x.m, { action: 'approve_import', source_id: 8, plan_hash: 'a'.repeat(64), reason: 'September orders approved' }, { token: 'pres' });
    assert.deepStrictEqual([r.status, r.body.error], [409, 'plan_changed']); assert.ok(!fns(x.w).includes('hcps_mfr_import_approve'));
    x = boot({ quarantine: QROWS, flags: ON, phaseE: {}, rpc: miFake() });
    const c = await call(x.m, { action: 'import_check', source_id: 8 }, { token: 'pres' });
    r = await call(x.m, { action: 'approve_import', source_id: 8, plan_hash: c.body.plan_hash, reason: 'September orders approved' }, { token: 'pres' });
    assert.deepStrictEqual([r.status, r.body.error], [409, 'not_approvable']); assert.ok(!fns(x.w).includes('hcps_sales_report_apply') || x.w.rpcs.every(q => q.fn !== 'hcps_sales_report_apply' || q.p.apply === false));
  });
  await t('approved import of the released export: accept → MI-1a apply (one call, no extra confirmations) → link → log → approval used', async () => {
    const o = { quarantine: QROWS, phaseE: { dispositions: [DISP()] }, flags: ON, rpc: miFake() };
    const x = boot(o); const c = await call(x.m, { action: 'import_check', source_id: 8 }, { token: 'pres' });
    const r = await call(x.m, { action: 'approve_import', source_id: 8, plan_hash: c.body.plan_hash, reason: 'September orders approved' }, { token: 'pres' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.strictEqual(r.body.outcome, 'imported');
    const seq = fns(x.w).filter(f => !(f === 'hcps_sales_report_apply' && false));
    const writesSeq = x.w.rpcs.filter(q => q.fn !== 'hcps_sales_report_apply' || q.p.apply === true).map(q => q.fn);
    assert.deepStrictEqual(writesSeq, ['hcps_mfr_import_approve', 'hcps_mfr_report_decide', 'hcps_sales_report_apply', 'hcps_mfr_report_link_batch', 'hcps_mfr_auto_import_log', 'hcps_mfr_import_use'], seq.join(','));
    const ap = x.w.rpcs.find(q => q.fn === 'hcps_sales_report_apply' && q.p.apply === true).p;
    assert.deepStrictEqual([ap.confirm_cross_lane, ap.approve_paid, ap.retire_orders.length, ap.source_file], [false, false, 0, 'Angelo Sep Orders.csv']);
    assert.strictEqual(x.w.rpcs.find(q => q.fn === 'hcps_mfr_import_use').p.outcome, 'imported');
    assert.strictEqual(x.w.rpcs.find(q => q.fn === 'hcps_mfr_report_decide').p.decision, 'accepted');
    assert.deepStrictEqual(writes(x.w), [], 'no direct table write — only the audited functions');
  });
  await t('an import that does not match the checked plan is rolled back at once; a failed link is rolled back too', async () => {
    for (const extra of [{ applied: { orders: { new: 1, unchanged: 0, changed: 2, retire: 0 } } }, { fail: { hcps_mfr_report_link_batch: 'mi1b_bad_link: x' } }]) {
      const x = boot({ quarantine: QROWS, phaseE: { dispositions: [DISP()] }, flags: ON, rpc: miFake(extra) });
      const c = await call(x.m, { action: 'import_check', source_id: 8 }, { token: 'pres' });
      const r = await call(x.m, { action: 'approve_import', source_id: 8, plan_hash: c.body.plan_hash, reason: 'September orders approved' }, { token: 'pres' });
      assert.deepStrictEqual([r.status, r.body.outcome], [409, 'rolled_back'], JSON.stringify(r.body));
      assert.ok(fns(x.w).includes('hcps_import_batch_rollback')); assert.strictEqual(x.w.rpcs.find(q => q.fn === 'hcps_mfr_import_use').p.outcome, 'rolled_back');
    }
  });
  await t('automatic run: does nothing while the switch is off; a clean report is imported; an approval case is logged once and never applied', async () => {
    const SR = F('shipto-review-api.js');
    let x = boot({ phaseE: {}, rpc: miFake() }); let res = await x.m.runAutoImport(); assert.strictEqual(res.skipped, 'switch_off'); assert.strictEqual(x.w.rpcs.length, 0);
    x = boot({ flags: ON, rpc: miFake() }); res = await x.m.runAutoImport(); assert.strictEqual(res.skipped, 'not_installed');
    x = boot({ phaseE: {}, flags: ON, rpc: miFake() }); res = await x.m.runAutoImport();
    assert.strictEqual(res.results[0].outcome, 'imported', JSON.stringify(res)); assert.ok(x.w.rpcs.some(q => q.fn === 'hcps_sales_report_apply' && q.p.apply === true));
    assert.strictEqual(x.w.rpcs.find(q => q.fn === 'hcps_mfr_report_decide').p.actor, 'system:auto-import'); assert.ok(!fns(x.w).includes('hcps_mfr_import_use'));
    x = boot({ quarantine: QROWS, phaseE: { dispositions: [DISP()] }, flags: ON, rpc: miFake() }); res = await x.m.runAutoImport();
    assert.strictEqual(res.results[0].outcome, 'needs_approval'); assert.ok(!x.w.rpcs.some(q => q.fn === 'hcps_sales_report_apply' && q.p.apply === true));
    assert.strictEqual(x.w.rpcs.filter(q => q.fn === 'hcps_mfr_auto_import_log').length, 1);
    const ph = res.results[0].plan_hash;
    x = boot({ quarantine: QROWS, phaseE: { dispositions: [DISP()], log: [{ id: 1, source_id: 8, outcome: 'needs_approval', plan_hash: ph }] }, flags: ON, rpc: miFake() });
    res = await x.m.runAutoImport(); assert.strictEqual(x.w.rpcs.filter(q => q.fn === 'hcps_mfr_auto_import_log').length, 0, 'the same plan is not logged twice');
    x = boot({ csv: HELD_CSV, phaseE: {}, flags: ON, rpc: miFake() }); res = await x.m.runAutoImport();
    assert.strictEqual(res.results[0].outcome, 'held'); assert.ok(!x.w.rpcs.some(q => q.fn === 'hcps_sales_report_apply'));
    x = boot({ phaseE: {}, flags: ON, rpc: miFake(), src: { import_batch_id: 'b' } });
    assert.ok(SR);
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
