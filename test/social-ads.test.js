/* Catalog 4 §8 — Social Media Ad Builder. The REAL dealer-ads-api handler against the in-memory PostgREST fake (nothing
   reaches Supabase, the storefront site or a social network). Synthetic data only.
   Checks: only authorized, listed products (discontinued / switched-off / unauthorized lines never); official photo and
   description; the advertised price comes from the storefront rules, never typed; words with prices, discounts, promotions
   or claims are refused; templates take the right number of products; save / reopen / compare-and-set / duplicate /
   archive; company vs branch scope; preview reads only; images only of authorized products and the account's own logo;
   suggestions carry no claim.   node test/social-ads.test.js */
const path = require('path');
const M = require(process.env.MOCK || path.join(__dirname, 'phase0-mock.js'));
const ROOT = process.env.CAT_ROOT || path.join(__dirname, '..', 'netlify', 'functions');
const ADS = require(path.join(ROOT, '_social_ads.js'));
let fail = 0, pass = 0;
async function t(n, f) { try { await f(); pass++; console.log('ok   ' + n); } catch (e) { fail++; console.log('FAIL ' + n + '\n     ' + (e && e.stack || e).toString().split('\n').slice(0, 3).join('\n     ')); } }
const eq = (a, b, w) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((w || '') + ' got ' + JSON.stringify(a) + ' expected ' + JSON.stringify(b)); };
const ok = (c, w) => { if (!c) throw new Error(w); };
const HQ = '11111111-1111-1111-1111-111111111111', BR = '22222222-2222-2222-2222-222222222222', OTHER = '44444444-4444-4444-4444-444444444444';
const CAT = {
  bemis: [{ code: 'B1', name: 'Raised Toilet Seat', category: 'Bath Safety', description: 'Official words', image: '/assets/products/bemis/B1.jpg', price: 55.5, base_price: 55.5, cost: 40, map: 89 },
    { code: 'B3', name: 'Discontinued seat', category: 'Bath Safety', image: '/assets/products/bemis/B3.jpg' },
    { code: 'B4', name: 'Switched off', category: 'Bath Safety' }, { code: 'B7', name: 'Heat Therapy Pad', category: 'Comfort', image: '/assets/products/bemis/B7.jpg', price: 20, base_price: 20 },
    { code: 'B8', name: 'Free-Standing Toilet Rail', category: 'Bath Safety', image: '/assets/products/bemis/B8.jpg', price: 30, base_price: 30 }],
  strongback: [{ code: 'S1', name: 'Comfort Chair', category: 'Wheelchairs', image: '/assets/products/strongback/S1.jpg', price: 300, base_price: 300 }],
  pedifix: [{ code: 'P1', name: 'Not authorized', category: 'Foot', image: '/assets/products/pedifix/P1.jpg' }],
};
function world(o) {
  o = o || {};
  const W = M.createWorld({ tokens: {}, catalog: CAT, missingTables: o.missingTables, tables: {
    dealers: [{ id: HQ, parent_id: null, business_name: 'Acme Medical', address: '1 Main', city: 'Dayton', state: 'OH', zip: '45402', phone: '555-0100', website: 'acme.test', logo_url: o.logo === undefined ? 'https://cdn.acme.test/logo.png' : o.logo },
      { id: BR, parent_id: HQ, business_name: 'Acme Branch', city: 'Xenia', state: 'OH', phone: '555-0200' }, { id: OTHER, parent_id: null, business_name: 'Else' }],
    dealer_users: [{ uid: 'u-hq', status: 'approved', dealer_id: HQ, email: 'hq@acme.test' }, { uid: 'u-br', status: 'approved', dealer_id: BR, email: 'br@acme.test' }, { uid: 'u-ot', status: 'approved', dealer_id: OTHER, email: 'x@else.test' }],
    dealer_user_scope: [], dealer_preview_tokens: [{ token: 'pv', dealer_id: HQ, expires_at: new Date(Date.now() + 600000).toISOString() }],
    dealer_manufacturers: [{ dealer_id: HQ, manufacturer: 'bemis', active: true }, { dealer_id: HQ, manufacturer: 'strongback', active: true }, { dealer_id: HQ, manufacturer: 'pedifix', active: false },
      { dealer_id: BR, manufacturer: 'bemis', active: true }],
    manufacturers: [{ slug: 'bemis', name: 'Bemis' }, { slug: 'strongback', name: 'Strongback' }, { slug: 'pedifix', name: 'PediFix' }],
    manufacturer_meta: [],
    product_content: [],
    product_skus: [{ manufacturer: 'bemis', code: 'B1', msrp: 99.99, msrp_auto: false, status: 'active', base_price: 55.5, map: 79 }, { manufacturer: 'bemis', code: 'B3', msrp: 5, status: 'discontinued' },
      { manufacturer: 'bemis', code: 'B7', msrp: 49, msrp_auto: false, status: 'active', base_price: 20 }, { manufacturer: 'bemis', code: 'B8', msrp: 59, msrp_auto: false, status: 'active', base_price: 30 }],
    product_overrides: [{ manufacturer: 'bemis', code: 'B4', patch: { active: false } }],
    custom_products: [], dealer_contract_prices: [{ dealer_id: HQ, code: 'B1', price: 33.33 }],
    dealer_storefronts: [], dealer_retail_prices: [], dealer_social_ads: o.ads || [],
    app_settings: o.policies ? [{ key: 'advertising_policies', value: { lines: o.policies } }] : [] } });
  const inner = W.fetch; W.images = [];
  W.fetch = async (url, opts) => { const u = String(url); const h = (opts && opts.headers) || {};
    if (u.startsWith(M.BASE + '/auth/v1/user')) { const tok = String(h.Authorization || '').replace(/^Bearer\s+/i, ''); const map = { hq: { id: 'u-hq' }, br: { id: 'u-br' }, ot: { id: 'u-ot' } };
      return map[tok] ? { ok: true, status: 200, json: async () => map[tok] } : { ok: false, status: 401, json: async () => ({}) }; }
    if (/\/assets\/products\/|cdn\.acme\.test/.test(u)) { W.images.push(u); const bytes = Buffer.from('PNGDATA');
      return { ok: true, status: 200, headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'image/png' : null) }, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) }; }
    if (/\/data\/content\//.test(u)) return { ok: false, status: 404, json: async () => null };
    if (opts && opts.method === 'POST' && u.includes('/rest/v1/dealer_social_ads')) { const body = JSON.parse(opts.body); body.id = require('crypto').randomUUID(); body.version = 1; body.archived_at = null; body.updated_at = new Date().toISOString(); opts = Object.assign({}, opts, { body: JSON.stringify(body) }); }
    return inner(url, opts); };
  return W;
}
const DNS = { 'cdn.acme.test': '93.184.216.34', 'evil.test': '10.0.0.5', 'meta.test': '169.254.169.254' };
require('dns').promises.lookup = async (h) => { if (!DNS[h]) throw new Error('ENOTFOUND'); return [{ address: DNS[h], family: 4 }]; };
const api = (W) => M.load('dealer-ads-api.js', W, {}, ROOT);
const as = (C, who, body) => M.call(C, body, { headers: { authorization: 'Bearer ' + who } });
const AD = (x) => Object.assign({ template: 'spotlight', format: 'square', font: 'Inter', colors: { bg: '#0b1f33', accent: '#ef6325', text: '#ffffff' }, title: 'Seat ad',
  headline: 'Feel steadier at home', body: 'See it at our Dayton showroom.', cta: 'Visit us today', caption: 'Now at Acme Medical.', hashtags: ['BathSafety'], products: [{ manufacturer: 'bemis', code: 'B1' }] }, x || {});

