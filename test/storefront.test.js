/* C3-07 Stage 7 — dealer-branded public storefronts. Runs the REAL dealer-storefront-api and storefront-public handlers
   against the in-memory PostgREST fake (nothing reaches Supabase, the storefront site or an email provider). Synthetic data.
   Checks: D2 access (head office manages its locations, a branch only itself, a preview only reads, another company never);
   settings validated (address rules, reserved / taken addresses, only authorized lines, HCPS's block can't be cleared,
   compare-and-set); D3 public prices (verified MSRP only — an HCPS-derived MSRP, wholesale, tiers, MAP, contract prices never;
   "Call for Price" mode; discontinued / switched-off products and hidden categories left out; Golden, retired and turned-off
   lines never shown); a storefront that is off or blocked is "not available"; D4 anonymous counts (only this storefront's
   products, ≤40) and inquiries (validated, honeypot, consent, limits, stored without visitor data, emailed to the dealer with
   the customer as reply-to and escaped, kept 24 months, dealer marks handled / deletes; an email failure never loses one);
   strict reads (503).
     node test/storefront.test.js */
const path = require('path');
const M = require(process.env.MOCK || path.join(__dirname, 'phase0-mock.js'));
const ROOT = process.env.CAT_ROOT || path.join(__dirname, '..', 'netlify', 'functions');
const SF = require(path.join(ROOT, '_storefront.js'));
let fail = 0, pass = 0;
async function t(n, f) { try { await f(); pass++; console.log('ok   ' + n); } catch (e) { fail++; console.log('FAIL ' + n + '\n     ' + (e && e.stack || e).toString().split('\n').slice(0, 3).join('\n     ')); } }
const eq = (a, b, w) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((w || '') + ' got ' + JSON.stringify(a) + ' expected ' + JSON.stringify(b)); };
const ok = (c, w) => { if (!c) throw new Error(w); };
const HQ = '11111111-1111-1111-1111-111111111111', BR = '22222222-2222-2222-2222-222222222222', OTHER = '44444444-4444-4444-4444-444444444444';
const CAT = { bemis: [{ code: 'B1', name: 'Raised seat <script>', category: 'Bath Safety', description: 'Nice', image: '/assets/products/bemis/B1.jpg', price: 55.5, base_price: 55.5, cost: 40, tiers: [{ min: 2, price: 50 }], attributes: { Width: '18"' } },
  { code: 'B2', name: 'Derived', category: 'Bath Safety', image: 'javascript:alert(1)' }, { code: 'B3', name: 'Discontinued', category: 'Bath Safety' }, { code: 'B4', name: 'Switched off', category: 'Bath Safety' },
  { code: 'B5', name: 'Hidden cat', category: 'Parts' }, { code: 'B6', name: 'Edit MSRP', category: 'Bath Safety' }],
  strongback: [{ code: 'S1', name: 'Chair', category: 'Wheelchairs' }], 'golden-technologies': [{ code: 'G1', name: 'Lift chair', category: 'Lift Chairs' }], 'ohio-medical': [{ code: 'O1', name: 'Old', category: 'Oxygen' }], gce: [{ code: 'O1', name: 'Old', category: 'Oxygen' }], dalton: [{ code: 'D1', name: 'Off line', category: 'X' }] };

