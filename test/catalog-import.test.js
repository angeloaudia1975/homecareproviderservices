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
const pending = [];
function t(name, fn) { pending.push([name, fn]); }
async function drain() { while (pending.length) { const [name, fn] = pending.shift(); try { await fn(); pass++; out.push('  ok   ' + name); } catch (e) { fail++; out.push('  FAIL ' + name + '\n         ' + e.message); } } }
function eq(a, b, what) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((what || 'value') + ': got ' + JSON.stringify(a) + ', expected ' + JSON.stringify(b)); }
const codes = (rows, level) => rows.flatMap(r => (r.flags || []).filter(f => !level || f.level === level).map(f => f.code));

function xlsxBuffer(aoa) {
  const X = require('xlsx'); const wb = X.utils.book_new(); X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(aoa), 'Sheet1');
  return X.write(wb, { type: 'buffer', bookType: 'xlsx' });
}


/* A minimal one-page PDF with text at fixed positions (synthetic Dalton-shaped list; no manufacturer data). */
function daltonPdf() {
  const T = [[300, 770, 'Effective November 1, 2099'], [300, 755, 'Revised: 3 listed items'], [40, 785, 'Dealers receive a 5% discount on orders over $10,000'],
    [30, 720, 'ITEM #'], [30, 700, 'BEDS'], [215, 700, '2'], [30, 680, 'BED100'], [105, 680, 'Homecare Bed, 450LB Weight Capacity'], [260, 680, '$999.00'],
    [30, 660, 'GL-10'], [105, 660, 'Exam Gloves 100/Box'], [260, 660, '$12.50'], [30, 630, 'TABLES'], [215, 630, '1'], [30, 610, 'OBT1'], [105, 610, 'Overbed Table'], [260, 610, '$89.99']];
  const esc = s => s.replace(/[\\()]/g, m => '\\' + m);
  const content = T.map(([x, y, s]) => `BT /F1 8 Tf ${x} ${y} Td (${esc(s)}) Tj ET`).join('\n');
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`];
  let pdf = '%PDF-1.4\n'; const off = [];
  objs.forEach((o, i) => { off.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + off.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('') + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

function loadAdp(src) { const m = new Module(ADP, module); m.filename = ADP; m.paths = module.paths; m._compile(src, ADP); return m.exports; }
async function run(src, adpSrc) {
  pending.length = 0;
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
  const A = adpSrc ? loadAdp(adpSrc) : require(ADP);
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


  // ================= PR #35 review: before/after, stop-on-blocker, exceptions queue, handoff, aliases =================
  const okv = (c, w) => { if (!c) throw new Error(w); };
  const IV = { basis: 'hcps_intake_verified', attachment_name: null, attachment_sha256: null, message_id: null, verified_by: 'test', note: 'synthetic' };
  const srcLine = (rows, extra) => Object.assign({ manufacturer: 'm', source: { file: 'f.xlsx', sha256: 'abc', effective_date_status: 'not_stated', received_date: '2026-10-20', received_basis: 'hcps_intake_verified', received_evidence: IV }, terms: [], rows }, extra || {});
  const pkg = (rows, existing, ctx, extra) => { const V = C.validateLine(srcLine(rows, extra)); const ex = existing || { catalog: [], master: [] };
    return C.buildPackage(V, C.compareLine(V, ex), Object.assign({ catalog: ex.catalog, master: ex.master, today: '2026-10-23' }, ctx || {})); };
  const kinds = P => P.exceptions.map(x => x.kind + (x.blocking ? '!' : ''));

  // ---- 1. deterministic per-SKU before/after
  const baRows = () => [row({ code: 'B-2', name: 'Bee', dealer_price: 7, msrp: 12, msrp_source: 'stated', tiers: [{ min_qty: 1, price: 7 }, { min_qty: 5, price: 6.5, pool: 'p' }] }),
    row({ code: 'A1', name: 'Ay', dealer_price: 10, uom: 'Case', case_qty: 4 }), row({ code: 'N9', name: 'New', dealer_price: 3, msrp: 4.5, msrp_source: 'source_rule' })];
  const baCat = () => [{ code: 'OLD', name: 'Old', base_price: 2, image: '/assets/x.jpg' }, { code: 'a1', name: 'Ay', base_price: 10, msrp: 20, uom: 'Case', case_qty: 4 },
    { code: 'B2', name: 'Bee', base_price: 6, tiers: [{ minQty: 1, price: 6 }] }];
  const baMaster = () => [{ code: 'A1', status: 'active', uom: 'Case', case_qty: 4 }];
  t('before/after: every field, before / after / change kind, for source SKUs and preserved SKUs', () => {
    const V = C.validateLine(srcLine(baRows()));
    const ba = C.beforeAfter(V, { catalog: baCat(), master: baMaster() });
    eq(ba.fields, ['name', 'dealer_price', 'tiers', 'msrp', 'map', 'uom', 'case_qty', 'status']);
    eq(ba.rows.map(r => r.code + ':' + r.row_kind), ['A1:unchanged', 'B-2:changed', 'N9:new', 'OLD:not_on_source_preserved'], 'stable sort by normalized code');
    const f = c => ba.rows.find(r => r.code === c).fields;
    eq(f('B-2').dealer_price, { before: 6, after: 7, change: 'changed' });
    eq(f('B-2').tiers, { before: '1+:6', after: '1+:7 5+:6.5(p)', change: 'changed' });
    eq(f('B-2').msrp, { before: null, after: 12, change: 'added' });
    eq(f('A1').msrp, { before: 20, after: 20, change: 'not_stated' }, 'a field the source does not state is kept');
    eq(f('A1').status, { before: 'active', after: 'active', change: 'not_stated' }, 'listing a SKU never changes its status');
    eq(f('N9').msrp, { before: null, after: null, change: 'not_stated' }, 'a source-RULE MSRP is not a stated MSRP');
    eq(f('N9').status, { before: null, after: 'active (new record)', change: 'added' });
    eq(f('OLD').status, { before: 'listed (no master record)', after: 'listed (no master record)', change: 'not_on_source' }, 'preserved, status unchanged');
    eq(ba.summary, { rows: 4, new: 1, changed: 1, unchanged: 1, not_on_source_preserved: 1 });
  });
  t('before/after: identical inputs give byte-identical JSON + CSV (hash), whatever the input order', () => {
    const one = C.beforeAfter(C.validateLine(srcLine(baRows())), { catalog: baCat(), master: baMaster() });
    const two = C.beforeAfter(C.validateLine(srcLine(baRows().reverse())), { catalog: baCat().reverse(), master: baMaster() });
    eq(C.beforeAfterJson(two), C.beforeAfterJson(one), 'json'); eq(C.beforeAfterCsv(two), C.beforeAfterCsv(one), 'csv');
    eq(C.beforeAfterHash(two), C.beforeAfterHash(one), 'hash');
    okv(/^[0-9a-f]{64}:[0-9a-f]{64}$/.test(C.beforeAfterHash(one)), 'hash shape');
    const rows = baRows(); rows[1].dealer_price = 10.01;
    okv(C.beforeAfterHash(C.beforeAfter(C.validateLine(srcLine(rows)), { catalog: baCat(), master: baMaster() })) !== C.beforeAfterHash(one), 'one cent moves the hash');
    const csv = C.beforeAfterCsv(one).split('\n');
    eq(csv[0].split(',').slice(0, 5), ['code', 'row_kind', 'name_before', 'name_after', 'name_change']); eq(csv.length, 6, 'header + 4 rows + final newline');
  });
  t('before/after: legacy discount tiers are shown as history, never as the new tiers', () => {
    const ba = C.beforeAfter(C.validateLine(srcLine([row({ code: 'R', dealer_price: 50 })])), { catalog: [{ code: 'R', base_price: 41.5, dealer_price: 50, tier_prices: { 17: 40.25, 15: 41.5 } }] });
    eq(ba.rows[0].fields.tiers, { before: 'legacy 15:41.5 17:40.25', after: 'legacy 15:41.5 17:40.25', change: 'not_stated' });
    eq(ba.rows[0].fields.dealer_price.change, 'unchanged', 'the list dealer price, not the discounted base');
  });

  // ---- 2. stop on blocker
  t('stop-on-blocker: any blocking exception → not stageable and NO import rows at all', () => {
    const P = pkg([row(), row({ code: 'B', dealer_price_scope: 'named_account' })]);
    eq([P.stageable, P.handoff], [false, null]); okv(/blocking exception/.test(P.withheld_reason), 'reason');
    eq(P.counts.blocking, 1); okv(P.before_after.rows.length === 2, 'the review is still produced');
  });
  t('stop-on-blocker: a clean line is stageable and carries the exact Manufacturer Center payloads', () => {
    const P = pkg([row({ code: 'A1', msrp: 20, msrp_source: 'stated' })]);
    eq(P.stageable, true, JSON.stringify(P.exceptions)); eq(P.handoff.mc_import_source_rows.action, 'mc_import_source_rows');
    eq(P.handoff.stage_record_source.dry_run, true, 'staging always starts as a dry run');
    eq([P.handoff.mc_import_source_rows.source_id, P.handoff.stage_record_source.source_id], [null, null], 'filled only after registration');
    eq(P.handoff.register, { manufacturer: 'm', kind: 'price_list', file_name: 'f.xlsx', sha256: 'abc', received_date: '2026-10-20', manufacturer_effective_date: null, effective_date_status: 'pending' });
  });
  t('stop-on-blocker: no received date blocks (never invented)', () => {
    const V = C.validateLine(srcLine([row()])); V.source.received_date = null;
    const P = C.buildPackage(V, C.compareLine(V, {}), { today: '2026-10-23' });
    eq([P.stageable, kinds(P)], [false, ['provenance_incomplete!']]);
  });
  const bare = () => { const V = C.validateLine(srcLine([row()])); V.source.received_date = null; V.source.received_basis = null; V.source.received_evidence = null; return V; };
  const pkgOf = V => C.buildPackage(V, C.compareLine(V, {}), { today: '2026-10-23' });
  t('receipt: a mailbox date is assigned only when the attachment SHA-256 equals the imported file', () => {
    const V = C.applyReceipt(bare(), { date: '2026-10-09', basis: 'mailbox_attachment_match', attachment_name: 'Pricelist fall 2026.pdf', attachment_sha256: 'ABC', message_id: '<m1>' });
    eq([V.source.received_date, V.source.received_basis], ['2026-10-09', 'mailbox_attachment_match']);
    const P = pkgOf(V);
    eq([P.stageable, kinds(P)], [true, []]);
    eq(P.handoff.mc_import_source_rows.rows[0].raw._provenance.received_evidence.attachment_sha256, 'abc');
  });
  t('receipt: a non-matching attachment (corrected / re-saved PDF) never gives its date to the file', () => {
    const V = C.applyReceipt(bare(), { date: '2026-10-20', basis: 'mailbox_attachment_match', attachment_name: 'NEW Dalton.pdf', attachment_sha256: 'def' });
    eq([V.source.received_date, V.source.received_basis], [null, null]);
    const P = pkgOf(V);
    eq([P.stageable, kinds(P)], [false, ['provenance_incomplete!', 'received_date_mismatch!']]);
    eq(P.handoff, null);
    eq(/NOT assigned/.test(P.exceptions.find(x => x.kind === 'received_date_mismatch').evidence), true);
  });
  t('receipt: a separately verified HCPS intake is its own basis; a mismatched hash still refuses the date', () => {
    const V = C.applyReceipt(bare(), { date: '2026-10-21', basis: 'hcps_intake_verified', verified_by: 'angelo', note: 'file handed over at the Oct 21 meeting' });
    eq([V.source.received_basis, pkgOf(V).stageable], ['hcps_intake_verified', true]);
    const W = C.applyReceipt(bare(), { date: '2026-10-21', basis: 'hcps_intake_verified', verified_by: 'angelo', note: 'x', attachment_sha256: 'zzz' });
    eq([W.source.received_date, kinds(pkgOf(W)).includes('received_date_mismatch!')], [null, true]);
    let threw = 0;
    for (const e of [{ date: '2026-10-21', basis: 'hcps_intake_verified' }, { date: '2026-10-21', basis: 'mailbox_attachment_match' }, { date: '10/21/2026', basis: 'hcps_intake_verified', verified_by: 'a', note: 'b' }, { date: '2026-10-21', basis: 'guess' }])
      try { C.applyReceipt(bare(), e); } catch (_) { threw++; }
    eq(threw, 4, 'incomplete evidence is refused');
  });
  t('receipt: a bare date with no basis is kept but blocks (received_unverified); never the effective date', () => {
    const V = C.applyReceipt(bare(), '2026-10-20');
    const P = pkgOf(V);
    eq([V.source.received_date, P.stageable, kinds(P)], ['2026-10-20', false, ['received_unverified!']]);
    eq(C.provenanceOf(V).effective_date, null);
  });
  t('stop-on-blocker: a recorded decision resolves an open exception; an incomplete decision does not', () => {
    const P = pkg([row({ code: 'B', dealer_price_scope: 'named_account' })]); const id = P.exceptions[0].id;
    eq(pkg([row({ code: 'B', dealer_price_scope: 'named_account' })], null, { decisions: { [id]: { status: 'resolved' } } }).stageable, false, 'no who / why');
    const R = pkg([row({ code: 'B', dealer_price_scope: 'named_account' })], null, { decisions: { [id]: { status: 'resolved', decided_by: 'angelo', reason: 'general price confirmed in writing' } } });
    eq([R.stageable, R.exceptions[0].status, R.exceptions[0].blocking], [true, 'resolved', false]);
  });

  // ---- 3. exceptions queue
  t('exceptions: one record per item with a stable id, blockers first, machine-readable fields', () => {
    const a = pkg([row({ code: 'B', dealer_price_scope: 'named_account' }), row({ code: 'W', name: 'Concentrator 3 Year Warranty' })]);
    const b = pkg([row({ code: 'W', name: 'Concentrator 3 Year Warranty' }), row({ code: 'B', dealer_price_scope: 'named_account' })]);
    eq(a.exceptions, b.exceptions, 'order and ids do not depend on input order');
    eq(Object.keys(a.exceptions[0]).sort(), ['blocking', 'evidence', 'id', 'kind', 'manufacturer', 'required_decision', 'sku', 'source_ref', 'status'].sort());
    eq(kinds(a), ['named_account_price!', 'warranty_conflict']); eq(a.exceptions[1].status, 'held');
    eq(a.exceptions[0].id.split(':').slice(0, 3), ['named_account_price', 'm', 'B']);
  });
  t('exceptions: blocking items come first, whatever their kind', () => {
    eq(kinds(pkg([row({ code: 'STP7M' })], { catalog: [{ code: 'STP7', base_price: 1, image: '/assets/a' }] })), ['uncertain_part_number!', 'legacy_not_on_source']);
  });
  t('exceptions: an older list is not_current_source (blocking) until the manufacturer confirms it in writing', () => {
    const ex = { source: { file: 'PediFix_2025.xlsx', sha256: 'x', title: '2025 OTC Price List', effective_date: '2025-07-01', effective_date_status: 'stated', received_date: '2026-10-20', received_basis: 'hcps_intake_verified', received_evidence: IV } };
    eq(kinds(pkg([row()], null, null, ex)), ['not_current_source!']);
    eq(pkg([row()], null, { confirmations: { current_source: true } }, ex).stageable, true, 'confirmed');
    eq(pkg([row()], null, { today: '2025-12-01' }, ex).stageable, true, 'current in its own year');
  });
  t('exceptions: uncertain part numbers and proposed codes block; nothing is renamed or merged', () => {
    const P = pkg([row({ code: 'STP7M' }), row({ code: 'STP2x48', flags: [C.flag('blocker', 'proposed_variant_code', 'proposed')] })], { catalog: [{ code: 'STP7', base_price: 10, image: '/assets/a' }] });
    eq(kinds(P).filter(k => /!$/.test(k)).sort(), ['proposed_code!', 'uncertain_part_number!']); eq(P.stageable, false);
  });
  t('exceptions: legacy SKUs not on the source are PRESERVED (held, non-blocking), never retired by omission', () => {
    const cat = [{ code: 'A1', base_price: 10, image: '/assets/a' }, { code: 'GONE', name: 'Old ramp', base_price: 5, image: '/assets/b' }];
    const P = pkg([row({ code: 'A1' })], { catalog: cat, master: [{ code: 'GONE', status: 'active' }] });
    eq([P.stageable, kinds(P)], [true, ['legacy_not_on_source']]); eq(P.exceptions[0].sku, 'GONE');
    eq(P.handoff.stage_record_source.rows.map(r => r.code), ['A1'], 'an omitted SKU is not in the stage rows');
    okv(P.handoff.stage_record_source.rows.every(r => !('status' in r)), 'status is never sent');
    eq(P.before_after.rows.find(r => r.code === 'GONE').fields.status, { before: 'active', after: 'active', change: 'not_on_source' });
  });
  t('exceptions: an old discount structure is discount_unverified (history only), capacity and image questions are held', () => {
    const cat = [{ code: 'R', name: 'Bed, 450LB Weight Capacity', dealer_price: 50, base_price: 41.5, tier_prices: { 15: 41.5 }, image: 'https://cdn.example.com/r.jpg' }];
    const P = pkg([row({ code: 'R', name: 'Bed, 600LB Weight Capacity', dealer_price: 50 })], { catalog: cat });
    eq(kinds(P), ['capacity_conflict', 'discount_unverified', 'image_rights']); eq(P.stageable, true, 'held items never block price import');
  });
  t('exceptions: pack text and an unverified case quantity block; OTC / medical claims and TBD freight are held', () => {
    const P = pkg([row({ code: 'G', flags: [C.flag('warn', 'pack_in_text', '100/Box')] }), row({ code: 'K', flags: [C.flag('blocker', 'case_qty_unverified', 'Case of 10')] }),
      row({ code: 'F', name: 'Antifungal solution', flags: [C.flag('warn', 'freight_tbd', 'TBD')] }), row({ code: 'H', name: 'Hospital bed mattress' })]);
    eq(kinds(P), ['case_qty_unverified!', 'pack_qty_check!', 'unsupported_claim', 'unsupported_claim', 'unsupported_claim']);
  });
  t('exceptions: reviewer holds come in as data and stay held', () => {
    const P = pkg([row()], null, { holds: [{ manufacturer: 'm', kind: 'capacity_conflict', evidence: 'beds differ' }, { manufacturer: 'other', kind: 'x', evidence: 'y' }] });
    eq([kinds(P), P.exceptions[0].status, P.stageable], [['capacity_conflict'], 'held', true]);
  });
  t('refused lines: the four frozen Gold Standard lines and Complete Medical Supplies are never staged', () => {
    for (const s of ['bemis', 'climbing-steps', 'ovation-medical', 'strongback-mobility', 'complete-medical-supplies', 'complete-medical']) {
      const P = pkg([row()], null, null, { manufacturer: s }); const k = s.startsWith('complete') ? 'activation_hold!' : 'line_frozen!';
      eq([P.stageable, P.handoff, kinds(P)], [false, null, [k]], s);
      const id = P.exceptions[0].id;
      eq(pkg([row()], null, { decisions: { [id]: { status: 'resolved', decided_by: 'x', reason: 'y' } } }, { manufacturer: s }).stageable, false, s + ' cannot be resolved here');
    }
    eq(pkg([row()], null, { frozen: ['new-gold'] }, { manufacturer: 'new-gold' }).stageable, false, 'a line frozen in the snapshot meta');
    eq(C.lineRefusal('corsicana'), null);
  });

  // ---- 4. Dalton exactly as printed
  t('as printed: a dealer price that is not the printed figure blocks (no discount, markup or rounding)', () => {
    const V = C.validateLine(srcLine([row({ code: 'D1', dealer_price: 94.43, raw: { printed_price: '$99.40' } }), row({ code: 'D2', dealer_price: 99.4, raw: { printed_price: '$99.40' } })]));
    eq(codes(V.rows, 'blocker'), ['price_not_as_printed']); eq(V.rows[0].flags[0].code, 'price_not_as_printed');
  });

  // ---- 5. handoff shape (the real catalog-api is exercised in catalog-import.handoff.test.js)
  t('handoff: every import row carries the source provenance; effective date null when not stated', () => {
    const P = pkg([row({ code: 'A1', case_qty: 4, uom: 'Case' }), row({ code: 'B1', msrp: 9, msrp_source: 'source_rule', map: 6.3, map_source: 'source_rule' })]);
    for (const r of P.handoff.mc_import_source_rows.rows) eq(r.raw._provenance, { file: 'f.xlsx', sha256: 'abc', received_date: '2026-10-20', received_basis: 'hcps_intake_verified', received_evidence: IV, effective_date: null, effective_date_status: 'not_stated' });
    for (const r of P.handoff.stage_record_source.rows) eq(r._provenance.sha256, 'abc');
    eq(P.handoff.mc_import_source_rows.rows[0].case_qty_text, '4', 'the field mc_import_source_rows parses');
    eq(P.handoff.stage_record_source.rows[1], { code: 'B1', base_price: 10, _provenance: P.handoff.stage_record_source.rows[1]._provenance }, 'no unstated field is sent, not even as null');
    const st = C.buildPackage(C.validateLine(srcLine([row()], { source: { file: 'f', sha256: 's', effective_date: '2026-11-01', effective_date_status: 'stated', received_date: '2026-10-20', received_basis: 'hcps_intake_verified', received_evidence: IV } })), null, { today: '2026-10-23' });
    eq([st.handoff.register.manufacturer_effective_date, st.handoff.register.effective_date_status, st.handoff.stage_record_source.rows[0]._provenance.effective_date], ['2026-11-01', 'stated', '2026-11-01']);
  });

  // ---- 6. Ohio Medical canonical slug, gce alias
  t('Ohio Medical: canonical ohio-medical, gce accepted as an alias; the storefront file stays gce.json', () => {
    eq([C.canonicalSlug('gce'), C.canonicalSlug(' GCE '), C.canonicalSlug('ohio-medical'), C.catalogFileSlug('gce'), C.catalogFileSlug('ohio-medical'), C.catalogFileSlug('dalton')],
      ['ohio-medical', 'ohio-medical', 'ohio-medical', 'gce', 'gce', 'dalton']);
    eq(C.slugAliases('gce'), ['ohio-medical', 'gce']);
    eq(pkg([row()], null, null, { manufacturer: 'gce' }).manufacturer, 'ohio-medical');
    eq(A.adapterFor('gce'), A.adapterFor('ohio-medical')); okv(A.adapterFor('gce'), 'adapter');
    okv(A.ADAPTERS.gce === A.ADAPTERS['ohio-medical'], 'gce in the adapter table'); okv(A.adapterFor(' GCE ') === A.ADAPTERS['ohio-medical'], 'adapterFor canonicalizes'); eq(A.adapterFor('complete-medical-supplies'), null);
  });

  t('Dalton adapter (synthetic PDF): prices exactly as printed; a discount on the list is recorded, never applied', async () => {
    const L = await A.ADAPTERS.dalton.fn(daltonPdf(), 'synthetic-dalton.pdf');
    eq(L.rows.map(r => [r.code, r.dealer_price, r.raw.printed_price]), [['BED100', 999, '$999.00'], ['GL-10', 12.5, '$12.50'], ['OBT1', 89.99, '$89.99']]);
    eq([L.source.effective_date, L.checks.stated_total, L.checks.rows_read], ['2099-11-01', 3, 3]);
    okv(L.terms.some(x => x.kind === 'discount_text_not_applied' && /5%/.test(x.text)), 'discount text recorded');
    const V = C.validateLine(L);
    eq(codes(V.rows, 'blocker'), [], 'no price differs from the printed figure');
    eq(C.priceImportRows(V).map(r => r.base_price), [999, 12.5, 89.99], 'import rows carry the printed prices');
    eq(C.stageRows(V).map(r => r.base_price), [999, 12.5, 89.99], 'stage rows carry the printed prices');
    for (const r of V.rows) okv(Math.abs(r.dealer_price - Math.round(r.dealer_price * 0.95 * 100) / 100) > 0.004, 'no 5% applied');
    eq(V.rows[1].flags.map(f => f.code), ['pack_in_text'], 'pack text is a check');
    const P = C.buildPackage(Object.assign(V, { source: Object.assign(V.source, { received_date: '2099-11-02', received_basis: 'hcps_intake_verified', received_evidence: IV }) }), C.compareLine(V, {}), { today: '2099-11-03' });
    eq([P.stageable, P.exceptions.filter(x => x.blocking).map(x => x.kind)], [false, ['pack_qty_check']]);
  });
  t('Corsicana adapter: "Case of N" from the description is case_qty_unverified (blocks)', () => {
    const buf = xlsxBuffer([['', 'Item number', 'Name', 'Description', 'Standard Healthcare Price', 'MSRP', 'White Glove', 'UPS/FedEx- under', 'LTL- over'],
      ['', 'C1', 'Protector', 'Case of 10', '$220.00', '$440.00', 'n/a', '$20.00', '$11.00']]);
    const V = C.validateLine(A.ADAPTERS.corsicana.fn(buf, 'synthetic.xlsx'));
    eq(codes(V.rows, 'blocker'), ['case_qty_unverified']); eq(V.rows[0].raw.printed_price, '$220.00');
  });

  await drain();
  return { pass, fail, report: out.join('\n') };
}
module.exports = { run, SRC, ADP };
if (require.main === module) run().then(r => { console.log(r.report); console.log('\ncatalog-import: ' + r.pass + ' passed, ' + r.fail + ' failed'); process.exit(r.fail ? 1 : 0); });
