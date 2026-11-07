/* Owner directive 2026-11-06 §7 — Golden reporting resilience. node test/golden-ref.test.js */
const assert = require('node:assert/strict');
const path = require('path');
const fresh = () => { delete require.cache[require.resolve(path.join(__dirname, '../netlify/functions/_golden_ref.js'))]; return require(path.join(__dirname, '../netlify/functions/_golden_ref.js')); };
let pass = 0, fail = 0;
async function t(n, f) { try { await f(); pass++; console.log('ok   ' + n); } catch (e) { fail++; console.log('FAIL ' + n + '\n     ' + String(e && e.stack || e).split('\n').slice(0, 3).join('\n     ')); } }
function store() {
  const db = {};
  return { db,
    sbGet: async (p) => { const k = decodeURIComponent((p.match(/key=eq\.([^&]+)/) || [])[1] || ''); return db[k] ? [{ value: db[k] }] : []; },
    sbSend: async (m, p, body) => { db[body.key] = JSON.parse(JSON.stringify(body.value)); return null; } };
}
const PRODUCTS = [
  { sku: 'PR510', name: 'Lift chair', category: 'Lift Chairs', msrp: 2000, dealer_price: 900, price_source: 'account' },
  { sku: 'GB108B', name: 'Buzzaround', category: 'Scooters', msrp: null, dealer_price: 700, price_source: 'standard' },
];
const ok = (products) => async () => ({ ok: true, json: { linked: true, products } });
const slow = (ms) => () => new Promise((r) => setTimeout(() => r({ ok: true, json: { linked: true, products: PRODUCTS } }), ms));

(async () => {
  await t('live answer: valued live; the shared reference keeps MSRP + STANDARD price only — never an account price', async () => {
    const G = fresh(), S = store();
    const r = await G.goldenReference({ sbGet: S.sbGet, sbSend: S.sbSend, fetchCatalog: ok(PRODUCTS) });
    assert.equal(r.source, 'live');
    const pr = r.catalog.byCode.get('PR510'); assert.deepEqual([pr.ref, pr.ref_source, pr.base_price, pr.cost], [2000, 'msrp', 900, null]);
    const gb = r.catalog.byCode.get('GB108B'); assert.deepEqual([gb.ref, gb.ref_source], [1400, 'calculated'], '2× the STANDARD price');
    const ref = S.db.golden_retail_ref; assert.ok(ref && ref.items.PR510 && ref.items.GB108B);
    assert.equal(ref.items.PR510.d, null, 'an account price is never stored'); assert.equal(JSON.stringify(ref).includes('900'), false);
  });
  await t('Golden slow: one quick retry at most, then the stored reference, labelled with its date', async () => {
    const G = fresh(), S = store();
    await G.goldenReference({ sbGet: S.sbGet, sbSend: S.sbSend, fetchCatalog: ok(PRODUCTS) });
    const G2 = fresh(); const t0 = Date.now();
    const r = await G2.goldenReference({ sbGet: S.sbGet, sbSend: S.sbSend, fetchCatalog: slow(8000) });
    assert.ok(Date.now() - t0 < 4000, 'bounded: ' + (Date.now() - t0) + ' ms');
    assert.deepEqual([r.source, r.live_reason], ['stored', 'timeout']); assert.equal(r.catalog.byCode.get('PR510').ref, 2000);
    assert.equal(r.catalog.byCode.get('PR510').base_price, null, 'no dealer price from the store');
    assert.ok(r.as_of);
  });
  await t('a dealer not connected to Golden still gets the stored reference; with none it is "not connected" — never a zero', async () => {
    const G = fresh(), S = store();
    const none = await G.goldenReference({ sbGet: S.sbGet, sbSend: S.sbSend, fetchCatalog: async () => ({ reason: 'no_access' }) });
    assert.deepEqual([none.catalog, none.reason], [null, 'golden_not_connected']);
    await G.goldenReference({ sbGet: S.sbGet, sbSend: S.sbSend, fetchCatalog: ok(PRODUCTS) });
    const G2 = fresh(); const r = await G2.goldenReference({ sbGet: S.sbGet, sbSend: S.sbSend, fetchCatalog: async () => ({ ok: true, json: { linked: false, products: [] } }) });
    assert.deepEqual([r.source, r.live_reason], ['stored', 'not_linked'], 'an unlinked account is not a live (empty) catalog');
  });
  await t('a stored reference older than 7 days is not used; failures are counted for monitoring', async () => {
    const G = fresh(), S = store();
    S.db.golden_retail_ref = { at: new Date(Date.now() - 8 * 864e5).toISOString(), count: 1, items: G.toReference(PRODUCTS) };
    const r = await G.goldenReference({ sbGet: S.sbGet, sbSend: S.sbSend, fetchCatalog: async () => { throw new Error('boom'); } });
    assert.deepEqual([r.catalog, r.reason], [null, 'golden_unavailable']);
    assert.ok(G._MEM.mon.failures >= 1 && G._MEM.mon.unavailable === 1);
    await G.recordMonitor(S.sbSend, { last_report_coverage_pct: 90 }); assert.equal(S.db.golden_ref_monitor.last_report_coverage_pct, 90);
  });
  await t('the stored reference is refreshed at most every 6 hours', async () => {
    const G = fresh(), S = store(); let writes = 0; const send = async (...a) => { writes++; return S.sbSend(...a); };
    await G.goldenReference({ sbGet: S.sbGet, sbSend: send, fetchCatalog: ok(PRODUCTS) });
    await G.goldenReference({ sbGet: S.sbGet, sbSend: send, fetchCatalog: ok(PRODUCTS) });
    assert.equal(writes, 1);
  });
  console.log(`\ngolden reference: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
