/* DEALER REPORT — EXCEL (owner directive 2026-11-06 17:40 CT, Priority 7). The workbook carries exactly the figures of the
   on-screen report and the PDF: it reads the SAME report object built by _dealer_report.build (no second calculation).
   Sheets: Summary · Total Sales by manufacturer / category / product · Monthly · Locations · Not valued (gaps) · Notes.
   Potential retail is the value of inventory purchased at today's Shop retail reference — never sales made. */
'use strict';
const XLSX = require('xlsx');

const n = (v) => (v == null || v === '' ? null : Number(v));
const pctCell = (v) => (v == null ? null : Number(v) / 100);

function sheet(rows, widths, money, pctCols) {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = widths.map((w) => ({ wch: w }));
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
  for (let R = 1; R <= range.e.r; R++) {
    for (const C of money || []) { const c = ws[XLSX.utils.encode_cell({ r: R, c: C })]; if (c && c.t === 'n') c.z = '$#,##0.00'; }
    for (const C of pctCols || []) { const c = ws[XLSX.utils.encode_cell({ r: R, c: C })]; if (c && c.t === 'n') c.z = '0.0%'; }
  }
  return ws;
}
const VCOLS = ['Wholesale purchases (valued)', 'Units', 'Potential retail — Shop reference', 'Gross profit — Shop', 'Margin — Shop',
  'Potential retail — your prices', 'Gross profit — your prices', 'Margin — your prices'];
const vrow = (x) => [n(x.cost), n(x.units), n(x.retail), n(x.profit), pctCell(x.margin_pct), n(x.custom_retail), n(x.custom_profit), pctCell(x.custom_margin_pct)];

function build({ report, scopeName, dealerName, generated }) {
  const R = report, V = R.valuation || {}, wb = XLSX.utils.book_new();
  const B = V.benchmark || {}, C = V.custom || {};
  const sum = [
    ['HCPS Dealer Report — Total Sales'], [dealerName && scopeName && !String(scopeName).startsWith(dealerName) ? `${dealerName} — ${scopeName}` : (scopeName || dealerName || '')],
    [`${R.period.label} · prepared ${generated} by HomeCare Provider Services`], [],
    ['Measure', 'Value'],
    ['Wholesale purchases (manufacturer-reported)', n(R.purchases.total)],
    ['Product units', n(R.purchases.units)],
    ['Wholesale purchases valued (matched to a Shop retail reference)', n(V.matched_cost)],
    ['Coverage (share of purchases valued)', pctCell(V.coverage_pct)],
    ['Potential retail — Shop reference (MSRP, else 2× standard cost)', n(B.retail)],
    ['Gross profit — Shop reference', n(B.profit)],
    ['Margin — Shop reference', pctCell(B.margin_pct)],
    ['Potential retail — your retail prices (Shop reference where you set none)', n(C.retail)],
    ['Gross profit — your retail prices', n(C.profit)],
    ['Margin — your retail prices', pctCell(C.margin_pct)],
    ['Difference: your prices vs Shop reference', n(V.difference)],
    ['Products with your own retail price', n(C.products_with_custom_price)],
    ['Purchases not valued (see the "Not valued" sheet)', n(V.gap_amount)],
  ];
  if (R.company) sum.push([], ['Company comparison (same period)', ''], ['Company purchases', n(R.company.purchases)], ['This location\'s share of company purchases', pctCell(R.company.branch_share_pct)],
    ['Company product units', n(R.company.units)], ['Company potential retail — Shop reference', n(R.company.retail_benchmark)], ['Company gross profit — Shop reference', n(R.company.profit)],
    ['Company margin — Shop reference', pctCell(R.company.margin_pct)], ['Company potential retail — your prices', n(R.company.custom_retail)], ['Company coverage', pctCell(R.company.coverage_pct)]);
  sum.push([], ['Potential retail is the value of the inventory purchased at today\'s Shop retail reference prices — not sales made. Historical purchases are valued at current prices. Portal orders are not included.']);
  const ws = XLSX.utils.aoa_to_sheet(sum); ws['!cols'] = [{ wch: 70 }, { wch: 18 }];
  for (let r = 5; r < sum.length; r++) { const c = ws[XLSX.utils.encode_cell({ r, c: 1 })]; if (c && c.t === 'n') c.z = /Coverage|Margin|share/i.test(String(sum[r][0])) ? '0.0%' : /units|Products with/i.test(String(sum[r][0])) ? '0' : '$#,##0.00'; }
  XLSX.utils.book_append_sheet(wb, ws, 'Summary');

  const money = [1, 3, 4, 6, 7], pc = [5, 8];
  XLSX.utils.book_append_sheet(wb, sheet([['Manufacturer', ...VCOLS], ...(V.by_manufacturer || []).map((x) => [x.name, ...vrow(x)])], [28, 18, 8, 20, 18, 12, 20, 18, 12], money, pc), 'By manufacturer');
  XLSX.utils.book_append_sheet(wb, sheet([['Category', ...VCOLS], ...(V.by_category || []).map((x) => [x.category, ...vrow(x)])], [28, 18, 8, 20, 18, 12, 20, 18, 12], money, pc), 'By category');
  XLSX.utils.book_append_sheet(wb, sheet([['Product', 'Item #', 'Manufacturer', 'Retail reference', 'Reference source', ...VCOLS],
    ...(V.by_product || []).map((x) => [x.name, x.code, x.manufacturer_name, n(x.reference), x.reference_source === 'msrp' ? 'Manufacturer MSRP' : 'HCPS calculated (2× standard cost)', ...vrow(x)])],
  [36, 14, 22, 14, 26, 18, 8, 20, 18, 12, 20, 18, 12], [3, 5, 7, 8, 10, 11], [9, 12]), 'By product');
  XLSX.utils.book_append_sheet(wb, sheet([['Month', 'All purchases', ...VCOLS],
    ...(V.monthly || []).map((x) => { const mo = (R.monthly || []).find((m) => m.month === x.month); return [x.month, n(mo ? mo.purchases : null), ...vrow(x)]; })],
  [10, 16, 18, 8, 20, 18, 12, 20, 18, 12], [1, 2, 4, 5, 7, 8], [6, 9]), 'Monthly');
  if ((R.branches || []).length > 1) XLSX.utils.book_append_sheet(wb, sheet([['Location', 'City', 'Purchases', 'Last year', 'Change', 'Last purchase month'],
    ...R.branches.map((b) => [b.name, b.city || '', n(b.purchases), n(b.prior), pctCell(b.change_pct), b.last_purchase_month || ''])], [30, 16, 16, 16, 10, 16], [2, 3], [4]), 'Locations');
  const why = { no_quantity: 'No quantity reported', no_amount: 'No amount', not_in_catalog: 'Not matched to a Shop product', no_retail_reference: 'No MSRP or standard cost in the Shop' };
  XLSX.utils.book_append_sheet(wb, sheet([['Manufacturer', 'Item #', 'Product', 'Units', 'Purchases', 'Why not valued'],
    ...(V.gaps || []).map((g) => [g.manufacturer_name, g.code, g.name, n(g.units), n(g.amount), why[g.reason] || g.reason])], [22, 14, 40, 8, 14, 32], [4], []), 'Not valued');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Notes'], ...(R.notes || []).map((t) => [t])]), 'Notes');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
module.exports = { build };
