/* Runs test/mi1a-compat.test.js once clean (must pass) and once per mutant (must fail). */
const { spawnSync } = require('child_process');
const path = require('path');
const TABLE = path.join(__dirname, 'mi1a-compat.mutants.table.js');
const table = require(TABLE);
function run(m) {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'mi1a-compat.test.js')],
    { env: Object.assign({}, process.env, m ? { P0_MUTANT: m, P0_MUTANT_TABLE: TABLE } : {}), encoding: 'utf8', timeout: 120000 });
  const out = (r.stdout || '') + (r.stderr || '');
  if (/MUTANT ANCHOR NOT FOUND/.test(out)) return { skipped: true };
  const x = out.match(/(\d+) passed, (\d+) failed/); return { failed: x ? +x[2] : 1 };
}
const c = run(null); console.log('CONTROL:', c.failed === 0 ? 'clean' : c.failed + ' FAILURES');
let killed = 0; const bad = [];
for (const n of Object.keys(table)) { const r = run(n);
  if (r.skipped) { bad.push(n); console.log('SKIPPED  ' + n); } else if (r.failed > 0) { killed++; console.log('killed   ' + n); } else { bad.push(n); console.log('SURVIVED ' + n); } }
console.log(`\n${killed}/${Object.keys(table).length} killed`);
process.exitCode = (c.failed || bad.length) ? 1 : 0;
