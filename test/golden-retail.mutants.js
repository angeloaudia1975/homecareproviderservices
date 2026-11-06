/* Mutation check for C3-07 P4 (Golden brochure / quote retail): golden-retail.test.js + quotes.test.js must fail on every mutant. */
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const F = (n) => path.join(__dirname, '..', 'netlify', 'functions', n);
const C2 = F('_storefront_catalog.js'), G = F('_golden_retail.js'), P = F('golden-proxy.js'), Q = F('_quote_doc.js'), A = F('dealer-quotes-api.js');
const M = [
  { f: G, from: "cost: plain && g.price_source === 'standard' ? num(g.dealer_price) : null", to: 'cost: num(g.dealer_price)', why: 'promotion / account price used as cost' },
  { f: G, from: "map: num(g.emap)", to: 'map: null', why: 'eMAP not checked' },
  { f: G, from: "if (parts.some((x) => x == null)) return null;", to: '', why: 'configuration with an unpriced part priced' },
  { f: G, from: "if (k.foot) { if (!(c.footrest && c.footrest.eligible === true)) return null;", to: "if (k.foot) { if (false) return null;", why: 'ineligible footrest priced' },
  { f: G, from: "if (!s || s.length > 120 || /\\|u=/.test(s)) return null;", to: "if (!s || s.length > 120) return null;", why: 'upgrade priced' },
  { f: G, from: "if (!cf || !cf.ok || !cf.json) return none('golden_unavailable');\n    msrp = configuredMsrp(cf.json.config, k);", to: "msrp = num(g.msrp);", why: 'configuration priced as the plain chair' },
  { f: G, from: "j.linked !== true ||", to: '', why: 'unlinked dealer priced' },
  { f: P, from: 'if(!who) return json(401, { ok:false, error:"unauthorized" });', to: 'if(!who) who = { dealer_id: "11111111-1111-1111-1111-111111111111" };', why: 'no sign-in needed' },
  { f: Q, from: "unit = g && g.price != null ? g.price : null;", to: 'unit = l.unit;', why: 'page figure trusted on a quote' },
  { f: Q, from: "(l.calc ? '<div class=\"sub\">Retail price</div>' : '<div class=\"sub\">MSRP</div>')", to: "'<div class=\"sub\">MSRP</div>'", why: 'calculated price labelled MSRP on a quote' },
  { f: A, from: 'golden.set(code, await GR.retailFor(sbGet, locationId, code, f, pol, ctx));', to: 'golden.set(code, await GR.retailFor(sbGet, locationId, code, f, "open", ctx));', why: 'advertising rule ignored on a quote' },
  { f: G, from: "if (hit && Date.now() - hit.at < TTL) return hit.r;", to: '', why: 'Golden catalog read for every line' },
  { f: G, from: "const key = JSON.stringify([deleg.sub_dealer, deleg.sub_branch, deleg.acct || null]);", to: "const key = 'all';", why: 'catalog cache shared across Golden accounts' },
  { f: A, from: 'msrp.set(l.mfr + "|" + l.sku, d && d.price != null ? { price: d.price, calc: d.source === "calculated" } : null);', to: 'msrp.set(l.mfr + "|" + l.sku, d && d.price != null ? { price: d.price, calc: false } : null);', why: 'calculated retail labelled MSRP on a quote' },
  { f: C2, from: "if (!d.active) { d.price = null; d.label = 'Call for Price'; d.source = 'call'; }", to: '', why: 'discontinued product priced' },
  { f: C2, from: "const d = RP.decide({ msrp: msrpV, cost: c && c.cost, map: mm.map, msrpMap: mm.msrpMap, policy });", to: "const d = RP.decide({ msrp: msrpV, cost: c && c.cost, map: mm.map, msrpMap: mm.msrpMap, policy: 'open' });", why: 'advertising rules ignored for defaults' },
  { f: C2, from: "const msrpV = facts.msrp.get(String(p.code)) || (c && c.msrp) || null;", to: "const msrpV = facts.msrp.get(String(p.code)) || null;", why: 'official MSRP from the commercial catalog ignored' },
  { f: A, from: "const allowed = new Set((dm || []).map((r) => r.manufacturer));", to: "const allowed = new Set(ask.map((x) => x.m));", why: 'unauthorized line priced' },
];
const runs = ['golden-retail.test.js', 'quotes.test.js'];
const run = () => runs.every((t) => spawnSync(process.execPath, [path.join(__dirname, t)], { encoding: 'utf8' }).status === 0);
if (!run()) { console.log('CONTROL FAILED'); process.exit(1); }
let k = 0; const s = [];
for (const m of M) { const o = fs.readFileSync(m.f, 'utf8'); if (!o.includes(m.from)) { s.push(m.why + ' (missing)'); continue; }
  fs.writeFileSync(m.f, o.replace(m.from, m.to)); try { if (!run()) k++; else s.push(m.why); } finally { fs.writeFileSync(m.f, o); } }
console.log(`golden retail mutants: ${k}/${M.length} killed${s.length ? ' — survivors: ' + s.join('; ') : ''}`); process.exit(s.length ? 1 : 0);
