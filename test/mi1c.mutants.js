/* Runs the three MI-1c suites clean (all must pass) and once per mutant (its suite must fail).
   API mutants are applied in memory by phase0-mock's loader; reader/matcher mutants to a temporary copy of
   netlify/functions inside test/ (so node_modules still resolves; removed afterwards); SQL mutants to a temporary copy
   of the migration. Nothing in the repository is changed. A mutant whose anchor is missing counts as a failure of the
   run (never as killed).  Optional: node test/mi1c.mutants.js <filter>   (only mutants whose name contains it) */
const { spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const TABLE = path.join(__dirname, 'mi1c.mutants.table.js'); const table = require(TABLE);
const SQL = path.join(__dirname, '..', 'supabase', 'mi1c_dealer_intel.sql');
const FN = path.join(__dirname, '..', 'netlify', 'functions');
const only = process.argv[2] || '';
const suiteOf = m => m.file === 'sql' ? 'mi1c-intel.pg.test.js' : m.fn ? 'mi1c-parser.test.js' : 'mi1c-api.test.js';
function exec(suite, env) {
  const r = spawnSync(process.execPath, [path.join(__dirname, suite)], { env, encoding: 'utf8', timeout: 600000, maxBuffer: 64 << 20 });
  const out = (r.stdout || '') + (r.stderr || '');
  if (/MUTANT ANCHOR NOT FOUND/.test(out) || /^SKIP/m.test(out) || /did not run/.test(out)) return { skipped: true, out };
  const x = out.match(/(\d+) passed, (\d+) failed/); return { failed: x ? +x[2] : 1, out };
}
function run(name) {
  const m = table[name]; const env = Object.assign({}, process.env);
  if (m.file === 'sql') { const src = fs.readFileSync(SQL, 'utf8'); if (!src.includes(m.from)) return { skipped: true };
    const tmp = path.join(os.tmpdir(), 'mi1c-mutant-' + process.pid + '.sql'); fs.writeFileSync(tmp, src.split(m.from).join(m.to)); env.MI1C_SQL = tmp;
    try { return exec(suiteOf(m), env); } finally { fs.unlinkSync(tmp); } }
  if (m.fn) { const src = fs.readFileSync(path.join(FN, m.file), 'utf8'); if (!src.includes(m.from)) return { skipped: true };
    const dir = path.join(__dirname, '.mi1c-mutant-' + process.pid); fs.mkdirSync(dir, { recursive: true });
    try { for (const f of fs.readdirSync(FN).filter(f => /^_.*\.js$/.test(f))) fs.copyFileSync(path.join(FN, f), path.join(dir, f));
      fs.writeFileSync(path.join(dir, m.file), src.split(m.from).join(m.to)); env.MI1C_FN_DIR = dir; return exec(suiteOf(m), env); }
    finally { fs.rmSync(dir, { recursive: true, force: true }); } }
  env.P0_MUTANT = name; env.P0_MUTANT_TABLE = TABLE; return exec(suiteOf(m), env);
}
const controls = ['mi1c-api.test.js', 'mi1c-parser.test.js', 'mi1c-intel.pg.test.js'].map(s => [s, exec(s, Object.assign({}, process.env))]);
const clean = controls.every(([, r]) => !r.skipped && r.failed === 0);
console.log('CONTROL: ' + controls.map(([s, r]) => `${s} ${r.skipped ? 'DID NOT RUN' : r.failed === 0 ? 'clean' : r.failed + ' failed'}`).join(' · '));
if (!clean) { console.log('The control run is not clean — the mutant results would mean nothing. Stopping.'); process.exit(1); }
let killed = 0; const bad = []; const names = Object.keys(table).filter(n => n.includes(only));
for (const n of names) { const r = run(n);
  if (r.skipped) { bad.push(n); console.log('NOT RUN  ' + n); } else if (r.failed > 0) { killed++; console.log('killed   ' + n); } else { bad.push(n); console.log('SURVIVED ' + n); } }
console.log(`\n${killed}/${names.length} killed`);
process.exitCode = bad.length ? 1 : 0;
