/* Mutants for the Total Sales / report-catalog work (owner directive 2026-11-06, Priorities 4–8). Each must fail a suite.
   node test/total-sales.mutants.js */
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const F = (n) => path.join(__dirname, '..', 'netlify', 'functions', n);
const DR = F('_dealer_report.js'), RC = F('_report_catalog.js'), XL = F('_report_xlsx.js');
const M = [
  { f: DR, from: "if (o.isMkt(r.code, r.name, r.mfr)) {", to: "if (false) {", why: 'marketing items valued' },
  { f: DR, from: "const isMkt = (c, nm, s) => mktWords(c, nm) && !listed(s, c, nm);", to: "const isMkt = (c, nm, s) => mktWords(c, nm);", why: 'a Shop product named display treated as marketing' },
  { f: DR, from: "(r.amt < 0 && !(r.qty < 0)) ? 'credit_without_units' :", to: "", why: 'amount-only credit removes a unit' },
  { f: DR, from: "(res.matched_by === 'golden_base' && !((res.base_price || res.cost) > 0 && unitCost != null && Math.abs(unitCost) <= (res.base_price || res.cost) * 1.02 + 0.01)) ? 'configuration_not_priced' : null", to: "null", why: 'upgraded Golden chair valued at base MSRP' },
  { f: DR, from: "res && res.unavailable ? 'catalog_unavailable' :", to: "", why: 'unavailable catalog not said' },
  { f: DR, from: "((input.catalog && input.catalog[n.manufacturer]) || {})[n.code] ?", to: "input.catalog[n.manufacturer][n.code] ?", why: 'P0: absent catalog file read' },
  { f: DR, from: "const ret = r2(q * res.ref);", to: "const ret = r2(2 * r.amt);", why: '2× purchases instead of the Shop reference' },
  { f: DR, from: "    const q = r.qty;\n", to: "    const q = Math.abs(r.qty);\n", why: 'return adds retail' },
  { f: DR, from: "const cRet = cp > 0 ? r2(q * cp) : ret;", to: "const cRet = ret;", why: 'custom prices ignored' },
  { f: DR, from: "margin_pct: pct1(x.retail - x.cost, x.retail)", to: "margin_pct: pct1(x.retail - x.cost, x.cost)", why: 'margin on cost' },
  { f: DR, from: "coverage_pct: pct1(cost, total)", to: "coverage_pct: 100", why: 'coverage not shown' },
  { f: DR, from: "if (scope !== 'company' && input.companyView === true && locations.length > 1) {", to: "if (scope !== 'company' && locations.length > 1) {", why: 'company figures to a branch login' },
  { f: DR, from: "units: c.filter((r) => !isMkt(r.code, r.name, r.mfr)).reduce((x, r) => x + r.qty, 0)", to: "units: c.reduce((x, r) => x + r.qty, 0)", why: 'marketing counted as product units' },
  { f: RC, from: "if (GOLDEN.has(slug)) { let c = C;", to: "if (true) { let c = C;", why: 'suffix stripping on every line' },
  { f: RC, from: "if (lg && cat.byCode.has(lg.code.toUpperCase()))", to: "if (false)", why: 'legacy mapping ignored' },
  { f: XL, from: "['Potential retail — Shop reference (MSRP, else 2× standard cost)', n(B.retail)],", to: "['Potential retail — Shop reference (MSRP, else 2× standard cost)', n(V.matched_cost * 2)],", why: 'Excel recalculates' },
];
const run = () => spawnSync(process.execPath, [path.join(__dirname, 'total-sales.test.js')], { encoding: 'utf8' });
if (run().status !== 0) { console.log('CONTROL FAILED'); process.exit(1); }
let k = 0; const s = [], bad = [];
for (const m of M) { const o = fs.readFileSync(m.f, 'utf8'); if (!o.includes(m.from)) { bad.push(m.why); continue; }
  fs.writeFileSync(m.f, o.replace(m.from, m.to)); try { if (run().status !== 0) k++; else s.push(m.why); } finally { fs.writeFileSync(m.f, o); } }
console.log(`total-sales mutants: ${k}/${M.length - bad.length} killed${s.length ? ' — survivors: ' + s.join('; ') : ''}${bad.length ? ' — missing anchors: ' + bad.join('; ') : ''}`);
process.exit(s.length || bad.length ? 1 : 0);
