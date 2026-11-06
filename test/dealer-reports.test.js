/* C3-07 Stage 6 — dealer & branch reports. Runs the REAL report builder and the REAL dealer-reports-api handler against the
   in-memory PostgREST fake (nothing reaches Supabase, the storefront or an AI provider). Synthetic data only.
   Checks: purchases = manufacturer-reported only, a commission line repeating a sales-report line counted once, a line with no
   amount never counted as $0; portal orders apart and never summed, cancelled excluded; quotes = activity; year-over-year only
   where HCPS history covers the comparison window (else "—" and a note), never against an invented zero; categories from the
   catalog; declining categories; network opportunities (≥3 OTHER dealers, this company and TEST dealers left out, retired lines
   and products not in the catalog never suggested, nothing bought in 12 months, no other dealer's name or figures returned);
   access (head office: company + each location; branch: its own only; another dealer's location 403; preview read-only, no AI);
   strict reads (503); the PDF (valid, branded, no AI); AI suggestions grounded (refs + numbers checked, banned phrases dropped).
     node test/dealer-reports.test.js */
const path = require('path');
const M = require(process.env.MOCK || path.join(__dirname, 'phase0-mock.js'));
const ROOT = process.env.CAT_ROOT || path.join(__dirname, '..', 'netlify', 'functions');
const REP = require(path.join(ROOT, '_dealer_report.js'));
let fail = 0, pass = 0;
async function t(n, f) { try { await f(); pass++; console.log('ok   ' + n); } catch (e) { fail++; console.log('FAIL ' + n + '\n     ' + (e && e.stack || e).toString().split('\n').slice(0, 3).join('\n     ')); } }
const eq = (a, b, w) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((w || '') + ' got ' + JSON.stringify(a) + ' expected ' + JSON.stringify(b)); };
const ok = (c, w) => { if (!c) throw new Error(w); };
const HQ = '11111111-1111-1111-1111-111111111111', BR = '22222222-2222-2222-2222-222222222222', OTHER = '44444444-4444-4444-4444-444444444444';
const F1 = '77777777-7777-7777-7777-777777777771', F2 = '77777777-7777-7777-7777-777777777772', F3 = '77777777-7777-7777-7777-777777777773';
const N1 = '55555555-5555-5555-5555-555555555551', N2 = '55555555-5555-5555-5555-555555555552', N3 = '55555555-5555-5555-5555-555555555553', TST = '66666666-6666-6666-6666-666666666666';
const Y = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric' }).format(new Date()));
const p = (y, m) => `${y}-${String(m).padStart(2, '0')}-01`;
let id = 0;
const sale = (dealer, mfr, period, code, qty, amount, source, extra) => Object.assign({ id: ++id, dealer_id: dealer, manufacturer: mfr, period, product_code: code, product_name: code + ' name', qty, amount, source: source || 'sales_report', external_ref: source === 'commission' ? null : 'x' }, extra || {});
const CAT = { strongback: [{ code: 'SB1', name: 'Excursion', category: 'Wheelchairs' }, { code: 'SB2', name: 'Rollator', category: 'Rollators' }, { code: 'SB9', name: 'Popular Chair', category: 'Wheelchairs' }, { code: 'SB8', name: 'Seat', category: 'Accessories' }, { code: 'SB7', name: 'Walker', category: 'Rollators' }, { code: 'SB6', name: 'Branch favourite', category: 'Wheelchairs' }],
  bemis: [{ code: 'BE1', name: 'Seat', category: 'Bath Safety' }], gce: [{ code: 'G1', name: 'Retired line item', category: 'Oxygen' }, { code: 'G0', name: 'Old', category: 'Oxygen' }] };

