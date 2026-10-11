/* Runs the C1 suite once clean (must pass) and once per mutant (must fail). CONTROL must survive. */
const { spawnSync } = require('child_process');
const path = require('path');
const TABLE = path.join(__dirname, 'academy-c1.mutants.table.js');
const table = require(TABLE);
function run(mutant) {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'academy-c1.test.js')],
    { env: Object.assign({}, process.env, mutant ? { P0_MUTANT: mutant, P0_MUTANT_TABLE: TABLE } : {}), encoding: 'utf8', timeout: 120000 });
  const out = (r.stdout || '') + (r.stderr || '');
  if (/MUTANT ANCHOR NOT FOUND/.test(out)) return { skipped: true };
  const m = out.match(/(\d+) passed, (\d+) failed/); return { failed: m ? +m[2] : 1 };
}
const clean = run(null);
console.log('clean run:', clean.failed === 0 ? 'all pass' : clean.failed + ' FAILURES');
let killed = 0; const survived = [], skipped = [], badControl = [];
for (const [name, mt] of Object.entries(table)) {
  const r = run(name);
  if (r.skipped) { skipped.push(name); console.log('SKIPPED  ' + name); continue; }
  if (mt.control) { if (r.failed > 0) badControl.push(name); console.log((r.failed ? 'CONTROL FAILED ' : 'control survived ') + name); continue; }
  if (r.failed > 0) { killed++; console.log('killed   ' + name + '  (' + r.failed + ')'); } else { survived.push(name); console.log('SURVIVED ' + name); }
}
const total = Object.values(table).filter(m => !m.control).length;
console.log(`\n${killed}/${total} killed, ${survived.length} survived, ${skipped.length} skipped${badControl.length ? ', CONTROL FAILED' : ''}`);
process.exitCode = (clean.failed || survived.length || skipped.length || badControl.length) ? 1 : 0;
