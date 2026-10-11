/* Runs the MI-1b suites clean (must pass) and once per mutant (must fail). API mutants are applied in memory by
   phase0-mock's loader; SQL mutants are written to a temporary copy of the migration (MI1B_SQL). Nothing on disk
   in the repo is changed. */
const { spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const TABLE = path.join(__dirname, 'mi1b.mutants.table.js'); const table = require(TABLE);
const SQL = path.join(__dirname, '..', 'supabase', 'mi1b_report_register.sql');
function run(name) {
  const m = name ? table[name] : null; const env = Object.assign({}, process.env);
  let suite = 'mi1b-api.test.js';
  if (m && m.file === 'sql') { const src = fs.readFileSync(SQL, 'utf8'); if (!src.includes(m.from)) return { skipped: true };
    const tmp = path.join(os.tmpdir(), 'mi1b-mutant-' + process.pid + '.sql'); fs.writeFileSync(tmp, src.split(m.from).join(m.to)); env.MI1B_SQL = tmp; suite = 'mi1b-register.pg.test.js'; }
  else if (m) { env.P0_MUTANT = name; env.P0_MUTANT_TABLE = TABLE; }
  const r = spawnSync(process.execPath, [path.join(__dirname, suite)], { env, encoding: 'utf8', timeout: 300000 });
  const out = (r.stdout || '') + (r.stderr || '');
  if (/MUTANT ANCHOR NOT FOUND/.test(out)) return { skipped: true };
  if (/^SKIP/m.test(out)) return { skipped: true };
  const x = out.match(/(\d+) passed, (\d+) failed/); return { failed: x ? +x[2] : 1 };
}
const c1 = run(null); const env = Object.assign({}, process.env);
const c2 = spawnSync(process.execPath, [path.join(__dirname, 'mi1b-register.pg.test.js')], { env, encoding: 'utf8' }); const c2f = /0 failed/.test(c2.stdout || '') ? 0 : 1;
console.log('CONTROL:', c1.failed === 0 && c2f === 0 ? 'clean' : 'FAILURES');
let killed = 0; const bad = [];
for (const n of Object.keys(table)) { const r = run(n);
  if (r.skipped) { bad.push(n); console.log('SKIPPED  ' + n); } else if (r.failed > 0) { killed++; console.log('killed   ' + n); } else { bad.push(n); console.log('SURVIVED ' + n); } }
console.log(`\n${killed}/${Object.keys(table).length} killed`);
process.exitCode = (c1.failed || c2f || bad.length) ? 1 : 0;
