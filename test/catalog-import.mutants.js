/* Mutation harness for the catalog importer core: every mutant must be killed by test/catalog-import.test.js,
   and the unmutated control must pass. */
const fs = require('fs');
const { run, SRC } = require('./catalog-import.test.js');
const base = fs.readFileSync(SRC, 'utf8');

const M = [
  ['named-account not a blocker', 'flag("blocker", "named_account_price"', 'flag("warn", "named_account_price"'],
  ['tier order check off', 'if (!(tiers[i].min_qty > tiers[i - 1].min_qty))', 'if (false)'],
  ['tier ascending >= allowed', 'tiers[i].min_qty > tiers[i - 1].min_qty', 'tiers[i].min_qty >= tiers[i - 1].min_qty'],
  ['costlier break not flagged', 'if (tiers[i].price > tiers[i - 1].price + 0.005)', 'if (false)'],
  ['qty1 mismatch ignored', 'Math.abs(tiers[0].price - r.dealer_price) >= 0.005', 'false'],
  ['MAP above MSRP ignored', 'r.map > r.msrp + 0.005', 'false'],
  ['fractional case accepted', 'Number.isInteger(r.case_qty) && r.case_qty >= 1', 'r.case_qty >= 1'],
  ['duplicate conflict downgraded', 'flag(same ? "warn" : "blocker"', 'flag("warn"'],
  ['unhashed source not blocked', 'flag("blocker", "source_unhashed"', 'flag("info", "source_unhashed"'],
  ['effective date not reported', 'if (src.effective_date_status !== "stated")', 'if (false)'],
  ['legacy list price ignored', 'legacy.dealer_price != null ? legacy.dealer_price : legacy.base_price', 'legacy.base_price'],
  ['price change not a change', 'Math.abs(lp - r.dealer_price) >= 0.005', 'false'],
  ['changed never set', 'out.status = "changed"', 'out.status = "matched"'],
  ['unchanged never set', 'if (out.status === "matched" && !out.changes.length) out.status = "unchanged";', ''],
  ['suggestion distance 2', 'lev(p, k) <= 1', 'lev(p, k) <= 2'],
  ['stage_ready ignores blockers', 'stage_ready: !all.some(f => f.level === "blocker")', 'stage_ready: true'],
  ['source-rule MSRP exported as stated', 'msrp: r.msrp_source === "stated" ? r.msrp ?? null : null', 'msrp: r.msrp ?? null'],
  ['source-rule MAP exported as stated', 'map: r.map_source === "stated" ? r.map ?? null : null', 'map: r.map ?? null'],
  ['source-rule MSRP not kept in raw', '_source_rule_msrp: r.msrp_source === "source_rule" ? r.msrp : null', '_source_rule_msrp: null'],
  ['blockers not sorted first', 'order[a.level] - order[b.level] ||', ''],
];

const ctl = run(base);
console.log('control: ' + ctl.pass + ' passed, ' + ctl.fail + ' failed');
if (ctl.fail) { console.log(ctl.report); process.exit(1); }
let killed = 0, survived = [];
for (const [name, from, to] of M) {
  if (!base.includes(from)) { survived.push(name + ' (pattern not found)'); continue; }
  const r = run(base.replace(from, to));
  if (r.fail) killed++; else survived.push(name);
}
console.log('mutants killed: ' + killed + '/' + M.length);
if (survived.length) { console.log('SURVIVED:\n  ' + survived.join('\n  ')); process.exit(1); }
