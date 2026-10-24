/* Mutation harness for the catalog importer core: every mutant must be killed by test/catalog-import.test.js,
   and the unmutated control must pass. */
const fs = require('fs');
const { run, SRC, ADP } = require('./catalog-import.test.js');
const base = fs.readFileSync(SRC, 'utf8');
const adpBase = fs.readFileSync(ADP, 'utf8');

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
  // PR #35 review: before/after, stop-on-blocker, exceptions queue, handoff, refusals, aliases, as printed
  ['printed price not checked', 'money(r.raw.printed_price) !== r.dealer_price', 'false'],
  ['package stageable despite blockers', 'const stageable = blocking.length === 0;', 'const stageable = true;'],
  ['blocked package still emits rows', 'handoff: !stageable ? null : {', 'handoff: false ? null : {'],
  ['received date not required', 'if (!src.received_date) add(', 'if (false) add('],
  ['old list treated as current', 'srcYear < year && !(ctx.confirmations || {}).current_source', 'false'],
  ['confirmation ignored', ' && !(ctx.confirmations || {}).current_source', ''],
  ['frozen lines not refused', 'if (FROZEN_LINES.includes(c) ||', 'if ('],
  ['snapshot-frozen not refused', ' || (frozen || []).map(canonicalSlug).includes(c)', ''],
  ['Complete Medical not refused', 'if (REFUSED_LINES[c]) return', 'if (false) return'],
  ['refused line not returned early', '    return out;\n  }\n  for (const e of line.exceptions || [])', '  }\n  for (const e of line.exceptions || [])'],
  ['decision without who/why accepted', 'd.status === "resolved" && d.decided_by && d.reason', 'd.status === "resolved"'],
  ['named account not blocking in queue', 'never staged as general pricing without Angelo\'s decision.", true]', 'never staged as general pricing without Angelo\'s decision.", false]'],
  ['pack text not blocking', 'and the order unit + case quantity.", true]', 'and the order unit + case quantity.", false]'],
  ['proposed code not blocking', 'never invented into the catalog.", true]', 'never invented into the catalog.", false]'],
  ['uncertain part number not blocking', '"Confirm with the manufacturer whether this is a new item or an existing code; nothing is merged or renamed automatically.", true);', '"Confirm with the manufacturer whether this is a new item or an existing code; nothing is merged or renamed automatically.", false);'],
  ['legacy SKUs not queued', 'for (const n of comparison.not_in_source || [])', 'for (const n of [])'],
  ['legacy SKUs blocking', '"Decide with the manufacturer whether it is still offered; any retirement is a separate, approved Manufacturer Center action.", false);', '"Decide with the manufacturer whether it is still offered; any retirement is a separate, approved Manufacturer Center action.", true);'],
  ['discount history not flagged', 'if (legacyTiers && !((r.tiers || []).length > 1))', 'if (false)'],
  ['capacity conflict not flagged', 'if (sc != null && cc != null && sc !== cc)', 'if (false)'],
  ['image rights not flagged', 'if (img && !/^\\/assets\\//.test(img)', 'if (false && !/^\\/assets\\//.test(img)'],
  ['warranty not held', 'if (/warrant/i.test(text)) add(', 'if (false) add('],
  ['OTC claim not held', 'if (OTC_CLAIM.test(text)) add(', 'if (false) add('],
  ['holds input ignored', 'for (const h of ctx.holds || [])', 'for (const h of [])'],
  ['exceptions unsorted', 'list.sort((a, b) => lvl(a) - lvl(b) ||', 'list.reverse((a, b) => lvl(a) - lvl(b) ||'],
  ['blocking exceptions not first', 'const lvl = x => (x.blocking ? 0 : x.status === "held" ? 1 : 2);', 'const lvl = x => 0;'],
  ['before/after unsorted', 'rows.sort((x, y) => (x.key < y.key', 'rows.reverse((x, y) => (x.key < y.key'],
  ['before/after: unstated shown as cleared', 'else if (now == null) { now = was; change = "not_stated"; }', 'else if (now == null) { change = "changed"; }'],
  ['before/after: preserved SKUs dropped', 'for (const k of keys) {\n    if (seen.has(k)) continue;', 'for (const k of []) {\n    if (seen.has(k)) continue;'],
  ['before/after: status changed by listing', 'now = b ? was : "active (new record)"', 'now = "active (new record)"'],
  ['before/after: source-rule MSRP as stated', 'msrp: r.msrp_source === "stated" ? r.msrp ?? null : null, map: r.map_source === "stated" ? r.map ?? null : null,\n    uom:', 'msrp: r.msrp ?? null, map: r.map ?? null,\n    uom:'],
  ['before/after: legacy discount tiers lost', 'tierText(c.tiers) || tierText(c.tier_prices)', 'tierText(c.tiers)'],
  ['stage rows send status', '    o._provenance = prov;\n    return o;', '    o.status = "active"; o._provenance = prov;\n    return o;'],
  ['stage rows send unstated MSRP as null', 'if (r.msrp_source === "stated" && r.msrp != null) o.msrp = r.msrp;', 'o.msrp = r.msrp_source === "stated" ? r.msrp : null;'],
  ['provenance missing on import rows', '      _provenance: prov }),', '      }),'],
  ['effective date invented from received', 'effective_date: s.effective_date_status === "stated" ? s.effective_date || null : null,', 'effective_date: s.effective_date || s.received_date || null,'],
  ['case qty not passed as text', 'case_qty_text: r.case_qty > 1 ? String(r.case_qty) : null,', 'case_qty_text: null,'],
  ['gce alias dropped', 'const SLUG_ALIASES = { gce: "ohio-medical" };', 'const SLUG_ALIASES = {};'],
  ['gce storefront file lost', 'const CATALOG_FILE_SLUG = { "ohio-medical": "gce" };', 'const CATALOG_FILE_SLUG = {};'],
];
// Adapter mutants (the adapters are compiled from the mutated text; the core stays real)
const MA = [
  ['Dalton applies a 5% discount', 'dealer_price: money(r.price), msrp: null', 'dealer_price: Math.round(money(r.price) * 95) / 100, msrp: null'],
  ['Dalton printed price not kept', 'raw: { printed_price: r.price }, _k: f.key', '_k: f.key'],
  ['Dalton discount text not recorded', 'if (/\\d+\\s*%|discount/i.test(t)) L.terms.push', 'if (false) L.terms.push'],
  ['Corsicana case qty from text not flagged', 'row.flags.push(flag("blocker", "case_qty_unverified"', 'row.flags.push(flag("info", "case_qty_unverified"'],
  ['gce adapter alias dropped', 'ADAPTERS.gce = ADAPTERS["ohio-medical"];', ''],
  ['adapterFor ignores aliases', 'ADAPTERS[require("./_catalog_import.js").canonicalSlug(slug)]', 'ADAPTERS[slug]'],
];

(async () => {
const ctl = await run(base);
console.log('control: ' + ctl.pass + ' passed, ' + ctl.fail + ' failed');
if (ctl.fail) { console.log(ctl.report); process.exit(1); }
let killed = 0, survived = [];
for (const [name, from, to] of M) {
  if (!base.includes(from)) { survived.push(name + ' (pattern not found)'); continue; }
  const r = await run(base.replace(from, to));
  if (r.fail) killed++; else survived.push(name);
}
for (const [name, from, to] of MA) {
  if (!adpBase.includes(from)) { survived.push(name + ' (pattern not found)'); continue; }
  const r = await run(base, adpBase.replace(from, to));
  if (r.fail) killed++; else survived.push(name);
}
console.log('mutants killed: ' + killed + '/' + (M.length + MA.length));
if (survived.length) { console.log('SURVIVED:\n  ' + survived.join('\n  ')); process.exit(1); }
})();
