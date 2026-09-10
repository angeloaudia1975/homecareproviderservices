/* Price-list import diff — behaviour suite.
   Executes the real diffPriceImport lifted out of catalog-api.js. */
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
  const diff = (records, rows, opts) => M.diffPriceImport(records, rows, opts);

  pass = 0; fail = 0; out.length = 0;

  /* ---- the ordinary case: the list agrees with the record ---------------- */
  t('a list that matches the record reports nothing to do', () => {
    const r = diff(
      [{ code:'MP-P12', base_price:524.99, map:749.99, msrp:1499 }],
      [{ code:'MP-P12', base_price:524.99, map:749.99, msrp:1499 }]);
    eq(r.stats, { on_list:1, in_record:1, unchanged:1, changed:0, added:0, absent:0 }, 'stats');
  });

  t('a real price change is reported with both numbers', () => {
    const r = diff(
      [{ code:'MP-P12', base_price:524.99 }],
      [{ code:'MP-P12', base_price:549.99 }]);
    eq(r.changed.length, 1, 'changed');
    eq(r.changed[0].fields.find(f=>f.field==='base_price'), { field:'base_price', from:524.99, to:549.99 }, 'field');
  });

  t('codes match through case and punctuation', () => {
    const r = diff([{ code:'MP-P08-KIT', base_price:367.49, msrp:734.98, msrp_auto:true }],
                   [{ code:'mp p08 kit', base_price:367.49 }]);
    eq(r.stats.unchanged, 1, 'unchanged');
    eq(r.stats.added, 0, 'not treated as new');
  });

  /* ---- what the list does not say --------------------------------------- */
  t('a list with no MAP column does not blank every MAP', () => {
    const r = diff([{ code:'A1', base_price:10, map:14.99, msrp:20, msrp_auto:true }],
                   [{ code:'A1', base_price:10 }]);
    eq(r.changed, [], 'no change proposed');
    eq(r.stats.unchanged, 1, 'unchanged');
  });

  t('a list with no tier columns does not clear a quantity ladder', () => {
    const r = diff([{ code:'A1', base_price:10, msrp:20, msrp_auto:true, tiers:[{min_qty:6,price:8}] }],
                   [{ code:'A1', base_price:10 }]);
    eq(r.changed, [], 'ladder left alone');
  });

  t('a code in the record but not on the list is reported, never retired', () => {
    const r = diff([{ code:'OLD1', base_price:5, msrp:10, msrp_auto:true },
                    { code:'A1', base_price:10, msrp:20, msrp_auto:true }],
                   [{ code:'A1', base_price:10 }]);
    eq(r.absent.map(x=>x.code), ['OLD1'], 'absent');
    eq(r.changed, [], 'and nothing proposed against it');
  });

  t('a code on the list but not in the record is reported, never created', () => {
    const r = diff([], [{ code:'NEW1', description:'A new brace', base_price:20 }]);
    eq(r.added.length, 1, 'added');
    eq(r.added[0].code, 'NEW1', 'code');
    eq(r.added[0].description, 'A new brace', 'description carried for review');
  });

  /* ---- the MSRP rule, applied to the list -------------------------------- */
  t('a list with no MSRP derives one from the price ON THAT LIST', () => {
    // The trap: deriving from the OLD price would keep the stale figure that
    // the six Nu-Form Thumb Spicas carried for months.
    const r = diff([{ code:'A1', base_price:19.95, msrp:39.9, msrp_auto:true }],
                   [{ code:'A1', base_price:27.95 }]);
    const f = r.changed[0].fields;
    eq(f.find(x=>x.field==='base_price').to, 27.95, 'new dealer price');
    eq(f.find(x=>x.field==='msrp').to, 55.9, 'MSRP re-derived from the new price');
  });

  t('a quoted MSRP is believed and marked as the manufacturer\'s', () => {
    const r = diff([{ code:'A1', base_price:10, msrp:20, msrp_auto:true }],
                   [{ code:'A1', base_price:10, msrp:35 }]);
    const f = r.changed[0].fields;
    eq(f.find(x=>x.field==='msrp').to, 35, 'msrp');
    eq(f.find(x=>x.field==='msrp_auto').to, false, 'no longer ours');
  });

  t('a manufacturer dropping its MSRP column hands the figure back to us', () => {
    const r = diff([{ code:'A1', base_price:10, msrp:35, msrp_auto:false }],
                   [{ code:'A1', base_price:10 }]);
    const f = r.changed[0].fields;
    eq(f.find(x=>x.field==='msrp').to, 20, 'derived at 2x');
    eq(f.find(x=>x.field==='msrp_auto').to, true, 'marked derived');
  });

  t('an unchanged derived MSRP is not reported as a change', () => {
    const r = diff([{ code:'A1', base_price:27.95, msrp:55.9, msrp_auto:true }],
                   [{ code:'A1', base_price:27.95 }]);
    eq(r.changed, [], 'nothing to do');
  });

  t('the multiplier is the platform rule, and can be overridden for a test', () => {
    const r = diff([{ code:'A1', base_price:10, msrp:20, msrp_auto:true }],
                   [{ code:'A1', base_price:10 }], { multiplier: 3 });
    eq(r.changed[0].fields.find(x=>x.field==='msrp').to, 30, 'msrp at 3x');
  });

  t('a record with no MSRP at all is offered one', () => {
    // This is what the broken fixtures were accidentally testing. It is correct:
    // a priced SKU with no MSRP should be given the derived one.
    const r = diff([{ code:'A1', base_price:10 }], [{ code:'A1', base_price:10 }]);
    eq(r.changed.length, 1, 'changed');
    eq(r.changed[0].fields.find(f=>f.field==='msrp').to, 20, 'derived');
  });

  /* ---- ladders ----------------------------------------------------------- */
  t('the same ladder written in a different order is not a change', () => {
    const r = diff([{ code:'A1', base_price:10, msrp:20, msrp_auto:true, tiers:[{min_qty:2,price:9},{min_qty:6,price:8}] }],
                   [{ code:'A1', base_price:10, tiers:[{min_qty:6,price:8},{min_qty:2,price:9}] }]);
    eq(r.changed, [], 'diffs');
  });

  t('a genuinely different ladder is reported', () => {
    const r = diff([{ code:'A1', base_price:10, msrp:20, msrp_auto:true, tiers:[{min_qty:6,price:8}] }],
                   [{ code:'A1', base_price:10, tiers:[{min_qty:6,price:7.5}] }]);
    eq(r.changed.length, 1, 'changed');
    eq(!!r.changed[0].fields.find(f=>f.field==='tiers'), true, 'the ladder is the reported field');
    eq(r.changed[0].fields.length, 1, 'and the only one');
  });

  /* ---- messy lists ------------------------------------------------------- */
  t('a code listed twice is read once', () => {
    const r = diff([{ code:'A1', base_price:10, msrp:20, msrp_auto:true }],
                   [{ code:'A1', base_price:10 }, { code:'a1', base_price:99 }]);
    eq(r.stats.on_list, 1, 'on_list');
    eq(r.changed, [], 'the second mention is ignored, not applied');
  });

  t('rows with no code are skipped rather than becoming blank products', () => {
    const r = diff([], [{ code:'', base_price:10 }, { base_price:20 }, { code:'  ', base_price:30 }]);
    eq(r.stats.added, 0, 'added');
    eq(r.stats.on_list, 0, 'on_list');
  });

  t('an empty list proposes nothing and reports the whole catalog as absent', () => {
    const r = diff([{ code:'A1' }, { code:'A2' }], []);
    eq(r.stats.changed, 0, 'changed');
    eq(r.stats.absent, 2, 'absent');
  });

  t('an empty catalog treats the whole list as new', () => {
    const r = diff([], [{ code:'A1', base_price:10 }, { code:'A2', base_price:20 }]);
    eq(r.stats.added, 2, 'added');
  });

  t('null inputs do not throw', () => {
    const r = diff(null, null);
    eq(r.stats.on_list, 0, 'on_list');
    eq(r.stats.absent, 0, 'absent');
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