(async () => {
  await t('context: only authorized, listed products with the official photo, description and the advertised price — never cost, MAP or a contract price', async () => {
    const r = await as(api(world()), 'hq', { action: 'ads_context' }); eq(r.status, 200);
    const codes = r.body.products.map((p) => p.code).sort(); eq(codes, ['B1', 'B7', 'B8', 'S1'], 'discontinued B3, switched-off B4, inactive PediFix never');
    const b1 = r.body.products.find((p) => p.code === 'B1');
    eq([b1.name, b1.description, b1.image], ['Raised Toilet Seat', 'Official words', '/assets/products/bemis/B1.jpg']);
    const s = JSON.stringify(r.body); ok(!/33\.33|"cost"|"map"/.test(s), 'no contract price, cost or MAP');
    eq([r.body.dealer.name, r.body.dealer.phone, r.body.dealer.website, r.body.dealer.has_logo], ['Acme Medical', '555-0100', 'https://acme.test', true]);
    ok(!('_logo' in r.body.dealer), 'logo URL not sent'); eq(r.body.publishing.enabled, false);
    eq(r.body.locations.map((l) => l.id).sort(), [HQ, BR].sort());
  });
  await t('the price on an ad is the storefront\'s advertised price: "Call for Price" when the line\'s rule shows none', async () => {
    const W = world({ policies: { bemis: 'no_price' } });
    const r = await as(api(W), 'hq', { action: 'ads_context' }); const b1 = r.body.products.find((p) => p.code === 'B1');
    eq([b1.price, b1.price_label], [null, 'Call for Price']);
  });
  await t('save → reopen → compare-and-set → duplicate → archive', async () => {
    const W = world(); const C = api(W);
    const s = await as(C, 'hq', { action: 'ads_save', location_id: HQ, ad: AD() }); eq(s.status, 200); const id = s.body.row.id;
    const hid = await as(C, 'hq', { action: 'ads_save', location_id: HQ, ad: AD({ products: [{ manufacturer: 'bemis', code: 'B1', show_price: false }] }) });
    const hg = await as(C, 'hq', { action: 'ads_get', id: hid.body.row.id }); eq([hg.body.products[0].price, hg.body.products[0].price_label], [null, null], 'price hidden by the dealer');
    const g = await as(C, 'hq', { action: 'ads_get', id }); eq([g.status, g.body.ad.headline, g.body.products[0].code, g.body.problems.length], [200, 'Feel steadier at home', 'B1', 0]);
    const u = await as(C, 'hq', { action: 'ads_save', id, version: 1, location_id: HQ, ad: AD({ headline: 'New words' }) }); eq([u.status, u.body.row.version], [200, 2]);
    const stale = await as(C, 'hq', { action: 'ads_save', id, version: 1, location_id: HQ, ad: AD() }); eq(stale.status, 409);
    const d = await as(C, 'hq', { action: 'ads_duplicate', id }); eq(d.status, 200); ok(/\(copy\)$/.test(d.body.row.title), 'copy title');
    const L = await as(C, 'hq', { action: 'ads_list' }); eq(L.body.ads.length, 3);
    eq((await as(C, 'hq', { action: 'ads_archive', id })).status, 200);
    eq((await as(C, 'hq', { action: 'ads_list' })).body.ads.length, 2); eq((await as(C, 'hq', { action: 'ads_get', id })).status, 404);
  });
  await t('words with a price, discount, promotion or claim are refused; a product\'s official name is not a claim', async () => {
    const C = api(world());
    for (const [f, v] of [['headline', 'Only $49 today'], ['body', 'Save 20% this week'], ['cta', 'Free delivery'], ['caption', 'Medicare covered'], ['body', 'Clinically proven to prevent falls'], ['headline', 'Lowest price in town']]) {
      const r = await as(C, 'hq', { action: 'ads_save', location_id: HQ, ad: AD({ [f]: v }) }); eq([r.status, r.body.field], [400, f], v);
    }
    const okName = await as(C, 'hq', { action: 'ads_save', location_id: HQ, ad: AD({ products: [{ manufacturer: 'bemis', code: 'B8' }], headline: 'Free-Standing Toilet Rail now in stock' }) });
    eq(okName.status, 200, 'official product name allowed');
    eq((await as(C, 'hq', { action: 'ads_save', location_id: HQ, ad: AD({ hashtags: ['SaleToday'] }) })).status, 400, 'promo hashtag');
    for (const v of ['Only 199.99', 'Was 499 now 399', 'Half price seats', 'Two for one', 'Complimentary fitting', 'No charge delivery', 'Reduced prices', '＄99 seat', 'Fr\u200bee delivery', 'Fr\u00adee delivery'])
      eq((await as(C, 'hq', { action: 'ads_save', location_id: HQ, ad: AD({ body: v }) })).status, 400, v);
    for (const h of ['freeshipping', 'onsale', '50off', 'lowprices', 'medicarecovered'])
      eq((await as(C, 'hq', { action: 'ads_save', location_id: HQ, ad: AD({ hashtags: [h] }) })).status, 400, '#' + h);
    eq((await as(C, 'hq', { action: 'ads_save', location_id: HQ, ad: AD({ hashtags: ['Dayton', 'AcmeMedical', 'BathSafety', 'HomeMedicalDealer'] }) })).status, 200, 'names on record');
    eq((await as(C, 'preview:pv', { action: 'ads_check', location_id: HQ, ad: AD({ body: 'Save 20%' }) })).status, 400, 'download gate refuses');
    const ck = await as(C, 'preview:pv', { action: 'ads_check', location_id: HQ, ad: AD() }); eq([ck.status, ck.body.products[0].code], [200, 'B1'], 'download gate passes clean words');
  });
  await t('only authorized products; template product counts enforced', async () => {
    const C = api(world());
    eq((await as(C, 'hq', { action: 'ads_save', location_id: HQ, ad: AD({ products: [{ manufacturer: 'pedifix', code: 'P1' }] }) })).status, 400, 'inactive line');
    eq((await as(C, 'hq', { action: 'ads_save', location_id: HQ, ad: AD({ products: [{ manufacturer: 'bemis', code: 'B3' }] }) })).status, 400, 'discontinued');
    eq((await as(C, 'br', { action: 'ads_save', location_id: BR, ad: AD({ products: [{ manufacturer: 'strongback', code: 'S1' }] }) })).status, 400, 'a branch without the line');
    eq((await as(C, 'hq', { action: 'ads_save', location_id: HQ, ad: AD({ template: 'grid' }) })).status, 400, 'grid needs 2–4');
    eq((await as(C, 'hq', { action: 'ads_save', location_id: HQ, ad: AD({ template: 'grid', products: [{ manufacturer: 'bemis', code: 'B1' }, { manufacturer: 'strongback', code: 'S1' }] }) })).status, 200);
    eq((await as(C, 'hq', { action: 'ads_save', location_id: HQ, ad: AD({ template: 'brand', products: [], headline: 'Your local home medical store' }) })).status, 200, 'general ad');
    eq((await as(C, 'hq', { action: 'ads_save', location_id: HQ, ad: AD({ format: 'banner' }) })).status, 400);
    eq((await as(C, 'hq', { action: 'ads_save', location_id: HQ, ad: AD({ colors: { bg: 'red' } }) })).status, 400);
  });
  await t('a product no longer authorized shows as a problem on reopen (never silently priced)', async () => {
    const W = world(); const C = api(W);
    const s = await as(C, 'hq', { action: 'ads_save', location_id: HQ, ad: AD({ products: [{ manufacturer: 'strongback', code: 'S1' }] }) });
    W.db.dealer_manufacturers.find((x) => x.manufacturer === 'strongback').active = false;
    const g = await as(api(W), 'hq', { action: 'ads_get', id: s.body.row.id }); eq([g.body.products.length, g.body.problems.length], [0, 1]);
  });
  await t('scope: a branch sees only its own ads; another company nothing; a preview only reads', async () => {
    const W = world(); const C = api(W);
    const s = await as(C, 'hq', { action: 'ads_save', location_id: HQ, ad: AD() });
    eq((await as(C, 'br', { action: 'ads_get', id: s.body.row.id })).status, 404);
    eq((await as(C, 'ot', { action: 'ads_get', id: s.body.row.id })).status, 404);
    eq((await as(C, 'br', { action: 'ads_save', location_id: HQ, ad: AD() })).status, 404);
    eq((await as(C, 'hq', { action: 'ads_save', location_id: BR, ad: AD() })).status, 200, 'head office makes branch ads');
    eq((await as(C, 'preview:pv', { action: 'ads_save', location_id: HQ, ad: AD() })).status, 403);
    eq((await as(C, 'preview:pv', { action: 'ads_list' })).status, 200);
    eq((await as(C, 'nobody', { action: 'ads_list' })).status, 401);
  });
  await t('images: an authorized product\'s photo or the account\'s own logo, fetched by the server; never another product', async () => {
    const W = world(); const C = api(W);
    const p = await as(C, 'hq', { action: 'ad_image', location_id: HQ, manufacturer: 'bemis', code: 'B1' }); eq(p.status, 200); ok(/^data:image\/png;base64,/.test(p.body.data_url));
    ok(W.images[0].endsWith('/assets/products/bemis/B1.jpg'));
    eq((await as(C, 'hq', { action: 'ad_image', location_id: HQ, manufacturer: 'pedifix', code: 'P1' })).status, 404);
    const typed = await as(C, 'hq', { action: 'ad_image', location_id: HQ, manufacturer: 'bemis', code: 'B1', url: 'https://evil.test/x.png' });
    eq(typed.status, 200); ok(W.images.every((u) => !/evil/.test(u)) && W.images[W.images.length - 1].endsWith('/B1.jpg'), 'a typed URL is never fetched');
    eq((await as(C, 'hq', { action: 'ad_image', location_id: HQ, logo: true })).status, 200);
    eq((await as(api(world({ logo: 'http://169.254.169.254/x' })), 'hq', { action: 'ad_image', location_id: HQ, logo: true })).status, 404, 'no plain-http / internal fetch');
    for (const bad of ['https://evil.test/x.png', 'https://meta.test/x.png', 'https://localhost./x.png', 'https://cdn.acme.test:8443/x.png', 'https://unknown.test/x.png']) {
      const W2 = world({ logo: bad }); eq((await as(api(W2), 'hq', { action: 'ad_image', location_id: HQ, logo: true })).status, 404, bad); ok(!W2.images.length, 'never fetched: ' + bad); }
    eq((await as(C, 'hq', { action: 'ad_image', location_id: OTHER, logo: true })).status, 404);
  });
  await t('suggestions use names on record only and never carry a claim', async () => {
    const r = await as(api(world()), 'hq', { action: 'ads_suggest', location_id: HQ, products: [{ manufacturer: 'bemis', code: 'B7' }, { manufacturer: 'strongback', code: 'S1' }] });
    eq(r.status, 200); ok(r.body.captions.length === 3, 'three captions'); ok(r.body.captions.every((c) => /Heat Therapy Pad/.test(c)), 'product names');
    for (const c of r.body.captions) ok(!ADS.claimProblem(c, ['Heat Therapy Pad', 'Acme Medical', 'Dayton']), c);
    ok(r.body.hashtags.includes('Wheelchairs') && r.body.hashtags.includes('Dayton'), JSON.stringify(r.body.hashtags));
  });
  await t('review #115: a copy is checked for its own location; an HCPS-blocked storefront pauses ads', async () => {
    const W = world(); const C = api(W);
    const s = await as(C, 'hq', { action: 'ads_save', location_id: HQ, ad: AD({ products: [{ manufacturer: 'strongback', code: 'S1' }], headline: 'Comfort at Acme Medical' }) });
    const d = await as(C, 'hq', { action: 'ads_duplicate', id: s.body.row.id, location_id: BR }); eq(d.status, 400, 'branch has no Strongback: a one-product ad with no product is refused');
    const W2 = world(); W2.db.dealer_storefronts.push({ id: 'sf1', dealer_id: HQ, company_id: HQ, slug: 'acme', enabled: true, hcps_blocked: true, lines: null, hidden_categories: [], price_mode: 'msrp' });
    const C2 = api(W2); const cx = await as(C2, 'hq', { action: 'ads_context' }); eq([cx.body.blocked, cx.body.can_edit], [true, false]);
    eq((await as(C2, 'hq', { action: 'ads_check', location_id: HQ, ad: AD() })).status, 423);
    eq((await as(C2, 'hq', { action: 'ads_save', location_id: HQ, ad: AD() })).status, 423);
  });
  await t('the table not yet installed: saving says so, designing still works', async () => {
    const W = world({ missingTables: ['dealer_social_ads'] }); const C = api(W);
    eq((await as(C, 'hq', { action: 'ads_context' })).status, 200);
    const r = await as(C, 'hq', { action: 'ads_save', location_id: HQ, ad: AD() }); eq(r.status, 503); ok(/opens shortly/.test(r.body.error));
  });
  console.log(`\nsocial ads: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
