/* C3-07 storefront correction P4 (owner 2026-11-06 13:25 CT) — the CUSTOMER RETAIL PRICE of one Golden Technologies
   product for a dealer's brochure or customer quote, decided on HCPS's server (never taken from the page).

     1. Golden's own MSRP for that item — a configured lift chair = the size's MSRP + the fabric / upgrade / footrest
        MSRPs, exactly as the configurator adds them; if any part has no MSRP the configuration has none
     2. otherwise HCPS CALCULATED RETAIL = Golden's STANDARD dealer price × 2 (owner-approved fallback), only for the plain
        item (no add-ons), only when Golden reports price_source "standard" (never a promotion or the dealer's own
        account price), and only when it is at or above Golden's eMAP (advertising rules, _retail_price.js)
     3. otherwise none ("Price on request")

   Answer: { ok, price, label: 'MSRP' | 'Price' | null, source: 'msrp' | 'calculated' | 'none', reason? } — never the
   dealer price, the eMAP or the account. Read-only: one catalog read (+ one configuration read for a configured chair),
   through the same gate the 360 Dealer Portal uses for Golden (_golden_storefront.access). Golden's wholesale prices,
   order totals, freight and ordering API are not touched. Any failure → no price (fail closed). */
'use strict';
const GC = require('./_golden_client.js');
const GS = require('./_golden_storefront.js');
const RP = require('./_retail_price.js');
const SKU_RE = /^[A-Z0-9][A-Z0-9-]{1,39}$/;
const CFG_SKU = /^PR\d{3}-[A-Z]{3}$/, CFG_COLOR = /^[A-Z0-9]{3}$/, FABRICS = ['std', 'xover', 'brisa'], TIERS = ['standard', 'irheat', 'hvib', 'nirvana'];   // = golden-proxy's
const num = (v) => (typeof v === 'number' && isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : null);

/* "SKU" or "SKU|fabric|colour|tier|footrest(0|1)" (the 360 Dealer Portal's configuration key) → parts, or null */
function parseCode(code) {
  const s = String(code || '').trim(); if (!s || s.length > 120 || /\|u=/.test(s)) return null;
  const p = s.split('|'); const sku = p[0].toUpperCase(); if (!SKU_RE.test(sku)) return null;
  if (p.length === 1) return { sku, configured: false };
  const fab = String(p[1] || 'std').toLowerCase(), color = String(p[2] || '').toUpperCase(), tier = String(p[3] || 'standard').toLowerCase(), foot = p[4] === '1';
  if (!CFG_SKU.test(sku) || !FABRICS.includes(fab) || (color && !CFG_COLOR.test(color)) || !TIERS.includes(tier)) return null;
  return { sku, configured: true, fab, color, tier, foot };
}
/* the configurator's own sum: size + fabric (non-standard) + upgrade (unless included / standard) + footrest */
function configuredMsrp(c, k) {
  if (!c || typeof c !== 'object') return null;
  const size = (Array.isArray(c.sizes) ? c.sizes : []).find((x) => x && String(x.sku).toUpperCase() === k.sku);
  const parts = [num(size && size.msrp)];
  if (k.fab !== 'std') { const t = (Array.isArray(c.tabs) ? c.tabs : []).find((x) => x && x.key === k.fab); parts.push(num(t && t.msrp)); }
  const tiers = c.tiers || {};
  if (!(tiers.included === true) && k.tier !== 'standard') { const o = (Array.isArray(tiers.options) ? tiers.options : []).find((x) => x && x.key === k.tier); parts.push(num(o && o.msrp)); }
  if (k.foot) { if (!(c.footrest && c.footrest.eligible === true)) return null; parts.push(num(c.footrest.msrp)); }
  if (parts.some((x) => x == null)) return null;
  return Math.round(parts.reduce((t, x) => t + x, 0) * 100) / 100;
}

/* review fix: Golden's catalog is read at most once a minute per Golden account (a warm function reuses it), and a quote
   with many Golden lines shares one gate check and one catalog read (ctx). Never shared across accounts. */
const CACHE = new Map(), TTL = 60000;
async function catalogFor(deleg) {
  const key = JSON.stringify([deleg.sub_dealer, deleg.sub_branch, deleg.acct || null]); const hit = CACHE.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.r;
  const r = await GC.call({ method: 'GET', path: '/v1/catalog', delegation: deleg });
  if (r && r.ok) { if (CACHE.size > 50) CACHE.delete(CACHE.keys().next().value); CACHE.set(key, { at: Date.now(), r }); }
  return r;
}
/* dealerId = the HCPS location the brochure / quote is for. policy = Golden's recorded advertising rule (default eMAP). */
async function retailFor(sbGet, dealerId, code, flags, policy, ctx) {
  const none = (reason) => ({ ok: true, price: null, label: null, source: 'none', reason });
  const k = parseCode(code); if (!k) return none('not_priced');
  const a = ctx && ctx.access ? ctx.access : await GS.access(sbGet, dealerId, flags); if (ctx) ctx.access = a; if (!a.ok) return none(a.reason);
  const deleg = Object.assign({ sub_dealer: a.c.sub_dealer, sub_branch: a.c.sub_branch, actor: 'retail:' + String(dealerId).slice(0, 40), role: 'hcps_staff' }, a.acct ? { acct: a.acct } : {});
  const cat = await catalogFor(deleg);
  const j = cat && cat.json;
  if (!cat || !cat.ok || !j || j.linked !== true || !Array.isArray(j.products)) return none(cat && cat.ok && j && j.linked !== true ? 'not_linked' : 'golden_unavailable');
  const g = j.products.find((p) => p && String(p.sku).toUpperCase() === k.sku); if (!g) return none('not_found');
  const plain = !k.configured || (k.fab === 'std' && (k.tier === 'standard' || !k.tier) && !k.foot);
  let msrp = null;
  if (plain) msrp = num(g.msrp);
  else {
    const q = { sku: k.sku, fabric: k.fab }; if (k.color) q.color = k.color; if (k.tier && k.tier !== 'standard') q.tier = k.tier;
    const cf = await GC.call({ method: 'GET', path: '/v1/config', query: q, delegation: deleg });
    if (!cf || !cf.ok || !cf.json) return none('golden_unavailable');
    msrp = configuredMsrp(cf.json.config, k);
  }
  const d = RP.decide({ msrp, cost: plain && g.price_source === 'standard' ? num(g.dealer_price) : null, map: num(g.emap), policy: policy || 'map' });
  if (d.source === 'call') return none(d.flags.length ? d.flags[d.flags.length - 1].flag : 'no_price');
  return { ok: true, price: d.price, label: d.label, source: d.source };
}
module.exports = { retailFor, parseCode, configuredMsrp };
