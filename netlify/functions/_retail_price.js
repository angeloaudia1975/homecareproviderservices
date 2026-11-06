/* C3-07 storefront correction (owner directive 2026-11-06 13:25 CT) — the PUBLIC RETAIL PRICE of one product (pure; no I/O).
   One rule, used by the public storefront, the dealer's storefront price editor and (for Golden) brochures:

     1. the dealer's saved retail price (the location's own, else the company default)  — if it may be advertised
     2. the manufacturer's MSRP on file (verified — never an HCPS-derived figure)
     3. HCPS CALCULATED RETAIL = authoritative STANDARD cost × 2 (owner-approved)        — if it may be advertised
     4. Call for Price

   "May be advertised" comes from the manufacturer's ADVERTISING RULES, recorded by HCPS per line:
     open       no advertising restriction — any price may be published
     map        prices may be published at or above the product's MAP / eMAP; a product with no MAP on file can't be
                checked → its dealer / calculated price is held for review (MSRP still shows)
     msrp_only  only the manufacturer's MSRP may be published
     no_price   no public prices at all (Call for Price)
     unknown    (nothing recorded) rules unknown → never assume permission: MSRP only; dealer / calculated prices are
                flagged for review
   A dealer's choice of "Call for Price on everything" wins over all of it.

   Public answer: { price, label: "MSRP" | "Price" | "Call for Price", unit_basis: "msrp" | "order_unit" } — never the
   source, the cost, the MAP or a flag. The editor answer (internal) adds source, default, flags. */
'use strict';
const POLICIES = ['open', 'map', 'msrp_only', 'no_price', 'unknown'];
const r2 = (n) => Math.round(n * 100) / 100;
const pos = (v) => { const n = Number(v); return isFinite(n) && n > 0 ? r2(n) : null; };

/* may a non-MSRP price be published under this policy? → { ok } or { ok:false, flag, map? } */
function advertisable(price, policy, map) {
  if (policy === 'open') return { ok: true };
  if (policy === 'map') {
    if (!map) return { ok: false, flag: 'no_map_on_file' };
    if (price < map) return { ok: false, flag: 'below_map', map };
    return { ok: true };
  }
  if (policy === 'msrp_only') return { ok: false, flag: 'msrp_only' };
  if (policy === 'no_price') return { ok: false, flag: 'no_public_price' };
  return { ok: false, flag: 'rules_unknown' };
}

/* input: { dealerPrice, msrp (verified only), cost (standard, per order unit), map (per ORDER UNIT), msrpMap (MAP in the MSRP's
   unit; defaults to map), policy, priceMode }
   → { price, label, source: 'dealer'|'msrp'|'calculated'|'call', unit_basis, calculated (the 2× value or null),
       flags: [{ on:'dealer'|'calculated'|'line', flag, map? }] } */
function decide(input) {
  const policy = POLICIES.includes(input.policy) ? input.policy : 'unknown';
  const dealer = pos(input.dealerPrice), msrp = pos(input.msrp), cost = pos(input.cost), map = pos(input.map);
  const msrpMap = pos(input.msrpMap === undefined ? input.map : input.msrpMap);   // the MAP in the MSRP's own unit (null = can't compare)
  const calculated = cost ? r2(cost * 2) : null;
  const flags = [];
  const call = (why) => ({ price: null, label: 'Call for Price', source: 'call', unit_basis: null, calculated, msrp, flags: why ? flags.concat([{ on: 'line', flag: why }]) : flags });
  if (input.priceMode === 'call') return call('dealer_call_for_price');
  if (policy === 'no_price') return call('no_public_price');
  if (dealer) {
    const a = advertisable(dealer, policy, map);
    if (a.ok) return { price: dealer, label: 'Price', source: 'dealer', unit_basis: 'order_unit', calculated, msrp, flags };
    flags.push(Object.assign({ on: 'dealer' }, a, { ok: undefined }));
  }
  /* review fix: under MAP rules an MSRP below the MAP (bad data) is never published either */
  if (msrp && policy === 'map' && msrpMap && msrp < msrpMap) flags.push({ on: 'msrp', flag: 'below_map', map: msrpMap });
  else if (msrp) return { price: msrp, label: 'MSRP', source: 'msrp', unit_basis: 'msrp', calculated, msrp, flags };
  if (calculated) {
    const a = advertisable(calculated, policy, map);
    if (a.ok) return { price: calculated, label: 'Price', source: 'calculated', unit_basis: 'order_unit', calculated, msrp, flags };
    flags.push(Object.assign({ on: 'calculated' }, a, { ok: undefined }));
  }
  return call(null);
}
const clean = (f) => f.map((x) => { const o = { on: x.on, flag: x.flag }; if (x.map) o.map = x.map; return o; });
/* the public slice — nothing about where the price came from */
function publicPrice(d) { return { price: d.price, price_label: d.label }; }
/* the dealer editor's slice (the dealer's own storefront; never the cost) */
function editorPrice(d) { return { price: d.price, price_label: d.label, source: d.source, calculated: d.calculated, msrp: d.msrp || null, flags: clean(d.flags) }; }

