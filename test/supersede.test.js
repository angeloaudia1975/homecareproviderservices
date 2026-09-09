/* Superseded part numbers — behaviour suite.
   Executes the real reconcileSkus and tombstoneRows lifted out of catalog-api.js. */
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
  const rec = o => M.reconcileSkus(Object.assign(
    { slug:'test-line', base:[], custom:[], overrides:{}, pages:[] }, o));
  const stones = (sup, live) => M.tombstoneRows(sup, live,
    { manufacturer:'test-line', now:'2026-09-09T00:00:00Z', who:'president' });

  pass = 0; fail = 0; out.length = 0;

  /* ---- the reconciler has to notice the pointer at all ------------------- */
  t('a code merged onto a DIFFERENT part number is recorded', () => {
    // Ovation's Gen 2 shape exactly: 10102 was reissued as 10102BLUE.
    const r = rec({
      base:      [{ code:'10102', base_price:49.95 }, { code:'10102BLUE', base_price:49.95 }],
      overrides: { '10102': { active:false, merged_into:'10102BLUE' } },
    });
    eq(r.rows.map(x => x.code), ['10102BLUE'], 'live rows');
    eq(r.superseded, [{ manufacturer:'test-line', code:'10102',
                        superseded_by:'10102BLUE', same_code:false }], 'superseded');
  });

  t('a same-spelling twin is recorded, and marked as one', () => {
    const r = rec({
      base:      [{ code:'MP-P08' }],
      custom:    [{ code:'mp-p08', active:true }],
      overrides: { 'mp-p08': { active:false, merged_into:'MP-P08' } },
    });
    eq(r.superseded.length, 1, 'one entry');
    eq(r.superseded[0].same_code, true, 'same_code');
  });

  t('a group where every spelling is dead still says which kind it was', () => {
    // Both spellings retired, the loser pointing at the winner. Nothing survives,
    // so this goes through the dead-group branch — the one place the same_code
    // flag is actually computed rather than assumed.
    const r = rec({
      base:      [{ code:'MP-P08' }],
      custom:    [{ code:'mp-p08', active:false }],
      overrides: { 'mp-p08': { active:false, merged_into:'MP-P08' },
                   'MP-P08': { active:false } },
    });
    eq(r.rows.length, 0, 'no live rows');
    eq(r.superseded.length, 1, 'one pointer');
    eq(r.superseded[0].same_code, true, 'recognised as a spelling twin');
  });

  t('a dead group replaced by a different part number is marked cross-code', () => {
    const r = rec({
      base:      [{ code:'10102' }, { code:'10102BLUE', base_price:49.95 }],
      overrides: { '10102': { active:false, merged_into:'10102BLUE' } },
    });
    eq(r.superseded[0].same_code, false, 'recognised as a replacement');
  });

  t('a code retired with no replacement produces no pointer', () => {
    const r = rec({
      base:      [{ code:'DEAD1' }],
      overrides: { 'DEAD1': { active:false } },
    });
    eq(r.superseded, [], 'superseded');
    eq(r.skipped.map(s => s.code), ['DEAD1'], 'skipped');
  });

  t('the survivor is still written, and is not marked superseded itself', () => {
    const r = rec({
      base:      [{ code:'25002-2', base_price:27.95 }, { code:'25002-2B', base_price:27.95 }],
      overrides: { '25002-2': { active:false, merged_into:'25002-2B' } },
    });
    const live = r.rows.find(x => x.code === '25002-2B');
    eq(!!live, true, 'survivor written');
    eq(live.superseded_by, null, 'survivor not superseded');
    eq(live.status, 'active', 'survivor active');
  });

  /* ---- which pointers become rows ---------------------------------------- */
  t('a cross-code supersession becomes a tombstone with no prices', () => {
    const { rows, refused } = stones(
      [{ code:'10102', superseded_by:'10102BLUE', same_code:false }],
      [{ code:'10102BLUE' }]);
    eq(refused, [], 'refused');
    eq(rows.length, 1, 'one row');
    eq(rows[0].code, '10102', 'code');
    eq(rows[0].superseded_by, '10102BLUE', 'superseded_by');
    eq(rows[0].status, 'discontinued', 'status');
    eq('base_price' in rows[0], false, 'no base_price');
    eq('msrp' in rows[0], false, 'no msrp');
    eq('tiers' in rows[0], false, 'no tiers');
  });

  t('a same-spelling twin never becomes a row', () => {
    // It would collide with its own survivor on (manufacturer, code_norm).
    const { rows, refused } = stones(
      [{ code:'mp-p08', superseded_by:'MP-P08', same_code:true }],
      [{ code:'MP-P08' }]);
    eq(rows, [], 'rows');
    eq(refused, [], 'not refused either — simply not needed');
  });

  t('a pointer at a code that did not survive is refused, and said so', () => {
    const { rows, refused } = stones(
      [{ code:'OLD1', superseded_by:'GONE', same_code:false }],
      [{ code:'SOMETHINGELSE' }]);
    eq(rows, [], 'rows');
    eq(refused.length, 1, 'one refusal');
    eq(refused[0].reason, 'replacement is not a live SKU', 'reason');
  });

  t('a dead code that is also live is refused rather than written twice', () => {
    const { rows, refused } = stones(
      [{ code:'10102', superseded_by:'10102BLUE', same_code:false }],
      [{ code:'10102' }, { code:'10102BLUE' }]);
    eq(rows, [], 'rows');
    eq(refused.length, 1, 'one refusal');
    eq(refused[0].reason, 'this code is live in its own right', 'reason');
  });

  t('a pointer at itself in a different spelling is dropped, not written', () => {
    // The schema's no_self_supersede check would reject it; better never to send it.
    const { rows, refused } = stones(
      [{ code:'mp-p08', superseded_by:'MP-P08 ', same_code:false }],
      [{ code:'MP-P08' }]);
    eq(rows, [], 'rows');
    eq(refused, [], 'refused');
  });

  t('punctuation and case do not hide a live replacement', () => {
    const { rows, refused } = stones(
      [{ code:'25002-2', superseded_by:'25002-2B', same_code:false }],
      [{ code:'250022b' }]);
    eq(refused, [], 'refused');
    eq(rows.length, 1, 'matched through normalisation');
  });

  /* ---- end to end -------------------------------------------------------- */
  t('twenty Gen 2 boots and one ankle brace, as they actually are', () => {
    const gen2 = ['10102','10103','10105','10107','10108','10002','10003','10005','10007','10008',
                  '11002','11003','11005','11007','11008','11102','11103','11105','11107','11108'];
    const base = [], overrides = {};
    gen2.forEach(c => {
      base.push({ code:c, base_price:49.95 });
      base.push({ code:c + 'BLUE', base_price:49.95 });
      overrides[c] = { active:false, merged_into:c + 'BLUE' };
    });
    base.push({ code:'25002-2', base_price:27.95 }, { code:'25002-2B', base_price:27.95 });
    overrides['25002-2'] = { active:false, merged_into:'25002-2B' };

    const r = rec({ base, overrides });
    eq(r.rows.length, 21, 'live SKUs');
    eq(r.skipped.length, 21, 'dead codes');
    eq(r.superseded.filter(s => !s.same_code).length, 21, 'cross-code pointers');

    const { rows, refused } = stones(r.superseded, r.rows);
    eq(rows.length, 21, 'tombstones');
    eq(refused, [], 'refused');
    eq(new Set(rows.map(x => x.status)).size, 1, 'all one status');
    eq(rows.every(x => x.superseded_by && x.code !== x.superseded_by), true, 'each points elsewhere');
  });

  t('tombstones cannot collide with a live row on the normalised code', () => {
    const gen2 = ['10102','10103'];
    const base = [], overrides = {};
    gen2.forEach(c => { base.push({ code:c }, { code:c + 'BLUE' });
                        overrides[c] = { active:false, merged_into:c + 'BLUE' }; });
    const r = rec({ base, overrides });
    const { rows } = stones(r.superseded, r.rows);
    const norm = c => String(c).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const all = r.rows.map(x => norm(x.code)).concat(rows.map(x => norm(x.code)));
    eq(all.length, new Set(all).size, 'every normalised code unique');
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
