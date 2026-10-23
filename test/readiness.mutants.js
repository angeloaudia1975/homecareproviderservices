/* Mutation harness for launch readiness (_readiness.js). A readiness board that misses a blocker would let a line
   launch half-finished; one that cries wolf gets ignored. CONTROL must survive; every real mutant must be killed. */
const fs = require('fs');
const suite = require('./readiness.test');
const src = fs.readFileSync(suite.SRC, 'utf8');

const MUTANTS = [
  { name: 'CONTROL — a comment, changing nothing', from: '  const ex = [];', to: '  const ex = []; /* control */', expect: 'survive' },
  { name: 'treat draft pages as visible', from: 'const VISIBLE = new Set(["published", "active", "discontinued"]);', to: 'const VISIBLE = new Set(["published", "active", "discontinued", "draft"]);' },
  { name: 'ignore a disabled page', from: 'VISIBLE.has(String(p.status || "")) && p.disabled !== true;', to: 'VISIBLE.has(String(p.status || ""));' },
  { name: 'drop discontinued from visible', from: 'const VISIBLE = new Set(["published", "active", "discontinued"]);', to: 'const VISIBLE = new Set(["published", "active"]);' },
  { name: 'match codes exactly instead of normalised', from: 'String(c == null ? "" : c).toUpperCase().replace(/[^A-Z0-9]/g, "")', to: 'String(c == null ? "" : c)' },
  { name: 'legacy-only line not flagged as not migrated', from: 'add("blocker", "not_migrated"', to: 'add("info", "not_migrated"' },
  { name: 'stop noticing an active SKU with no price', from: 'add("blocker", "active_sku_without_price"', to: 'add("info", "active_sku_without_price"' },
  { name: 'count tombstones as active', from: 'const active = skus.filter(r => r.status === "active");', to: 'const active = skus;' },
  { name: 'ignore the parity error', from: 'if (meta.record_resync_error)', to: 'if (false)' },
  { name: 'stop reporting authority OFF', from: 'if (skus.length && meta.record_authoritative !== true)', to: 'if (false)' },
  { name: 'deferral ignored', from: 'add(deferred ? "info" : "warn",', to: 'add("warn",' },
  { name: 'broken image file only a warning', from: 'add("blocker", "image_file_missing"', to: 'add("warn", "image_file_missing"' },
  { name: 'unlisted rows not a blocker', from: 'add(rows.length || skus.length ? "blocker" : "info", "not_listed"', to: 'add("info", "not_listed"' },
  { name: 'listed-without-rows missed', from: 'if (listing && listing.hasData === true && !rows.length && !skus.length)', to: 'if (false)' },
  { name: 'freight terms not checked', from: 'if (listing && !listing.freight && (rows.length || skus.length))', to: 'if (false)' },
  { name: 'open regression fix not reported', from: 'if (Number(i.open_regression_fixes) > 0)', to: 'if (false)' },
  { name: 'alias applied silently', from: 'if (i.alias_from) add(', to: 'if (false) add(' },
  { name: 'alias applied without being passed', from: 'const to = s => aliases[s] || s;', to: 'const to = s => (Object.assign({ gce: "ohio-medical" }, aliases))[s] || s;' },
  { name: 'later failed runs become the status', from: ': gs ? "gold_standard" : "in_progress";', to: ': gs && !gs.later_failed ? "gold_standard" : "in_progress";' },
  { name: 'unmeasured master read as not migrated', from: '  if (!measured.master) {}\n  else if', to: '  if (false) {}\n  else if' },
  { name: 'partial measurement claims a completion %', from: 'completion: base && !unmeasured.length ?', to: 'completion: base ?' },
  { name: 'partial run called in_progress', from: ': unmeasured.length ? "partial_measurement"', to: ': false ? "partial_measurement"' },
  { name: 'unmeasured stage reported as 0', from: 'master: !measured.master ? null :', to: 'master: !measured.master ? 0 :' },
  { name: 'platform % claimed over partial lines', from: 'withData.length && withData.every(l => l.completion != null)', to: 'withData.length' },
  { name: 'gold standard not required for verified', from: 'verified: !measured.runs ? null : gs ? 1 : 0,', to: 'verified: !measured.runs ? null : 1,' },
  { name: 'catalog stage reads public file prices again', from: 'const coded = rows.filter(r => normCode(r && r.code)).length;', to: 'const coded = rows.filter(r => normCode(r && r.code) && Number(r.base_price) > 0).length;' },
  { name: 'rows without a code count as catalogued', from: 'const coded = rows.filter(r => normCode(r && r.code)).length;', to: 'const coded = rows.length;' },
  { name: 'launch_ready from Gold Standard alone', from: 'const launch_ready = status === "gold_standard" && ov;', to: 'const launch_ready = status === "gold_standard";' },
  { name: 'launch_ready from order_verified alone', from: 'const launch_ready = status === "gold_standard" && ov;', to: 'const launch_ready = ov;' },
  { name: 'order_verified not carried by the matrix', from: "order_verified: (lines[s] || {}).order_verified === true }));", to: "order_verified: false }));" },
  { name: 'denominator hidden', from: 'average_over_lines: withData.length,', to: 'average_over_lines: out.length,' },
  { name: 'no_data lines not listed as excluded', from: 'excluded_no_data: out.filter(l => l.status === "no_data").map(l => l.slug),', to: 'excluded_no_data: [],' },
  { name: 'no_data lines dragged into the platform average', from: 'const withData = out.filter(l => l.status !== "no_data");', to: 'const withData = out;' },
  { name: 'exclude ignored (Golden counted)', from: '.filter(s => !(i.exclude || []).includes(s))', to: '' },
  { name: 'master-only lines dropped from the matrix', from: '...Object.keys(skus), ', to: '' },
  { name: 'blockers not sorted first', from: 'ex.sort((a, b) => order[a.severity] - order[b.severity] || a.check.localeCompare(b.check));', to: 'ex.sort((a, b) => a.check.localeCompare(b.check));' },
  { name: 'duplicate codes not reported', from: 'if (dup.length) add(', to: 'if (false) add(' },
];

let bad = 0;
console.log('mutant'.padEnd(56) + 'anchors  result'); console.log('-'.repeat(84));
for (const m of MUTANTS) {
  const hits = src.split(m.from).length - 1;
  if (hits !== 1) { console.log(m.name.padEnd(56) + String(hits).padStart(6) + '   ANCHOR NOT UNIQUE — mutant is meaningless'); bad++; continue; }
  let r; try { r = suite.run(src.replace(m.from, m.to)); } catch (e) { r = { fail: -1 }; }
  const survived = r.fail === 0, want = m.expect === 'survive', ok = survived === want; if (!ok) bad++;
  console.log(m.name.padEnd(56) + String(hits).padStart(6) + '   ' + (survived ? (want ? 'survived (correct — no-op)' : 'SURVIVED — untested behaviour') : (want ? 'KILLED — harness is broken' : 'killed by ' + r.fail + ' test(s)')));
}
console.log('-'.repeat(84));
console.log(bad === 0 ? 'All mutants behaved as required (control survived, every real mutant killed).' : bad + ' mutant(s) did not behave as required.');
process.exit(bad ? 1 : 0);