function seed(o) {
  o = o || {};
  id = 0;
  const sales = [
    // HQ: strongback both years (history from Y-2 → covered), commission duplicate of one sales line, one row without an amount
    sale(HQ, 'strongback', p(Y, 1), 'SB1', 2, 600), sale(HQ, 'strongback', p(Y, 1), 'SB1', 2, 600, 'commission'),
    sale(HQ, 'strongback', p(Y, 1), 'SB2', 1, 100), sale(HQ, 'strongback', p(Y, 1), 'SB2', 1, null, 'commission'),
    sale(HQ, 'strongback', p(Y - 1, 1), 'SB1', 1, 300), sale(HQ, 'strongback', p(Y - 1, 1), 'SB2', 10, 1000),
    sale(HQ, 'strongback', p(Y - 2, 6), 'SB1', 1, 50),
    // branch: bemis, a line whose HCPS history only starts this year (not covered)
    sale(BR, 'bemis', p(Y, 1), 'BE1', 4, 400),
    // the network: three other dealers + a TEST dealer + this company all order SB9; only two order SB8
    sale(N1, 'strongback', p(Y, 1), 'SB9', 3, 900), sale(N2, 'strongback', p(Y, 1), 'SB9', 1, 300), sale(N3, 'strongback', p(Y, 1), 'SB9', 1, 300),
    sale(TST, 'strongback', p(Y, 1), 'SB8', 1, 10), sale(N1, 'strongback', p(Y, 1), 'SB8', 1, 10), sale(N2, 'strongback', p(Y, 1), 'SB8', 1, 10),
    sale(N1, 'gce', p(Y, 1), 'G1', 1, 10), sale(N2, 'gce', p(Y, 1), 'G1', 1, 10), sale(N3, 'gce', p(Y, 1), 'G1', 1, 10),
    sale(OTHER, 'strongback', p(Y, 1), 'SB1', 1, 99999),
    sale(F1, 'strongback', p(Y, 1), 'SB6', 1, 300), sale(F2, 'strongback', p(Y, 1), 'SB6', 1, 300), sale(F3, 'strongback', p(Y, 1), 'SB6', 1, 300),
    sale(N1, 'strongback', p(Y, 1), 'SB7', 1, 300), sale(N2, 'strongback', p(Y, 1), 'SB7', 1, 300), sale(BR, 'strongback', p(Y, 1), 'SB7', 1, 0),
    sale(N1, 'strongback', p(Y, 1), 'SB1', 1, 300), sale(N2, 'strongback', p(Y, 1), 'SB1', 1, 300), sale(N3, 'strongback', p(Y, 1), 'SB1', 1, 300),
    sale(HQ, 'gce', p(Y - 1, 0 + 1).replace(/-01-01$/, '-01-01'), 'G0', 1, 5, 'sales_report', { period: `${Y - 2}-12-01` }),
  ];
  const W = M.createWorld({ tokens: {}, failRead: o.failRead, missingTables: o.missingTables, catalog: CAT, tables: {
    dealers: [{ id: HQ, parent_id: null, business_name: 'Acme Medical', city: 'Dayton', state: 'OH', logo_url: null }, { id: BR, parent_id: HQ, business_name: 'Acme Branch', city: 'Xenia', state: 'OH' },
      { id: OTHER, parent_id: null, business_name: 'Else Medical' }, { id: N1, parent_id: null, business_name: 'N1' }, { id: N2, parent_id: null, business_name: 'N2' }, { id: N3, parent_id: null, business_name: 'N3' },
      { id: TST, parent_id: null, business_name: 'TEST', is_test: true }, { id: F1, parent_id: null, business_name: 'Fam' }, { id: F2, parent_id: F1, business_name: 'Fam 2' }, { id: F3, parent_id: F1, business_name: 'Fam 3' }],
    dealer_users: [{ uid: 'u-hq', status: 'approved', dealer_id: HQ, email: 'hq@acme.test' }, { uid: 'u-br', status: 'approved', dealer_id: BR, email: 'br@acme.test' }, { uid: 'u-ot', status: 'approved', dealer_id: OTHER, email: 'x@else.test' }],
    dealer_user_scope: [], dealer_preview_tokens: [{ token: 'pv1', dealer_id: HQ, expires_at: new Date(Date.now() + 600000).toISOString() }, { token: 'pvnull', dealer_id: HQ, expires_at: null }, { token: 'pvold', dealer_id: HQ, expires_at: new Date(Date.now() - 1000).toISOString() }],
    monthly_sales: sales,
    orders: [{ id: 'o1', dealer_id: HQ, manufacturer: 'strongback', status: 'submitted', subtotal: 250, submitted_at: `${Y}-01-15T10:00:00Z` },
      { id: 'o2', dealer_id: HQ, manufacturer: 'strongback', status: 'cancelled', subtotal: 999, submitted_at: `${Y}-01-16T10:00:00Z` },
      { id: 'o3', dealer_id: OTHER, manufacturer: 'strongback', status: 'submitted', subtotal: 5, submitted_at: `${Y}-01-16T10:00:00Z` }],
    dealer_saved_quotes: [{ id: 'q1', dealer_id: HQ, location_id: HQ, status: 'sent', created_at: `${Y}-01-03T00:00:00Z`, lines: [{}, {}] }, { id: 'q2', dealer_id: HQ, location_id: BR, status: 'draft', created_at: `${Y}-01-04T00:00:00Z`, lines: [{}] }],
    manufacturers: [{ slug: 'strongback', name: 'Strongback' }, { slug: 'bemis', name: 'Bemis' }, { slug: 'gce', name: 'GCE' }] } });
  const inner = W.fetch;
  W.ai = [];
  W.fetch = async (url, opts) => { const u = String(url);
    if (u.startsWith(M.BASE + '/auth/v1/user')) { const tok = String(((opts && opts.headers) || {}).Authorization || '').replace(/^Bearer\s+/i, '');
      const map = { hq: { id: 'u-hq' }, br: { id: 'u-br' }, ot: { id: 'u-ot' } };
      return map[tok] ? { ok: true, status: 200, json: async () => map[tok] } : { ok: false, status: 401, json: async () => ({}) }; }
    if (u.includes('api.anthropic.com')) { W.ai.push(JSON.parse(opts.body)); const txt = JSON.stringify({ content: [{ type: 'text', text: o.aiText || '{}' }] }); return { ok: true, status: 200, text: async () => txt, json: async () => JSON.parse(txt) }; }
    return inner(url, opts); };
  return W;
}
const api = (W, env) => M.load('dealer-reports-api.js', W, Object.assign({ ANTHROPIC_API_KEY: 'sk-test' }, env || {}), ROOT);
const as = (C, who, body) => M.call(C, body, { headers: { authorization: 'Bearer ' + who } });

