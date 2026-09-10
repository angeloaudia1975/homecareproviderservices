/* Record consistency audit — behaviour suite.
   Executes the real auditRecord and packSize lifted out of catalog-api.js. */
const { load } = require('./lift');

let pass = 0, fail = 0;
const out = [];
function t(name, fn){
  try { fn(); pass++; out.push('  ok   ' + name); }
  catch(e){ fail++; out.push('  FAIL ' + name + '\n         ' + e.message); }
}
function eq(a, b, what){
  if(JSON.stringify(a) !== JSON.stringify(b))
    throw new Error((what || 'value') + ': got ' + JSON.stringify(a) + ', expected ' + JSON.stringify(b));
}

function run(src){
  const M = load(src);
  const audit = (rows, opts) => M.auditRecord(rows, opts);
  const checks = rows => audit(rows).findings.map(f => f.check).sort();
  const P = o => Object.assign({ code:'A1', status:'active', base_price:10, msrp:20 }, o || {});

  pass = 0; fail = 0; out.length = 0;

  /* ---- pack sizes -------------------------------------------------------- */
  t('a pack size is read out of the unit of measure', () => {
    eq(M.packSize('4/CS'), 4, '4/CS');
    eq(M.packSize('2/cs'), 2, 'lowercase');
    eq(M.packSize('12 / CASE'), 12, 'spaced');
    eq(M.packSize('Case of 6'), 6, 'worded');
  });

  t('a unit that says nothing about quantity returns nothing', () => {
    eq(M.packSize('EA'), null, 'EA');
    eq(M.packSize(''), null, 'empty');
    eq(M.packSize(null), null, 'null');
    eq(M.packSize('1/CS'), null, 'a pack of one is not a pack');
  });

  /* ---- THE ONE THAT COST MONEY ------------------------------------------- */
  t('a quantity-1 rung that disagrees with the card is caught', () => {
    // MP-P12 exactly: card $524.99, cart $629.99.
    const f = audit([P({ code:'MP-P12', base_price:524.99, msrp:1499,
                         tiers:[{min_qty:1, price:629.99}] })]).findings;
    eq(f.length, 1, 'one finding');
    eq(f[0].check, 'qty1_rung_conflicts', 'check');
    eq(f[0].code, 'MP-P12', 'code');
  });

  t('a quantity-1 rung that agrees is not a finding', () => {
    eq(checks([P({ tiers:[{min_qty:1, price:10}] })]), [], 'findings');
  });

  t('a difference smaller than half a cent is rounding, not a conflict', () => {
    // Prices arrive from spreadsheets and floating point. Flagging a tenth of a
    // cent would bury the real findings under noise nobody can act on.
    eq(checks([P({ tiers:[{min_qty:1, price:10.001}] })]), [], 'findings');
    eq(checks([P({ tiers:[{min_qty:1, price:10.01}] })]), ['qty1_rung_conflicts'], 'a real cent is real');
  });

  /* ---- pack pricing must not produce false alarms ------------------------ */
  t('a case-priced SKU with a per-unit MSRP is clean', () => {
    // Bemis 7YA05313GRY: $119.96 a case of four, $59.99 MSRP per unit.
    eq(checks([P({ code:'7YA05313GRY', base_price:119.96, case_qty:4,
                   uom:'4/CS', msrp:59.99, map:59.99, msrp_auto:false })]), [], 'findings');
  });

  t('the same row without its pack size DOES look broken — which is the point', () => {
    const c = checks([P({ base_price:119.96, msrp:59.99, map:59.99 })]);
    eq(c.indexOf('msrp_below_dealer_price') >= 0, true, 'msrp flagged');
    eq(c.indexOf('map_below_dealer_price') >= 0, true, 'map flagged');
  });

  t('a uom that states a pack while case_qty is unset is reported', () => {
    const c = checks([P({ uom:'4/CS', base_price:119.96, msrp:239.92 })]);
    eq(c.indexOf('pack_size_not_recorded') >= 0, true, 'reported');
  });

  t('a derived MSRP on a pack line derives from the per-unit price', () => {
    eq(checks([P({ base_price:119.96, case_qty:4, msrp:59.98, msrp_auto:true })]), [], 'clean at 2x per unit');
    eq(checks([P({ base_price:119.96, case_qty:4, msrp:239.92, msrp_auto:true })]),
       ['stale_derived_msrp'], 'flagged when derived from the case price');
  });

  /* ---- ladders ----------------------------------------------------------- */
  t('a tier that costs more than buying one is caught', () => {
    eq(checks([P({ tiers:[{min_qty:6, price:12}] })]), ['tier_above_base'], 'findings');
  });

  t('a ladder that rises with quantity is caught', () => {
    eq(checks([P({ tiers:[{min_qty:2, price:9}, {min_qty:6, price:9.5}] })]),
       ['tier_not_descending'], 'findings');
  });

  t('a normal descending ladder is clean', () => {
    eq(checks([P({ tiers:[{min_qty:2, price:9}, {min_qty:6, price:8}] })]), [], 'findings');
  });

  /* ---- price relationships ----------------------------------------------- */
  t('MAP below the dealer price is caught', () => {
    eq(checks([P({ base_price:10, map:8, msrp:20 })]), ['map_below_dealer_price'], 'findings');
  });

  t('MSRP below MAP is caught', () => {
    eq(checks([P({ base_price:10, map:25, msrp:20 })]), ['msrp_below_map'], 'findings');
  });

  t('a stale derived MSRP is caught', () => {
    eq(checks([P({ base_price:27.95, msrp:39.9, msrp_auto:true })]), ['stale_derived_msrp'], 'findings');
  });

  t('a quoted MSRP is never called stale, however odd it looks', () => {
    eq(checks([P({ base_price:27.95, msrp:39.9, msrp_auto:false })]), [], 'findings');
  });

  /* ---- status ------------------------------------------------------------ */
  t('an active SKU with no price is caught', () => {
    eq(checks([P({ base_price:null, msrp:null })]), ['no_dealer_price'], 'findings');
  });

  t('an active SKU that is also superseded is caught', () => {
    eq(checks([P({ superseded_by:'A2' })]), ['active_but_superseded'], 'findings');
  });

  t('a tombstone is not audited as a live product', () => {
    eq(checks([{ code:'DEAD1', status:'discontinued', superseded_by:'A1' }]), [], 'findings');
  });

  t('a tombstone carrying a price is caught', () => {
    eq(checks([{ code:'DEAD1', status:'discontinued', base_price:10 }]),
       ['discontinued_with_price'], 'findings');
  });

  /* ---- shape ------------------------------------------------------------- */
  t('one SKU with several problems is counted once in skus_affected', () => {
    const r = audit([P({ base_price:10, map:8, msrp:5, tiers:[{min_qty:1, price:12}] })]);
    eq(r.stats.skus_affected, 1, 'skus_affected');
    eq(r.stats.findings >= 3, true, 'several findings');
  });

  t('a clean catalog reports nothing', () => {
    const r = audit([P(), P({ code:'A2', base_price:5, msrp:10 })]);
    eq(r.stats, { rows:2, findings:0, skus_affected:0 }, 'stats');
  });

  t('rows with no code, and null input, do not throw', () => {
    eq(audit([{ base_price:10 }, { code:'' }]).stats.findings, 0, 'skipped');
    eq(audit(null).stats.findings, 0, 'null');
  });

  return { pass, fail, report: out.join('\n') };
}

module.exports = { run };

if(require.main === module){
  const r = run();
  console.log(r.report);
  console.log('\n' + r.pass + ' passed, ' + r.fail + ' failed');
  process.exit(r.fail ? 1 : 0);
}
