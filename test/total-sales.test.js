/* Owner directive 2026-11-06 17:40 CT — Priorities 4–8: Strongback reconciliation, the Shop category resolver, potential retail
   from the Shop reference, Total Sales, branch vs company, and one calculation for screen / PDF / Excel.
   Real _dealer_report.valuate / build, real _report_catalog.lookup, the real dealer-reports-api handler on the in-memory
   PostgREST fake. Synthetic data only.   node test/total-sales.test.js */
const path = require('path');
const M = require(path.join(__dirname, 'phase0-mock.js'));
const ROOT = path.join(__dirname, '..', 'netlify', 'functions');
const REP = require(path.join(ROOT, '_dealer_report.js'));
const RC = require(path.join(ROOT, '_report_catalog.js'));
const XLSX = require('xlsx');
let fail = 0, pass = 0;
async function t(n, f) { try { await f(); pass++; console.log('ok   ' + n); } catch (e) { fail++; console.log('FAIL ' + n + '\n     ' + (e && e.stack || e).toString().split('\n').slice(0, 3).join('\n     ')); } }
const eq = (a, b, w) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((w || '') + ' got ' + JSON.stringify(a) + ' expected ' + JSON.stringify(b)); };
const ok = (c, w) => { if (!c) throw new Error(w); };
const Y = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric' }).format(new Date()));
const HQ = '11111111-1111-1111-1111-111111111111', BR = '22222222-2222-2222-2222-222222222222';
const loc = [{ id: HQ, name: 'Syn HQ' }, { id: BR, name: 'Syn Branch' }];

/* a resolver like the API's: exact / legacy / Golden base, over a synthetic catalog */
const cat = (slug, rows) => ({ byCode: new Map(rows.map((r) => [r.code.toUpperCase(), r])), readable: true });
const CATS = {
  'strongback-mobility': cat('strongback-mobility', [{ code: '1010AB', name: 'Comfort 24" with AB', category: 'Wheelchairs', ref: 900, ref_source: 'msrp' },
    { code: 'ES0001', name: 'ErgoSteel', category: 'Wheelchairs', ref: 440, ref_source: 'calculated' }]),
  'golden-technologies': cat('golden-technologies', [{ code: 'GB108B', name: 'Buzzaround', category: 'Scooters', ref: 1500, ref_source: 'msrp', cost: 800 }, { code: 'PR510', name: 'Lift chair', category: 'Lift Chairs', ref: 2000, ref_source: 'msrp', cost: 1000 }]),
  dalton: cat('dalton', [{ code: 'EX201-1', name: 'Pedal Exerciser Led Display', category: 'Exercise', ref: 60, ref_source: 'msrp' }]),
};
const resolve = (s, c) => { const m = RC.lookup(CATS[s], s, c); return m ? Object.assign({}, m.entry, { matched_by: m.matched_by }) : null; };
const mk = (loc_, mfr, m, code, name, qty, amount) => ({ dealer_id: loc_, manufacturer: mfr, period: `${Y}-${String(m).padStart(2, '0')}-01`, product_code: code, product_name: name, qty, amount, source: 'sales_report', external_ref: 'x' });
const STRONGBACK = [   // the shape of the James Medical Bowling Green May order: one order, 5 lines, 17 items
  mk(BR, 'strongback-mobility', 5, '1010+AB-2025', 'STRONGBACK24+AB-2025* (1010+AB-2025)', 1, 556),
  mk(BR, 'strongback-mobility', 5, 'ES0001', 'ErgoSteel', 1, 220),
  mk(BR, 'strongback-mobility', 5, 'D2G-SIGN', 'D2G Retailer Sign', 1, 0),
  mk(BR, 'strongback-mobility', 5, 'BROCH-TRI', 'Brochure Trifold', 10, 0),
  mk(BR, 'strongback-mobility', 5, 'WOB-1', 'Wobbler', 4, 0),
];
const build = (sales, o) => REP.build(Object.assign({ year: Y, today: `${Y}-12-15`, locations: loc, scope: BR, sales, orders: [], quotes: [], catalog: {}, mfrName: { 'strongback-mobility': 'Strongback', 'golden-technologies': 'Golden' },
  reportedMonths: { 'strongback-mobility': Array.from({ length: 12 }, (_, i) => `${Y}-${String(i + 1).padStart(2, '0')}`), 'golden-technologies': Array.from({ length: 12 }, (_, i) => `${Y}-${String(i + 1).padStart(2, '0')}`) },
  network: [], resolve, isMarketing: RC.isMarketing, marketingLabel: RC.MARKETING }, o || {}));

