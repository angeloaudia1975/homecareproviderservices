/* REPORT CATALOG (owner directive 2026-11-06 17:40 CT, Priorities 5 + 6). One place that tells the reports, for a product a
   dealer bought, (a) its Shop category and (b) its SHOP RETAIL REFERENCE price — so Reports, Total Sales, PDF and Excel never
   disagree.
     category — the Shop's own merged product (commercial record + enrichment, the storefront's merge) → the line's catalog
                file → Golden's integrated catalog → a verified legacy SKU mapping; signs, brochures and displays → "Marketing &
                Displays". Nothing is guessed: an unknown product is reported as not matched.
     reference — per ORDER UNIT, as the dealer bought it: official manufacturer MSRP (a per-piece MSRP on a pack × the pack
                quantity) → HCPS calculated retail = 2 × STANDARD dealer cost (no contract price, no promotion) → none. Never 2×
                a purchase total. Golden: Golden's MSRP for the item as catalogued (no chair upgrade is priced — Golden's
                upgrades are not on the purchase line) → 2 × Golden's standard dealer price → none.
   Valuation is internal (dealer reports), so advertising rules (MAP / no-price) do not hide a reference here.
   Read-only. A line whose catalog can't be read gives no reference (counted as a gap), never a guessed one. */
'use strict';
const SC = require('./_storefront_catalog.js');
const SF = require('./_storefront.js');
const GS = require('./_golden_storefront.js');
const GR = require('./_golden_retail.js');
const GOLDEN = new Set(['golden', 'golden-technologies']);
const MARKETING = 'Marketing & Displays';
const MKT_RE = /\b(sign|signs|brochure|brochures|trifold|tri-fold|wobbler|display|displays|banner|poster|flyer|literature|catalog|catalogue|counter card|shelf talker|pop)\b/i;
/* verified legacy SKU mappings: a code a manufacturer report prints that the current catalog spells differently. Each needs
   source evidence (the report's own product name) — recorded with it. */
const LEGACY = { 'strongback-mobility': { '1010+AB-2025': { code: '1010AB', evidence: 'Strongback order export prints "STRONGBACK24+AB-2025* (1010+AB-2025)" = Comfort 24" 20" with AB (1010AB)' } } };
const r2 = (n) => Math.round(Number(n) * 100) / 100;
const pos = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? r2(n) : null; };

/* a purchase line's product is "marketing" when its name or code says so (a $0 sign, brochure, display) */
function isMarketing(code, name) { return MKT_RE.test(String(name || '')) || MKT_RE.test(String(code || '')); }

/* line catalog for a non-Golden line: Map UPPER(code) → { code, name, category, ref, ref_source } */
async function lineCatalog(deps, slug) {
  const L = await SC.lineData(deps, slug, false);
  const out = new Map();
  const merged = new Map((L.merged || []).map((p) => [String(p.code).toUpperCase(), p]));
  const fileBy = new Map((L.file || []).map((p) => [String(p.code).toUpperCase(), p]));
  const codes = new Set([...merged.keys(), ...fileBy.keys()]);
  for (const C of codes) {
    const m = merged.get(C), f = fileBy.get(C), p = m || f;
    const rec = L.facts && L.facts.unit ? L.facts.unit.get(String(p.code)) : null;
    const c = L.costs ? L.costs.get(String(p.code)) : null;
    const msrp = (L.facts && L.facts.msrp.get(String(p.code))) || (c && c.msrp) || null;
    let ref = null, src = 'none';
    if (msrp) { const unit = SF.unitOf(p, rec); const q = Number((rec && rec.case_qty) || p.case_qty) || 1;
      ref = unit === 'each' && q > 1 ? r2(msrp * q) : r2(msrp); src = 'msrp'; }
    else if (c && pos(c.cost)) { ref = r2(2 * c.cost); src = 'calculated'; }
    out.set(C, { code: String(p.code), name: (m && m.name) || (f && f.name) || '', category: (m && m.category) || (f && f.category) || null, ref, ref_source: src, cost: c && pos(c.cost) ? pos(c.cost) : null });
  }
  return { byCode: out, readable: !!L.costs };
}
/* Golden catalog for the dealer's own Golden account (Golden's authorization), or null */
async function goldenCatalog(sbGet, dealerId, flags) {
  const a = await GS.access(sbGet, dealerId, flags); if (!a.ok) return null;
  const deleg = Object.assign({ sub_dealer: a.c.sub_dealer, sub_branch: a.c.sub_branch, actor: 'report:' + String(dealerId).slice(0, 40), role: 'hcps_staff' }, a.acct ? { acct: a.acct } : {});
  const cat = await GR.catalogFor(deleg); const j = cat && cat.json;
  if (!cat || !cat.ok || !j || j.linked !== true || !Array.isArray(j.products)) return null;
  const out = new Map();
  for (const g of j.products) {
    if (!g || !g.sku) continue;
    const msrp = pos(g.msrp), std = g.price_source === 'standard' ? pos(g.dealer_price) : null;
    out.set(String(g.sku).toUpperCase(), { code: String(g.sku), name: String(g.name || g.title || ''), category: g.category ? String(g.category) : null,
      ref: msrp || (std ? r2(2 * std) : null), ref_source: msrp ? 'msrp' : std ? 'calculated' : 'none', cost: std,
      /* the dealer's own Golden price for the base model (any price source) — used ONLY to tell whether a configured purchase
         cost more than the base model (a paid upgrade), never as a retail reference */
      base_price: pos(g.dealer_price) });
  }
  return { byCode: out, readable: true };
}
/* find a purchase code in a line catalog: exact → verified legacy mapping → Golden configuration suffix ("GB108B-ST" →
   "GB108B"; "PR118-MSM" is itself a Golden SKU). Returns { entry, matched_by } or null. */
function lookup(cat, slug, code) {
  if (!cat || !code) return null;
  const C = String(code).trim().toUpperCase();
  if (cat.byCode.has(C)) return { entry: cat.byCode.get(C), matched_by: 'exact' };
  const lg = LEGACY[slug] && (LEGACY[slug][String(code).trim()] || LEGACY[slug][C]);
  if (lg && cat.byCode.has(lg.code.toUpperCase())) return { entry: cat.byCode.get(lg.code.toUpperCase()), matched_by: 'legacy', evidence: lg.evidence };
  if (GOLDEN.has(slug)) { let c = C; for (let i = 0; i < 2 && /-[A-Z0-9]{1,4}$/.test(c); i++) { c = c.replace(/-[A-Z0-9]{1,4}$/, ''); if (cat.byCode.has(c)) return { entry: cat.byCode.get(c), matched_by: 'golden_base' }; } }
  return null;
}
/* the dealer's live Golden catalog call, for _golden_ref (Golden's own authorization; { reason:'no_access' } without it) */
function goldenFetcher(sbGet, dealerId, flags) {
  return async () => {
    const a = await GS.access(sbGet, dealerId, flags); if (!a.ok) return { reason: 'no_access' };
    const deleg = Object.assign({ sub_dealer: a.c.sub_dealer, sub_branch: a.c.sub_branch, actor: 'report:' + String(dealerId).slice(0, 40), role: 'hcps_staff' }, a.acct ? { acct: a.acct } : {});
    return GR.catalogFor(deleg);
  };
}
module.exports = { goldenFetcher, lineCatalog, goldenCatalog, lookup, isMarketing, MARKETING, LEGACY, GOLDEN };
