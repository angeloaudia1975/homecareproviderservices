/* Derived MSRP — behaviour suite.
   Executes the real reconcileSkus lifted out of catalog-api.js. */
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
  const srcText = src;
  const M = load(src);
  const one = ({ base = [], custom = [], overrides = {}, pages = [] }) =>
    M.reconcileSkus({ slug: 'test-line', base, custom, overrides, pages });

  pass = 0; fail = 0; out.length = 0;

  /* ---- the thirty-three: no MSRP anywhere, so derive one and say so -------- */
  t('unstated MSRP is derived at 2x and flagged as derived', () => {
    const r = one({ base: [{ code: 'ST006SN', base_price: 27.95 }] });
    eq(r.rows[0].msrp, 55.9, 'msrp');
    eq(r.rows[0].msrp_auto, true, 'msrp_auto');
    eq(r.conflicts.length, 0, 'conflicts');
  });

  t('the four bucket-S SKUs derive exactly what the storefront shows', () => {
    const shop = { ST002SN: [13.95, 27.9], ST003SN: [17, 34], ST004SN: [19.95, 39.9], ST006SN: [27.95, 55.9] };
    const r = one({ base: Object.keys(shop).map(c => ({ code: c, base_price: shop[c][0] })) });
    r.rows.forEach(row => eq(row.msrp, shop[row.code][1], row.code + ' msrp'));
  });

  /* Doubling a double is exact — the exponent moves and the mantissa doesn't —
     so at a multiplier of 2 the rounding in the derivation can never change an
     answer. That makes it look like dead code, and the next person will delete
     it. It is not dead: it is what keeps the record in whole cents if the
     multiplier ever stops being a power of two. This test pins that directly,
     by running the real derivation at 1.5 against a price that lands on half a
     cent. Without the rounding it produces 49.995, and Postgres would quietly
     round it on the way into numeric(12,2) — a number in the master record that
     nothing in this codebase chose. */
  t('the rounding still holds the record to whole cents at a non-doubling multiplier', () => {
    const at15 = load((srcText || require('fs').readFileSync(require('./lift').SRC, 'utf8'))
      .replace(/const MSRP_MULTIPLIER = [\d.]+;/, 'const MSRP_MULTIPLIER = 1.5;'));
    eq(at15.MSRP_MULTIPLIER, 1.5, 'multiplier under test');
    const r = at15.reconcileSkus({ slug: 'test-line', base: [{ code: 'X', base_price: 33.33 }],
      custom: [], overrides: {}, pages: [] });
    eq(r.rows[0].msrp, 50, 'msrp');
    eq(Math.round(r.rows[0].msrp * 100) === r.rows[0].msrp * 100, true, 'whole cents');
  });

  /* ---- a stated MSRP is never overwritten -------------------------------- */
  t('a stated MSRP wins and is not marked derived', () => {
    const r = one({ base: [{ code: 'A1', base_price: 10, msrp: 30 }] });
    eq(r.rows[0].msrp, 30, 'msrp');
    eq(r.rows[0].msrp_auto, false, 'msrp_auto');
  });

  t('a stated MSRP that a layer flagged as auto keeps that provenance', () => {
    const r = one({
      base:   [{ code: 'A1', base_price: 27.95 }],
      custom: [{ code: 'A1', base_price: 27.95, msrp: 55.9, msrp_auto: true, active: true }],
    });
    eq(r.rows[0].msrp, 55.9, 'msrp');
    eq(r.rows[0].msrp_auto, true, 'msrp_auto');
  });

  t('a layer saying msrp_auto false cannot manufacture a conflict', () => {
    const r = one({
      base:   [{ code: 'A1', base_price: 10, msrp: 30 }],
      custom: [{ code: 'A1', base_price: 10, msrp: 30, msrp_auto: false, active: true }],
    });
    eq(r.conflicts.length, 0, 'conflicts');
    eq(r.rows[0].msrp_auto, false, 'msrp_auto');
  });

  /* ---- a generated MSRP is refreshed; a quoted one never is --------------- */
  t('a stale auto MSRP is re-derived from the price it actually has now', () => {
    // The six Nu-Form Thumb Spica records exactly: $39.90 is twice $19.95, the
    // price these stopped being sold at. The dealer price is $27.95 today.
    const r = one({
      base:      [{ code: '50072-5', base_price: 27.95 }],
      custom:    [{ code: '50072-5', base_price: 27.95, msrp: 39.9, msrp_auto: true, active: true }],
      overrides: { '50072-5': { base_price: 27.95 } },
    });
    eq(r.rows[0].msrp, 55.9, 'msrp');
    eq(r.rows[0].msrp_auto, true, 'msrp_auto');
    eq(r.conflicts.length, 0, 'conflicts');
  });

  t('an MSRP nobody flagged as generated is never rewritten, however odd it looks', () => {
    const r = one({
      base:   [{ code: 'A1', base_price: 27.95 }],
      custom: [{ code: 'A1', base_price: 27.95, msrp: 39.9, active: true }],
    });
    eq(r.rows[0].msrp, 39.9, 'msrp left alone');
    eq(r.rows[0].msrp_auto, false, 'msrp_auto');
  });

  t('an auto MSRP that still matches its price is left exactly as it is', () => {
    const r = one({
      base:   [{ code: 'A1', base_price: 27.95 }],
      custom: [{ code: 'A1', base_price: 27.95, msrp: 55.9, msrp_auto: true, active: true }],
    });
    eq(r.rows[0].msrp, 55.9, 'msrp');
    eq(r.rows[0].msrp_auto, true, 'msrp_auto');
  });

  t('a stale auto MSRP is still not re-derived while the base price is disputed', () => {
    const r = one({
      base:      [{ code: 'A1', base_price: 27.95 }],
      custom:    [{ code: 'A1', base_price: 19.95, msrp: 39.9, msrp_auto: true, active: true }],
      overrides: {},
    });
    eq(r.rows[0].base_price, null, 'base_price disputed');
    eq(r.rows[0].msrp, 39.9, 'stored MSRP kept, not guessed at');
    eq(r.rows[0].msrp_auto, true, 'still marked generated');
  });

  /* ---- THE SAFETY PROPERTY: disputed is not the same as absent ------------ */
  t('a DISPUTED MSRP is never replaced by a derived one', () => {
    const r = one({
      base:      [{ code: 'A1', base_price: 10, msrp: 30 }],
      overrides: { A1: { msrp: 40 } },
    });
    eq(r.rows[0].msrp, null, 'msrp stays null');
    eq(r.rows[0].msrp_auto, false, 'not flagged derived');
    eq(r.conflicts.filter(c => c.field === 'msrp').length, 1, 'msrp conflict recorded');
  });

  t('a disputed base price cannot produce a derived MSRP', () => {
    const r = one({
      base:      [{ code: 'A1', base_price: 10 }],
      overrides: { A1: { base_price: 12 } },
    });
    eq(r.rows[0].base_price, null, 'base_price');
    eq(r.rows[0].msrp, null, 'msrp');
    eq(r.rows[0].msrp_auto, false, 'msrp_auto');
  });

  t('no base price means no MSRP is invented', () => {
    const r = one({ base: [{ code: 'A1' }] });
    eq(r.rows[0].msrp, null, 'msrp');
    eq(r.rows[0].msrp_auto, false, 'msrp_auto');
  });

  t('a zero base price does not become a zero MSRP', () => {
    const r = one({ base: [{ code: 'A1', base_price: 0 }] });
    eq(r.rows[0].msrp, null, 'msrp');
    eq(r.rows[0].msrp_auto, false, 'msrp_auto');
  });

  /* ---- nothing else moved ------------------------------------------------ */
  t('deriving an MSRP leaves the quantity ladder alone', () => {
    const r = one({ base: [{ code: 'A1', base_price: 27.95,
      tiers: [{ min_qty: 1, price: 27.95 }, { min_qty: 6, price: 23.85 }] }] });
    eq(r.rows[0].msrp, 55.9, 'msrp');
    eq(r.rows[0].tiers, [{ min_qty: 6, price: 23.85 }], 'qty-1 rung still dropped');
  });

  t('a resolved conflict still applies, and the row is written', () => {
    const r = one({
      base:      [{ code: 'A1', base_price: 10, msrp: 30 }],
      overrides: { A1: { msrp: 40 } },
    });
    const applied = M.applyResolutions(r.rows, r.conflicts, { 'A1|msrp': 40 });
    eq(applied.ready.length, 1, 'ready');
    eq(applied.ready[0].msrp, 40, 'resolved msrp');
    eq(applied.blocked.length, 0, 'blocked');
  });

  t('the multiplier is the same one the storefront uses', () => {
    eq(M.MSRP_MULTIPLIER, 2, 'MSRP_MULTIPLIER');
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
