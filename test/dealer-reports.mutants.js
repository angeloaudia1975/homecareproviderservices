/* Mutation check for C3-07 Stage 6 dealer reports: test/dealer-reports.test.js must fail on every mutant. */
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const R = path.join(__dirname, '..', 'netlify', 'functions', '_dealer_report.js'), A = path.join(__dirname, '..', 'netlify', 'functions', 'dealer-reports-api.js');
const M = [
  { f: R, from: 'if (n > 0) { salesKeys.set(k, n - 1); notes.duplicates_removed++; continue; }', to: 'if (false) { }', why: 'commission duplicate counted twice' },
  { f: R, from: "if (v == null || v === '') return null; ", to: '', why: 'blank amount counted as $0' },
  { f: R, from: "const live = orders.filter((o) => o.status !== 'cancelled' && inW.has(ym(o.submitted_at)));", to: 'const live = orders.filter((o) => inW.has(ym(o.submitted_at)));', why: 'cancelled portal orders counted' },
  { f: R, from: 'const covered = (s) => !!coverage[s] && coverage[s] <= W.prior[0];', to: 'const covered = (s) => true;', why: 'year-over-year against missing history' },
  { f: R, from: 'const MIN_DEALERS = 3;', to: 'const MIN_DEALERS = 2;', why: 'opportunity from 2 dealers' },
  { f: R, from: '!retired(n.manufacturer) && ', to: '', why: 'retired line suggested' },
  { f: R, from: "!recent.has(n.manufacturer + '|' + n.code) && ", to: '', why: 'already-bought item suggested' },
  { f: R, from: 'c.change_pct <= -20)', to: 'c.change_pct <= -95)', why: 'declining category missed' },
  { f: R, from: '&& numbersOk(r.title + \' \' + r.detail, F))', to: ')', why: 'AI invented number kept' },
  { f: R, from: '&& r.refs.every((x) => ids.has(x))', to: '', why: 'AI unknown fact kept' },
  { f: A, from: "if (!dl || familyIds.has(dl) || tests.has(dl) || !r.product_code) continue;", to: 'if (!dl || tests.has(dl) || !r.product_code) continue;', why: 'own company counted in network' },
  { f: A, from: "if (!dl || familyIds.has(dl) || tests.has(dl) || !r.product_code) continue;", to: 'if (!dl || familyIds.has(dl) || !r.product_code) continue;', why: 'TEST dealer counted in network' },
  { f: A, from: "if (scope === 'company' && !headOffice) scope = did;", to: '', why: 'branch sees company' },
  { f: A, from: "if (scope !== 'company' && !locations.some((l) => l.id === scope))", to: 'if (false)', why: 'foreign location readable' },
  { f: A, from: "&order=id.asc`),\n    sb('GET', `orders?", to: "&order=id.asc`).catch(() => []),\n    sb('GET', `orders?", why: 'unreadable purchases shown as none' },
  { f: A, from: "if (b.action === 'report_ai' && who.preview)", to: 'if (false)', why: 'AI in read-only preview' },
  { f: A, from: "if (hist.length >= 4)", to: 'if (false)', why: 'no AI limit' },
];
const run = () => spawnSync(process.execPath, [path.join(__dirname, 'dealer-reports.test.js')], { encoding: 'utf8' });
if (run().status !== 0) { console.log('CONTROL FAILED'); process.exit(1); }
let k = 0; const s = [];
for (const m of M) { const o = fs.readFileSync(m.f, 'utf8'); if (!o.includes(m.from)) { s.push(m.why + ' (missing)'); continue; }
  fs.writeFileSync(m.f, o.replace(m.from, m.to)); try { if (run().status !== 0) k++; else s.push(m.why); } finally { fs.writeFileSync(m.f, o); } }
console.log(`dealer-reports mutants: ${k}/${M.length} killed${s.length ? ' — survivors: ' + s.join('; ') : ''}`); process.exit(s.length ? 1 : 0);
