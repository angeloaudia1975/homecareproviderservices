/* C3-07 Stage 4 — saved dealer retail prices. Runs the REAL dealer-retail-api handler against the in-memory PostgREST fake.
   Checks: company default + per-location prices (D2: head office sets default and its locations; a branch only its own),
   history on every change, removal, bulk limits / validation, no other dealer's prices, never a wholesale / MAP / tier
   write, strict reads (503), and a database before the Stage 4 SQL.
     node test/retail-prices.test.js */
const path = require('path');
const M = require(process.env.MOCK || path.join(__dirname, 'phase0-mock.js'));
const ROOT = process.env.CAT_ROOT || path.join(__dirname, '..', 'netlify', 'functions');
let fail = 0, pass = 0;
async function t(n, f) { try { await f(); pass++; console.log('ok   ' + n); } catch (e) { fail++; console.log('FAIL ' + n + '\n     ' + (e && e.stack || e).toString().split('\n').slice(0, 3).join('\n     ')); } }
const eq = (a, b, w) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((w || '') + ' got ' + JSON.stringify(a) + ' expected ' + JSON.stringify(b)); };
const ok = (c, w) => { if (!c) throw new Error(w); };
const HQ = '11111111-1111-1111-1111-111111111111', BR = '22222222-2222-2222-2222-222222222222', BR2 = '33333333-3333-3333-3333-333333333333', OTHER = '44444444-4444-4444-4444-444444444444';
function world(o) {
  o = o || {};
  const W = M.createWorld({ tokens: {}, failRead: o.failRead, failWrite: o.failWrite, missingTables: o.missingTables, tables: {
    dealers: [{ id: HQ, parent_id: null, business_name: 'Acme HQ' }, { id: BR, parent_id: HQ, business_name: 'Acme Branch' }, { id: BR2, parent_id: HQ, business_name: 'Acme Two' }, { id: OTHER, parent_id: null, business_name: 'Else' }],
    dealer_users: [{ uid: 'u-hq', status: 'approved', dealer_id: HQ, email: 'hq@acme.test' }, { uid: 'u-br', status: 'approved', dealer_id: BR, email: 'br@acme.test' }, { uid: 'u-x', status: 'pending', dealer_id: OTHER, email: 'x@else.test' }],
    dealer_user_scope: [], dealer_retail_price_history: [],
    dealer_retail_prices: o.prices || [{ id: 1, dealer_id: OTHER, location_id: null, manufacturer: 'yuwell', code: 'YU-1', price: 99, updated_by: 'x' }],
    product_skus: [{ code: 'YU-1', base_price: 10 }], dealer_contract_prices: [] } });
  const inner = W.fetch;
  W.fetch = async (url, opts) => { const u = String(url);
    if (u.startsWith(M.BASE + '/auth/v1/user')) { const tok = String(((opts && opts.headers) || {}).Authorization || '').replace(/^Bearer\s+/i, '');
      const map = { hq: { id: 'u-hq' }, br: { id: 'u-br' }, x: { id: 'u-x' } };
      return map[tok] ? { ok: true, status: 200, json: async () => map[tok] } : { ok: false, status: 401, json: async () => ({}) }; }
    return inner(url, opts); };
  return W;
}
const api = W => M.load('dealer-retail-api.js', W, {}, ROOT);
const as = (C, who, body) => M.call(C, body, { headers: { authorization: 'Bearer ' + who } });
const writesTo = (W, tb) => W.calls.filter(c => c.method !== 'GET' && String(c.url || '').includes('/rest/v1/' + tb));

