/* C3-07 Stage 8 — HCPS demand intelligence (pure; no I/O). Built ONLY from:
     • storefront_daily_counts — anonymous daily product views / "Request information" counts per dealer storefront (D4: no
       visitor data exists to show);
     • purchases (monthly_sales, manufacturer-reported) and 360 Dealer Portal orders — to tell interest apart from buying.
   INTEREST IS NOT A SALE: every figure is labelled as views or requests; "not ordered" means no manufacturer-reported purchase
   or portal order of that product by that dealer's company (head office + branches) in the past 12 months — nothing more is concluded. TEST dealers are left out. */
'use strict';
const r1 = (n) => Math.round(n * 10) / 10;

function build(input) {
  const { counts, dealers, names, mfrName, scopeIds, bought, network } = input;
  const D = (id) => dealers.get(String(id)) || null;
  const inScope = (id) => { const d = D(id); return d && !d.is_test && (!scopeIds || scopeIds.has(String(id))); };
  const rows = (counts || []).filter((c) => inScope(c.dealer_id));
  const nameOf = (m, c) => (names[m] && names[m][c]) || c;
  const mName = (m) => (mfrName && mfrName[m]) || m;
  const add = (map, key, init, r) => { const x = map.get(key) || map.set(key, Object.assign({ views: 0, inquiries: 0 }, init)).get(key); x.views += r.views || 0; x.inquiries += r.inquiries || 0; return x; };
  const byM = new Map(), byC = new Map(), byS = new Map(), byP = new Map(), byR = new Map(), byDP = new Map();
  for (const r of rows) {
    const d = D(r.dealer_id);
    add(byM, r.manufacturer, { manufacturer: r.manufacturer, name: mName(r.manufacturer) }, r);
    add(byC, r.category || 'Other', { category: r.category || 'Other' }, r);
    const s = add(byS, String(r.dealer_id), { dealer_id: String(r.dealer_id), name: d.name, city: d.city || '', state: d.state || '' }, r);
    const p = add(byP, r.manufacturer + '|' + r.code, { manufacturer: r.manufacturer, manufacturer_name: mName(r.manufacturer), code: r.code, name: nameOf(r.manufacturer, r.code), category: r.category || 'Other', storefronts: new Set() }, r);
    p.storefronts.add(String(r.dealer_id));
    const g = add(byR, d.state || '—', { state: d.state || '—', storefronts: new Set() }, r); g.storefronts.add(String(r.dealer_id));
    add(byDP, String(r.dealer_id) + '|' + r.manufacturer + '|' + r.code, { dealer_id: String(r.dealer_id), dealer: d.name, city: d.city || '', manufacturer: r.manufacturer, manufacturer_name: mName(r.manufacturer), code: r.code, name: nameOf(r.manufacturer, r.code) }, r);
  }
  const sortI = (a, b) => b.inquiries - a.inquiries || b.views - a.views;
  const top = (m, n) => [...m.values()].sort(sortI).slice(0, n);
  const net = network || new Map();
  const products = top(byP, 50).map((p) => { const nw = net.get(p.manufacturer + '|' + p.code) || { dealers: 0 };
    return { manufacturer: p.manufacturer, manufacturer_name: p.manufacturer_name, code: p.code, name: p.name, category: p.category, views: p.views, inquiries: p.inquiries,
      storefronts: p.storefronts.size, dealers_ordering_12m: nw.dealers }; });
  // interest with little ordering across the network: requested on storefronts, ordered by at most one dealer company in 12 months
  const interest_not_ordered = products.filter((p) => p.inquiries > 0 && p.dealers_ordering_12m <= 1).slice(0, 20);
  // per dealer: products its own storefront visitors looked at or asked about that the dealer hasn't bought in 12 months
  const dealer_opportunities = [...byDP.values()].filter((x) => !(bought.get(D(x.dealer_id).root) || new Set()).has(x.manufacturer + '|' + x.code))
    .sort(sortI).slice(0, 50).map((x) => Object.assign({}, x, { not_ordered_12m: true }));
  const storefronts = top(byS, 50).map((s) => { const best = [...byDP.values()].filter((x) => x.dealer_id === s.dealer_id).sort(sortI)[0];
    return Object.assign(s, { top_product: best ? best.name : null }); });
  const totals = rows.reduce((a, r) => { a.views += r.views || 0; a.inquiries += r.inquiries || 0; return a; }, { views: 0, inquiries: 0 });
  totals.storefronts_with_activity = byS.size; totals.request_rate_pct = totals.views ? r1(totals.inquiries / totals.views * 100) : null;
  return { totals, by_manufacturer: top(byM, 20), by_category: top(byC, 20), by_region: [...byR.values()].sort(sortI).map((g) => ({ state: g.state, views: g.views, inquiries: g.inquiries, storefronts: g.storefronts.size })),
    storefronts, products, interest_not_ordered, dealer_opportunities };
}
module.exports = { build };
