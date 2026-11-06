/* C3-07 Stage 8 — HCPS demand intelligence. Runs the REAL demand-intel-api handler (and the pure _demand.js) against the in-memory
   PostgREST fake; synthetic data only. Checks: staff only (no / bad sign-in 401); a rep sees only the dealers in their book,
   management everyone; TEST dealers left out; interest is labelled and never added to sales; "dealers ordering" counts dealer
   COMPANIES (branches roll up) from purchases; "not ordered" uses the dealer's own purchases AND portal orders (cancelled ones
   don't count); requested-but-rarely-ordered = requests > 0 and at most one company ordering; the dealer action is scope-checked
   and shows the storefront link; before the storefront SQL → installed:false; never reads inquiry contacts; read errors → 503.
     node test/demand-intel.test.js */
const path = require('path');
const M = require(process.env.MOCK || path.join(__dirname, 'phase0-mock.js'));
const ROOT = process.env.CAT_ROOT || path.join(__dirname, '..', 'netlify', 'functions');
const DM = require(path.join(ROOT, '_demand.js'));
let fail = 0, pass = 0;
async function t(n, f) { try { await f(); pass++; console.log('ok   ' + n); } catch (e) { fail++; console.log('FAIL ' + n + '\n     ' + (e && e.stack || e).toString().split('\n').slice(0, 3).join('\n     ')); } }
const eq = (a, b, w) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((w || '') + ' got ' + JSON.stringify(a) + ' expected ' + JSON.stringify(b)); };
const ok = (c, w) => { if (!c) throw new Error(w); };
const A = 'aaaaaaaa-0000-0000-0000-000000000001', A2 = 'aaaaaaaa-0000-0000-0000-000000000002', B = 'bbbbbbbb-0000-0000-0000-000000000001', C = 'cccccccc-0000-0000-0000-000000000001', T = 'dddddddd-0000-0000-0000-000000000001';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
const ym = new Date().toISOString().slice(0, 7) + '-01';
const counts = [
  { day: today, dealer_id: A, manufacturer: 'bemis', code: 'B1', category: 'Bath Safety', views: 30, inquiries: 2 },
  { day: today, dealer_id: A, manufacturer: 'bemis', code: 'B2', category: 'Bath Safety', views: 10, inquiries: 1 },
  { day: today, dealer_id: A, manufacturer: 'bemis', code: 'B3', category: 'Bath Safety', views: 4, inquiries: 0 },
  { day: today, dealer_id: A2, manufacturer: 'bemis', code: 'B2', category: 'Bath Safety', views: 3, inquiries: 0 },
  { day: today, dealer_id: B, manufacturer: 'bemis', code: 'B1', category: 'Bath Safety', views: 5, inquiries: 1 },
  { day: today, dealer_id: B, manufacturer: 'strongback', code: 'S1', category: 'Wheelchairs', views: 8, inquiries: 3 },
  { day: today, dealer_id: T, manufacturer: 'bemis', code: 'B1', category: 'Bath Safety', views: 999, inquiries: 99 },
  { day: '2000-01-01', dealer_id: A, manufacturer: 'bemis', code: 'OLD', category: 'X', views: 500, inquiries: 50 }];
