/* Mutation check for _commission_auto.js: each mutant weakens one safeguard; test/commission-auto.pg.test.js must fail
   for every one (a surviving mutant = a safeguard no test protects). The mutated copy is written beside the original
   under a temporary name, loaded by the test through COMMISSION_AUTO_PATH, and always removed.
     PGHOST=127.0.0.1 PGUSER=postgres PGPASSWORD=… node test/commission-auto.mutants.js */
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const SRC = path.join(__dirname, '..', 'netlify', 'functions', '_commission_auto.js');
const TMP = path.join(__dirname, '..', 'netlify', 'functions', '_commission_auto.mutant.js');
const M = [
  ['no unmatched-dealer hold', 'if (review.unmatched_count || review.held_rows', 'if (false && (review.unmatched_count || review.held_rows)'],
  ['problems ignored', 'if (probs.length) {', 'if (false) {'],
  // Not a mutant here: 'every month' vs 'any month' cannot differ while automatic statements are single-month (a
  // multi-month record is an exception before this check), so that edit is equivalent and is not listed.
  ['identical waives every problem', 'probs.every(p => p.error === "decision_required" || p.error === "paid_period_change")', 'true'],
  ['no result check', 'if (Number(ww.rows) !== Number(dw.rows) || R2(ww.commission) !== R2(dw.commission) || R2(ww.amount) !== R2(dw.amount))', 'if (false)'],
  ['no rollback on link refusal', 'if (!ln.ok) return rollback("link_refused"', 'if (false) return rollback("link_refused"'],
  ['sha not checked', 'if (sha256(bytes) !== src.file_sha256)', 'if (false)'],
  ['statement gate skipped', 'if (!gate.ok) return held("statement_incomplete"', 'if (false) return held("statement_incomplete"'],
  ['multi-month accepted', 'if (!period || ym(src.report_period_end || src.report_period_start) !== period)', 'if (!period)'],
  ['SR032 problems ignored', 'if (!s.ok) return held("statement_problems"', 'if (false) return held("statement_problems"'],
  ['finished records re-processed', 'if (last && last.detail.final && last.detail.sha === src.file_sha256) continue;', ''],
  ['rolled-back retried', 'if (last && (last.outcome === "rolled_back" || (last.outcome === "error" && last.batch_id)) && last.detail.sha === src.file_sha256) continue;', ''],
  ['switch ignored', 'if (!(await flagOn("mi_commission_v2"))) return { ok: true, skipped: "switch_off" };', ''],
  ['logged every run', 'const changed = !last ||', 'const changed = true ||'],
  ['manual link: several accepted', 'if (after.length === 1) {', 'if (after.length >= 1) {'],
];
const orig = fs.readFileSync(SRC, 'utf8');
const control = spawnSync(process.execPath, [path.join(__dirname, 'commission-auto.pg.test.js')], { encoding: 'utf8', env: process.env });
if (control.status !== 0) { console.log('CONTROL FAILED — fix the suite first\n' + control.stdout.slice(-800)); process.exit(1); }
let killed = 0; const survived = [];
try {
  for (const [name, from, to] of M) {
    if (!orig.includes(from)) { console.log('  ANCHOR NOT FOUND: ' + name); survived.push(name + ' (anchor)'); continue; }
    fs.writeFileSync(TMP, orig.split(from).join(to));
    const r = spawnSync(process.execPath, [path.join(__dirname, 'commission-auto.pg.test.js')], { encoding: 'utf8', env: Object.assign({}, process.env, { COMMISSION_AUTO_PATH: TMP }) });
    if (r.status !== 0) { killed++; console.log('  killed   ' + name); } else { survived.push(name); console.log('  SURVIVED ' + name); }
  }
} finally { try { fs.unlinkSync(TMP); } catch (e) {} }
console.log(`\ncommission-auto mutants: ${killed}/${M.length} killed${survived.length ? ' — survived: ' + survived.join(', ') : ''}`);
process.exit(survived.length ? 1 : 0);