/* the dealer's saved price for a location: its own row, else the company default (location null) */
function dealerPriceFor(rows, locationId, manufacturer, code) {
  let def = null, own = null;
  for (const r of rows || []) {
    if (r.manufacturer !== manufacturer || String(r.code) !== String(code)) continue;
    if (r.location_id == null) def = r.price; else if (String(r.location_id) === String(locationId)) own = r.price;
  }
  return pos(own != null ? own : def);
}
/* the recorded advertising rules → { slug: policy } (anything unrecognised = unknown) */
function policiesFrom(setting, defaults) {
  const out = Object.assign({}, defaults || {});
  const lines = setting && typeof setting === 'object' && setting.lines && typeof setting.lines === 'object' ? setting.lines : {};
  for (const [slug, v] of Object.entries(lines)) { const p = v && typeof v === 'object' ? v.policy : v; if (POLICIES.includes(p)) out[slug] = p; }
  return out;
}
const FLAG_TEXT = {
  no_map_on_file: 'This manufacturer advertises by MAP, and HCPS has no MAP on file for this product — your price can\'t be checked, so it isn\'t shown publicly.',
  below_map: 'Below the manufacturer\'s minimum advertised price (MAP).',
  msrp_only: 'This manufacturer allows only its MSRP to be advertised.',
  no_public_price: 'This manufacturer doesn\'t allow public prices — customers see "Call for Price".',
  rules_unknown: 'HCPS hasn\'t recorded this manufacturer\'s advertising rules yet, so only its MSRP is shown publicly. HCPS reviews these.',
  dealer_call_for_price: 'Your storefront is set to "Call for Price" on everything.',
};
/* MAP in the same unit as the price it is compared with (review fix 2026-11-06): on a pack (case_qty > 1) the dealer's
   and the calculated price are per ORDER UNIT; MAP is per piece unless map_basis is 'order_unit'. A pack whose quantity
   isn't known has no comparable MAP. → { map (per order unit), msrpMap (in the MSRP's unit) } */
function mapsFor(p, rec, map, msrp) {
  const m = Number(map); if (!(m > 0)) return { map: null, msrpMap: null };
  const r = rec || {}; const u = String(r.uom || p.uom || '').trim(); const q = Number(r.case_qty || p.case_qty);
  const pack = q > 1 || (u && !/^(each|ea|1)$/i.test(u)); if (!pack) return { map: m, msrpMap: m };
  const basis = r.map_basis || p.map_basis;
  if (basis !== 'each' && basis !== 'order_unit') {
    /* unit not recorded (legacy lines): the manufacturer's own MSRP is never blocked on a guess (msrpMap null); MAP is per
       piece (× pack quantity) unless the MSRP proves it is quoted per pack — a MAP above the MSRP is impossible (2026-11-06) */
    const ms = Number(msrp); const msrpEach = r.msrp_basis === 'each' || (r.msrp_basis !== 'order_unit' && p.msrp_each === true);
    const msrpOrder = ms > 0 ? (msrpEach && q > 1 ? ms * q : ms) : null;
    if (msrpOrder && q > 1 && m * q > msrpOrder + 0.005) return { map: m, msrpMap: null };
    return { map: q > 1 ? Math.round(m * q * 100) / 100 : null, msrpMap: null };
  }
  const perOrder = basis === 'order_unit';
  const orderMap = perOrder ? m : (q > 1 ? Math.round(m * q * 100) / 100 : null), pieceMap = perOrder ? (q > 1 ? Math.round(m / q * 100) / 100 : null) : m;
  const msrpEach = r.msrp_basis === 'each' || (r.msrp_basis !== 'order_unit' && p.msrp_each === true);
  return { map: orderMap, msrpMap: msrpEach ? pieceMap : orderMap };
}
module.exports = { mapsFor, decide, publicPrice, editorPrice, dealerPriceFor, policiesFrom, advertisable, POLICIES, FLAG_TEXT };
