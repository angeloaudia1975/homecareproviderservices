/* Mutants for the Golden retail reference (owner directive 2026-11-06 §7). Each must fail test/golden-ref.test.js.
   node test/golden-ref.mutants.js */
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const F = path.join(__dirname, '..', 'netlify', 'functions', '_golden_ref.js');
const M = [
  { from: "std = g.price_source === 'standard' ? pos(g.dealer_price) : null;", to: "std = pos(g.dealer_price);", why: 'account price stored in the shared reference' },
  { from: "if (stored && now - Date.parse(stored.at) <= STALE_MAX) {", to: "if (stored) {", why: 'a reference older than 7 days used' },
  { from: "const fresh = stored && now - Date.parse(stored.at) < REFRESH_EVERY;", to: "const fresh = false;", why: 'reference rewritten on every report' },
  { from: "if (!(r.v && r.v.ok) && Date.now() - t0 < RETRY_IF_FAST)", to: "if (!(r.v && r.v.ok))", why: 'slow Golden retried past the bound' },
  { from: "return { reason: 'timeout' }; }", to: "return { products: [] }; }", why: 'a timeout treated as an empty catalog (silent zero)' },
  { from: "got.reason === 'no_access' || got.reason === 'not_linked' ? 'golden_not_connected' : 'golden_unavailable'", to: "'golden_unavailable'", why: 'not connected reported as a failure' },
  { from: "base_price: own.has(k) ? own.get(k) : null });", to: "base_price: x.d });", why: 'a stored price used as the dealer\'s own price' },
  { from: "ref: x.m || (x.d ? r2(2 * x.d) : null)", to: "ref: x.m || null", why: 'no 2× standard fallback' },
  { from: "if (j.linked !== true) return { reason: 'not_linked' };", to: "", why: 'unlinked account treated as a live catalog' },
  { from: "MEM.mon.unavailable++;", to: "", why: 'unavailability not monitored' },
];
const run = () => spawnSync(process.execPath, [path.join(__dirname, 'golden-ref.test.js')], { encoding: 'utf8' });
if (run().status !== 0) { console.log('CONTROL FAILED'); process.exit(1); }
let k = 0; const s = [], bad = [];
for (const m of M) { const o = fs.readFileSync(F, 'utf8'); if (!o.includes(m.from)) { bad.push(m.why); continue; }
  fs.writeFileSync(F, o.replace(m.from, m.to)); try { if (run().status !== 0) k++; else s.push(m.why); } finally { fs.writeFileSync(F, o); } }
console.log(`golden-ref mutants: ${k}/${M.length - bad.length} killed${s.length ? ' — survivors: ' + s.join('; ') : ''}${bad.length ? ' — missing anchors: ' + bad.join('; ') : ''}`);
process.exit(s.length || bad.length ? 1 : 0);
