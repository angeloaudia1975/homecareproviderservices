/* C3-07 — ONE builder for a storefront's products and their public prices, used by the public page (storefront-public)
   and by the dealer's own price editor / preview (dealer-storefront-api), so the dealer always sees exactly what customers
   will see.

   Products: the line's catalog with every hiding rule of _storefront.lineFacts (records, saved edits, visible enrichment
   pages, enriched-only lines, discontinued never public), the dealer's hidden categories, and — owner correction
   2026-11-06 — Golden Technologies through _golden_storefront (Golden's verified link decides).
   Prices: _retail_price.decide per product — the dealer's saved retail (this location, else the company default), the
   verified MSRP, HCPS calculated retail (STANDARD cost × 2: the shop's own engine at quantity 1 with no contract price
   and no line discount — _pricing.lineProducts), Call for Price — under the line's recorded advertising rules.
   The cost and MAP never leave this module except as the editor's `calculated` figure (2× cost, the public price the
   rule would show) — no cost, margin or source reaches the public answer. */
'use strict';
const SF = require('./_storefront.js');
const RP = require('./_retail_price.js');
const PR = require('./_pricing.js');
const GS = require('./_golden_storefront.js');
const RETIRED = require('./_retired_lines.js');
const GOLDEN = new Set(['golden-technologies', 'golden']);
const POLICY_DEFAULTS = { 'golden-technologies': 'map' };   // Golden publishes an eMAP for every product (contract golden-commerce-v1)
const enc = encodeURIComponent;

/* deps: { sb(method,path), sbAll(path), catalogFile(slug), contentFile(slug), flags(), supabaseUrl }
   sf: the storefront row; opts.editor = true → the editor's slice per product; opts.lines = override the line choice
   returns { lineList, products, unpriced: {slug: count} } */
