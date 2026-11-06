/* C3-07 storefront correction — the public retail price rule (_retail_price.js), pure.
     node test/retail-price.test.js */
const path = require('path');
const RP = require(path.join(process.env.CAT_ROOT || path.join(__dirname, '..', 'netlify', 'functions'), '_retail_price.js'));
let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log('ok   ' + n); } catch (e) { fail++; console.log('FAIL ' + n + '\n     ' + e.message); } };
const eq = (a, b, w) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((w || '') + ' got ' + JSON.stringify(a) + ' expected ' + JSON.stringify(b)); };
const D = (o) => { const d = RP.decide(o); return [d.price, d.label, d.source]; };

t('hierarchy under "open" rules: dealer price → MSRP → 2× standard cost → Call for Price', () => {
  eq(D({ dealerPrice: 150, msrp: 199.99, cost: 60, policy: 'open' }), [150, 'Price', 'dealer']);
  eq(D({ msrp: 199.99, cost: 60, policy: 'open' }), [199.99, 'MSRP', 'msrp']);
  eq(D({ cost: 60.125, policy: 'open' }), [120.26, 'Price', 'calculated'], '2 × the standard cost, to the cent');
  eq(D({ policy: 'open' }), [null, 'Call for Price', 'call']);
});
t('a calculated price is never called MSRP; MSRP only when it is the manufacturer\'s figure', () => {
  const d = RP.decide({ cost: 50, policy: 'open' }); eq([d.label, RP.publicPrice(d).price_label], ['Price', 'Price']);
  eq(Object.keys(RP.publicPrice(d)).sort(), ['price', 'price_label'], 'public answer carries no source or cost');
});
t('MAP rules: a dealer or calculated price below MAP is never published; without a MAP on file it is held', () => {
  eq(D({ dealerPrice: 79, msrp: 120, map: 89.99, policy: 'map' }), [120, 'MSRP', 'msrp'], 'below MAP → falls to MSRP');
  eq(D({ dealerPrice: 95, msrp: 120, map: 89.99, policy: 'map' }), [95, 'Price', 'dealer']);
  eq(D({ cost: 40, map: 89.99, policy: 'map' }), [null, 'Call for Price', 'call'], '2× = 80 < MAP');
  eq(D({ cost: 50, map: 89.99, policy: 'map' }), [100, 'Price', 'calculated']);
  eq(D({ dealerPrice: 95, cost: 50, policy: 'map' }), [null, 'Call for Price', 'call'], 'no MAP on file → nothing but MSRP');
  const f = RP.decide({ dealerPrice: 79, msrp: 120, map: 89.99, policy: 'map' }).flags; eq(f, [{ on: 'dealer', flag: 'below_map', map: 89.99 }]);
});
t('review fix: under MAP rules an MSRP below the MAP is not published either; msrpMap compares in the MSRP\'s own unit', () => {
  eq(D({ msrp: 80, map: 89.99, policy: 'map' }), [null, 'Call for Price', 'call']);
  eq(D({ msrp: 30, map: 120, msrpMap: 30, policy: 'map' }), [30, 'MSRP', 'msrp'], 'MSRP each vs MAP each on a pack');
  eq(D({ msrp: 80, map: 89.99, policy: 'open' }), [80, 'MSRP', 'msrp']);
});
t('unknown rules never assume permission: MSRP only, dealer and calculated prices flagged', () => {
  eq(D({ dealerPrice: 95, cost: 50, msrp: 120 }), [120, 'MSRP', 'msrp']);
  eq(D({ dealerPrice: 95, cost: 50 }), [null, 'Call for Price', 'call']);
  eq(RP.decide({ dealerPrice: 95, cost: 50 }).flags.map((x) => x.flag), ['rules_unknown', 'rules_unknown']);
  eq(D({ dealerPrice: 95, cost: 50, policy: 'whatever' }), [null, 'Call for Price', 'call'], 'unrecognised = unknown');
});
t('msrp_only and no_price; the dealer\'s "Call for Price on everything" wins', () => {
  eq(D({ dealerPrice: 95, cost: 50, msrp: 120, policy: 'msrp_only' }), [120, 'MSRP', 'msrp']);
  eq(D({ dealerPrice: 95, cost: 50, policy: 'msrp_only' }), [null, 'Call for Price', 'call']);
  eq(D({ msrp: 120, policy: 'no_price' }), [null, 'Call for Price', 'call']);
  eq(D({ msrp: 120, policy: 'open', priceMode: 'call' }), [null, 'Call for Price', 'call']);
});
t('dealer price: the location\'s own, else the company default; bad values ignored', () => {
  const rows = [{ manufacturer: 'bemis', code: 'B1', location_id: null, price: 100 }, { manufacturer: 'bemis', code: 'B1', location_id: 'L2', price: 110 }, { manufacturer: 'bemis', code: 'B2', location_id: null, price: 0 }];
  eq([RP.dealerPriceFor(rows, 'L1', 'bemis', 'B1'), RP.dealerPriceFor(rows, 'L2', 'bemis', 'B1'), RP.dealerPriceFor(rows, 'L1', 'bemis', 'B2'), RP.dealerPriceFor(rows, 'L1', 'dalton', 'B1')], [100, 110, null, null]);
});
t('recorded rules: only known policies count; defaults kept (Golden eMAP)', () => {
  eq(RP.policiesFrom({ lines: { bemis: { policy: 'map' }, dalton: { policy: 'nonsense' }, abm: 'open' } }, { 'golden-technologies': 'map' }), { 'golden-technologies': 'map', bemis: 'map', abm: 'open' });
  eq(RP.policiesFrom(null, {}), {});
});
t('editor slice explains the restriction; texts exist for every flag', () => {
  const e = RP.editorPrice(RP.decide({ dealerPrice: 79, msrp: 120, map: 89.99, cost: 30, policy: 'map' }));
  eq([e.price, e.source, e.calculated, e.flags[0].flag], [120, 'msrp', 60, 'below_map']);
  for (const k of ['no_map_on_file', 'below_map', 'msrp_only', 'no_public_price', 'rules_unknown', 'dealer_call_for_price']) if (!RP.FLAG_TEXT[k]) throw new Error('no text for ' + k);
});
t('pack MAP units: explicit basis honoured; unknown basis never blocks the manufacturer\'s MSRP, and an MSRP proves a per-pack MAP', () => {
  eq(RP.mapsFor({ case_qty: 6 }, { map_basis: 'each' }, 2, 30), { map: 12, msrpMap: 12 }); eq(RP.mapsFor({ case_qty: 6 }, { map_basis: 'each', msrp_basis: 'each' }, 2, 5), { map: 12, msrpMap: 2 });
  eq(RP.mapsFor({ case_qty: 6 }, { map_basis: 'order_unit' }, 12, 30), { map: 12, msrpMap: 12 });
  eq(RP.mapsFor({ case_qty: 6 }, { msrp_basis: 'order_unit' }, 12.75, 15), { map: 12.75, msrpMap: null }, 'MAP 12.75 × 6 exceeds an MSRP stated per pack (15) → MAP is per pack');
  eq(RP.mapsFor({ case_qty: 4 }, {}, 10, 15), { map: null, msrpMap: null }, 'units unknown → no comparable MAP (never $20 against a true $40)');
  eq(RP.mapsFor({ case_qty: 6 }, {}, 2, null), { map: null, msrpMap: null }, 'no MSRP → held');
  eq(D({ dealerPrice: 20, msrp: 15, ...RP.mapsFor({ case_qty: 4 }, {}, 10, 15), policy: 'map' }), [15, 'MSRP', 'msrp'], 'dealer price held, MSRP shown');
  eq(RP.mapsFor({ uom: 'Box' }, {}, 5, 20), { map: null, msrpMap: null }, 'pack size unknown → no comparable MAP');
  eq(D({ msrp: 15, ...RP.mapsFor({ case_qty: 6 }, {}, 12.75, 15), policy: 'map' }), [15, 'MSRP', 'msrp'], 'the MSRP is published');
});
console.log(`\nretail-price: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
