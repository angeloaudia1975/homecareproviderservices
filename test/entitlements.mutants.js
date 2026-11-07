/* Mutants: Dealer Manager is the only ordering source; imports never grant (owner 2026-11-06 §2/§3). node test/entitlements.mutants.js */
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const F = (n) => path.join(__dirname, '..', 'netlify', 'functions', n);
const M = [
  { f: F('_access.js'), from: "if (hasGrid || gridOnly) {", to: "if (hasGrid) {", why: 'territory fallback survives grid-only' },
  { f: F('_access.js'), from: "if (!gridOnly && golden !== \"Account\" && st === \"KY\")", to: "if (golden !== \"Account\" && st === \"KY\")", why: 'KY Golden prospect by territory' },
  { f: F('_accountorg.js'), from: "{ dealer_id: dealerId, manufacturer: slug, account_ref: ref, active: false },\n        { Prefer: \"resolution=ignore-duplicates", to: "{ dealer_id: dealerId, manufacturer: slug, account_ref: ref, active: true },\n        { Prefer: \"resolution=ignore-duplicates", why: 'report creates an ordering row' },
  { f: F('_accountorg.js'), from: "{ dealer_id: id, manufacturer: slug, account_ref: orgPrimary, active: false }", to: "{ dealer_id: id, manufacturer: slug, account_ref: orgPrimary, active: true }", why: 'branch fill grants' },
  { f: F('_accountorg.js'), from: "const suggest = !row || row.active === false;", to: "const suggest = false;", why: 'no access suggestion' },
  { f: F('dealers-api.js'), from: "const gridRows=b.manufacturers.map(m=>({m,active:true})).concat(keepOff.map(m=>({m,active:false})));", to: "const gridRows=b.manufacturers.map(m=>({m,active:true}));", why: 'grid save erases identifiers' },
  { f: F('dealers-api.js'), from: "return json(200,{ok:true,written:0,suggested:", to: "await sbSend(\"POST\",\"dealer_manufacturers?on_conflict=dealer_id,manufacturer\",[...new Set([...(t.your_accounts||[]),...(t.available||[])])].map(m=>({dealer_id:b.dealer_id,manufacturer:m,active:true})),{Prefer:\"resolution=merge-duplicates,return=minimal\"}); return json(200,{ok:true,written:0,suggested:", why: 'territory suggestion writes' },
  { f: F('_entitlement_impact.js'), from: "if (d.is_test) continue;", to: "", why: 'TEST dealers in the impact report' },
];
const run = () => spawnSync(process.execPath, [path.join(__dirname, 'entitlements-grid-only.test.js')], { encoding: 'utf8' });
if (run().status !== 0) { console.log('CONTROL FAILED'); process.exit(1); }
let k = 0; const s = [], bad = [];
for (const m of M) { const o = fs.readFileSync(m.f, 'utf8'); if (!o.includes(m.from)) { bad.push(m.why); continue; }
  fs.writeFileSync(m.f, o.replace(m.from, m.to)); try { if (run().status !== 0) k++; else s.push(m.why); } finally { fs.writeFileSync(m.f, o); } }
console.log(`entitlement mutants: ${k}/${M.length - bad.length} killed${s.length ? ' — survivors: ' + s.join('; ') : ''}${bad.length ? ' — missing anchors: ' + bad.join('; ') : ''}`);
process.exit(s.length || bad.length ? 1 : 0);