async function build(sf, deps, opts) {
  opts = opts || {};
  const [dms, names, metas, setting, retail] = await Promise.all([
    deps.sb('GET', `dealer_manufacturers?dealer_id=eq.${enc(sf.dealer_id)}&active=eq.true&select=manufacturer`),
    deps.sb('GET', 'manufacturers?select=slug,name'), deps.sb('GET', 'manufacturer_meta?select=slug,active,enriched_only'),
    deps.sb('GET', 'app_settings?key=eq.advertising_policies&select=value').then((r) => (r && r[0] && r[0].value) || null),
    deps.sbAll(`dealer_retail_prices?dealer_id=eq.${enc(sf.company_id)}&select=id,manufacturer,code,location_id,price&order=id.asc`).catch((e) => { if (/PGRST205|42P01/.test(String(e && e.message))) return []; throw e; }),
  ]);
  const policies = RP.policiesFrom(setting, POLICY_DEFAULTS);
  const off = new Set((metas || []).filter((m) => m.active === false).map((m) => m.slug)), enrOnly = new Set((metas || []).filter((m) => m.enriched_only === true).map((m) => m.slug)), nm = new Map((names || []).map((m) => [m.slug, m.name || m.slug]));
  nm.set('golden-technologies', nm.get('golden-technologies') || 'Golden Technologies');
  let lines = [...new Set((dms || []).map((x) => String(x.manufacturer || '')))].filter((s) => s && !GOLDEN.has(s) && !off.has(s) && !RETIRED.isRetiredLine(s));
  const choose = opts.lines !== undefined ? opts.lines : sf.lines;
  const golden = Array.isArray(choose) ? choose.includes('golden-technologies') : true;
  if (Array.isArray(choose)) lines = lines.filter((s) => choose.includes(s));
  const hiddenCats = new Set((sf.hidden_categories || []).map((x) => String(x).toLowerCase()));
  const products = [], lineList = [];
  /* review fix (2026-11-06): MAP is compared in the SAME unit as the price. On a pack (case_qty > 1) the dealer's and the
     calculated price are per ORDER UNIT while MAP is per piece (map_basis 'each', the standing rule) or per order unit
     (map_basis 'order_unit'); a pack whose quantity isn't known can't be checked → no MAP (held under MAP rules). */
  const mapsFor = RP.mapsFor;
  const priced = (p, line, facts, cost, map, fileMsrp) => {
    const rec = facts && facts.unit ? facts.unit.get(String(p.code)) : null;
    const msrpV = facts ? (facts.msrp.get(String(p.code)) || fileMsrp || null) : p._msrp;
    const mm = mapsFor(p, rec, map, msrpV);
    const d = RP.decide({ dealerPrice: RP.dealerPriceFor(retail, sf.dealer_id, line, p.code), msrp: msrpV,
      cost, map: mm.map, msrpMap: mm.msrpMap, policy: policies[line] || 'unknown', priceMode: sf.price_mode });
    const unit = d.unit_basis === 'msrp' ? SF.unitOf(p, rec) : d.unit_basis === 'order_unit' ? SF.unitOf(p, Object.assign({}, rec || {}, { msrp_basis: 'order_unit' })) : null;
    return Object.assign(RP.publicPrice(d), { price_unit: d.price != null ? unit : null }, opts.editor ? { editor: RP.editorPrice(d) } : {});
  };
  for (const line of lines) {
    const { file, facts, costs } = await lineData(deps, line, enrOnly.has(line));
    let n = 0;
    for (const p of file) {
      if (!p || !p.code || facts.isHidden(p.code) || p.active === false || p.discontinued === true) continue;
      const pp = SF.publicProduct(p, line, facts, 'call', deps.supabaseUrl);
      if (hiddenCats.has(pp.category.toLowerCase())) continue;
      const c = costs && costs.get(String(p.code));
      products.push(Object.assign(pp, priced(p, line, facts, c && c.cost, c && c.map, c && c.msrp))); n++; if (products.length >= 6000) break;
    }
    if (n) lineList.push({ slug: line, name: nm.get(line) || line, count: n });
  }
  if (golden && deps.flags) {
    let g = { ok: false, products: [] };
    try { g = await GS.products(deps.sb.bind(null, 'GET'), sf.dealer_id, sf.slug, await deps.flags()); } catch (e) { console.error('storefront golden failed', e && String(e.message).slice(0, 120)); }
    let n = 0;
    for (const p of g.products || []) {
      if (hiddenCats.has(p.category.toLowerCase())) continue;
      const out = { manufacturer: p.manufacturer, code: p.code, name: p.name, category: p.category, subcategory: p.subcategory, brand: p.brand, description: p.description,
        uom: null, image: p.image, attributes: p.attributes, features: p.features };
      products.push(Object.assign(out, priced(p, 'golden-technologies', null, p._cost, p._map))); n++;
    }
    if (n) lineList.unshift({ slug: 'golden-technologies', name: 'Golden Technologies', count: n });
  }
  return { lineList, products, policies };
}
/* one line's catalog file, its visibility / official-MSRP facts and its STANDARD cost + MAP per code (strict reads; a line
   whose commercial layers can't be read gets costs = null → no calculated price, never a guessed cost) */
