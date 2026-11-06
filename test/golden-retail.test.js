/* C3-07 P4 — golden-proxy "retail": the customer retail price of one Golden item for a brochure / quote, read on HCPS's
   server. Real handler + _golden_retail.js against the in-memory PostgREST fake and a fake Golden; synthetic data only.
     node test/golden-retail.test.js */
const path = require('path');
const M = require(process.env.MOCK || path.join(__dirname, 'phase0-mock.js'));
const ROOT = process.env.CAT_ROOT || path.join(__dirname, '..', 'netlify', 'functions');
let fail = 0, pass = 0;
async function t(n, f) { try { await f(); pass++; console.log('ok   ' + n); } catch (e) { fail++; console.log('FAIL ' + n + '\n     ' + (e && e.stack || e).toString().split('\n').slice(0, 3).join('\n     ')); } }
const eq = (a, b, w) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((w || '') + ' got ' + JSON.stringify(a) + ' expected ' + JSON.stringify(b)); };
const HQ = '11111111-1111-1111-1111-111111111111', D2 = '22222222-2222-2222-2222-222222222222';
const ENV = { GOLDEN_P360_KEY_ID: 'kid-test', GOLDEN_P360_SECRET: 'x'.repeat(48), GOLDEN_API_BASE: 'https://golden.test' };
const CAT = [{ sku: 'PR501-SMA', category: 'Lift Chairs', msrp: 2499, emap: 1999, dealer_price: 1100, price_source: 'standard' },
  { sku: 'GB121', category: 'Scooters', msrp: null, emap: 1200, dealer_price: 700, price_source: 'standard' },
  { sku: 'GB999', category: 'Scooters', msrp: null, emap: 400, dealer_price: 500, price_source: 'promo' }];
function world(o) {
  o = o || {};
  const W = M.createWorld({ tokens: {}, tables: {
    dealers: [{ id: HQ, parent_id: null, business_name: 'Acme' }, { id: D2, parent_id: null, business_name: 'Other' }], dealer_users: [{ uid: 'u1', status: 'approved', dealer_id: HQ }, { uid: 'u2', status: 'approved', dealer_id: D2 }],
    app_settings: [{ key: 'phase2_flags', value: o.flags || { golden_p360_catalog: true, golden_p360_all_linked: true } }].concat(o.policy ? [{ key: 'advertising_policies', value: { lines: { 'golden-technologies': { policy: o.policy } } } }] : []),
    dealer_preview_tokens: [] } });
  const inner = W.fetch; W.golden = [];
  W.fetch = async (url, opts) => { const u = String(url); const h = (opts && opts.headers) || {};
    if (u.startsWith(M.BASE + '/auth/v1/user')) { const t = String(h.Authorization); return t === 'Bearer good' ? { ok: true, status: 200, json: async () => ({ id: 'u1' }) } : t === 'Bearer other' ? { ok: true, status: 200, json: async () => ({ id: 'u2' }) } : { ok: false, status: 401, json: async () => ({}) }; }
    if (u.startsWith('https://golden.test/')) { W.golden.push({ url: u, method: (opts && opts.method) || 'GET' });
      if (/\/v1\/catalog(\?|$)/.test(u)) { const d = JSON.parse(Buffer.from(String(h['x-hcps-delegation'] || ''), 'base64url').toString() || '{}');
        return { ok: true, status: 200, json: async () => ({ prices_visible: true, linked: true, products: d.sub_dealer === D2 ? CAT.map((p) => Object.assign({}, p, { msrp: p.msrp ? 2222 : null })) : CAT }) }; }
      if (/\/v1\/config/.test(u)) return { ok: true, status: 200, json: async () => ({ prices_visible: true, linked: true, config: { sku: 'PR501-SMA', sizes: [{ sku: 'PR501-SMA', msrp: 2499 }], tabs: [{ key: 'xover', msrp: 300 }], tiers: { included: false, options: [{ key: 'irheat', msrp: 450 }] }, footrest: { eligible: false, msrp: 129 } } }) };
      return { ok: false, status: 404, json: async () => ({}) }; }
    return inner(url, opts); };
  return W;
}
const call = (W, body, tok) => M.call(M.load('golden-proxy.js', W, ENV, ROOT), body, { headers: tok ? { authorization: 'Bearer ' + tok } : {} });
const P = (r) => { if (r.status !== 200) throw new Error('status ' + r.status + ' ' + JSON.stringify(r.body)); return [r.body.price, r.body.label, r.body.source]; };

(async () => {
  await t('needs the dealer\'s own sign-in', async () => { eq((await call(world(), { action: 'retail', code: 'PR501-SMA' })).status, 401); });
  await t('Golden\'s MSRP; a configured chair = the configurator\'s sum; a footrest the chair can\'t take = no price', async () => {
    const W = world();
    eq(P(await call(W, { action: 'retail', code: 'PR501-SMA' }, 'good')), [2499, 'MSRP', 'msrp']);
    eq(P(await call(W, { action: 'retail', code: 'PR501-SMA|xover|ABC|irheat|0' }, 'good')), [3249, 'MSRP', 'msrp']);
    eq(P(await call(W, { action: 'retail', code: 'PR501-SMA|xover|ABC|irheat|1' }, 'good')), [null, null, 'none']);
    eq(W.golden.every((g) => g.method === 'GET'), true, 'read-only: no quote, no order');
  });
  await t('no MSRP → 2× STANDARD only (never a promotion / account price), at or above eMAP; nothing about the cost in the answer', async () => {
    const r = await call(world(), { action: 'retail', code: 'GB121' }, 'good'); eq(P(r), [1400, 'Price', 'calculated']);
    eq(/700|1200|dealer_price|emap/.test(JSON.stringify(r.body)), false, 'cost or eMAP leaked');
    eq(P(await call(world(), { action: 'retail', code: 'GB999' }, 'good')), [null, null, 'none']);
    eq(P(await call(world({ policy: 'msrp_only' }), { action: 'retail', code: 'GB121' }, 'good')), [null, null, 'none'], 'HCPS recorded MSRP-only for Golden');
  });
  await t('upgrade keys and bad codes are never priced; Golden switched off → none', async () => {
    eq(P(await call(world(), { action: 'retail', code: 'PR501-SMA|u=Heat' }, 'good')), [null, null, 'none']);
    eq(P(await call(world(), { action: 'retail', code: 'PR501-SMA|std|ABC|standard|0|u=Heat' }, 'good')), [null, null, 'none'], 'an upgraded configuration has no MSRP');
    eq(P(await call(world(), { action: 'retail', code: 'PR501-SMA|silk|ABC|standard|0' }, 'good')), [null, null, 'none']);
    eq(P(await call(world({ flags: {} }), { action: 'retail', code: 'PR501-SMA' }, 'good')), [null, null, 'none']);
  });
  await t('Golden\'s catalog is cached per account only: a second dealer gets its own read and its own prices', async () => {
    const W = world(); const C = M.load('golden-proxy.js', W, ENV, ROOT); const as = (tok) => M.call(C, { action: 'retail', code: 'PR501-SMA' }, { headers: { authorization: 'Bearer ' + tok } });
    eq((await as('good')).body.price, 2499); eq((await as('good')).body.price, 2499); eq(W.golden.filter((g) => /\/v1\/catalog/.test(g.url)).length, 1, 'cached for the same account');
    eq((await as('other')).body.price, 2222, 'another account\'s prices'); eq(W.golden.filter((g) => /\/v1\/catalog/.test(g.url)).length, 2);
  });
  console.log(`\ngolden-retail: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