(async () => {
  await t('purchases: a commission line repeating a sales-report line counts once; a line with no amount is not $0', async () => {
    const W = seed(); const C = api(W); const r = await as(C, 'hq', { action: 'report', scope: HQ, year: Y });
    eq(r.status, 200); const R = r.body.report;
    eq(R.purchases.total, 700, 'HQ purchases'); ok(R.notes.some((n) => /1 commission-statement line/.test(n)), 'dup note'); ok(R.notes.some((n) => /1 reported line\(s\) have no amount/.test(n)), 'no-amount note');
  });
  await t('portal orders shown apart (cancelled excluded) and never added to purchases; quotes are activity', async () => {
    const W = seed(); const C = api(W); const R = (await as(C, 'hq', { action: 'report', scope: 'company', year: Y })).body.report;
    eq([R.portal.orders, R.portal.merchandise, R.portal.cancelled_excluded], [1, 250, 1]); eq(R.purchases.total, 1100, 'company = HQ 700 + branch 400, no portal');
    eq([R.quotes.created, R.quotes.sent, R.quotes.draft, R.quotes.lines], [2, 1, 1, 3]);
  });
  await t('year-over-year only where HCPS history covers the window: Strongback compared, Bemis shown as "—", the company total withheld with a note', async () => {
    const W = seed(); const C = api(W); const R = (await as(C, 'hq', { action: 'report', scope: 'company', year: Y })).body.report;
    const sb = R.manufacturers.find((m) => m.slug === 'strongback'), be = R.manufacturers.find((m) => m.slug === 'bemis');
    eq([sb.purchases, sb.prior, sb.change_pct], [700, 1300, -46.2]); eq([be.prior, be.change_pct], [null, null]);
    eq([R.purchases.total, R.purchases.current_compared, R.purchases.prior, R.purchases.change_pct, R.purchases.partial], [1100, 700, 1300, -46.2, true], 'company: like-for-like over the comparable line only');
    ok(R.notes.some((n) => /No year-over-year comparison for: Bemis/.test(n)), 'coverage note');
    const hq = (await as(C, 'hq', { action: 'report', scope: HQ, year: Y })).body.report; eq([hq.purchases.prior, hq.purchases.change_pct], [1300, -46.2], 'HQ alone is fully covered');
  });
  await t('categories from the catalog; Rollators flagged as declining (≥$500 last year, ≤ -20%)', async () => {
    const W = seed(); const C = api(W); const R = (await as(C, 'hq', { action: 'report', scope: HQ, year: Y })).body.report;
    eq(R.categories.map((c) => [c.category, c.purchases, c.prior]), [['Wheelchairs', 600, 300], ['Rollators', 100, 1000]]);
    eq(R.declining_categories.map((c) => c.category), ['Rollators']);
  });
  await t('opportunities: ≥3 OTHER dealers on a line this company buys; TEST dealers, this company, retired lines and uncatalogued items left out; no names or figures', async () => {
    const W = seed(); const C = api(W); const r = await as(C, 'hq', { action: 'report', scope: 'company', year: Y });
    eq(r.body.report.opportunities, [{ manufacturer: 'strongback', manufacturer_name: 'Strongback', code: 'SB9', name: 'Popular Chair', category: 'Wheelchairs', dealers: 3 }]);
    const s = JSON.stringify(r.body); ok(!/N1|Else Medical|99999|"900"/.test(s), 'no other dealer data in the answer');
    const h = await as(C, 'hq', { action: 'report', scope: HQ, year: Y }); eq(h.body.report.opportunities.map((o) => o.code), ['SB9'], 'a sister location\'s purchase never makes a network favourite');
  });
  await t('access: a branch sees its own location only (company → its own); another dealer\'s location 403; no token 401', async () => {
    const W = seed(); const C = api(W);
    const b = await as(C, 'br', { action: 'report', scope: 'company', year: Y }); eq([b.status, b.body.scope, b.body.head_office, b.body.locations.length], [200, BR, false, 1]); eq(b.body.report.purchases.total, 400);
    eq((await as(C, 'br', { action: 'report', scope: HQ })).status, 403); eq((await as(C, 'hq', { action: 'report', scope: OTHER })).status, 403);
    eq((await as(C, 'nobody', { action: 'report' })).status, 401); eq((await as(C, 'hq', { action: 'report', scope: 'drop table' })).status, 400);
    const h = await as(C, 'hq', { action: 'report' }); eq([h.body.scope, h.body.head_office, h.body.locations.length], ['company', true, 2]);
  });
  await t('a head office limited to its own location (dealer_user_scope "own") sees only that location', async () => {
    const W = seed(); W.db.dealer_user_scope = [{ uid: 'u-hq', scope: 'own', locations: [] }]; const C = api(W);
    const r = await as(C, 'hq', { action: 'report', scope: 'company' }); eq([r.body.scope, r.body.locations.length], [HQ, 1]); eq((await as(C, 'hq', { action: 'report', scope: BR })).status, 403);
  });
  await t('HCPS preview token reads the report; AI is refused in preview', async () => {
    const W = seed(); const C = api(W);
    eq((await as(C, 'preview:pv1', { action: 'report', scope: 'company', year: Y })).body.report.purchases.total, 1100);
    eq((await as(C, 'preview:pv1', { action: 'report_ai', scope: 'company' })).status, 403); eq((await as(C, 'preview:nope', { action: 'report' })).status, 401); eq((await as(C, 'preview:pvnull', { action: 'report' })).status, 401, 'no expiry refused'); eq((await as(C, 'preview:pvold', { action: 'report' })).status, 401, 'expired');
  });
  await t('strict: unreadable purchases or orders answer 503, never an empty report', async () => {
    for (const tb of ['monthly_sales', 'orders']) { const W = seed({ failRead: (table, qs) => (table === tb && /dealer_id=in/.test(decodeURIComponent(String(qs || ''))) ? 500 : 0) }); const r = await as(api(W), 'hq', { action: 'report', year: Y }); eq(r.status, 503, tb); }
    const W = seed({ missingTables: ['dealer_saved_quotes'] }); const r = await as(api(W), 'hq', { action: 'report', year: Y }); eq(r.status, 200); ok(r.body.report.notes.some((n) => /quotes are not available/i.test(n)), 'quotes note');
  });
  await t('PDF: a valid PDF, HCPS-branded, built from the report (no AI)', async () => {
    const W = seed(); const r = await as(api(W), 'hq', { action: 'report_pdf', scope: 'company', year: Y });
    eq(r.status, 200); const buf = Buffer.from(r.body.pdf_base64, 'base64'); ok(buf.slice(0, 5).toString() === '%PDF-', 'pdf header'); ok(buf.length > 20000, 'logo embedded (' + buf.length + ')');
    const { PDFDocument } = require(path.join(__dirname, '..', 'node_modules', 'pdf-lib')); const d = await PDFDocument.load(buf); ok(d.getPageCount() >= 1 && /Acme/.test(d.getTitle()), 'title'); eq(W.ai.length, 0);
  });
  await t('AI: grounded suggestions kept; one citing an unknown fact, inventing a number or using a banned phrase dropped', async () => {
    const good = { title: 'Revisit Rollators', detail: 'Rollators are -90% versus last year; review your rollator assortment.', refs: ['down0'] };
    const recs = [good, { title: 'Grow', detail: 'You could add $50,000 in sales.', refs: ['total'] }, { title: 'X', detail: 'Something', refs: ['nope'] }, { title: 'Just checking in', detail: 'Just checking in on Rollators.', refs: ['down0'] }];
    const W = seed({ aiText: JSON.stringify({ recommendations: recs }) }); const r = await as(api(W), 'hq', { action: 'report_ai', scope: HQ, year: Y });
    eq(r.status, 200); eq(r.body.recommendations.map((x) => x.title), ['Revisit Rollators']); eq(W.ai.length, 1); ok(W.ai[0].thinking && W.ai[0].thinking.type === 'disabled', 'thinking off');
    ok(/FACTS/.test(W.ai[0].messages[0].content) && !/99999|Else Medical/.test(W.ai[0].messages[0].content), 'prompt has only this dealer\'s facts');
  });
  await t('AI: nothing checkable → 502 after one retry; no API key → 503; limited per dealer', async () => {
    const W = seed({ aiText: '{"recommendations":[{"title":"t","detail":"Buy 7 more.","refs":["total"]}]}' }); const C = api(W);
    eq((await as(C, 'hq', { action: 'report_ai', scope: HQ })).status, 502); eq(W.ai.length, 2);
    eq((await as(api(seed(), { ANTHROPIC_API_KEY: '' }), 'hq', { action: 'report_ai' })).status, 503);
    const W2 = seed({ aiText: '{}' }); const C2 = api(W2); const codes = []; for (let i = 0; i < 5; i++) codes.push((await as(C2, 'hq', { action: 'report_ai' })).status); eq(codes, [502, 502, 502, 502, 429]);
  });
  await t('one company with three branches never meets the 3-dealer network minimum alone', async () => {
    const R = (await as(api(seed()), 'hq', { action: 'report', scope: HQ, year: Y })).body.report; ok(!R.opportunities.some((o) => o.code === 'SB6'), JSON.stringify(R.opportunities));
  });
  await t('reporting lag: months not yet reported are left out of this year and of the comparison (Jan–Sep vs Jan–Sep, 0%)', async () => {
    const rows = [], rm = [];
    for (let m = 1; m <= 12; m++) { rows.push({ dealer_id: 'a', manufacturer: 'x', period: `2025-${String(m).padStart(2, '0')}-01`, product_code: 'X', qty: 1, amount: 100, source: 'sales_report', external_ref: 'r' }); rm.push(`2025-${String(m).padStart(2, '0')}`); }
    for (let m = 1; m <= 9; m++) { rows.push({ dealer_id: 'a', manufacturer: 'x', period: `2026-${String(m).padStart(2, '0')}-01`, product_code: 'X', qty: 1, amount: 100, source: 'sales_report', external_ref: 'r' }); rm.push(`2026-${String(m).padStart(2, '0')}`); }
    const R = REP.build({ year: '2026', today: '2026-11-06', locations: [{ id: 'a', name: 'A' }], scope: 'a', sales: rows, catalog: {}, reportedMonths: { x: rm } });
    eq([R.period.through, R.purchases.total, R.purchases.prior, R.purchases.change_pct, R.monthly.length], ['2026-09', 900, 900, 0, 9]);
  });
  await t('a gap in a line\'s reports (Feb never reported this year) compares only the months reported in both years', async () => {
    const rows = [], rm = ['2025-01', '2025-02', '2025-03', '2026-01', '2026-03'];
    for (const m of rm) rows.push({ dealer_id: 'a', manufacturer: 'x', period: m + '-01', product_code: 'X', qty: 1, amount: 100, source: 'sales_report', external_ref: 'r' });
    const R = REP.build({ year: '2026', today: '2026-04-10', locations: [{ id: 'a', name: 'A' }], scope: 'a', sales: rows, catalog: {}, reportedMonths: { x: rm } });
    eq([R.purchases.total, R.purchases.current_compared, R.purchases.prior, R.purchases.change_pct, R.manufacturers[0].compared_months], [200, 200, 200, 0, 2]);
  });
  await t('PDF survives emoji, CJK, right-to-left and control characters in names', async () => {
    const PDF = require(path.join(ROOT, '_report_pdf.js'));
    const rep = REP.build({ year: '2026', today: '2026-04-10', locations: [{ id: 'a', name: 'A' }], scope: 'a', sales: [{ dealer_id: 'a', manufacturer: 'x', period: '2026-01-01', product_code: 'X', product_name: 'Chair 🪑 椅子 كرسي \u0007 ≥', qty: 1, amount: 5, source: 'sales_report', external_ref: 'r' }], catalog: {}, reportedMonths: { x: ['2026-01'] } });
    const b = await PDF.render({ report: rep, dealer: { business_name: 'Dealer 🙂 名前', logo_url: 'data:image/png;base64,AAAA' }, scopeName: 'Scope \u202e evil', generated: 'today' }); ok(b.slice(0, 5).toString() === '%PDF-', 'pdf');
  });
  await t('builder: the current-year window is Jan→this month, compared with the same months last year', async () => {
    const w = REP.windowFor(2026, '2026-03-15', '2026-03'); eq([w.months, w.prior, w.ytd], [['2026-01', '2026-02', '2026-03'], ['2025-01', '2025-02', '2025-03'], true]);
    eq(REP.windowFor(2025, '2026-03-15').months.length, 12); eq(REP.windowFor(2026, '2026-03-15', '2026-02').months, ['2026-01', '2026-02']); eq(REP.windowFor(2026, '2026-03-15').months, ['2026-01', '2026-02'], 'nothing reported → through last month');
    eq(REP.windowFor(2026, '2026-03-15', '2026-02').months, ['2026-01', '2026-02'], 'stops at the last reported month'); eq(REP.windowFor(2026, '2026-03-15', '2025-12').months, ['2026-01', '2026-02'], 'no data this year → through last month'); eq(REP.numbersOk('Down 46.2% from $1,300.00', [{ id: 'a', text: '$1,300.00 and -46.2%' }]), true); eq(REP.numbersOk('Down 47%', [{ id: 'a', text: '46.2' }]), false);
  });
  console.log(`\ndealer reports: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