(async () => {
  await t('P4 Strongback: 17 items on 5 lines = 2 product units + 15 marketing items; nothing changed "from 17 to 2" by hand', async () => {
    const r = build(STRONGBACK);
    const m = r.manufacturers.find((x) => x.slug === 'strongback-mobility');
    eq([r.purchases.total, m.purchases, m.units, m.marketing_units], [776, 776, 2, 15]);
    eq(r.categories.map((c) => [c.category, c.units]).sort(), [['Marketing & Displays', 15], ['Wheelchairs', 2]], 'marketing in its own category');
  });
  await t('P5 resolver: 1010+AB-2025 → 1010AB / Wheelchairs by the recorded evidence; Golden suffix GB108B-ST → GB108B; unknown = not matched', async () => {
    const a = RC.lookup(CATS['strongback-mobility'], 'strongback-mobility', '1010+AB-2025'); eq([a.entry.code, a.entry.category, a.matched_by], ['1010AB', 'Wheelchairs', 'legacy']); ok(/1010\+AB-2025/.test(a.evidence), 'evidence kept');
    const g = RC.lookup(CATS['golden-technologies'], 'golden-technologies', 'GB108B-ST'); eq([g.entry.code, g.matched_by], ['GB108B', 'golden_base']);
    eq(RC.lookup(CATS['strongback-mobility'], 'strongback-mobility', 'ES0001-ST'), null, 'suffix stripping is Golden only');
    eq(RC.lookup(CATS['strongback-mobility'], 'strongback-mobility', 'NOPE'), null);
    ok(RC.isMarketing('X', 'Counter display') && RC.isMarketing('WOB', 'Wobbler') && !RC.isMarketing('1010AB', 'Comfort chair'), 'marketing words');
  });
  await t('P6 potential retail = units × Shop reference (MSRP, else 2× standard cost); never 2× the purchase total; coverage and gaps shown', async () => {
    const sales = STRONGBACK.concat([mk(BR, 'strongback-mobility', 6, 'UNKNOWN-1', 'Something', 2, 100), mk(BR, 'strongback-mobility', 6, 'POP-9', 'Floor display', 1, 25)]);
    const V = build(sales).valuation;
    eq([V.purchases_total, V.matched_cost, V.coverage_pct], [901, 776, 86.1], 'a paid display counts in purchases, never valued');
    eq([V.benchmark.retail, V.benchmark.profit, V.benchmark.margin_pct], [1340, 564, 42.1], '1×900 + 1×440; profit 1340−776; margin ÷ retail');
    ok(V.benchmark.retail !== 2 * V.matched_cost, 'not 2× purchases');
    eq(V.gaps.map((g) => [g.code, g.reason, g.amount]), [['UNKNOWN-1', 'not_in_catalog', 100], ['POP-9', 'marketing', 25]], 'valued + not valued = purchases');
    eq(V.matched_cost + V.gap_amount, V.purchases_total);
    eq(V.by_product.map((p) => [p.code, p.reference_source]).sort(), [['1010+AB-2025', 'msrp'], ['ES0001', 'calculated']]);
    eq([V.by_manufacturer[0].profit, V.by_manufacturer[0].margin_pct], [564, 42.1], 'margin = profit ÷ retail, per manufacturer too');
  });
  await t('P6 a return (negative quantity) takes its units back out; an amount-only credit is listed, never valued', async () => {
    const V = build(STRONGBACK.concat([mk(BR, 'strongback-mobility', 7, 'ES0001', 'ErgoSteel', -1, -220)])).valuation;
    eq([V.matched_cost, V.benchmark.retail], [556, 900]);
    const V2 = build(STRONGBACK.concat([mk(BR, 'strongback-mobility', 7, 'ES0001', 'ErgoSteel price credit', 1, -20)])).valuation;
    eq([V2.matched_cost, V2.benchmark.retail, V2.gaps[0].reason], [776, 1340, 'credit_without_units'], 'an amount-only credit removes no unit');
  });
  await t('review #109: a Shop product named "display" stays a product; Golden base matches valued only when no upgrade was paid; an unreadable catalog is listed', async () => {
    const sales = [mk(BR, 'dalton', 3, 'EX201-1', 'Pedal Exerciser Led Display', 2, 60), mk(BR, 'golden-technologies', 3, 'GB108B-ST', 'Buzzaround ST', 1, 800), mk(BR, 'golden-technologies', 3, 'PR510-MED-IRH', 'Lift chair heat', 1, 1400)];
    const r = build(sales, { mfrName: { dalton: 'Dalton', 'golden-technologies': 'Golden' } }); const V = r.valuation;
    eq(r.categories.map((c) => c.category).sort(), ['Exercise', 'Lift Chairs', 'Scooters']);
    eq(V.by_product.map((p) => p.code).sort(), ['EX201-1', 'GB108B-ST']); eq(V.gaps.map((g) => [g.code, g.reason]), [['PR510-MED-IRH', 'configuration_not_priced']]);
    const r2 = build(sales, { resolve: (sl, c) => (sl === 'golden-technologies' ? { unavailable: true } : resolve(sl, c)) });
    ok(r2.valuation.gaps.filter((g) => g.reason === 'catalog_unavailable').length === 2, 'unavailable');
  });
  await t('review #109 P0: network opportunities on a line with no public catalog file (Golden) never break the report', async () => {
    const sales = [mk(BR, 'golden-technologies', 1, 'GB108B-ST', 'Buzzaround ST', 1, 800)];
    const r = build(sales, { today: `${Y}-03-15`, network: [{ manufacturer: 'golden-technologies', code: 'PR510', dealers: 4, units: 9 }, { manufacturer: 'strongback-mobility', code: 'WOB-1', dealers: 5, units: 9 }] });
    eq(r.opportunities.map((o) => [o.code, o.name]), [['PR510', 'Lift chair']]);
  });
  await t('P6 dealer custom comparison: company default + branch override, shown apart; the Shop benchmark is unchanged', async () => {
    const rows = [{ manufacturer: 'strongback-mobility', code: '1010AB', location_id: null, price: 1000 }, { manufacturer: 'strongback-mobility', code: '1010AB', location_id: BR, price: 1100 }];
    const RP = require(path.join(ROOT, '_retail_price.js'));
    const V = build(STRONGBACK, { customPrice: (l, s, c) => RP.dealerPriceFor(rows, l, s, c) }).valuation;
    eq([V.benchmark.retail, V.custom.retail, V.difference, V.custom.products_with_custom_price], [1340, 1540, 200, 1], 'branch 1100 + ES0001 at the Shop 440');
    eq([V.custom.profit, V.custom.margin_pct], [764, 49.6]);
    const V2 = build(STRONGBACK.map((r) => Object.assign({}, r, { dealer_id: HQ })), { scope: HQ, customPrice: (l, s, c) => RP.dealerPriceFor(rows, l, s, c) }).valuation;
    eq(V2.custom.retail, 1440, 'head office uses the company default');
  });
  await t('P8 branch vs company: the same period, no double counting, only for a viewer who can see the company', async () => {
    const sales = STRONGBACK.concat([mk(HQ, 'strongback-mobility', 5, 'ES0001', 'ErgoSteel', 3, 660)]);
    const r = build(sales, { companyView: true });
    eq([r.purchases.total, r.company.purchases, r.company.branch_share_pct, r.company.units, r.company.retail_benchmark], [776, 1436, 54, 5, 2660]);
    eq(build(sales, { companyView: false }).company, null, 'branch login: no company figures');
    eq(build(sales, { scope: 'company', companyView: true }).company, null, 'company scope needs no comparison');
  });
  await t('P7 Excel carries exactly the report\'s figures (one calculation)', async () => {
    const r = build(STRONGBACK, { companyView: true });
    const XL = require(path.join(ROOT, '_report_xlsx.js'));
    const wb = XLSX.read(XL.build({ report: r, scopeName: 'Syn Branch', dealerName: 'Syn', generated: 'today' }), { type: 'buffer' });
    eq(wb.SheetNames.slice(0, 5), ['Summary', 'By manufacturer', 'By category', 'By product', 'Monthly']);
    const S = XLSX.utils.sheet_to_json(wb.Sheets.Summary, { header: 1 }); const v = (lab) => (S.find((x) => String(x[0]).startsWith(lab)) || [])[1];
    eq([v('Wholesale purchases (manufacturer'), v('Potential retail — Shop'), v('Gross profit — Shop'), v('Product units')], [r.purchases.total, r.valuation.benchmark.retail, r.valuation.benchmark.profit, 2]);
    ok(S.some((x) => /not sales made/.test(String(x[0]))), 'labelled potential, not sales');
    const PDF = require(path.join(ROOT, '_report_pdf.js'));
    const buf = await PDF.render({ report: r, dealer: { business_name: 'Syn' }, scopeName: 'Syn Branch', generated: 'today' }); ok(buf.length > 1000, 'pdf renders with Total Sales');
  });
  /* the real handler: catalog from the shop files (synthetic), report_excel = report */
  await t('API: report and report_excel give the same valuation; marketing units apart; a branch login gets no company figures', async () => {
    const W = M.createWorld({ tokens: {}, catalog: { 'strongback-mobility': [{ code: '1010AB', name: 'Comfort', category: 'Wheelchairs', base_price: 450, msrp: 900 }, { code: 'ES0001', name: 'ErgoSteel', category: 'Wheelchairs', base_price: 220 }] },
      tables: { dealers: [{ id: HQ, parent_id: null, business_name: 'Syn HQ' }, { id: BR, parent_id: HQ, business_name: 'Syn Branch' }],
        dealer_users: [{ uid: 'u-hq', status: 'approved', dealer_id: HQ, email: 'hq@syn.test' }, { uid: 'u-br', status: 'approved', dealer_id: BR, email: 'br@syn.test' }],
        dealer_user_scope: [], monthly_sales: STRONGBACK.map((r, i) => Object.assign({ id: i + 1 }, r)), orders: [], dealer_saved_quotes: [],
        manufacturers: [{ slug: 'strongback-mobility', name: 'Strongback' }], manufacturer_meta: [{ slug: 'strongback-mobility' }],
        product_skus: [], product_overrides: [], custom_products: [], product_content: [], product_images: [], product_links: [], product_media: [], dealer_contract_prices: [], dealer_retail_prices: [] } });
    const inner = W.fetch; W.fetch = async (u, o) => { u = String(u);
      if (u.startsWith(M.BASE + '/auth/v1/user')) { const tok = String(((o && o.headers) || {}).Authorization || '').replace(/^Bearer\s+/i, ''); const map = { hq: { id: 'u-hq' }, br: { id: 'u-br' } };
        return map[tok] ? { ok: true, status: 200, json: async () => map[tok] } : { ok: false, status: 401, json: async () => ({}) }; }
      if (/\/data\/content\//.test(u)) return { ok: false, status: 404, json: async () => null, text: async () => '' };
      return inner(u, o); };
    const C = M.load('dealer-reports-api.js', W, {}, ROOT);
    const r = await M.call(C, { action: 'report', scope: BR }, { headers: { authorization: 'Bearer hq' } }); eq(r.status, 200, JSON.stringify(r.body).slice(0, 300));
    const V = r.body.report.valuation; eq([V.matched_cost, V.benchmark.retail, V.coverage_pct], [776, 1340, 100], 'MSRP 900 + 2×220');
    eq(r.body.report.manufacturers[0].marketing_units, 15); ok(r.body.report.company && r.body.report.company.purchases === 776, 'head office sees the company comparison');
    const x = await M.call(C, { action: 'report_excel', scope: BR }, { headers: { authorization: 'Bearer hq' } }); eq(x.status, 200);
    const wb = XLSX.read(Buffer.from(x.body.xlsx_base64, 'base64'), { type: 'buffer' }); const S = XLSX.utils.sheet_to_json(wb.Sheets.Summary, { header: 1 });
    eq((S.find((y) => String(y[0]).startsWith('Potential retail — Shop')) || [])[1], 1340);
    const b = await M.call(C, { action: 'report' }, { headers: { authorization: 'Bearer br' } }); eq([b.status, b.body.report.company], [200, null]);
  });
  console.log(`\ntotal sales: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