(async () => {
  await t('head office: company default + a location price saved, history written, unchanged skipped', async () => {
    const W = world(); const C = api(W);
    const r = await as(C, 'hq', { action: 'retail_set', rows: [{ manufacturer: 'yuwell', code: 'YU-1', price: '$129.00' }, { manufacturer: 'yuwell', code: 'YU-1', price: 139.5, location_id: BR }] });
    eq([r.status, r.body.saved], [200, 2], JSON.stringify(r.body));
    const mine = W.db.dealer_retail_prices.filter(x => x.dealer_id === HQ);
    eq(mine.map(x => [x.location_id, x.price]).sort(), [[BR, 139.5], [null, 129]].sort());
    eq(W.db.dealer_retail_price_history.length, 2);
    eq((await as(C, 'hq', { action: 'retail_set', rows: [{ manufacturer: 'yuwell', code: 'YU-1', price: 129 }] })).body.unchanged, 1);
    const up = await as(C, 'hq', { action: 'retail_set', rows: [{ manufacturer: 'yuwell', code: 'YU-1', price: 119 }] });
    eq(up.body.saved, 1); eq(W.db.dealer_retail_price_history.slice(-1)[0].old_price, 129);
  });
  await t('branch: its rows go to its own location under the company; it cannot set the default or another branch', async () => {
    const W = world(); const C = api(W);
    eq((await as(C, 'br', { action: 'retail_set', rows: [{ manufacturer: 'yuwell', code: 'YU-1', price: 140 }] })).body.saved, 1);
    const row = W.db.dealer_retail_prices.find(x => x.dealer_id === HQ); eq([row.location_id, row.price], [BR, 140]);
    eq((await as(C, 'br', { action: 'retail_set', rows: [{ manufacturer: 'yuwell', code: 'YU-1', price: 1, location_id: BR2 }] })).status, 403);
    eq((await as(C, 'br', { action: 'retail_set', rows: [{ manufacturer: 'yuwell', code: 'YU-1', price: 1, location_id: OTHER }] })).status, 403);
  });
  await t('list: a branch sees the company default + its own, never another branch; nobody sees another dealer', async () => {
    const W = world({ prices: [{ id: 1, dealer_id: HQ, location_id: null, manufacturer: 'yuwell', code: 'A', price: 10 }, { id: 2, dealer_id: HQ, location_id: BR, manufacturer: 'yuwell', code: 'A', price: 11 },
      { id: 3, dealer_id: HQ, location_id: BR2, manufacturer: 'yuwell', code: 'A', price: 12 }, { id: 4, dealer_id: OTHER, location_id: null, manufacturer: 'yuwell', code: 'A', price: 99 }] });
    const C = api(W);
    eq((await as(C, 'br', { action: 'retail_list' })).body.prices.map(p => p.price).sort(), [10, 11]);
    eq((await as(C, 'hq', { action: 'retail_list' })).body.prices.map(p => p.price).sort(), [10, 11, 12]);
  });
  await t('remove (price null), validation, limits, duplicates', async () => {
    const W = world({ prices: [{ id: 1, dealer_id: HQ, location_id: null, manufacturer: 'yuwell', code: 'A', price: 10 }] }); const C = api(W);
    eq((await as(C, 'hq', { action: 'retail_set', rows: [{ manufacturer: 'yuwell', code: 'A', price: null }] })).body.removed, 1);
    eq(W.db.dealer_retail_prices.length, 0); eq(W.db.dealer_retail_price_history[0].new_price, null);
    eq((await as(C, 'hq', { action: 'retail_set', rows: [{ manufacturer: 'yuwell', code: 'A', price: -5 }] })).status, 400);
    eq((await as(C, 'hq', { action: 'retail_set', rows: [{ manufacturer: 'Bad Slug!', code: 'A', price: 5 }] })).status, 400);
    eq((await as(C, 'hq', { action: 'retail_set', rows: new Array(501).fill({ manufacturer: 'yuwell', code: 'A', price: 1 }) })).status, 400);
    eq((await as(C, 'hq', { action: 'retail_set', rows: [{ manufacturer: 'yuwell', code: 'A', price: 1 }, { manufacturer: 'yuwell', code: 'A', price: 2 }] })).status, 400);
  });
  await t('never writes a wholesale price, MAP, tier or contract price', async () => {
    const W = world(); await as(api(W), 'hq', { action: 'retail_set', rows: [{ manufacturer: 'yuwell', code: 'YU-1', price: 129 }] });
    eq(['product_skus', 'dealer_contract_prices', 'product_overrides', 'custom_products'].map(tb => writesTo(W, tb).length), [0, 0, 0, 0]);
  });
  await t('not signed in / not approved → 401; unreadable store → 503; before the SQL → 503 "open shortly"', async () => {
    eq((await as(api(world()), 'x', { action: 'retail_list' })).status, 401);
    eq((await as(api(world()), 'nobody', { action: 'retail_list' })).status, 401);
    eq((await as(api(world({ failRead: tb => tb === 'dealer_retail_prices' ? 500 : 0 })), 'hq', { action: 'retail_list' })).status, 503);
    const r = await as(api(world({ missingTables: ['dealer_retail_prices', 'dealer_user_scope'] })), 'hq', { action: 'retail_list' });
    eq([r.status, /open shortly/.test(r.body.error)], [503, true], JSON.stringify(r.body));
  });
  await t('a write failing part-way says how many were saved (never "saved")', async () => {
    let n = 0; const W = world({ failWrite: (m, tb) => (tb === 'dealer_retail_prices' && ++n === 2) ? 500 : 0 });
    const r = await as(api(W), 'hq', { action: 'retail_set', rows: [{ manufacturer: 'yuwell', code: 'A', price: 1 }, { manufacturer: 'yuwell', code: 'B', price: 2 }] });
    eq([r.status, r.body.ok, r.body.saved], [503, false, 1]); ok(/Saved 1 of 2/.test(r.body.error), r.body.error);
  });
  await t('more than 1000 saved prices: the list is complete and a save finds the existing row (no partial read)', async () => {
    const many = []; for (let i = 0; i < 1203; i++) many.push({ id: i + 1, dealer_id: HQ, location_id: null, manufacturer: 'yuwell', code: 'C' + i, price: 5 });
    const W = world({ prices: many }); const C = api(W);
    eq((await as(C, 'hq', { action: 'retail_list' })).body.prices.length, 1203);
    const r = await as(C, 'hq', { action: 'retail_set', rows: [{ manufacturer: 'yuwell', code: 'C1202', price: 6 }] });
    eq([r.status, r.body.saved], [200, 1], JSON.stringify(r.body)); eq(W.db.dealer_retail_prices.length, 1203, 'updated, not added');
  });
  await t('a head office HCPS narrowed to "own" cannot change the company default; its own location still can', async () => {
    const W = world(); W.db.dealer_user_scope.push({ uid: 'u-hq', scope: 'own', locations: null }); const C = api(W);
    eq((await as(C, 'hq', { action: 'retail_set', rows: [{ manufacturer: 'yuwell', code: 'A', price: 3 }] })).status, 403);
    eq((await as(C, 'hq', { action: 'retail_set', rows: [{ manufacturer: 'yuwell', code: 'A', price: 3, location_id: HQ }] })).body.saved, 1);
  });
  await t('history: a branch does not see who changed a price; a failed history write is reported', async () => {
    const W = world(); const C = api(W);
    await as(C, 'hq', { action: 'retail_set', rows: [{ manufacturer: 'yuwell', code: 'A', price: 3 }] });
    eq((await as(C, 'br', { action: 'retail_history', manufacturer: 'yuwell', code: 'A' })).body.history[0].changed_by, null);
    eq((await as(C, 'hq', { action: 'retail_history', manufacturer: 'yuwell', code: 'A' })).body.history[0].changed_by, 'hq@acme.test');
    const W2 = world({ failWrite: (m, tb) => tb === 'dealer_retail_price_history' ? 500 : 0 });
    eq((await as(api(W2), 'hq', { action: 'retail_set', rows: [{ manufacturer: 'yuwell', code: 'A', price: 3 }] })).body.history_recorded, false);
  });
  await t('a price changed by someone else between read and write is not overwritten blindly', async () => {
    const W = world({ prices: [{ id: 1, dealer_id: HQ, location_id: null, manufacturer: 'yuwell', code: 'A', price: 10, updated_by: 'x' }] });
    const inner = W.fetch; W.fetch = async (u, o) => { if (o && o.method === 'PATCH' && /dealer_retail_prices/.test(String(u))) W.db.dealer_retail_prices[0].price = 12; return inner(u, o); };
    const r = await as(api(W), 'hq', { action: 'retail_set', rows: [{ manufacturer: 'yuwell', code: 'A', price: 11 }] });
    eq([r.status, r.body.saved], [503, 0], JSON.stringify(r.body)); eq(W.db.dealer_retail_prices[0].price, 12);
  });
  console.log(`\nretail prices: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
