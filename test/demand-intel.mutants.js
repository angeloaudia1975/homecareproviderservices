/* Mutation check for C3-07 Stage 8 demand intelligence: test/demand-intel.test.js must fail on every mutant. */
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const F = (n) => path.join(__dirname, '..', 'netlify', 'functions', n);
const D = F('_demand.js'), A = F('demand-intel-api.js');
const M = [
  { f: D, from: "return d && !d.is_test && (!scopeIds || scopeIds.has(String(id)));", to: "return d && (!scopeIds || scopeIds.has(String(id)));", why: 'TEST dealers counted' },
  { f: D, from: "return d && !d.is_test && (!scopeIds || scopeIds.has(String(id)));", to: "return d && !d.is_test;", why: 'scope ignored' },
  { f: D, from: "p.inquiries > 0 && p.dealers_ordering_12m <= 1", to: "p.dealers_ordering_12m <= 1", why: 'views-only products called requested' },
  { f: D, from: "p.inquiries > 0 && p.dealers_ordering_12m <= 1", to: "p.inquiries > 0", why: 'widely ordered called rarely ordered' },
  { f: D, from: ".filter((x) => !(bought.get(x.dealer_id) || new Set()).has(x.manufacturer + '|' + x.code))", to: "", why: 'bought products called opportunities' },
  { f: D, from: "const sortI = (a, b) => b.inquiries - a.inquiries || b.views - a.views;", to: "const sortI = (a, b) => b.views - a.views;", why: 'requests not ranked first' },
  { f: D, from: "const nameOf = (m, c) => (names[m] && names[m][c]) || c;", to: "const nameOf = (m, c) => c;", why: 'catalog names lost' },
  { f: A, from: "x.companies.add(d.root);", to: "x.companies.add(String(s.dealer_id));", why: 'branches counted as companies' },
  { f: A, from: "if (!d || d.is_test || !s.product_code) continue;", to: "if (!d || !s.product_code) continue;", why: 'TEST purchases counted' },
  { f: A, from: "&status=neq.cancelled", to: "", why: 'cancelled orders count as ordering' },
  { f: A, from: "if (!scope.isAll && !scope.ids.has(String(b.dealer_id))) return json(403", to: "if (false) return json(403", why: 'dealer action unscoped' },
  { f: A, from: "if (!me) return json(401", to: "if (false) return json(401", why: 'no sign-in needed' },
  { f: A, from: "return su && su.active !== false ?", to: "return su ?", why: 'inactive staff allowed' },
  { f: A, from: "storefront_daily_counts?day=gte.${since}", to: "storefront_daily_counts?day=gte.1900-01-01", why: 'period ignored' },
  { f: A, from: "if (/PGRST205|42P01/.test(String(e.message))) return { installed: false }; throw e;", to: "return { installed: false };", why: 'read errors hidden as not installed' },
];
const run = () => spawnSync(process.execPath, [path.join(__dirname, 'demand-intel.test.js')], { encoding: 'utf8' });
if (run().status !== 0) { console.log('CONTROL FAILED'); process.exit(1); }
let k = 0; const s = [];
for (const m of M) { const o = fs.readFileSync(m.f, 'utf8'); if (!o.includes(m.from)) { s.push(m.why + ' (missing)'); continue; }
  fs.writeFileSync(m.f, o.replace(m.from, m.to)); try { if (run().status !== 0) k++; else s.push(m.why); } finally { fs.writeFileSync(m.f, o); } }
console.log(`demand-intel mutants: ${k}/${M.length} killed${s.length ? ' — survivors: ' + s.join('; ') : ''}`); process.exit(s.length ? 1 : 0);
