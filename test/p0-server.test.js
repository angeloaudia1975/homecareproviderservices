/* P0 (2026-10-23, homecareproviderservicesordering issue #2) — the server side of the price lock-down.
   The storefront's public catalog files no longer carry prices; the commercial half of each line lives
   in the private table catalog_file_commercial. Runs the REAL orders-api (→ _pricing.js → the shop's
   own engine) and catalog-api against the in-memory PostgREST fake and a fake storefront site:
     · a stripped public file + its commercial row prices EXACTLY like the old priced file did;
     · a stripped file with no commercial row is refused (503) — never priced from nothing, nothing stored;
     · a commercial row out of step with the public file is refused;
     · the engine's catalog-layers read is answered from this line's rows only, with the shop's columns;
     · catalog-api's catalog file (Product Catalog, audits, Price Check) carries the restored prices.
   Plus: the real Bemis file (full copy from git) gives identical server prices both ways. */
const path = require('path');
const M = require(process.env.MOCK || path.join(__dirname, 'phase0-mock.js'));
const ROOT = process.env.CAT_ROOT || path.join(__dirname, '..', 'netlify', 'functions');
const CC = require(path.join(ROOT, '_catalog_commercial.js'));
const OB = 'https://ordering.test';
let fail = 0, pass = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('ok   ' + name); } catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + String((e && e.stack) || e).split('\n').slice(0, 2).join('\n     ')); } }
const eq = (a, b, w) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((w || '') + ' got ' + JSON.stringify(a) + ' expected ' + JSON.stringify(b)); };
const ok = (c, w) => { if (!c) throw new Error(w); };
const copy = v => JSON.parse(JSON.stringify(v));

const LINE = 'ovation-medical';
const FULL = [
  { manufacturer: LINE, code: 'A1', name: 'Standard item', group: '', base_price: 50, msrp: 100, price_note: 'MAP $X' },
  { manufacturer: LINE, code: 'B1', name: 'Boot S', group: 'Boot', base_price: 50, tiers: [{ minQty: 1, price: 50 }, { minQty: 3, price: 40 }] },
  { manufacturer: LINE, code: 'B2', name: 'Boot M', group: 'Boot', base_price: 50, tiers: [{ minQty: 1, price: 50 }, { minQty: 3, price: 40 }] },
];
const SPLIT = CC.splitCatalogFile(FULL);

function world({ file, commercial, extra }) {
  const W = M.createWorld({ tokens: { dealer: 'd@x.com' }, tables: Object.assign({
    app_settings: [{ key: 'platform_state', value: { mode: 'development' } }],
    manufacturers: [{ slug: LINE, name: 'Ovation Medical' }], manufacturer_meta: [{ slug: LINE }],
    dealers: [{ id: 'd1', parent_id: null, is_test: true }], dealer_users: [{ uid: 'u1', status: 'approved', dealer_id: 'd1', email: 'd@x.com' }],
    dealer_manufacturers: [{ dealer_id: 'd1', manufacturer: LINE, active: true }, { dealer_id: 'd1', manufacturer: 'bemis', active: true }, { dealer_id: 'd1', manufacturer: 'strongback-mobility', active: false }],
    dealer_contract_prices: [], product_overrides: [{ manufacturer: 'other-line', code: 'A1', patch: { active: false } }],
    custom_products: [{ manufacturer: LINE, code: 'X9', name: 'Added', base_price: 30, active: true }, { manufacturer: 'other-line', code: 'Z1', name: 'Other', base_price: 1, active: true }],
    product_images: [], product_links: [], product_media: [], product_content: [], product_skus: [],
    orders: [], order_items: [], tracking_requests: [], email_sends: [], intent_events: [], email_attribution: [],
    catalog_file_commercial: commercial || [],
  }, extra || {}) });
  const inner = W.fetch;
  W.fetch = async (url, opts) => {
    const u = String(url);
    if (u.startsWith(M.BASE + '/auth/v1/user')) { const tok = String(((opts && opts.headers) || {}).Authorization || '').replace(/^Bearer\s+/i, '');
      return tok === 'dealer' ? { ok: true, status: 200, json: async () => ({ id: 'u1', email: 'd@x.com' }) } : { ok: false, status: 401, json: async () => ({}) }; }
    if (u.startsWith(OB + '/data/content/')) return { ok: false, status: 404, json: async () => null, text: async () => '' };
    if (u.startsWith(OB + '/data/')) return { ok: true, status: 200, json: async () => copy(file), text: async () => JSON.stringify(file) };
    if (u.startsWith('https://api.resend.com')) return { ok: true, status: 200, json: async () => ({ id: 'm' }) };
    return inner(url, opts);
  };
  return W;
}
const orders = W => M.load('orders-api.js', W, { ORDERING_BASE: OB }, ROOT);
const call = (C, body) => M.call(C, body, { headers: { authorization: 'Bearer dealer' } });
const order = items => ({ manufacturer_slug: LINE, manufacturer_name: 'Ovation Medical', po: 'PO1', items });
const row = (slug, rows) => ({ manufacturer: slug, rows });

