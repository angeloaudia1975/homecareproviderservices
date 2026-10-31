/* Runs the Smart Email Learning Phase 1 suites clean (must pass) and once per mutant (must fail). JS mutants are applied in
   memory by phase0-mock's loader; SQL mutants run against a temporary copy of the migration (EL1_SQL). Nothing in the repo
   changes on disk. SQL mutants need Postgres (PGHOST / PGUSER / PGPASSWORD). */
const { spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
// Phase 1 and Phase 2 tables run one after the other (each with its own control).
const TABLES = [path.join(__dirname, 'email-learning.mutants.table.js'), path.join(__dirname, 'email-learning-p2.mutants.table.js')];
const SQLF = { sql: [path.join(__dirname, '..', 'supabase', 'email_learning_p1_capture.sql'), 'EL1_SQL'],
               sql2: [path.join(__dirname, '..', 'supabase', 'email_learning_p2_rules.sql'), 'EL2_SQL'] };
const SUITES = { js: 'email-learning-p1.test.js', pg: 'email-learning-p1.pg.test.js', js2: 'email-learning-p2.test.js', pg2: 'email-learning-p2.pg.test.js' };
function run(suite, env) {
  const r = spawnSync(process.execPath, [path.join(__dirname, SUITES[suite])], { env, encoding: 'utf8', timeout: 300000 });
  const out = (r.stdout || '') + (r.stderr || '');
  if (/MUTANT ANCHOR NOT FOUND/.test(out) || /SKIP:/.test(out)) return { skipped: true, out };
  const m = out.match(/(\d+) passed, (\d+) failed/); return { failed: m ? +m[2] : 1 };
}
let killed = 0, total = 0; const survived = [], skipped = [];
for (const s of Object.keys(SUITES)) { const r = run(s, Object.assign({}, process.env)); console.log(`clean ${s}: ${r.skipped ? 'SKIPPED' : r.failed ? r.failed + ' FAILURES' : 'pass'}`); if (r.failed) process.exitCode = 1; }
for (const TABLE of TABLES) { const table = require(TABLE); total += Object.values(table).filter(m => !m.control).length;
for (const [name, m] of Object.entries(table)) {
  const env = Object.assign({}, process.env); let tmp = null;
  if (SQLF[m.file]) {
    const [SQL, VAR] = SQLF[m.file]; let src = fs.readFileSync(SQL, 'utf8');
    if (src.split(m.from).length !== 2 || (m.also_sql && src.split(m.also_sql.from).length !== 2)) { skipped.push(name); console.log('ANCHOR?  ' + name); continue; }
    src = src.replace(m.from, () => m.to); if (m.also_sql) src = src.replace(m.also_sql.from, () => m.also_sql.to);   // a second edit, same file
    tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'el-')), 'm.sql'); fs.writeFileSync(tmp, src); env[VAR] = tmp;
  } else { env.P0_MUTANT = name; env.P0_MUTANT_TABLE = TABLE; }
  const r = run(m.suite, env);
  if (tmp) fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  if (r.skipped) { skipped.push(name); console.log('SKIPPED  ' + name); continue; }
  const dead = r.failed > 0;
  if (m.control) { console.log((dead ? 'CONTROL DIED ' : 'control survived ') + name); if (dead) survived.push(name); continue; }
  if (dead) { killed++; console.log('killed   ' + name); } else { survived.push(name); console.log('SURVIVED ' + name); }
}
}
console.log(`\n${killed}/${total} killed, ${survived.length} survived, ${skipped.length} skipped`);
process.exitCode = (process.exitCode || survived.length || skipped.length) ? 1 : 0;