function world(o) {
  o = o || {};
  const W = M.createWorld({ tokens: {}, failRead: o.failRead, missingTables: o.missingTables, catalog: CAT, tables: {
    dealers: [{ id: HQ, parent_id: null, business_name: 'Acme Medical', address: '1 Main', city: 'Dayton', state: 'OH', zip: '45402', email: 'hq@acme.test', phone: '555-0100', logo_url: o.logo || 'https://acme.test/logo.png', active: o.hqActive },
      { id: BR, parent_id: HQ, business_name: 'Acme Branch', city: 'Xenia', state: 'OH', email: 'br@acme.test', phone: '555-0200', active: o.brActive }, { id: OTHER, parent_id: null, business_name: 'Else' }],
    dealer_users: [{ uid: 'u-hq', status: 'approved', dealer_id: HQ, email: 'hq@acme.test' }, { uid: 'u-br', status: 'approved', dealer_id: BR, email: 'br@acme.test' }, { uid: 'u-ot', status: 'approved', dealer_id: OTHER, email: 'x@else.test' }],
    dealer_user_scope: [], dealer_preview_tokens: [{ token: 'pv', dealer_id: HQ, expires_at: new Date(Date.now() + 600000).toISOString() }],
    dealer_manufacturers: ['bemis', 'strongback', 'golden-technologies', 'ohio-medical', 'dalton'].map((m) => ({ dealer_id: HQ, manufacturer: m, active: true, account_ref: 'SYN-1' }))
      .concat([{ dealer_id: BR, manufacturer: 'bemis', active: true }, { dealer_id: HQ, manufacturer: 'pedifix', active: false }]),
    manufacturers: [{ slug: 'bemis', name: 'Bemis' }, { slug: 'strongback', name: 'Strongback' }, { slug: 'golden-technologies', name: 'Golden' }, { slug: 'dalton', name: 'Dalton' }],
    manufacturer_meta: [{ slug: 'dalton', active: false }].concat(o.meta || []),
    product_content: o.pages || [],
    product_skus: [{ manufacturer: 'bemis', code: 'B1', msrp: 99.99, msrp_auto: false, status: 'active', base_price: 55.5, map: 79 }, { manufacturer: 'bemis', code: 'B2', msrp: 20, msrp_auto: true, status: 'active', base_price: 10 },
      { manufacturer: 'bemis', code: 'B3', msrp: 5, status: 'discontinued' }],
    product_overrides: [{ manufacturer: 'bemis', code: 'B4', patch: { active: false } }, { manufacturer: 'bemis', code: 'B6', patch: { msrp: 61.25, base_price: 30 } }],
    custom_products: [], dealer_contract_prices: [{ dealer_id: HQ, code: 'B1', price: 33.33 }],
    dealer_storefronts: o.storefronts || [], storefront_inquiries: o.inquiries || [] } });
  const inner = W.fetch; W.counts = []; W.mail = []; W.adds = [];
  W.fetch = async (url, opts) => { const u = String(url); const h = (opts && opts.headers) || {};
    if (u.startsWith(M.BASE + '/auth/v1/user')) { const tok = String(h.Authorization || '').replace(/^Bearer\s+/i, ''); const map = { hq: { id: 'u-hq' }, br: { id: 'u-br' }, ot: { id: 'u-ot' } };
      return map[tok] ? { ok: true, status: 200, json: async () => map[tok] } : { ok: false, status: 401, json: async () => ({}) }; }
    if (u.startsWith(M.BASE + '/rest/v1/rpc/storefront_count')) { W.counts.push(JSON.parse(opts.body)); return { ok: true, status: 200, text: async () => '1', json: async () => 1 }; }
    if (u.startsWith(M.BASE + '/rest/v1/rpc/storefront_inquiry_add')) {   // the limits themselves are proven in storefront.pg.test.js
      const a = JSON.parse(opts.body); W.adds.push(a); const sf = W.db.dealer_storefronts.find((x) => x.id === a.p_storefront);
      const res = !sf || !sf.enabled || sf.hcps_blocked ? { refused: 'unavailable' } : o.refuse ? { refused: o.refuse } : null;
      if (res) return { ok: true, status: 200, text: async () => JSON.stringify(res) };
      const id = 'iiiiiiii-iiii-iiii-iiii-' + String(W.db.storefront_inquiries.length).padStart(12, '0');
      const r = a.p_row; W.db.storefront_inquiries.push({ id, storefront_id: sf.id, dealer_id: sf.dealer_id, name: r.name, email: r.email, phone: r.phone, message: r.message, manufacturer: r.manufacturer, product_code: r.product_code, product_name: r.product_name, notified: false });
      if (r.manufacturer) W.counts.push({ p_kind: 'inquiry', code: r.product_code });
      const send = !!sf.email && !o.noSend; return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, id, send, to: send ? sf.email : null }) }; }
    if (h.Prefer === 'count=exact') { const r = await inner(u, { method: 'GET', headers: { apikey: 'svc' } }); const rows = await r.json(); return { ok: true, status: 206, headers: { get: () => '0-0/' + rows.length }, text: async () => '[]' }; }
    if (u.includes('api.resend.com')) { const b = JSON.parse(opts.body); W.mail.push(b); if (o.mailFails) return { ok: false, status: 500, text: async () => 'no' }; return { ok: true, status: 200, text: async () => '{"id":"m1"}', json: async () => ({ id: 'm1' }) }; }
    return inner(url, opts); };
  return W;
}
const dealerApi = (W, env) => M.load('dealer-storefront-api.js', W, env, ROOT);
const pubApi = (W, env) => M.load('storefront-public.js', W, Object.assign({ RESEND_API_KEY: 're_test', HCPS_MAIL_FROM: 'HCPS <orders@hcps.test>' }, env || {}), ROOT);
const as = (C, who, body) => M.call(C, body, { headers: { authorization: 'Bearer ' + who } });
const pubGet = async (C, s) => { const r = await C.handler({ httpMethod: 'GET', headers: {}, queryStringParameters: { s }, body: '' }); return { status: r.statusCode, body: JSON.parse(r.body), headers: r.headers }; };
const pubPost = (C, b, ip) => M.call(C, b, { headers: ip ? { 'x-nf-client-connection-ip': ip } : {} });
const live = (x) => Object.assign({ id: 'sf-hq', dealer_id: HQ, company_id: HQ, slug: 'acme-medical', enabled: true, hcps_blocked: false, headline: 'Welcome', about: null, phone: '555-0199', email: 'shop@acme.test', hours: null, show_address: true, lines: null, hidden_categories: ['Parts'], price_mode: 'msrp', version: 1 }, x || {});