(async () => {
  const CART = [{ code: 'A1', qty: 1, unit: 50 }, { code: 'B1', qty: 2, unit: 40 }, { code: 'B2', qty: 1, unit: 40 }, { code: 'X9', qty: 1, unit: 30 }];
  let before;
  await t('today: the priced public file prices the cart (reference answer)', async () => {
    const r = await call(orders(world({ file: FULL })), { action: 'price_check', orders: [order(copy(CART))] });
    eq(r.status, 200); before = r.body.orders[0]; eq(r.body.changed, false, 'changed');
  });
  await t('P0: the stripped public file + its private commercial row prices the cart identically, item for item', async () => {
    const r = await call(orders(world({ file: SPLIT.public, commercial: [row(LINE, SPLIT.overlay)] })), { action: 'price_check', orders: [order(copy(CART))] });
    eq(r.status, 200); eq(r.body.changed, false, 'changed'); eq(r.body.orders[0], before, 'priced order');
  });
  await t('a stripped public file with no commercial row is refused — 503, never priced from nothing, nothing stored', async () => {
    const W = world({ file: SPLIT.public }); const C = orders(W);
    const r = await call(C, { action: 'price_check', orders: [order(copy(CART))] });
    eq(r.status, 503); eq(r.body.status, 'pricing_unavailable'); ok(/no commercial record/.test(r.body.error), r.body.error);
    const c = await call(C, { action: 'create', orders: [order(copy(CART))], dealer: {} });
    eq(c.status, 503, 'create'); eq(W.db.orders.length + W.db.order_items.length, 0, 'nothing stored');
  });
  await t('a commercial row out of step with the public file is refused (503)', async () => {
    const r = await call(orders(world({ file: SPLIT.public, commercial: [row(LINE, SPLIT.overlay.slice(1))] })), { action: 'price_check', orders: [order(copy(CART))] });
    eq(r.status, 503); ok(/catalog_file_mismatch/.test(r.body.error), r.body.error);
  });
  await t('an unreadable commercial table is refused (503), nothing stored', async () => {
    const W = world({ file: SPLIT.public, commercial: [row(LINE, SPLIT.overlay)] });
    const inner = W.fetch; W.fetch = async (u, o) => /catalog_file_commercial/.test(String(u)) ? { ok: false, status: 500, json: async () => ({}), text: async () => 'down' } : inner(u, o);
    const C = orders(W); const c = await call(C, { action: 'create', orders: [order(copy(CART))], dealer: {} });
    eq(c.status, 503); eq(W.db.orders.length, 0);
  });
  await t('the private row wins over a stale price left in a public file', async () => {
    const stale = copy(FULL); stale[0].base_price = 1;
    const r = await call(orders(world({ file: stale, commercial: [row(LINE, SPLIT.overlay)] })), { action: 'price_check', orders: [order([{ code: 'A1', qty: 1, unit: 50 }])] });
    eq(r.body.orders[0].items[0].unit, 50);
  });
  await t('the engine\'s catalog-layers read is answered from this line only, with the storefront\'s columns', async () => {
    const W = world({ file: SPLIT.public, commercial: [row(LINE, SPLIT.overlay), row('other-line', [])] });
    const r = await call(orders(W), { action: 'price_check', orders: [order([{ code: 'Z1', qty: 1, unit: 1 }, { code: 'A1', qty: 1, unit: 50 }])] });
    const items = r.body.orders[0].items;
    eq(items.find(i => i.code === 'Z1').available, false, 'another line\'s added product never joins this line');
    eq(items.find(i => i.code === 'A1').available, true, 'another line\'s override never hides this line\'s product');
    ok(W.calls.some(c => /custom_products\?manufacturer=eq\.ovation-medical&select=code,name,category,base_price,msrp,map,image,description,active,tiers,price_note/.test(c.url)), 'custom select');
    ok(W.calls.some(c => /product_overrides\?manufacturer=eq\.ovation-medical&select=code,patch/.test(c.url)), 'override select');
  });
  await t('orders-api: a dealer cannot price or order a line it does not carry (no commercial field leaks), nothing stored', async () => {
    const W = world({ file: SPLIT.public, commercial: [row(LINE, SPLIT.overlay)] }); const C = orders(W);
    const sb = [{ manufacturer_slug: 'strongback-mobility', items: [{ code: 'SB100', qty: 1, unit: 1 }] }];
    const r = await call(C, { action: 'price_check', orders: sb });
    eq(r.status, 403); eq(r.body.status, 'not_entitled'); eq(r.body.lines, ['strongback-mobility']); ok(!/base_price|tiers|msrp|"map"/.test(JSON.stringify(r.body)), 'commercial leaked');
    const mixed = await call(C, { action: 'create', orders: [order([{ code: 'A1', qty: 1, unit: 50 }])].concat(sb), dealer: {} });
    eq(mixed.status, 403, 'a cart mixing a carried and a non-carried line is refused whole'); eq(W.db.orders.length + W.db.order_items.length, 0, 'nothing stored');
    ok(!W.calls.some(c => /\/data\/strongback/.test(c.url)), 'the non-carried line was never even read');
  });
  await t('orders-api: an unreadable line list stops pricing (503), never "carries everything"', async () => {
    const W = world({ file: SPLIT.public, commercial: [row(LINE, SPLIT.overlay)] });
    const inner = W.fetch; W.fetch = async (u, o) => /dealer_manufacturers/.test(String(u)) ? { ok: false, status: 500, json: async () => ({}), text: async () => 'down' } : inner(u, o);
    const r = await call(orders(W), { action: 'price_check', orders: [order([{ code: 'A1', qty: 1, unit: 50 }])] });
    eq(r.status, 503);
  });
  await t('orders-api: Golden is left to Golden (no HCPS line check)', async () => {
    const W = world({ file: SPLIT.public, commercial: [row(LINE, SPLIT.overlay)] });
    const c = await call(orders(W), { action: 'create', orders: [{ manufacturer_slug: 'golden-technologies', po: 'G', items: [{ code: 'G1', qty: 1, unit: 5 }], items_subtotal: 5 }], dealer: {} });
    eq(c.status, 200);
  });
  await t('catalog-api: Product Catalog reads the restored prices from the private row', async () => {
    const W = world({ file: SPLIT.public, commercial: [row(LINE, SPLIT.overlay)] });
    const C = M.load('catalog-api.js', W, { ANALYTICS_TOKEN: 'pass', ORDERING_BASE: OB }, ROOT);
    const r = await M.call(C, null, { method: 'GET', qs: { manufacturer: LINE }, headers: { 'x-analytics-token': 'pass' } });
    eq(r.status, 200, 'status ' + JSON.stringify(r.body).slice(0, 200));
    eq(r.body.products.map(p => [p.code, p.base_price, p.msrp == null ? null : p.msrp, (p.tiers || []).length]), [['A1', 50, 100, 0], ['B1', 50, null, 2], ['B2', 50, null, 2]], 'prices');
  });
  await t('catalog-api: a stripped file with no private row is an unreadable layer (503), never a price-less catalog', async () => {
    const W = world({ file: SPLIT.public });
    const C = M.load('catalog-api.js', W, { ANALYTICS_TOKEN: 'pass', ORDERING_BASE: OB }, ROOT);
    const r = await M.call(C, null, { method: 'GET', qs: { manufacturer: LINE }, headers: { 'x-analytics-token': 'pass' } });
    eq(r.status, 503);
  });
  await t('real Bemis (frozen): stripped file + private row = the priced file, at every quantity, contract and freight', async () => {
    const full = require('./p0-fullfile.js').fullFile('bemis'), s = CC.splitCatalogFile(full);
    const mk = (file, commercial) => world({ file, commercial, extra: { manufacturers: [{ slug: 'bemis', name: 'Bemis' }], manufacturer_meta: [{ slug: 'bemis' }],
      dealer_contract_prices: [{ dealer_id: 'd1', manufacturer: 'bemis', code: full[0].code, price: 1.23, active: true }] } });
    const cart = full.map((p, i) => ({ code: p.code, qty: [1, 2, 6, 11, 21][i % 5] }));
    const o = items => [{ manufacturer_slug: 'bemis', manufacturer_name: 'Bemis', po: 'P', items }];
    const a = await call(orders(mk(full)), { action: 'price_check', orders: o(copy(cart)) });
    const b = await call(orders(mk(s.public, [row('bemis', s.overlay)])), { action: 'price_check', orders: o(copy(cart)) });
    eq(a.status, 200); eq(b.status, 200); eq(b.body.orders, a.body.orders, 'priced orders');
    ok(a.body.orders[0].items.some(i => i.contract === 1.23), 'contract price exercised');
  });
  console.log(`\np0 server: ${pass} passed, ${fail} failed`); process.exitCode = fail ? 1 : 0;
})();
