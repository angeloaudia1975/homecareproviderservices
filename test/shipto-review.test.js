/* Phase C — Ship-To review: the server reader (_report_rows.js), the order-level review (_shipto_review.js), the
   strict resolver additions (_shipto.js: state names, saved ZIP assignments, the shared matcher) and the API
   (shipto-review-api.js) against a small fake of Supabase Auth / PostgREST / Storage / RPC. All modules are loaded
   through phase0-mock's loader so a mutant of any of them is the version under test.
     node test/shipto-review.test.js */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { load, call } = require('./phase0-mock');
const BASE = 'https://db.test';
const F = f => require(path.join(__dirname, '..', 'netlify', 'functions', f));

const { HEADER, COLS, line, W, CSV, BYTES, SHA, DEALERS, ACCOUNTS } = require('./fixtures/shipto-fixture.js');

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + String(e && e.message || e).split('\n')[0]); } }

function world(o) {
  o = o || {};
  const st = { calls: [], rpcs: [], corrections: (o.corrections || []).slice(), mappings: (o.mappings || []).slice() };
  const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => typeof body === 'string' ? body : JSON.stringify(body),
    arrayBuffer: async () => { const b = Buffer.isBuffer(body) ? body : Buffer.from(String(body)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); } });
  const page = (u, rows) => /offset=([1-9])/.test(u) ? [] : rows;
  st.fetch = async (url, opts) => {
    opts = opts || {}; const u = String(url), m = (opts.method || 'GET').toUpperCase(); st.calls.push({ u, m, body: opts.body });
    if (u.startsWith(BASE + '/auth/v1/user')) { const tok = String((opts.headers || {}).Authorization || '').replace('Bearer ', '');
      const em = { pres: 'angelo@hcps.us', admin: 'ad@hcps.us', greg: 'greg@hcps.us', lori: 'lori@hcps.us', off: 'gone@hcps.us' }[tok]; return em ? res(200, { email: em }) : res(401, {}); }
    if (u.startsWith(BASE + '/rest/v1/staff_users')) { const em = decodeURIComponent(u.match(/email=eq\.([^&]+)/)[1]);
      const s = { 'angelo@hcps.us': { role: 'president' }, 'ad@hcps.us': { role: 'admin' }, 'greg@hcps.us': { role: 'rep' }, 'lori@hcps.us': { role: 'relations' }, 'gone@hcps.us': { role: 'president', active: false } }[em];
      return res(200, s ? [{ email: em, ...s }] : []); }
    if (o.failRead && m === 'GET' && o.failRead(u)) return res(500, { message: 'forced' });
    const OB = o.csv ? Buffer.from(o.csv, 'utf8') : null, OS = OB ? require('crypto').createHash('sha256').update(OB).digest('hex') : SHA;
    if (u.startsWith(BASE + '/storage/v1/object/mfr-sources/')) return res(200, OB || o.bytes || BYTES);
    if (u.startsWith(BASE + '/rest/v1/mfr_sources')) return res(200, page(u, [{ id: 8, manufacturer: 'strongback-mobility', kind: o.kind || 'sales_export', title: 'Strongback orders',
      file_name: 'Angelo Sep Orders.csv', file_sha256: OS, storage_path: `reports/strongback-mobility/sales_export/${OS}.csv`, received_date: '2026-10-02',
      report_period_start: '2026-09-01', report_period_end: '2026-09-30', status: 'received' }]));
    if (u.startsWith(BASE + '/rest/v1/dealers')) return res(200, page(u, DEALERS));
    if (u.startsWith(BASE + '/rest/v1/dealer_manufacturers')) return res(200, page(u, ACCOUNTS));
    if (u.startsWith(BASE + '/rest/v1/dealer_aliases')) return res(200, page(u, []));
    if (u.startsWith(BASE + '/rest/v1/app_settings')) return res(200, o.zipmap ? [{ value: o.zipmap }] : []);
    if (u.startsWith(BASE + '/rest/v1/mfr_shipto_mappings')) return res(200, page(u, st.mappings));
    if (u.startsWith(BASE + '/rest/v1/mfr_shipto_corrections')) return res(200, page(u, st.corrections));
    if (u.startsWith(BASE + '/rest/v1/monthly_sales')) return res(200, page(u, o.history || []));
    if (u.startsWith(BASE + '/rest/v1/rpc/')) { const fn = u.split('/rpc/')[1]; const p = JSON.parse(opts.body).p; st.rpcs.push({ fn, p });
      if (o.rpc) { const r = o.rpc(fn, p, st); if (r) return res(r.status, r.body); }
      if (fn === 'hcps_mfr_shipto_correct') { const v = st.corrections.filter(c => c.order_key === p.order_key).length + 1;
        const c = { id: 100 + st.corrections.length, order_key: p.order_key, version: v, order_fingerprint: p.order_fingerprint, scope: p.scope, dealer_id: p.dealer_id,
          ship_name: p.ship_name || null, ship_address: p.ship_address || null, ship_city: p.ship_city || null, ship_state: p.ship_state || null, ship_zip: p.ship_zip || null,
          reason: p.reason, actor: p.actor, created_at: '2026-10-11T22:00:00Z' };
        st.corrections.push(c);
        if (p.remember) st.mappings.push({ id: 900 + st.mappings.length, account_ref: p.mapping_account_ref, ship_key: p.mapping_ship_key, scope: p.scope, dealer_id: p.dealer_id, retired_at: null });
        return res(200, { ok: true, correction_id: c.id, version: v, mapping: p.remember ? 'created' : 'none' }); }
      return res(200, { ok: true }); }
    return res(404, { message: 'unexpected ' + m + ' ' + u });
  };
  return st;
}
const boot = o => { const w = world(o); return { w, m: load('shipto-review-api.js', w) }; };
const writes = w => w.calls.filter(c => c.m !== 'GET' && !c.u.includes('/rpc/') && !c.u.includes('/auth/v1/'));

