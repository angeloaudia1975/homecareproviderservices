/* Phase C shadow validation, offline. Input: the JSON from supabase/mi_c_shadow_export.sql (a .json file, or the CSV the
   SQL editor downloads — its one cell is read). Optional: an order export CSV (e.g. record 8) to review order by order.
   Read-only: prints results, writes nothing anywhere.
     node scripts/shipto_shadow_local.js export.csv|json [orders.csv] */
const fs = require('fs'), path = require('path');
const FN = f => require(path.join(__dirname, '..', 'netlify', 'functions', f));
const SH = FN('_shipto.js'), RV = FN('_shipto_review.js'), RR = FN('_report_rows.js');
const { NAME_FIRST } = FN('_mfr_rules.js');
let txt = fs.readFileSync(process.argv[2], 'utf8').trim();
if (!txt.startsWith('{')) { const rows = RR.parseCsv(txt).filter(r => r.length && r[0]); txt = rows[rows.length - 1][0]; }
const X = JSON.parse(txt);
const real = (X.dealers || []).filter(d => !d.is_test);
const nameOf = id => ((X.dealers || []).find(d => d.id === id) || {}).business_name || id;
for (const mfr of ['strongback-mobility', 'bemis']) {
  const matcher = SH.makeMatcher({ dealers: real, accounts: (X.accounts || []).filter(a => a.manufacturer === mfr), aliases: X.aliases || [], nameFirst: NAME_FIRST.has(mfr) });
  const zipmap = (X.zipmaps || {})['zipmap:' + mfr] || {};
  const hist = (X.history || []).filter(h => h.manufacturer === mfr);
  const s = RV.shadow(hist, { matcher, mappings: [], zipmap });
  console.log(`\n=== ${mfr}: ${hist.length} rows · ${s.orders} orders · same ${s.same} · held ${s.held} ${JSON.stringify(s.held_reasons)} · DIFFERENT ${s.different} · unmatched in history ${s.unmatched_history} · split in history ${s.mixed_history}`);
  for (const r of s.list) console.log(`  ${r.outcome.padEnd(17)} ${r.key.padEnd(22)} ${String(r.company).slice(0, 34).padEnd(34)} ${[r.ship_city, r.ship_zip].filter(Boolean).join(' ').padEnd(22)} booked: ${nameOf(r.booked) || '—'}${r.strict ? ' · rules: ' + nameOf(r.strict) : ' · ' + r.basis}`);
  if (process.argv[3] && mfr === 'strongback-mobility') {
    const p = RR.readOrderRows(fs.readFileSync(process.argv[3]), 'csv');
    const rv = RV.buildReview(p.rows, { matcher, zipmap });
    console.log(`\n=== order export ${path.basename(process.argv[3])}: ${rv.status} · ${JSON.stringify(rv.counts)} · ${JSON.stringify(rv.needs_review_by_reason)}`);
    for (const o of rv.orders) console.log(`  ${o.order_key.padEnd(8)} ${o.status.padEnd(13)} ${String(o.reported.company).slice(0, 34).padEnd(34)} ${[o.reported.ship_city, o.reported.ship_zip].join(' ').padEnd(22)} → ${o.dealer_id ? nameOf(o.dealer_id) + ' (' + o.basis + ')' : o.reason}`);
  }
}