function world(o) {
  o = o || {};
  const W = M.createWorld({ tokens: {}, failRead: o.failRead, missingTables: o.missingTables, catalog: { bemis: [{ code: 'B1', name: 'Raised seat' }, { code: 'B2', name: 'Grab bar' }], strongback: [{ code: 'S1', name: 'Excursion chair' }] }, tables: {
    staff_users: [{ email: 'boss@hcps.test', role: 'president', active: true, name: 'Boss' }, { email: 'rep@hcps.test', role: 'rep', rep_name: 'Rita Rep', active: true, name: 'Rita' }, { email: 'gone@hcps.test', role: 'president', active: false }],
    dealers: [{ id: A, parent_id: null, business_name: 'Acme', city: 'Dayton', state: 'OH', rep_email: 'rep@hcps.test' }, { id: A2, parent_id: A, business_name: 'Acme Branch', city: 'Xenia', state: 'OH' },
      { id: B, parent_id: null, business_name: 'Bravo', city: 'Nashville', state: 'TN', rep_email: 'other@hcps.test' }, { id: C, parent_id: null, business_name: 'Charlie', state: 'KY', rep_email: 'other@hcps.test' },
      { id: T, parent_id: null, business_name: 'TEST dealer', state: 'OH', is_test: true, rep_email: 'rep@hcps.test' }],
    dealer_directory: [], manufacturers: [{ slug: 'bemis', name: 'Bemis' }, { slug: 'strongback', name: 'Strongback' }],
    storefront_daily_counts: counts,
    storefront_inquiries: [{ id: 'i1', dealer_id: A, name: 'Secret Customer', email: 'secret@x.test' }],
    dealer_storefronts: [{ dealer_id: A, slug: 'acme', enabled: true, hcps_blocked: false }],
    monthly_sales: [{ id: 1, period: ym, dealer_id: A2, manufacturer: 'bemis', product_code: 'B3', qty: 1, amount: 10 }, { id: 6, period: ym, dealer_id: A, manufacturer: 'bemis', product_code: 'B3', qty: 1, amount: 10 }, { id: 2, period: ym, dealer_id: A, manufacturer: 'bemis', product_code: 'B2', qty: 1, amount: 50 },
      { id: 3, period: ym, dealer_id: C, manufacturer: 'bemis', product_code: 'B2', qty: 4, amount: 200 }, { id: 4, period: ym, dealer_id: T, manufacturer: 'bemis', product_code: 'B1', qty: 9, amount: 9 },
      { id: 5, period: '2000-01-01', dealer_id: B, manufacturer: 'bemis', product_code: 'B1', qty: 1, amount: 1 }],
    orders: [{ id: 'o1', dealer_id: B, manufacturer: 'strongback', status: 'submitted', env: 'live', submitted_at: new Date().toISOString(), order_items: [{ code: 'S1' }] },
      { id: 'o3', dealer_id: A, manufacturer: 'bemis', status: 'submitted', env: 'test', submitted_at: new Date().toISOString(), order_items: [{ code: 'B1' }] },
      { id: 'o2', dealer_id: B, manufacturer: 'bemis', status: 'cancelled', env: 'live', submitted_at: new Date().toISOString(), order_items: [{ code: 'B1' }] }],
  } });
  const inner = W.fetch; W.urls = [];
  W.fetch = async (url, opts) => { const u = String(url); W.urls.push(u); const h = (opts && opts.headers) || {};
    if (u.startsWith(M.BASE + '/auth/v1/user')) { const tok = String(h.Authorization || '').replace(/^Bearer\s+/i, ''); const map = { boss: { email: 'boss@hcps.test' }, rep: { email: 'rep@hcps.test' }, gone: { email: 'gone@hcps.test' } };
      return map[tok] ? { ok: true, status: 200, json: async () => map[tok] } : { ok: false, status: 401, json: async () => ({}) }; }
    if (/\/rest\/v1\/orders\?/.test(u)) { const q = decodeURIComponent(u); const ids = (q.match(/dealer_id=in\.\(([^)]*)\)/) || [])[1] || ''; const rows = W.db.orders.filter((o) => ids.split(',').includes(o.dealer_id) && (!/status=neq\.cancelled/.test(q) || o.status !== 'cancelled') && (!/env=eq\.live/.test(q) || o.env === 'live'));
      return { ok: true, status: 200, text: async () => JSON.stringify(rows), json: async () => rows }; }    // the fake drops embedded selects
    return inner(url, opts); };
  return W;
}
const api = (W) => M.load('demand-intel-api.js', W, {}, ROOT);
const as = (C2, who, body) => M.call(C2, body, { headers: { authorization: 'Bearer ' + who } });