(async () => {
  await t('sf_get: head office sees its locations with only authorized, active, non-retired, non-Golden lines; a branch only itself', async () => {
    const W = world(); const r = await as(dealerApi(W), 'hq', { action: 'sf_get' });
    eq(r.status, 200); eq(r.body.locations.map((l) => [l.name, l.can_edit, l.lines.map((x) => x.slug)]), [['Acme Medical', true, ['bemis', 'strongback']], ['Acme Branch', true, ['bemis']]]);
    eq(r.body.locations[0].suggested_slug, 'acme-medical-dayton');
    const b = await as(dealerApi(W), 'br', { action: 'sf_get' }); eq(b.body.locations.map((l) => l.name), ['Acme Branch']);
    eq((await as(dealerApi(W), 'nobody', { action: 'sf_get' })).status, 401);
  });
  await t('sf_save: creates with a valid address; reserved / malformed / taken addresses and unauthorized lines refused; HCPS block ignored', async () => {
    const W = world({ storefronts: [live({ id: 'sf-other', dealer_id: OTHER, company_id: OTHER, slug: 'taken-name' })] }); const C = dealerApi(W);
    eq((await as(C, 'hq', { action: 'sf_save', location_id: HQ, settings: { slug: 'admin' } })).status, 400);
    eq((await as(C, 'hq', { action: 'sf_save', location_id: HQ, settings: { slug: '-bad-' } })).status, 400);
    eq((await as(C, 'hq', { action: 'sf_save', location_id: HQ, settings: { slug: 'taken-name' } })).status, 409);
    eq((await as(C, 'hq', { action: 'sf_save', location_id: HQ, settings: { slug: 'acme', lines: ['golden-technologies'] } })).status, 400);
    eq((await as(C, 'hq', { action: 'sf_save', location_id: HQ, settings: { headline: 'x' } })).status, 400, 'no address yet');
    const r = await as(C, 'hq', { action: 'sf_save', location_id: HQ, settings: { slug: 'acme', enabled: true, hcps_blocked: false, email: 'Shop@Acme.test', lines: ['bemis'], price_mode: 'call' } });
    eq(r.status, 200); eq([r.body.storefront.slug, r.body.storefront.enabled, r.body.storefront.email, r.body.storefront.lines, r.body.storefront.price_mode, r.body.storefront.company_id, 'hcps_blocked' in W.db.dealer_storefronts[1] ? W.db.dealer_storefronts[1].hcps_blocked : undefined], ['acme', true, 'shop@acme.test', ['bemis'], 'call', HQ, undefined]);
    ok(/\/store\/acme$/.test(r.body.link), 'link');
    eq((await as(C, 'hq', { action: 'sf_save', location_id: HQ, version: 99, settings: { headline: 'y' } })).status, 409, 'stale version');
    eq((await as(C, 'hq', { action: 'sf_save', location_id: HQ, version: 1, settings: { email: 'a@b.c, d@e.f' } })).status, 400, 'one address');
  });
  await t('D2: a branch can\'t change its head office\'s storefront; a head office can change a branch\'s; another company never; a preview only reads', async () => {
    const W = world(); const C = dealerApi(W);
    eq((await as(C, 'br', { action: 'sf_save', location_id: HQ, settings: { slug: 'nope' } })).status, 404);
    eq((await as(C, 'hq', { action: 'sf_save', location_id: BR, settings: { slug: 'acme-xenia' } })).status, 200);
    eq((await as(C, 'ot', { action: 'sf_save', location_id: HQ, settings: { slug: 'steal' } })).status, 404);
    eq((await as(C, 'preview:pv', { action: 'sf_save', location_id: HQ, settings: { slug: 'pv' } })).status, 403);
    eq((await as(C, 'preview:pv', { action: 'sf_get' })).status, 200);
  });
  await t('public page: off or blocked → not available; on → the dealer\'s public details only', async () => {
    eq((await pubGet(pubApi(world({ storefronts: [live({ enabled: false })] })), 'acme-medical')).status, 404);
    eq((await pubGet(pubApi(world({ storefronts: [live({ hcps_blocked: true })] })), 'acme-medical')).status, 404);
    eq((await pubGet(pubApi(world()), 'acme-medical')).status, 404);
    const r = await pubGet(pubApi(world({ storefronts: [live()] })), 'acme-medical');
    eq(r.status, 200); eq([r.body.dealer.name, r.body.dealer.phone, r.body.dealer.email, r.body.dealer.address.city, r.body.dealer.logo], ['Acme Medical', '555-0199', 'shop@acme.test', 'Dayton', null], 'third-party logo never shown');
    const n = await pubGet(pubApi(world({ storefronts: [live({ phone: null, email: null })] })), 'acme-medical');
    eq([n.body.dealer.phone, n.body.dealer.email], ['', ''], 'the account\'s own email / phone never become public');
    const lg = await pubGet(pubApi(world({ storefronts: [live()], logo: M.BASE + '/storage/v1/object/public/dealer-logos/acme.png' })), 'acme-medical'); eq(lg.body.dealer.logo, M.BASE + '/storage/v1/object/public/dealer-logos/acme.png');
    eq((await pubGet(pubApi(world({ storefronts: [live()], hqActive: false })), 'acme-medical')).status, 404, 'closed location');
    eq((await pubGet(pubApi(world({ storefronts: [live({ id: 'sf-br', dealer_id: BR, slug: 'acme-xenia' })], hqActive: false })), 'acme-xenia')).status, 404, 'branch of a closed head office');
    eq((await pubGet(pubApi(world({ storefronts: [live({ id: 'sf-br', dealer_id: BR, slug: 'acme-xenia' })] })), 'acme-xenia')).status, 200);
    eq(r.body.lines.map((l) => l.slug), ['bemis', 'strongback'], 'Golden, retired, switched-off line never');
  });
  await t('D3: verified MSRP or Call for Price only — derived MSRP, wholesale, tiers, MAP, contract prices never public; hidden products and categories left out', async () => {
    const r = await pubGet(pubApi(world({ storefronts: [live()] })), 'acme-medical'); const P = r.body.products.filter((p) => p.manufacturer === 'bemis');
    eq(P.map((p) => [p.code, p.price, p.price_label]), [['B1', 99.99, 'MSRP'], ['B2', null, 'Call for Price'], ['B6', 61.25, 'MSRP']]);
    eq(Object.keys(P[0]).sort(), ['attributes', 'brand', 'category', 'code', 'description', 'image', 'manufacturer', 'name', 'price', 'price_label', 'price_unit', 'subcategory', 'uom']);
    eq([P[0].image, P[1].image], ['/assets/products/bemis/B1.jpg', null], 'unsafe image dropped');
    const s = JSON.stringify(r.body); ok(!/55\.5|33\.33|"cost"|tiers|base_price|"map"|79|SYN-1|Else/.test(s), 'no wholesale / contract / MAP / account / other dealer data');
    const c = await pubGet(pubApi(world({ storefronts: [live({ price_mode: 'call' })] })), 'acme-medical'); ok(c.body.products.every((p) => p.price === null && p.price_label === 'Call for Price'), 'call mode');
    const l = await pubGet(pubApi(world({ storefronts: [live({ lines: ['strongback'] })] })), 'acme-medical'); eq(l.body.lines.map((x) => x.slug), ['strongback']);
  });
  await t('D3: discontinued / hidden / switched-off enrichment pages and SKUs never public; enriched-only lines show only published pages; pack MSRP names its unit', async () => {
    const pages = [{ manufacturer: 'bemis', page_key: 'p1', status: 'discontinued', skus: [{ sku: 'b1' }] }, { manufacturer: 'bemis', page_key: 'p2', status: 'published', skus: [{ sku: 'B2', status: 'hidden' }, { sku: 'B6' }] },
      { manufacturer: 'bemis', page_key: 'p3', status: 'hidden', disabled: true, skus: [{ sku: 'B6', status: 'hidden' }] },
      { manufacturer: 'strongback', page_key: 's1', status: 'published', disabled: true, skus: [{ code: 'S1', disabled: true }] }];
    const r = await pubGet(pubApi(world({ storefronts: [live()], pages })), 'acme-medical');
    eq(r.body.products.map((p) => p.code), ['B6', 'S1'], 'B1 (page discontinued, lower-case) and B2 (SKU hidden) gone; a hidden or switched-off page is ignored as the dealer shop ignores it (B6, S1 stay)');
    const e = await pubGet(pubApi(world({ storefronts: [live()], meta: [{ slug: 'bemis', enriched_only: true }], pages: [{ manufacturer: 'bemis', page_key: 'p', status: 'published', skus: [{ sku: 'B6' }] }, { manufacturer: 'bemis', page_key: 'd', status: 'pending_review', skus: [{ sku: 'B1' }] }] })), 'acme-medical');
    eq(e.body.products.filter((p) => p.manufacturer === 'bemis').map((p) => p.code), ['B6'], 'enriched-only: a draft page is not enough');
    eq([SF.unitOf({ uom: '12-roll pack', case_qty: 12 }), SF.unitOf({ uom: 'Case', case_qty: 2 }), SF.unitOf({ uom: 'Each' }), SF.unitOf({ case_qty: 4 })], ['per 12-roll pack', 'per Case (2 each)', null, 'per pack of 4']);
    eq([SF.unitOf({ uom: '2/CS' }, { uom: 'Case', case_qty: 2, msrp_basis: 'each' }), SF.unitOf({ uom: 'Case', case_qty: 2, msrp_each: true }), SF.unitOf({ uom: 'Case', msrp_each: true }, { msrp_basis: 'order_unit', case_qty: 3 }), SF.unitOf({}, { uom: 'Each', case_qty: 1, msrp_basis: 'each' })],
      ['each', 'each', 'per Case (3 each)', null], 'Phase 4 basis: Bemis MSRP is per piece; the record\'s unit wins');
    eq([SF.publicProduct({ code: 'X', image: 'https://maker.example/x.jpg' }, 'bemis', { msrp: new Map() }, 'msrp').image, SF.publicProduct({ code: 'X', image: '/assets/p/x.jpg' }, 'bemis', { msrp: new Map() }, 'msrp').image], [null, '/assets/p/x.jpg'], 'third-party photo hosts never');
  });
  await t('D4 counts: only products this storefront shows, at most 40, nothing about the visitor', async () => {
    const W = world({ storefronts: [live()] }); const C = pubApi(W);
    await pubPost(C, { action: 'view', s: 'acme-medical', items: [{ manufacturer: 'bemis', code: 'B1' }, { manufacturer: 'bemis', code: 'B4' }, { manufacturer: 'golden-technologies', code: 'G1' }].concat(Array.from({ length: 50 }, () => ({ manufacturer: 'bemis', code: 'B1' }))) });
    eq(W.counts.length, 1); ok(W.counts[0].p_items.length <= 40 && W.counts[0].p_items.every((i) => i.code === 'B1' && i.category === 'Bath Safety'), JSON.stringify(W.counts[0].p_items.slice(0, 3)));
    eq(Object.keys(W.counts[0]).sort(), ['p_client', 'p_dealer', 'p_items']); eq(W.counts[0].p_items.length, 1, 'duplicates collapse');
    ok(!JSON.stringify(W.counts).includes('203.0.113'), 'no address');
    await pubPost(C, { action: 'view', s: 'acme-medical', items: [{ manufacturer: ['bemis'], code: 'B1' }, null, 5, { manufacturer: 'bemis', code: 'B1' }] }, '203.0.113.9');
    const last = W.counts[W.counts.length - 1]; eq(last.p_items.length, 1, 'malformed items skipped, no crash'); ok(/^[0-9a-f]{32}$/.test(last.p_client), 'keyed hash of the address');
    ok(!JSON.stringify(last).includes('203.0.113'), 'the address itself never sent');
    const k = (ip) => C._test.clientKey({ headers: { 'x-nf-client-connection-ip': ip } });
    eq([k('2001:db8:1:2:aaaa::1') === k('2001:0db8:0001:0002:ffff:1:2:3'), k('2001:db8:1:3::1') === k('2001:db8:1:2::1'), k('203.0.113.9') === k('203.0.113.10'), k('203.0.113.9') === k('203.0.113.9')], [true, false, false, true], 'IPv6 keyed by /64, IPv4 by address');
  });
  await t('inquiry: validated, consent required, honeypot silently dropped, stored with only what was typed, emailed to the dealer (reply-to customer, escaped)', async () => {
    const W = world({ storefronts: [live({ email: 'shop@acme.test' })] }); const C = pubApi(W);
    eq((await pubPost(C, { action: 'inquiry', s: 'acme-medical', name: '', email: 'a@b.co', consent: true })).status, 400);
    eq((await pubPost(C, { action: 'inquiry', s: 'acme-medical', name: 'Pat' , consent: true })).status, 400, 'needs email or phone');
    eq((await pubPost(C, { action: 'inquiry', s: 'acme-medical', name: 'Pat', email: 'a@b.co' })).status, 400, 'consent');
    eq((await pubPost(C, { action: 'inquiry', s: 'acme-medical', name: 'Bot', email: 'a@b.co', consent: true, hp: 'x' })).status, 200); eq(W.db.storefront_inquiries.length, 0, 'honeypot not stored');
    const r = await pubPost(C, { action: 'inquiry', s: 'acme-medical', name: 'Pat <b>', email: 'Pat@Example.com', phone: '555 0100', message: 'Do you have <img src=x> in stock?', consent: true, product: { manufacturer: 'bemis', code: 'B1', name: 'FREE\r\nBcc: x@evil.test' } });
    eq(r.status, 200); const row = W.db.storefront_inquiries[0];
    eq([row.dealer_id, row.email, row.product_code, row.product_name, row.status || 'new', row.notified], [HQ, 'pat@example.com', 'B1', 'Raised seat <script>', 'new', true], 'product name from the catalog, not the visitor');
    ok(!/[\r\n]/.test(W.mail[0].subject) && !/evil/.test(W.mail[0].subject), 'subject has no visitor line breaks');
    ok(!('ip' in row) && !('user_agent' in row), 'no visitor data'); eq(W.mail.length, 1); eq([W.mail[0].to, W.mail[0].reply_to], [['shop@acme.test'], 'pat@example.com']);
    ok(/Pat &lt;b&gt;/.test(W.mail[0].html) && !/<img src=x>/.test(W.mail[0].html), 'escaped'); eq(W.counts.pop().p_kind, 'inquiry'); eq(W.adds[0].p_client, 'none', 'no address header → shared bucket');
    await pubPost(C, { action: 'inquiry', s: 'acme-medical', name: 'Pat', phone: '5550100', consent: true, product: { manufacturer: 'golden-technologies', code: 'G1', name: 'x' } });
    eq(W.db.storefront_inquiries[1].product_code, null, 'a product this storefront doesn\'t show is dropped');
  });
  await t('inquiry limits come from the database call: refusals become 429 / 404; a switched-off storefront refuses at once; an email failure keeps the request', async () => {
    eq((await pubPost(pubApi(world({ storefronts: [live()], refuse: 'contact' })), { action: 'inquiry', s: 'acme-medical', name: 'Pat', email: 'p@x.co', consent: true })).status, 429);
    eq((await pubPost(pubApi(world({ storefronts: [live()], refuse: 'client' })), { action: 'inquiry', s: 'acme-medical', name: 'Pat', email: 'p@x.co', consent: true })).status, 429);
    const W = world({ storefronts: [live()] }); const C = pubApi(W); eq((await pubGet(C, 'acme-medical')).status, 200);
    W.db.dealer_storefronts[0].enabled = false;     // switched off after the page was cached
    eq((await pubPost(C, { action: 'inquiry', s: 'acme-medical', name: 'Pat', email: 'p@x.co', consent: true })).status, 404); eq(W.mail.length, 0);
    const W0 = world({ storefronts: [live({ email: null })] }); eq((await pubPost(pubApi(W0), { action: 'inquiry', s: 'acme-medical', name: 'Pat', email: 'p@x.co', consent: true })).status, 200); eq(W0.mail.length, 0, 'no request address → stored, not emailed');
    const W1 = world({ storefronts: [live()], noSend: true }); eq((await pubPost(pubApi(W1), { action: 'inquiry', s: 'acme-medical', name: 'Pat', email: 'p@x.co', consent: true })).status, 200);
    eq([W1.db.storefront_inquiries.length, W1.mail.length], [1, 0], 'over the hourly email limit → stored, not emailed');
    const W3 = world({ storefronts: [live()], mailFails: true }); eq((await pubPost(pubApi(W3), { action: 'inquiry', s: 'acme-medical', name: 'Pat', email: 'p@x.co', consent: true })).status, 200);
    eq([W3.db.storefront_inquiries.length, !!W3.db.storefront_inquiries[0].notified], [1, false]);
  });
  await t('cache: "not found" is never cached (a storefront just switched on shows at once); the cache is bounded', async () => {
    const W = world({ storefronts: [live({ enabled: false })] }); const C = pubApi(W);
    eq((await pubGet(C, 'acme-medical')).status, 404); W.db.dealer_storefronts[0].enabled = true; eq((await pubGet(C, 'acme-medical')).status, 200);
    for (let i = 0; i < 260; i++) await C._test.cached('k' + i, 60000, async () => ({ i }));
    ok(C._test.CACHE.size <= 200, 'bounded: ' + C._test.CACHE.size); ok(C._test.CACHE.has('k259') && !C._test.CACHE.has('k0'), 'oldest dropped first');
  });
  await t('settings: a live storefront needs a customer phone or email; a preview never reads customers\' requests', async () => {
    const W = world(); const C = dealerApi(W);
    eq((await as(C, 'hq', { action: 'sf_save', location_id: HQ, settings: { slug: 'acme', enabled: true } })).status, 400);
    eq((await as(C, 'hq', { action: 'sf_save', location_id: HQ, settings: { slug: 'acme', enabled: true, phone: '555-0111' } })).status, 200);
    const P = await as(dealerApi(world({ inquiries: [{ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', dealer_id: HQ, name: 'A', email: 'a@x.co' }] })), 'preview:pv', { action: 'sf_inquiries' });
    eq([P.body.inquiries.length, P.body.hidden_in_preview], [0, true]);
  });
  await t('dealer inbox: list, mark handled, delete — head office for its locations, a branch only its own; kept 24 months', async () => {
    const inq = [{ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', storefront_id: 'sf-hq', dealer_id: HQ, created_at: '2026-11-01T00:00:00Z', name: 'A', email: 'a@x.co', status: 'new', delete_after: '2028-11-01' },
      { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', storefront_id: 'sf-br', dealer_id: BR, created_at: '2026-11-02T00:00:00Z', name: 'B', phone: '555', status: 'new', delete_after: '2028-11-02' }];
    const W = world({ inquiries: inq }); const C = dealerApi(W);
    eq((await as(C, 'hq', { action: 'sf_inquiries' })).body.inquiries.length, 2); eq((await as(C, 'br', { action: 'sf_inquiries' })).body.inquiries.map((x) => x.name), ['B']);
    eq((await as(C, 'br', { action: 'sf_inquiry_set', id: inq[0].id, status: 'handled' })).status, 404);
    eq((await as(C, 'hq', { action: 'sf_inquiry_set', id: inq[1].id, status: 'handled' })).status, 200); eq(W.db.storefront_inquiries[1].status, 'handled');
    eq((await as(C, 'preview:pv', { action: 'sf_inquiry_delete', id: inq[0].id })).status, 403);
    eq((await as(C, 'br', { action: 'sf_inquiry_delete', id: inq[1].id })).status, 200); eq(W.db.storefront_inquiries.length, 1);
  });
  await t('strict: commercial records that can\'t be read → 503, never a list that could show discontinued products; before the SQL → "open shortly"', async () => {
    const W = world({ storefronts: [live()], failRead: (tb) => (tb === 'product_skus' ? 500 : 0) }); eq((await pubGet(pubApi(W), 'acme-medical')).status, 503);
    const W2 = world({ missingTables: ['dealer_storefronts'] }); eq((await as(dealerApi(W2), 'hq', { action: 'sf_get' })).body.error, 'Storefronts open shortly.');
  });
  await t('rules: address suggestions and inquiry email', async () => {
    eq([SF.slugify('Smith & Sons Médical, Inc.'), SF.slugProblem('ab'), SF.slugProblem('a--b'), SF.slugProblem('good-name')], ['smith-and-sons-medical-inc', SF.slugProblem('ab'), 'That address is not available — please choose another.', null]);
    ok(SF.slugProblem('ab'), 'too short');
    const m = SF.inquiryEmail({ name: 'A', email: 'a@b.co', product_name: 'Seat\r\nBcc: x@y.z' }, {}, 'Dealer', 'https://x/store/a'); ok(!/[\r\n]/.test(m.subject), 'subject one line');
  });
  console.log(`\nstorefront: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
