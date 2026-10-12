/* Runs the Phase C suites clean (must pass) and once per mutant (must fail). JS mutants are applied in memory by
   phase0-mock's loader; SQL mutants are written to a temporary copy of the migration (MIC_SQL). Nothing in the repo
   changes on disk. Needs Postgres for the SQL mutants (PGTEST_PSQL, PGHOST, PGPORT, PGUSER). */
const { spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const TABLE = path.join(__dirname, 'mi-c.mutants.table.js'); const table = require(TABLE);
const SQL = path.join(__dirname, '..', 'supabase', 'mi_c_shipto.sql');
const SUITES = { review: 'shipto-review.test.js', shipto: 'shipto.test.js', source: 'source-import.test.js', pg: 'mi-c-shipto.pg.test.js' };
function run(suite, env) {
  const r = spawnSync(process.execPath, [path.join(__dirname, SUITES[suite])], { env, encoding: 'utf8', timeout: 900000 });
  const out = (r.stdout || '') + (r.stderr || '');
  if (/MUTANT ANCHOR NOT FOUND/.test(out)) return { skipped: true };
  if (/^SKIP/m.test(out)) return { skipped: true };
  const x = out.match(/(\d+) passed, (\d+) failed/); return { failed: x ? +x[2] : 1 };
}
const ctl = Object.keys(SUITES).map(s => [s, run(s, Object.assign({}, process.env))]);
const clean = ctl.every(([, r]) => r.failed === 0 && !r.skipped);
console.log('CONTROL:', clean ? 'clean' : 'FAILURES ' + JSON.stringify(ctl));
let killed = 0; const bad = [];
for (const [n, m] of Object.entries(table)) {
  const env = Object.assign({}, process.env); let suite = m.suite;
  if (m.file === 'sql') { const src = fs.readFileSync(SQL, 'utf8'); if (!src.includes(m.from)) { bad.push(n); console.log('SKIPPED  ' + n); continue; }
    const tmp = path.join(os.tmpdir(), 'mic-mutant-' + process.pid + '.sql'); fs.writeFileSync(tmp, src.split(m.from).join(m.to)); env.MIC_SQL = tmp; suite = 'pg'; }
  else { env.P0_MUTANT = n; env.P0_MUTANT_TABLE = TABLE; }
  const r = run(suite, env);
  if (r.skipped) { bad.push(n); console.log('SKIPPED  ' + n); } else if (r.failed > 0) { killed++; console.log('killed   ' + n); } else { bad.push(n); console.log('SURVIVED ' + n); }
}
console.log(`\n${killed}/${Object.keys(table).length} killed`);
process.exitCode = (!clean || bad.length) ? 1 : 0;