async function lineData(deps, line, enrichedOnly) {
  const q = `manufacturer=eq.${enc(line)}`;
  const [file, records, overrides, custom, pages] = await Promise.all([deps.catalogFile(line),
    deps.sbAll(`product_skus?${q}&select=code,msrp,msrp_auto,status,uom,case_qty,msrp_basis,map_basis&order=code.asc`), deps.sbAll(`product_overrides?${q}&select=code,patch&order=code.asc`),
    deps.sbAll(`custom_products?${q}&select=code,msrp,msrp_auto&order=code.asc`), deps.sbAll(`product_content?${q}&select=page_key,status,disabled,skus&order=page_key.asc`)]);
  /* review fix (2026-11-06, retired ABM / PediFix SKUs): the dealer shop reads a line's pages from product_content and,
     when the line has NO visible page there, from its static content file (./data/content/<line>.json) — where retired
     SKUs are switched off (status hidden, disabled). Read the same way here, so a product the shop doesn't list is never
     priced, quoted or shown on a storefront. A content file that can't be read is an error (strict), never "no pages". */
  let pg = pages || [];
  if (!pg.some((r) => ['published', 'active', 'discontinued'].includes(String((r && r.status) || ''))) && deps.contentFile) {
    const cj = await deps.contentFile(line); const o = (cj && cj.pages && typeof cj.pages === 'object') ? cj.pages : {};
    pg = Object.keys(o).map((k) => Object.assign({ page_key: k }, o[k]));
  }
  const facts = SF.lineFacts({ records, overrides, custom, pages: pg, enrichedOnly: !!enrichedOnly });
  /* standard cost and MAP: the shop's own engine (no contract price, no line discount, quantity 1 — a quantity break or
     special never applies at 1) */
  let costs = null;
  try {
    const lp = await PR.lineProducts({ slug: line, sb: deps.sb, catalogFile: deps.catalogFile, contentFile: deps.contentFile, contract: {}, rates: {}, cart: new Map() });
    /* official MSRP on file in the private commercial catalog (legacy lines keep it there): the merged product's MSRP unless
       the shop derived it (_msrp_suggested = 2 × dealer price, never an official figure) */
    costs = new Map((lp.products || []).map((p) => { let c = null; try { c = lp.engine.unitPrice(p, 1); } catch (e) { c = null; }
      const m = Number(p.msrp); return [String(p.code), { cost: c, map: p.map, msrp: !p._msrp_suggested && p.msrp_auto !== true && m > 0 ? m : null }]; }));
  } catch (e) { console.error('storefront cost read failed', line, e && String(e.message).slice(0, 120)); costs = null; }
  return { file: file || [], facts, costs };
}

/* C3-07 owner directive 2026-11-06 15:23 CT: the DEFAULT customer retail of each product of a line, for My Retail Prices,
   quotes and brochures — official MSRP, else HCPS calculated retail (2 × standard dealer cost) when the line's rules allow
   it, else none. No dealer price, no contract price. → { policy, items: Map code → RP.decide result (+ hidden) } */
async function lineDefaults(deps, line, opts) {
  opts = opts || {};
  const setting = opts.setting !== undefined ? opts.setting : await deps.sb('GET', 'app_settings?key=eq.advertising_policies&select=value').then((r) => (r && r[0] && r[0].value) || null);
  const policy = RP.policiesFrom(setting, POLICY_DEFAULTS)[line] || 'unknown';
  const meta = opts.meta !== undefined ? opts.meta : await deps.sb('GET', `manufacturer_meta?slug=eq.${enc(line)}&select=enriched_only`);
  const { file, facts, costs } = await lineData(deps, line, !!(meta && meta[0] && meta[0].enriched_only === true));
  const items = new Map();
  for (const p of file) {
    if (!p || !p.code) continue;
    const rec = facts.unit ? facts.unit.get(String(p.code)) : null; const c = costs && costs.get(String(p.code));
    const msrpV = facts.msrp.get(String(p.code)) || (c && c.msrp) || null;
    const mm = RP.mapsFor(p, rec, c && c.map, msrpV);
    const d = RP.decide({ msrp: msrpV, cost: c && c.cost, map: mm.map, msrpMap: mm.msrpMap, policy });
    d.active = !(facts.isHidden(p.code) || p.active === false || p.discontinued === true); d.no_cost = !(c && c.cost > 0);
    if (!d.active) { d.price = null; d.label = 'Call for Price'; d.source = 'call'; }   // review fix: never a price for a product no storefront shows
    items.set(String(p.code), d);
  }
  return { policy, items, costs_readable: !!costs };
}
module.exports = { build, lineDefaults, lineData, POLICY_DEFAULTS };