(async () => {
  await t('staff only: no sign-in or an unknown token is refused; GET refused', async () => {
    const W = world(); const H = api(W);
    eq((await M.call(H, { action: 'overview' }, { headers: {} })).status, 401); eq((await as(H, 'nobody', { action: 'overview' })).status, 401); eq((await as(H, 'gone', { action: 'overview' })).status, 401, 'inactive staff');
    eq((await H.handler({ httpMethod: 'GET', headers: {}, body: '' })).statusCode, 405);
  });
  await t('management: every real dealer, TEST and out-of-period rows left out; interest labelled, never sales', async () => {
    const r = await as(api(world()), 'boss', { action: 'overview', days: 30 });
    eq(r.status, 200); eq([r.body.installed, r.body.totals.views, r.body.totals.inquiries, r.body.totals.storefronts_with_activity], [true, 60, 7, 3]);
    eq(r.body.products.map((p) => [p.code, p.name, p.views, p.inquiries, p.storefronts]), [['B1', 'Raised seat', 35, 3, 2], ['S1', 'Excursion chair', 8, 3, 1], ['B2', 'Grab bar', 13, 1, 2], ['B3', 'B3', 4, 0, 1]], 'most requests first, then views; a code not in the catalog keeps its code');
    ok(!/amount|revenue|sales_total|\$/.test(JSON.stringify(r.body.totals)), 'interest never summed with money');
    eq(r.body.by_region.map((g) => [g.state, g.storefronts]), [['TN', 1], ['OH', 2]]);
  });
  await t('ordering: dealer COMPANIES from purchases (branches roll up, TEST out); not-ordered uses the dealer\'s purchases and live portal orders', async () => {
    const r = await as(api(world()), 'boss', { action: 'overview' });
    const P = Object.fromEntries(r.body.products.map((p) => [p.code, p.dealers_ordering_12m]));
    eq(P, { B1: 0, S1: 0, B2: 2, B3: 1 }, 'B2: Acme and Charlie; B3: Acme head office + branch = one company; B1 only by TEST / long ago');
    eq(r.body.dealer_opportunities.map((x) => [x.dealer, x.code]), [['Acme', 'B1'], ['Bravo', 'B1']], 'Acme Branch looked at B2, which its head office bought (family, not location); Bravo ordered S1 on the portal; the cancelled and the test-environment B1 orders do not count');
    ok(!('units_ordered_12m' in r.body.products[0]), 'no units added across lanes');
    eq(r.body.interest_not_ordered.map((p) => p.code), ['B1', 'S1'], 'requests > 0 (not B3, views only) and at most one company ordering (not B2, two companies)');
  });
  await t('a rep sees only the dealers in their book (never another rep\'s or TEST)', async () => {
    const r = await as(api(world()), 'rep', { action: 'overview' });
    eq(r.status, 200); eq(r.body.storefronts.map((s) => s.name), ['Acme', 'Acme Branch']); eq(r.body.totals.views, 47);
    ok(!/Bravo|Charlie|TEST dealer/.test(JSON.stringify(r.body)), 'no other dealers');
  });
  await t('My Sales Workspace: the President sees only his own book', async () => {
    const W = world(); W.db.dealers.find((d) => d.id === B).rep_email = 'boss@hcps.test';
    const r = await M.call(api(W), { action: 'overview' }, { headers: { authorization: 'Bearer boss', 'x-hcps-workspace': 'mine' } });
    eq(r.body.storefronts.map((s) => s.name), ['Bravo']);
    eq((await M.call(api(W), { action: 'dealer', dealer_id: A }, { headers: { authorization: 'Bearer boss', 'x-hcps-workspace': 'mine' } })).status, 403);
  });
  await t('orders are read in batches of 100 dealers (the address stays short)', async () => {
    const W = world(); for (let i = 0; i < 250; i++) { const id = 'eeeeeeee-0000-0000-0000-' + String(i).padStart(12, '0'); W.db.dealers.push({ id, parent_id: A, business_name: 'B' + i }); }
    await as(api(W), 'boss', { action: 'overview' }); const o = W.urls.filter((u) => /\/rest\/v1\/orders\?/.test(u));
    ok(o.length === 3 && o.every((u) => u.length < 5000), o.length + ' calls, longest ' + Math.max(...o.map((u) => u.length)));
  });
  await t('dealer action: scope-checked; storefront link and status; malformed id 404', async () => {
    const W = world(); const H = api(W);
    eq((await as(H, 'rep', { action: 'dealer', dealer_id: B })).status, 403);
    eq((await as(H, 'rep', { action: 'dealer', dealer_id: 'x' })).status, 404);
    const r = await as(H, 'rep', { action: 'dealer', dealer_id: A, days: 90 });
    eq([r.status, r.body.storefront.live, /\/store\/acme$/.test(r.body.storefront.link), r.body.totals.views], [200, true, true, 44]);
    const b = await as(H, 'boss', { action: 'dealer', dealer_id: C }); eq([b.status, b.body.storefront, b.body.totals.views], [200, null, 0]);
  });
  await t('privacy: inquiry contacts are never read', async () => {
    const W = world(); await as(api(W), 'boss', { action: 'overview' }); await as(api(W), 'boss', { action: 'dealer', dealer_id: A });
    ok(!W.urls.some((u) => /storefront_inquiries/.test(u)), 'read storefront_inquiries');
  });
  await t('before the storefront SQL → installed:false; a read error → 503', async () => {
    eq((await as(api(world({ missingTables: ['storefront_daily_counts'] })), 'boss', { action: 'overview' })).body.installed, false);
    eq((await as(api(world({ failRead: (tb) => (tb === 'monthly_sales' ? 500 : 0) })), 'boss', { action: 'overview' })).status, 503);
    eq((await as(api(world({ failRead: (tb) => (tb === 'storefront_daily_counts' ? 500 : 0) })), 'boss', { action: 'overview' })).status, 503, 'not hidden as "not installed"');
  });
  await t('rules: an empty input gives an empty report; the request rate', async () => {
    const e = DM.build({ counts: [], dealers: new Map(), names: {}, mfrName: {}, scopeIds: null, bought: new Map(), network: new Map() });
    eq([e.totals.views, e.totals.request_rate_pct, e.products.length], [0, null, 0]);
  });
  console.log(`\ndemand-intel: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
