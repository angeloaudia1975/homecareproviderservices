/* Catalog importer — behaviour suite. Executes the real _catalog_import.js (or a mutated copy) and the real adapters
   against SYNTHETIC sources built in the test (both repos are public: no manufacturer price list or wholesale price
   ever goes into git). */
const fs = require('fs');
const path = require('path');
const Module = require('module');
const SRC = path.join(__dirname, '..', 'netlify', 'functions', '_catalog_import.js');
const ADP = path.join(__dirname, '..', 'netlify', 'functions', '_import_adapters.js');

function load(src) { const m = new Module(SRC, module); m.filename = SRC; m.paths = module.paths; m._compile(src, SRC); return m.exports; }

let pass = 0, fail = 0; const out = [];
function t(name, fn) { try { fn(); pass++; out.push('  ok   ' + name); } catch (e) { fail++; out.push('  FAIL ' + name + '\n         ' + e.message); } }
function eq(a, b, what) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((what || 'value') + ': got ' + JSON.stringify(a) + ', expected ' + JSON.stringify(b)); }
const codes = (rows, level) => rows.flatMap(r => (r.flags || []).filter(f => !level || f.level === level).map(f => f.code));

function xlsxBuffer(aoa) {
  const X = require('xlsx'); const wb = X.utils.book_new(); X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(aoa), 'Sheet1');
  return X.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function run(src) {
  const C = load(src || fs.readFileSync(SRC, 'utf8'));
  pass = 0; fail = 0; out.length = 0;
  const row = o => Object.assign({ code: 'A1', name: 'Thing', dealer_price: 10, tiers: [], msrp: null, msrp_source: null, map: null, map_source: null, locator: 'r1', flags: [] }, o || {});
  const line = rows => ({ manufacturer: 'm', source: { file: 'f.xlsx', sha256: 'abc', effective_date_status: 'stated' }, terms: [], rows });

  // ---- money
  t('money reads $1,234.50, plain numbers, +$40 and rejects text', () => {
    eq([C.money('$1,234.50'), C.money(12.345), C.money('+$40'), C.money('n/a'), C.money(''), C.money('$2550')], [1234.5, 12.35, 40, null, null, 2550]);
  });

  // ---- validation
  t('a clean line has no blockers', () => { const V = C.validateLine(line([row()])); eq(codes(V.rows, 'blocker'), []); eq(C.report(V).stage_ready, true, 'ready'); });
  t('no price is a blocker (never orderable)', () => { eq(codes(C.validateLine(line([row({ dealer_price: null })])).rows, 'blocker'), ['no_dealer_price']); });
  t('a named-account price column is a blocker, not a base price', () => {
    eq(codes(C.validateLine(line([row({ dealer_price_scope: 'named_account' })])).rows, 'blocker'), ['named_account_price']);
  });
  t('duplicate in source with the same figures warns; with different figures blocks', () => {
    eq(codes(C.validateLine(line([row(), row({ locator: 'r2' })])).rows), ['duplicate_in_source_same_price'], 'same');
    eq(codes(C.validateLine(line([row(), row({ locator: 'r2', dealer_price: 11 })])).rows, 'blocker'), ['duplicate_in_source_conflict'], 'diff');
  });
  t('duplicates are matched on the normalized code', () => { eq(codes(C.validateLine(line([row({ code: 'RS-0051 2' }), row({ code: 'rs00512' })])).rows).length, 1); });
  t('quantity breaks: first must equal the dealer price; ascending; a costlier higher break is kept but flagged', () => {
    eq(codes(C.validateLine(line([row({ tiers: [{ min_qty: 1, price: 9 }, { min_qty: 5, price: 8 }] })])).rows, 'blocker'), ['qty1_mismatch'], 'qty1');
    eq(codes(C.validateLine(line([row({ tiers: [{ min_qty: 1, price: 10 }, { min_qty: 1, price: 9 }] })])).rows, 'blocker'), ['tier_order'], 'order');
    eq(codes(C.validateLine(line([row({ tiers: [{ min_qty: 1, price: 10 }, { min_qty: 5, price: 10.5 }] })])).rows, 'warn'), ['tier_not_descending'], 'up');
  });
  t('MAP above MSRP warns', () => { eq(codes(C.validateLine(line([row({ msrp: 10, map: 12 })])).rows), ['map_above_msrp']); });
  t('a fractional case quantity blocks', () => { eq(codes(C.validateLine(line([row({ case_qty: 2.5 })])).rows, 'blocker'), ['bad_case_qty']); });
  t('no effective date is reported as pending, never invented', () => {
    const V = C.validateLine({ manufacturer: 'm', source: { sha256: 'x', effective_date_status: 'not_stated' }, rows: [row()] });
    eq(V.exceptions.map(e => e.code), ['effective_date_not_stated']); eq(V.source.effective_date, undefined, 'no date made up');
  });
  t('an unhashed source blocks', () => { eq(C.validateLine({ manufacturer: 'm', source: { effective_date_status: 'stated' }, rows: [] }).exceptions.map(e => e.level), ['blocker']); });
  t('validation never drops a row', () => { eq(C.validateLine(line([row(), row({ code: '' }), row({ code: 'B', dealer_price: 0 })])).rows.length, 3); });

  // ---- comparison
  t('compare: new / changed / unchanged / not in source, matched on normalized code', () => {
    const V = C.validateLine(line([row({ code: 'A1', dealer_price: 10 }), row({ code: 'B-2', dealer_price: 7 }), row({ code: 'NEW1' })]));
    const R = C.compareLine(V, { catalog: [{ code: 'a1', base_price: 10, image: '/x' }, { code: 'B2', base_price: 6, image: '/y' }, { code: 'OLD', base_price: 3 }] });
    eq(R.rows.map(r => r.code + ':' + r.status), ['A1:unchanged', 'B-2:changed', 'NEW1:new']);
    eq(R.not_in_source.map(r => r.code), ['OLD']); eq(R.rows[1].changes, [{ field: 'dealer_price', from: 6, to: 7 }]);
  });
  t('compare uses a legacy list dealer price over a discounted base', () => {
    const V = C.validateLine(line([row({ code: 'R', dealer_price: 284.12 })]));
    eq(C.compareLine(V, { catalog: [{ code: 'R', base_price: 220.15, dealer_price: 259, image: '/i' }] }).rows[0].changes, [{ field: 'dealer_price', from: 259, to: 284.12 }]);
  });
  t('compare reports MAP newly stated, MSRP and case quantity changes', () => {
    const V = C.validateLine(line([row({ code: 'P', map: 99, msrp: 99, case_qty: 4 })]));
    const ch = C.compareLine(V, { catalog: [{ code: 'P', base_price: 10, msrp: 120, image: '/i' }] }).rows[0].changes.map(c => c.field);
    eq(ch, ['msrp', 'map', 'case_qty']);
  });
  t('a source duplicate is compared once', () => {
    const V = C.validateLine(line([row(), row({ locator: 'r2' })]));
    eq(C.compareLine(V, { catalog: [] }).rows.length, 1);
  });
  t('suggestions are hints only (one character apart / separator differences)', () => {
    const V = C.validateLine(line([row({ code: 'STP7M' })]));
    const R = C.compareLine(V, { catalog: [{ code: 'STP7', base_price: 1 }] });
    eq(R.rows[0].status, 'new', 'never auto-matched'); eq(R.rows[0].suggestions, ['STP7'], 'suggested');
    const F = C.compareLine(C.validateLine(line([row({ code: 'STQ8' })])), { catalog: [{ code: 'STP7', base_price: 1 }] });
    eq(F.rows[0].suggestions || [], [], 'two characters apart is not suggested');
  });
  t('master status travels with the match', () => {
    const V = C.validateLine(line([row({ code: 'A1' })]));
    eq(C.compareLine(V, { catalog: [], master: [{ code: 'A1', status: 'discontinued' }] }).rows[0].master_status, 'discontinued');
  });

  // ---- report + import rows
  t('report: blockers first, stage_ready false with any blocker', () => {
    const V = C.validateLine(line([row({ msrp: 10, map: 12 }), row({ code: 'B', dealer_price: null })]));
    const R = C.report(V);
    eq(R.exceptions[0].level, 'blocker', 'first'); eq(R.stage_ready, false, 'ready'); eq(R.counts.priced, 1, 'priced');
  });
  t('price_imports rows carry only STATED MSRP/MAP; a source-rule figure stays in raw', () => {
    const V = C.validateLine(line([row({ msrp: 15, msrp_source: 'source_rule', map: 10.5, map_source: 'source_rule' }), row({ code: 'S', msrp: 20, msrp_source: 'stated' })]));
    const P = C.priceImportRows(V);
    eq([P[0].msrp, P[0].map, P[0].raw._source_rule_msrp, P[0].raw._source_rule_map, P[1].msrp], [null, null, 15, 10.5, 20]);
  });
  t('price_imports keep tier pools and skip source duplicates', () => {
    const V = C.validateLine(line([row({ tiers: [{ min_qty: 1, price: 10 }, { min_qty: 10, price: 9, pool: 'p' }] }), row({ locator: 'r2', tiers: [{ min_qty: 1, price: 10 }, { min_qty: 10, price: 9, pool: 'p' }] })]));
    const P = C.priceImportRows(V); eq(P.length, 1, 'one'); eq(P[0].tiers, [{ min_qty: 1, price: 10 }, { min_qty: 10, price: 9, pool: 'p' }]);
  });

  // ---- adapters (real adapter code, synthetic sources)
  const A = require(ADP);
  t('workbook adapter (Ohio Medical shape): header found below a title, two breaks, bundle code kept', () => {
    const buf = xlsxBuffer([['Item Number', 'Description', 'Category', 'Package Contents', 'Product Weight', 'Oxygen Flow', 'Price Each', 'Price 5+', 'MSRP'],
      ['X-1 + X-2', 'Kit', 'Cat', 'Includes: thing', '1 LBS', '', '$100.00', '$90.00', '$250.00'], ['Y-9', 'Filter pk of 10', 'Cat', '', '', '', '$5.00', '', '$9.00']]);
    const L = A.ADAPTERS['ohio-medical'].fn(buf, 'synthetic.xlsx');
    eq(L.rows.map(r => [r.code, r.dealer_price, r.tiers.length, r.msrp]), [['X-1+X-2', 100, 2, 250], ['Y-9', 5, 0, 9]]);
    eq(L.rows[0].flags.map(f => f.code), ['bundle_code'], 'bundle'); eq(L.rows[1].flags.map(f => f.code), ['pack_in_text'], 'pack');
  });
  t('workbook adapter (PediFix shape): section rows, effective date from the title, pack quantity', () => {
    const buf = xlsxBuffer([['', '2099 Synthetic OTC Price List (Effective 7/1/99)'], [''], ['', 'Item #', 'Quantity Ordered', 'Cost', 'Total Cost', 'Description', 'Size', 'UPC #', 'QTY per pack', 'MSRP'],
      ['', 'Kits', '', '', '', '', '', '', '', ''], ['', 'K1', '', '$4.25', '$0.00', 'Thing', 'One Size', '000', '10', '$8.50'], ['', 'REV0799']]);
    const L = A.ADAPTERS.pedifix.fn(buf, 'synthetic.xlsx');
    eq([L.source.effective_date, L.rows.length, L.rows[0].section, L.rows[0].case_qty, L.rows[0].uom], ['2099-07-01', 1, 'Kits', 10, 'Pack of 10']);
  });
  t('workbook adapter (Corsicana shape): "Case of N" sets the unit; TBD freight warns', () => {
    const buf = xlsxBuffer([['', 'PRODUCTS'], ['', 'Item number', 'Name', 'Description', 'Standard Healthcare Price', 'MSRP', 'White Glove', 'UPS/FedEx- under', 'LTL- over'],
      ['', 'C1 ', 'Protector', 'Case of 10', '$220.00', '$440.00', 'n/a', '$20.00', '$11.00'], ['', 'C2', 'Booster', 'Backrest', '$165.00', '$330.00', 'n/a', 'TBD', 'TBD']]);
    const L = A.ADAPTERS.corsicana.fn(buf, 'synthetic.xlsx');
    eq([L.rows[0].code, L.rows[0].uom, L.rows[0].case_qty], ['C1', 'Case', 10]); eq(L.rows[1].flags.map(f => f.code), ['freight_tbd', 'freight_tbd']);
  });
  t('anchor table: items attach to the nearest code row; a price printed between rows is "spanning"', () => {
    const it = (x, y, s) => ({ page: 1, x, y, w: 10, s });
    const T = A.anchorTable([it(50, 500, 'BNG1'), it(120, 500, 'Kit A'), it(430, 500, '$10'), it(50, 470, 'BNG2'), it(120, 470, 'Kit B'), it(430, 470, '$10'), it(490, 485, '$9')],
      { codeRe: /^BNG\d$/, codeX: [40, 100], band: 18, lineTol: 3, columns: { name: [100, 400], p1: [400, 460], p10: [460, 520] }, priceCols: ['p1', 'p10'] });
    eq(T.rows.map(r => [r.code, r.name, r.p1]), [['BNG1', 'Kit A', '$10'], ['BNG2', 'Kit B', '$10']]); eq(T.spanning.map(s => s.s), ['$9']);
  });
  t('Access4U transcription: "x3W" makes one row per offered width; X = not offered; MSRP/MAP by the STATED rule', () => {
    const L = A.ADAPTERS.access4u.fn({ rows: [{ page: 2, section: 'T', code: 'TR24x3W', description: 'Ramp 24 x W', widths: { '30': '100.00', '36': 'X' } }] }, Buffer.from('x'), 'f.pdf');
    eq(L.rows.map(r => [r.code, r.dealer_price, r.msrp, r.map, r.msrp_source]), [['TR24x30', 100, 150, 105, 'source_rule']]);
  });
  t('Access4U transcription: a width with no printed code gets a PROPOSED code that blocks', () => {
    const L = A.ADAPTERS.access4u.fn({ rows: [{ page: 1, section: 'S', code: 'STP2', description: 'Stair', widths: { '36': '1.00', '48': '2.00' }, width_code: { '36': 'STP2' } }] }, Buffer.from('x'), 'f.pdf');
    eq(L.rows.map(r => r.code), ['STP2', 'STP2x48']); eq(L.rows[1].flags.map(f => f.level + ':' + f.code), ['blocker:proposed_variant_code']);
  });
  t('Access4U option up-charges stay options (X dropped), never separate SKUs', () => {
    const L = A.ADAPTERS.access4u.fn({ rows: [{ page: 1, section: 'R', code: 'R1', description: 'Ramp', price: '10', options: [{ label: 'Picket', price_add: '40' }, { label: 'Commercial', price_add: 'X' }] }] }, Buffer.from('x'), 'f.pdf');
    eq([L.rows.length, L.rows[0].options], [1, [{ label: 'Picket', price_add: 40 }]]);
  });

  return { pass, fail, report: out.join('\n') };
}
module.exports = { run, SRC };
if (require.main === module) { const r = run(); console.log(r.report); console.log('\ncatalog-import: ' + r.pass + ' passed, ' + r.fail + ' failed'); process.exit(r.fail ? 1 : 0); }
