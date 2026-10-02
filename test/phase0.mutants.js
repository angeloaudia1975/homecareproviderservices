/* Runs the Phase 0 suites once clean (must pass) and once per mutant (must fail). */
const { spawnSync } = require('child_process');
const path = require('path');
const table = require('./phase0.mutants.table.js');
const SUITES = ['phase0-security.test.js', 'phase0-ownership.test.js', 'phase0-scope.test.js', 'phase0-visits.test.js', 'phase0-outbox.test.js', 'phase0-contacts.test.js', 'phase0-tasks.test.js', 'phase0-roles.test.js', 'phase0-landing.test.js'];
function run(mutant) {
  let failed = 0; const notes = [];
  for (const s of SUITES) {
    const r = spawnSync(process.execPath, [path.join(__dirname, s)], { env: Object.assign({}, process.env, mutant ? { P0_MUTANT: mutant } : {}), encoding: 'utf8', timeout: 240000 });
    const out = (r.stdout || '') + (r.stderr || '');
    if (/MUTANT ANCHOR NOT FOUND/.test(out)) return { skipped: true };
    const m = out.match(/(\d+) passed, (\d+) failed/); failed += m ? +m[2] : 1;
  }
  return { failed };
}
const control = run(null);
console.log('CONTROL (no mutant):', control.failed === 0 ? 'clean' : control.failed + ' FAILURES');
let killed = 0, survived = [], skipped = [];
for (const name of Object.keys(table)) {
  const r = run(name);
  if (r.skipped) { skipped.push(name); console.log('SKIPPED  ' + name); continue; }
  if (r.failed > 0) { killed++; console.log('killed   ' + name + '  (' + r.failed + ')'); }
  else { survived.push(name); console.log('SURVIVED ' + name); }
}
console.log(`\n${killed}/${Object.keys(table).length} killed, ${survived.length} survived, ${skipped.length} skipped`);
process.exitCode = (control.failed || survived.length || skipped.length) ? 1 : 0;
