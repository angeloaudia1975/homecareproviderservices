/* C3-07 storefront correction (owner 2026-11-06 13:25 CT) — Golden Technologies on a dealer's PUBLIC storefront.

   Read-only. The same gate the 360 Dealer Portal uses for Golden (golden-proxy): Golden's master switch
   (phase2_flags.golden_p360_catalog), the pilot list or "all linked dealers", branch-as-account, and — when the account gate
   is on — the Golden account number HCPS records for the location or its head office. Then Golden's own catalog, asked
   through the signed client as HCPS's server (delegation role hcps_staff, actor "storefront:<address>"); only a VERIFIED
   Golden link (linked === true) shows Golden — that is Golden's own authorization of the dealer.

   Only public catalog fields leave: name, category, description, specifications, Golden's photo (Golden's own hosts),
   MSRP and eMAP. A STANDARD dealer price (price_source "standard") is passed back ONLY as `cost` for the 2× calculated
   retail and never reaches a response; a promotion or the dealer's own account price is never used. Nothing is stored.
   No ordering, quote, checkout or switch is touched. Any failure → no Golden products (the rest of the storefront stands). */
'use strict';
const GC = require('./_golden_client.js');
const GA = require('./_golden_addresses.js');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GOLDEN_IMG = /^https:\/\/(d3325uqufdmhie\.cloudfront\.net|cdn\.wdgtsrc\.com|goldenonlineordering\.netlify\.app|goldentech\.com|www\.goldentech\.com)\/[^'"\s<>\\`]{1,500}$/;
const CATS = ['Lift Chairs', 'Scooters', 'Power Wheelchairs', 'Beds'];
const s = (v, n) => (typeof v === 'string' && v.trim() ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n) : null);
const num = (v) => (typeof v === 'number' && isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : null);

/* who Golden would serve for this location, or { ok:false, reason } */
async function access(sbGet, dealerId, flags) {
  const f = flags || {};
  if (f.golden_p360_catalog !== true) return { ok: false, reason: 'switched_off' };
  if (!GC.configured()) return { ok: false, reason: 'golden_not_configured' };
  const rows = await sbGet(`dealers?id=eq.${encodeURIComponent(dealerId)}&select=id,parent_id`);
  const d = rows && rows[0]; if (!d) return { ok: false, reason: 'dealer_not_found' };
  let c = d.parent_id ? { sub_dealer: String(d.parent_id), sub_branch: String(d.id) } : { sub_dealer: String(d.id), sub_branch: null };
  if (c.sub_branch && f.golden_p360_branch_as_account === true) c = { sub_dealer: c.sub_dealer, sub_branch: null };
  const pilot = Array.isArray(f.golden_p360_pilot_dealers) ? f.golden_p360_pilot_dealers.map(String) : [];
  if (f.golden_p360_all_linked !== true && !pilot.includes(c.sub_dealer) && !pilot.includes(String(dealerId))) return { ok: false, reason: 'not_in_pilot' };
  let acct = null;
  if (f.golden_p360_account_gate === true) {
    const a = await GA.accountFor(sbGet, dealerId); if (!a.ok) return { ok: false, reason: a.reason };
    acct = a.acct; c = { sub_dealer: String(a.owner), sub_branch: null };
  }
  if (!UUID.test(c.sub_dealer) || (c.sub_branch && !UUID.test(c.sub_branch))) return { ok: false, reason: 'dealer_not_found' };
  return { ok: true, c, acct };
}

/* a Golden catalog product → the storefront's shape (+ internal cost/map, removed before anything is sent) */
function toProduct(g) {
  const category = CATS.includes(g.category) ? g.category : null; if (!category || !s(g.sku, 40)) return null;
  const specs = Array.isArray(g.specs) ? g.specs.map((x) => s(x, 160)).filter(Boolean).slice(0, 20) : [];
  const attributes = {}; const features = [];
  for (const x of specs) { const i = x.indexOf(':'); if (i > 0 && i < 50) attributes[x.slice(0, i).trim()] = x.slice(i + 1).trim(); else features.push(x); }
  if (s(g.size_label, 60)) attributes.Size = s(g.size_label, 60);
  if (s(g.zones, 60)) attributes.Zones = s(g.zones, 60);
  return {
    manufacturer: 'golden-technologies', code: s(g.sku, 40), name: s(g.name, 200) || s(g.sku, 40), category, subcategory: s(g.subcategory, 120),
    brand: 'Golden Technologies', description: s(g.description, 1200), uom: null, image: typeof g.image === 'string' && GOLDEN_IMG.test(g.image) ? g.image : null,
    attributes, features, _msrp: num(g.msrp), _map: num(g.emap), _cost: g.price_source === 'standard' ? num(g.dealer_price) : null,
  };
}

/* { ok, products } — products carry _msrp/_map/_cost for the price rule; the caller strips every _ key */
async function products(sbGet, dealerId, slug, flags) {
  const a = await access(sbGet, dealerId, flags); if (!a.ok) return { ok: false, reason: a.reason, products: [] };
  const r = await GC.call({ method: 'GET', path: '/v1/catalog', delegation: Object.assign({ sub_dealer: a.c.sub_dealer, sub_branch: a.c.sub_branch, actor: 'storefront:' + String(slug).slice(0, 60), role: 'hcps_staff' }, a.acct ? { acct: a.acct } : {}) });
  const j = r && r.json;
  if (!r || !r.ok || !j || j.linked !== true || !Array.isArray(j.products)) return { ok: false, reason: (r && r.ok && j && j.linked !== true) ? 'not_linked' : 'golden_unavailable', products: [] };
  const out = j.products.slice().sort((x, y) => (x.sort || 0) - (y.sort || 0)).map(toProduct).filter(Boolean);
  return { ok: true, products: out };
}
module.exports = { access, products, toProduct, GOLDEN_IMG };