(async () => {
  const { m: M0 } = boot();       // compiles every helper through the mock loader (mutants)
  const RR = F('_report_rows.js'), RV = F('_shipto_review.js'), SH = F('_shipto.js');
  const matcher = SH.makeMatcher({ dealers: DEALERS.filter(d => !d.is_test), accounts: ACCOUNTS, aliases: [] });
  const parsed = RR.readOrderRows(BYTES, 'csv');
  const rv = RV.buildReview(parsed.rows, { matcher });
  const O = k => rv.orders.find(o => o.order_key === 'o:' + k);

  console.log('\n— reading the stored file —');
  await t('the real Strongback header maps (order, created date, account, company, SKU, qty, wholesale price, full ship-to, billing)', () => {
    for (const k of ['order_number', 'date', 'account_ref', 'company', 'product_code', 'qty', 'unit_price', 'ship_name', 'ship_address', 'ship_city', 'ship_state', 'ship_zip', 'bill_zip', 'bill_city'])
      assert.ok(parsed.map[k] != null, k);
    assert.strictEqual(parsed.headers[parsed.map.date], 'Created Date'); assert.strictEqual(parsed.headers[parsed.map.ship_address], 'Shipping Address');
    assert.strictEqual(parsed.headers[19], 'Line Item ["MSRP"]');
  });
  await t('text stays text: a leading-zero ZIP and a ZIP+4 are kept exactly; every original cell is kept', () => {
    const b = parsed.rows.find(r => r.order_number === '7210'); assert.strictEqual(b.ship_zip, '02134');
    assert.strictEqual(parsed.rows[0].ship_zip, '47591-1143'); assert.strictEqual(parsed.rows[0].raw.length, COLS); assert.strictEqual(parsed.rows[0].line, 2);
  });
  await t("the page's column patterns and the server's are identical (no drift)", () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'admin', 'sales-import.html'), 'utf8');
    const src = html.slice(html.indexOf('const pat={') + 10, html.indexOf('};', html.indexOf('const pat={')) + 1);
    const pagePat = eval('(' + src + ')');
    assert.deepStrictEqual(Object.keys(pagePat), Object.keys(RR.PAGE_PATTERNS));
    for (const k of Object.keys(pagePat)) assert.strictEqual(String(pagePat[k]), String(RR.PAGE_PATTERNS[k]), k);
  });
  await t('an XLSX copy reads the same orders (formatted text, not numbers)', () => {
    const X = require('xlsx'); const aoa = RR.parseCsv(CSV).filter(r => r.length > 1); const ws = X.utils.aoa_to_sheet(aoa);
    // as Excel holds a ZIP column: a NUMBER with the "00000" format — the reader must keep the shown text "02134"
    const zc = aoa[0].indexOf('Shipping Zip Code'); aoa.forEach((r, i) => { if (i && /^\d{5}$/.test(r[zc])) ws[X.utils.encode_cell({ r: i, c: zc })] = { t: 'n', v: +r[zc], z: '00000' }; });
    const wb = X.utils.book_new(); X.utils.book_append_sheet(wb, ws, 'Orders');
    const p2 = RR.readOrderRows(X.write(wb, { type: 'buffer', bookType: 'xlsx' }), 'xlsx');
    assert.strictEqual(p2.rows.length, parsed.rows.length); assert.strictEqual(p2.rows.find(r => r.order_number === '7210').ship_zip, '02134');
  });

  console.log('\n— order-level review (strict: never HQ / first branch without evidence) —');
  await t('lines are grouped into ORDERS (two lines of 7139 = one order, amount summed)', () => {
    assert.strictEqual(rv.counts.lines, 10); assert.strictEqual(rv.counts.orders, 8);
    assert.strictEqual(O(7139).lines, 2); assert.strictEqual(O(7139).amount, 1041);
  });
  await t('one dealer → resolved; billing elsewhere never decides (Princeton ships, Washington bills → Princeton by ZIP)', () => {
    assert.strictEqual(O(7139).status, 'resolved'); assert.strictEqual(O(7139).dealer_id, 'harm');
    assert.strictEqual(O(7191).status, 'resolved'); assert.strictEqual(O(7191).dealer_id, 'wpr'); assert.strictEqual(O(7191).basis, 'zip');
  });
  await t('a new location (ZIP no branch has) → needs review, NOT the headquarters', () => {
    assert.strictEqual(O(7200).status, 'needs_review'); assert.strictEqual(O(7200).reason, 'new_location'); assert.strictEqual(O(7200).dealer_id, null);
    assert.ok(O(7200).suggestions.some(s => s.dealer_id === 'whq' && s.basis === 'hq'));   // offered, never chosen
  });
  await t('billing address only → needs review (billing_address_only)', () => { assert.strictEqual(O(7201).status, 'needs_review'); assert.strictEqual(O(7201).reason, 'billing_address_only'); });
  await t('a ZIP shared by two branches → needs review (zip_shared), both suggested', () => {
    assert.strictEqual(O(7202).reason, 'zip_shared'); assert.deepStrictEqual(O(7202).suggestions.map(s => s.dealer_id).sort(), ['tb2', 'thq']); });
  await t('no dealer for the company / account (TEST dealers never match) → needs review (no_dealer_match)', () => assert.strictEqual(O(7203).reason, 'no_dealer_match'));
  await t('lines of ONE order that ship to different places → needs review (mixed_lines), never split', () => assert.strictEqual(O(7204).reason, 'mixed_lines'));
  await t('the matcher finds a dealer by NAME when the account number is unknown (as Sales Report Import does)', () => {
    assert.deepStrictEqual(matcher.candidates({ company: 'Harmonia Medical Supply', account_ref: 'not-on-file' }).map(d => d.id), ['harm']);
  });
  await t('saved ZIP assignments never change the manual import (legacy picks)', () => {
    const r = SH.resolveBranch(matcher.candidates(O(7202).reported), O(7202).reported, { mode: 'legacy', zipmap: { '47546': { d: 'tb2', c: 'thq' } }, rootOf: matcher.rootOf });
    assert.strictEqual(r.dealer_id, 'thq'); assert.strictEqual(r.basis, 'zip_shared');
  });
  await t('state spelled out matches the dealer code ("Indiana" = IN)', () => assert.strictEqual(SH._internal.nstate('Indiana'), 'IN'));
  await t('report status: held as a WHOLE while any order needs review; amounts split out', () => {
    assert.strictEqual(rv.status, 'held'); assert.strictEqual(rv.counts.needs_review, 5); assert.strictEqual(rv.counts.resolved, 3);
    assert.ok(rv.totals.amount_needing_review > 0 && rv.totals.amount_needing_review < rv.totals.amount);
  });
  await t('the legacy (manual import) picks for the same orders are unchanged: HQ fallback for the new location', () => {
    const r = SH.resolveBranch(matcher.candidates(O(7200).reported), O(7200).reported, { mode: 'legacy' });
    assert.strictEqual(r.dealer_id, 'whq'); assert.strictEqual(r.basis, 'hq_fallback'); assert.strictEqual(r.questionable, true);
  });

  console.log('\n— corrections, verified mappings, saved ZIP assignments —');
  await t('a correction (latest version) resolves the order; an earlier version never wins', () => {
    const fp = O(7200).fingerprint;
    const r2 = RV.buildReview(parsed.rows, { matcher, corrections: [
      { order_key: 'o:7200', version: 2, order_fingerprint: fp, scope: 'branch', dealer_id: 'wja' },
      { order_key: 'o:7200', version: 1, order_fingerprint: fp, scope: 'branch', dealer_id: 'wpr' }] });
    const o = r2.orders.find(x => x.order_key === 'o:7200'); assert.strictEqual(o.status, 'corrected'); assert.strictEqual(o.dealer_id, 'wja');
  });
  await t('a correction made on a different reading of the order is NOT applied silently (correction_stale)', () => {
    const r2 = RV.buildReview(parsed.rows, { matcher, corrections: [{ order_key: 'o:7200', version: 1, order_fingerprint: 'f'.repeat(32), scope: 'branch', dealer_id: 'wja' }] });
    assert.strictEqual(r2.orders.find(x => x.order_key === 'o:7200').reason, 'correction_stale');
  });
  await t('a verified mapping (manufacturer + account + FILE ship-to key) resolves a recurring order automatically', () => {
    const key = SH.shipKey(O(7200).reported);
    const r2 = RV.buildReview(parsed.rows, { matcher, mappings: [{ id: 5, account_ref: 'wilburbros', ship_key: key, scope: 'branch', dealer_id: 'wja' }] });
    const o = r2.orders.find(x => x.order_key === 'o:7200'); assert.strictEqual(o.status, 'resolved'); assert.strictEqual(o.basis, 'verified_mapping'); assert.strictEqual(o.dealer_id, 'wja');
  });
  await t('a mapping never acts as "account → one branch": another ship-to of the same account still needs review', () => {
    const key = SH.shipKey(O(7200).reported);
    const r2 = RV.buildReview(parsed.rows, { matcher, mappings: [{ id: 5, account_ref: 'wilburbros', ship_key: key, scope: 'branch', dealer_id: 'wja' }] });
    assert.strictEqual(r2.orders.find(x => x.order_key === 'o:7201').status, 'needs_review');
  });
  await t('a retired mapping is never used', () => {
    const key = SH.shipKey(O(7200).reported);
    const r2 = RV.buildReview(parsed.rows, { matcher, mappings: [{ id: 5, account_ref: 'wilburbros', ship_key: key, scope: 'branch', dealer_id: 'wja', retired_at: '2026-10-11' }] });
    assert.strictEqual(r2.orders.find(x => x.order_key === 'o:7200').status, 'needs_review');
  });
  await t('a saved ZIP assignment (Commission Review, RULE 6) resolves a shared ZIP inside its corporate only', () => {
    const r2 = RV.buildReview(parsed.rows, { matcher, zipmap: { '47546': { d: 'tb2', c: 'thq' } } });
    const o = r2.orders.find(x => x.order_key === 'o:7202'); assert.strictEqual(o.dealer_id, 'tb2'); assert.strictEqual(o.basis, 'zip_assignment');
    const r3 = RV.buildReview(parsed.rows, { matcher, zipmap: { '47546': { d: 'tb2', c: 'whq' } } });         // another corporate's rule
    assert.strictEqual(r3.orders.find(x => x.order_key === 'o:7202').status, 'needs_review');
    const r4 = RV.buildReview(parsed.rows, { matcher, zipmap: { '47546': 'wja' } });                          // unscoped: only a candidate
    assert.strictEqual(r4.orders.find(x => x.order_key === 'o:7202').status, 'needs_review');
  });

  console.log('\n— the corrected report (overlay; the original never changes) —');
  await t('original columns and cells are byte-identical; HCPS columns are appended', () => {
    const fp = O(7200).fingerprint;
    const r2 = RV.buildReview(parsed.rows, { matcher, corrections: [{ order_key: 'o:7200', version: 1, order_fingerprint: fp, scope: 'branch', dealer_id: 'wja',
      ship_zip: '47546', ship_city: 'Jasper', actor: 'staff:angelo@hcps.us', reason: 'Jasper store', created_at: 'x' }] });
    const out = RR.parseCsv(RV.correctedCsv(parsed.headers, parsed.rows, r2, id => (DEALERS.find(d => d.id === id) || {}).business_name)).filter(r => r.length > 1);
    const orig = RR.parseCsv(CSV).filter(r => r.length > 1);
    assert.strictEqual(out.length, orig.length);
    out.forEach((r, i) => assert.deepStrictEqual(r.slice(0, COLS), orig[i]));
    assert.deepStrictEqual(out[0].slice(COLS), RV.CSV_COLS);
    const row = out.find(r => r[0] === '7200'); assert.strictEqual(row[COLS], 'corrected'); assert.strictEqual(row[COLS + 1], 'Wilbur Brothers Jasper'); assert.strictEqual(row[COLS + 8], '47546');
  });

  console.log('\n— shadow validation against history (read-only) —');
  await t('history booked as the strict resolver would → same; HQ-fallback history → held; a hand-corrected different branch → different', () => {
    const hist = [
      { invoice_no: 'A1', customer_name: 'Wilbur Brothers Healthcare Pharmacy', customer_ref: 'wilburbros', ship_zip: '47670', ship_city: 'Princeton', ship_state: 'IN', dealer_id: 'wpr', amount: 10, period: '2026-07-01' },
      { invoice_no: 'A2', customer_name: 'Wilbur Brothers Healthcare Pharmacy', customer_ref: 'wilburbros', ship_zip: '', ship_city: '', dealer_id: 'whq', amount: 20, period: '2026-07-01' },
      { invoice_no: 'A3', customer_name: 'Wilbur Brothers Healthcare Pharmacy', customer_ref: 'wilburbros', ship_zip: '47546', ship_city: 'Jasper', dealer_id: 'wpr', amount: 30, period: '2026-07-01' },
      { invoice_no: 'A4', customer_name: 'Gone Co', customer_ref: '', ship_zip: '', dealer_id: null, amount: 5, period: '2026-07-01' },
    ];
    const s = RV.shadow(hist, { matcher });
    assert.strictEqual(s.orders, 4); assert.strictEqual(s.same, 1); assert.strictEqual(s.held, 1); assert.strictEqual(s.different, 1); assert.strictEqual(s.unmatched_history, 1);
    assert.strictEqual(s.list.find(x => x.outcome === 'different').strict, 'wja');
  });

  await t('shadow keeps SOURCE LANES apart (MI-1a rule): sales-report lines vs commission lines (incl. legacy no-source rows) vs other', () => {
    const W1 = { customer_name: 'Wilbur Brothers Healthcare Pharmacy', customer_ref: 'wilburbros', ship_zip: '47670', ship_city: 'Princeton', ship_state: 'IN', dealer_id: 'wpr', period: '2026-07-01' };
    const hist = [];
    for (let i = 0; i < 143; i++) hist.push(Object.assign({ id: i + 1, invoice_no: 'S' + (i % 50), amount: 10, source: 'sales_report', external_ref: 'strongback-mobility|S|' + i }, W1));
    for (let i = 0; i < 12; i++) hist.push(Object.assign({ id: 500 + i, invoice_no: 'C' + i, amount: 5, source: 'commission', external_ref: null }, W1));
    for (let i = 0; i < 5; i++) hist.push(Object.assign({ id: 600 + i, invoice_no: 'L' + i, amount: 5, source: null, external_ref: null }, W1));     // legacy commission lane
    hist.push(Object.assign({ id: 700, invoice_no: 'X1', amount: 1, source: null, external_ref: 'portal|X1' }, W1));                                   // neither lane
    const s = RV.shadow(hist, { matcher });
    assert.deepStrictEqual([s.by_lane.sales_report.lines, s.by_lane.commission.lines, s.by_lane.other.lines], [143, 17, 1]);
    assert.strictEqual(s.by_lane.sales_report.orders, 50, 'sales-report lines grouped into their own orders only');
    assert.strictEqual(s.by_lane.commission.orders, 17);
    assert.strictEqual(s.lines, 161); assert.strictEqual(s.same, 68);
    assert.ok(Object.values(s.by_lane).every(L => L.different === 0));
    assert.strictEqual(RV.laneOf({ source: 'sales_report', external_ref: null }), 'sales_report');
    assert.strictEqual(RV.laneOf({ source: 'commission', external_ref: 'x' }), 'commission');
    assert.strictEqual(RV.laneOf({}), 'commission'); assert.strictEqual(RV.laneOf({ source: null, external_ref: 'x' }), 'other');
  });
  await t('shadow: the SAME invoice in both lanes is two transactions, never merged; booked to different branches = a lane disagreement', () => {
    const base = { invoice_no: 'Q1', customer_name: 'Wilbur Brothers Healthcare Pharmacy', customer_ref: 'wilburbros', ship_zip: '47670', ship_city: 'Princeton', ship_state: 'IN', amount: 10, period: '2026-06-01' };
    const s = RV.shadow([Object.assign({ id: 1, source: 'sales_report', external_ref: 'k', dealer_id: 'wpr' }, base), Object.assign({ id: 2, source: 'commission', dealer_id: 'whq' }, base)], { matcher });
    assert.strictEqual(s.orders, 2); assert.strictEqual(s.mixed_history, 0, 'not one order booked two ways');
    assert.strictEqual(s.by_lane.sales_report.same, 1); assert.strictEqual(s.by_lane.commission.different, 1);
    assert.strictEqual(s.lane_disagreements, 1); assert.deepStrictEqual(s.lane_disagreement_list[0].booked, { sales_report: 'wpr', commission: 'whq' });
    const d = s.list.find(x => x.outcome === 'different'); assert.strictEqual(d.lane, 'commission'); assert.strictEqual(d.booked, 'whq'); assert.deepStrictEqual(d.row_ids, [2]);
  });

  console.log('\n— API —');
  await t('sign-in required; management only (rep / Relations / inactive refused)', async () => {
    const { m } = boot();
    assert.strictEqual((await call(m, { action: 'queue' })).status, 401);
    assert.strictEqual((await call(m, { action: 'queue' }, { token: 'junk' })).status, 401);
    assert.strictEqual((await call(m, { action: 'queue' }, { token: 'off' })).status, 401);
    assert.strictEqual((await call(m, { action: 'queue' }, { token: 'greg' })).status, 403);
    assert.strictEqual((await call(m, { action: 'queue' }, { token: 'lori' })).status, 403);
    assert.strictEqual((await call(m, { action: 'queue' }, { token: 'pres', method: 'GET' })).status, 405);
  });
  await t('queue: the registered export, held, with counts; nothing written', async () => {
    const { w, m } = boot(); const r = await call(m, { action: 'queue' }, { token: 'pres' });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.held, 1);
    assert.strictEqual(r.body.reports[0].review_status, 'held'); assert.strictEqual(r.body.reports[0].counts.needs_review, 5);
    assert.deepStrictEqual(writes(w), []); assert.strictEqual(w.rpcs.length, 0);
  });
  await t('report: orders needing review first, with candidates and reasons', async () => {
    const { m } = boot(); const r = await call(m, { action: 'report', source_id: 8 }, { token: 'admin' });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.orders[0].status, 'needs_review');
    const o = r.body.orders.find(x => x.order_key === 'o:7200'); assert.ok(o.candidates.length === 3); assert.strictEqual(o.current_version, 0);
  });
  await t('a stored file whose SHA-256 differs is never read (409)', async () => {
    const { m } = boot({ bytes: Buffer.from(CSV + 'x') }); const r = await call(m, { action: 'report', source_id: 8 }, { token: 'pres' });
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.error, 'file_changed');
  });
  await t('only order exports are reviewed here', async () => {
    const { m } = boot({ kind: 'commission_statement' }); assert.strictEqual((await call(m, { action: 'report', source_id: 8 }, { token: 'pres' })).status, 422);
  });
  await t('an unreadable source of evidence is a 503, never "no evidence"', async () => {
    for (const tb of ['dealers', 'dealer_manufacturers', 'dealer_aliases', 'mfr_shipto_mappings', 'mfr_shipto_corrections', 'app_settings']) {
      const { m } = boot({ failRead: u => u.includes('/rest/v1/' + tb + '?') }); const r = await call(m, { action: 'report', source_id: 8 }, { token: 'pres' });
      assert.strictEqual(r.status, 503, tb);
    }
  });
  await t('Save & Continue: the actor is the VERIFIED sign-in; fingerprint, reported values and ship key come from the server; revalidates; next order', async () => {
    const { w, m } = boot();
    const r = await call(m, { action: 'correct', source_id: 8, order_key: 'o:7200', dealer_id: 'wja', reason: 'new Jasper store', expected_version: 0, remember: true,
      actor: 'staff:evil@x.us', order_fingerprint: '0'.repeat(32), mapping_ship_key: 'id:forged', reported: { company: 'x' } }, { token: 'pres' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const p = w.rpcs[0].p; assert.strictEqual(w.rpcs[0].fn, 'hcps_mfr_shipto_correct');
    assert.strictEqual(p.actor, 'staff:angelo@hcps.us'); assert.strictEqual(p.order_fingerprint, O(7200).fingerprint);
    assert.strictEqual(p.mapping_ship_key, SH.shipKey(O(7200).reported)); assert.strictEqual(p.mapping_account_ref, 'wilburbros'); assert.strictEqual(p.reported.company, W.company);
    assert.strictEqual(r.body.order.status, 'corrected'); assert.strictEqual(r.body.report.counts.needs_review, 4); assert.strictEqual(r.body.next_order_key, 'o:7201');
    assert.deepStrictEqual(writes(w), []);
  });
  await t('Remember needs the order\'s account number on record for the chosen family — the order itself can still be corrected', async () => {
    // an order with no account number
    const csv = CSV.replace(/\r\n$/, '') + '\r\n' + line(Object.assign({}, W, { n: 7300, user: '', sname: 'Wilbur Brothers', saddr: '9 New Plaza', scity: 'Evansville', sstate: 'IN', szip: '47999' })) + '\r\n';
    const a = boot({ csv });
    const r = await call(a.m, { action: 'correct', source_id: 8, order_key: 'o:7300', dealer_id: 'wja', reason: 'new store', expected_version: 0, remember: true }, { token: 'pres' });
    assert.strictEqual(r.status, 422); assert.strictEqual(r.body.error, 'shipto_no_account'); assert.strictEqual(a.w.rpcs.length, 0);
    const rep = await call(a.m, { action: 'report', source_id: 8 }, { token: 'pres' });
    assert.deepStrictEqual(rep.body.orders.find(x => x.order_key === 'o:7300').remember_roots, []);
    const ok = await call(a.m, { action: 'correct', source_id: 8, order_key: 'o:7300', dealer_id: 'wja', reason: 'new store', expected_version: 0 }, { token: 'pres' });
    assert.strictEqual(ok.status, 200); assert.strictEqual(a.w.rpcs[0].p.remember, false); assert.strictEqual(a.w.mappings.length, 0);
    // an account number on record for ANOTHER family (Wilbur's number, Boston chosen with confirmation)
    const b = boot();
    const r2 = await call(b.m, { action: 'correct', source_id: 8, order_key: 'o:7200', dealer_id: 'bos', reason: 'drop ship', expected_version: 0, remember: true, confirm_outside_family: true }, { token: 'pres' });
    assert.strictEqual(r2.status, 422); assert.strictEqual(r2.body.error, 'shipto_account_family'); assert.strictEqual(b.w.rpcs.length, 0);
    const r3 = await call(b.m, { action: 'report', source_id: 8 }, { token: 'pres' });
    assert.deepStrictEqual(r3.body.orders.find(x => x.order_key === 'o:7200').remember_roots, ['whq']);
    // the database refusals pass through too
    for (const code of ['shipto_no_account', 'shipto_account_family', 'shipto_account_mismatch']) {
      const c = boot({ rpc: () => ({ status: 400, body: { message: code + ': no' } }) });
      const rr = await call(c.m, { action: 'correct', source_id: 8, order_key: 'o:7200', dealer_id: 'wja', reason: 'abc', expected_version: 0, remember: true }, { token: 'pres' });
      assert.strictEqual(rr.status, 422, code); assert.strictEqual(rr.body.error, code);
    }
  });
  await t('a mapping saved for ANOTHER family is never reused by the API (needs review, mapping_unverified)', async () => {
    const key = SH.shipKey(O(7200).reported);
    for (const mp of [{ scope: 'corporate', dealer_id: 'bos' }, { scope: 'branch', dealer_id: 'tb2' }]) {
      const { m } = boot({ mappings: [Object.assign({ id: 7, account_ref: 'wilburbros', ship_key: key, retired_at: null }, mp)] });
      const o = (await call(m, { action: 'report', source_id: 8 }, { token: 'pres' })).body.orders.find(x => x.order_key === 'o:7200');
      assert.deepStrictEqual([o.status, o.reason, o.dealer_id], ['needs_review', 'mapping_unverified', null]);
    }
  });
  await t('a branch outside the matched family needs an explicit confirmation (409 first)', async () => {
    const { w, m } = boot();
    const r = await call(m, { action: 'correct', source_id: 8, order_key: 'o:7200', dealer_id: 'bos', reason: 'x y z', expected_version: 0 }, { token: 'pres' });
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.error, 'outside_family'); assert.strictEqual(w.rpcs.length, 0);
    const r2 = await call(m, { action: 'correct', source_id: 8, order_key: 'o:7200', dealer_id: 'bos', reason: 'x y z', expected_version: 0, confirm_outside_family: true }, { token: 'pres' });
    assert.strictEqual(r2.status, 200);
  });
  await t('refused: a TEST dealer, an unknown dealer, an order not in the report', async () => {
    const { w, m } = boot();
    assert.strictEqual((await call(m, { action: 'correct', source_id: 8, order_key: 'o:7203', dealer_id: 'tst', reason: 'abc', expected_version: 0, confirm_outside_family: true }, { token: 'pres' })).status, 422);
    assert.strictEqual((await call(m, { action: 'correct', source_id: 8, order_key: 'o:7203', dealer_id: 'nope', reason: 'abc', expected_version: 0 }, { token: 'pres' })).status, 422);
    assert.strictEqual((await call(m, { action: 'correct', source_id: 8, order_key: 'o:9999', dealer_id: 'wja', reason: 'abc', expected_version: 0 }, { token: 'pres' })).status, 404);
    assert.strictEqual(w.rpcs.length, 0);
  });
  await t('database refusals pass through (stale → 409, mapping conflict → 409, reason → 422)', async () => {
    for (const [code, st] of [['shipto_stale', 409], ['shipto_mapping_conflict', 409], ['shipto_reason_required', 422]]) {
      const { m } = boot({ rpc: () => ({ status: 400, body: { message: code + ': no' } }) });
      const r = await call(m, { action: 'correct', source_id: 8, order_key: 'o:7200', dealer_id: 'wja', reason: 'abc', expected_version: 0 }, { token: 'pres' });
      assert.strictEqual(r.status, st, code); assert.strictEqual(r.body.error, code);
    }
  });
  await t('after remembering, the next report of the same ship-to resolves by the verified mapping', async () => {
    const { w, m } = boot();
    await call(m, { action: 'correct', source_id: 8, order_key: 'o:7200', dealer_id: 'wja', reason: 'abc', expected_version: 0, remember: true }, { token: 'pres' });
    w.corrections.length = 0;     // a later file: no corrections yet, only the mapping
    const r = await call(m, { action: 'report', source_id: 8 }, { token: 'pres' });
    const o = r.body.orders.find(x => x.order_key === 'o:7200'); assert.strictEqual(o.status, 'resolved'); assert.strictEqual(o.basis, 'verified_mapping');
  });
  await t('a RETIRED mapping in the database is never used by the API', async () => {
    const { m } = boot({ mappings: [{ id: 7, account_ref: 'wilburbros', ship_key: SH.shipKey(O(7200).reported), scope: 'branch', dealer_id: 'wja', retired_at: '2026-10-11T00:00:00Z' }] });
    const r = await call(m, { action: 'report', source_id: 8 }, { token: 'pres' });
    assert.strictEqual(r.body.orders.find(x => x.order_key === 'o:7200').status, 'needs_review');
  });
  await t('export: the corrected CSV (original columns first)', async () => {
    const { m } = boot(); const r = await call(m, { action: 'export', source_id: 8 }, { token: 'pres' });
    assert.strictEqual(r.status, 200); const rows = F('_report_rows.js').parseCsv(r.body.csv).filter(x => x.length > 1);
    assert.deepStrictEqual(rows[0].slice(0, COLS), F('_report_rows.js').parseCsv(HEADER)[0]); assert.strictEqual(rows[0][COLS], 'HCPS Status');
    assert.ok(/ship-to corrected\.csv$/.test(r.body.file_name));
  });
  await t('retire_mapping needs a reason; actor is the sign-in', async () => {
    const { w, m } = boot();
    assert.strictEqual((await call(m, { action: 'retire_mapping', mapping_id: 5, reason: '' }, { token: 'pres' })).status, 422);
    assert.strictEqual((await call(m, { action: 'retire_mapping', mapping_id: 5, reason: 'closed', actor: 'staff:x@y.z' }, { token: 'pres' })).status, 200);
    assert.strictEqual(w.rpcs[0].p.actor, 'staff:angelo@hcps.us');
  });
  await t('dealer_search never offers a TEST dealer', async () => {
    const { m } = boot(); const r = await call(m, { action: 'dealer_search', q: 'unknown' }, { token: 'pres' });
    assert.deepStrictEqual(r.body.dealers, []);
    const r2 = await call(m, { action: 'dealer_search', q: 'jasper' }, { token: 'pres' }); assert.ok(r2.body.dealers.some(d => d.dealer_id === 'wja' && d.parent === 'Wilbur Brothers Healthcare Pharmacy'));
  });
  await t('shadow is read-only (GETs only) and reports different / held', async () => {
    const { w, m } = boot({ history: [
      { id: 1, invoice_no: 'A3', customer_name: 'Wilbur Brothers Healthcare Pharmacy', customer_ref: 'wilburbros', ship_zip: '47546', ship_city: 'Jasper', dealer_id: 'wpr', amount: 30, period: '2026-07-01' }] });
    const r = await call(m, { action: 'shadow', manufacturer: 'strongback-mobility' }, { token: 'pres' });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.shadow.different, 1); assert.strictEqual(r.body.read_only, true);
    assert.ok(w.calls.some(c => c.u.includes('/rest/v1/monthly_sales') && /select=[^&]*source,external_ref/.test(c.u)), 'reads the lane columns');
    assert.ok(r.body.shadow.by_lane && r.body.shadow.by_lane.commission.different === 1, 'a no-source, no-ref row is the commission lane');
    assert.deepStrictEqual(w.calls.filter(c => c.m !== 'GET'), []);
  });
  console.log(`\nshipto-review: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
